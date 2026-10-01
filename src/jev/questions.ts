import type { Trigger } from "../types.ts";
import type { JevQuestion } from "./client.ts";

/** One Jev request per trigger: every judgement is a question here (doc 04 §1). */
export function buildQuestions(trigger: Trigger, pending: { id: string; text: string }[]): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {};

  // An activity change re-decides what is already queued; nothing is being written, so none of the
  // reply-shaping questions apply and asking them would only produce answers nothing reads.
  if (trigger !== "activity_changed") {
    q.respond_mode = {
      type: "choice",
      instructions: "As `character`, given `activity`, `derived` and `currentTurn`, how do they handle replying?",
      criteria: {
        now: "Reply now (the reply may still be slow)",
        later: "Too busy right now; they will message back on their own later",
        no_reply: "Nothing needs a reply (e.g. 'ok', 'lol', the chat ended naturally)",
      },
    };
    q.follow_up = {
      type: "noul",
      // Deliberately NOT "…e.g. after finishing what they are doing": `activity` is always `idle`
      // until the routine engine lands, so that clause refers to a state that does not exist and
      // Jev answers "they are free, they would just reply now" — measured 0.23-0.32 over real turns.
      // Ask the answerable question instead: is there something left for them to come back with?
      instructions: "Does `character` have anything they want to bring up on their own later, or is the conversation done for now?",
    };
    q.follow_up_after = {
      type: "choice",
      instructions: "If `character` messages again later on their own, roughly when?",
      criteria: { "15m": null, "1h": null, "3h": null, next_day: null },
    };
    q.message_length = {
      type: "choice",
      instructions: "Considering how `character` texts and how they feel right now, how much would they put into each single message?",
      criteria: {
        terse: "A couple of words. 'fine.' 'no way.' 'yeah.'",
        short: "One short line, one thought, nothing else",
        normal: "A sentence or two",
        long: "Several sentences, when they are worked up or explaining something",
      },
    };
    q.message_count = {
      type: "choice",
      // Without criteria to choose between them Jev answers 1 every time, so a character with a lot
      // to say writes one 300-character paragraph instead of texting like a person.
      instructions: "Into how many separate messages would `character` break this reply? People fire off one thought per message rather than writing a paragraph.",
      criteria: {
        "1": "The whole reply is one message",
        "2": "A line, then a separate afterthought or a follow-up question",
        "3": "A short burst: a reaction, then the point, then the tail of it",
        "4": "Broken right up, several messages of only a few words each",
        "5": "Firing off fragments back to back, barely pausing",
      },
    };
    q.ask_question = { type: "noul", instructions: "Should the reply ask the user something?" };
    q.importance = {
      type: "score",
      instructions: "How important or attention-grabbing is `currentTurn` for `character`?",
      criteria: ["Trivial small talk", "Mildly interesting", "Important to the user", "Urgent or emotionally big"],
    };
  }

  q.pace = {
    type: "choice",
    instructions: "How quickly would `character` reply, given `activity`, `derived.attention` and how engaging `currentTurn` is?",
    criteria: {
      instant: "Glued to the phone, replies immediately",
      fast: "Within a few seconds",
      normal: "Within several seconds",
      slow: "Takes up to a minute",
      very_slow: "Takes a couple of minutes",
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
    q.mood = {
      type: "choice",
      // The gate, not just this wording, is what keeps it stable: an answer only overwrites the
      // stored mood when it beats chance, so "it usually does not change" is enforced by the maths.
      instructions: "What is `character`'s mood right now, given `mood` and `currentTurn`? Most of the time a conversation does not change it.",
      criteria: {
        neutral: "No particular mood",
        happy: "Buoyant, in a good mood",
        tired: "Worn down, low on energy",
        annoyed: "Irritated by something",
        excited: "Wound up about something",
        distracted: "Elsewhere in their head",
      },
    };
  }

  for (const p of pending) {
    q[`pending_${p.id}`] = {
      type: "choice",
      instructions: {
        queued: p.text,
        question: "`character` already queued `queued` but has not sent it yet. Given `activity` and `currentTurn`, what should happen to it?",
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
