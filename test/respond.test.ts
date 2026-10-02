import { test } from "node:test";
import assert from "node:assert/strict";
import { respond, splitToCount } from "../src/im/respond.ts";
import type { BotMessage } from "../src/types.ts";
import { choice, makeDeps, noul, score } from "./helpers.ts";

const turn = (texts: string[], firstAt: number) => ({ texts, firstAt, lastAt: firstAt });

function seedPending(store: ReturnType<typeof makeDeps>["store"], convId: string, over: Partial<BotMessage> = {}) {
  const m: BotMessage = { id: "old1", conversationId: convId, generationId: "g0", conversationVersion: 0, text: "what happened?", order: 0, status: "scheduled", dueAt: 0, ...over };
  store.insertBotMessage(m);
  store.putAction({ id: m.id, conversationId: convId, kind: "send_message", dueAt: m.dueAt });
  return m;
}

test("schedules fragments stamped with the current version, increasing dueAt, actions persisted", async () => {
  const { deps, store, jev, llm, convId, clock } = makeDeps();
  const c = store.getConversation(convId)!;
  store.saveConversation({ ...c, version: 3 });
  jev.next = { respond_mode: choice("now"), message_count: choice("2"), pace: choice("fast") };
  llm.outputs = [{ messages: [{ text: "wait what" }, { text: "your boss quit??" }] }];
  await respond(deps, convId, "user_turn", turn(["my boss quit"], clock.now()));
  const pending = store.pendingBotMessages(convId);
  assert.deepEqual(pending.map((m) => m.text), ["wait what", "your boss quit??"]);
  assert.ok(pending.every((m) => m.conversationVersion === 3));
  assert.ok(pending[0].dueAt > clock.now() && pending[1].dueAt > pending[0].dueAt);
  assert.ok(pending.every((m) => store.getAction(m.id)?.kind === "send_message"));
  assert.deepEqual(jev.calls[0].state.currentTurn, ["my boss quit"]);
});

test("clamps: message count, correction as extra fragment, empty correction dropped, max chars", async () => {
  const { deps, store, jev, llm, convId, clock } = makeDeps();
  jev.next = { message_count: choice("1"), pending_keep: choice("continue") };
  llm.outputs = [{ messages: [{ text: "see u tomorow", correction: "*tomorrow" }, { text: "extra" }] }];
  await respond(deps, convId, "user_turn", turn(["bye"], clock.now()));
  assert.deepEqual(store.pendingBotMessages(convId).map((m) => m.text), ["see u tomorow", "*tomorrow"]);

  const b = makeDeps();
  b.llm.outputs = [{ messages: [{ text: "x".repeat(2500), correction: "  " }] }];
  await respond(b.deps, b.convId, "user_turn", turn(["hi"], b.clock.now()));
  const only = b.store.pendingBotMessages(b.convId);
  assert.equal(only.length, 1);
  assert.equal(only[0].text.length, 2000);
});

test("Jev unavailable: pending cancelled, reply still generated at the character's base pace", async () => {
  const { deps, store, jev, llm, convId, clock } = makeDeps();
  seedPending(store, convId, { dueAt: clock.now() + 5000 });
  jev.next = new Error("down");
  await respond(deps, convId, "user_turn", turn(["never mind"], clock.now()));
  assert.equal(store.getBotMessage("old1")!.status, "cancelled");
  assert.equal(store.getAction("old1"), undefined);
  assert.equal(llm.calls.length, 1);
  const decision = store.events(convId).find((e) => e.type === "BEHAVIOR_DECISION_CREATED")!.payload;
  assert.equal(decision.pace, "fast");
});

