import type { JevAnswers, JevQuestion } from "../jev/client.ts";
import { EMOTIONS, type Emotion, type ExampleLine } from "../types.ts";

export interface TranscriptLine {
  episode: string;
  speaker: string;
  text: string;
}

export interface Exchange {
  characterId: string;
  episode: string;
  /** Index of its first line in `transcriptLines` output — stable for a given CSV. */
  start: number;
  lines: ExampleLine[];
}

/** Doc 05 §5.1 asks for windows of 4–8 consecutive lines. */
const EXCHANGE_SPAN = 6;
const MIN_TARGET_LINES = 2;

/**
 * RFC-4180 enough for this file: quoted fields, doubled quotes, embedded newlines and commas.
 * The transcript's `dialouge` column is quoted and indented across lines, so `split(",")` does not
 * survive contact with it.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\n") (row.push(field), rows.push(row), (row = []), (field = ""));
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) (row.push(field), rows.push(row));
  return rows;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The transcript interleaves stage directions with the words: "stumbles in drunkenly, and turns on
 * the lights. Morty! You gotta come on." / "Come on! the portal opens up in the lunchroom". Feeding
 * those to the model as voice would teach it to narrate, which is the one thing the prompt bans
 * twice and `humanize` strips. The transcription marks narration by writing it lowercase, so the
 * spoken part is the longest run of consecutive sentences that don't start that way — which drops a
 * leading direction, a trailing one, or both.
 */
