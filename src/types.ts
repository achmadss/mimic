export const ACTIVITIES = ["idle", "working", "studying", "gaming", "eating", "watching", "commuting", "sleeping", "away"] as const;
export type Activity = (typeof ACTIVITIES)[number];
export type Availability = "available" | "busy" | "away" | "sleeping";
export const PACES = ["instant", "fast", "normal", "slow", "very_slow"] as const;
export type Pace = (typeof PACES)[number];
export type Platform = "telegram" | "discord" | "cli";
/** What a platform shows for an account. Derived from `activity`; never stored. */
export type Presence = "online" | "idle" | "dnd" | "invisible";
export const TOPIC_ACTIONS = ["continue", "switch", "acknowledge_return", "ignore", "ask"] as const;
export type TopicAction = (typeof TOPIC_ACTIONS)[number];
export const PENDING_DECISIONS = ["continue", "cancel", "delay", "replace"] as const;
export type PendingDecision = (typeof PENDING_DECISIONS)[number];
export const RESPOND_MODES = ["now", "later", "no_reply"] as const;
export type RespondMode = (typeof RESPOND_MODES)[number];
export type MessageStatus = "scheduled" | "sending" | "sent" | "cancelled" | "failed";
/** `unanswered`: the character came back (woke up, got home) to messages they never answered. */
export type Trigger = "user_turn" | "followup_due" | "activity_changed" | "unanswered";
/** How much goes into one message. A fraction of the character's own per-message ceiling. */
export const MESSAGE_LENGTHS = ["terse", "short", "normal", "long"] as const;
export type MessageLength = (typeof MESSAGE_LENGTHS)[number];

/** Doc 04 §1: `turn_emotion` and the example tag are the same set, on purpose. */
export const EMOTIONS = ["neutral", "excited", "annoyed", "sad", "confused", "joking", "serious"] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** One line of source dialogue. The speaker is normalized (`"Rick:"` → `"rick"`) and rendered back. */
export interface ExampleLine {
  speaker: string;
  text: string;
}

/** A tagged stretch of source dialogue, retrieved at reply time by `(characterId, emotion)`. */
export interface Example {
  /** `${characterId}:${episode}:${firstRow}` — stable across reruns, so ingest can `OR REPLACE`. */
  id: string;
  characterId: string;
  episode: string;
  emotion: Emotion;
  /** Other registers Jev gave real weight to. How a show with few calm scenes still fills `neutral`. */
  secondary: Emotion[];
  lines: ExampleLine[];
}

/**
 * Doc 02 §1. The stored list *is* the open set: a thread is removed once it has been asked about,
 * so there is no `status` to write and never read.
 */
export interface UnresolvedItem {
  id: string;
  summary: string;
  raisedAt: number;
}

export interface ConversationState {
  conversationId: string;
  characterId: string;
  platform: Platform;
  chatId: string;
  version: number;
  topic: string | null;
  topicStartedAt: number | null;
  lastUserAt: number;
  lastBotAt: number;
  attention: number | null;
  attentionRaisedAt: number | null;
  unresolved: UnresolvedItem[];
}

/** Doc 02 §1. Set by Jev, persisted, and expired on a TTL by `moodNow`. */
export const MOODS = ["neutral", "happy", "tired", "annoyed", "excited", "distracted"] as const;
export type Mood = (typeof MOODS)[number];

export interface CharacterState {
  characterId: string;
  activity: Activity;
  activitySince: number;
  mood: Mood | null;
  moodChangedAt: number | null;
}

/** A row exists only while the turn is collecting. */
export interface TurnBuffer {
  conversationId: string;
  messageIds: string[];
  texts: string[];
  firstAt: number;
  lastAt: number;
}

export interface BotMessage {
  id: string; // also the Scheduler action id
  conversationId: string;
  generationId: string;
  conversationVersion: number;
  text: string;
  order: number;
  status: MessageStatus;
  dueAt: number;
}

export type ActionKind = "send_message" | "turn_quiet" | "delayed_followup";

export interface ActionRow {
  id: string;
  conversationId: string;
  kind: ActionKind;
  dueAt: number;
}

export interface BehaviorDecision {
  respondMode: RespondMode;
  followUp?: { afterMs: number };
  topicAction: TopicAction;
  pace: Pace;
  messageCount: number;
  messageLength: MessageLength;
  /** Undefined means "unchanged": a mood that nothing said should move is left to expire on its TTL. */
  mood?: Mood;
  askQuestion: boolean;
  attentionRaise?: number;
  /** Undefined off a user turn: there is no user message to read a register from. */
  emotion?: Emotion;
  /** The user raised something still open; the LLM writes the summary (doc 04 §1). */
  openThread: boolean;
  pendingActions: { messageId: string; action: PendingDecision }[];
  answers: unknown; // raw Jev answers, for the event log
}

export interface SummaryOutput {
  summary: string;
  /** Durable things about the user, one short sentence each. */
  facts: string[];
}

/** Doc 05 §1 long-term layer. A summary covers `fromAt..toAt`; a fact was learned in that span. */
export interface MemoryItem {
  id: string;
  conversationId: string;
  kind: "summary" | "fact";
  text: string;
  fromAt: number;
  toAt: number;
}

export interface LLMOutput {
  messages: { text: string; correction?: string | null }[];
  topic?: string | null;
  /** Required when `BehaviorDecision.openThread`; the label Jev cannot write. */
  openThread?: string | null;
}