test("pending question carries the queued text; continue re-stamps it and the new reply follows it", async () => {
  const { deps, store, jev, llm, convId, clock } = makeDeps();
  store.saveConversation({ ...store.getConversation(convId)!, version: 2 });
  seedPending(store, convId, { conversationVersion: 1, dueAt: clock.now() - 10 }); // was held while user typed
  jev.next = (q) => {
    assert.deepEqual((q.pending_old1 as any).instructions.queued, "what happened?");
    return { pending_old1: choice("continue"), pace: choice("instant") };
  };
  llm.outputs = [{ messages: [{ text: "anyway" }] }];
  await respond(deps, convId, "user_turn", turn(["lol"], clock.now()));
  const [kept, fresh] = store.pendingBotMessages(convId);
  assert.equal(kept.id, "old1");
  assert.equal(kept.conversationVersion, 2);
  assert.ok(kept.dueAt >= clock.now());
  assert.equal(store.getAction("old1")!.dueAt, kept.dueAt);
  assert.equal(fresh.text, "anyway");
  assert.ok(fresh.dueAt > kept.dueAt);
  assert.match(llm.calls[0][0].content, /already queued/);
});

test("no_reply skips the LLM", async () => {
  const { deps, jev, llm, convId, clock } = makeDeps();
  jev.next = { respond_mode: choice("no_reply") };
  await respond(deps, convId, "user_turn", turn(["ok"], clock.now()));
  assert.equal(llm.calls.length, 0);
});

test("follow-up is scheduled; on a follow-up trigger 'later' sends nothing and schedules nothing", async () => {
  const { deps, store, jev, convId, clock } = makeDeps();
  jev.next = { respond_mode: choice("now"), follow_up: noul(0.9), follow_up_after: choice("15m") };
  await respond(deps, convId, "user_turn", turn(["what are you doing"], clock.now()));
  assert.equal(store.getAction(`followup:${convId}`)!.dueAt, clock.now() + 15 * 60_000);

  const b = makeDeps();
  b.jev.next = { respond_mode: choice("later") };
  await respond(b.deps, b.convId, "followup_due", null);
  assert.equal(b.llm.calls.length, 0);
  assert.equal(b.store.getAction(`followup:${b.convId}`), undefined);
});

test("LLM failure is logged as an event and nothing is scheduled", async () => {
  const { deps, store, llm, convId, clock } = makeDeps();
  llm.outputs = [new Error("llm down")];
  await respond(deps, convId, "user_turn", turn(["hi"], clock.now()));
  assert.equal(store.pendingBotMessages(convId).length, 0);
  assert.ok(store.events(convId).some((e) => e.type === "LLM_GENERATION_FAILED"));
});

test("topic switch uses the LLM label; attention raise is stored", async () => {
  const { deps, store, jev, llm, convId, clock } = makeDeps();
  jev.next = { topic_action: choice("switch"), importance: score(3) };
  llm.outputs = [{ messages: [{ text: "wait what interview" }], topic: "job interview" }];
  await respond(deps, convId, "user_turn", turn(["forget the pc, i got an interview"], clock.now()));
  const c = store.getConversation(convId)!;
  assert.equal(c.topic, "job interview");
  assert.equal(c.topicStartedAt, clock.now());
  assert.equal(c.attention, 1);
  assert.ok(store.events(convId).some((e) => e.type === "TOPIC_CHANGED"));
});

test("a smaller raise never lowers stored attention, and the change is logged", async () => {
  const { deps, store, jev, convId, clock } = makeDeps();
  jev.next = { importance: score(3) }; // 3/3 = 1
  await respond(deps, convId, "user_turn", turn(["my flatmate flooded the kitchen"], clock.now()));
  assert.equal(store.getConversation(convId)!.attention, 1);

  clock.advance(60_000);
  jev.next = { importance: score(2) }; // 2/3 ≈ 0.67 — important, but not more than before
  await respond(deps, convId, "user_turn", turn(["also i lost my keys"], clock.now()));
  assert.equal(store.getConversation(convId)!.attention, 1);
  assert.equal(store.getConversation(convId)!.attentionRaisedAt, clock.now());
  assert.deepEqual(
    store.events(convId).filter((e) => e.type === "ATTENTION_CHANGED").map((e) => e.payload.attention),
    [1, 1],
  );
});

