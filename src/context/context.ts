import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { seededUnit } from "../rng.ts";
import type { ConversationState, Example, UnresolvedItem } from "../types.ts";

export interface HistoryMessage {
  role: "user" | "bot";
  text: string;
  at: number;
}

/**
 * Doc 05 §5: topic scoping is the cheap answer to "PC history drowning out the keyboard topic" —
 * no embeddings, just a lower bound on the message query.
 *
 * The floor is the whole point. A topic raised one message ago would otherwise return a single
 * message and blank out the conversation the character is replying into, which is a far worse
 * failure than the crowding it fixes. Below the floor, fall back to the ordinary recent window.
 */
export function contextWindow(
  conv: Pick<ConversationState, "topicStartedAt">,
  config: Config,
  fetch: (since: number) => HistoryMessage[],
): HistoryMessage[] {
  const since = conv.topicStartedAt ?? 0;
  if (!since) return fetch(0);
  const topic = fetch(since);
  return topic.length >= config.minRecentMessages ? topic : fetch(0);
}

/**
 * Doc 05 §5.1: a seeded draw, so the same examples do not repeat every turn. Deterministic for a
 * given seed, which is what makes a surprising reply reproducible.
 */
export function selectExamples(pool: Example[], limit: number, seed: string): Example[] {
  return [...pool].sort((x, y) => seededUnit(seed, x.id) - seededUnit(seed, y.id)).slice(0, limit);
}

/**
 * The open, unexpired threads, oldest first, capped to the newest `unresolvedMax`. Sorted rather
 * than trusting the stored order, so a hand-edited or migrated row cannot silently drop the newest.
 */
export function openThreads(items: UnresolvedItem[], now: number, config: Config): UnresolvedItem[] {
  return items
    .filter((t) => now - t.raisedAt < config.unresolvedTtlMs)
    .sort((a, b) => a.raisedAt - b.raisedAt)
    .slice(-config.unresolvedMax);
}

/** Same hygiene the reply path applies to a repeated line: punctuation and case are not a difference. */
const normalized = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/**
 * Does the summary talk about the message it is supposed to summarise?
 *
 * Measured: told a landlord was inspecting the flat, the model set `openThread` to "thesis defense
 * thursday morning" — something from earlier in the conversation. Nothing else catches that, and
 * the cost is not a missing thread but a wrong one: the bot asks about the wrong thing and drops
 * the right one.
 *
 * `ponytail:` four-character prefix overlap, which reads `quit`/`quitting` and `meet`/`meeting` as
 * the same word. A genuine paraphrase (">first day at work" for "starting my new job monday") shares
 * no prefix and is dropped — a missing thread rather than a wrong one, which is the cheaper error.
 * Reach for a stemmer only if that shows up.
 */
/** The user's own words, as a summary: one line, cut at a word boundary, keeping the start. */
function clamp(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= 80 ? t : `${t.slice(0, 80).replace(/\s+\S*$/, "")}...`;
}

function aboutSameThing(summary: string, about: string): boolean {
  const words = (s: string) => s.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const them = words(about);
  return words(summary).some((w) => them.some((v) => w.slice(0, 4) === v.slice(0, 4)));
}

/**
 * The list to store after a turn. `asked` threads are removed — a thread is consumed by being asked
 * about, and this runs only after the reply that asked was actually generated. A repeated summary is
 * ignored rather than stored twice.
 */
export function nextOpenThreads(
  open: UnresolvedItem[],
  opts: { asked: UnresolvedItem[]; raised: string | null; about?: string },
  now: number,
  config: Config,
): UnresolvedItem[] {
  const askedIds = new Set(opts.asked.map((t) => t.id));
  const kept = open.filter((t) => !askedIds.has(t.id));
  const raw = opts.raised?.trim() ?? "";
  // A summary about the conversation instead of the message is not *this* thread — but the user
  // still said something open, so fall back to their own words rather than forgetting it. Without
  // the fallback the guard would turn a wrong memory into a missing one, which is quieter but not
  // actually better.
  const summary = !raw || !opts.about || aboutSameThing(raw, opts.about) ? raw : clamp(opts.about);
  if (summary && !kept.some((t) => normalized(t.summary) === normalized(summary))) {
    kept.push({ id: randomUUID(), summary, raisedAt: now });
  }
  return kept.slice(-config.unresolvedMax);
}
