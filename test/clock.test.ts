import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/clock.ts";

test("FakeClock fires due timers in time order and moves now", () => {
  const c = new FakeClock(1000);
  const fired: string[] = [];
  c.setTimeout(() => fired.push(`b@${c.now()}`), 200);
  c.setTimeout(() => fired.push(`a@${c.now()}`), 100);
  c.setTimeout(() => fired.push("late"), 5000);
  c.advance(300);
  assert.deepEqual(fired, ["a@1100", "b@1200"]);
  assert.equal(c.now(), 1300);
  assert.equal(c.pendingTimers(), 1);
});

test("FakeClock: equal due times fire in creation order; negative delay fires on advance(0)", () => {
  const c = new FakeClock(0);
  const fired: number[] = [];
  c.setTimeout(() => fired.push(1), -50);
  c.setTimeout(() => fired.push(2), 0);
  c.advance(0);
  assert.deepEqual(fired, [1, 2]);
});

test("FakeClock clearTimeout cancels", () => {
  const c = new FakeClock(0);
  let hit = false;
  const h = c.setTimeout(() => (hit = true), 10);
  c.clearTimeout(h);
  c.advance(100);
  assert.equal(hit, false);
});
