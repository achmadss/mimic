import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/clock.ts";
import { openDb } from "../src/db.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";
import type { ActionRow } from "../src/types.ts";

function setup(start = 0) {
  const store = new Store(openDb(":memory:"));
  const clock = new FakeClock(start);
  const fired: ActionRow[] = [];
  const s = new Scheduler(store, clock, (r) => fired.push(r));
  return { store, clock, fired, s };
}

test("persists and fires at dueAt", () => {
  const { store, clock, fired, s } = setup();
  s.schedule({ id: "a", conversationId: "c", kind: "send_message", dueAt: 100 });
  assert.equal(store.getAction("a")!.dueAt, 100);
  clock.advance(99);
  assert.equal(fired.length, 0);
  clock.advance(1);
  assert.deepEqual(fired.map((r) => r.id), ["a"]);
  assert.deepEqual(store.events("c").map((e) => e.type), ["TIMER_EXPIRED"]);
});

test("cancel removes the row and the timer", () => {
  const { store, clock, fired, s } = setup();
  s.schedule({ id: "a", conversationId: "c", kind: "send_message", dueAt: 100 });
  s.cancel("a");
  clock.advance(1000);
  assert.equal(fired.length, 0);
  assert.equal(store.getAction("a"), undefined);
});

test("scheduling the same id again replaces the old timer", () => {
  const { clock, fired, s } = setup();
  s.schedule({ id: "a", conversationId: "c", kind: "turn_quiet", dueAt: 100 });
  s.schedule({ id: "a", conversationId: "c", kind: "turn_quiet", dueAt: 300 });
  clock.advance(200);
  assert.equal(fired.length, 0);
  clock.advance(100);
  assert.deepEqual(fired.map((r) => r.dueAt), [300]);
});

test("armAll after restart fires overdue rows in dueAt order", () => {
  const { store } = setup();
  store.putAction({ id: "late", conversationId: "c", kind: "send_message", dueAt: 50 });
  store.putAction({ id: "early", conversationId: "c", kind: "send_message", dueAt: 10 });
  store.putAction({ id: "future", conversationId: "c", kind: "send_message", dueAt: 5000 });
  const clock = new FakeClock(1000);
  const fired: string[] = [];
  new Scheduler(store, clock, (r) => fired.push(r.id)).armAll();
  clock.advance(0);
  assert.deepEqual(fired, ["early", "late"]);
  clock.advance(4000);
  assert.deepEqual(fired, ["early", "late", "future"]);
});
