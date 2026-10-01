# 03 — Events, Scheduling, Concurrency, Failure

## 1. Event model

An event-driven design is justified, but only the **in-process, log-backed**
kind. No external broker in the MVP. The event log doubles as memory input,
and debug/audit trail.

### Minimum event set

| Event | Emitted by | Meaning |
|---|---|---|
| `USER_MESSAGE_RECEIVED` | Ingester | raw inbound message appended |
| `USER_TURN_READY` | Turn buffer / debounce | user has (probably) finished |
| `BEHAVIOR_DECISION_CREATED` | Interaction Mgr | Jev returned a decision |
| `LLM_RESPONSE_GENERATED` | Interaction Mgr | structured messages received |
| `LLM_GENERATION_FAILED` | Interaction Mgr | LLM gave up after retries |
| `OUTGOING_MESSAGE_SCHEDULED` | Interaction Mgr | message placed on the Scheduler |
| `OUTGOING_MESSAGE_CANCELLED` | Interaction Mgr | message removed / voided |
| `OUTGOING_MESSAGE_SENT` | Delivery adapter | bytes delivered |
| `ACTIVITY_CHANGED` | Routine Engine / event | character activity changed |
| `ATTENTION_CHANGED` | Interaction Mgr | attention raised/decayed |
| `TOPIC_CHANGED` | Interaction Mgr (per Jev) | active topic switched |
| `TIMER_EXPIRED` | Scheduler | a scheduled action came due |
| `DELIVERY_FAILED` | Delivery adapter | send error, retry or drop |

Events dropped from the `DOC.md` long list because they are derivable or
redundant:

- `LLM_GENERATION_STARTED` — not needed for behavior; add only for tracing.
- `CONVERSATION_VERSION_BUMPED` — redundant: every bump is exactly one
  `USER_TURN_READY`.
- `JEV_DECISION_CREATED` → renamed `BEHAVIOR_DECISION_CREATED`; one event.
- `CONVERSATION_INTERRUPTED` — not a first-class state; interruption is the
  *input* (a user message during pending work), recorded as
  `USER_MESSAGE_RECEIVED` + a cancellation/modification event.

Every event is appended to the Event Log in the **same SQLite transaction** as
the state change it causes (and any scheduled-action rows). A crash leaves
either both or neither. On restart, state is read straight from the tables; the
log is never replayed to rebuild it.

## 2. Scheduler

One durable delay queue per deployment, partitioned by conversation. Each entry
is a `ScheduledAction` with a `dueAt`. This table *is* the pending action queue;
there is no separate queue component to keep in sync.

API:

```ts
interface Scheduler {
  schedule(action: ScheduledAction, dueAt: number): string  // returns actionId
  cancel(actionId: string): void
  reschedule(actionId: string, dueAt: number): void
  onExpired(cb: (actionId: string) => void): void
}
```

Rules:

- On fire, the scheduler does **not** send anything. It emits `TIMER_EXPIRED`
  into the Interaction Manager, which re-validates and decides.
- On restart, pending actions are re-armed from persistence. Actions whose
  `dueAt` already passed while down are handled by a **catch-up policy**
  (see §6).
- Fires in near-identical times are staggered to preserve `order`.

### Timing ownership (who decides vs who executes)

```
Jev:    pace Choice → "slow"                              // category only
System: [lo, hi] = paceRange("slow") × activity multiplier  // §8 table
System: dueAt = now + seededUniform(lo, hi) + typingTime(text)
System: schedules the timer and owns the clock
```

Jev chooses a **category**, never a number or timestamp. The
System converts it using character profile (base pace), activity (speedup or
slowdown), message length (typing time), and seeded jitter.

Timing inputs, in order of influence:

1. Jev pace category — primary.
2. Activity speed multiplier — derived.
3. Character base pace — profile.
4. Message length → typing time — computed.
5. Previous message timing — spacing within a burst.
6. Bounded random jitter — seeded from `hash(characterId, actionId)`, so a
   given action always gets the same jitter (reproducible in tests) while
   different actions vary.
7. Time of day — routine slot modifier.

## 3. Message lifecycle

```
generated → planned → scheduled → ready → sending → sent
                │          │         │
                └──────────┴─────────┴──► cancelled
                                          sending ─► failed
```

