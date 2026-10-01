import type { Platform, Presence } from "../types.ts";

export interface IncomingText {
  chatId: string;
  platformMessageId: string;
  text: string;
}

export interface DeliveryAdapter {
  readonly platform: Platform;
  /** true when re-sending with the same idempotencyKey cannot produce a duplicate (Discord nonce). */
  readonly idempotent: boolean;
  /**
   * How long the platform keeps showing `typing…` before it has to be re-sent. Absent means the
   * platform has no indicator, and that is the only reason not to show one.
   */
  readonly typingRefreshMs?: number;
  send(chatId: string, text: string, idempotencyKey: string): Promise<{ platformMessageId: string }>;
  start(onMessage: (m: IncomingText) => void): Promise<void>;
  stop(): Promise<void>;
  /** Best-effort decoration: an indicator that fails must never block a send. */
  showTyping?(chatId: string): Promise<void>;
  /** Global to the bot account, which is why this is one bot per character. */
  setPresence?(presence: Presence): void;
}

export type DeliveryLookup = (characterId: string, platform: Platform) => DeliveryAdapter;
