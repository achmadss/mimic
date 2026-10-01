import type { Activity, Availability, ConversationState, Presence } from "../types.ts";
import type { CharacterProfile } from "./profile.ts";

export function availability(a: Activity): Availability {
  switch (a) {
    case "sleeping":
      return "sleeping";
    case "away":
    case "commuting":
      return "away";
    case "working":
    case "studying":
      return "busy";
    default:
      return "available";
  }
}

const ATTENTION_HALF_LIFE_MS = 10 * 60_000;

/** Current attention: the last raise decays toward the activity baseline; computed on read, no timer. */
export function attentionNow(
  conv: Pick<ConversationState, "attention" | "attentionRaisedAt">,
  profile: CharacterProfile,
  activity: Activity,
  now: number,
): number {
  const base = profile.activityBaselines[activity].attention;
  if (conv.attention === null || conv.attentionRaisedAt === null) return base;
  const decay = 0.5 ** ((now - conv.attentionRaisedAt) / ATTENTION_HALF_LIFE_MS);
  return base + Math.max(0, conv.attention - base) * decay;
}

/** How a character's availability shows on a platform that has a status (doc 06 §2.27). */
export const PRESENCE: Record<Availability, Presence> = { available: "online", busy: "idle", away: "idle", sleeping: "invisible" };

const AVAILABILITY_FLOOR: Record<Availability, number> = { available: 1, busy: 0.4, away: 0.2, sleeping: 0.05 };

export function interruptibility(activity: Activity, attention: number): number {
  return Math.min(1, Math.max(AVAILABILITY_FLOOR[availability(activity)], attention));
}

/** High attention (an important message) cancels the activity slowdown. */
export function speedMultiplier(profile: CharacterProfile, activity: Activity, attention: number): number {
  const m = profile.activityBaselines[activity].speedMultiplier;
  return attention >= 0.8 ? Math.min(m, 1) : m;
}

export function formatLocalTime(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}
