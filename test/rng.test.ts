import { test } from "node:test";
import assert from "node:assert/strict";
import { seededBetween, seededUnit } from "../src/rng.ts";

test("seededUnit is deterministic, in [0,1), and varies with input", () => {
  assert.equal(seededUnit("a", "b"), seededUnit("a", "b"));
  assert.notEqual(seededUnit("a", "b"), seededUnit("a", "c"));
  for (let i = 0; i < 100; i++) {
    const u = seededUnit(String(i));
    assert.ok(u >= 0 && u < 1);
  }
});

test("seededBetween stays in range", () => {
  for (let i = 0; i < 100; i++) {
    const v = seededBetween(800, 3000, "gap", String(i));
    assert.ok(v >= 800 && v < 3000);
  }
});
