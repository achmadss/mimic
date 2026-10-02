import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfiles } from "../src/character/profile.ts";
import { RoutineEngine } from "../src/character/routine-engine.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { checkRequest, startDashboard } from "../src/dashboard/server.ts";
import { AdapterRegistry, type BotPlatform } from "../src/delivery/registry.ts";
import { FakeAdapter } from "./helpers.ts";
import { InteractionManager } from "../src/im/manager.ts";
import { choice, setupIM } from "./helpers.ts";

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "mimic-dash-"));
  cpSync("characters", join(dir, "characters"), { recursive: true });
  const t = setupIM();
  const profiles = loadProfiles(join(dir, "characters"));
  const config = structuredClone(DEFAULT_CONFIG);
  // the IM must see the same profiles and config objects the dashboard edits
  const im = new InteractionManager({ store: t.store, clock: t.clock, ai: () => ({ jev: t.jev, llm: t.llm }), profiles, config, log: () => {} }, () => t.adapter);
  const routine = new RoutineEngine({ store: t.store, clock: t.clock, profiles, onTransition: () => {}, log: () => {} });
  routine.start();
  const configPath = join(dir, "mimic.config.json");
  const envPath = join(dir, ".env");
  const env: NodeJS.ProcessEnv = { RICK_TELEGRAM_TOKEN: "1:rick-token" };
  // fake bots: a token containing "bad" is rejected the way Telegram's getMe would reject it
  const started: { platform: BotPlatform; token: string; stopped: boolean }[] = [];
  const adapters = new AdapterRegistry({
    allowed: ["telegram", "discord"],
    env,
    create: (platform, token) => {
      const a = new FakeAdapter(platform);
      const rec = { platform, token, stopped: false };
      a.start = async () => {
        if (token.includes("bad")) throw new Error("401: Unauthorized");
        started.push(rec);
      };
      a.stop = async () => void (rec.stopped = true);
      return a;
    },
    receive: () => {},
    onStart: (c, p) => im.adopt(c, p),
    onStop: (c, p) => im.release(c, p),
    log: () => {},
  });
  for (const p of profiles.values()) await adapters.sync(p.characterId, p);
  const server = startDashboard(
    { store: t.store, clock: t.clock, im, routine, profiles, config, configPath, charactersDir: join(dir, "characters"), adapters, envPath, env },
    { host: "127.0.0.1", port: 0 },
  );
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { t, im, profiles, config, configPath, envPath, env, started, adapters, dir, call, base, close: () => { routine.stop(); server.close(); } };
}

test("request guard: loopback Host only, JSON writes only, password when set", () => {
  const o = { host: "127.0.0.1", port: 1 };
  assert.equal(checkRequest({ method: "GET", headers: { host: "127.0.0.1:8787" } }, o), null);
  assert.equal(checkRequest({ method: "GET", headers: { host: "evil.example:8787" } }, o)?.status, 403, "DNS rebinding");
  assert.equal(checkRequest({ method: "POST", headers: { host: "localhost:8787", "content-type": "text/plain" } }, o)?.status, 415, "a cross-site form post");
  const pw = { ...o, password: "s3cret" };
  assert.equal(checkRequest({ method: "GET", headers: { host: "x" } }, pw)?.status, 401);
  const auth = `Basic ${Buffer.from("anyone:s3cret").toString("base64")}`;
  assert.equal(checkRequest({ method: "GET", headers: { host: "x", authorization: auth } }, pw), null);
  assert.throws(() => startDashboard({} as any, { host: "0.0.0.0", port: 0 }), /DASHBOARD_PASSWORD/);
});

test("overview and the page", async () => {
  const d = await boot();
  try {
    const o = (await d.call("GET", "/api/overview")).body;
    const rick = o.characters.find((c: any) => c.id === "rick");
    assert.deepEqual(rick.platforms.telegram, { env: "RICK_TELEGRAM_TOKEN", tokenSet: true, tokenHint: "…oken", running: true, error: null });
    assert.equal(JSON.stringify(o).includes("1:rick-token"), false, "a token is never sent to the page");
    assert.ok(o.enums.activity.includes("sleeping"));
    const page = await fetch(d.base + "/");
    assert.match(await page.text(), /<title>mimic<\/title>/);
  } finally {
    d.close();
  }
});

test("a character edit is validated, written to its file, and live", async () => {
  const d = await boot();
  try {
    const { profile } = (await d.call("GET", "/api/characters/rick")).body;
    const bad = await d.call("PUT", "/api/characters/rick", { ...profile, timezone: "Mars/Olympus" });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.issues.map((i: any) => i.path), ["timezone"]);
    assert.equal((await d.call("PUT", "/api/characters/rick", { ...profile, characterId: "bob" })).status, 400);

    const ok = await d.call("PUT", "/api/characters/rick", { ...profile, name: "Rick C-137" });
    assert.equal(ok.body.ok, true);
    assert.equal(d.started.length, 1, "an unrelated edit does not restart the bot");
    assert.equal(d.profiles.get("rick")!.name, "Rick C-137", "the shared map the reply path reads");
    assert.equal(JSON.parse(readFileSync(join(d.dir, "characters", "rick.json"), "utf8")).name, "Rick C-137");

    const moved = await d.call("PUT", "/api/characters/rick", { ...profile, platforms: {} });
    assert.deepEqual(moved.body.platforms, {});
    assert.equal(d.started[0].stopped, true, "unbinding stops the bot, no restart");
    const morty = d.profiles.get("morty")!;
    const clash = await d.call("PUT", "/api/characters/rick", { ...profile, platforms: { telegram: { botTokenEnv: morty.platforms.telegram!.botTokenEnv } } });
    assert.equal(clash.status, 409, "two characters cannot share a token");
  } finally {
    d.close();
  }
});

