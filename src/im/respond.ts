import { randomUUID } from "node:crypto";
import { attentionNow, formatLocalTime, speedMultiplier } from "../character/derived.ts";
import { moodNow } from "../character/mood.ts";
import { applyStyle, humanize, styleFor, type MessageStyle } from "../character/style.ts";
import type { CharacterProfile } from "../character/profile.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import { acquaintanceFrom, clamp, contextWindow, describeAcquaintance, nextOpenThreads, openThreads, selectExamples } from "../context/context.ts";
import type { JevAnswers, JevClient } from "../jev/client.ts";
import { elsewhere, recall, summarizeIfDue } from "../context/memory.ts";
import { decide } from "../jev/decide.ts";
import { buildQuestions } from "../jev/questions.ts";
import { buildJevState } from "../jev/state.ts";
import { sessionIdFor, type LLMClient } from "../llm/client.ts";
import { buildPrompt } from "../llm/prompt.ts";
import type { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import { delayOffset, replyOffsets } from "../timing.ts";
import type { BehaviorDecision, BotMessage, ConversationState, LLMOutput, Trigger, UnresolvedItem } from "../types.ts";

/**
 * Jev chooses the beat count before the model writes, so sometimes the model answers "3" with one
 * paragraph — a wall of text where three short messages belonged. Splitting only where the model
 * already put a sentence break keeps its phrasing intact; cutting on commas instead would produce
 * "i know," / "right?".
 *
 * ponytail: one message in, N messages out, sentence boundaries only, and it never merges a burst
 * the model chose. If a wrong count ever becomes common, have the model tag its own beats rather
 * than guess harder here.
 */
export function splitToCount(text: string, want: number): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (want < 2 || parts.length < want) return [text];
  const per = Math.ceil(parts.length / want);
  const out = Array.from({ length: want }, (_, i) => parts.slice(i * per, (i + 1) * per).join(" ")).filter(Boolean);
  return out.length >= 2 ? out : [text];
}

export interface Deps {
  store: Store;
  scheduler: Scheduler;
  clock: Clock;
  /** The character's own Jev and LLM. Resolved per call, so a key or model changed in the dashboard applies on the next turn. */
  ai: (characterId: string) => { llm: LLMClient; jev: JevClient };
  profiles: Map<string, CharacterProfile>;
  config: Config;
  log: (msg: string, err?: unknown) => void;
}

/** The user's finished turn: what they said, and when they started and stopped saying it. */
export interface TurnInput {
  texts: string[];
  firstAt: number;
  lastAt: number;
}

