import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEnvVar } from "../src/envfile.ts";

test("setEnvVar replaces, appends and removes one line, and leaves the rest alone", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mimic-env-")), ".env");
  writeFileSync(path, "# keys\nLLM_API_KEY=abc\nRICK_TELEGRAM_TOKEN=old\n");
  const env: NodeJS.ProcessEnv = {};
  setEnvVar(path, env, "RICK_TELEGRAM_TOKEN", "123:New-tok_en");
  setEnvVar(path, env, "RICK_DISCORD_TOKEN", "MTIz.abc.def");
  assert.equal(readFileSync(path, "utf8"), "# keys\nLLM_API_KEY=abc\nRICK_TELEGRAM_TOKEN=123:New-tok_en\nRICK_DISCORD_TOKEN=MTIz.abc.def\n");
  assert.equal(env.RICK_DISCORD_TOKEN, "MTIz.abc.def");
  setEnvVar(path, env, "RICK_TELEGRAM_TOKEN", null);
  assert.equal(readFileSync(path, "utf8"), "# keys\nLLM_API_KEY=abc\nRICK_DISCORD_TOKEN=MTIz.abc.def\n");
  assert.equal(env.RICK_TELEGRAM_TOKEN, undefined);
  assert.throws(() => setEnvVar(path, env, "X", "a b\nEVIL=1"), /bot token/, "no line injection");
  assert.throws(() => setEnvVar(path, env, "bad-name", "x"), /UPPER_SNAKE_CASE/);
});
