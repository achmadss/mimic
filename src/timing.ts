import { seededBetween } from "./rng.ts";
import type { Pace } from "./types.ts";

export const PACE_RANGE_MS: Record<Pace, [number, number]> = {
  instant: [0, 1000],
  fast: [1000, 4000],
  normal: [4000, 15_000],
  slow: [15_000, 60_000],
  very_slow: [60_000, 120_000],
};

export function typingTimeMs(text: string): number {
  return Math.min(8000, Math.round((text.length / 6) * 1000));
}

/** Offsets (ms from the reply's start time) at which each fragment is sent. */
export function replyOffsets(i: { pace: Pace; speedMultiplier: number; texts: string[]; maxDelayMs: number; seed: string }): number[] {
  const [lo, hi] = PACE_RANGE_MS[i.pace];
  let t = Math.min(i.maxDelayMs, seededBetween(lo, hi, i.seed, "base") * i.speedMultiplier);
  return i.texts.map((text, k) => {
    if (k > 0) t += seededBetween(800, 3000, i.seed, "gap", String(k));
    t += typingTimeMs(text);
    return Math.round(t);
  });
}

/** Extra wait applied when Jev says `delay` for a pending message. */
export function delayOffset(pace: Pace, seed: string): number {
  const [lo, hi] = PACE_RANGE_MS[pace];
  return Math.round(seededBetween(lo, hi, seed, "delay"));
}
