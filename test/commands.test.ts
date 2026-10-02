import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/im/commands.ts";
import { choice, setupIM } from "./helpers.ts";

const LONG = 200_000;

test("parseCommand: known names only, case and @bot suffix ignored", () => {
  assert.equal(parseCommand("/status"), "status");
  assert.equal(parseCommand("/Memory@rick_bot please"), "memory");
  assert.equal(parseCommand("/shrug"), null);
  assert.equal(parseCommand("i got 3/4 through"), null);
});

test("commands are answered out of character and never reach the conversation", async () => {
  const t = setupIM();
  const cmd = (command: string, id: string) => t.im.receive("rick", "cli", { chatId: "local", platformMessageId: id, text: `/${command}`, command });
  cmd("help", "c1");
  cmd("start", "c2");
  cmd("nonsense", "c3");
  await t.tick(LONG);
  assert.equal(t.adapter.sent.length, 2, "/start is silent: it is how Telegram opens a chat");
  assert.match(t.adapter.sent[0].text, /\/reset - /);
  assert.equal(t.adapter.sent[1].text, t.adapter.sent[0].text, "an unknown command gets the list");
  assert.equal(t.jev.calls.length, 0);
  assert.equal(t.store.recentMessages(t.convId, 10).length, 0, "nothing was stored as a message");
});

test("status, memory, forget and debug describe and edit this chat", async () => {
  const t = setupIM();
  const cmd = async (command: string) => {
    t.im.receive("rick", "cli", { chatId: "local", platformMessageId: `c-${command}-${t.adapter.sent.length}`, text: "", command });
    await t.tick(0);
    return t.adapter.sent.at(-1)!.text;
  };
  assert.match(await cmd("debug"), /No reply has been decided/);
  assert.match(await cmd("memory"), /doesn't remember anything/);

  t.jev.next = { respond_mode: choice("now") };
  t.llm.outputs = [{ messages: [{ text: "sup" }], topic: null, openThread: null }];
  t.say("hey");
  await t.tick(2500);
  assert.match(await cmd("status"), /^Rick: \w+ for .*\nTopic: none\.\n1 message\(s\) queued/);
  assert.match(await cmd("debug"), /respond now, topic continue/);

  const c = t.store.getConversation(t.convId)!;
  t.store.saveConversation({ ...c, unresolved: [{ id: "t1", summary: "exam friday", raisedAt: t.clock.now() }] });
  t.store.saveMemories(t.convId, [{ id: "f1", conversationId: t.convId, kind: "fact", text: "They have a cat.", fromAt: 0, toAt: 0 }], 0);
  const mem = await cmd("memory");
  assert.match(mem, /Facts:\n- They have a cat\./);
  assert.match(mem, /Meaning to ask about:\n- exam friday/);

  await cmd("forget");
  assert.equal(t.store.memories(t.convId, "fact", 10).length, 0);
  assert.deepEqual(t.store.getConversation(t.convId)!.unresolved, []);
  assert.equal(t.store.recentMessages(t.convId, 10).length, 1, "forget keeps the chat");
});

test("reset cancels what is queued, wipes the chat, and makes anything in flight stale", async () => {
  const t = setupIM();
  t.jev.next = { respond_mode: choice("now"), follow_up: { type: "noul", noul: 0.99 } };
  t.llm.outputs = [{ messages: [{ text: "one sec" }], topic: "portal gun", openThread: null }];
  t.say("hey");
  await t.tick(2500);
  assert.equal(t.store.pendingBotMessages(t.convId).length, 1);
  const before = t.store.getConversation(t.convId)!.version;

  t.im.receive("rick", "cli", { chatId: "local", platformMessageId: "r1", text: "/reset", command: "reset" });
  await t.tick(LONG);
  assert.deepEqual(t.adapter.sent.map((s) => s.text), ["Chat reset. Rick won't remember any of it."], "the queued reply never went out");
  const conv = t.store.getConversation(t.convId)!;
  assert.equal(conv.version, before + 1);
  assert.equal(conv.topic, null);
  assert.equal(t.store.recentMessages(t.convId, 10).length, 0);
  assert.equal(t.store.allActions().filter((a) => a.conversationId === t.convId).length, 0, "the follow-up is gone too");
});
