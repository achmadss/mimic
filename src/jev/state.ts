import { availability, interruptibility } from "../character/derived.ts";
import type { CharacterProfile } from "../character/profile.ts";
import type { Activity, Trigger } from "../types.ts";

export interface JevStateInput {
  trigger: Trigger;
  profile: CharacterProfile;
  activity: Activity;
  attention: number;
  localTime: string;
  topic: string | null;
  recent: { role: "user" | "bot"; text: string }[];
  turn: string[];
  pending: { id: string; text: string }[];
}

export function buildJevState(i: JevStateInput) {
  return {
    trigger: i.trigger,
    character: { name: i.profile.name, personaSummary: i.profile.persona },
    activity: i.activity,
    derived: {
      availability: availability(i.activity),
      interruptibility: interruptibility(i.activity, i.attention),
      attention: i.attention,
    },
    localTime: i.localTime,
    topic: i.topic,
    recentMessages: i.recent.slice(-10).map((m) => ({ from: m.role, text: m.text })),
    currentTurn: i.turn,
    pendingBots: i.pending.map((m) => ({ id: m.id, text: m.text })),
  };
}