test("splitToCount: rescues a paragraph the model wrote where Jev asked for beats", () => {
  assert.deepEqual(splitToCount("fine. dont go friday. you go in there and its two of you.", 3), [
    "fine.",
    "dont go friday.",
    "you go in there and its two of you.",
  ]);
  assert.deepEqual(splitToCount("a. b. c. d. e. f.", 2), ["a. b. c.", "d. e. f."]);
  // it only ever splits: never a merge, never more than asked for, never a guess with nothing to cut on
  assert.deepEqual(splitToCount("one. two.", 1), ["one. two."]);
  assert.deepEqual(splitToCount("a. b.", 5), ["a. b."]);
  assert.deepEqual(splitToCount("just one thought here", 3), ["just one thought here"]);
  assert.deepEqual(splitToCount("", 2), [""]);
});

test("a line the model re-sent that is already queued is dropped", async () => {
  const { deps, clock, store, llm, jev, convId } = makeDeps();
  jev.next = { message_count: choice("2"), pending_keep: choice("continue") };
  const queued: BotMessage = { id: "keep", conversationId: convId, generationId: "g0", conversationVersion: 0, text: "night, dipshit", order: 0, status: "scheduled", dueAt: clock.now() + 60_000 };
  store.insertBotMessage(queued);
  deps.scheduler.schedule({ id: "keep", conversationId: convId, kind: "send_message", dueAt: queued.dueAt });
  llm.outputs = [{ messages: [{ text: "Night, dipshit!" }, { text: "wear the gloves" }] }];

  await respond(deps, convId, "user_turn", turn(["ok. night"], clock.now()));
  const texts = store.pendingBotMessages(convId).filter((m) => m.id !== "keep").map((m) => m.text);
  assert.deepEqual(texts, ["wear the gloves"], "the duplicate is dropped, the new line is not");
});

test("dropping every generated line still leaves the queued ones on their way", async () => {
  const { deps, clock, store, llm, jev, convId } = makeDeps();
  jev.next = { message_count: choice("1"), pending_keep: choice("continue") };
  const queued: BotMessage = { id: "keep", conversationId: convId, generationId: "g0", conversationVersion: 0, text: "night, dipshit", order: 0, status: "scheduled", dueAt: clock.now() + 60_000 };
  store.insertBotMessage(queued);
  deps.scheduler.schedule({ id: "keep", conversationId: convId, kind: "send_message", dueAt: queued.dueAt });
  llm.outputs = [{ messages: [{ text: "night, dipshit." }] }];

  await respond(deps, convId, "user_turn", turn(["ok"], clock.now()));
  assert.deepEqual(store.pendingBotMessages(convId).map((m) => m.id), ["keep"]);
});

const example = (id: string, emotion: "joking" | "sad" = "joking") => ({
  id, characterId: "rick", episode: "1", emotion, secondary: [], lines: [{ speaker: "rick", text: id }],
});

test("examples reach the prompt for the turn's register, and never on a follow-up", async () => {
  const { deps, store, jev, llm, convId, clock } = makeDeps();
  store.saveExample(example("joke-1"));
  store.saveExample(example("sad-1", "sad"));

  jev.next = { turn_emotion: choice("joking") };
  await respond(deps, convId, "user_turn", turn(["lmao"], clock.now()));
  assert.match(llm.calls[0][0].content, /Here is how Rick talks/);
  assert.match(llm.calls[0][0].content, /RICK: joke-1/);
  assert.doesNotMatch(llm.calls[0][0].content, /sad-1/, "only the matching bucket is read");

  // a follow-up has no user message, so there is no register to match and no example is fetched
  const fu = makeDeps();
  fu.store.saveExample(example("joke-1"));
  await respond(fu.deps, fu.convId, "followup_due", null);
  assert.doesNotMatch(fu.llm.calls[0][0].content, /Here is how Rick talks/);
});

test("a character with no examples still replies", async () => {
  const { deps, store, llm, convId, clock } = makeDeps();
  assert.equal(store.exampleCount(), 0);
  await respond(deps, convId, "user_turn", turn(["hey"], clock.now()));
  assert.equal(store.pendingBotMessages(convId).length, 1);
  assert.equal(llm.calls.length, 1);
});

