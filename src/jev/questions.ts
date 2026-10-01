import type { Trigger } from "../types.ts";
import type { JevQuestion } from "./client.ts";

/** One Jev request per turn: every judgement is a question here (doc 04 §1). */
export function buildQuestions(trigger: Trigger, pending: { id: string; text: string }[]): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {
    respond_mode: {
      type: "choice",
      instructions: "As `character`, given `activity`, `derived` and `currentTurn`, how do they handle replying?",
      criteria: {
        now: "Reply now (the reply may still be slow)",
        later: "Too busy right now; they will message back on their own later",
        no_reply: "Nothing needs a reply (e.g. 'ok', 'lol', the chat ended naturally)",
      },
    },
    follow_up: {
      type: "noul",
      instructions: "Would `character` naturally message again on their own later about this, e.g. after finishing what they are doing?",
    },
    follow_up_after: {
      type: "choice",
      instructions: "If `character` messages again later on their own, roughly when?",
      criteria: { "15m": null, "1h": null, "3h": null, next_day: null },
    },
    pace: {
      type: "choice",
      instructions: "How quickly would `character` reply, given `activity`, `derived.attention` and how engaging `currentTurn` is?",
      criteria: {
        instant: "Glued to the phone, replies immediately",
        fast: "Within a few seconds",
        normal: "Within several seconds",
        slow: "Takes up to a minute",
        very_slow: "Takes a couple of minutes",
      },
    },
    message_count: {
      type: "choice",
      instructions: "Into how many separate short chat messages would `character` split the reply?",
      criteria: { "1": null, "2": null, "3": null },
    },
    ask_question: { type: "noul", instructions: "Should the reply ask the user something?" },
    importance: {
      type: "score",
      instructions: "How important or attention-grabbing is `currentTurn` for `character`?",
      criteria: ["Trivial small talk", "Mildly interesting", "Important to the user", "Urgent or emotionally big"],
    },
  };
  if (trigger === "user_turn") {
    q.topic_action = {
      type: "choice",
      instructions: "How should `character` handle the subject of `currentTurn` relative to the current `topic`?",
      criteria: {
        continue: "Stay on the current topic",
        switch: "Move to the new topic the user raised",
        acknowledge_return: "Briefly acknowledge the new topic, then return to the current one",
        ignore: "Ignore the new topic for now",
        ask: "Ask the user about the new topic",
      },
    };
  }
  for (const p of pending) {
    q[`pending_${p.id}`] = {
      type: "choice",
      instructions: {
        queued: p.text,
        question: "`character` already queued `queued` but has not sent it yet. Given `currentTurn`, what should happen to it?",
      },
      criteria: {
        continue: "Still makes sense; send it as planned",
        cancel: "No longer makes sense; drop it",
        delay: "Still fine, but send it a bit later",
        replace: "Drop it; the new reply covers it",
      },
    };
  }
  return q;
}
