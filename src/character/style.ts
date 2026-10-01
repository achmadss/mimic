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
  /** The model writes a small typo in this message. */
  typo: boolean;
  /** It also notices that typo and sends a `correction`. People mostly just leave them standing. */
  correct: boolean;
}

/** Of the typos a character makes, the share they actually go back and fix. */
export const CORRECTION_RATE = 0.3;

/** The gestures a model reaches for when it narrates itself. */
const STAGE_DIRECTION =
  /^\s*(?:burps?|sighs?|laughs?|chuckles?|coughs?|groans?|shrugs?|nods?|pauses?|smirks?|grins?|snorts?|hiccups?|yawns?|blinks?|exhales?|inhales?|mumbles?|mutters?|whispers?|slurs?|sips?|slurps?|clears throat|long pause|beat)\s*$/i;

/** One roll per message, seeded by the generation so a retry of the same generation is identical. */
export function styleFor(profile: CharacterProfile, seed: string, count: number): MessageStyle[] {
  const s = profile.speechStyle;
  return Array.from({ length: count }, (_, k) => {
    const typo = s.typoRate > 0 && seededUnit(seed, "typo", String(k)) < s.typoRate;
    return {
      lowercase: seededUnit(seed, "case", String(k)) < s.lowercase,
      typo,
      correct: typo && seededUnit(seed, "fix", String(k)) < CORRECTION_RATE,
    };
  });
}

/**
 * Texting hygiene: things a language model does that people don't.
 * The prompt asks for these too, but a mechanical rule belongs in code — the model is free to
 * ignore an instruction, and it only takes one `*burp*` to break the illusion.
 */
export function humanize(text: string): string {
  return (
    text
      // an em dash is the clearest tell that a machine wrote this: a comma or a sentence break
      // is what a person types. Inside a word it's a cut-off ("oh for fu—"), which keeps a hyphen.
      .replace(/\s+[—–]\s+/g, ", ")
      .replace(/[—–]/g, "-")
      // *burp*, *sighs*, *pauses* — people don't narrate themselves in a text, so the whole span
      // goes. A span that is not one of those is emphasis, where only the asterisks are the tell.
      // ponytail: a word list, so an invented direction (*florps*) survives as a stray word.
      // Add to it if one shows up; the prompt ban means this backstop rarely fires at all.
      .replace(/\*([^*\n]{1,32})\*/g, (_m, inner: string) => (STAGE_DIRECTION.test(inner) ? " " : inner))
      .replace(/\s+([,.!?])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/** Everything the System applies to a message before it is scheduled. */
export function applyStyle(text: string, style: MessageStyle | undefined): string {
  const t = humanize(text);
  return style?.lowercase ? t.toLowerCase() : t;
}
