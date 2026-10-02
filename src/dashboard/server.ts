import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { AI_VARS, aiStatus, aiVarName, checkAiValue, llmEndpoint, type AiVar } from "../ai.ts";
import { availability, formatLocalTime } from "../character/derived.ts";
import { moodNow } from "../character/mood.ts";
import { ProfileSchema, type CharacterProfile } from "../character/profile.ts";
import type { RoutineEngine } from "../character/routine-engine.ts";
import type { Clock } from "../clock.ts";
import { applyConfig, ConfigOverridesSchema, DEFAULT_CONFIG, writeConfigFile, type Config } from "../config.ts";
import { BOT_PLATFORMS, type AdapterRegistry, type BotPlatform } from "../delivery/registry.ts";
import { setEnvVar } from "../envfile.ts";
import type { InteractionManager } from "../im/manager.ts";
import { openThreads } from "../context/context.ts";
import type { Store } from "../store.ts";
import { ACTIVITIES, PACES } from "../types.ts";

/**
 * The dashboard: one page and a JSON API, inside the bot process so that an edit is live on the
 * next turn — profiles and config are shared objects the reply path reads every time.
 *
 * Bot tokens and platform bindings are live too: a change re-syncs that character's adapters.
 * So are LLM and Jev keys and models: the reply path resolves them from `env` on every call.
 */
export interface DashboardDeps {
  store: Store;
  clock: Clock;
  im: InteractionManager;
  routine: RoutineEngine;
  profiles: Map<string, CharacterProfile>;
  config: Config;
  configPath: string;
  charactersDir: string;
  adapters: AdapterRegistry;
  /** The dotenv file bot tokens, keys and models are written to. */
  envPath: string;
  env: NodeJS.ProcessEnv;
}

export interface DashboardOptions {
  host: string;
  port: number;
  /** Required unless bound to loopback. Checked as HTTP Basic auth, any user name. */
  password?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const PAGE = join(import.meta.dirname, "index.html");

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly issues?: unknown) {
    super(message);
  }
}

/** The file a character lives in: whichever one already holds that id, else `<id>.json`. */
function profileFile(dir: string, id: string): string {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
    try {
      if (JSON.parse(readFileSync(join(dir, f), "utf8")).characterId === id) return join(dir, f);
    } catch {
      /* a broken file is not this character */
    }
  }
  return join(dir, `${id}.json`);
}

function validProfile(body: unknown): CharacterProfile {
  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "invalid character", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return parsed.data;
}

const platformsOf = (p: CharacterProfile, d: DashboardDeps) => d.adapters.status(p);

/** Two characters on one token would overwrite each other's conversations: refuse it at the edge. */
function assertOwnBindings(d: DashboardDeps, p: CharacterProfile) {
  for (const other of d.profiles.values()) {
    if (other.characterId === p.characterId) continue;
    for (const k of BOT_PLATFORMS) {
      const mine = p.platforms[k]?.botTokenEnv;
      if (mine && BOT_PLATFORMS.some((j) => other.platforms[j]?.botTokenEnv === mine)) {
        throw new HttpError(409, `${mine} is already ${other.name}'s token`);
      }
    }
  }
}

function saveProfile(d: DashboardDeps, p: CharacterProfile) {
  writeFileSync(profileFile(d.charactersDir, p.characterId), `${JSON.stringify(p, null, 2)}\n`);
  d.profiles.set(p.characterId, p);
}

const ALLOWED_COMMANDS = new Set(["forget", "reset"]);

