import { randomUUID } from "node:crypto";
import type { CharacterProfile } from "../character/profile.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import { sessionIdFor, type LLMClient } from "../llm/client.ts";
import type { Store } from "../store.ts";
import type { MemoryItem } from "../types.ts";
import { overlap, type HistoryMessage } from "./context.ts";

/**
 * Doc 05 §1, the long-term layer. What the reply path cannot see — everything older than the
 * newest `recentMessages` — is kept as notes: one summary per chunk, plus durable facts about the
 * user. The summarizer runs off the reply path and after it; a failure leaves the chunk to be tried
 * again on the next turn, and the reply never waits on it (doc 05 §9).
 */

export interface MemoryDeps {
  store: Store;
  llm: LLMClient;
  clock: Clock;
  profiles: Map<string, CharacterProfile>;
  config: Config;
  log: (msg: string, err?: unknown) => void;
}

const inFlight = new Set<string>();
const day = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(at);
const normalized = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** The oldest messages that have left the window and are not yet summarized; empty if too few. */
export function dueChunk(after: HistoryMessage[], config: Config): HistoryMessage[] {
  const outside = after.length - config.recentMessages;
  return outside < config.summaryMinChunk ? [] : after.slice(0, Math.min(outside, config.summaryMaxChunk));
}

/** Resolves true when it wrote notes. Never throws. */
export async function summarizeIfDue(d: MemoryDeps, conversationId: string): Promise<boolean> {
  if (inFlight.has(conversationId)) return false;
  inFlight.add(conversationId);
  try {
    const { store, config } = d;
    const conv = store.getConversation(conversationId);
    const profile = conv && d.profiles.get(conv.characterId);
    if (!profile) return false;
    const chunk = dueChunk(store.messagesAfter(conversationId, store.summarizedUntil(conversationId)), config);
    if (!chunk.length) return false;

    const known = store.memories(conversationId, "fact", 50);
    const notes = await d.llm.summarize([
      {
        role: "system",
        content: [
          `You keep private notes for ${profile.name} on their text conversation with one person.`,
          // measured: without the date, "thesis defense on Thursday" is stored, and is wrong a week later
          `These messages are from ${day(chunk[0].at, profile.timezone)}${day(chunk[0].at, profile.timezone) === day(chunk[chunk.length - 1].at, profile.timezone) ? "" : ` to ${day(chunk[chunk.length - 1].at, profile.timezone)}`}. Write any day they mention as a date ("Thu 1 Oct"), never as "tomorrow" or "on Thursday". No em dashes.`,
          known.length ? `Already known about the person: ${known.map((f) => f.text).join("; ")}.` : "",
          `Write "summary": 1-3 sentences on what was talked about in these messages, from ${profile.name}'s side ("they told me...", "we argued about..."). Keep names, dates and specifics.`,
          `Write "facts": durable things about the person that would still matter weeks from now: their name, work or school, people and pets in their life, likes and dislikes, plans with dates. One short sentence each. Nothing about ${profile.name}, nothing already known, no passing small talk. Use [] when there is nothing new.`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      { role: "user", content: chunk.map((m) => `${m.role === "user" ? "THEM" : "YOU"}: ${m.text}`).join("\n") },
    ], { sessionId: sessionIdFor(conversationId) });

    const fromAt = chunk[0].at;
    const toAt = chunk[chunk.length - 1].at;
    const seen = new Set(known.map((f) => normalized(f.text)));
    const items: MemoryItem[] = [{ id: randomUUID(), conversationId, kind: "summary", text: notes.summary, fromAt, toAt }];
    for (const fact of notes.facts) {
      if (seen.has(normalized(fact))) continue;
      seen.add(normalized(fact));
      items.push({ id: randomUUID(), conversationId, kind: "fact", text: fact, fromAt, toAt });
    }
    store.tx(() => {
      store.saveMemories(conversationId, items, toAt);
      store.appendEvent(conversationId, d.clock.now(), "MEMORY_WRITTEN", { messages: chunk.length, summary: notes.summary, facts: items.length - 1 });
    });
    return true;
  } catch (e) {
    d.log("summarizer failed; will retry on a later turn", e);
    return false;
  } finally {
    inFlight.delete(conversationId);
  }
}

/**
 * Doc 05 §5 rung 2: keyword overlap with the turn and topic, newest first on a tie, capped by the
 * budget. With nothing in common, that is simply the newest notes — what just left the window.
 */
export function recall(store: Store, conversationId: string, query: string, config: Config): { facts: MemoryItem[]; summaries: MemoryItem[] } {
  const rank = (items: MemoryItem[], limit: number) =>
    items
      .map((m, i) => ({ m, score: overlap(m.text, query), i }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, limit)
      .map((x) => x.m);
  return {
    facts: rank(store.memories(conversationId, "fact", 200), config.maxFacts),
    // chronological in the prompt, so two notes read as a sequence of events
    summaries: rank(store.memories(conversationId, "summary", 100), config.maxSummaries).sort((a, b) => a.toAt - b.toAt),
  };
}

export interface ElsewhereMessage extends HistoryMessage {
  platform: string;
}

/** The newest messages from this person's other linked chats, oldest first. */
export function elsewhere(store: Store, conversationId: string, now: number, config: Config): ElsewhereMessage[] {
  if (!config.crossChatMessages) return [];
  return store
    .linkedConversationIds(conversationId)
    .slice(1)
    .flatMap((id) => {
      const platform = store.getConversation(id)?.platform ?? "another app";
      return store.recentMessages(id, config.crossChatMessages, Number.MAX_SAFE_INTEGER, now - config.crossChatWindowMs).map((m) => ({ ...m, platform }));
    })
    .sort((a, b) => a.at - b.at)
    .slice(-config.crossChatMessages);
}