export function spokenText(raw: string): string {
  const clean = collapse(
    raw
      .replace(/<[^>]+>/g, " ")
      .replace(/\([^)]*\)/g, " ") // parenthetical asides: "( cut back to the present, Rick grunts )"
      .replace(/^:\s*/, "")      // the speaker is sometimes split as `Rick` + `: line`
      .replace(/(^|\s)-(?=[A-Za-z"'])/g, "$1"), // overlapping-dialogue dashes: "-We know."
  );
  let best: string[] = [];
  let run: string[] = [];
  for (const s of clean.split(/(?<=[.!?])\s+/)) {
    if (/^[A-Z0-9"']/.test(s)) run.push(s);
    else {
      if (run.length > best.length) best = run;
      run = [];
    }
  }
  if (run.length > best.length) best = run;
  // trim only, never empty a line: a short all-lowercase text ("eh, whatever.") is speech the
  // capitalization rule cannot recognise, and losing it is worse than keeping one stray direction
  // a leading dash is a continuation marker; a trailing one is a cut-off, which is speech
  return collapse(best.length ? best.join(" ") : clean).replace(/^-+\s*/, "");
}

/** Rows with no usable dialogue are dropped; the header is located, not assumed. */
export function transcriptLines(csv: string): TranscriptLine[] {
  const rows = parseCsv(csv);
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  // `dialouge` is misspelled in the source file; `dial` matches either spelling
  const [ep, sp, tx] = ["episode", "speaker", "dial"].map((p) => header.findIndex((h) => h.startsWith(p)));
  if (ep < 0 || sp < 0 || tx < 0) throw new Error(`unexpected transcript columns: ${header.join(", ")}`);
  return rows
    .map((r) => ({ episode: (r[ep] ?? "").trim(), speaker: (r[sp] ?? "").trim(), text: spokenText(r[tx] ?? "") }))
    .filter((l) => l.text.length > 1);
}

/** `"Rick:"` → `"rick"`, `"Pickle Rick"` → `"pickle rick"`. */
export function normalizeSpeaker(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whole-word match, so `"Pickle Rick"` and `"Toxic Rick"` count as `rick` while a character named
 * `ann` does not swallow `"anne"`.
 */
export function speaksAs(speaker: string, characterId: string): boolean {
  return normalizeSpeaker(speaker).split(" ").includes(characterId.toLowerCase());
}

/**
 * A direction run straight into the speech with no sentence break: "puts an arm around Jacob's
 * shoulders The way we see it". The names inside the direction make the boundary unrecoverable, so
 * the line is not cut — its span is skipped. 47 of 9486 lines.
 */
export function narrated(text: string): boolean {
  return /^[a-z][a-z,']*( [a-z,']+)* [A-Z]/.test(text);
}

const spanKey = (span: TranscriptLine[]) =>
  span.map((l) => `${normalizeSpeaker(l.speaker)}:${collapse(l.text).toLowerCase()}`).join("|");

/**
 * Doc 05 §5.1: spans of consecutive lines in which the target character speaks at least twice, one
 * exchange per target. A Rick-and-Morty span yields an exchange for each of them. Spans that repeat
 * verbatim elsewhere in the file are kept once, because the source repeats lines across episodes.
 */
export function cutExchanges(lines: TranscriptLine[], characterIds: string[]): Exchange[] {
  const out: Exchange[] = [];
  const seen = new Set<string>();
  let runStart = 0;
  while (runStart < lines.length) {
    let runEnd = runStart + 1;
    while (runEnd < lines.length && lines[runEnd].episode === lines[runStart].episode) runEnd++;
    for (let i = runStart; i + EXCHANGE_SPAN <= runEnd; i += EXCHANGE_SPAN) {
      const span = lines.slice(i, i + EXCHANGE_SPAN);
      if (span.some((l) => narrated(l.text))) continue;
      const key = `${span[0].episode}:${spanKey(span)}`;
      for (const characterId of characterIds) {
        if (span.filter((l) => speaksAs(l.speaker, characterId)).length < MIN_TARGET_LINES) continue;
        if (seen.has(`${characterId}|${key}`)) continue;
        seen.add(`${characterId}|${key}`);
        out.push({
          characterId,
          episode: span[0].episode,
          start: i,
          lines: span.map((l) => ({ speaker: normalizeSpeaker(l.speaker), text: l.text })),
        });
      }
    }
    runStart = runEnd;
  }
  return out;
}

export function exchangeId(e: Exchange): string {
  return `${e.characterId}:${e.episode}:${e.start}`;
}

export const renderExchange = (lines: ExampleLine[]) => lines.map((l) => `${l.speaker.toUpperCase()}: ${l.text}`).join("\n");

/**
 * One question per exchange, so a batch of exchanges is one Jev request — all questions in a
 * request are evaluated in parallel (doc 04 §1), and the ingest is the one place where the cost is
 * per-exchange rather than per-turn.
 */
export function taggingQuestions(index: number, lines: ExampleLine[]): Record<string, JevQuestion> {
  return {
    [`e${index}_emotion`]: {
      type: "choice",
      instructions: {
        question: "What is the emotional register of `exchange`? Pick the one that dominates it.",
        exchange: renderExchange(lines),
      },
      criteria: {
        neutral: "Ordinary, matter-of-fact",
        excited: "Something good happened, or they are wound up",
        annoyed: "Complaining, irritated, picking a fight",
        sad: "Down about something, hurting",
        confused: "Lost, or did not understand something",
        joking: "Playing around, teasing, not serious",
        serious: "Pressing, or admitting something real",
      },
    },
  };
}

/**
 * Measured over 36 exchanges: `neutral` was the argmax of none and `sad` of one, so those buckets
 * held 3-5 examples each. But Jev gave `neutral` 0.20-0.34 and `sad` 0.17-0.44 on a handful more.
 * Anything at or above this floor is a register the exchange also reads as.
 */
const SECONDARY_FLOOR = 0.15;

/** The Choice's argmax, or `neutral` when Jev did not answer; plus every other emotion above the floor. */
export function readTags(answers: JevAnswers, index: number): { emotion: Emotion; secondary: Emotion[] } {
  const a = answers[`e${index}_emotion`];
  if (a?.type !== "choice" || !(EMOTIONS as readonly string[]).includes(a.choice)) return { emotion: "neutral", secondary: [] };
  const emotion = a.choice as Emotion;
  const secondary = EMOTIONS.filter((e) => e !== emotion && (a.probabilities[e] ?? 0) >= SECONDARY_FLOOR);
  return { emotion, secondary };
}
