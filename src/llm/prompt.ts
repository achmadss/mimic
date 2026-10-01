import type { CharacterProfile } from "../character/profile.ts";
import type { MessageStyle } from "../character/style.ts";
import type { Activity, BehaviorDecision, TopicAction, Trigger } from "../types.ts";
import type { ChatMessage } from "./client.ts";

export interface PromptInput {
  profile: CharacterProfile;
  decision: BehaviorDecision;
  trigger: Trigger;
  activity: Activity;
  localTime: string;
  topic: string | null;
  recent: { role: "user" | "bot"; text: string }[]; // history BEFORE the current turn
  turn: string[];
  keptPending: string[];
  /** Rolled by the System, one per message (doc 06 §2.2). */
  styles: MessageStyle[];
}

/** A chat message is a line or two, not a paragraph. */
const CHAT_CHARS = 180;

const TOPIC_INSTRUCTION: Record<TopicAction, string> = {
  continue: "Stay on the current topic.",
  switch: "Go with the new topic they raised.",
  acknowledge_return: "Briefly acknowledge what they said, then steer back to the current topic.",
  ignore: "Don't engage with the new topic they raised for now.",
  ask: "Ask them about the new topic they raised.",
};

export function buildPrompt(p: PromptInput): ChatMessage[] {
  const s = p.profile.speechStyle;
  const typoMsgs = p.styles.map((st, k) => (st.typo ? k + 1 : 0)).filter(Boolean);
  const system = [
    `You are ${p.profile.name}, texting one person in a private chat.`,
    `Who you are: ${p.profile.persona}`,
    `Texting style: write like a real person texting, not a script and not an assistant. Keep each message to a line or two — under ${CHAT_CHARS} characters. A longer thought becomes more messages, not a longer paragraph.`,
    s.slang.length ? `Things you sometimes say (sparingly, never every message): ${s.slang.join(", ")}.` : "",
    "Never say you are an AI, a bot, or a character in a show.",
    `Right now it is ${p.localTime} for you and you are ${p.activity}.`,
    p.topic ? `Current topic: ${p.topic}.` : "",
    `Send exactly ${p.decision.messageCount} message(s).`,
    typoMsgs.length
      ? `Make message ${typoMsgs.join(" and ")} contain one small realistic typo, and set that message's "correction" to the fix, e.g. text "i'll see you tomorow" with correction "*tomorrow". Every other "correction" must be null.`
      : `Set every "correction" to null.`,
    p.decision.askQuestion ? "Ask them something." : "",
    p.trigger === "user_turn" ? TOPIC_INSTRUCTION[p.decision.topicAction] : "",
    p.keptPending.length ? `These messages of yours are already queued and will be sent first: ${p.keptPending.map((t) => JSON.stringify(t)).join(", ")}. Don't repeat them.` : "",
    p.trigger === "followup_due" ? "They haven't written anything new. You are messaging them again on your own, following up on the conversation so far." : "",
    'If you switch to a new topic, set "topic" to a 1-4 word label for it; otherwise set "topic" to null.',
    'Reply as JSON: {"messages":[{"text":"...","correction":null}],"topic":null}',
  ]
    .filter(Boolean)
    .join("\n");

  const history: ChatMessage[] = p.recent.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
  const current: ChatMessage[] = p.turn.length ? [{ role: "user", content: p.turn.join("\n") }] : [];
  return [{ role: "system", content: system }, ...history, ...current];
}
