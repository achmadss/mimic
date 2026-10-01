import { seededUnit } from "../rng.ts";
import type { CharacterProfile } from "./profile.ts";

/**
 * What the System decided this one message should look like.
 * Doc 06 §2.2: the style weights are a per-message probability from seeded RNG, not a prompt mood,
 * so the same character stays consistent and a transformation never lands on every message.
 */
export interface MessageStyle {
  /** Applied to the text in code — the model cannot talk itself out of it. */
  lowercase: boolean;
  /** Told to the model, because only it can write the typo and its `correction`. */
  typo: boolean;
}

/** One roll per message, seeded by the generation so a retry of the same generation is identical. */
export function styleFor(profile: CharacterProfile, seed: string, count: number): MessageStyle[] {
  const s = profile.speechStyle;
  return Array.from({ length: count }, (_, k) => ({
    lowercase: seededUnit(seed, "case", String(k)) < s.lowercase,
    typo: s.typoRate > 0 && seededUnit(seed, "typo", String(k)) < s.typoRate,
  }));
}

/** The raw text a real person would have typed, typo included, before the correction message. */
export function applyLowercase(text: string, style: MessageStyle | undefined): string {
  return style?.lowercase ? text.toLowerCase() : text;
}
