import type { Platform } from "./types.ts";

export interface Config {
  quietMs: number;
  maxTurnMs: number;
  maxDelayMs: number;
  maxMessages: number;
  catchUpMs: number;
  recentMessages: number;
  /**
   * How far above chance the winning option must be, as a multiple of the 1/k uniform baseline for
   * a k-way question. An absolute bar cannot serve questions with different option counts: 0.4 is a
   * clear preference among 3 options but barely above chance among 5, so `message_count` fell back
   * to 1 on answers that were 1.75x uniform.
   */
  choiceMargin: number;
  /** Minimum confidence for an `importance` score to move attention (scores have no option count). */
  scoreConfidence: number;
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
  maxMessages: 5,
  catchUpMs: 300_000,
  recentMessages: 20,
  choiceMargin: 1.2,
  scoreConfidence: 0.4,
  noulThreshold: 0.7,
  followUpThreshold: 0.6,
  maxChars: { telegram: 4096, discord: 2000, cli: 2000 },
};
