import { availability, interruptibility } from "../character/derived.ts";
import type { CharacterProfile } from "../character/profile.ts";
import type { Activity, Mood, Trigger } from "../types.ts";

export interface JevStateInput {
  trigger: Trigger;
  now: number;
  profile: CharacterProfile;
  activity: Activity;
  /** When the current activity began, so Jev can tell a fresh change from one that is hours old. */
  activitySince: number;
  mood: Mood;
  moodChangedAt: number | null;
  attention: number;
  localTime: string;
  topic: string | null;
  lastUserAt: number;
  lastBotAt: number;
  turn: { texts: string[]; firstAt: number; lastAt: number } | null;
  recent: { role: "user" | "bot"; text: string; at: number }[];
  pending: { id: string; text: string; dueAt: number }[];
}

/**
 * How long ago everything happened, in milliseconds.
 *
 * Jev used to receive `{ from, text }` with no timestamps at all, so a reply five seconds later
 * mid-flow and one eight hours later out of the blue were the same input. Every number here already
 * exists in the database; it was simply being thrown away before the call.
 */
function since(i: JevStateInput) {
  return {
    lastUserMsgAgoMs: i.now - i.lastUserAt,
    lastBotMsgAgoMs: i.lastBotAt ? i.now - i.lastBotAt : null,
    turnStartedAgoMs: i.turn ? i.now - i.turn.firstAt : null,
    turnLastMsgAgoMs: i.turn ? i.now - i.turn.lastAt : null,
    activityChangedAgoMs: i.now - i.activitySince,
    moodChangedAgoMs: i.moodChangedAt === null ? null : i.now - i.moodChangedAt,
    oldestPendingInMs: i.pending.length ? Math.min(...i.pending.map((m) => m.dueAt)) - i.now : null,
  };
}

export function buildJevState(i: JevStateInput) {
  return {
    trigger: i.trigger,
    character: { name: i.profile.name, personaSummary: i.profile.persona },
    activity: i.activity,
    mood: i.mood,
    derived: {
      availability: availability(i.activity),
      interruptibility: interruptibility(i.activity, i.attention),
      attention: i.attention,
    },
    localTime: i.localTime,
    /** Durations in milliseconds, all relative to now. */
    since: since(i),
    topic: i.topic,
    recentMessages: i.recent.slice(-10).map((m) => ({ from: m.role, text: m.text, agoMs: i.now - m.at })),
    currentTurn: i.turn?.texts ?? [],
    pendingBots: i.pending.map((m) => ({ id: m.id, text: m.text, dueInMs: m.dueAt - i.now })),
  };
}
