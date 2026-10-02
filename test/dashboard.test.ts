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
import { InteractionManager } from "../src/im/manager.ts";
import { choice, setupIM } from "./helpers.ts";

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "mimic-dash-"));
  cpSync("characters", join(dir, "characters"), { recursive: true });
  const t = setupIM();
  const profiles = loadProfiles(join(dir, "characters"));
  const config = structuredClone(DEFAULT_CONFIG);
  // the IM must see the same profiles and config objects the dashboard edits
  const im = new InteractionManager({ store: t.store, clock: t.clock, jev: t.jev, llm: t.llm, profiles, config, log: () => {} }, () => t.adapter);
  const routine = new RoutineEngine({ store: t.store, clock: t.clock, profiles, onTransition: () => {}, log: () => {} });
  routine.start();
  const configPath = join(dir, "mimic.config.json");
  const server = startDashboard(
    { store: t.store, clock: t.clock, im, routine, profiles, config, configPath, charactersDir: join(dir, "characters"), running: new Set(["rick:telegram"]), env: { RICK_TELEGRAM_TOKEN: "x" } },
    { host: "127.0.0.1", port: 0 },
  );
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { t, im, profiles, config, configPath, dir, call, base, close: () => { routine.stop(); server.close(); } };
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
    assert.deepEqual(rick.platforms.telegram, { env: "RICK_TELEGRAM_TOKEN", set: true, running: true });
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
    assert.deepEqual(ok.body, { ok: true, restartNeeded: false });
    assert.equal(d.profiles.get("rick")!.name, "Rick C-137", "the shared map the reply path reads");
    assert.equal(JSON.parse(readFileSync(join(d.dir, "characters", "rick.json"), "utf8")).name, "Rick C-137");

    const moved = await d.call("PUT", "/api/characters/rick", { ...profile, platforms: {} });
    assert.equal(moved.body.restartNeeded, true);
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
    assert.deepEqual(r.body, { ok: true, restartNeeded: true });
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
