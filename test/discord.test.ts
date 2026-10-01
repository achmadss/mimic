import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { DiscordAdapter, discordNonce, toIncoming } from "../src/delivery/discord.ts";

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

test("showTyping types in the channel, and a failure never escapes", async () => {
  const a = new DiscordAdapter("token");
  const typed: string[] = [];
  const channels = [...Array(2)].map(() => ({ isSendable: () => true, sendTyping: async () => void typed.push("t") }));
  let next = 0;
  (a.client as any).channels = { fetch: async () => (next++ === 0 ? channels[0] : Promise.reject(new Error("no channel"))) };
  await a.showTyping("c1");
  assert.deepEqual(typed, ["t"]);
  assert.equal(a.typingRefreshMs, 8000);
  await a.showTyping("c2"); // resolves: the indicator is decoration, the send is not
});

test("setPresence mirrors availability onto the bot account", () => {
  const a = new DiscordAdapter("token");
  const seen: any[] = [];
  (a.client as any).user = { setPresence: (o: any) => seen.push(o) };
  a.setPresence("online");
  a.setPresence("invisible");
  assert.deepEqual(seen, [{ status: "online" }, { status: "invisible" }]);
  // a client that has not finished logging in has no user yet, and that must not throw
  (a.client as any).user = null;
  a.setPresence("idle");
});
