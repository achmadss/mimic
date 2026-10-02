import assert from "node:assert/strict";
import { test } from "node:test";
import { loadProfiles } from "../src/character/profile.ts";
import { applyStyle, humanize, styleFor, type MessageStyle } from "../src/character/style.ts";
import { buildPrompt } from "../src/llm/prompt.ts";
import { decide } from "../src/jev/decide.ts";

const rick = loadProfiles("characters").get("rick")!;
const decision = { ...decide(null, { trigger: "user_turn", pendingIds: [], basePace: "fast", maxMessages: 3, choiceMargin: 1.2, scoreConfidence: 0.4, noulThreshold: 0.7, followUpThreshold: 0.55, openThreadThreshold: 0.55 }), messageCount: 2 };
const prompt = (styles: MessageStyle[]) =>
  buildPrompt({ profile: rick, decision, trigger: "user_turn", activity: "idle", mood: "neutral", localTime: "Thu 04:00", topic: null, recent: [], turn: ["sup"], keptPending: [], examples: [], askAbout: [], them: [], facts: [], earlier: [], elsewhere: [], styles })[0].content;

test("styleFor: deterministic per generation, and a tendency rather than a constant", () => {
  assert.deepEqual(styleFor(rick, "gen-a", 3), styleFor(rick, "gen-a", 3));
  const rolls = Array.from({ length: 300 }, (_, i) => styleFor(rick, `gen-${i}`, 1)[0]);
  const lower = rolls.filter((r) => r.lowercase).length / rolls.length;
  assert.ok(Math.abs(lower - rick.speechStyle.lowercase) < 0.12, `lowercase rate ${lower} should track the 0.8 profile weight`);
  assert.ok(rolls.some((r) => r.typo) && rolls.some((r) => !r.typo), "typoRate 0.05 must be occasional, not every message or never");
});

test("prompt: a rolled typo names the message and asks for its correction", () => {
  assert.match(prompt([{ lowercase: true, typo: false, correct: false }, { lowercase: true, typo: true, correct: true }]), /Message 2 must contain one small realistic typo/);
  assert.match(prompt([{ lowercase: true, typo: false, correct: false }, { lowercase: false, typo: false, correct: false }]), /Set every "correction" to null/);
  // a typo that is NOT rolled for correction must be explicitly left alone
  const left = prompt([{ lowercase: false, typo: true, correct: false }, { lowercase: false, typo: false, correct: false }]);
  assert.match(left, /Do not fix it/);
});

test("applyStyle: the System applies the roll, the model cannot opt out", () => {
  const lc = { lowercase: true, typo: true, correct: false };
  const plain = { lowercase: false, typo: false, correct: false };
  assert.equal(applyStyle("I'll See You Tomorow", lc), "i'll see you tomorow");
  assert.equal(applyStyle("I'll See You Tomorrow", plain), "I'll See You Tomorrow");
  assert.equal(applyStyle("Anything", undefined), "Anything");
});

test("humanize: strips the tells a language model leaves in a text message", () => {
  // an em dash is the loudest one; a person types a comma or starts a new sentence
  assert.equal(humanize("it's fine — i don't care"), "it's fine, i don't care");
  assert.equal(humanize("oh for fu— listen"), "oh for fu- listen");
  // stage directions
  assert.equal(humanize("*burp* yeah sure"), "yeah sure");
  assert.equal(humanize("i mean *sighs* whatever"), "i mean whatever");
  // emphasis asterisks are a tell too
  assert.equal(humanize("a *waitlist* to scan your brain"), "a waitlist to scan your brain");
  // and it leaves an ordinary message completely alone
  const plain = "you said dont answer so obviously i have to answer";
  assert.equal(humanize(plain), plain);
});

test("styleFor: most typos are left standing, only some get corrected", () => {
  const rolls = Array.from({ length: 500 }, (_, i) => styleFor({ ...rick, speechStyle: { ...rick.speechStyle, typoRate: 0.5 } }, `g${i}`, 1)[0]);
  const typos = rolls.filter((r) => r.typo);
  const fixed = typos.filter((r) => r.correct);
  assert.ok(typos.length > 150, "typoRate 0.5 should produce plenty of typos");
  assert.ok(fixed.length < typos.length * 0.5, `only ~30% should be corrected, got ${fixed.length}/${typos.length}`);
  assert.ok(fixed.length > 0, "some should still be corrected");
  assert.equal(rolls.filter((r) => r.correct && !r.typo).length, 0, "a correction requires a typo");
});
