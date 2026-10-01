import { test } from "node:test";
import assert from "node:assert/strict";
import { moodNow } from "../src/character/mood.ts";

const T = 1_000_000;
const at = (agoMs: number) => ({ mood: "tired" as const, moodChangedAt: T - agoMs });

test("no mood set reads as neutral", () => {
  assert.equal(moodNow({ mood: null, moodChangedAt: null }, T), "neutral");
  assert.equal(moodNow({ mood: "happy", moodChangedAt: null }, T), "neutral"); // half-written row
});

test("a mood lingers, then passes", () => {
  assert.equal(moodNow(at(0), T), "tired");
  assert.equal(moodNow(at(44 * 60_000), T), "tired");
  assert.equal(moodNow(at(45 * 60_000), T), "neutral");
  assert.equal(moodNow(at(10 * 3_600_000), T), "neutral");
});
