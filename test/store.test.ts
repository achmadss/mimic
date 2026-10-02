import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import type { BotMessage } from "../src/types.ts";

const fresh = () => new Store(openDb(":memory:"));
const bot = (over: Partial<BotMessage>): BotMessage => ({
  id: "b1", conversationId: "rick:cli:local", generationId: "g1", conversationVersion: 1,
  text: "yo", order: 0, status: "scheduled", dueAt: 100, ...over,
});

test("conversation is created once with the documented id", () => {
  const s = fresh();
  const a = s.getOrCreateConversation("rick", "cli", "local");
  const b = s.getOrCreateConversation("rick", "cli", "local");
  assert.equal(a.conversationId, "rick:cli:local");
  assert.deepEqual(a, b);
  assert.equal(a.version, 0);
  assert.equal(a.topic, null);
  assert.equal(a.attention, null);
});

test("tx rolls back state and events together", () => {
  const s = fresh();
  const c = s.getOrCreateConversation("rick", "cli", "local");
  assert.throws(() =>
    s.tx(() => {
      s.saveConversation({ ...c, version: 5 });
      s.appendEvent(c.conversationId, 1, "X");
      throw new Error("boom");
    }),
  );
  assert.equal(s.getConversation(c.conversationId)!.version, 0);
  assert.deepEqual(s.events(c.conversationId), []);
});

test("duplicate user message id is rejected", () => {
  const s = fresh();
  s.getOrCreateConversation("rick", "cli", "local");
  assert.equal(s.insertUserMessage("m1", "rick:cli:local", "hi", 1), true);
  assert.equal(s.insertUserMessage("m1", "rick:cli:local", "hi", 2), false);
});

test("recentMessages: chronological, only sent bot messages, honors before + limit", () => {
  const s = fresh();
  const id = s.getOrCreateConversation("rick", "cli", "local").conversationId;
  s.insertUserMessage("u1", id, "one", 10);
  s.insertBotMessage(bot({ id: "b1", text: "sent-reply", dueAt: 20 }));
  s.markSent("b1", 20);
  s.insertBotMessage(bot({ id: "b2", text: "still-scheduled", dueAt: 25 }));
  s.insertUserMessage("u2", id, "two", 30);
  s.insertUserMessage("u3", id, "three", 40);
  assert.deepEqual(s.recentMessages(id, 10), [
    { role: "user", text: "one", at: 10 },
    { role: "bot", text: "sent-reply", at: 20 },
    { role: "user", text: "two", at: 30 },
    { role: "user", text: "three", at: 40 },
  ]);
  assert.deepEqual(s.recentMessages(id, 2, 40), [
    { role: "bot", text: "sent-reply", at: 20 },
    { role: "user", text: "two", at: 30 },
  ]);
});

test("bot messages: pending list ordered, update, status query", () => {
  const s = fresh();
  s.getOrCreateConversation("rick", "cli", "local");
  s.insertBotMessage(bot({ id: "b2", order: 1, dueAt: 200 }));
  s.insertBotMessage(bot({ id: "b1", order: 0, dueAt: 100 }));
  assert.deepEqual(s.pendingBotMessages("rick:cli:local").map((m) => m.id), ["b1", "b2"]);
  s.updateBotMessage({ ...s.getBotMessage("b1")!, status: "sending", conversationVersion: 2, dueAt: 150 });
  const b1 = s.getBotMessage("b1")!;
  assert.equal(b1.status, "sending");
  assert.equal(b1.conversationVersion, 2);
  assert.equal(b1.dueAt, 150);
  assert.deepEqual(s.pendingBotMessages("rick:cli:local").map((m) => m.id), ["b2"]);
  assert.deepEqual(s.botMessagesWithStatus("sending").map((m) => m.id), ["b1"]);
});