- **generated** — LLM returned the fragment; not yet validated.
- **planned** — passed validation; part of a burst; no timer yet.
- **scheduled** — placed on the Scheduler with a `dueAt`.
- **ready** — dueAt reached, version re-checked, awaiting delivery.
- **sending** — handed to the delivery adapter.
- **sent** — delivery acknowledged.
- **cancelled** — voided before `sending`.
- **failed** — delivery error after `sending`.

**Cancellation window.** Allowed in `planned`, `scheduled`, `ready`. Once
`sending` starts, cancellation is refused; the message is already leaving the
system. No time-based window is needed: the Interaction Manager is serial, so
the `ready → sending` transition and any cancel can never interleave. This is
the concrete answer to `DOC.md` §17.

## 4. Concurrency and race conditions

The brief warns about: LLM generating + user sends another message + activity
changes + a scheduled message becomes due.

### The single fix: serialize per conversation

The Interaction Manager processes one event at a time per conversation. This
turns concurrency problems into ordering problems, which the event log already
records. No locks, no optimistic retries for state.

```
Conversation A queue:  [USER_MESSAGE] [TIMER_EXPIRED] [ACTIVITY_CHANGED] ...
                          handled fully, one by one
Conversation B queue:  runs in parallel, fully isolated
```

### Stale responses: one counter

`conversationVersion` increments on exactly one event: `USER_TURN_READY`.

A topic change does not bump it. Topics only change through a turn's
`BehaviorDecision`, and that turn has already bumped the version, so a second
bump would invalidate nothing new.

Every generated message records the version it was built from. Before sending,
the System compares:

```
if (message.conversationVersion !== state.version) → cancel, do not send
```

The gate does not replan. The turn that bumped the version already gets its own
`BehaviorDecision`, and replanning here too would produce a double reply.

This handles "what happened?" → "never mind" exactly: the user turn bumps the
version, the turn's decision cancels "what happened?" (or the gate catches it),
and the new decision answers "never mind".

Messages that Jev explicitly keeps (`continue` / `delay`, see §5) are
re-stamped with the new version. The gate therefore voids only what nobody
re-approved.

**We intentionally do NOT add** `stateVersion`, `contextVersion`, or a separate
`scheduledMessageId`. We keep:

- `conversationVersion` — invalidation (semantic).
- `generationId` — burst grouping (operational, to cancel a whole batch).
- `actionId` — scheduler identity (operational). For a send, it is the
  `ScheduledMessage.id`.

That is three IDs, each with one job. `DOC.md` §12 warns against introducing
all of them; we justify these three and reject the rest.

### Concurrent LLM generations

Because the queue is serial, at most one generation is active per conversation.
If a new user turn becomes ready while a generation is in flight, the event
waits in the queue. When it is processed, the version check voids stale output.
Optional optimization for later: cancel the in-flight HTTP request via an
`AbortController` keyed by `generationId` — not needed for correctness.

## 5. Interruptions (user messages during pending bot messages)

When `USER_MESSAGE_RECEIVED` arrives while scheduled messages exist, the
Interaction Manager:

1. Appends the user message and extends the turn buffer (re-arms the quiet
   timer).
2. Holds pending sends while the buffer is `collecting`. A send that comes due
   is rescheduled until after the turn is ready. This is deterministic and
   needs no Jev call.
3. On `USER_TURN_READY`, bumps the version and makes the turn's **one**
   `BehaviorDecision` call. The pending messages are part of the Jev input, and
   the decision covers each of them:

```json
{
  "respondMode": "now",
  "pendingActions": [
    { "messageId": "msg_1", "action": "cancel" },
    { "messageId": "msg_2", "action": "cancel" }
  ]
}
```

4. Applies the result. Kept messages (`continue` / `delay`) are re-stamped with
   the new version; everything else is cancelled.

Possible outcomes map to the brief exactly:

| Outcome | System action |
|---|---|
| `continue` | re-stamp version; leave scheduled |
| `cancel` | cancel the message |
| `delay` | re-stamp version; reschedule with a new `dueAt` |
| `replace` | cancel; the new response replaces it |
| (new response) | normal generation path |

The decision is per message, but it all happens in **one** Jev call for the
whole turn. It is never a separate call per message.

## 6. Failure handling

