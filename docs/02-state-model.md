# 02 — State Model

Goal: the **smallest coherent state** that supports the brief. Persist only what
cannot be cheaply recomputed. One owner per field.

## 1. Persisted state

### CharacterState (per character)

```ts
type CharacterState = {
  characterId: string
  activity: Activity          // "idle" | "working" | "gaming" | ...
  activitySince: number
  mood: Mood | null           // optional, transient
  moodChangedAt: number | null
}
```

- `activity` — drives everything else. Set by the Routine Engine or by explicit
  events. **Persisted** because it is the source for derived values. Only the
  Routine Engine writes it, so conversations never race on character state.
- `mood` — **optional, transient**. Set by Jev only when it clearly matters.
  If unused, drop it. It is not derived and not needed for timing.

### ConversationState (per conversation)

```ts
type ConversationState = {
  conversationId: string       // derived key: characterId + platform + chatId
  characterId: string
  platform: "telegram" | "discord"
  chatId: string               // the DM channel on that platform
  version: number              // monotonic; bumped only on USER_TURN_READY
  topic: string | null
  topicStartedAt: number | null
  lastUserAt: number
  lastBotAt: number
  attention: number | null     // 0..1, last raised value; null = activity baseline
  attentionRaisedAt: number | null
  unresolved: UnresolvedItem[]
}

type UnresolvedItem = {
  id: string
  summary: string
  raisedAt: number
  status: "open" | "resolved"
}
```

- `version` — the stale-response guard (§03). One counter, not three.
- `topic` / `topicStartedAt` — used for context horizon `recent_topic` and for
  topic-latching. Momentum is **derived** (see §2), not stored.
- `attention` / `attentionRaisedAt` — the character's focus on *this*
  conversation (see §3). It lives here, not in CharacterState, because a
  character can be in several conversations at once and each one is serialized
  separately.
- `unresolved` — small list of open threads (interview tomorrow, waiting on a
  reply). Feeds context planning and Jev.

### TurnBuffer (per conversation)

```ts
type TurnBuffer = {
  conversationId: string
  messages: UserMessage[]
  firstAt: number
  lastAt: number
  state: "collecting" | "ready"
}
```

### ScheduledMessage / PendingAction (per conversation)

```ts
type ScheduledMessage = {
  id: string                   // doubles as the Scheduler actionId
  conversationId: string
  generationId: string
  conversationVersion: number  // captured at generation; re-stamped if Jev keeps it
  text: string
  order: number                // position within the multi-message burst
  status: MessageStatus
  dueAt: number
}

type MessageStatus =
  | "planned" | "scheduled" | "ready"
  | "sending" | "sent" | "cancelled" | "failed"
```

Non-message future actions share the same queue:

```ts
type ScheduledAction =
  | { kind: "send_message"; message: ScheduledMessage }
  | { kind: "turn_quiet"; conversationId: string }  // turn-buffer debounce
  | { kind: "delayed_followup"; conversationId: string }
  | { kind: "activity_change"; characterId: string; activity: Activity }
  | { kind: "routine_transition"; characterId: string; slot: string }
```

### Supporting types

```ts
type Activity = "idle" | "working" | "studying" | "gaming" | "eating"
              | "watching" | "commuting" | "sleeping" | "away"
type Availability = "available" | "busy" | "away" | "sleeping"
type Speed = "instant" | "fast" | "normal" | "slow" | "very_slow"   // same scale as Jev pace
type Mood = "neutral" | "happy" | "tired" | "annoyed" | "excited" | "distracted"

type UserMessage = {
  id: string                   // platform message id
  conversationId: string
  text: string
  at: number
}

// Config (files), not state
type CharacterProfile = {
  characterId: string
  name: string
  timezone: string             // IANA, e.g. "Asia/Jakarta"
  persona: string              // personality, interests, dislikes, habits
  speechStyle: { lowercase: number; typoRate: number; slang: string[]; language: string }
  basePace: Speed
  activityBaselines: Record<Activity, { attention: number; speedMultiplier: number }>
  routine: RoutineSlot[]
  platforms: { telegram?: { botTokenEnv: string }; discord?: { botTokenEnv: string } }
}

type RoutineSlot = {
  start: string                // "07:00" in the character TZ
  activity: Activity
  jitterMin: number            // boundary varies ± this, seeded per day
}
```

`offline` from the brief (2.13) is not an availability value. The bot is
either running or it isn't, and the platform shows that.

### Event Log (append-only, per conversation)

```ts
type StoredEvent = {
  id: string
  conversationId: string
  at: number
  type: EventType
  payload: unknown
}
```

The log feeds memory, summaries, topic history, and debugging. Runtime state
lives in its own tables, written in the **same SQLite transaction** as the
event that changed it. State is never rebuilt from the log.

## 2. Derived state (do NOT persist)

