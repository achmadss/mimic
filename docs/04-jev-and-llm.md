# 04 — Jev Decision Model and LLM Contract

## 1. Jev: one request per turn

Jev is TypeSafe AI's System One model (`jev-latest`, HTTP
`POST https://api.typesafe.ai/v1/systemone`, TS SDK `@typesafe-ai/sdk`). It
does **not** generate text or arbitrary JSON. A request is one **state** plus a
map of typed **questions**, and every answer is a probability:

- **Choice** — pick one of up to 255 named options. Returns `choice`,
  `probabilities`, and `confidence`.
- **Score** — rate against 2–10 ordered levels. Returns `score`,
  `probabilities`, and `confidence`.
- **Noul** — yes/no. Returns `noul` ∈ [0,1].

All questions in one request are evaluated in parallel, so adding questions
barely changes latency. This is what makes "one Jev call per turn" work: the
brief (§6, §9) warns against dozens of tiny calls, and here the whole turn's
judgement is **one request with many questions**. The System then assembles a
`BehaviorDecision` from the answers, applying thresholds and clamps in code.

### Jev state (what Jev reads)

```ts
type JevState = {
  trigger: "user_turn" | "followup_due" | "activity_changed"
  character: { name: string; personaSummary: string }
  activity: Activity
  derived: { availability: Availability; interruptibility: number; attention: number }
  localTime: string                       // character TZ, e.g. "Tue 23:40"
  topic: string | null
  recentMessages: { from: "user" | "bot"; text: string }[]   // short window
  currentTurn: string[]                   // the buffered user turn
  pendingBots: { id: string; text: string }[]
  unresolved: { id: string; summary: string }[]
  contextCandidates: { id: string; summary: string }[]       // capped, e.g. 20
}
```

Jev sees **summaries and candidates**, never raw database rows (§30.2).

Jev is also given **the clock**, under `since`, in milliseconds relative to now:
`lastUserMsgAgoMs`, `lastBotMsgAgoMs`, `turnStartedAgoMs`, `turnLastMsgAgoMs`,
`activityChangedAgoMs`, `moodChangedAgoMs`, `oldestPendingInMs`, plus `agoMs`
per recent message and `dueInMs` per queued one. Without these a reply five
seconds later mid-flow and one eight hours later out of the blue were the
*same input* — every number already existed in the database and was thrown away
before the call. This is what lets `respond_mode` mean "they have been waiting
all day" instead of guessing from the words alone.

### Questions (one request)

| Key | Type | Options / levels | Feeds |
|---|---|---|---|
| `respond_mode` | Choice | `now`, `later`, `no_reply` | `respondMode` |
| `follow_up` | Noul | "would naturally message again later about this" | `followUp` |
| `follow_up_after` | Choice | `15m`, `1h`, `3h`, `next_day` | `followUp.afterMs` |
| `topic_action` | Choice | `continue`, `switch`, `acknowledge_return`, `ignore`, `ask` | `topicAction` |
| `pace` | Choice | `instant`, `fast`, `normal`, `slow`, `very_slow` | `pace` |
| `message_count` | Choice | `1`–`5` | `messageCount` |
| `message_length` | Choice | `terse`, `short`, `normal`, `long` | per-message character budget |
| `ask_question` | Noul | "the reply should ask the user something" | `askQuestion` |
| `importance` | Score | trivial → urgent (4 levels) | `attentionRaise` |
| `opens_thread` | Noul | "user mentioned something worth asking about later" | unresolved item |
| `horizon` | Choice | `current_turn`, `recent`, `recent_topic`, `current_conversation`, `long_term` | `contextPlan.horizon` |
| `pending_<id>` | Choice, one per pending msg | `continue`, `cancel`, `delay`, `replace` | `pendingActions` |
| `relevant_<id>` | Noul, one per candidate | "relevant to the current turn" | `contextPlan.include` |
| `turn_emotion` | Choice | `neutral`, `excited`, `annoyed`, `sad`, `confused`, `joking`, `serious` (same set as example tags) | example selection (doc 05 §5.1) |
| `mood` | Choice | `neutral`, `happy`, `tired`, `annoyed`, `excited`, `distracted` | `mood` |

Questions are added only when they apply: no `pending_*` without pending
messages, no `topic_action` on a `followup_due` trigger, and no `mood` outside a
`user_turn` — the decision reads an answer only on a trigger that asked for it.

### The triggers

| Trigger | Asked | What it does |
|---|---|---|
| `user_turn` | everything above | the normal turn |
| `followup_due` | everything except `topic_action` and `mood` | the character messaging again on their own |
| `activity_changed` | `pace`, `pending_<id>` | **what is already queued is re-decided; nothing is written.** No reply-shaping question is asked, because no reply is being written, and `decide` pins `respondMode` to `no_reply` so the LLM is never reached |

