import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { DeliveryAdapter, IncomingText } from "./types.ts";

export class TelegramAdapter implements DeliveryAdapter {
  readonly platform = "telegram" as const;
  /** The Bot API has no idempotency key: never resend an unconfirmed message. */
  readonly idempotent = false;
  readonly bot: Bot;

  constructor(token: string, private readonly opts: { botInfo?: UserFromGetMe; poll?: boolean } = {}) {
    this.bot = new Bot(token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
    // Retry only rate limits (429 + retry_after). 5xx/network errors are ambiguous → rethrow.
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60, rethrowInternalServerErrors: true, rethrowHttpErrors: true }));
  }

  async start(onMessage: (m: IncomingText) => void) {
    this.bot.on("message:text", (ctx) => {
      if (ctx.chat.type !== "private") return; // DMs only
      // Telegram sends /start when the user opens the chat. A command is addressed to the bot, so it
      // must not reach the character — otherwise the first thing they ever say is a reply to "/start".
      if (ctx.message.entities?.[0]?.type === "bot_command") return;
      onMessage({ chatId: String(ctx.chat.id), platformMessageId: String(ctx.message.message_id), text: ctx.message.text });
    });
    this.bot.catch((err) => console.error("[telegram] handler error", err));
    if (this.opts.poll !== false) this.bot.start().catch((e) => console.error("[telegram] polling stopped", e));
  }

  async send(chatId: string, text: string, _idempotencyKey: string) {
    const m = await this.bot.api.sendMessage(Number(chatId), text);
    return { platformMessageId: String(m.message_id) };
  }

  async stop() {
    await this.bot.stop();
  }
}
