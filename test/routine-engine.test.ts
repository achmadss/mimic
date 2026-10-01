import { test } from "node:test";
import assert from "node:assert/strict";
import { RoutineEngine, type Transition } from "../src/character/routine-engine.ts";
import { loadProfiles, type CharacterProfile } from "../src/character/profile.ts";
import { FakeClock } from "../src/clock.ts";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";

/** Noon and 21:00 in Los Angeles on 2026-05-14 (PDT). */
const NOON = Date.parse("2026-05-14T19:00:00Z");
const HOUR = 3_600_000;

const profile: CharacterProfile = {
  ...loadProfiles("characters").get("rick")!,
  routine: [
    { start: "07:00", activity: "idle", jitterMin: 0 },
    { start: "20:00", activity: "sleeping", jitterMin: 0 },
  ],
};

function setup(start = NOON, character: CharacterProfile = profile) {
  const store = new Store(openDb(":memory:"));
  const clock = new FakeClock(start);
  const transitions: Transition[] = [];
  const engine = new RoutineEngine({
    store,
    clock,
    profiles: new Map([[character.characterId, character]]),
    onTransition: (t) => transitions.push(t),
    log: () => {},
  });
  return { store, clock, transitions, engine };
}

test("start() lands in the slot running now, and a stale stored activity is corrected", () => {
  const { store, clock, transitions, engine } = setup();
  store.getCharacterState("rick", NOON);
  store.saveCharacterState({ characterId: "rick", activity: "working", activitySince: NOON - 5 * HOUR, mood: null, moodChangedAt: null });
  engine.start();
  const cs = store.getCharacterState("rick", NOON);
  assert.equal(cs.activity, "idle");
  assert.equal(cs.activitySince, Date.parse("2026-05-14T14:00:00Z")); // 07:00 PDT
  assert.deepEqual(transitions, [{ characterId: "rick", from: "working", to: "idle" }]);
  assert.deepEqual(
    store.events("character:rick").map((e) => e.type),
    ["ACTIVITY_CHANGED"],
  );
  engine.stop();
  clock.advance(0);
});

test("crossing a boundary writes the activity, emits once, and re-arms", () => {
  const { store, clock, transitions, engine } = setup();
  engine.start();
  clock.advance(8 * HOUR + 1000); // past 20:00 PDT
  assert.equal(store.getCharacterState("rick", clock.now()).activity, "sleeping");
  assert.deepEqual(transitions, [{ characterId: "rick", from: "idle", to: "sleeping" }]);

  clock.advance(11 * HOUR); // past 07:00 the next morning
  assert.equal(store.getCharacterState("rick", clock.now()).activity, "idle");
  assert.equal(transitions.length, 2);
  assert.deepEqual(
    store.events("character:rick").map((e) => e.payload.to),
    ["sleeping", "idle"],
  );
  engine.stop();
});

test("a slot that runs across a boundary without changing activity emits nothing", () => {
  const sameAllDay: CharacterProfile = {
    ...profile,
    routine: [
      { start: "07:00", activity: "idle", jitterMin: 0 },
      { start: "20:00", activity: "idle", jitterMin: 0 },
    ],
  };
  const { clock, transitions, engine } = setup(NOON, sameAllDay);
  engine.start();
  clock.advance(9 * HOUR);
  assert.deepEqual(transitions, []);
  engine.stop();
});

test("stop() disarms: no timer survives it", () => {
  const { clock, transitions, engine } = setup();
  engine.start();
  assert.ok(clock.pendingTimers() > 0);
  engine.stop();
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(48 * HOUR);
  assert.deepEqual(transitions, []);
});

test("a throw inside a transition is logged, and the engine still re-arms", () => {
  const { store, clock } = setup();
  const logged: string[] = [];
  const engine = new RoutineEngine({
    store,
    clock,
    profiles: new Map([[profile.characterId, profile]]),
    onTransition: () => {
      throw new Error("handler exploded");
    },
    log: (msg) => logged.push(msg),
  });
  engine.start();
  clock.advance(8 * HOUR + 1000); // idle → sleeping: handler throws
  assert.equal(logged.length, 1);
  clock.advance(11 * HOUR); // sleeping → idle: the timer was still re-armed
  assert.equal(store.getCharacterState("rick", clock.now()).activity, "idle");
  engine.stop();
  assert.equal(clock.pendingTimers(), 0);
});
