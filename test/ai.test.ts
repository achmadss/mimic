import { test } from "node:test";
import assert from "node:assert/strict";
import { aiClients, importFromEnv } from "../src/ai.ts";

test("a character's own keys win, unset ones fall back, and a change rebuilds the clients", () => {
  const env: NodeJS.ProcessEnv = { LLM_BASE_URL: "https://x/v1", LLM_MODEL: "m", LLM_API_KEY: "k", TYPESAFE_API_KEY: "j" };
  const ai = aiClients((n) => env[n]);
  const first = ai("rick");
  assert.equal(ai("rick"), first, "cached while nothing changes");
  env.RICK_LLM_MODEL = "other";
  assert.notEqual(ai("rick"), first, "a new model applies on the next call");
  assert.equal(ai("morty"), ai("morty"));

  delete env.TYPESAFE_API_KEY;
  assert.throws(() => ai("morty"), /morty has no TYPESAFE_API_KEY/);
  env.RICK_TYPESAFE_API_KEY = "rj";
  assert.ok(ai("rick"), "Rick has his own Jev key");
  env.RICK_LLM_STRUCTURED_MODE = "xml";
  assert.throws(() => ai("rick"), /LLM_STRUCTURED_MODE/);
});

test("keys left in .env are copied into the store once, never over a stored value", () => {
  const stored = new Map([["LLM_MODEL", "from-dashboard"]]);
  const env = { LLM_MODEL: "from-env", LLM_API_KEY: "k", RICK_TELEGRAM_TOKEN: "" };
  const moved = importFromEnv(env, ["LLM_MODEL", "LLM_API_KEY", "RICK_TELEGRAM_TOKEN", "LLM_API_KEY"], (n) => stored.get(n), (n, v) => stored.set(n, v));
  assert.deepEqual(moved, ["LLM_API_KEY"]);
  assert.equal(stored.get("LLM_MODEL"), "from-dashboard");
});
