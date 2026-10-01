import { test } from "node:test";
import assert from "node:assert/strict";
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
