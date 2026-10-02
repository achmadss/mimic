import { test } from "node:test";
import assert from "node:assert/strict";
import { typingTimeMs } from "../src/timing.ts";
import { choice, noul, setupIM } from "./helpers.ts";

const LONG = 200_000; // longer than any normal reply delay

test("several quick messages become one turn, one Jev call, one reply", async () => {
  const t = setupIM();
  t.llm.outputs = [{ messages: [{ text: "wait what" }] }];
  t.say("wait");
  await t.tick(1000);
  t.say("i forgot");
  await t.tick(1000);
  t.say("oh yeah my boss quit");
  await t.tick(2500);
  assert.equal(t.jev.calls.length, 1);
  assert.deepEqual(t.jev.calls[0].state.currentTurn, ["wait", "i forgot", "oh yeah my boss quit"]);
  assert.equal(t.store.getConversation(t.convId)!.version, 1);
  await t.tick(LONG);
  assert.deepEqual(t.adapter.sent.map((s) => s.text), ["wait what"]);
  assert.ok(t.store.events(t.convId).some((e) => e.type === "OUTGOING_MESSAGE_SENT"));
});

test("duplicate platform message is ignored (Review Focus 1)", async () => {
  const t = setupIM();
  t.say("hi", "same");
  t.say("hi", "same");
  await t.tick(2500);
  assert.deepEqual(t.jev.calls[0].state.currentTurn, ["hi"]);
});

test("whitespace-only messages are ignored", async () => {
  const t = setupIM();
  t.say("   ");
  await t.tick(LONG);
  assert.equal(t.jev.calls.length, 0);
});

test("max turn window forces a reply while the user keeps typing (Review Focus 2)", async () => {
  const t = setupIM();
  for (let i = 0; i < 10; i++) {
    t.say(`msg ${i}`);
    await t.tick(2000);
  }
  assert.equal(t.jev.calls.length, 1);
  assert.equal(t.jev.calls[0].state.currentTurn.length, 10);
});

async function firstReplyPending(t: ReturnType<typeof setupIM>) {
  t.jev.next = { pace: choice("slow") };
  t.llm.outputs = [{ messages: [{ text: "what happened?" }] }];
  t.say("ugh my pc");
  await t.tick(2500);
  const [m] = t.store.pendingBotMessages(t.convId);
  return m;
}

test("interruption: due send is held while the user types, then cancelled by the turn decision", async () => {
  const t = setupIM();
  const m = await firstReplyPending(t);
  await t.tick(m.dueAt - 1000 - t.clock.now());
  t.say("never mind");
  t.jev.next = { [`pending_${m.id}`]: choice("cancel") };
  t.llm.outputs = [{ messages: [{ text: "oh ok lol" }] }];
  await t.tick(1000); // m comes due while collecting → held
  assert.equal(t.adapter.sent.length, 0);
  await t.tick(1500); // turn ready
  await t.tick(LONG);
  assert.deepEqual(t.adapter.sent.map((s) => s.text), ["oh ok lol"]);
  assert.equal(t.store.getBotMessage(m.id)!.status, "cancelled");
});

test("interruption: 'continue' re-stamps the held message and it is sent before the new reply", async () => {
  const t = setupIM();
  const m = await firstReplyPending(t);
  await t.tick(m.dueAt - 1000 - t.clock.now());
  t.say("lol");
  t.jev.next = { [`pending_${m.id}`]: choice("continue") };
  t.llm.outputs = [{ messages: [{ text: "anyway" }] }];
  await t.tick(2500);
  await t.tick(LONG);
  assert.deepEqual(t.adapter.sent.map((s) => s.text), ["what happened?", "anyway"]);
  assert.equal(t.store.getBotMessage(m.id)!.conversationVersion, 2);
});

test("version gate cancels a message whose version is stale", async () => {
  const t = setupIM();
  const m = await firstReplyPending(t);
  const c = t.store.getConversation(t.convId)!;
  t.store.saveConversation({ ...c, version: c.version + 1 });
  await t.tick(LONG);
  assert.equal(t.adapter.sent.length, 0);
  assert.equal(t.store.getBotMessage(m.id)!.status, "cancelled");
  assert.ok(t.store.events(t.convId).some((e) => e.type === "OUTGOING_MESSAGE_CANCELLED" && e.payload.reason === "stale_version"));
});

