import type { Platform } from "./types.ts";

export interface Config {
  quietMs: number;
  maxTurnMs: number;
  maxDelayMs: number;
  maxMessages: number;
  catchUpMs: number;
  recentMessages: number;
  /**
   * Minimum probability the winning option must carry. Compared against the probability of the
   * option Jev picked, not its `confidence` margin. A k-way question is uniform at 1/k, so the bar
   * has to clear 0.33 for a 3-way choice; at 0.5 every `message_count` answer took its fallback,
   * which is the option Jev rated least likely (P=0.16-0.26 against P(3)=0.46).
   */
  choiceConfidence: number;
  noulThreshold: number;
  /**
   * `follow_up` needs its own cutoff. It is a rarer event than the other noul questions and Jev
   * scores it lower on the same scale: measured over 19 real turns, median 0.49, max 0.70 — so the
   * shared `noulThreshold` of 0.7 sat exactly on the model's ceiling and the feature never fired.
   * 0.6 schedules a follow-up on roughly 1 turn in 9.
   */
  followUpThreshold: number;
  maxChars: Record<Platform, number>;
}

export const DEFAULT_CONFIG: Config = {
  quietMs: 2500,
  maxTurnMs: 20_000,
  maxDelayMs: 120_000,
  maxMessages: 3,
  catchUpMs: 300_000,
  recentMessages: 20,
  choiceConfidence: 0.4,
  noulThreshold: 0.7,
  followUpThreshold: 0.6,
  maxChars: { telegram: 4096, discord: 2000, cli: 2000 },
};
