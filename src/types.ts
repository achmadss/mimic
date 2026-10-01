export const ACTIVITIES = ["idle", "working", "studying", "gaming", "eating", "watching", "commuting", "sleeping", "away"] as const;
export type Activity = (typeof ACTIVITIES)[number];
export type Availability = "available" | "busy" | "away" | "sleeping";
export const PACES = ["instant", "fast", "normal", "slow", "very_slow"] as const;
export type Pace = (typeof PACES)[number];
export type Platform = "telegram" | "discord" | "cli";
export const TOPIC_ACTIONS = ["continue", "switch", "acknowledge_return", "ignore", "ask"] as const;
export type TopicAction = (typeof TOPIC_ACTIONS)[number];
export const PENDING_DECISIONS = ["continue", "cancel", "delay", "replace"] as const;
export type PendingDecision = (typeof PENDING_DECISIONS)[number];
export const RESPOND_MODES = ["now", "later", "no_reply"] as const;
export type RespondMode = (typeof RESPOND_MODES)[number];
export type MessageStatus = "scheduled" | "sending" | "sent" | "cancelled" | "failed";
export type Trigger = "user_turn" | "followup_due";
/** How much goes into one message. A fraction of the character's own per-message ceiling. */
export const MESSAGE_LENGTHS = ["terse", "short", "normal", "long"] as const;
export type MessageLength = (typeof MESSAGE_LENGTHS)[number];

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
  askQuestion: boolean;
  attentionRaise?: number;
  pendingActions: { messageId: string; action: PendingDecision }[];
  answers: unknown; // raw Jev answers, for the event log
}

export interface LLMOutput {
  messages: { text: string; correction?: string | null }[];
  topic?: string | null;
}
