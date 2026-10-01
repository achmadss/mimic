import { test } from "node:test";
import assert from "node:assert/strict";
import { ProfileSchema, loadProfiles } from "../src/character/profile.ts";
import { attentionNow, availability, formatLocalTime, interruptibility, speedMultiplier } from "../src/character/derived.ts";

const profiles = loadProfiles("characters");
const rick = profiles.get("rick")!;

test("both shipped profiles load", () => {
  assert.deepEqual([...profiles.keys()].sort(), ["morty", "rick"]);
});

test("profile validation rejects a bad timezone and a missing activity baseline", () => {
  assert.equal(ProfileSchema.safeParse({ ...rick, timezone: "Mars/Olympus" }).success, false);
  const { sleeping: _drop, ...partial } = rick.activityBaselines;
  assert.equal(ProfileSchema.safeParse({ ...rick, activityBaselines: partial }).success, false);
});

test("availability mapping", () => {
  assert.equal(availability("idle"), "available");
  assert.equal(availability("working"), "busy");
  assert.equal(availability("commuting"), "away");
  assert.equal(availability("sleeping"), "sleeping");
});

test("attention decays from a raise toward the activity baseline (10 min half-life)", () => {
  const t = 1_000_000;
  assert.equal(attentionNow({ attention: null, attentionRaisedAt: null }, rick, "idle", t), 0.6);
  assert.equal(attentionNow({ attention: 1, attentionRaisedAt: t }, rick, "idle", t), 1);
  assert.ok(Math.abs(attentionNow({ attention: 1, attentionRaisedAt: t }, rick, "idle", t + 600_000) - 0.8) < 1e-9);
});

test("interruptibility and speed react to attention", () => {
  assert.equal(interruptibility("working", 0.2), 0.4);
  assert.equal(interruptibility("working", 0.9), 0.9);
  assert.equal(speedMultiplier(rick, "working", 0.2), 2.5);
  assert.equal(speedMultiplier(rick, "working", 0.9), 1);
});

test("local time is rendered in the character timezone", () => {
  assert.equal(formatLocalTime(Date.UTC(2026, 0, 1, 12, 0, 0), "America/Los_Angeles"), "Thu 04:00");
});
