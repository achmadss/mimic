import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ACTIVITIES, PACES } from "../types.ts";

const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** One stretch of the character's day. The Routine Engine turns this into `activity`. */
export const RoutineSlotSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "start must be HH:MM in the character's timezone"),
  activity: z.enum(ACTIVITIES),
  /** The boundary moves by ± this many minutes, seeded per character per day. 0 = exact. */
  jitterMin: z.number().int().min(0).max(180),
});

export const ProfileSchema = z.object({
  characterId: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  timezone: z.string().refine(validTimeZone, "invalid IANA timezone"),
  /** Prose summary. Goes to Jev as the character's brief; the structured fields below go to the LLM. */
  persona: z.string().min(20),
  identity: z.object({
    age: z.string().min(1),
    occupation: z.string().min(1),
    background: z.string().min(10),
    /** Who the person they are texting is to them. */
    relationship: z.string().min(5),
  }),
  traits: z.array(z.string().min(1)).min(1),
  likes: z.array(z.string().min(1)).default([]),
  dislikes: z.array(z.string().min(1)).default([]),
  /** Habits and tics the model should reach for when it needs a mannerism. */
  quirks: z.array(z.string().min(1)).default([]),
  /**
   * Optional character sheet, rendered to the model as "intelligence 10/10, patience 2/10".
   * Nothing computes on these — they are description, and the scale is whatever you write them on.
   */
  stats: z.record(z.string(), z.number()).optional(),
  speechStyle: z.object({
    lowercase: z.number().min(0).max(1),
    typoRate: z.number().min(0).max(1),
    /** Of the typos they make, the share they bother to go back and fix. */
    correctionRate: z.number().min(0).max(1),
    /** Ceiling for one message. Jev picks a length class within it, per turn. */
    maxCharsPerMessage: z.number().int().positive(),
    slang: z.array(z.string()),
    language: z.literal("en"),
  }),
  basePace: z.enum(PACES),
  // enum-keyed records are exhaustive in zod v4: every activity must be present
  activityBaselines: z.record(z.enum(ACTIVITIES), z.object({ attention: z.number().min(0).max(1), speedMultiplier: z.number().positive() })),
  /** Their day, in their timezone. Required: a character with no routine is permanently idle. */
  routine: z.array(RoutineSlotSchema).min(1),
  platforms: z.object({
    telegram: z.object({ botTokenEnv: z.string() }).optional(),
    discord: z.object({ botTokenEnv: z.string() }).optional(),
  }),
});

export type CharacterProfile = z.infer<typeof ProfileSchema>;
export type RoutineSlot = z.infer<typeof RoutineSlotSchema>;

/** Files starting with `_` are templates and notes, not characters. */
export function loadProfiles(dir: string): Map<string, CharacterProfile> {
  const out = new Map<string, CharacterProfile>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
    const parsed = ProfileSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (!parsed.success) throw new Error(`invalid character profile ${file}: ${parsed.error.message}`);
    out.set(parsed.data.characterId, parsed.data);
  }
  return out;
}
