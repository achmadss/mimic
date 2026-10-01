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
  jev.next = { message_count: choice("1") };
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
