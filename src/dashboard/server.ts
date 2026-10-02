import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { availability, formatLocalTime } from "../character/derived.ts";
import { moodNow } from "../character/mood.ts";
import { ProfileSchema, type CharacterProfile } from "../character/profile.ts";
import type { RoutineEngine } from "../character/routine-engine.ts";
import type { Clock } from "../clock.ts";
import { applyConfig, ConfigOverridesSchema, DEFAULT_CONFIG, writeConfigFile, type Config } from "../config.ts";
import type { InteractionManager } from "../im/manager.ts";
import { openThreads } from "../context/context.ts";
import type { Store } from "../store.ts";
import { ACTIVITIES, PACES } from "../types.ts";

/**
 * The dashboard: one page and a JSON API, inside the bot process so that an edit is live on the
 * next turn — profiles and config are shared objects the reply path reads every time.
 *
 * What still needs a restart is said so in the response: bot tokens and platform bindings are read
 * once, when the adapters start.
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
  /** `${characterId}:${platform}` for every adapter that started at boot. */
  running: Set<string>;
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

function platformsOf(p: CharacterProfile, d: DashboardDeps) {
  return Object.fromEntries(
    (["telegram", "discord"] as const)
      .filter((k) => p.platforms[k])
      .map((k) => [k, { env: p.platforms[k]!.botTokenEnv, set: Boolean(d.env[p.platforms[k]!.botTokenEnv]), running: d.running.has(`${p.characterId}:${k}`) }]),
  );
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
    return { profile: p, platforms: platformsOf(p, d) };
  }

  if (method === "PUT" && (m = path.match(/^\/api\/characters\/([a-z0-9_]+)$/))) {
    const before = d.profiles.get(m[1]);
    if (!before) throw new HttpError(404, "no such character");
    const p = validProfile(body);
    if (p.characterId !== m[1]) throw new HttpError(400, "characterId cannot be changed: it is part of every conversation id");
    writeFileSync(profileFile(d.charactersDir, p.characterId), `${JSON.stringify(p, null, 2)}\n`);
    d.profiles.set(p.characterId, p);
    d.routine.reload(p.characterId);
    return { ok: true, restartNeeded: JSON.stringify(before.platforms) !== JSON.stringify(p.platforms) };
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
    writeFileSync(join(d.charactersDir, `${id}.json`), `${JSON.stringify(p, null, 2)}\n`);
    d.profiles.set(id, p);
    d.routine.reload(id);
    return { ok: true, restartNeeded: true };
  }

  if (method === "GET" && path === "/api/config") return { config: d.config, defaults: DEFAULT_CONFIG };

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
      return {
        conversation: conv,
        openThreads: openThreads(conv.unresolved, now, d.config),
        messages: d.store.recentMessages(id, 100),
        pending: d.store.pendingBotMessages(id),
        facts: d.store.memories(id, "fact", 200),
        summaries: d.store.memories(id, "summary", 50),
        events: d.store.recentEvents(id, 100),
      };
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