These are pure functions of persisted state plus the character profile. Compute
on read.

```ts
function availability(a: Activity): Availability { /* map */ }
function attention(conv: ConversationState, cs: CharacterState, now: number): number
function interruptibility(cs: CharacterState, conv: ConversationState, profile: CharacterProfile, now: number): number
function responseSpeed(cs: CharacterState, profile: CharacterProfile, now: number): Speed
function momentum(state: ConversationState, now: number): number
```

Rationale:

| Derived value | Derived from | Why not persisted |
|---|---|---|
| `availability` | `activity` | Pure mapping; no extra information. |
| `interruptibility` | `activity` + profile + `attention` | Cheap; avoids drift between copies. |
| `responseSpeed` | `activity` + profile + time-of-day | Same. |
| `energy` | routine slot + time + activity | If needed at all, it is a function, not a variable. |
| `sociability`, `patience`, `interest` | profile + activity (+ recent activity) | Speculative; drop until a behavior depends on it. |
| topic `momentum` | `topicStartedAt`, `lastBotAt`, `lastUserAt`, `version` | Recomputed from timestamps. |
| `typing indicator` | scheduled message `dueAt` | A view of the scheduler, not new state. |

## 3. Attention — the one scalar worth keeping

Attention is a bounded value `[0,1]` with three transitions:

1. **Raise**: an important user message sets attention upward (for example to
   `0.9`). Jev can request the raise; the System clamps it and stores it with
   `attentionRaisedAt`.
2. **Decay**: attention decays toward the character's baseline for the current
   activity (working → low baseline, idle → high). Decay is computed on read
   from `attentionRaisedAt`, so no timer and no decay events are needed.
3. **Activity override**: an activity change resets the baseline.

Why keep it instead of folding into `activity`? Because a single important
message must be able to override the activity baseline temporarily. That is a
real behavior. Everything *else* in the "social state" family is dropped.

## 4. Redundant concepts removed

`DOC.md` §5 asks whether these overlap. They do:

```
activity = working
   → attention baseline low
   → responseSpeed slow
   → interruptibility low
   → availability busy
```

Persisting all five would create five copies that can drift. We persist
`activity` (+ `attention` override) and derive the rest.

Same for topics:

```
current topic  ⊃ topic momentum  ⊃ conversation priority
```

`topic` + timestamps already encode momentum. "Conversation priority" is not a
stored value; it is a Jev judgement computed when needed.

## 5. State ownership table

| State | Created by | Modified by | Read by | Persisted | Derived | Jev needs | LLM needs | Stale? | Invalidated by |
|---|---|---|---|---|---|---|---|---|---|
| Character profile | config | config | all | yes | no | yes | yes (voice) | no | config change |
| activity | Routine Engine / event | Routine Engine / event | engine, Jev | yes | no | yes | yes (context) | yes | activity_change |
| attention (per conversation) | Interaction Mgr | Jev raise; decays on read | Jev, timing calc | yes | no | yes | no | yes | decay, activity change |
| availability | — | — | Jev, presence | no | yes | yes | no | no | activity change |
| interruptibility | — | — | Jev | no | yes | yes | no | no | activity/attention |
| responseSpeed | — | — | timing calc | no | yes | no | no | no | activity/profile |
| topic | Interaction Mgr / Jev | Jev decision | context, Jev | yes | no | yes | yes | yes | topic change |
| momentum | — | — | context ranking | no | yes | no | no | no | time |
| TurnBuffer | Interaction Mgr | Interaction Mgr | Jev | yes | no | yes | yes | yes | turn ready |
| pending bot messages | Interaction Mgr | Interaction Mgr (per Jev decision) | Jev, scheduler | yes | no | yes | yes | yes | send/cancel/topic change |
| scheduled actions | Interaction Mgr | Interaction Mgr (per Jev decision) | scheduler | yes | no | yes | no | yes | fire/cancel |
| conversation version | Interaction Mgr | USER_TURN_READY | Interaction Mgr (send gate) | yes | no | no | no | no | bump |
| user behavior | derived | — | Jev | optional | yes | maybe | no | yes | new messages |
| memory | summarizer | summarizer | context builder | yes | no | sees summary | sees retrieved items | yes | new summaries |
| mood | Jev | Jev | LLM (voice) | optional | no | maybe | yes | yes | time/mood change |
| routine | config + engine | Routine Engine | engine | yes | no | yes (via activity) | yes (context) | no | schedule |

## 6. Why each field exists (short)

- `version` — the single concurrency guard. Nothing else needed.
- `generationId` — groups the fragments of one LLM generation so a
  regeneration can cancel the whole burst atomically.
- `dueAt` — when the scheduler fires.
- `order` — preserves the intended sequence of a split thought.
- `attention` — lets one important message override an activity baseline.
- `unresolved` — lets the bot "remember" to ask how the interview went.

No field is present "because it sounds useful".
