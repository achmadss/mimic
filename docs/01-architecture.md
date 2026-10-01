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
│  Delivery Adapter ◄── Interaction Manager                          │
└──────────┬──────────▲───────────────────┬──────────▲─────────────┘
           │          │                   │          │
  (1) state +    (2) typed          (3) context +   (4) structured
   questions      answers            decision        messages
           ▼          │                   ▼          │
        ┌───────────────┐              ┌───────────────┐
        │      JEV      │              │      LLM      │
        │ behavior +    │              │ language +    │
        │ judgements    │              │ message list  │
        └───────────────┘              └───────────────┘
```

Jev and the LLM never talk to each other directly. The System calls each one
and validates what comes back. Jev returns probabilities; the System turns them
into a `BehaviorDecision` (doc 04 §1).

### Application System

Authority: **execution**. Best for anything that must be exact, replayable, or
persisted.

- Timers, delays, monotonic clock.
- Persistent state and the event log.
- Queues: user-turn buffer, scheduled actions, per-conversation work queue.
- Scheduling, cancellation mechanics, delivery retries.
- State transitions and validation (message lifecycle, version checks).
- Rate limits, maximum message count, maximum delay, routine boundaries.
- Context retrieval/budgeting (mechanics).
- External platform calls (Telegram, Discord) through one adapter:

```ts
interface DeliveryAdapter {
  platform: "telegram" | "discord"
  send(chatId: string, text: string, idempotencyKey: string /* Discord nonce; Telegram ignores */): Promise<{ platformMessageId: string }>
  showTyping(chatId: string): Promise<void>   // Telegram ~5s, Discord ~10s; re-send while typing
  onMessage(cb: (msg: UserMessage) => void): void
}
```

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
names. Build these five primitives once:

| Primitive | Responsibility | Features it serves |
|---|---|---|
| **Event Log** | Append-only, per conversation. Audit trail and input for memory/summaries; written in the same transaction as state. | memory, summaries, topic history, user-behavior modeling, stale detection, audit |
| **Conversation State** | Versioned snapshot of the active exchange. | turn aggregation, topic tracking, momentum, interruptions, unresolved items |
| **Scheduler** | Durable table of future actions (send, follow-up, activity change, routine transition, turn quiet), restart-safe. Also *is* the pending action queue. | response delays, multi-message spacing, outgoing messages, follow-ups, delayed replies, routine transitions, activity changes, cancellation |
| **Interaction Manager** | Single serialized entry point per conversation. | interruptions, topic switch, cancellation, delay, new user messages, stale detection, replanning |
| **Character State Engine** | Derives behavioral values from persisted state. | activity, availability, interruptibility, attention, response speed, mood |

### Why one Scheduler, not many timers scattered

Response delay, multi-message spacing, delayed follow-up, routine transition,
and turn debounce are all "do X at time T, unless invalidated". They share the
same durable timer table. That table also serves as the pending action queue:
a pending action is just a row that has not fired yet. Keeping a separate queue
would mean two stores describing the same future and a sync problem between
them. This removes five ad-hoc timer systems and gives one recovery path after
restart.

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
  | { type: "OUTGOING_MESSAGE_SENT"; messageId: string }
  | { type: "DELIVERY_FAILED"; messageId: string }

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
(debounce). When the timer expires, the System emits `USER_TURN_READY`. A turn
is also forced ready once `now - firstAt` exceeds a maximum turn window, so a
user who keeps typing still gets a reply. Jev is not asked whether the user is
finished, because that would be a Jev call per message. This reuses the one
Scheduler (a `turn_quiet` action).

While the buffer is `collecting`, outgoing sends that come due are held until
the turn is ready. A bot message never lands in the middle of a user's burst.

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
  normal replies; follow-ups and routine actions have their own, longer cap).
- Never send a message whose `conversationVersion` is stale.
- Never persist derived values that a pure function can recompute cheaply.
- Never generate text when a deterministic stub is equivalent (for example an
  `activity` change does not need an LLM).
