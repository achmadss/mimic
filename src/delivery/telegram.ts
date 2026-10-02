import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { COMMANDS } from "../im/commands.ts";
import type { DeliveryAdapter, IncomingText } from "./types.ts";

export class TelegramAdapter implements DeliveryAdapter {
  readonly platform = "telegram" as const;
  /** The Bot API has no idempotency key: never resend an unconfirmed message. */
  readonly idempotent = false;
  /** `sendChatAction("typing")` shows for ~5 s, so it is refreshed inside that. */
  readonly typingRefreshMs = 4000;
  readonly bot: Bot;

  constructor(token: string, private readonly opts: { botInfo?: UserFromGetMe; poll?: boolean } = {}) {
    this.bot = new Bot(token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
    // Retry only rate limits (429 + retry_after). 5xx/network errors are ambiguous → rethrow.
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60, rethrowInternalServerErrors: true, rethrowHttpErrors: true }));
  }

  async start(onMessage: (m: IncomingText) => void) {
    this.bot.on("message:text", (ctx) => {
      if (ctx.chat.type !== "private") return; // DMs only
      const base = { chatId: String(ctx.chat.id), platformMessageId: String(ctx.message.message_id), text: ctx.message.text };
      // A command is addressed to the bot, not the character: it is flagged, never fed to the
      // conversation — otherwise the first thing they ever say is a reply to "/start".
      const cmd = ctx.message.entities?.[0];
      if (cmd?.type === "bot_command" && cmd.offset === 0) {
        onMessage({ ...base, command: ctx.message.text.slice(1, cmd.length).split("@")[0].toLowerCase() });
        return;
      }
      onMessage(base);
    });
    this.bot.catch((err) => console.error("[telegram] handler error", err));
    if (this.opts.poll === false) return;
    // the menu next to the text box; best-effort, the commands work without it
    await this.bot.api
      .setMyCommands(Object.entries(COMMANDS).map(([command, description]) => ({ command, description })), { scope: { type: "all_private_chats" } })
      .catch((e) => console.error("[telegram] setMyCommands failed", e));
    this.bot.start().catch((e) => console.error("[telegram] polling stopped", e));
  }

  async send(chatId: string, text: string, _idempotencyKey: string) {
    const m = await this.bot.api.sendMessage(Number(chatId), text);
    return { platformMessageId: String(m.message_id) };
  }

  /** Best-effort: the indicator is decoration, so a failure here must not disturb the send. */
  async showTyping(chatId: string) {
    try {
      await this.bot.api.sendChatAction(Number(chatId), "typing");
    } catch {
      /* the message still goes out on schedule */
    }
  }

  async stop() {
    await this.bot.stop();
  }
}