| Failure | Behavior |
|---|---|
| **Jev unavailable** | Fall back to deterministic defaults: respond now, `pace = normal`, 1 message, no topic change, **cancel all pending messages** (a stale reply is worse than a missing one). Engine stays alive. |
| **LLM unavailable** | Retry with backoff (bounded). On final failure, do not send malformed text; either send a short deterministic fallback (`"hmm"`, `"one sec"`) or stay silent per behavior config, and record `LLM_GENERATION_FAILED`. |
| **Scheduler failure / restart** | Load state and scheduled-action rows, re-arm timers. Catch-up policy: actions overdue by less than the catch-up window fire immediately in `order`; older sends are cancelled, and older follow-ups/routine actions fire once. |
| **Delivery failure** | Retry only on unambiguous errors (e.g. 429 with `retry_after`, 5xx before the request was accepted). On an ambiguous failure (timeout), Discord retries with `nonce` = `messageId` + `enforce_nonce`, which dedupes. Telegram has no idempotency, so it does **not** retry: the message is marked `failed`, and a missing message beats a duplicate. Messages found in `sending` after a crash follow the same rule. |
| **User message during generation** | Queued serially. The finished output is scheduled at the old version; the next turn's decision keeps/cancels it and the version gate voids anything not kept. |
| **Activity change while response pending** | Recompute timing; if the new activity is "sleeping", Jev may cancel/delay. Reply text is unaffected unless the version changed. |
| **Context retrieval fails** | Degrade to immediate context (recent messages + current turn). Never block the reply on optional context. |
| **Jev context planning fails** | Use deterministic default horizon (`recent`). |

Guiding rule: **the system must always be able to produce a reasonable reply
from immediate context alone.**

## 7. Restart and recovery sequence

```
boot
  → load state tables and scheduled-action rows
  → messages still in `sending`: apply the delivery-failure rule above
  → re-arm Scheduler timers
  → for each overdue action: apply catch-up policy
  → resume serial queues and routine engine
```

Because state and its event are committed together, recovery is: load,
reconcile `sending`, re-arm. No replay, no distributed consensus.

## 8. Starting values (config, tune by feel)

| Knob | Start |
|---|---|
| Turn quiet window | 2.5 s after the last user message |
| Max turn window | 20 s after `firstAt` |
| Pace → base delay | instant 0–1 s · fast 1–4 s · normal 4–15 s · slow 15–60 s · very_slow 1–2 min |
| Typing time | ~6 chars/s (≈ 70 wpm), capped at 8 s per message |
| Gap within a burst | 0.8–3 s + typing time of the next fragment |
| Max normal reply delay | 2 min (follow-ups and routine actions exempt) |
| Max messages per reply | 5 (+ correction fragments) |
| Catch-up window | 5 min |
| Rate limit | ≤ 1 generated reply per user turn; ≤ 30 sends/min per bot |
| Jev choice margin | 1.2 x the 1/k uniform baseline for a k-way question |
| Jev score confidence | 0.4 (an `importance` score has no option count to normalise against) |
| Jev Noul threshold | 0.7 |
| Jev follow-up threshold | 0.6 — `follow_up` is scored lower than the other nouls, so it needs its own |

Notes from live tuning (2026-10-01, 19 real turns):

- **Jev's `confidence` is a margin, not a probability.** It shrinks as a question gains options:
  a 3-way choice tops out around 0.35 while its winner is 0.4–0.7 likely. Gating on it made every
  `message_count` answer take the fallback — which is the option Jev rated *least* likely. Gate on
  `probabilities[chosen]` instead, and gate it *relative to chance*: an absolute bar cannot serve
  questions of different widths, since 0.4 is a clear lead among 3 options but barely above chance
  among 5. A flat distribution still falls back; a real preference is honoured at any width.
- **Where a character's own rhythm lives.** `speechStyle.maxCharsPerMessage` is the ceiling for one
  message (Rick 150, Morty 230) and `correctionRate` is how often they fix a typo they made; Jev
  picks a `message_length` class per turn (terse/short/normal/long) that scales a fraction of it.
- **`follow_up` runs lower than `ask_question`** on the same 0–1 scale — over 20 turns, median 0.49
  against 0.61, and a lower ceiling (0.70 against 0.78). At a shared 0.7 cutoff the unprompted
  follow-up fired on 1 turn in 20; the two questions now have separate thresholds.
- **`importance` is a 0–3 score**, so `score / 3` maps it to 0..1 and the `≥ 2` bar means
  "important to the user" or above.
- **Latency** from user message to first reply measured p50 14.4 s. Long single messages dominate it
  (generation time), which is why splitting a reply into 2–3 messages makes the bot feel faster.