test("a new character comes from the template and loads", async () => {
  const d = await boot();
  try {
    assert.equal((await d.call("POST", "/api/characters", { characterId: "Bad Id" })).status, 400);
    assert.equal((await d.call("POST", "/api/characters", { characterId: "rick" })).status, 409);
    const r = await d.call("POST", "/api/characters", { characterId: "nadia" });
    assert.deepEqual(r.body, { ok: true });
    assert.equal(loadProfiles(join(d.dir, "characters")).get("nadia")!.platforms.telegram!.botTokenEnv, "NADIA_TELEGRAM_TOKEN");
    assert.ok(d.profiles.has("nadia"));
  } finally {
    d.close();
  }
});

test("config: validated, applied in place, and only the difference is saved", async () => {
  const d = await boot();
  try {
    assert.equal((await d.call("PUT", "/api/config", { quietMs: -1 })).status, 400);
    assert.equal((await d.call("PUT", "/api/config", { madeUp: 1 })).status, 400);
    const r = await d.call("PUT", "/api/config", { quietMs: 4000, maxChars: { discord: 1500 } });
    assert.equal(r.status, 200);
    assert.equal(d.config.quietMs, 4000);
    assert.equal(d.config.maxChars.telegram, 4096, "a partial maxChars keeps the rest");
    assert.deepEqual(JSON.parse(readFileSync(d.configPath, "utf8")), { quietMs: 4000, maxChars: { discord: 1500 } });
    assert.equal(DEFAULT_CONFIG.maxChars.discord, 2000, "the defaults themselves are never touched");
  } finally {
    d.close();
  }
});

test("conversations: list, detail, delete a memory and a thread, reset", async () => {
  const d = await boot();
  try {
    const { t } = d;
    t.jev.next = { respond_mode: choice("now") };
    t.llm.outputs = [{ messages: [{ text: "sup" }], topic: null, openThread: null }];
    d.im.receive("rick", "cli", { chatId: "local", platformMessageId: "u1", text: "hey" });
    await d.im.drain();
    t.clock.advance(3000);
    await d.im.drain();
    const id = "rick:cli:local";
    const c = t.store.getConversation(id)!;
    t.store.saveConversation({ ...c, unresolved: [{ id: "t1", summary: "exam", raisedAt: t.clock.now() }] });
    t.store.saveMemories(id, [{ id: "f1", conversationId: id, kind: "fact", text: "Has a cat.", fromAt: 0, toAt: 0 }], 0);

    const list = (await d.call("GET", "/api/conversations")).body;
    assert.equal(list[0].id, id);
    assert.equal(list[0].openThreads, 1);
    const detail = (await d.call("GET", `/api/conversations/${encodeURIComponent(id)}`)).body;
    assert.deepEqual(detail.messages.map((m: any) => m.text), ["hey"]);
    assert.equal(detail.pending.length, 1);
    assert.ok(detail.events.some((e: any) => e.type === "BEHAVIOR_DECISION_CREATED"));

    assert.equal((await d.call("DELETE", "/api/memories/f1", {})).status, 200);
    assert.equal((await d.call("DELETE", `/api/conversations/${encodeURIComponent(id)}/threads/t1`, {})).status, 200);
    assert.deepEqual(t.store.getConversation(id)!.unresolved, []);
    assert.equal(t.store.memories(id, "fact", 10).length, 0);

    assert.equal((await d.call("POST", `/api/conversations/${encodeURIComponent(id)}/debug`, {})).status, 404, "only forget and reset");
    const reset = await d.call("POST", `/api/conversations/${encodeURIComponent(id)}/reset`, {});
    assert.match(reset.body.message, /Chat reset/);
    assert.equal(t.store.pendingBotMessages(id).length, 0);
    assert.equal(t.adapter.sent.length, 0, "a dashboard reset does not message the user");
  } finally {
    d.close();
  }
});

