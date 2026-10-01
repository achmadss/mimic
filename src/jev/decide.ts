import { PACES, PENDING_DECISIONS, RESPOND_MODES, TOPIC_ACTIONS, type BehaviorDecision, type Pace, type Trigger } from "../types.ts";
import type { JevAnswers } from "./client.ts";

export interface DecideContext {
  trigger: Trigger;
  pendingIds: string[];
  basePace: Pace;
  maxMessages: number;
  choiceConfidence: number;
  noulThreshold: number;
}

export const FOLLOW_UP_MS = { "15m": 15 * 60_000, "1h": 3_600_000, "3h": 3 * 3_600_000, next_day: 18 * 3_600_000 } as const;
const FOLLOW_UP_KEYS = Object.keys(FOLLOW_UP_MS) as (keyof typeof FOLLOW_UP_MS)[];

/** Turn Jev's probabilities into one decision. Missing/unsure answers take the field's safe default. */
export function decide(answers: JevAnswers | null, c: DecideContext): BehaviorDecision {
  const a = answers ?? {};
  const choice = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const x = a[key];
    return x?.type === "choice" && x.confidence >= c.choiceConfidence && (allowed as readonly string[]).includes(x.choice)
      ? (x.choice as T)
      : fallback;
  };
  const yes = (key: string) => {
    const x = a[key];
    return x?.type === "noul" && x.noul >= c.noulThreshold;
  };

  let respondMode = choice("respond_mode", RESPOND_MODES, "now");
  if (c.trigger === "followup_due" && respondMode === "later") respondMode = "no_reply"; // no follow-up chains
  const wantsFollowUp = c.trigger === "user_turn" && (respondMode === "later" || yes("follow_up"));
  const imp = a.importance;

  return {
    respondMode,
    followUp: wantsFollowUp ? { afterMs: FOLLOW_UP_MS[choice("follow_up_after", FOLLOW_UP_KEYS, "1h")] } : undefined,
    topicAction: choice("topic_action", TOPIC_ACTIONS, "continue"),
    pace: choice("pace", PACES, c.basePace),
    messageCount: Math.min(c.maxMessages, Number(choice("message_count", ["1", "2", "3"] as const, "1"))),
    askQuestion: yes("ask_question"),
    attentionRaise: imp?.type === "score" && imp.confidence >= c.choiceConfidence && imp.score >= 2 ? imp.score / 3 : undefined,
    // a stale reply is worse than a missing one: unsure → cancel
    pendingActions: c.pendingIds.map((id) => ({ messageId: id, action: choice(`pending_${id}`, PENDING_DECISIONS, "cancel") })),
    answers,
  };
}
