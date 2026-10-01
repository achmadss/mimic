import { MESSAGE_LENGTHS, MOODS, PACES, PENDING_DECISIONS, RESPOND_MODES, TOPIC_ACTIONS, type BehaviorDecision, type Pace, type RespondMode, type Trigger } from "../types.ts";
import type { JevAnswers } from "./client.ts";

export interface DecideContext {
  trigger: Trigger;
  pendingIds: string[];
  basePace: Pace;
  maxMessages: number;
  choiceMargin: number;
  scoreConfidence: number;
  noulThreshold: number;
  followUpThreshold: number;
}

export const FOLLOW_UP_MS = { "15m": 15 * 60_000, "1h": 3_600_000, "3h": 3 * 3_600_000, next_day: 18 * 3_600_000 } as const;
const FOLLOW_UP_KEYS = Object.keys(FOLLOW_UP_MS) as (keyof typeof FOLLOW_UP_MS)[];

/** Turn Jev's probabilities into one decision. Missing/unsure answers take the field's safe default. */
export function decide(answers: JevAnswers | null, c: DecideContext): BehaviorDecision {
  const a = answers ?? {};
  const choice = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const x = a[key];
    if (x?.type !== "choice") return fallback;
    // Gate on the probability of the chosen option, not on `confidence`: Jev's confidence is a
    // margin that shrinks as a question gains options, so a 3-way answer tops out around 0.35 and
    // could never clear an absolute 0.5 bar. Chance for a k-way question is 1/k, so compare against
    // that — a flat distribution still falls back, a real preference is honoured whatever the width.
    // the question's own option list is the true k — Jev's probability map can come back sparse
    const options = allowed.length || Object.keys(x.probabilities ?? {}).length || 1;
    const p = x.probabilities?.[x.choice] ?? x.confidence;
    return p >= c.choiceMargin / options && (allowed as readonly string[]).includes(x.choice) ? (x.choice as T) : fallback;
  };
  const yes = (key: string, threshold = c.noulThreshold) => {
    const x = a[key];
    return x?.type === "noul" && x.noul >= threshold;
  };

  // An activity change re-decides what is already queued. No text is being written, so the
  // reply-shaping fields take their "nothing to do" value rather than whatever Jev would have said.
  const generating = c.trigger !== "activity_changed";
  let respondMode: RespondMode = generating ? choice("respond_mode", RESPOND_MODES, "now") : "no_reply";
  if (c.trigger === "followup_due" && respondMode === "later") respondMode = "no_reply"; // no follow-up chains
  const wantsFollowUp = c.trigger === "user_turn" && (respondMode === "later" || yes("follow_up", c.followUpThreshold));
  const imp = a.importance;
  // neutral is the fallback and maps to `undefined`: a mood nobody asked to move is left alone to
  // expire on its own TTL, instead of being reset every turn. Read only on a user turn, which is
  // the one trigger that asks for it — a decision must never read an answer nobody requested.
  const mood = c.trigger === "user_turn" ? choice("mood", MOODS, "neutral") : "neutral";

  return {
    respondMode,
    followUp: wantsFollowUp ? { afterMs: FOLLOW_UP_MS[choice("follow_up_after", FOLLOW_UP_KEYS, "1h")] } : undefined,
    topicAction: generating ? choice("topic_action", TOPIC_ACTIONS, "continue") : "continue",
    pace: choice("pace", PACES, c.basePace),
    messageCount: generating ? Math.min(c.maxMessages, Number(choice("message_count", ["1", "2", "3", "4", "5"] as const, "1"))) : 1,
    messageLength: generating ? choice("message_length", MESSAGE_LENGTHS, "normal") : "normal",
    mood: mood === "neutral" ? undefined : mood,
    askQuestion: generating && yes("ask_question"),
    attentionRaise: generating && imp?.type === "score" && imp.confidence >= c.scoreConfidence && imp.score >= 2 ? imp.score / 3 : undefined,
    // a stale reply is worse than a missing one: unsure → cancel
    pendingActions: c.pendingIds.map((id) => ({ messageId: id, action: choice(`pending_${id}`, PENDING_DECISIONS, "cancel") })),
    answers,
  };
}
