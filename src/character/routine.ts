import { seededBetween } from "../rng.ts";
import type { Activity } from "../types.ts";
import type { CharacterProfile } from "./profile.ts";

/**
 * What a character is doing, as a pure function of the clock.
 *
 * Nothing here reads or writes state: the same instant gives the same answer on a fresh process, so a
 * boundary crossed while the bot was down resolves to the slot that is running *now* rather than being
 * replayed late. The stored `character_state.activity` is a cache of this with an event trail.
 */

/** Minutes since local midnight, in `tz`, at instant `at`. */
function localMinutes(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")!.value) % 24; // some ICU builds emit "24" at midnight
  return hour * 60 + Number(parts.find((p) => p.type === "minute")!.value);
}

/** `YYYY-MM-DD` in `tz`, as the seed for that day's jitter. */
function localDayKey(tz: string, at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * The instant `"HH:MM"` happens on the local day containing `at`.
 * ponytail: the day's offset is taken at `at`, so a boundary landing inside a DST jump on the same
 * local day is an hour out. Adding a timezone library for a bedtime is not worth the dependency.
 */
function atLocalTime(tz: string, at: number, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return at - localMinutes(tz, at) * 60_000 + (h * 60 + m) * 60_000;
}

interface Boundary {
  at: number;
  activity: Activity;
}

/** The day's slots as instants, jittered, in time order. */
function dayBoundaries(profile: CharacterProfile, at: number): Boundary[] {
  const day = localDayKey(profile.timezone, at);
  return profile.routine
    .map((slot) => {
      const jitter = slot.jitterMin ? Math.round(seededBetween(-slot.jitterMin, slot.jitterMin, profile.characterId, "routine", day, slot.start)) : 0;
      return { at: atLocalTime(profile.timezone, at, slot.start) + jitter * 60_000, activity: slot.activity };
    })
    // after jitter: two slots close together can cross, and whichever lands earlier should win
    .sort((a, b) => a.at - b.at);
}

/** Every slot boundary on the local day containing `at`. */
export function slotBoundaries(profile: CharacterProfile, at: number): number[] {
  return dayBoundaries(profile, at).map((b) => b.at);
}

/** The slot running at `at`, and when it started. */
export function activityAt(profile: CharacterProfile, at: number): { activity: Activity; since: number } {
  const running = dayBoundaries(profile, at).filter((b) => b.at <= at);
  if (running.length) {
    const last = running[running.length - 1];
    return { activity: last.activity, since: last.at };
  }
  // before today's first boundary, yesterday's last slot is still running — this is what makes a
  // night shift wrap past midnight instead of collapsing to the first slot of the day
  const yesterday = dayBoundaries(profile, at - 24 * 3_600_000);
  const last = yesterday[yesterday.length - 1];
  return { activity: last.activity, since: last.at };
}

/** The next boundary strictly after `at`, always in the future. */
export function nextTransitionAt(profile: CharacterProfile, at: number): number {
  const next = dayBoundaries(profile, at).find((b) => b.at > at);
  if (next) return next.at;
  return dayBoundaries(profile, at + 24 * 3_600_000)[0].at;
}
