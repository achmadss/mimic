import { test } from "node:test";
import assert from "node:assert/strict";
import { httpJevClient, type JevAnswers } from "../src/jev/client.ts";
import { buildQuestions } from "../src/jev/questions.ts";
import { FOLLOW_UP_MS, decide, type DecideContext } from "../src/jev/decide.ts";

const ctx = (over: Partial<DecideContext> = {}): DecideContext => ({
  trigger: "user_turn", pendingIds: [], basePace: "fast", maxMessages: 3, choiceConfidence: 0.5, noulThreshold: 0.7, ...over,
});
const choice = (c: string, confidence = 0.9) => ({ type: "choice" as const, choice: c, confidence, probabilities: { [c]: confidence } });
const noul = (p: number) => ({ type: "noul" as const, noul: p });

test("http client posts state+questions to systemone and returns answers", async () => {
  let seen: any;
  const fetchFn = (async (url: string, init: any) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { x: { type: "noul", noul: 0.9 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const jev = httpJevClient({ apiKey: "k", fetchFn });
  const answers = await jev.ask({ a: 1 }, { x: { type: "noul", instructions: "?" } });
  assert.equal(seen.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen.headers.authorization, "Bearer k");
  assert.equal(seen.body.model, "jev-latest");
  assert.deepEqual(seen.body.state, { a: 1 });
  assert.deepEqual(answers, { x: { type: "noul", noul: 0.9 } });
});

test("http client throws on non-2xx", async () => {
  const fetchFn = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(httpJevClient({ apiKey: "k", fetchFn }).ask({}, {}), /jev 401/);
});

test("questions: topic only on user turns, one choice per pending message", () => {
  const q = buildQuestions("user_turn", [{ id: "m1", text: "what happened?" }]);
  assert.ok(q.topic_action && q.respond_mode && q.pace && q.message_count && q.importance);
  assert.equal(q.pending_m1.type, "choice");
  assert.deepEqual(Object.keys((q.pending_m1 as any).criteria), ["continue", "cancel", "delay", "replace"]);
  assert.equal(buildQuestions("followup_due", []).topic_action, undefined);
});

test("decide: Jev unavailable → safe defaults, every pending message cancelled", () => {
  const d = decide(null, ctx({ pendingIds: ["m1", "m2"] }));
  assert.equal(d.respondMode, "now");
  assert.equal(d.pace, "fast"); // character base pace
  assert.equal(d.messageCount, 1);
  assert.equal(d.topicAction, "continue");
  assert.equal(d.followUp, undefined);
  assert.deepEqual(d.pendingActions, [
    { messageId: "m1", action: "cancel" },
    { messageId: "m2", action: "cancel" },
  ]);
});

test("decide: confident answers are used, low-confidence ones fall back", () => {
  const answers: JevAnswers = {
    respond_mode: choice("now"),
    pace: choice("slow", 0.3), // below 0.5 → default
    message_count: choice("3"),
    topic_action: choice("switch"),
    ask_question: noul(0.8),
    pending_m1: choice("continue"),
  };
  const d = decide(answers, ctx({ pendingIds: ["m1"], maxMessages: 2 }));
  assert.equal(d.pace, "fast");
  assert.equal(d.messageCount, 2); // clamped
  assert.equal(d.topicAction, "switch");
  assert.equal(d.askQuestion, true);
  assert.deepEqual(d.pendingActions, [{ messageId: "m1", action: "continue" }]);
});

test("decide: follow-up and attention", () => {
  const d = decide(
    { respond_mode: choice("now"), follow_up: noul(0.9), follow_up_after: choice("15m"), importance: { type: "score", score: 3, confidence: 0.9, probabilities: {} } },
    ctx(),
  );
  assert.deepEqual(d.followUp, { afterMs: FOLLOW_UP_MS["15m"] });
  assert.equal(d.attentionRaise, 1);
  const low = decide({ importance: { type: "score", score: 1, confidence: 0.9, probabilities: {} } }, ctx());
  assert.equal(low.attentionRaise, undefined);
});

test("decide: 'later' becomes a follow-up; on a follow-up trigger it becomes no_reply with no new follow-up", () => {
  const later = decide({ respond_mode: choice("later") }, ctx());
  assert.equal(later.respondMode, "later");
  assert.deepEqual(later.followUp, { afterMs: FOLLOW_UP_MS["1h"] });
  const loop = decide({ respond_mode: choice("later"), follow_up: noul(0.99) }, ctx({ trigger: "followup_due" }));
  assert.equal(loop.respondMode, "no_reply");
  assert.equal(loop.followUp, undefined);
});