test("turn buffer and actions round-trip", () => {
  const s = fresh();
  s.saveTurnBuffer({ conversationId: "c", messageIds: ["m1"], texts: ["hi"], firstAt: 1, lastAt: 2 });
  assert.deepEqual(s.getTurnBuffer("c"), { conversationId: "c", messageIds: ["m1"], texts: ["hi"], firstAt: 1, lastAt: 2 });
  s.deleteTurnBuffer("c");
  assert.equal(s.getTurnBuffer("c"), undefined);

  s.putAction({ id: "a2", conversationId: "c", kind: "send_message", dueAt: 20 });
  s.putAction({ id: "a1", conversationId: "c", kind: "turn_quiet", dueAt: 10 });
  s.putAction({ id: "a2", conversationId: "c", kind: "send_message", dueAt: 5 }); // replace
  assert.deepEqual(s.allActions().map((a) => [a.id, a.dueAt]), [["a2", 5], ["a1", 10]]);
  s.deleteAction("a2");
  assert.equal(s.getAction("a2"), undefined);
  assert.equal(s.getAction("a1")!.kind, "turn_quiet");
});

test("character state defaults to idle with no mood", () => {
  const s = fresh();
  assert.deepEqual(s.getCharacterState("rick", 7), { characterId: "rick", activity: "idle", activitySince: 7, mood: null, moodChangedAt: null });
});

test("character state round-trips activity and mood", () => {
  const s = fresh();
  s.getCharacterState("rick", 7);
  s.saveCharacterState({ characterId: "rick", activity: "sleeping", activitySince: 100, mood: "tired", moodChangedAt: 150 });
  assert.deepEqual(s.getCharacterState("rick", 200), { characterId: "rick", activity: "sleeping", activitySince: 100, mood: "tired", moodChangedAt: 150 });
});

test("unresolved threads round-trip on the conversation and default to empty", () => {
  const s = fresh();
  const c = s.getOrCreateConversation("rick", "cli", "local");
  assert.deepEqual(c.unresolved, []);
  const t = { id: "t1", summary: "interview tomorrow", raisedAt: 30 };
  s.saveConversation({ ...c, unresolved: [t] });
  assert.deepEqual(s.getConversation(c.conversationId)!.unresolved, [t]);
});

test("examples are read back by character and emotion, bounded by limit", () => {
  const s = fresh();
  const mk = (id: string, characterId: string, emotion: "joking" | "sad") => ({
    id, characterId, episode: "1", emotion, lines: [{ speaker: characterId, text: id }],
  });
  s.saveExample(mk("a", "rick", "joking"));
  s.saveExample(mk("b", "rick", "joking"));
  s.saveExample(mk("c", "rick", "sad"));
  s.saveExample(mk("d", "morty", "joking"));
  assert.deepEqual(s.examplesFor("rick", "joking", 10).map((e) => e.id), ["a", "b"]);
  assert.deepEqual(s.examplesFor("rick", "joking", 1).map((e) => e.id), ["a"]);
  assert.deepEqual(s.examplesFor("rick", "excited", 10), []);
  assert.equal(s.exampleCount(), 4);
  assert.equal(s.exampleCount("rick"), 3);
  // re-running the ingest replaces rather than duplicating
  s.saveExample({ ...mk("a", "rick", "joking"), emotion: "sad" });
  assert.equal(s.exampleCount("rick"), 3);
  assert.deepEqual(s.examplesFor("rick", "sad", 10).map((e) => e.id), ["a", "c"]);
});

test("recentMessages can be scoped to a `since`", () => {
  const s = fresh();
  const id = s.getOrCreateConversation("rick", "cli", "local").conversationId;
  for (const at of [10, 20, 30, 40]) s.insertUserMessage(`u${at}`, id, `${at}`, at);
  assert.deepEqual(s.recentMessages(id, 10, 100, 30).map((m) => m.text), ["30", "40"]);
  assert.deepEqual(s.recentMessages(id, 10, 100, 0).map((m) => m.text), ["10", "20", "30", "40"]);
  assert.deepEqual(s.recentMessages(id, 2, 35, 0).map((m) => m.text), ["20", "30"]);
});

test("conversationsForCharacter returns only that character's conversations", () => {
  const s = fresh();
  s.getOrCreateConversation("rick", "cli", "local");
  s.getOrCreateConversation("rick", "telegram", "42");
  s.getOrCreateConversation("morty", "cli", "local");
  assert.deepEqual(s.conversationsForCharacter("rick").map((c) => c.conversationId).sort(), ["rick:cli:local", "rick:telegram:42"]);
});
