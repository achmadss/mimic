import assert from "node:assert/strict";
import { test } from "node:test";
import { loadProfiles } from "../src/character/profile.ts";
import { applyLowercase, styleFor } from "../src/character/style.ts";
import { buildPrompt } from "../src/llm/prompt.ts";
import { decide } from "../src/jev/decide.ts";

const rick = loadProfiles("characters").get("rick")!;
const decision = { ...decide(null, { trigger: "user_turn", pendingIds: [], basePace: "fast", maxMessages: 3, choiceConfidence: 0.5, noulThreshold: 0.7, followUpThreshold: 0.55 }), messageCount: 2 };
const prompt = (styles: { lowercase: boolean; typo: boolean }[]) =>
  buildPrompt({ profile: rick, decision, trigger: "user_turn", activity: "idle", localTime: "Thu 04:00", topic: null, recent: [], turn: ["sup"], keptPending: [], styles })[0].content;

test("styleFor: deterministic per generation, and a tendency rather than a constant", () => {
  assert.deepEqual(styleFor(rick, "gen-a", 3), styleFor(rick, "gen-a", 3));
  const rolls = Array.from({ length: 300 }, (_, i) => styleFor(rick, `gen-${i}`, 1)[0]);
  const lower = rolls.filter((r) => r.lowercase).length / rolls.length;
  assert.ok(Math.abs(lower - rick.speechStyle.lowercase) < 0.12, `lowercase rate ${lower} should track the 0.8 profile weight`);
  assert.ok(rolls.some((r) => r.typo) && rolls.some((r) => !r.typo), "typoRate 0.05 must be occasional, not every message or never");
});

test("prompt: a rolled typo names the message and asks for its correction", () => {
  assert.match(prompt([{ lowercase: true, typo: false }, { lowercase: true, typo: true }]), /Make message 2 contain one small realistic typo/);
  assert.match(prompt([{ lowercase: true, typo: false }, { lowercase: false, typo: false }]), /Set every "correction" to null/);
});

test("applyLowercase: the System applies the roll, the model cannot opt out", () => {
  assert.equal(applyLowercase("I'll See You Tomorow", { lowercase: true, typo: true }), "i'll see you tomorow");
  assert.equal(applyLowercase("I'll See You Tomorrow", { lowercase: false, typo: false }), "I'll See You Tomorrow");
  assert.equal(applyLowercase("Anything", undefined), "Anything");
});
