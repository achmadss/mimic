import type { CharacterState, Mood } from "../types.ts";

/** Doc 02 §1 calls mood transient: it is set for a moment, not a state machine. */
const MOOD_TTL_MS = 45 * 60_000;

/**
 * The mood as of `now`.
 * Attention is a magnitude and decays; mood is a category, so it either is still true or it is over.
 */
export function moodNow(cs: Pick<CharacterState, "mood" | "moodChangedAt">, now: number): Mood {
  if (cs.mood === null || cs.moodChangedAt === null) return "neutral";
  return now - cs.moodChangedAt < MOOD_TTL_MS ? cs.mood : "neutral";
}
