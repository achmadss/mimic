import { ApplicationIntegrationType, ChannelType, Client, Events, GatewayIntentBits, InteractionContextType, Partials, type ChatInputCommandInteraction } from "discord.js";
import { COMMANDS } from "../im/commands.ts";
import type { Presence } from "../types.ts";
import type { DeliveryAdapter, IncomingText } from "./types.ts";

/** Discord nonces are max 25 chars; the message UUID without dashes, truncated, is unique enough per message. */
export function discordNonce(key: string): string {
  return key.replace(/-/g, "").slice(0, 25);
}

/**
 * How people reach the bot. A user can only DM a bot they share a server with — a user-installed
 * app covers commands, not open DMs — so the bot joins a server with the `bot` scope and no
 * permissions: it never acts in the server, it is only there to be found.
 */
export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=0`;
}

export function toIncoming(msg: { author: { bot: boolean }; channel: { type: ChannelType }; channelId: string; id: string; content: string }): IncomingText | null {
  if (msg.author.bot || msg.channel.type !== ChannelType.DM || !msg.content.trim()) return null;
  return { chatId: msg.channelId, platformMessageId: msg.id, text: msg.content };
}

/** Slash commands, offered in the bot's DMs only — the bot never acts in a server. */
export const SLASH_COMMANDS = Object.entries(COMMANDS).map(([name, description]) => ({
  name,
  description,
  contexts: [InteractionContextType.BotDM],
  integrationTypes: [ApplicationIntegrationType.GuildInstall],
}));

/**
 * Discord wants an answer to an interaction within 3 s, and the command waits its turn behind
 * whatever the conversation is doing — possibly an LLM call. So it is deferred at once and the
 * answer edits the placeholder.
 */
export async function commandIncoming(i: Pick<ChatInputCommandInteraction, "channelId" | "id" | "commandName" | "deferReply" | "editReply">): Promise<IncomingText> {
  await i.deferReply();
  return { chatId: i.channelId, platformMessageId: i.id, text: "", command: i.commandName, reply: async (t) => void (await i.editReply(t)) };
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
    this.client.on(Events.InteractionCreate, async (i) => {
      if (!i.isChatInputCommand() || i.context !== InteractionContextType.BotDM) return;
      try {
        onMessage(await commandIncoming(i));
      } catch (e) {
        console.error("[discord] command failed", e);
      }
    });
    this.client.once(Events.ClientReady, (c) => {
      c.application.commands.set(SLASH_COMMANDS).catch((e) => console.error("[discord] registering commands failed", e));
      console.error(`[mimic] discord: people can DM ${c.user.tag} once it shares a server with them. Add it: ${inviteUrl(c.user.id)}`);
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
