import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProfiles } from "../src/character/profile.ts";
import { httpJevClient, type JevAnswers } from "../src/jev/client.ts";
import { buildQuestions } from "../src/jev/questions.ts";
import { buildJevState, type JevStateInput } from "../src/jev/state.ts";
import { FOLLOW_UP_MS, decide, type DecideContext } from "../src/jev/decide.ts";
import { EMOTIONS } from "../src/types.ts";

const ctx = (over: Partial<DecideContext> = {}): DecideContext => ({
  trigger: "user_turn", pendingIds: [], basePace: "fast", maxMessages: 3, choiceMargin: 1.2, scoreConfidence: 0.4, noulThreshold: 0.7, followUpThreshold: 0.55, openThreadThreshold: 0.55, ...over,
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

test("questions: the register and the open thread are asked only where they can be read", () => {
  const ut = buildQuestions("user_turn", []);
  assert.deepEqual(Object.keys((ut.turn_emotion as any).criteria), [...EMOTIONS]);
  assert.equal(ut.opens_thread?.type, "noul");
  // both are judgements about the user's own message, so neither applies without one
  for (const trigger of ["followup_due", "activity_changed"] as const) {
    assert.equal(buildQuestions(trigger, []).turn_emotion, undefined, trigger);
    assert.equal(buildQuestions(trigger, []).opens_thread, undefined, trigger);
  }
});

test("questions: a thread left open is given to `topic_action`, so `ask` has a referent", () => {
  const thread = { id: "t1", summary: "interview tomorrow", raisedAt: 0 };
  const withThread = buildQuestions("user_turn", [], [thread]).topic_action as any;
  assert.deepEqual(withThread.instructions.unresolved, ["interview tomorrow"]);
  assert.match(withThread.criteria.ask, /unresolved/);

  const without = buildQuestions("user_turn", []).topic_action as any;
  assert.equal("unresolved" in without.instructions, false);
  assert.match(without.criteria.ask, /new topic/);
});

test("decide: emotion and the open thread are read on a user turn only", () => {
  assert.equal(decide({ turn_emotion: choice("annoyed") }, ctx()).emotion, "annoyed");
  assert.equal(decide({ turn_emotion: choice("joking", 0.1) }, ctx()).emotion, "neutral", "a torn answer is not a register");
  assert.equal(decide({}, ctx()).emotion, "neutral");
  assert.equal(decide({ turn_emotion: choice("annoyed") }, ctx({ trigger: "followup_due" })).emotion, undefined);
  assert.equal(decide({ turn_emotion: choice("annoyed") }, ctx({ trigger: "activity_changed" })).emotion, undefined);

  assert.equal(decide({ opens_thread: noul(0.9) }, ctx()).openThread, true);
  assert.equal(decide({ opens_thread: noul(0.5) }, ctx()).openThread, false);
  assert.equal(decide({ opens_thread: noul(0.9) }, ctx({ trigger: "followup_due" })).openThread, false);
  assert.equal(decide({ opens_thread: noul(0.9) }, ctx({ trigger: "activity_changed" })).openThread, false);
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
    pace: choice("slow", 0.2), // 0.2 does not clear 1.2/5 for a 5-way question → default
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

test("decide: follow_up uses its own threshold, ask_question keeps the shared one", () => {
  // an intermediate score is exactly what Jev returns for follow_up: below noulThreshold, above its own
  const mid = { follow_up: noul(0.6), ask_question: noul(0.6) };
  const d = decide(mid, ctx());
  assert.deepEqual(d.followUp, { afterMs: FOLLOW_UP_MS["1h"] });
  assert.equal(d.askQuestion, false, "the same score must NOT also trigger a question");
});

test("decide: 'later' becomes a follow-up; on a follow-up trigger it becomes no_reply with no new follow-up", () => {
  const later = decide({ respond_mode: choice("later") }, ctx());
  assert.equal(later.respondMode, "later");
  assert.deepEqual(later.followUp, { afterMs: FOLLOW_UP_MS["1h"] });
  const loop = decide({ respond_mode: choice("later"), follow_up: noul(0.99) }, ctx({ trigger: "followup_due" }));
  assert.equal(loop.respondMode, "no_reply");
  assert.equal(loop.followUp, undefined);
});

test("questions: an activity change asks only what to do with what is already queued", () => {
  const q = buildQuestions("activity_changed", [{ id: "m1", text: "on my way" }]);
  assert.ok(q.pace, "pace is still needed: a delayed message is rescheduled from it");
  assert.equal(q.pending_m1.type, "choice");
  for (const key of ["respond_mode", "topic_action", "message_count", "message_length", "mood", "importance", "follow_up", "ask_question"]) {
    assert.equal(q[key], undefined, `activity_changed must not ask ${key}`);
  }
});

test("decide: an activity change never plans a reply, but still decides the queued ones", () => {
  const d = decide({ respond_mode: choice("now"), message_count: choice("3"), ask_question: noul(0.99), pace: choice("slow"), pending_m1: choice("continue") }, ctx({ trigger: "activity_changed", pendingIds: ["m1"] }));
  assert.equal(d.respondMode, "no_reply");
  assert.equal(d.messageCount, 1);
  assert.equal(d.askQuestion, false);
  assert.equal(d.topicAction, "continue");
  assert.equal(d.mood, undefined);
  assert.equal(d.pace, "slow", "pace still applies: it times a `delay` on a kept message");
  assert.deepEqual(d.pendingActions, [{ messageId: "m1", action: "continue" }]);
});

test("decide: mood only moves on a confident answer, so it does not reset every turn", () => {
  assert.equal(decide({ mood: choice("tired") }, ctx()).mood, "tired");
  assert.equal(decide({ mood: choice("annoyed") }, ctx()).mood, "annoyed");
  assert.equal(decide({ mood: choice("tired", 0.15) }, ctx()).mood, undefined, "a torn answer leaves the mood alone");
  assert.equal(decide({ mood: choice("neutral") }, ctx()).mood, undefined, "neutral means unchanged");
  assert.equal(decide({ mood: choice("tired") }, ctx({ trigger: "followup_due" })).mood, undefined);
});

test("Jev state carries the timestamps it used to be starved of", () => {
  const profile = loadProfiles("characters").get("rick")!;
  const now = 1_000_000;
  const input: JevStateInput = {
    trigger: "user_turn",
    now,
    profile,
    activity: "working",
    activitySince: now - 4 * 60_000,
    mood: "tired",
    moodChangedAt: now - 20 * 60_000,
    attention: 0.5,
    localTime: "Thu 04:00",
    topic: "portal gun",
    lastUserAt: now - 30_000,
    lastBotAt: now - 8 * 3_600_000,
    turn: { texts: ["hey"], firstAt: now - 12_000, lastAt: now - 2_000 },
    recent: [{ role: "user", text: "hey", at: now - 30_000 }],
    pending: [{ id: "b1", text: "one sec", dueAt: now + 45_000 }],
    openThreads: [{ id: "t1", summary: "interview tomorrow", raisedAt: now - 60_000 }],
  };
  const s = buildJevState(input) as any;
  assert.equal(s.mood, "tired");
  assert.deepEqual(s.since, {
    lastUserMsgAgoMs: 30_000,
    lastBotMsgAgoMs: 8 * 3_600_000,
    turnStartedAgoMs: 12_000,
    turnLastMsgAgoMs: 2_000,
    activityChangedAgoMs: 4 * 60_000,
    moodChangedAgoMs: 20 * 60_000,
    oldestPendingInMs: 45_000,
  });
  assert.deepEqual(s.recentMessages, [{ from: "user", text: "hey", agoMs: 30_000 }]);
  assert.deepEqual(s.pendingBots, [{ id: "b1", text: "one sec", dueInMs: 45_000 }]);
  // summaries, not rows: Jev never sees `raisedAt`
  assert.deepEqual(s.unresolved, [{ id: "t1", summary: "interview tomorrow" }]);
  // a character who has never sent anything, on a turn with no history, must not produce NaN
  const bare = buildJevState({ ...input, trigger: "followup_due", lastBotAt: 0, mood: "neutral", moodChangedAt: null, turn: null, recent: [], pending: [] }) as any;
  assert.equal(bare.since.lastBotMsgAgoMs, null);
  assert.equal(bare.since.turnStartedAgoMs, null);
  assert.equal(bare.since.oldestPendingInMs, null);
  assert.deepEqual(bare.currentTurn, []);
});

test("decide: a choice is gated on the probability of its own answer, not Jev's margin", () => {
  // Jev reports the same 3-way answer two ways: probability 0.57 of "3", confidence 0.11.
  // Gating on confidence silently forced messageCount to 1 on every such turn.
  const three = { type: "choice", choice: "3", confidence: 0.11, probabilities: { "1": 0.26, "2": 0.17, "3": 0.57 } } as const;
  assert.equal(decide({ message_count: three }, ctx()).messageCount, 3);
  // a genuinely flat answer — every option near the 1/5 chance line — still takes the fallback
  const torn = { type: "choice", choice: "2", confidence: 0.02, probabilities: { "1": 0.21, "2": 0.2, "3": 0.2, "4": 0.2, "5": 0.19 } } as const;
  assert.equal(decide({ message_count: torn }, ctx()).messageCount, 1);
  // the bar scales with the option count: 0.35 clears chance among 5 options, and would not among 3
  const wide = { type: "choice", choice: "3", confidence: 0.1, probabilities: { "1": 0.2, "2": 0.2, "3": 0.35, "4": 0.15, "5": 0.1 } } as const;
  assert.equal(decide({ message_count: wide }, ctx()).messageCount, 3);
  // the same 0.35 clears chance among 5 options but not among 3, where chance is 0.33
  const threeWay = { type: "choice", choice: "later", confidence: 0.1, probabilities: { now: 0.4, later: 0.35, no_reply: 0.25 } } as const;
  assert.equal(decide({ respond_mode: threeWay }, ctx()).respondMode, "now");
});