test("delivery failure marks the message failed", async () => {
  const t = setupIM();
  const m = await firstReplyPending(t);
  t.adapter.fail = new Error("403 blocked");
  await t.tick(LONG);
  assert.equal(t.store.getBotMessage(m.id)!.status, "failed");
  assert.ok(t.store.events(t.convId).some((e) => e.type === "DELIVERY_FAILED"));
});

test("delayed follow-up fires through the same scheduler", async () => {
  const t = setupIM();
  t.jev.next = { follow_up: noul(0.9), follow_up_after: choice("15m") };
  t.llm.outputs = [{ messages: [{ text: "working" }] }, { messages: [{ text: "done finally" }] }];
  t.say("what are you doing");
  await t.tick(2500);
  await t.tick(LONG);
  t.jev.next = {};
  await t.tick(15 * 60_000);
  await t.tick(LONG);
  assert.equal(t.jev.calls[1].state.trigger, "followup_due");
  assert.deepEqual(t.adapter.sent.map((s) => s.text), ["working", "done finally"]);
});

test("recovery: 'sending' at crash → failed on non-idempotent, resent on idempotent (Review Focus 3)", async () => {
  for (const idempotent of [false, true]) {
    const a = setupIM();
    const m = await firstReplyPending(a);
    a.store.updateBotMessage({ ...m, status: "sending" });
    a.store.deleteAction(m.id);
    const b = setupIM({ store: a.store, start: a.clock.now(), idempotent });
    await b.im.recover();
    await b.tick(0);
    assert.equal(b.store.getBotMessage(m.id)!.status, idempotent ? "sent" : "failed");
    assert.equal(b.adapter.sent.length, idempotent ? 1 : 0);
  }
});

test("recovery: a send stranded with no action row is re-armed, not lost", async () => {
  const a = setupIM();
  const m = await firstReplyPending(a);
  a.store.deleteAction(m.id); // onSendDue dropped it while the turn was collecting, then the handler died
  const b = setupIM({ store: a.store, start: a.clock.now(), idempotent: true });
  await b.im.recover();
  assert.equal(b.store.getAction(m.id)?.kind, "send_message");
  await b.tick(m.dueAt - b.clock.now() + 1000);
  assert.equal(b.store.getBotMessage(m.id)!.status, "sent");
  assert.deepEqual(b.adapter.sent.map((s) => s.text), ["what happened?"]);
});

test("recovery: a stranded send whose version moved on is cancelled, not sent", async () => {
  const a = setupIM();
  const m = await firstReplyPending(a);
  a.store.deleteAction(m.id);
  const c = a.store.getConversation(a.convId)!;
  a.store.saveConversation({ ...c, version: c.version + 1 }); // the turn's reply was generated, then lost
  const b = setupIM({ store: a.store, start: a.clock.now(), idempotent: true });
  await b.im.recover();
  assert.equal(b.store.getBotMessage(m.id)!.status, "cancelled");
  assert.ok(b.store.events(b.convId).some((e) => e.type === "OUTGOING_MESSAGE_CANCELLED" && e.payload.reason === "stale_version"));
  await b.tick(LONG);
  assert.equal(b.adapter.sent.length, 0);
});

test("recovery: overdue sends within catch-up fire; older ones are cancelled", async () => {
  const a = setupIM();
  const m = await firstReplyPending(a);
  const late = setupIM({ store: a.store, start: m.dueAt + 10 * 60_000 });
  await late.im.recover();
  await late.tick(0);
  assert.equal(late.store.getBotMessage(m.id)!.status, "cancelled");

  const a2 = setupIM();
  const m2 = await firstReplyPending(a2);
  const soon = setupIM({ store: a2.store, start: m2.dueAt + 60_000 });
  await soon.im.recover();
  await soon.tick(0);
  assert.equal(soon.store.getBotMessage(m2.id)!.status, "sent");
});

