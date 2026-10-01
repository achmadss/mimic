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
    { role: "user", text: "one" },
    { role: "bot", text: "sent-reply" },
    { role: "user", text: "two" },
    { role: "user", text: "three" },
  ]);
  assert.deepEqual(s.recentMessages(id, 2, 40), [
    { role: "bot", text: "sent-reply" },
    { role: "user", text: "two" },
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

test("character state defaults to idle", () => {
  const s = fresh();
  assert.deepEqual(s.getCharacterState("rick", 7), { characterId: "rick", activity: "idle", activitySince: 7 });
});
