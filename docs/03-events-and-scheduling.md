# 03 — Events, Scheduling, Concurrency, Failure

## 1. Event model

An event-driven design is justified, but only the **in-process, log-backed**
kind. No external broker in the MVP. The event log doubles as memory input,
debug trail, and replay source.

### Minimum event set

| Event | Emitted by | Meaning |
|---|---|---|
| `USER_MESSAGE_RECEIVED` | Ingester | raw inbound message appended |
| `USER_TURN_READY` | Turn buffer / debounce | user has (probably) finished |
| `BEHAVIOR_DECISION_CREATED` | Interaction Mgr | Jev returned a decision |
| `LLM_RESPONSE_GENERATED` | Interaction Mgr | structured messages received |
| `OUTGOING_MESSAGE_SCHEDULED` | Interaction Mgr | message placed on the Scheduler |
| `OUTGOING_MESSAGE_CANCELLED` | Interaction Mgr | message removed / voided |
| `OUTGOING_MESSAGE_SENT` | Delivery adapter | bytes delivered |
| `CONVERSATION_VERSION_BUMPED` | Interaction Mgr | topic change / turn ready |
| `ACTIVITY_CHANGED` | Routine Engine / event | character activity changed |
| `ATTENTION_CHANGED` | Interaction Mgr | attention raised/decayed |
| `TOPIC_CHANGED` | Interaction Mgr (per Jev) | active topic switched |
| `TIMER_EXPIRED` | Scheduler | a scheduled action came due |
| `DELIVERY_FAILED` | Delivery adapter | send error, retry or drop |

Events dropped from the `DOC.md` long list because they are derivable or
redundant:

- `LLM_GENERATION_STARTED` — not needed for behavior; add only for tracing.
- `JEV_DECISION_CREATED` → renamed `BEHAVIOR_DECISION_CREATED`; one event.
- `CONVERSATION_INTERRUPTED` — not a first-class state; interruption is the
  *input* (a user message during pending work), recorded as
  `USER_MESSAGE_RECEIVED` + a cancellation/modification event.

Every event is appended to the Event Log **before** it is acted on. This gives
crash-recovery: on restart the log is replayed to rebuild state and re-arm
timers.

## 2. Scheduler

One durable delay queue per deployment, partitioned by conversation. Each entry
is a `ScheduledAction` with a `dueAt`.

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
Jev:    { "pace": "slow", "delayRange": [6000, 12000] }   // category + bound
System: dueAt = now + clamp(jitter(8000), 6000, 12000) + typingTime(text)
System: schedules the timer and owns the clock
```

Jev chooses a **category or bounded range**, never an absolute timestamp. The
System converts it using character profile (base pace), activity (speedup or
slowdown), message length (typing time), and seeded jitter.

Timing inputs, in order of influence:

1. Jev pace category — primary.
2. Activity speed multiplier — derived.
3. Character base pace — profile.
4. Message length → typing time — computed.
5. Previous message timing — spacing within a burst.
6. Bounded random jitter — seeded per character for reproducibility.
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

**Cancellation window.** Allowed in `planned`, `scheduled`, `ready` — up to
`cancellableUntil`, which is set slightly before `dueAt`. Once `sending` starts,
cancellation is refused; the message is already leaving the system. This is the
concrete answer to `DOC.md` §17.

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

`conversationVersion` increments when:

- a user turn becomes ready (`USER_TURN_READY`), or
- the topic changes (`TOPIC_CHANGED`).

Every generated message records the version it was built from. Before sending,
the System compares:

```
if (message.conversationVersion !== state.version) → do not send; replan
```

This handles "what happened?" → "never mind" exactly: the user message bumps the
version, so the queued "what happened?" is voided and a fresh plan runs.

**We intentionally do NOT add** `stateVersion`, `actionId` for state
comparison, and a separate `generationId` per *decision*. We keep:

- `conversationVersion` — invalidation (semantic).
- `generationId` — burst grouping (operational, to cancel a whole batch).
- `actionId` — scheduler identity (operational).

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

1. Appends the user message, extends the turn buffer.
2. Bumps/awaits version per turn rules.
3. Asks Jev **once** for a combined decision over the pending messages:

```json
{
  "pending": [
    { "messageId": "msg_1", "text": "what happened?" },
    { "messageId": "msg_2", "text": "lol" }
  ],
  "action": "replace",
  "keep": [],
  "cancel": ["msg_1", "msg_2"],
  "respond": true
}
```

Possible outcomes map to the brief exactly:

| Outcome | System action |
|---|---|
| `continue` | leave pending messages scheduled |
| `cancel` | cancel the listed messages |
| `delay` | reschedule listed messages with a new `dueAt` |
| `replace` | cancel + generate a new response |
| (new response) | normal generation path |

Jev decides **once** for the batch, not once per message, unless the user
explicitly asks to reconsider a specific one.

## 6. Failure handling

| Failure | Behavior |
|---|---|
| **Jev unavailable** | Fall back to deterministic defaults: respond, `pace = normal`, 1 message, no topic change, no cancellation. Engine stays alive. |
| **LLM unavailable** | Retry with backoff (bounded). On final failure, do not send malformed text; either send a short deterministic fallback (`"hmm"`, `"one sec"`) or stay silent per behavior config, and record `DELIVERY_FAILED`/generation failure. |
| **Scheduler failure / restart** | Replay the event log, rebuild state, re-arm pending actions. Catch-up policy: actions overdue by less than the catch-up window fire immediately in `order`; older ones are dropped or converted to a follow-up, per config. |
| **Delivery failure** | Retry with idempotency key = `messageId`. On repeated failure, mark `failed`, surface, and do not duplicate on next replay. |
| **User message during generation** | Queued serially; version bump voids stale output; replan. |
| **Activity change while response pending** | Recompute timing; if the new activity is "sleeping", Jev may cancel/delay. Reply text is unaffected unless the version changed. |
| **Context retrieval fails** | Degrade to immediate context (recent messages + current turn). Never block the reply on optional context. |
| **Jev context planning fails** | Use deterministic default horizon (`recent` + `recent_topic`). |

Guiding rule: **the system must always be able to produce a reasonable reply
from immediate context alone.**

## 7. Restart and recovery sequence

```
boot
  → load persisted state, pending actions, event log tail
  → for each conversation: re-arm Scheduler entries
  → for each overdue action: apply catch-up policy
  → resume serial queues
  → resume routine engine timers
```

Because every transition was logged before it was acted on, recovery is:
replay, reconcile, re-arm. No distributed consensus required.