test("activity change re-decides a queued reply: a character who has gone to sleep drops it", async () => {
  const t = setupIM();
  const m = await firstReplyPending(t);
  t.store.saveCharacterState({ characterId: "rick", activity: "sleeping", activitySince: t.clock.now(), mood: null, moodChangedAt: null });
  const before = t.jev.calls.length;
  t.jev.next = { [`pending_${m.id}`]: choice("cancel") };
  t.im.onActivityChanged("rick");
  await t.im.drain();

  assert.equal(t.jev.calls.length, before + 1);
  const q = t.jev.calls[before].questions;
  assert.ok(!("respond_mode" in q) && !("topic_action" in q) && !("message_count" in q), "an activity change asks nothing about writing a reply");
  assert.ok("pending_" + m.id in q);
  assert.equal(t.jev.calls[before].state.activity, "sleeping");
  assert.equal(t.store.getBotMessage(m.id)!.status, "cancelled");
  assert.equal(t.llm.calls.length, 1, "the LLM must not run again: nothing new is being written");
  await t.tick(LONG);
  assert.deepEqual(t.adapter.sent, []);
});

test("messages left unanswered while asleep get answered on waking, once, and never when already answered", async () => {
  const t = setupIM();
  const awake = (activity: "sleeping" | "idle") =>
    t.store.saveCharacterState({ characterId: "rick", activity, activitySince: t.clock.now(), mood: null, moodChangedAt: null });
  // the server case: `later`, then the follow-up lands while asleep and becomes no_reply
  t.jev.next = { respond_mode: choice("later"), follow_up_after: choice("15m") };
  t.say("u up?");
  await t.tick(2500);
  awake("sleeping");
  t.jev.next = { respond_mode: choice("no_reply") };
  await t.tick(15 * 60_000);
  assert.deepEqual(t.adapter.sent, []);
  const asked = t.jev.calls.length;

  t.im.onActivityChanged("rick"); // still asleep: nothing
  await t.im.drain();
  assert.equal(t.jev.calls.length, asked);

  awake("idle");
  t.jev.next = {};
  t.llm.outputs = [{ messages: [{ text: "sorry was out cold" }] }];
  t.im.onActivityChanged("rick");
  await t.tick(LONG);
  assert.equal(t.jev.calls[asked].state.trigger, "unanswered");
  assert.ok(t.llm.calls.at(-1)!.some((m: any) => /still unanswered/.test(m.content)));
  assert.deepEqual(t.adapter.sent.map((s: any) => s.text), ["sorry was out cold"]);

  t.im.onActivityChanged("rick"); // answered now: nothing more to do
  await t.im.drain();
  assert.equal(t.jev.calls.length, asked + 1);
});

test("waking up replaces a far-off follow-up: a 03:49 'next day' is answered in the morning, not 18 h later", async () => {
  const t = setupIM();
  t.store.saveCharacterState({ characterId: "rick", activity: "sleeping", activitySince: t.clock.now(), mood: null, moodChangedAt: null });
  t.jev.next = { respond_mode: choice("later"), follow_up_after: choice("next_day") };
  t.say("u up?");
  await t.tick(2500);
  assert.ok(t.store.getAction("followup:rick:cli:local"));

  await t.tick(4 * 3_600_000); // morning
  t.store.saveCharacterState({ characterId: "rick", activity: "idle", activitySince: t.clock.now(), mood: null, moodChangedAt: null });
  t.jev.next = {};
  t.llm.outputs = [{ messages: [{ text: "just woke up" }] }];
  t.im.onActivityChanged("rick");
  await t.tick(LONG);
  assert.deepEqual(t.adapter.sent.map((s: any) => s.text), ["just woke up"]);
  assert.equal(t.store.getAction("followup:rick:cli:local"), undefined, "the 18 h follow-up is gone, so no second message tomorrow");
});

test("activity change with nothing queued does not call Jev at all", async () => {
  const t = setupIM();
  t.store.getOrCreateConversation("rick", "cli", "local");
  t.im.onActivityChanged("rick");
  await t.im.drain();
  assert.equal(t.jev.calls.length, 0);
});

test("Jev unavailable during an activity change cancels the queued reply rather than sending it", async () => {
  const t = setupIM();
  const m = await firstReplyPending(t);
  t.store.saveCharacterState({ characterId: "rick", activity: "sleeping", activitySince: t.clock.now(), mood: null, moodChangedAt: null });
  t.jev.next = new Error("jev is down");
  t.im.onActivityChanged("rick");
  await t.im.drain();
  assert.equal(t.store.getBotMessage(m.id)!.status, "cancelled");
  await t.tick(LONG);
  assert.deepEqual(t.adapter.sent, []);
});

