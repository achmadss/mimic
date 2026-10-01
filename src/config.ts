import type { Platform } from "./types.ts";

export interface Config {
  quietMs: number;
  maxTurnMs: number;
  maxDelayMs: number;
  maxMessages: number;
  catchUpMs: number;
  recentMessages: number;
  choiceConfidence: number;
  noulThreshold: number;
  maxChars: Record<Platform, number>;
}

export const DEFAULT_CONFIG: Config = {
  quietMs: 2500,
  maxTurnMs: 20_000,
  maxDelayMs: 120_000,
  maxMessages: 3,
  catchUpMs: 300_000,
  recentMessages: 20,
  choiceConfidence: 0.5,
  noulThreshold: 0.7,
  maxChars: { telegram: 4096, discord: 2000, cli: 2000 },
};
