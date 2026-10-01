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

export const ProfileSchema = z.object({
  characterId: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  timezone: z.string().refine(validTimeZone, "invalid IANA timezone"),
  persona: z.string().min(20),
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
  platforms: z.object({
    telegram: z.object({ botTokenEnv: z.string() }).optional(),
    discord: z.object({ botTokenEnv: z.string() }).optional(),
  }),
});

export type CharacterProfile = z.infer<typeof ProfileSchema>;

export function loadProfiles(dir: string): Map<string, CharacterProfile> {
  const out = new Map<string, CharacterProfile>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const parsed = ProfileSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (!parsed.success) throw new Error(`invalid character profile ${file}: ${parsed.error.message}`);
    out.set(parsed.data.characterId, parsed.data);
  }
  return out;
}
