import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProfiles, type CharacterProfile } from "../src/character/profile.ts";
import { activityAt, nextTransitionAt, slotBoundaries } from "../src/character/routine.ts";
import { ACTIVITIES } from "../src/types.ts";

const rick = loadProfiles("characters").get("rick")!;

/** HH:MM on 2026-05-14 (+ `day` days), America/Los_Angeles — PDT, so UTC-7. */
const at = (hhmm: string, day = 0) => Date.parse(`2026-05-${14 + day}T${hhmm}:00-07:00`);

/** Rick's day without jitter, so the slot under test is exact. */
const fixed = (routine: CharacterProfile["routine"]): CharacterProfile => ({ ...rick, routine });
const nap = fixed([
  { start: "07:00", activity: "idle", jitterMin: 0 },
  { start: "20:00", activity: "sleeping", jitterMin: 0 },
]);

test("activityAt is a function of the clock, not of history", () => {
  assert.equal(activityAt(nap, at("06:59")).activity, "sleeping"); // yesterday's 20:00 is still running
  assert.equal(activityAt(nap, at("07:00")).activity, "idle");
  assert.equal(activityAt(nap, at("12:00")).activity, "idle");
  assert.equal(activityAt(nap, at("20:00")).activity, "sleeping");
  assert.equal(activityAt(nap, at("03:00")).activity, "sleeping");
});

test("a slot reports when it started, across the midnight wrap", () => {
  assert.equal(activityAt(nap, at("12:00")).since, at("07:00"));
  assert.equal(activityAt(nap, at("03:00")).since, at("20:00", -1));
});

test("jitter is seeded per character per day: stable within a day, different across days and characters", () => {
  const one: CharacterProfile = { ...rick, routine: [{ start: "07:00", activity: "idle", jitterMin: 45 }] };
  const a = slotBoundaries(one, at("12:00"))[0];
  assert.deepEqual(slotBoundaries(one, at("18:00")), slotBoundaries(one, at("12:00")));
  const b = slotBoundaries(one, at("12:00", 1))[0];
  assert.notEqual(a, b);
  assert.notEqual(slotBoundaries({ ...one, characterId: "nadia" }, at("12:00"))[0], a);
  assert.ok(Math.abs(a - at("07:00")) <= 45 * 60_000);
  assert.ok(Math.abs(b - at("07:00", 1)) <= 45 * 60_000);
});

test("nextTransitionAt is the next boundary strictly after now, and always in the future", () => {
  assert.equal(nextTransitionAt(nap, at("12:00")), at("20:00"));
  assert.equal(nextTransitionAt(nap, at("20:00")), at("07:00", 1)); // strictly after, so not itself
  assert.equal(nextTransitionAt(nap, at("21:00")), at("07:00", 1));
});

test("routine respects the character timezone across DST", () => {
  const local = (t: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(t);
  for (const [day, offset] of [
    ["2026-03-07", "-08:00"], // PST
    ["2026-03-08", "-07:00"], // spring forward
    ["2026-11-01", "-08:00"], // fall back
  ]) {
    const noon = Date.parse(`${day}T12:00:00${offset}`);
    const slot = activityAt(nap, noon);
    assert.equal(slot.activity, "idle");
    assert.equal(local(slot.since), "07:00");
  }
});

test("every shipped character resolves at every hour, with a future transition", () => {
  for (const p of loadProfiles("characters").values()) {
    for (let h = 0; h < 24; h++) {
      const t = Date.parse(`2026-05-14T${String(h).padStart(2, "0")}:30:00-07:00`);
      assert.ok(ACTIVITIES.includes(activityAt(p, t).activity), `${p.characterId} @${h}:30`);
      assert.ok(nextTransitionAt(p, t) > t, `${p.characterId} @${h}:30`);
    }
  }
});
