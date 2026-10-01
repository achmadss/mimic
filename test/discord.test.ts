import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { discordNonce, toIncoming } from "../src/delivery/discord.ts";

const msg = (over: Record<string, unknown> = {}) =>
  ({ author: { bot: false }, channel: { type: ChannelType.DM }, channelId: "c1", id: "m1", content: "hey", ...over }) as any;

test("only human DMs with text are forwarded", () => {
  assert.deepEqual(toIncoming(msg()), { chatId: "c1", platformMessageId: "m1", text: "hey" });
  assert.equal(toIncoming(msg({ author: { bot: true } })), null);
  assert.equal(toIncoming(msg({ channel: { type: ChannelType.GuildText } })), null);
  assert.equal(toIncoming(msg({ content: "  " })), null);
});

test("nonce is ≤ 25 chars, deterministic, and differs per message", () => {
  const a = discordNonce("3f2b8c1e-9d4a-4b6f-8e2a-1c3d5e7f9a0b");
  assert.ok(a.length <= 25);
  assert.equal(a, discordNonce("3f2b8c1e-9d4a-4b6f-8e2a-1c3d5e7f9a0b"));
  assert.notEqual(a, discordNonce("aaaaaaaa-9d4a-4b6f-8e2a-1c3d5e7f9a0b"));
});