test("a raised thread is stored, offered to Jev, and retired once it has been asked about", async () => {
  const { deps, store, jev, llm, convId, clock } = makeDeps();
  jev.next = { opens_thread: noul(0.95) };
  llm.outputs = [{ messages: [{ text: "good luck with it" }], openThread: "interview tomorrow" }];
  await respond(deps, convId, "user_turn", turn(["i have the interview tomorrow"], clock.now()));
  const open = store.getConversation(convId)!.unresolved;
  assert.deepEqual(open.map((t) => t.summary), ["interview tomorrow"]);

  // next turn Jev offers it back and decides to ask — Jev reads summaries, not rows
  jev.next = { topic_action: choice("ask"), respond_mode: choice("now") };
  llm.outputs = [{ messages: [{ text: "how did the interview go?" }] }];
  await respond(deps, convId, "user_turn", turn(["im back"], clock.now()));
  assert.deepEqual(jev.calls[1].state.unresolved, [{ id: open[0].id, summary: "interview tomorrow" }]);
  assert.match(llm.calls[1][0].content, /meaning to ask them about: interview tomorrow/);
  assert.deepEqual(store.getConversation(convId)!.unresolved, [], "asked once, then it is over");
});

test("an open thread is not asked about on a turn that did not choose `ask`", async () => {
  const { deps, store, jev, llm, convId, clock } = makeDeps();
  store.saveConversation({ ...store.getConversation(convId)!, unresolved: [{ id: "t1", summary: "interview tomorrow", raisedAt: clock.now() }] });
  jev.next = { topic_action: choice("continue") };
  await respond(deps, convId, "user_turn", turn(["anyway"], clock.now()));
  assert.doesNotMatch(llm.calls[0][0].content, /meaning to ask them about/);
  assert.equal(store.getConversation(convId)!.unresolved.length, 1, "still waiting to be asked");
});

test("a failed generation keeps the thread open: a thread is consumed by being asked", async () => {
  const { deps, store, jev, llm, convId, clock } = makeDeps();
  store.saveConversation({ ...store.getConversation(convId)!, unresolved: [{ id: "t1", summary: "interview tomorrow", raisedAt: clock.now() }] });
  jev.next = { topic_action: choice("ask") };
  llm.outputs = [new Error("down")];
  await respond(deps, convId, "user_turn", turn(["hey"], clock.now()));
  assert.deepEqual(store.getConversation(convId)!.unresolved.map((t) => t.id), ["t1"]);
});

test("the window follows the topic once it is built up, and falls back when it is not", async () => {
  /** Eight messages on the old topic, then `topicMsgs` on the one that replaced it. */
  const mk = (topicMsgs: number) => {
    const { deps, store, llm, convId, clock } = makeDeps();
    const now = clock.now();
    const t0 = now - 10_000;
    for (let i = 0; i < 8; i++) store.insertUserMessage(`old${i}`, convId, `old-${i}`, t0 + i * 100);
    store.saveConversation({ ...store.getConversation(convId)!, topic: "keyboard", topicStartedAt: t0 + 1000 });
    for (let i = 0; i < topicMsgs; i++) store.insertUserMessage(`new${i}`, convId, `new-${i}`, t0 + 1200 + i * 100);
    return { deps, store, llm, convId, now };
  };
  // history is messages 1..n of the call, after the system prompt
  const history = (llm: ReturnType<typeof makeDeps>["llm"]) => llm.calls[0].map((m) => m.content).join("\n");

  const built = mk(8);
  await respond(built.deps, built.convId, "user_turn", turn(["anyway"], built.now));
  assert.match(history(built.llm), /new-0/);
  assert.doesNotMatch(history(built.llm), /old-0/, "the topic window drops what came before it");

  const fresh = mk(1);
  await respond(fresh.deps, fresh.convId, "user_turn", turn(["anyway"], fresh.now));
  assert.match(history(fresh.llm), /new-0/);
  assert.match(history(fresh.llm), /old-0/, "a one-message-old topic must not blank out the conversation behind it");
});
