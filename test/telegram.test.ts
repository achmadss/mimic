import { test } from "node:test";
import assert from "node:assert/strict";
import type { Update, UserFromGetMe } from "grammy/types";
import { TelegramAdapter } from "../src/delivery/telegram.ts";
import type { IncomingText } from "../src/delivery/types.ts";

const botInfo = { id: 1, is_bot: true, first_name: "Rick", username: "rick_test_bot" } as UserFromGetMe;
const update = (chatType: "private" | "group", text = "hey", id = 7) =>
  ({
    update_id: id,
    message: { message_id: id, date: 0, chat: { id: 123, type: chatType, first_name: "U", title: "g" }, from: { id: 123, is_bot: false, first_name: "U" }, text },
  }) as unknown as Update;

test("private text messages are forwarded; group messages are ignored", async () => {
  const a = new TelegramAdapter("123:abc", { botInfo, poll: false });
  const got: IncomingText[] = [];
  await a.start((m) => got.push(m));
  await a.bot.handleUpdate(update("private"));
  await a.bot.handleUpdate(update("group", "hi all", 8));
  assert.deepEqual(got, [{ chatId: "123", platformMessageId: "7", text: "hey" }]);
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