async function route(d: DashboardDeps, method: string, path: string, body: unknown): Promise<unknown> {
  const now = d.clock.now();
  let m: RegExpMatchArray | null;

  if (method === "GET" && path === "/api/overview") {
    const conversations = d.store.listConversations();
    return {
      characters: [...d.profiles.values()].map((p) => {
        const cs = d.store.getCharacterState(p.characterId, now);
        return {
          id: p.characterId,
          name: p.name,
          activity: cs.activity,
          activitySince: cs.activitySince,
          availability: availability(cs.activity),
          mood: moodNow(cs, now),
          localTime: formatLocalTime(now, p.timezone),
          platforms: platformsOf(p, d),
          conversations: conversations.filter((c) => c.characterId === p.characterId).length,
        };
      }),
      conversations: conversations.length,
      examples: d.store.exampleCount(),
      enums: { activity: ACTIVITIES, basePace: PACES },
    };
  }

  if (method === "GET" && (m = path.match(/^\/api\/characters\/([a-z0-9_]+)$/))) {
    const p = d.profiles.get(m[1]);
    if (!p) throw new HttpError(404, "no such character");
    return { profile: p, platforms: platformsOf(p, d), ai: aiStatus(d.env, p.characterId) };
  }

  if (method === "PUT" && (m = path.match(/^\/api\/characters\/([a-z0-9_]+)$/))) {
    if (!d.profiles.has(m[1])) throw new HttpError(404, "no such character");
    const p = validProfile(body);
    if (p.characterId !== m[1]) throw new HttpError(400, "characterId cannot be changed: it is part of every conversation id");
    assertOwnBindings(d, p);
    saveProfile(d, p);
    d.routine.reload(p.characterId);
    await d.adapters.sync(p.characterId, p);
    return { ok: true, platforms: platformsOf(p, d) };
  }

  if (method === "PUT" && (m = path.match(/^\/api\/characters\/([a-z0-9_]+)\/platforms\/(telegram|discord)$/))) {
    let p = d.profiles.get(m[1]);
    if (!p) throw new HttpError(404, "no such character");
    const platform = m[2] as BotPlatform;
    const token = (body as { token?: unknown })?.token;
    if (token !== null && (typeof token !== "string" || !token.trim())) throw new HttpError(400, "token must be a string, or null to remove it");
    // a token with nowhere to go gets the conventional env var name, and the binding is saved
    if (!p.platforms[platform]) {
      p = { ...p, platforms: { ...p.platforms, [platform]: { botTokenEnv: `${p.characterId.toUpperCase()}_${platform.toUpperCase()}_TOKEN` } } };
      assertOwnBindings(d, p);
      saveProfile(d, p);
    }
    const envName = p.platforms[platform]!.botTokenEnv;
    if (typeof token === "string") {
      for (const other of d.profiles.values()) {
        for (const k of BOT_PLATFORMS) {
          const name = other.platforms[k]?.botTokenEnv;
          if (name && name !== envName && d.env[name] === token.trim()) throw new HttpError(409, `that token is already ${other.name}'s ${k} bot`);
        }
      }
    }
    try {
      setEnvVar(d.envPath, d.env, envName, typeof token === "string" ? token.trim() : null);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    await d.adapters.sync(p.characterId, p);
    return { ok: true, platform: platformsOf(p, d)[platform] };
  }

  if (method === "POST" && path === "/api/characters") {
    const id = (body as { characterId?: unknown })?.characterId;
    if (typeof id !== "string" || !/^[a-z0-9_]+$/.test(id)) throw new HttpError(400, "characterId must be lowercase letters, digits and _");
    if (d.profiles.has(id) || existsSync(join(d.charactersDir, `${id}.json`))) throw new HttpError(409, "that character already exists");
    const template = JSON.parse(readFileSync(join(d.charactersDir, "_template.json"), "utf8"));
    const upper = id.toUpperCase();
    const p = validProfile({
      ...template,
      characterId: id,
      platforms: { telegram: { botTokenEnv: `${upper}_TELEGRAM_TOKEN` }, discord: { botTokenEnv: `${upper}_DISCORD_TOKEN` } },
    });
    saveProfile(d, p);
    d.routine.reload(id);
    await d.adapters.sync(id, p);
    return { ok: true };
  }

  if (method === "GET" && path === "/api/config") return { config: d.config, defaults: DEFAULT_CONFIG, ai: aiStatus(d.env, null) };

  // keys and models: `default` is the global value, a character id is that character's override
  if ((m = path.match(/^\/api\/ai\/([a-z0-9_]+)(\/.*)?$/))) {
    const characterId = m[1] === "default" ? null : m[1];
    if (characterId && !d.profiles.has(characterId)) throw new HttpError(404, "no such character");
    const rest = m[2] ?? "";

    if (method === "GET" && rest === "/models") {
      const { baseUrl, apiKey } = llmEndpoint(d.env, characterId);
      if (!baseUrl) return { models: [] };
      try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { models: [], error: `${baseUrl}/models answered ${res.status}` };
        const data = ((await res.json()) as { data?: { id?: unknown }[] }).data ?? [];
        return { models: data.map((x) => x.id).filter((x): x is string => typeof x === "string").sort() };
      } catch (e) {
        return { models: [], error: (e as Error).message };
      }
    }

    const v = rest.slice(1) as AiVar;
    if (method === "PUT" && AI_VARS.includes(v)) {
      const raw = (body as { value?: unknown })?.value;
      if (raw !== null && (typeof raw !== "string" || !raw.trim())) throw new HttpError(400, "value must be a string, or null to unset it");
      const value = typeof raw === "string" ? raw.trim() : null;
      try {
        if (value !== null) checkAiValue(v, value);
        setEnvVar(d.envPath, d.env, aiVarName(characterId, v), value);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return { ok: true, ai: aiStatus(d.env, characterId) };
    }
  }

  if (method === "PUT" && path === "/api/config") {
    const parsed = ConfigOverridesSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "invalid config", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    applyConfig(d.config, parsed.data as Partial<Config>);
    writeConfigFile(d.configPath, d.config);
    return { ok: true, config: d.config };
  }

  if (method === "GET" && path === "/api/conversations") {
    return d.store.listConversations().map((c) => ({
      id: c.conversationId,
      characterId: c.characterId,
      platform: c.platform,
      chatId: c.chatId,
      topic: c.topic,
      lastUserAt: c.lastUserAt,
      lastBotAt: c.lastBotAt,
      messages: c.messageCount,
      openThreads: openThreads(c.unresolved, now, d.config).length,
    }));
  }

  if ((m = path.match(/^\/api\/conversations\/([^/]+)(\/.*)?$/))) {
    const id = decodeURIComponent(m[1]);
    const conv = d.store.getConversation(id);
    if (!conv) throw new HttpError(404, "no such conversation");
    const rest = m[2] ?? "";

    if (method === "GET" && rest === "") {
      const linked = new Set(d.store.linkedConversationIds(id));
      const brief = (c: { conversationId: string; platform: string; chatId: string; messageCount?: number }) => ({ id: c.conversationId, platform: c.platform, chatId: c.chatId, messages: c.messageCount });
      const others = d.store.listConversations().filter((c) => c.characterId === conv.characterId && c.conversationId !== id);
      return {
        conversation: conv,
        linked: others.filter((c) => linked.has(c.conversationId)).map(brief),
        linkable: others.filter((c) => !linked.has(c.conversationId)).map(brief),
        openThreads: openThreads(conv.unresolved, now, d.config),
        messages: d.store.recentMessages(id, 100),
        pending: d.store.pendingBotMessages(id),
        facts: d.store.memories(id, "fact", 200),
        summaries: d.store.memories(id, "summary", 50),
        events: d.store.recentEvents(id, 100),
      };
    }
    if (method === "POST" && rest === "/link") {
      const other = (body as { with?: unknown })?.with;
      if (typeof other !== "string" || other === id) throw new HttpError(400, "say which chat to link with");
      try {
        d.store.linkConversations(id, other);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      d.store.appendEvent(id, now, "CONVERSATIONS_LINKED", { with: other });
      return { ok: true, linked: d.store.linkedConversationIds(id) };
    }
    if (method === "POST" && rest === "/unlink") {
      d.store.unlinkConversation(id);
      d.store.appendEvent(id, now, "CONVERSATIONS_UNLINKED", {});
      return { ok: true };
    }
    if (method === "POST" && (m = rest.match(/^\/(\w+)$/)) && ALLOWED_COMMANDS.has(m[1])) {
      return { ok: true, message: await d.im.command(id, m[1] as "forget" | "reset") };
    }
    if (method === "DELETE" && (m = rest.match(/^\/threads\/([^/]+)$/))) {
      const threadId = decodeURIComponent(m[1]);
      // through the queue: a reply that read the row before this would otherwise save the thread back
      await d.im.run(id, () => {
        const c = d.store.getConversation(id)!;
        d.store.saveConversation({ ...c, unresolved: c.unresolved.filter((t) => t.id !== threadId) });
        d.store.appendEvent(id, d.clock.now(), "UNRESOLVED_CHANGED", { removedBy: "dashboard", id: threadId });
      });
      return { ok: true };
    }
  }

  if (method === "DELETE" && (m = path.match(/^\/api\/memories\/([^/]+)$/))) {
    if (!d.store.deleteMemory(decodeURIComponent(m[1]))) throw new HttpError(404, "no such memory");
    return { ok: true };
  }

  throw new HttpError(404, "not found");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new HttpError(413, "body too large");
  }
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

/**
 * Who may talk to it. Loopback-only by default; anything wider needs the password. Two cheap
 * guards for the loopback case, where a page in the same browser is the attacker: the Host header
 * must be ours (DNS rebinding), and a write must be `application/json` (a cross-site form or
 * no-cors fetch cannot send that without a preflight, which this server never answers).
 */
export function checkRequest(req: Pick<IncomingMessage, "method" | "headers">, o: DashboardOptions): HttpError | null {
  if (o.password) {
    const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
    const pass = scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":") : null;
    if (pass !== o.password) return new HttpError(401, "password required");
  } else {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!LOOPBACK.has(host)) return new HttpError(403, "unexpected Host header");
  }
  if (req.method !== "GET" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return new HttpError(415, "writes must be application/json");
  }
  return null;
}

export function startDashboard(d: DashboardDeps, o: DashboardOptions): Server {
  if (!LOOPBACK.has(o.host) && !o.password) throw new Error("DASHBOARD_PASSWORD is required when the dashboard is not bound to localhost");
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const denied = checkRequest(req, o);
    if (denied) return send(res, denied.status, { error: denied.message }, denied.status === 401 ? { "www-authenticate": 'Basic realm="mimic"' } : {});
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      if (req.method === "GET" && !path.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(PAGE));
      }
      send(res, 200, await route(d, req.method ?? "GET", path, await readBody(req)));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, issues: e.issues });
      console.error("[dashboard]", e);
      send(res, 500, { error: String(e) });
    }
  });
  server.listen(o.port, o.host, () => console.error(`[mimic] dashboard on http://${o.host.includes(":") ? `[${o.host}]` : o.host}:${o.port}`));
  return server;
}
