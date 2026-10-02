import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { elsewhere, recall } from "../src/context/memory.ts";
import { respond } from "../src/im/respond.ts";
import { choice, makeDeps } from "./helpers.ts";

const fact = (id: string, conversationId: string, text: string) => ({ id, conversationId, kind: "fact" as const, text, fromAt: 1, toAt: 1 });

test("linked chats are one person: memory is shared both ways, writes stay with their chat", () => {
  const { store } = makeDeps();
  const tg = store.getOrCreateConversation("rick", "telegram", "1").conversationId;
  const dc = store.getOrCreateConversation("rick", "discord", "9").conversationId;
  const other = store.getOrCreateConversation("morty", "discord", "9").conversationId;
  store.saveMemories(tg, [fact("f1", tg, "Their thesis defense is Thu 1 Oct.")], 0);
  assert.deepEqual(store.memories(dc, "fact", 10), [], "not linked yet");

  store.linkConversations(dc, tg);
  assert.deepEqual(store.memories(dc, "fact", 10).map((f) => f.id), ["f1"]);
  assert.deepEqual(store.linkedConversationIds(dc), [dc, tg]);
  assert.throws(() => store.linkConversations(tg, other), /same character/);

  // a third chat joins the whole group, not just one member
  const cli = store.getOrCreateConversation("rick", "cli", "local").conversationId;
  store.linkConversations(cli, dc);
  assert.deepEqual(new Set(store.linkedConversationIds(tg)), new Set([tg, dc, cli]));

  store.saveMemories(dc, [fact("f2", dc, "Has a cat.")], 0);
  store.resetConversation(dc);
  assert.deepEqual(store.memories(tg, "fact", 10).map((f) => f.id), ["f1"], "a reset clears only that chat's own notes");

  store.unlinkConversation(tg);
  assert.deepEqual(store.linkedConversationIds(tg), [tg]);
  assert.deepEqual(new Set(store.linkedConversationIds(dc)), new Set([dc, cli]), "the rest stay linked to each other");

  store.linkConversations(tg, dc);
  assert.equal(store.forgetMemories(cli), 1, "forget is about the person: every linked chat");
});

test("a reply on Discord sees what was just said on Telegram, and what is known from there", async () => {
  const { deps, store, jev, llm, clock } = makeDeps();
  const tg = store.getOrCreateConversation("rick", "telegram", "1").conversationId;
  const dc = store.getOrCreateConversation("rick", "discord", "9").conversationId;
  store.linkConversations(dc, tg);
  store.insertUserMessage("t1", tg, "my thesis defense got moved to monday", clock.now() - 60_000);
  store.insertUserMessage("t0", tg, "ancient history", clock.now() - 5 * 86_400_000);
  store.saveMemories(tg, [fact("f1", tg, "They are a grad student.")], 0);

  assert.deepEqual(elsewhere(store, dc, clock.now(), DEFAULT_CONFIG).map((m) => m.text), ["my thesis defense got moved to monday"], "older than the window is left to notes");
  assert.deepEqual(recall(store, dc, "thesis", DEFAULT_CONFIG).facts.map((f) => f.text), ["They are a grad student."]);

  jev.next = { respond_mode: choice("now") };
  llm.outputs = [{ messages: [{ text: "monday, huh" }], topic: null, openThread: null }];
  await respond(deps, dc, "user_turn", { texts: ["so about the thesis"], firstAt: clock.now(), lastAt: clock.now() });
  const system = llm.calls[0][0].content;
  assert.match(system, /You also text this same person on Telegram\. The latest there, which you remember:\nTHEM \(Telegram\): my thesis defense got moved to monday/);
  assert.match(system, /Things you know about them .*They are a grad student\./);
});
