import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { CliAdapter } from "../src/delivery/cli.ts";
import type { IncomingText } from "../src/delivery/types.ts";

test("cli adapter reads lines and writes replies", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (d) => (written += d));
  const got: IncomingText[] = [];
  const a = new CliAdapter("Rick", input, output);
  await a.start((m) => got.push(m));
  input.write("hello\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(got[0].text, "hello");
  assert.equal(got[0].chatId, "local");
  await a.send("local", "what", "k1");
  assert.equal(written, "Rick: what\n");
  await a.stop();
});

test("cli message ids are unique across adapter instances (Review Focus 5)", async () => {
  const ids: string[] = [];
  for (let run = 0; run < 2; run++) {
    const input = new PassThrough();
    const a = new CliAdapter("Rick", input, new PassThrough());
    await a.start((m) => ids.push(m.platformMessageId));
    input.write("same text\n");
    await new Promise((r) => setImmediate(r));
    await a.stop();
  }
  assert.equal(new Set(ids).size, 2);
});