/** Jev → decision → LLM → scheduled fragments. Must run inside the conversation's serial queue. */
export async function respond(d: Deps, conversationId: string, trigger: Trigger, turn: TurnInput | null): Promise<void> {
  const { store, clock, config } = d;
  const now = clock.now();
  const conv = store.getConversation(conversationId);
  if (!conv) throw new Error(`unknown conversation ${conversationId}`);
  const profile = d.profiles.get(conv.characterId);
  if (!profile) throw new Error(`no profile for character ${conv.characterId}`);

  const cs = store.getCharacterState(conv.characterId, now);
  const activity = cs.activity;
  const attention = attentionNow(conv, profile, activity, now);
  const mood = moodNow(cs, now);
  const pending = store.pendingBotMessages(conversationId);
  const recent = contextWindow(conv, config, (since) =>
    store.recentMessages(conversationId, config.recentMessages, turn?.firstAt, since),
  );
  const localTime = formatLocalTime(now, profile.timezone);
  const texts = turn?.texts ?? [];
  // pruned and capped here, so Jev sees the same list the turn will act on
  const open = openThreads(conv.unresolved, now, config);
  const stats = store.userMessageStats(conversationId);
  const them = acquaintanceFrom(stats.firstAt, stats.count, store.recentMessages(conversationId, 100));

  let answers: JevAnswers | null = null;
  try {
    const state = buildJevState({
      trigger,
      now,
      profile,
      activity,
      activitySince: cs.activitySince,
      mood,
      moodChangedAt: cs.moodChangedAt,
      attention,
      localTime,
      topic: conv.topic,
      lastUserAt: conv.lastUserAt,
      lastBotAt: conv.lastBotAt,
      turn,
      recent,
      pending,
      openThreads: open,
      them,
    });
    answers = await d.ai(conv.characterId).jev.ask(state, buildQuestions(trigger, pending, open));
  } catch (e) {
    d.log("jev unavailable, using defaults", e);
  }
  const decision = decide(answers, {
    trigger,
    pendingIds: pending.map((m) => m.id),
    basePace: profile.basePace,
    maxMessages: config.maxMessages,
    choiceMargin: config.choiceMargin,
    scoreConfidence: config.scoreConfidence,
    noulThreshold: config.noulThreshold,
    followUpThreshold: config.followUpThreshold,
    openThreadThreshold: config.openThreadThreshold,
  });

  const kept = store.tx(() => applyDecision(d, conv, decision, pending, now));
  // An activity change re-decides what is queued. It never writes text, whether or not Jev exists.
  if (trigger === "activity_changed" || decision.respondMode !== "now") {
    // Measured live: "the thesis thing is tomorrow morning" opened a thread on a turn Jev answered
    // `later`, and with no generation there was no label, so it was lost. Their own words stand in.
    if (decision.openThread && texts.length) {
      const unresolved = nextOpenThreads(open, { asked: [], raised: clamp(texts.join(" ")) }, now, config);
      store.tx(() => saveThreads(d, conversationId, conv.unresolved, unresolved, now));
    }
    return;
  }

  // the seed for both the send jitter and the per-message style, fixed before the model runs
  const generationId = randomUUID();
  const styles = styleFor(profile, generationId, decision.messageCount);
  // a seeded draw over the emotion bucket: same generation seed, same examples
  const examples = decision.emotion
    ? selectExamples(store.examplesFor(conv.characterId, decision.emotion, config.examplePool), config.maxExamples, generationId)
    : [];
  const asking = decision.topicAction === "ask" ? open : [];
  const remembered = recall(store, conversationId, `${texts.join(" ")} ${conv.topic ?? ""}`, config);
  const otherChats = elsewhere(store, conversationId, now, config);
  // What this turn was actually built from (doc 04 §2: recorded for explainability). The prompt is
  // not stored, but its inputs are, and they are what explain a surprising reply.
  store.appendEvent(conversationId, now, "CONTEXT_RETRIEVED", {
    window: conv.topicStartedAt && recent.length >= config.minRecentMessages ? "recent_topic" : "recent",
    messages: recent.length,
    examples: examples.map((e) => e.id),
    openThreads: open.map((t) => t.id),
    asking: asking.map((t) => t.id),
    memories: [...remembered.facts, ...remembered.summaries].map((m) => m.id),
    elsewhere: otherChats.length,
  });

  let output: LLMOutput;
  try {
    output = await d.ai(conv.characterId).llm.generate(
      buildPrompt({
        profile, decision, trigger, activity, mood, localTime, topic: conv.topic, recent, turn: texts,
        keptPending: kept.map((m) => m.text), styles, examples, askAbout: asking.map((t) => t.summary),
        them: describeAcquaintance(them, now),
        facts: remembered.facts.map((m) => m.text),
        earlier: remembered.summaries.map((m) => m.text),
        elsewhere: otherChats,
      }),
      { sessionId: sessionIdFor(conversationId) },
    );
  } catch (e) {
    // A thread is consumed by being asked, and nothing was asked: the list is left untouched.
    d.log("llm failed; staying silent", e);
    store.appendEvent(conversationId, clock.now(), "LLM_GENERATION_FAILED", { error: String(e) });
    return;
  }
  const speed = speedMultiplier(profile, activity, Math.max(attention, decision.attentionRaise ?? 0));
  const unresolved = nextOpenThreads(
    open,
    { asked: asking, raised: decision.openThread ? (output.openThread ?? null) : null, about: texts.join(" ") },
    now,
    config,
  );
  store.tx(() => scheduleReply(d, conversationId, decision, output, kept, speed, generationId, styles, unresolved));
  // after the reply is queued, never before it, and outside this queue's critical path
  void summarizeIfDue(d, conversationId);
}

