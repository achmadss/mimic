# 05 — Context Engine

The brief (§30) rejects "send the last N messages". Mimic instead has an
explicit **Context Planner** and **Context Builder**. This is the answer to
§30.16: keep them as a **separate subsystem**, not folded into the Interaction
Manager, because context assembly is reused by both the reply path and the
summarization path, and it has its own failure modes.

```
Conversation History ─► Context Store ─► Context Planner (Jev) ─► Context Builder ─► LLM
                                              ▲                        ▲
                                        Interaction Manager ───────────┘
```

## 1. Context layers

| Layer | Contents | Priority | Source |
|---|---|---|---|
| **Immediate** | current user turn, recent user/bot messages, pending bot messages, interaction state | highest | Conversation State |
| **Conversational** | current topic, prior discussion of it, unresolved questions, recent switches | high | Conversation State + Event Log |
| **Long-term** | known facts, user preferences, important past events, relationship state | medium, retrieved | Memory store |
| **Character** | profile, style, current activity/state, relevant example conversations | high | Config + Character State |
| **System** | current time, activity, attention, interruptibility, pending actions, behavior decision, response constraints | always | Engine |

Immediate + System are **always available** (not retrieved). Character profile
is **always available**. Conversational and Long-term are **conditionally
retrieved**. Examples are **optional**.

## 2. Jev as Context Planner

Jev does **not** retrieve records. It receives candidate summaries and returns a
horizon plus include/exclude choices:

```json
{
  "horizon": "recent_topic",
  "include": ["topic_18", "memory_4"],
  "exclude": ["topic_12"]
}
```

The System translates the horizon into actual retrieval. This keeps Jev
decoupled from the storage schema (§30.3).

### Context horizons

| Horizon | Resolves to |
|---|---|
| `current_turn` | buffered user turn only |
| `recent` | last N messages + current turn |
| `recent_topic` | messages since `topicStartedAt` |
| `current_conversation` | current session up to the topic boundary |
| `long_term` | retrieved memories + older topic summaries |

## 3. Context Builder pipeline

```
1. Collect conversation state + system state          (always)
2. Collect candidate summaries                        (store query, cheap)
3. Ask Jev for horizon + include/exclude              (or deterministic default)
4. Retrieve selected items                            (messages/summaries/memories/examples)
5. Deduplicate + order by priority                    (immediate → conversational → long-term)
6. Apply token/size budget                            (trim lowest priority first)
7. Attach character state + behavior decision
8. Emit ordered LLM input
```

Steps 3 and 4 are merged when no Jev context plan exists: use the default
horizon `recent` + `recent_topic`.

### Context item

```ts
type ContextItem = {
  id: string
  type: "message" | "summary" | "memory" | "topic" | "example" | "state"
  content: string
  relevance?: number     // internal ranking
  source?: string        // for provenance
  createdAt?: number
}
```

Metadata is for selection and debugging, not for the LLM prompt body.

## 4. Context budget

```ts
type ContextBudget = {
  maxTotalTokens: number
  maxRecentMessages: number
  maxMemories: number
  maxTopicHistory: number
  maxExamples: number
}
```

Recommendation: **reserved minimums + a shared pool.** Reserve small guaranteed
slots so immediate context is never crowded out, then distribute remaining
budget dynamically by priority. Simply filling the window is explicitly
rejected (§30.4).

## 5. Retrieval strategy — simplest viable first

The brief asks which to use first (§30.13, §20). Recommendation, in order:

1. **Manual + tag selection** (MVP). Examples and memories carry tags
   (`scenario`, `topic`, `emotion`, `behavior`). Selection = filters on
   character + current activity/topic.
2. **Keyword/topic scoring** (MVP, cheap). Rank topic summaries and memories by
   term overlap with the current turn and topic. This solves the "PC history
   drowning out the keyboard topic" problem via topic tags rather than
   embeddings.
3. **Semantic retrieval** (Next). Only when keyword/topic recall is measurably
   insufficient.
4. **Vector search** (Experimental). Only when corpus size and recall demands
   it. Not in the MVP.

This honors §30.7 (topic-based retrieval before semantic) and the constraint to
avoid premature vector databases (§26).

## 6. Unresolved conversation items

`UnresolvedItem` lives in Conversation State. Flow:

1. Jev or a lightweight classifier marks a thread open (interview tomorrow).
2. It appears as a context candidate.
3. On a later greeting, Jev may choose `topicAction: "ask"`.
4. LLM phrases it using the unresolved item as context.

So unresolved tracking is **Conversation State** that feeds **Context
Planning**; Jev decides whether to surface it; the LLM decides wording. It is
not a fourth separate system.

## 7. Context invalidation

Context becomes stale when:

- the **topic changes** (deprioritize old topic, prioritize new),
- a **new user turn** arrives (bump `conversationVersion`),
- the **activity** changes materially (system context changes),
- **time passes** past a decay threshold for conversational context.

Because `conversationVersion` is also the stale-message guard, the two problems
share one counter. A pending message built from version `v` is invalid once the
version is `v+1`.

## 8. Context and the scheduler

A scheduled message retains `conversationVersion` and `generationId`. Before
send:

- version mismatch → replan (context was invalidated),
- context retrieval for replan failed → degrade to immediate context.

The scheduler never inspects context content; it only carries the version the
Interaction Manager checks.

## 9. Context failure handling (§30.15)

| Failure | Fallback |
|---|---|
| Retrieval fails | Use immediate + system + character context only. |
| Jev planning fails | Default horizon `recent`. |
| Summary missing | Skip it; recent raw messages cover recency. |
| Memory unavailable | Skip long-term; do not block. |
| Token budget exceeded | Trim long-term, then conversational, keep immediate. |
| Context conflicts with current turn | Current turn + version win; discard contradictory retrieved items. |
| Context too broad | Apply tighter `maxRecentMessages` and topic filter. |

Rule: **the reply must never fail because optional context failed.**

## 10. Context source matrix (§30.17)

| Source | Always included? | Jev selects? | Retrieved dynamically? | Stored? |
|---|---|---|---|---|
| Current user turn | Yes | No | No | Yes |
| Recent messages | Usually | Possibly | No | Yes |
| Topic history | No | Yes | Yes | Yes |
| Memory | No | Yes | Yes | Yes (summarized) |
| Character profile | Yes | No | No | Yes |
| Examples | No | Yes | Yes | Yes |
| Activity/state | Yes | No | No | Yes/derived |

## 11. Context deliverables — condensed

- **Context architecture**: store → planner (Jev) → builder → LLM. Separate
  subsystem.
- **Context state model**: `ConversationState.unresolved`, topic summaries, and
  memory records; no new heavy state.
- **Retrieval strategy**: tags + topic/keyword scoring first; semantic/vector
  only on measured need.
- **Invalidation**: `conversationVersion` + topic change + time decay.
- **Scheduler interaction**: version gate before send.
- **Jev interaction**: Jev picks horizon and candidate inclusion only.
- **LLM contract**: receives ordered, budgeted `ContextItem[]`; controls none of
  timing, cancellation, or budgeting.