test("typing opens inside the message's own window and closes when it goes out", async () => {
  const t = setupIM();
  t.jev.next = { pace: choice("slow") };
  t.llm.outputs = [{ messages: [{ text: "on my way" }] }];
  t.say("you coming?");
  await t.tick(2500);
  const [m] = t.store.pendingBotMessages(t.convId);
  const opensAt = m.dueAt - typingTimeMs(m.text);

  assert.deepEqual(t.adapter.typed, [], "does not type for a message that is a minute away");
  await t.tick(opensAt - t.clock.now() + 1);
  assert.ok(t.adapter.typed.length > 0, "types once the window opens");

  await t.tick(LONG);
  assert.equal(t.store.getBotMessage(m.id)!.status, "sent");
  const afterSend = t.adapter.typed.length;
  await t.tick(LONG);
  assert.equal(t.adapter.typed.length, afterSend, "stops typing once the message is delivered");
});

test("typing follows a cancelled message and stops with it", async () => {
  const t = setupIM();
  const m = await firstReplyPending(t);
  const opensAt = m.dueAt - typingTimeMs(m.text);
  await t.tick(opensAt - t.clock.now() + 1);
  assert.ok(t.adapter.typed.length > 0);
  t.store.updateBotMessage({ ...t.store.getBotMessage(m.id)!, status: "cancelled" });
  const typed = t.adapter.typed.length;
  await t.tick(LONG);
  assert.equal(t.adapter.typed.length, typed);
});

test("a process leaves alone conversations on platforms it is not running", async () => {
  const { InteractionManager } = await import("../src/im/manager.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { loadProfiles } = await import("../src/character/profile.ts");
  const t = setupIM();
  const tg = t.store.getOrCreateConversation("rick", "telegram", "42").conversationId;
  t.store.putAction({ id: `followup:${tg}`, conversationId: tg, kind: "delayed_followup", dueAt: t.clock.now() - 1000 });
  // the CLI process: only a cli adapter, like `npm run cli` against the live database
  const cliOnly = new InteractionManager(
    { store: t.store, clock: t.clock, ai: () => ({ jev: t.jev, llm: t.llm }), profiles: loadProfiles("characters"), config: DEFAULT_CONFIG, log: () => {} },
    (_c, platform) => {
      if (platform !== "cli") throw new Error(`no adapter for ${platform}`);
      return t.adapter;
    },
  );
  await cliOnly.recover();
  t.clock.advance(LONG);
  await cliOnly.drain();
  assert.equal(t.jev.calls.length, 0, "the Telegram follow-up was not fired");
  assert.ok(t.store.getAction(`followup:${tg}`), "and is still there for the Telegram process");
});

test("a platform that starts after boot adopts its timers; one that stops releases them", async () => {
  const { InteractionManager } = await import("../src/im/manager.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const { loadProfiles } = await import("../src/character/profile.ts");
  const t = setupIM();
  const tg = t.store.getOrCreateConversation("rick", "telegram", "42").conversationId;
  t.store.putAction({ id: `followup:${tg}`, conversationId: tg, kind: "delayed_followup", dueAt: t.clock.now() + 60_000 });
  const live = new Set<string>();
  const im = new InteractionManager(
    { store: t.store, clock: t.clock, ai: () => ({ jev: t.jev, llm: t.llm }), profiles: loadProfiles("characters"), config: DEFAULT_CONFIG, log: () => {} },
    (_c, platform) => {
      if (!live.has(platform)) throw new Error("offline");
      return t.adapter;
    },
  );
  await im.recover();

  live.add("telegram"); // a token was added in the dashboard
  await im.adopt("rick", "telegram");
  live.delete("telegram"); // and removed again before the follow-up came due
  im.release("rick", "telegram");
  t.clock.advance(LONG);
  await im.drain();
  assert.equal(t.jev.calls.length, 0, "released: the timer does not fire into a missing adapter");
  assert.ok(t.store.getAction(`followup:${tg}`), "the row is kept for whoever adopts it next");

  live.add("telegram");
  await im.adopt("rick", "telegram");
  t.clock.advance(1);
  await im.drain();
  assert.equal(t.jev.calls.length, 1, "adopted: the overdue follow-up fires");
});
