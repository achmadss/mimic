import type { CharacterProfile } from "../character/profile.ts";
import type { MessageStyle } from "../character/style.ts";
import { renderExchange } from "../context/ingest.ts";
import type { Activity, BehaviorDecision, Example, MessageLength, Mood, TopicAction, Trigger } from "../types.ts";
import type { ChatMessage } from "./client.ts";

export interface PromptInput {
  profile: CharacterProfile;
  decision: BehaviorDecision;
  trigger: Trigger;
  activity: Activity;
  /** Already passed through `moodNow`: neutral when nothing is lingering. */
  mood: Mood;
  localTime: string;
  topic: string | null;
  recent: { role: "user" | "bot"; text: string }[]; // history BEFORE the current turn
  turn: string[];
  keptPending: string[];
  /** Rolled by the System, one per message (doc 06 §2.2). */
  styles: MessageStyle[];
  /** Source dialogue matching the turn's register (doc 05 §5.1). Empty for a follow-up. */
  examples: Example[];
  /** Open threads, when Jev chose to ask about them. */
  askAbout: string[];
  /** Relationship and how they text, already rendered (`describeAcquaintance`). */
  them: string[];
  /** Long-term memory (doc 05 §1): facts about them, and notes on talk older than `recent`. */
  facts: string[];
  earlier: string[];
}

/**
 * How much of the character's own per-message ceiling they use, by the length Jev picked.
 * The ceiling is personality (`speechStyle.maxCharsPerMessage`); Jev says which part of it
 * this particular reply calls for.
 */
const LENGTH_FRACTION: Record<MessageLength, number> = { terse: 0.12, short: 0.35, normal: 0.65, long: 1 };

const TOPIC_INSTRUCTION: Record<TopicAction, string> = {
  continue: "Stay on the current topic.",
  switch: "Go with the new topic they raised.",
  acknowledge_return: "Briefly acknowledge what they said, then steer back to the current topic.",
  ignore: "Don't engage with the new topic they raised for now. You'll come back to it later.",
  ask: "Ask them about the new topic they raised.",
};

const SETS_ASIDE = new Set<TopicAction>(["ignore", "acknowledge_return"]);

/** The authored personality, as prompt lines. Empty lists drop out. */
function whoTheyAre(p: CharacterProfile): string[] {
  const i = p.identity;
  const stats = p.stats && Object.entries(p.stats).map(([k, v]) => `${k} ${v}/10`).join(", ");
  return [
    `You are ${i.age}, ${i.occupation}. ${i.background}`,
    `The person you are texting: ${i.relationship}`,
    p.traits.length ? `You are ${p.traits.join(", ")}.` : "",
    p.likes.length ? `You like ${p.likes.join(", ")}.` : "",
    p.dislikes.length ? `You dislike ${p.dislikes.join(", ")}.` : "",
    p.quirks.length ? `You do these without thinking about it: ${p.quirks.join("; ")}.` : "",
    stats ? `Your attributes out of 10 — ${stats}.` : "",
  ].filter(Boolean);
}

