import { test } from "node:test";
import assert from "node:assert/strict";
import type { Update, UserFromGetMe } from "grammy/types";
import { TelegramAdapter } from "../src/delivery/telegram.ts";
import type { IncomingText } from "../src/delivery/types.ts";

const botInfo = { id: 1, is_bot: true, first_name: "Rick", username: "rick_test_bot" } as UserFromGetMe;
const update = (chatType: "private" | "group", text = "hey", id = 7, command = false) =>
  ({
    update_id: id,
    message: {
      message_id: id, date: 0, chat: { id: 123, type: chatType, first_name: "U", title: "g" },
      from: { id: 123, is_bot: false, first_name: "U" }, text,
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}),
    },
  }) as unknown as Update;

test("private text messages are forwarded; group messages are ignored", async () => {
  const a = new TelegramAdapter("123:abc", { botInfo, poll: false });
  const got: IncomingText[] = [];
  await a.start((m) => got.push(m));
  await a.bot.handleUpdate(update("private"));
  await a.bot.handleUpdate(update("group", "hi all", 8));
  assert.deepEqual(got, [{ chatId: "123", platformMessageId: "7", text: "hey" }]);
});

test("bot commands are flagged as commands, never passed on as conversation", async () => {
  const a = new TelegramAdapter("123:abc", { botInfo, poll: false });
  const got: IncomingText[] = [];
  await a.start((m) => got.push(m));
  await a.bot.handleUpdate(update("private", "/start", 9, true));
  await a.bot.handleUpdate(update("private", "/Status@rick_test_bot", 10, true));
  assert.deepEqual(got.map((m) => m.command), ["start", "status"]);
  got.length = 0;
  // a slash inside a normal message is not a command and still reaches the character
  await a.bot.handleUpdate(update("private", "i got 3/4 through it", 11));
  assert.equal(got.length, 1);
});

test("showTyping sends a typing chat action, and a failure never escapes", async () => {
  const a = new TelegramAdapter("123:abc", { botInfo, poll: false });
  const calls: [number, string][] = [];
  (a.bot.api as any).sendChatAction = async (id: number, action: string) => {
    calls.push([id, action]);
  };
  await a.showTyping("123");
  assert.deepEqual(calls, [[123, "typing"]]);
  assert.equal(a.typingRefreshMs, 4000);
  (a.bot.api as any).sendChatAction = async () => {
    throw new Error("network");
  };
  await a.showTyping("123"); // resolves: the indicator is decoration, the send is not
});

test("send calls sendMessage and returns the Telegram message id; not idempotent", async () => {
  const a = new TelegramAdapter("123:abc", { botInfo, poll: false });
  const calls: any[] = [];
  a.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 99 } } as any;
  });
  const r = await a.send("123", "yo", "k");
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].payload.chat_id, 123);
  assert.equal(calls[0].payload.text, "yo");
  assert.equal(r.platformMessageId, "99");
  assert.equal(a.idempotent, false);
});
