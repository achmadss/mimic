import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProfiles } from "../src/character/profile.ts";
import { openAICompatibleClient, parseJsonLoose, type StructuredMode } from "../src/llm/client.ts";
import { buildPrompt } from "../src/llm/prompt.ts";
import { decide } from "../src/jev/decide.ts";

const ok = (content: unknown, toolArgs = false) =>
  () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: toolArgs
              ? { tool_calls: [{ function: { name: "reply", arguments: JSON.stringify(content) } }] }
              : { content: typeof content === "string" ? content : JSON.stringify(content) },
          },
        ],
      }),
      { status: 200 },
    );

function fakeFetch(responses: (() => Response)[]) {
  const calls: any[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const client = (mode: StructuredMode, fn: typeof fetch) =>
  openAICompatibleClient({ baseUrl: "https://llm.test/v1/", apiKey: "k", model: "m", mode, retries: 2, retryDelayMs: 0, fetchFn: fn });

const VALID = { messages: [{ text: "yo", correction: null }], topic: null };

test("json_schema mode sends response_format and parses content", async () => {
  const f = fakeFetch([ok(VALID)]);
  const out = await client("json_schema", f.fn).generate([{ role: "user", content: "hi" }]);
  assert.equal(f.calls[0].url, "https://llm.test/v1/chat/completions");
  assert.equal(f.calls[0].headers.authorization, "Bearer k");
  assert.equal(f.calls[0].body.response_format.type, "json_schema");
  assert.equal(out.messages[0].text, "yo");
});

test("tool mode forces the reply tool and parses its arguments", async () => {
  const f = fakeFetch([ok(VALID, true)]);
  const out = await client("tool", f.fn).generate([{ role: "user", content: "hi" }]);
  assert.equal(f.calls[0].body.tool_choice.function.name, "reply");
  assert.equal(out.messages[0].text, "yo");
});

test("json_object mode appends the schema instruction", async () => {
  const f = fakeFetch([ok(VALID)]);
  await client("json_object", f.fn).generate([{ role: "user", content: "hi" }]);
  const msgs = f.calls[0].body.messages;
  assert.equal(f.calls[0].body.response_format.type, "json_object");
  assert.match(msgs[msgs.length - 1].content, /JSON schema/);
});

test("identifies itself and sends the per-conversation session header", async () => {
  const f = fakeFetch([ok(VALID), ok(VALID)]);
  const c = client("json_schema", f.fn);
  await c.generate([{ role: "user", content: "hi" }], { sessionId: "sess-1" });
  await c.generate([{ role: "user", content: "hi" }], { sessionId: "sess-1" });
  assert.equal(f.calls[0].headers["user-agent"], "mimic/0.1");
  assert.equal(f.calls[0].headers["x-opencode-session"], "sess-1");
  assert.equal(f.calls[1].headers["x-opencode-session"], "sess-1"); // stable across turns of a conversation
});

test("fenced JSON with prose around it is parsed", () => {
  assert.deepEqual(parseJsonLoose('sure!\n```json\n{"a":1}\n```\nhope that helps'), { a: 1 });
  assert.deepEqual(parseJsonLoose('here: {"a":{"b":2}} done'), { a: { b: 2 } });
});

test("schema mismatch and 5xx are retried; then succeeds", async () => {
  const f = fakeFetch([ok({ nope: true }), () => new Response("err", { status: 503 }), ok(VALID)]);
  const out = await client("json_schema", f.fn).generate([{ role: "user", content: "hi" }]);
  assert.equal(f.calls.length, 3);
  assert.equal(out.messages[0].text, "yo");
});

test("4xx (non-429) is not retried; exhausting retries throws", async () => {
  const f1 = fakeFetch([() => new Response("bad", { status: 400 })]);
  await assert.rejects(client("json_schema", f1.fn).generate([]), /400/);
  assert.equal(f1.calls.length, 1);
  const f2 = fakeFetch([ok("not json"), ok("not json"), ok("not json")]);
  await assert.rejects(client("json_schema", f2.fn).generate([]));
  assert.equal(f2.calls.length, 3);
});

test("prompt: persona, plan, history roles, follow-up framing", () => {
  const rick = loadProfiles("characters").get("rick")!;
  const decision = { ...decide(null, { trigger: "user_turn", pendingIds: [], basePace: "fast", maxMessages: 3, choiceMargin: 1.2, scoreConfidence: 0.4, noulThreshold: 0.7, followUpThreshold: 0.55 }), messageCount: 2 };
  const msgs = buildPrompt({
    profile: rick, decision, trigger: "user_turn", activity: "idle", localTime: "Thu 04:00", topic: "portal gun",
    recent: [{ role: "user", text: "sup" }, { role: "bot", text: "what" }], turn: ["my boss quit"], keptPending: [], styles: [{ lowercase: false, typo: false, correct: false }, { lowercase: false, typo: false, correct: false }],
  });
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /Rick Sanchez/);
  assert.match(msgs[0].content, /exactly 2 message/);
  assert.match(msgs[0].content, /portal gun/);
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(msgs[msgs.length - 1].content, "my boss quit");

  // the per-message budget comes from the character's own ceiling, scaled by Jev's length class
  const short = buildPrompt({
    profile: rick, decision: { ...decision, messageCount: 3, messageLength: "terse" }, trigger: "user_turn", activity: "idle", localTime: "Thu 04:00", topic: null,
    recent: [], turn: ["sup"], keptPending: [], styles: [],
  });
  const budget = Math.max(20, Math.round(rick.speechStyle.maxCharsPerMessage * 0.12)); // 20-char floor
  assert.match(short[0].content, new RegExp(`under about ${budget} characters`));
  assert.match(short[0].content, /One thought per message/);
  assert.match(short[0].content, /exactly 3 message/);
  const long = buildPrompt({
    profile: rick, decision: { ...decision, messageCount: 1, messageLength: "long" }, trigger: "user_turn", activity: "idle", localTime: "Thu 04:00", topic: null,
    recent: [], turn: ["sup"], keptPending: [], styles: [],
  });
  assert.match(long[0].content, new RegExp(`under about ${rick.speechStyle.maxCharsPerMessage} characters`));

  const fu = buildPrompt({ profile: rick, decision, trigger: "followup_due", activity: "idle", localTime: "Thu 04:00", topic: null, recent: [], turn: [], keptPending: [], styles: [] });
  assert.equal(fu.length, 1);
  assert.match(fu[0].content, /on your own/);
});