function applyDecision(d: Deps, conv: ConversationState, decision: BehaviorDecision, pending: BotMessage[], now: number): BotMessage[] {
  const { store, scheduler } = d;
  store.appendEvent(conv.conversationId, now, "BEHAVIOR_DECISION_CREATED", decision);
  const kept: BotMessage[] = [];
  let last = now;
  for (const m of pending) {
    const action = decision.pendingActions.find((p) => p.messageId === m.id)?.action ?? "cancel";
    if (action === "continue" || action === "delay") {
      const extra = action === "delay" ? delayOffset(decision.pace, m.id) : 0;
      const dueAt = Math.max(m.dueAt + extra, now + extra, kept.length ? last + 800 : 0);
      const updated: BotMessage = { ...m, conversationVersion: conv.version, dueAt };
      store.updateBotMessage(updated);
      scheduler.schedule({ id: m.id, conversationId: conv.conversationId, kind: "send_message", dueAt });
      kept.push(updated);
      last = dueAt;
    } else {
      store.updateBotMessage({ ...m, status: "cancelled" });
      scheduler.cancel(m.id);
      store.appendEvent(conv.conversationId, now, "OUTGOING_MESSAGE_CANCELLED", { messageId: m.id, reason: action });
    }
  }
  if (decision.attentionRaise !== undefined) {
    // a new raise can only ever raise: an "important" message must not leave them less attentive than before
    const current = store.getConversation(conv.conversationId)!;
    const attention = Math.max(current.attention ?? 0, decision.attentionRaise);
    store.saveConversation({ ...current, attention, attentionRaisedAt: now });
    store.appendEvent(conv.conversationId, now, "ATTENTION_CHANGED", { attention, raisedBy: decision.attentionRaise });
  }
  if (decision.mood) {
    store.saveCharacterState({ ...store.getCharacterState(conv.characterId, now), mood: decision.mood, moodChangedAt: now });
  }
  if (decision.followUp) {
    scheduler.schedule({ id: `followup:${conv.conversationId}`, conversationId: conv.conversationId, kind: "delayed_followup", dueAt: now + decision.followUp.afterMs });
  }
  return kept;
}

/**
 * Only on a real change. `nextOpenThreads` always returns a fresh array, so an identity check wrote
 * a save and an empty `UNRESOLVED_CHANGED` on every turn.
 */
function saveThreads(d: Deps, conversationId: string, before: UnresolvedItem[], after: UnresolvedItem[], now: number) {
  const ids = (l: UnresolvedItem[]) => l.map((t) => t.id).join(",");
  if (ids(before) === ids(after)) return;
  d.store.saveConversation({ ...d.store.getConversation(conversationId)!, unresolved: after });
  d.store.appendEvent(conversationId, now, "UNRESOLVED_CHANGED", { open: after.map((t) => t.summary) });
}

function scheduleReply(
  d: Deps,
  conversationId: string,
  decision: BehaviorDecision,
  output: LLMOutput,
  kept: BotMessage[],
  speed: number,
  generationId: string,
  styles: MessageStyle[],
  unresolved: UnresolvedItem[],
) {
  const { store, scheduler, clock, config } = d;
  const now = clock.now();
  const conv = store.getConversation(conversationId)!;
  const maxChars = config.maxChars[conv.platform];

  // The model re-sends a line that is already queued often enough to matter, even with the list in
  // front of it — measured live: it answered a kept "night, dipshit" with another "night, dipshit".
  // Dropping it in code is the same kind of hygiene as `humanize`: a rule the model cannot opt out of.
  // ponytail: exact match after lowercasing and stripping punctuation. A paraphrase still gets
  // through; near-duplicate detection is not worth the false positives it brings.
  const normalized = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const alreadyQueued = new Set(kept.map((m) => normalized(m.text)));

  const texts: string[] = [];
  output.messages.slice(0, decision.messageCount).forEach((m, k) => {
    const styled = applyStyle(m.text.trim(), styles[k]).slice(0, maxChars);
    if (alreadyQueued.has(normalized(styled))) return;
    // only when the model under-delivered on a count Jev had already chosen
    const pieces = output.messages.length === 1 && decision.messageCount > 1 ? splitToCount(styled, decision.messageCount) : [styled];
    texts.push(...pieces);
    const correction = m.correction?.trim();
    if (correction) texts.push(humanize(correction).slice(0, maxChars));
  });
  store.appendEvent(conversationId, now, "LLM_RESPONSE_GENERATED", { output });

  const newTopic = output.topic?.trim();
  if (decision.topicAction === "switch" && newTopic) {
    store.saveConversation({ ...conv, topic: newTopic, topicStartedAt: now });
    store.appendEvent(conversationId, now, "TOPIC_CHANGED", { topic: newTopic });
  }
  saveThreads(d, conversationId, conv.unresolved, unresolved, now);

  const start = Math.max(now, ...kept.map((m) => m.dueAt));
  const offsets = replyOffsets({ pace: decision.pace, speedMultiplier: speed, texts, maxDelayMs: config.maxDelayMs, seed: generationId });
  texts.forEach((text, order) => {
    const m: BotMessage = { id: randomUUID(), conversationId, generationId, conversationVersion: conv.version, text, order, status: "scheduled", dueAt: start + offsets[order] };
    store.insertBotMessage(m);
    scheduler.schedule({ id: m.id, conversationId, kind: "send_message", dueAt: m.dueAt });
    store.appendEvent(conversationId, now, "OUTGOING_MESSAGE_SCHEDULED", { messageId: m.id, dueAt: m.dueAt, text });
  });
}
