import { test } from "node:test";
import assert from "node:assert/strict";
import { cutExchanges, exchangeId, narrated, normalizeSpeaker, parseCsv, readTags, renderExchange, speaksAs, spokenText, transcriptLines } from "../src/context/ingest.ts";

const HEADER = ",episode no.,speaker,dialouge";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

/** Six lines in one episode, alternating so both characters clear the two-line minimum. */
const alternating = csv(
  "0,1,Rick,one",
  "1,1,Morty,two",
  "2,1,Rick,three",
  "3,1,Morty,four",
  "4,1,Rick,five",
  "5,1,Morty,six",
);

test("parseCsv survives quoted commas, embedded newlines and doubled quotes", () => {
  const rows = parseCsv(csv('0,1,Rick,"line, with a comma"', '1,1,Morty,"one\ntwo"', '2,1,Summer,"he said ""wow"""'));
  assert.deepEqual(rows[1], ["0", "1", "Rick", "line, with a comma"]);
  assert.deepEqual(rows[2], ["1", "1", "Morty", "one\ntwo"]);
  assert.deepEqual(rows[3], ["2", "1", "Summer", 'he said "wow"']);
});

test("transcriptLines locates the header, collapses whitespace and drops blank dialogue", () => {
  const lines = transcriptLines(csv('0,1,Rick,"\n     say it,          Morty"', "1,1,Morty,", "2,2,Summer,ok"));
  assert.deepEqual(lines, [
    { episode: "1", speaker: "Rick", text: "say it, Morty" },
    { episode: "2", speaker: "Summer", text: "ok" },
  ]);
});

test("spokenText drops the stage directions the transcription writes lowercase", () => {
  // leading direction, trailing direction, and both at once
  assert.equal(spokenText("stumbles in drunkenly, and turns on the lights. Morty! You gotta come on."), "Morty! You gotta come on.");
  assert.equal(spokenText("Come on, Morty! We got to get out of here! the portal opens up in the lunchroom"), "Come on, Morty! We got to get out of here!");
  assert.equal(spokenText("grunts. I'm a pickle, Morty. he falls over"), "I'm a pickle, Morty.");
  // markup, a parenthetical aside, and the split-speaker colon
  assert.equal(spokenText(': <span style="font-weight: normal"> Ah, God, gross and weird!</span>'), "Ah, God, gross and weird!");
  assert.equal(spokenText(": I'mma bust a -- ( cut back to the present, Rick grunts )"), "I'mma bust a --");
  // never empty a line: a lowercase line the capitalization rule cannot read is still speech
  assert.equal(spokenText("eh, whatever."), "eh, whatever.");
});

test("a speaker who is not the character is not that character", () => {
  assert.equal(normalizeSpeaker("Rick:"), "rick");
  assert.equal(normalizeSpeaker("Pickle Rick"), "pickle rick");
  for (const s of ["Rick", "Rick:", "RICK", "Pickle Rick", "Toxic Rick"]) assert.ok(speaksAs(s, "rick"), s);
  // whole words only: `rick` must not swallow a different character whose name merely contains it
  assert.ok(!speaksAs("Brick", "rick"));
  assert.ok(!speaksAs("Morty", "rick"));
});

test("cutExchanges keeps a span the target speaks in twice, one exchange per character", () => {
  const got = cutExchanges(transcriptLines(alternating), ["rick", "morty"]);
  assert.deepEqual(got.map((e) => e.characterId).sort(), ["morty", "rick"]);
  assert.ok(got.every((e) => e.lines.length === 6));
  assert.equal(exchangeId(got[0]), `${got[0].characterId}:1:0`);
  assert.match(renderExchange(got[0].lines), /^RICK: |^MORTY: /);
});

test("a span where the target barely speaks is not an example of them", () => {
  const rickOnce = csv("0,1,Rick,one", "1,1,Morty,two", "2,1,Morty,three", "3,1,Morty,four", "4,1,Morty,five", "5,1,Morty,six");
  assert.deepEqual(cutExchanges(transcriptLines(rickOnce), ["rick"]), []);
  assert.equal(cutExchanges(transcriptLines(rickOnce), ["morty"]).length, 1);
});

test("spans do not cross an episode, and a short episode yields nothing", () => {
  const short = csv("0,1,Rick,one", "1,1,Morty,two", "2,1,Rick,three", "3,1,Morty,four", "4,1,Rick,five");
  assert.deepEqual(cutExchanges(transcriptLines(short), ["rick"]), [], "5 lines is under the span");

  const two = csv("0,1,Rick,one", "1,1,Morty,two", "2,1,Rick,three", "3,2,Rick,four", "4,2,Morty,five", "5,2,Rick,six");
  // episode 1 has 3 lines, episode 2 has 3: neither reaches 6, so the boundary cannot leak either way
  assert.deepEqual(cutExchanges(transcriptLines(two), ["rick"]), []);
});

test("a span that repeats verbatim in the same episode is stored once", () => {
  const repeated = [0, 1].flatMap((block) =>
    ["Rick,one", "Morty,two", "Rick,three", "Morty,four", "Rick,five", "Morty,six"].map((l, i) => `${block * 6 + i},1,${l}`),
  );
  const got = cutExchanges(transcriptLines(csv(...repeated)), ["rick"]);
  assert.equal(got.length, 1);
});

test("readTags takes the Choice, and an unanswerable batch falls back to neutral", () => {
  assert.deepEqual(readTags({ e0_emotion: { type: "choice", choice: "joking", confidence: 0.9, probabilities: {} } }, 0), { emotion: "joking", secondary: [] });
  assert.deepEqual(readTags({ e0_emotion: { type: "choice", choice: "ecstatic", confidence: 0.9, probabilities: {} } }, 0), { emotion: "neutral", secondary: [] });
  assert.deepEqual(readTags({}, 0), { emotion: "neutral", secondary: [] });
});

test("readTags keeps every other emotion at or above the floor as secondary", () => {
  const probabilities = { joking: 0.39, neutral: 0.34, serious: 0.15, sad: 0.12 };
  const got = readTags({ e0_emotion: { type: "choice", choice: "joking", confidence: 0.39, probabilities } }, 0);
  assert.deepEqual(got, { emotion: "joking", secondary: ["neutral", "serious"] });
});

test("dialogue dashes are stripped, and a span with narration fused into speech is skipped", () => {
  assert.equal(spokenText("-We know."), "We know.");
  assert.equal(spokenText("Fine. -Got it."), "Fine. Got it.");
  assert.equal(spokenText("- What?! -"), "What?! -");
  assert.equal(spokenText("a well-known fact"), "a well-known fact");
  assert.ok(narrated("puts an arm around Jacob's shoulders The way we see it."));
  assert.ok(narrated("amazed Wow!"));
  assert.ok(!narrated("eh, whatever."));
  assert.ok(!narrated("Morty, come on."));
  const fused = csv("0,1,Rick,one", "1,1,Morty,two", "2,1,Rick,amazed Wow!", "3,1,Morty,four", "4,1,Rick,five", "5,1,Morty,six");
  assert.deepEqual(cutExchanges(transcriptLines(fused), ["rick"]), []);
});
