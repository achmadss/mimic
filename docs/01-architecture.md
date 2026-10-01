# 01 — Architecture

## 1. Layers

The starting three-layer hypothesis in `DOC.md` is correct, but the boundary
between them must be sharp. Each layer has a single kind of authority.

```
┌──────────────────────────────────────────────────────────────────┐
│                         APPLICATION SYSTEM                         │
│  deterministic · persisted · owns time                             │
│                                                                    │
│  Event Ingester ─► Interaction Manager ─► Conversation State       │
│       │                    │                    │                  │
│       │                    ├──► Turn Buffer     │                  │
│       │                    ├──► Pending Actions │                  │
│       │                    ├──► Scheduler ◄─────┘                  │
│       │                    └──► Context Builder                    │
│       │                                          │                 │
│       └──────────────► Event Log (append-only)   │                 │
│                                                  │                 │
│  Routine Engine ─► Character State ──────────────┘                 │
│  Delivery Adapter ◄── Scheduler                                    │
└───────────────┬───────────────────────────┬──────────────────────┘
                │                           │
         (1) state + candidates        (4) verified messages
                ▼                           │
        ┌───────────────┐                   │
        │      JEV      │                   │
        │ behavior +    │                   │
        │ context plan  │                   │
        └───────┬───────┘                   │
                │ (2) decision + plan       │
                ▼                           │
        ┌───────────────┐                   │
        │      LLM      │                   │
        │ language +    │                   │
        │ message list  │                   │
        └───────┬───────┘                   │
                │ (3) structured messages   │
                └───────────────────────────┘
```

### Application System

Authority: **execution**. Best for anything that must be exact, replayable, or
persisted.

- Timers, delays, monotonic clock.
- Persistent state and the event log.
- Queues: user-turn buffer, pending action queue, per-conversation work queue.
- Scheduling, cancellation mechanics, delivery retries.
- State transitions and validation (message lifecycle, version checks).
- Rate limits, maximum message count, maximum delay, routine boundaries.
- Context retrieval/budgeting (mechanics).
- External platform calls.

### Jev

Authority: **decision**. Best for structured judgement under uncertainty.

- Should I respond now / later / not at all?
- Continue, switch, acknowledge-and-return, ignore, or ask about a topic?
- How fast or slow to pace the reply? How many messages?
- Review pending messages: cancel, continue, delay, or replace.
- Choose a context horizon and relevant context candidates.
- One combined decision per turn, not many tiny calls.

Jev never executes. It returns a decision object. The System validates it
against limits (for example a requested delay outside the allowed range is
clamped).

### LLM

Authority: **language**. Best for wording and nuance.

- Natural response wording and character voice.
- Nuanced interpretation of messy user input.
- Dialogue coherence and storytelling.
- Expressing reactions, emotion, jokes, disagreement.
- Writing self-corrections.
- Producing a list of candidate message fragments.

The LLM never sees the scheduler. It emits a structured message list; the
System decides when and whether each is sent.

### Combined flow

```
incoming message
   ↓ System captures event + bumps version on turn completion
   ↓ Jev returns one BehaviorDecision (+ optional ContextPlan)
   ↓ System builds context, calls LLM
   ↓ LLM returns ordered message fragments
   ↓ System registers ScheduledMessages with the Scheduler
   ↓ (user may interrupt) Interaction Manager asks Jev: cancel/continue/delay/replace
   ↓ System sends or cancels; Event Log records every transition
```

## 2. Shared infrastructure map

`DOC.md` lists many features. Most are the *same* primitive wearing different
names. Build these six primitives once:

| Primitive | Responsibility | Features it serves |
|---|---|---|
| **Event Log** | Append-only, per conversation. Source of truth for replay and debugging. | memory, summaries, topic history, user-behavior modeling, stale detection, audit |
| **Conversation State** | Versioned snapshot of the active exchange. | turn aggregation, topic tracking, momentum, interruptions, unresolved items |
| **Scheduler** | One delay/timer service, persisted, restart-safe. | response delays, multi-message spacing, follow-ups, delayed replies, routine transitions, activity changes, stale checks, cancellation |
| **Pending Action Queue** | Durable list of future actions (send/cancel/replan/activity). | outgoing messages, follow-ups, activity changes, routine events, delayed responses |
| **Interaction Manager** | Single serialized entry point per conversation. | interruptions, topic switch, cancellation, delay, new user messages, stale detection, replanning |
| **Character State Engine** | Derives behavioral values from persisted state. | activity, availability, interruptibility, attention, response speed, mood |

### Why one Scheduler, not many timers scattered

Response delay, multi-message spacing, delayed follow-up, routine transition,
and stale-response checks are all "do X at time T, unless invalidated". They
share the same durable timer table. This removes five ad-hoc timer systems and
gives one recovery path after restart.

### Why one Interaction Manager

Cancellation, interruption, topic switch, and stale responses are all "a new
event arrived while work was in flight". Handling them in one serialized place
avoids duplicated race logic.

## 3. Interaction Manager

This is the heart of the engine. It is a **per-conversation serial actor**: it
processes one event at a time and never runs two handlers concurrently for the
same conversation.

Interface (conceptual):

```ts
type IncomingEvent =
  | { type: "USER_MESSAGE_RECEIVED"; message: UserMessage }
  | { type: "USER_TURN_READY"; turnId: string }
  | { type: "TIMER_EXPIRED"; actionId: string }
  | { type: "ACTIVITY_CHANGED"; activity: Activity }
  | { type: "DELIVERY_RESULT"; messageId: string; ok: boolean }

interface InteractionManager {
  enqueue(conversationId: string, event: IncomingEvent): void
}
```

Responsibilities:

1. **Ingest** the event and append it to the Event Log.
2. **Update** state (turn buffer, character state, conversation version).
3. **Decide**: call Jev when judgement is required; otherwise apply
   deterministic rules.
4. **Act**: enqueue/cancel/modify scheduled actions via the Scheduler.
5. **Emit** events (`OUTGOING_MESSAGE_SCHEDULED`, `TOPIC_CHANGED`, ...).

Boundaries — hard rules:

- The **LLM cannot** call the Scheduler. Only the Interaction Manager does.
- **Jev cannot** execute timers. It only returns a decision.
- The Scheduler **cannot** mutate conversation semantics. It only fires
  `TIMER_EXPIRED`; the Interaction Manager decides what that means.

### Turn detection

Multiple user messages in a row are the same problem as an interruption. The
turn buffer is the shared primitive:

```ts
type TurnBuffer = {
  conversationId: string
  messages: UserMessage[]
  firstAt: number
  lastAt: number
  state: "collecting" | "ready"
}
```

Rule: each new user message extends `lastAt` and resets a short *quiet timer*
(debounce). When the timer expires, the System emits `USER_TURN_READY`. Jev may
also force readiness when a message is clearly complete. This reuses the one
Scheduler.

## 4. Multi-character support

No duplication. All characters run through the same engine. A character is:

```
CharacterProfile   → static: personality, interests, speech style, quirks
CharacterRoutine   → template: daily slots with variation
ActivityTendencies → probabilities: how likely to shift activity, respond, etc.
ExampleConversations → tagged context source
BehaviorConfig     → tuning: base pace, interruptibility weights, message limits
```

State stores are keyed by `characterId` and `conversationId`. The engine code is
character-agnostic; only configuration and the LLM prompt content vary.

## 5. What the System must never do

- Never let the LLM emit an unbounded message list — clamp to a configured
  maximum (MVP: 3).
- Never let a requested delay exceed a configured maximum (MVP: 2 minutes for
  normal replies, routine delays may be longer).
- Never send a message whose `conversationVersion` is stale.
- Never persist derived values that a pure function can recompute cheaply.
- Never generate text when a deterministic stub is equivalent (for example an
  `activity` change does not need an LLM).