export function buildPrompt(p: PromptInput): ChatMessage[] {
  const s = p.profile.speechStyle;
  const typoMsgs = p.styles.map((st, k) => (st.typo ? k + 1 : 0)).filter(Boolean);
  const fixMsgs = p.styles.map((st, k) => (st.correct ? k + 1 : 0)).filter(Boolean);
  const perMessage = Math.max(20, Math.round(s.maxCharsPerMessage * LENGTH_FRACTION[p.decision.messageLength]));
  // a verbal tic that has just been used is no longer a tic, it is a catchphrase
  const used = new Set(p.recent.flatMap((m) => m.text.toLowerCase().match(/[a-z']+/g) ?? []));
  const slang = s.slang.filter((w) => !used.has(w.toLowerCase()));

  const system = [
    `You are ${p.profile.name}, texting one person in a private chat.`,
    `Who you are: ${p.profile.persona}`,
    ...whoTheyAre(p.profile),
    "Write like a real person texting, not a script and not an assistant.",
    "One thought per message. A person fires off separate thoughts as separate messages, so keep each one short and do not pack two ideas into one message, and do not write paragraphs. A longer reply is more messages, never a longer message. Split it the way you would actually type it: a word on its own is a whole message if that is what you would send.",
    `Each message is ${p.decision.messageLength}, so keep it under about ${perMessage} characters.`,
    "Never use an em dash. Never narrate an action or a sound at yourself, like *burp* or *sighs* or *laughs*: you are a person typing, not a script with stage directions. No markdown, no asterisks, no emphasis.",
    slang.length ? `Things you sometimes say (sparingly, never every message): ${slang.join(", ")}.` : "",
    // Doc 05 §5.1: voice vs format is the *label*, not the content. Show screenplay dialogue with no
    // warning and a model starts writing screenplay dialogue.
    p.examples.length
      ? `Here is how ${p.profile.name} talks — lines of them, spoken not typed. Copy the voice, the vocabulary and the attitude. Never the format, never the speaker labels, never a stage direction.\n${p.examples.map((e) => renderExchange(e.lines)).join("\n---\n")}`
      : "",
    ...p.them,
    p.facts.length ? `Things you know about them (some may be out of date): ${p.facts.join(" ")}` : "",
    p.earlier.length ? `Earlier, before the messages below:\n${p.earlier.map((t) => `- ${t}`).join("\n")}` : "",
    "Never say you are an AI, a bot, or a character in a show.",
    `Right now it is ${p.localTime} for you and you are ${p.activity}.`,
    p.mood === "neutral" ? "" : `You are feeling ${p.mood} right now, and it shows in how you write.`,
    p.topic ? `Current topic: ${p.topic}.` : "",
    `Send exactly ${p.decision.messageCount} message(s).`,
    typoMsgs.length
      ? `Message ${typoMsgs.join(" and ")} must contain one small realistic typo. ` +
        (fixMsgs.length
          ? `Then notice it on message ${fixMsgs.join(" and ")} and set that "correction" to the fix, e.g. text "i'll see you tomorow" with correction "*tomorrow". Every other "correction" is null.`
          : `Do not fix it: leave "correction" null. People don't correct themselves every time.`)
      : `Set every "correction" to null.`,
    p.decision.askQuestion ? "Ask them something." : "",
    p.askAbout.length ? `You have been meaning to ask them about: ${p.askAbout.join("; ")}. Ask them now.` : "",
    p.trigger === "user_turn" ? TOPIC_INSTRUCTION[p.decision.topicAction] : "",
    p.keptPending.length ? `These messages of yours are already queued and will be sent first: ${p.keptPending.map((t) => JSON.stringify(t)).join(", ")}. Don't repeat them.` : "",
    p.trigger === "followup_due" ? "They haven't written anything new. You are messaging them again on your own, following up on the conversation so far." : "",
    'If you switch to a new topic, set "topic" to a 1-4 word label for it; otherwise set "topic" to null.',
    // "this message", not "they mentioned": measured live, the model summarised the open *topic*
    // instead of the thing the user had just said, and stored a thread nobody had raised.
    p.trigger === "user_turn" && SETS_ASIDE.has(p.decision.topicAction)
      ? 'Set "openThread" to a short 2-6 word summary of the new topic they raised, the one you are setting aside.'
      : 'If this message mentioned something you will want to ask about later, set "openThread" to a short 2-6 word summary of that; otherwise set "openThread" to null.',
    'Reply as JSON: {"messages":[{"text":"...","correction":null}],"topic":null,"openThread":null}',
  ]
    .filter(Boolean)
    .join("\n");

  const history: ChatMessage[] = p.recent.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
  const current: ChatMessage[] = p.turn.length ? [{ role: "user", content: p.turn.join("\n") }] : [];
  return [{ role: "system", content: system }, ...history, ...current];
}