test("tokens: set, swap, reject, remove, all live, and written to .env", async () => {
  const d = await boot();
  try {
    const set = await d.call("PUT", "/api/characters/morty/platforms/discord", { token: "MTIz.morty.dc" });
    assert.deepEqual(set.body.platform, { env: "MORTY_DISCORD_TOKEN", tokenSet: true, tokenHint: "…y.dc", running: true, error: null });
    assert.match(readFileSync(d.envPath, "utf8"), /^MORTY_DISCORD_TOKEN=MTIz\.morty\.dc$/m);

    // a new token replaces the running bot
    await d.call("PUT", "/api/characters/morty/platforms/discord", { token: "MTIz.morty.two" });
    assert.deepEqual(d.started.filter((s) => s.platform === "discord").map((s) => [s.token, s.stopped]), [["MTIz.morty.dc", true], ["MTIz.morty.two", false]]);

    const bad = await d.call("PUT", "/api/characters/morty/platforms/telegram", { token: "9:bad" });
    assert.equal(bad.body.platform.running, false);
    assert.equal(bad.body.platform.error, "401: Unauthorized", "a rejected token is reported, not swallowed");

    assert.equal((await d.call("PUT", "/api/characters/morty/platforms/telegram", { token: "1:rick-token" })).status, 409, "Rick's token");
    assert.equal((await d.call("PUT", "/api/characters/morty/platforms/telegram", { token: "a b" })).status, 400);

    const off = await d.call("PUT", "/api/characters/morty/platforms/discord", { token: null });
    assert.equal(off.body.platform.running, false);
    assert.doesNotMatch(readFileSync(d.envPath, "utf8"), /MORTY_DISCORD_TOKEN/);

    // a character with no binding for a platform gets one when a token arrives
    await d.call("POST", "/api/characters", { characterId: "nadia" });
    const p = d.profiles.get("nadia")!;
    await d.call("PUT", "/api/characters/nadia", { ...p, platforms: {} });
    const bound = await d.call("PUT", "/api/characters/nadia/platforms/telegram", { token: "5:nadia" });
    assert.equal(bound.body.platform.env, "NADIA_TELEGRAM_TOKEN");
    assert.equal(d.profiles.get("nadia")!.platforms.telegram!.botTokenEnv, "NADIA_TELEGRAM_TOKEN");
  } finally {
    d.close();
  }
});

test("link and unlink two chats from the dashboard", async () => {
  const d = await boot();
  try {
    const tg = d.t.store.getOrCreateConversation("rick", "telegram", "1").conversationId;
    const dc = d.t.store.getOrCreateConversation("rick", "discord", "9").conversationId;
    const mt = d.t.store.getOrCreateConversation("morty", "discord", "9").conversationId;
    const path = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
    const before = (await d.call("GET", path(tg))).body;
    assert.deepEqual(before.linked, []);
    assert.ok(before.linkable.some((c: any) => c.id === dc));
    assert.ok(!before.linkable.some((c: any) => c.id === mt), "another character's chat is not offered");

    assert.equal((await d.call("POST", path(tg) + "/link", { with: mt })).status, 400);
    assert.equal((await d.call("POST", path(tg) + "/link", { with: dc })).status, 200);
    assert.deepEqual((await d.call("GET", path(dc))).body.linked.map((c: any) => c.id), [tg]);
    await d.call("POST", path(tg) + "/unlink", {});
    assert.deepEqual((await d.call("GET", path(dc))).body.linked, []);
  } finally {
    d.close();
  }
});

test("model and keys: defaults, per-character overrides, validated, written to .env", async () => {
  const d = await boot();
  try {
    assert.equal((await d.call("PUT", "/api/ai/default/LLM_MODEL", { value: "glm-5" })).status, 200);
    const key = await d.call("PUT", "/api/ai/rick/LLM_API_KEY", { value: "sk-rick-1234" });
    assert.deepEqual(key.body.ai.LLM_API_KEY, { name: "RICK_LLM_API_KEY", secret: true, own: "…1234", effective: "…1234" }, "a key is never echoed");
    assert.deepEqual(key.body.ai.LLM_MODEL, { name: "RICK_LLM_MODEL", secret: false, own: null, effective: "glm-5" }, "unset falls back to the default");

    await d.call("PUT", "/api/ai/rick/LLM_MODEL", { value: "kimi-k3/preview" });
    const rick = await d.call("GET", "/api/characters/rick");
    assert.equal(rick.body.ai.LLM_MODEL.effective, "kimi-k3/preview");
    assert.equal((await d.call("GET", "/api/characters/morty")).body.ai.LLM_MODEL.effective, "glm-5", "Morty is untouched");
    assert.match(readFileSync(d.envPath, "utf8"), /^RICK_LLM_API_KEY=sk-rick-1234$/m);
    assert.equal(d.env.RICK_LLM_MODEL, "kimi-k3/preview", "the running process sees it");

    assert.equal((await d.call("PUT", "/api/ai/rick/LLM_STRUCTURED_MODE", { value: "xml" })).status, 400);
    assert.equal((await d.call("PUT", "/api/ai/rick/LLM_BASE_URL", { value: "not-a-url" })).status, 400);
    assert.equal((await d.call("PUT", "/api/ai/rick/PATH", { value: "x" })).status, 404, "only the AI vars are writable");
    assert.equal((await d.call("PUT", "/api/ai/nobody/LLM_MODEL", { value: "x" })).status, 404);

    const unset = await d.call("PUT", "/api/ai/rick/LLM_MODEL", { value: null });
    assert.equal(unset.body.ai.LLM_MODEL.effective, "glm-5");
    assert.equal((await d.call("GET", "/api/config")).body.ai.LLM_MODEL.own, "glm-5");
  } finally {
    d.close();
  }
});
