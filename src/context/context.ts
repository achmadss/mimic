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

/** Distinct 4-letter prefixes of the words of 4+ letters: `quitting` and `quit` share `quit`. */
export function keywords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).map((w) => w.slice(0, 4)));
}

export function overlap(a: string, b: string): number {
  const kb = keywords(b);
  return [...keywords(a)].filter((k) => kb.has(k)).length;
}

function aboutSameThing(summary: string, about: string): boolean {
  return overlap(summary, about) > 0;
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

/**
 * Relationship and user behaviour (doc 06 §2.25, §2.26), derived from the messages alone and never
 * stored: how long they have known each other, and how this person texts.
 */
export interface Acquaintance {
  firstAt: number | null;
  theirMessages: number;
  avgChars: number | null;
  medianReplyMs: number | null;
}

/** A gap longer than this is someone coming back, not someone replying. */
const SESSION_GAP_MS = 6 * 3_600_000;
/** Below this many of their messages, a "usual" is one bad sample. */
const MIN_PATTERN = 10;

export function acquaintanceFrom(firstAt: number | null, theirMessages: number, sample: HistoryMessage[]): Acquaintance {
  const theirs = sample.filter((m) => m.role === "user");
  const gaps = sample.flatMap((m, i) => {
    const prev = sample[i - 1];
    const gap = prev && m.role === "user" && prev.role === "bot" ? m.at - prev.at : -1;
    return gap >= 0 && gap < SESSION_GAP_MS ? [gap] : [];
  });
  const enough = theirs.length >= MIN_PATTERN;
  return {
    firstAt,
    theirMessages,
    avgChars: enough ? Math.round(theirs.reduce((n, m) => n + m.text.length, 0) / theirs.length) : null,
    medianReplyMs: enough && gaps.length >= 3 ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null,
  };
}

function duration(ms: number): string {
  const day = 86_400_000;
  if (ms < day) return "since today";
  if (ms < 14 * day) return `for ${Math.round(ms / day)} day(s)`;
  if (ms < 60 * day) return `for ${Math.round(ms / (7 * day))} weeks`;
  return `for ${Math.round(ms / (30 * day))} months`;
}

/** Prompt lines. Says nothing it cannot back with a number. */
export function describeAcquaintance(a: Acquaintance, now: number): string[] {
  const lines = [
    a.theirMessages <= 3 || a.firstAt === null
      ? "You have barely talked to this person before; you are still getting to know them."
      : `You have been texting this person ${duration(now - a.firstAt)}; they have sent you ${a.theirMessages} messages.`,
  ];
  const how: string[] = [];
  if (a.avgChars !== null) how.push(a.avgChars < 25 ? "short, quick messages" : a.avgChars > 120 ? "long messages" : "medium-length messages");
  if (a.medianReplyMs !== null) how.push(a.medianReplyMs < 60_000 ? "usually reply within a minute" : a.medianReplyMs > 30 * 60_000 ? "usually take their time to reply" : "reply at an ordinary pace");
  if (how.length) lines.push(`They tend to write ${how.join(", and ")}.`);
  return lines;
}
