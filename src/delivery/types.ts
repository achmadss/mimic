import type { Platform } from "../types.ts";

export interface IncomingText {
  chatId: string;
  platformMessageId: string;
  text: string;
}

export interface DeliveryAdapter {
  readonly platform: Platform;
  /** true when re-sending with the same idempotencyKey cannot produce a duplicate (Discord nonce). */
  readonly idempotent: boolean;
  send(chatId: string, text: string, idempotencyKey: string): Promise<{ platformMessageId: string }>;
  start(onMessage: (m: IncomingText) => void): Promise<void>;
  stop(): Promise<void>;
}

export type DeliveryLookup = (characterId: string, platform: Platform) => DeliveryAdapter;
