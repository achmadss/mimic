import { test } from "node:test";
import assert from "node:assert/strict";
import { PACE_RANGE_MS, delayOffset, replyOffsets, typingTimeMs } from "../src/timing.ts";

test("typing time is 6 chars/s capped at 8s", () => {
  assert.equal(typingTimeMs("123456"), 1000);
  assert.equal(typingTimeMs("x".repeat(1000)), 8000);
});

test("reply offsets: first within pace range + typing, strictly increasing, deterministic", () => {
  const texts = ["wait what", "your boss actually quit??", "lmao"];
  const a = replyOffsets({ pace: "fast", speedMultiplier: 1, texts, maxDelayMs: 120_000, seed: "g1" });
  const b = replyOffsets({ pace: "fast", speedMultiplier: 1, texts, maxDelayMs: 120_000, seed: "g1" });
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  const [lo, hi] = PACE_RANGE_MS.fast;
  assert.ok(a[0] >= lo + typingTimeMs(texts[0]) && a[0] <= hi + typingTimeMs(texts[0]));
  assert.ok(a[1] > a[0] + 800 && a[2] > a[1] + 800);
});

test("base delay is multiplied by speedMultiplier and clamped to maxDelayMs", () => {
  const [o] = replyOffsets({ pace: "very_slow", speedMultiplier: 10, texts: ["k"], maxDelayMs: 120_000, seed: "s" });
  assert.ok(o <= 120_000 + typingTimeMs("k"));
});

test("delayOffset stays inside the pace range", () => {
  const d = delayOffset("slow", "m1");
  assert.ok(d >= 15_000 && d <= 60_000);
});
