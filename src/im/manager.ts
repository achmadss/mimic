import type { DeliveryLookup, IncomingText } from "../delivery/types.ts";
import { Scheduler } from "../scheduler.ts";
import { typingTimeMs } from "../timing.ts";
import type { ActionRow, BotMessage, ConversationState, Platform } from "../types.ts";
import { COMMANDS, runCommand, type CommandName } from "./commands.ts";
import { respond, type Deps } from "./respond.ts";

/** One serial queue per conversation; the only writer of conversation state. */
export class InteractionManager {
  readonly scheduler: Scheduler;
  private readonly deps: Deps;
  private queues = new Map<string, Promise<void>>();
  private inFlight = new Set<Promise<void>>();
  private typing = new Map<string, unknown>();

  constructor(base: Omit<Deps, "scheduler">, private readonly delivery: DeliveryLookup) {
    this.scheduler = new Scheduler(base.store, base.clock, (row) => this.enqueue(row.conversationId, () => this.onTimer(row)));
    this.deps = { ...base, scheduler: this.scheduler };
  }

  receive(characterId: string, platform: Platform, m: IncomingText) {
    const conv = this.deps.store.getOrCreateConversation(characterId, platform, m.chatId);
    if (m.command !== undefined) {
      this.enqueue(conv.conversationId, () => this.onCommand(conv.conversationId, characterId, platform, m));
      return;
    }
    const text = m.text.trim();
    if (!text) return;
    this.enqueue(conv.conversationId, () => this.onUserMessage(conv.conversationId, m.platformMessageId, text));
  }

