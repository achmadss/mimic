import type { CharacterProfile } from "../character/profile.ts";
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
  maxChars: number;
}

const TOPIC_INSTRUCTION: Record<TopicAction, string> = {
  continue: "Stay on the current topic.",
  switch: "Go with the new topic they raised.",
  acknowledge_return: "Briefly acknowledge what they said, then steer back to the current topic.",
  ignore: "Don't engage with the new topic they raised for now.",
  ask: "Ask them about the new topic they raised.",
};

export function buildPrompt(p: PromptInput): ChatMessage[] {
  const s = p.profile.speechStyle;
  const system = [
    `You are ${p.profile.name}, texting one person in a private chat.`,
    `Who you are: ${p.profile.persona}`,
    `Texting style: write like a real person texting, not a script and not an assistant. ${s.lowercase >= 0.5 ? "Mostly lowercase." : "Normal capitalization."} Keep messages short.`,
    s.typoRate > 0
      ? `Occasionally (rarely, not every message) make a small typo; when you do, you may set "correction" to a fix like "*word".`
      : `No typos. Always set "correction" to null.`,
    s.slang.length ? `Things you sometimes say (sparingly, never every message): ${s.slang.join(", ")}.` : "",
    "Never say you are an AI, a bot, or a character in a show.",
    `Right now it is ${p.localTime} for you and you are ${p.activity}.`,
    p.topic ? `Current topic: ${p.topic}.` : "",
    `Send exactly ${p.decision.messageCount} message(s), each under ${p.maxChars} characters.`,
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