`mood` is a `Choice` over the six levels, and the *gate* is what keeps it
stable, not the wording: an answer only overwrites the stored mood when it beats
the chance bar, so a torn answer leaves the character as they were. `neutral` is
the fallback and maps to `undefined` — "unchanged" — so a mood nobody moved
expires on its own TTL rather than being reset every turn.

### BehaviorDecision (assembled by the System)

```ts
type BehaviorDecision = {
  respondMode: "now" | "later" | "no_reply"
  followUp?: { afterMs: number }    // set when follow_up.noul ≥ threshold or respondMode = "later"
  topicAction: "continue" | "switch" | "acknowledge_return" | "ignore" | "ask"
  pace: "instant" | "fast" | "normal" | "slow" | "very_slow"
  messageCount: 1 | 2 | 3
  askQuestion: boolean
  attentionRaise?: number           // importance score mapped to 0..1
  openThread: boolean               // LLM writes the summary (see §2)
  mood?: Mood
  pendingActions: { messageId: string; action: "continue" | "cancel" | "delay" | "replace" }[]
  contextPlan: { horizon: Horizon; include: string[] }
  answers: unknown                  // raw Jev answers, kept for the event log
}
```

Things Jev cannot produce come from elsewhere:

- **New topic label** — Jev cannot output text. When `topicAction` is
  `switch`, the LLM returns the label (`LLMOutput.topic`).
- **Unresolved-thread summary** — when `opens_thread` fires, the LLM returns it
  (`LLMOutput.openThread`).
- **Exact delays** — `pace` → range table (doc 03 §2); `delay` on a pending
  message reuses the current pace's range.
- **`reason`** — dropped. The raw probabilities in `answers` explain the
  decision better than a sentence would.

### Confidence gating

Each Choice/Score answer carries `confidence`. Below a configured threshold
(start at 0.5), the System uses that field's deterministic default instead:
respond `now`, `normal` pace, 1 message, `continue` topic, `recent` horizon.
For a pending message, the default is `cancel` (a stale reply is worse than a
missing one). Nouls use probability thresholds (start at 0.7).

### Jev unavailable

Every field takes its default; all pending messages are cancelled and the bot
replies `now`. The engine never blocks on Jev.

### Which decisions stay deterministic (no Jev)

| Decision | Why deterministic |
|---|---|
| Actual `dueAt` timestamp | Clock math; Jev gives a pace category only. |
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

The engine talks to the LLM through one adapter interface, so the provider can
be swapped:

```ts
interface LLMClient {
  generate(input: LLMInput): Promise<LLMOutput>   // validates against the LLMOutput schema
}
```

The first implementation is **OpenAI-compatible** `POST {baseUrl}/chat/completions`,
configured by `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Testing uses
OpenCode Go (`https://opencode.ai/zen/go/v1`, model list at `/models`).
Gateway models differ in what structured output they support, so the client
has one config switch:

| `LLM_STRUCTURED_MODE` | Request | Notes |
|---|---|---|
| `json_schema` (default) | `response_format: { type: "json_schema", strict: true }` | Best when the model supports it |
| `tool` | a single forced tool call whose parameters are the `LLMOutput` schema | For models that do tools but not `json_schema` |
| `json_object` | `response_format: { type: "json_object" }` + schema pasted in the prompt | Last resort |

In every mode the response is validated against the same `LLMOutput` schema.
Output that fails validation counts as a failed attempt and goes through the
retry path in doc 03 §6.

### Input (conceptual)

```ts
type LLMInput = {
  characterVoice: CharacterVoice      // profile + style + examples
  behaviorDecision: Omit<BehaviorDecision, "answers">
  context: ContextItem[]              // already retrieved, ordered, budgeted
  constraints: {
    maxMessages: number
    maxCharsPerMessage: number        // ≤ platform limit (Telegram 4096, Discord 2000)
    lowercase: boolean
    allowTypos: boolean
    language: string                  // "en" for now
  }
}
```

### Output (strict)

```ts
type LLMOutput = {
  messages: {
    text: string
    correction?: string     // e.g. "*tomorrow"; System schedules as next fragment
    delayHint?: "fast" | "normal" | "slow"   // position within the pace range
  }[]
  topic?: string            // required when topicAction = "switch"
  openThread?: string       // required when decision.openThread; e.g. "interview tomorrow"
  usedContextIds: string[]  // for provenance/debugging
}
```

Rules enforced by the System, not the prompt alone:

- `messages.length` clamped to `maxMessages`. A `correction` is an extra
  fragment and does not count toward the limit.
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

- Timing (only a `delayHint` inside the pace range).
- Cancellation of other messages.
- The scheduler.
- Whether the bot responds at all (that is Jev's `respondMode`).
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
