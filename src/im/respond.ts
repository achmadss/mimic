import { randomUUID } from "node:crypto";
import { attentionNow, formatLocalTime, speedMultiplier } from "../character/derived.ts";
import type { CharacterProfile } from "../character/profile.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { JevAnswers, JevClient } from "../jev/client.ts";
import { decide } from "../jev/decide.ts";
import { buildQuestions } from "../jev/questions.ts";
import { buildJevState } from "../jev/state.ts";
import type { LLMClient } from "../llm/client.ts";
import { buildPrompt } from "../llm/prompt.ts";
import type { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import { delayOffset, replyOffsets } from "../timing.ts";
import type { BehaviorDecision, BotMessage, ConversationState, LLMOutput, Trigger } from "../types.ts";

export interface Deps {
  store: Store;
  scheduler: Scheduler;
  clock: Clock;
  jev: JevClient;
  llm: LLMClient;
  profiles: Map<string, CharacterProfile>;
  config: Config;
  log: (msg: string, err?: unknown) => void;
}

/** Jev → decision → LLM → scheduled fragments. Must run inside the conversation's serial queue. */
export async function respond(d: Deps, conversationId: string, trigger: Trigger, turn: { texts: string[]; firstAt: number } | null): Promise<void> {
  const { store, clock, config } = d;
  const now = clock.now();
  const conv = store.getConversation(conversationId);
  if (!conv) throw new Error(`unknown conversation ${conversationId}`);
  const profile = d.profiles.get(conv.characterId);
  if (!profile) throw new Error(`no profile for character ${conv.characterId}`);

  const { activity } = store.getCharacterState(conv.characterId, now);
  const attention = attentionNow(conv, profile, activity, now);
  const pending = store.pendingBotMessages(conversationId);
  const recent = store.recentMessages(conversationId, config.recentMessages, turn?.firstAt);
  const localTime = formatLocalTime(now, profile.timezone);
  const texts = turn?.texts ?? [];

  let answers: JevAnswers | null = null;
  try {
    const state = buildJevState({ trigger, profile, activity, attention, localTime, topic: conv.topic, recent, turn: texts, pending });
    answers = await d.jev.ask(state, buildQuestions(trigger, pending));
  } catch (e) {
    d.log("jev unavailable, using defaults", e);
  }
  const decision = decide(answers, {
    trigger,
    pendingIds: pending.map((m) => m.id),
    basePace: profile.basePace,
    maxMessages: config.maxMessages,
    choiceConfidence: config.choiceConfidence,
    noulThreshold: config.noulThreshold,
  });

  const kept = store.tx(() => applyDecision(d, conv, decision, pending, now));
  if (decision.respondMode !== "now") return;

  let output: LLMOutput;
  try {
    output = await d.llm.generate(
      buildPrompt({ profile, decision, trigger, activity, localTime, topic: conv.topic, recent, turn: texts, keptPending: kept.map((m) => m.text), maxChars: config.maxChars[conv.platform] }),
    );
  } catch (e) {
    d.log("llm failed; staying silent", e);
    store.appendEvent(conversationId, clock.now(), "LLM_GENERATION_FAILED", { error: String(e) });
    return;
  }
  const speed = speedMultiplier(profile, activity, Math.max(attention, decision.attentionRaise ?? 0));
  store.tx(() => scheduleReply(d, conversationId, decision, output, kept, speed));
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
  if (decision.followUp) {
    scheduler.schedule({ id: `followup:${conv.conversationId}`, conversationId: conv.conversationId, kind: "delayed_followup", dueAt: now + decision.followUp.afterMs });
  }
  return kept;
}

function scheduleReply(d: Deps, conversationId: string, decision: BehaviorDecision, output: LLMOutput, kept: BotMessage[], speed: number) {
  const { store, scheduler, clock, config } = d;
  const now = clock.now();
  const conv = store.getConversation(conversationId)!;
  const maxChars = config.maxChars[conv.platform];

  const texts: string[] = [];
  for (const m of output.messages.slice(0, decision.messageCount)) {
    texts.push(m.text.trim().slice(0, maxChars));
    const correction = m.correction?.trim();
    if (correction) texts.push(correction.slice(0, maxChars));
  }
  store.appendEvent(conversationId, now, "LLM_RESPONSE_GENERATED", { output });

  const newTopic = output.topic?.trim();
  if (decision.topicAction === "switch" && newTopic) {
    store.saveConversation({ ...conv, topic: newTopic, topicStartedAt: now });
    store.appendEvent(conversationId, now, "TOPIC_CHANGED", { topic: newTopic });
  }

  const generationId = randomUUID();
  const start = Math.max(now, ...kept.map((m) => m.dueAt));
  const offsets = replyOffsets({ pace: decision.pace, speedMultiplier: speed, texts, maxDelayMs: config.maxDelayMs, seed: generationId });
  texts.forEach((text, order) => {
    const m: BotMessage = { id: randomUUID(), conversationId, generationId, conversationVersion: conv.version, text, order, status: "scheduled", dueAt: start + offsets[order] };
    store.insertBotMessage(m);
    scheduler.schedule({ id: m.id, conversationId, kind: "send_message", dueAt: m.dueAt });
    store.appendEvent(conversationId, now, "OUTGOING_MESSAGE_SCHEDULED", { messageId: m.id, dueAt: m.dueAt, text });
  });
}
