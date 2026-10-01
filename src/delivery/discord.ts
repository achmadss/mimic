import { ChannelType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import type { Presence } from "../types.ts";
import type { DeliveryAdapter, IncomingText } from "./types.ts";

/** Discord nonces are max 25 chars; the message UUID without dashes, truncated, is unique enough per message. */
export function discordNonce(key: string): string {
  return key.replace(/-/g, "").slice(0, 25);
}

export function toIncoming(msg: { author: { bot: boolean }; channel: { type: ChannelType }; channelId: string; id: string; content: string }): IncomingText | null {
  if (msg.author.bot || msg.channel.type !== ChannelType.DM || !msg.content.trim()) return null;
  return { chatId: msg.channelId, platformMessageId: msg.id, text: msg.content };
}

export class DiscordAdapter implements DeliveryAdapter {
  readonly platform = "discord" as const;
  /** nonce + enforceNonce makes Discord drop a resend of the same message. */
  readonly idempotent = true;
  /** `sendTyping()` shows for ~10 s. */
  readonly typingRefreshMs = 8000;
  // Partials.Channel is required to receive DMs from uncached channels
  readonly client = new Client({ intents: [GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });

  constructor(private readonly token: string) {}

  async start(onMessage: (m: IncomingText) => void) {
    this.client.on(Events.MessageCreate, (msg) => {
      const m = toIncoming(msg);
      if (m) onMessage(m);
    });
    await this.client.login(this.token);
  }

  async send(chatId: string, text: string, idempotencyKey: string) {
    const ch = await this.client.channels.fetch(chatId);
    if (!ch?.isSendable()) throw new Error(`discord channel ${chatId} is not sendable`);
    const m = await ch.send({ content: text, nonce: discordNonce(idempotencyKey), enforceNonce: true });
    return { platformMessageId: m.id };
  }

  /** Best-effort: the indicator is decoration, so a failure here must not disturb the send. */
  async showTyping(chatId: string) {
    try {
      const ch = await this.client.channels.fetch(chatId);
      if (ch?.isSendable()) await ch.sendTyping();
    } catch {
      /* the message still goes out on schedule */
    }
  }

  /** The bot account's status is global, which is why there is one bot per character. */
  setPresence(presence: Presence) {
    this.client.user?.setPresence({ status: presence });
  }

  async stop() {
    await this.client.destroy();
  }
}
