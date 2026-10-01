# 04 — Jev Decision Model and LLM Contract

## 1. Jev: one structured call per turn

The brief (§6, §9) warns against dozens of tiny Jev calls. We replace them with
**one `BehaviorDecision` per turn** that bundles the correlated judgements.

### Input to Jev

```ts
type JevInput = {
  character: CharacterProfile
  characterState: CharacterStateDerived   // activity + derived values
  conversation: ConversationState
  currentTurn: { messages: string[] }      // the buffered user turn
  pendingBots: { messageId: string; text: string; dueAt: number }[]
  unresolved: UnresolvedItem[]
  clock: { now: number; localHour: number; routineSlot: string }
  contextCandidates: ContextCandidateSummary[]
}
```

Jev sees **summaries and candidates**, never raw database rows (§30.2).

### Output from Jev

```ts
type BehaviorDecision = {
  respond: boolean
  respondMode: "now" | "later" | "no_reply"
  followUpAfterMs?: number          // only when respondMode = "later"

  topicAction: "continue" | "switch" | "acknowledge_return" | "ignore" | "ask"
  newTopic?: string

  pace: "instant" | "fast" | "normal" | "slow" | "very_slow"
  delayRange?: [number, number]     // optional bounded override

  messageCount: number              // 1..maxMessages (System clamps)
  askQuestion: boolean
  attentionRaise?: number           // 0..1, System clamps

  pendingAction?: {
    action: "continue" | "cancel" | "delay" | "replace"
    messageIds: string[]
    delayMs?: number
  }

  contextPlan?: {
    horizon: "current_turn" | "recent" | "recent_topic" | "current_conversation" | "long_term"
    include?: string[]
    exclude?: string[]
  }

  reason: string                    // short; for debugging and the event log
}
```

One call answers all of: should I respond, when, how fast, how many messages,
topic handling, pending-message handling, attention, and context horizon.

### Which decisions stay deterministic (no Jev)

| Decision | Why deterministic |
|---|---|
| Actual `dueAt` timestamp | Clock math; Jev gives a category/range only. |
| Max message count clamp | Safety bound. |
| Max delay clamp | Safety bound; prevents absurd waits. |
| Rate limit | Anti-spam; not a judgement. |
| Message persistence / logging | Infrastructure. |
| Version check before send | Correctness. |
| Delivery retries | Infrastructure. |
| Routine slot boundaries | Config + clock. |
| Typing-time estimate | Pure function of text length. |

Only call Jev when the decision is genuinely a judgement. For example, a routine
transitioning `working → idle` is deterministic; the Routine Engine does it and
emits `ACTIVITY_CHANGED` with no Jev call.

## 2. LLM contract

The LLM's only job is language. It receives a fully assembled, budgeted context
and the behavior decision, and returns **structured** output.

### Input (conceptual)

```ts
type LLMInput = {
  characterVoice: CharacterVoice      // profile + style + examples
  behaviorDecision: BehaviorDecision
  context: ContextItem[]              // already retrieved, ordered, budgeted
  constraints: {
    maxMessages: number
    maxCharsPerMessage: number
    lowercase: boolean
    allowTypos: boolean
    language: string
  }
}
```

### Output (strict)

```ts
type LLMOutput = {
  messages: {
    text: string
    correction?: string     // e.g. "*tomorrow"; System schedules as next fragment
    delayHint?: "fast" | "normal" | "slow"   // within the decision's bound
  }[]
  usedContextIds: string[]  // for provenance/debugging
  notes?: string            // optional, not sent to the user
}
```

Rules enforced by the System, not the prompt alone:

- `messages.length` clamped to `maxMessages`.
- Each message clamped to `maxCharsPerMessage`.
- `usedContextIds` recorded for explainability (§30.6).
- Typos are a *tendency*: the prompt includes a probability-like instruction
  ("occasionally, not every message"), and the System can suppress repeated
  typo patterns. Randomness is seeded so characters stay consistent.

### Why structured output, not a text blob

Multiple messages (`wait what` / `your boss actually quit??` / `lmao`) are a
**plan**, not a paragraph. Structure lets the System schedule spacing, cancel
individual fragments, and group a self-correction (`i'll see you tomorow` then
`*tomorrow`) as two fragments of one generation.

### Self-correction flow

1. LLM returns `messages[0].text = "i'll see you tomorow"` and
   `messages[0].correction = "*tomorrow"`.
2. System creates two `ScheduledMessage`s sharing one `generationId`, with
   `order` 0 and 1 and a short gap.
3. If the user interrupts before the correction fires, Jev may cancel it — the
   correction is a legitimate cancellable action, not a special case.

### What the LLM never controls

- Timing (only a `delayHint` inside a Jev-bounded range).
- Cancellation of other messages.
- The scheduler.
- Whether the bot responds at all (that is Jev's `respond`).
- Token/context budgeting (already applied).

## 3. LLM efficiency — when NOT to call it

Do not call the LLM for:

- Activity changes, routine transitions, presence updates.
- Pure acknowledgements that a deterministic stub covers (configurable).
- Context summarization *if* a cheaper heuristic/tag pass suffices (summaries
  are a separate, batched job — not on the hot path).
- Every tiny Jev sub-decision — those are one structured call.

Call the LLM only when fresh natural language is required.

## 4. Prompt assembly order

The Context Builder (doc 05) produces a fixed order so behavior is stable:

1. Character voice and constraints.
2. Behavior decision (what to do).
3. System/state context (activity, time, attention).
4. Conversation context (current turn, recent messages, topic).
5. Retrieved long-term context (memories, examples) — lowest priority.

Higher-priority items survive budget trimming first.