  /** Resolves when every queued job (including ones they enqueue) has finished. */
  async drain() {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  /** Boot: settle messages stuck in `sending`, drop sends overdue past catch-up, arm timers. */
  async recover() {
    const { store, clock, config } = this.deps;
    const now = clock.now();
    // through the queue, not beside it: a resend must not interleave with messages already arriving
    for (const msg of store.botMessagesWithStatus("sending")) {
      await this.enqueue(msg.conversationId, () => this.settleSending(msg));
    }
    store.tx(() => {
      // held sends whose turn's handler died: their action row is gone, so nothing would ever re-arm them
      for (const msg of store.scheduledBotMessagesWithoutAction()) {
        const conv = store.getConversation(msg.conversationId);
        const reason = !conv || msg.conversationVersion !== conv.version ? "stale_version" : msg.dueAt < now - config.catchUpMs ? "overdue_at_restart" : null;
        if (reason) {
          store.updateBotMessage({ ...msg, status: "cancelled" });
          store.appendEvent(msg.conversationId, now, "OUTGOING_MESSAGE_CANCELLED", { messageId: msg.id, reason });
        } else {
          store.putAction({ id: msg.id, conversationId: msg.conversationId, kind: "send_message", dueAt: msg.dueAt });
        }
      }
    });
    store.tx(() => {
      for (const row of store.allActions()) {
        if (row.kind !== "send_message" || row.dueAt >= now - config.catchUpMs) continue;
        store.deleteAction(row.id);
        const msg = store.getBotMessage(row.id);
        if (!msg) continue;
        store.updateBotMessage({ ...msg, status: "cancelled" });
        store.appendEvent(row.conversationId, now, "OUTGOING_MESSAGE_CANCELLED", { messageId: row.id, reason: "overdue_at_restart" });
      }
    });
    this.scheduler.armAll();
  }

  /**
   * The Routine Engine moved a character. Anything already queued for them was timed against the old
   * activity, so it is re-decided here — one Jev call per conversation that actually has something
   * in flight, and none at all (the common case) when nothing is pending.
   */
  onActivityChanged(characterId: string) {
    for (const conv of this.deps.store.conversationsForCharacter(characterId)) {
      if (!this.deps.store.pendingBotMessages(conv.conversationId).length) continue;
      void this.enqueue(conv.conversationId, () => respond(this.deps, conv.conversationId, "activity_changed", null));
    }
  }

  private enqueue(conversationId: string, job: () => Promise<void> | void): Promise<void> {
    const prev = this.queues.get(conversationId) ?? Promise.resolve();
    const next = prev.then(job).catch((e) => this.deps.log(`conversation ${conversationId}: handler failed`, e));
    this.queues.set(conversationId, next);
    this.inFlight.add(next);
    void next.finally(() => {
      this.inFlight.delete(next);
      if (this.queues.get(conversationId) === next) {
        this.queues.delete(conversationId);
        // once the queue is empty, re-derive typing from whatever is left scheduled
        this.syncTyping(conversationId);
      }
    });
    return next;
  }

  /**
   * Typing is a view of the earliest queued message (doc 06 §2.27): it opens at
   * `dueAt − typingTime`, refreshes while the platform's indicator is expiring, and closes when the
   * message goes out or stops being scheduled. Nothing is persisted, because nothing needs recovering
   * — if the process dies mid-typing, the indicator expires on the platform by itself.
   */
  private syncTyping(conversationId: string) {
    const { store, clock } = this.deps;
    this.stopTyping(conversationId);
    const conv = store.getConversation(conversationId);
    const next = store.pendingBotMessages(conversationId)[0];
    if (!conv || !next) return;
    const adapter = this.delivery(conv.characterId, conv.platform);
    if (!adapter.showTyping) return;
    const refresh = adapter.typingRefreshMs ?? 4000;

    const tick = () => {
      // re-read every tick: a message cancelled or rescheduled after this started owns its own indicator
      const cur = store.getBotMessage(next.id);
      const t = clock.now();
      if (!cur || cur.status !== "scheduled" || t >= cur.dueAt) return this.stopTyping(conversationId);
      if (t >= cur.dueAt - typingTimeMs(cur.text)) void adapter.showTyping!(conv.chatId);
      this.typing.set(conversationId, clock.setTimeout(tick, Math.max(250, Math.min(refresh, cur.dueAt - t))));
    };
    this.typing.set(conversationId, clock.setTimeout(tick, Math.max(0, next.dueAt - typingTimeMs(next.text) - clock.now())));
  }

  private stopTyping(conversationId: string) {
    const h = this.typing.get(conversationId);
    if (h !== undefined) this.deps.clock.clearTimeout(h);
    this.typing.delete(conversationId);
  }

  /**
   * Telegram sends `/start` when someone opens the chat; answering it out of character would make a
   * settings menu the first thing they ever see, so it stays silent. Any other unknown command gets
   * the list.
   */
  private async onCommand(conversationId: string, characterId: string, platform: Platform, m: IncomingText) {
    if (m.command === "start") return;
    const name: CommandName = m.command && m.command in COMMANDS ? (m.command as CommandName) : "help";
    const text = runCommand(this.deps, conversationId, name);
    if (name === "reset") this.stopTyping(conversationId);
    try {
      await (m.reply ? m.reply(text) : this.delivery(characterId, platform).send(m.chatId, text, `cmd:${m.platformMessageId}`));
    } catch (e) {
      this.deps.log(`command /${name} reply failed`, e);
    }
  }

  /** A message left `sending` by a crash: resend only where the platform can dedupe it. */
  private async settleSending(msg: BotMessage) {
    const { store, clock } = this.deps;
    const conv = store.getConversation(msg.conversationId)!;
    if (this.delivery(conv.characterId, conv.platform).idempotent) {
      await this.deliver(conv, msg);
    } else {
      store.tx(() => {
        store.updateBotMessage({ ...msg, status: "failed" });
        store.appendEvent(msg.conversationId, clock.now(), "DELIVERY_FAILED", { messageId: msg.id, error: "unconfirmed at restart" });
      });
    }
  }

  private onUserMessage(conversationId: string, platformMessageId: string, text: string) {
    const { store, clock, config } = this.deps;
    const now = clock.now();
    store.tx(() => {
      const id = `${conversationId}:${platformMessageId}`;
      if (!store.insertUserMessage(id, conversationId, text, now)) return; // platform redelivery
      store.appendEvent(conversationId, now, "USER_MESSAGE_RECEIVED", { messageId: id, text });
      store.saveConversation({ ...store.getConversation(conversationId)!, lastUserAt: now });
      const buf = store.getTurnBuffer(conversationId) ?? { conversationId, messageIds: [], texts: [], firstAt: now, lastAt: now };
      buf.messageIds.push(id);
      buf.texts.push(text);
      buf.lastAt = now;
      store.saveTurnBuffer(buf);
      this.scheduler.schedule({
        id: `turn:${conversationId}`,
        conversationId,
        kind: "turn_quiet",
        dueAt: Math.min(now + config.quietMs, buf.firstAt + config.maxTurnMs),
      });
    });
  }

  private async onTimer(fired: ActionRow) {
    const row = this.deps.store.getAction(fired.id);
    if (!row || row.dueAt !== fired.dueAt) return; // cancelled, or re-scheduled after this timer fired
    if (row.kind === "turn_quiet") return this.onTurnReady(row);
    if (row.kind === "send_message") return this.onSendDue(row);
    this.deps.store.deleteAction(row.id);
    return respond(this.deps, row.conversationId, "followup_due", null);
  }

  private async onTurnReady(row: ActionRow) {
    const { store, clock } = this.deps;
    const now = clock.now();
    const turn = store.tx(() => {
      store.deleteAction(row.id);
      const buf = store.getTurnBuffer(row.conversationId);
      if (!buf) return null;
      store.deleteTurnBuffer(row.conversationId);
      const conv = store.getConversation(row.conversationId)!;
      store.saveConversation({ ...conv, version: conv.version + 1 });
      store.appendEvent(row.conversationId, now, "USER_TURN_READY", { messageIds: buf.messageIds, version: conv.version + 1 });
      return buf;
    });
    // ponytail: a crash during this turn's Jev/LLM call drops the reply; add a turn-pending marker if that matters
    if (turn) await respond(this.deps, row.conversationId, "user_turn", { texts: turn.texts, firstAt: turn.firstAt, lastAt: turn.lastAt });
  }

  private async onSendDue(row: ActionRow) {
    const { store, clock } = this.deps;
    const msg = store.getBotMessage(row.id);
    const conv = store.getConversation(row.conversationId)!;
    const go = store.tx(() => {
      store.deleteAction(row.id);
      if (!msg || msg.status !== "scheduled") return false;
      // user is mid-turn: hold; the turn's decision re-schedules or cancels it
      if (store.getTurnBuffer(row.conversationId)) return false;
      if (msg.conversationVersion !== conv.version) {
        store.updateBotMessage({ ...msg, status: "cancelled" });
        store.appendEvent(row.conversationId, clock.now(), "OUTGOING_MESSAGE_CANCELLED", { messageId: msg.id, reason: "stale_version" });
        return false;
      }
      store.updateBotMessage({ ...msg, status: "sending" });
      return true;
    });
    if (go) await this.deliver(conv, msg!);
  }

  // ponytail: no per-bot send rate limit (doc 03 §8 asks for ≤30/min). Telegram absorbs 429s via
  // autoRetry; Discord does not, so a burst across many conversations can 429. Sliding window here is
  // the fix if that ever bites; at two characters and DMs only, it does not.
  private async deliver(conv: ConversationState, msg: BotMessage) {
    const { store, clock } = this.deps;
    try {
      const r = await this.delivery(conv.characterId, conv.platform).send(conv.chatId, msg.text, msg.id);
      const now = clock.now();
      store.tx(() => {
        store.markSent(msg.id, now);
        store.saveConversation({ ...store.getConversation(conv.conversationId)!, lastBotAt: now });
        store.appendEvent(conv.conversationId, now, "OUTGOING_MESSAGE_SENT", { messageId: msg.id, platformMessageId: r.platformMessageId });
      });
    } catch (e) {
      this.deps.log(`delivery failed for ${msg.id}`, e);
      store.tx(() => {
        store.updateBotMessage({ ...msg, status: "failed" });
        store.appendEvent(conv.conversationId, clock.now(), "DELIVERY_FAILED", { messageId: msg.id, error: String(e) });
      });
    }
  }
}
