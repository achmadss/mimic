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

**Status.** The *inputs* on the right are built; the Jev planner on the left is
not. What exists: the `examples` store (offline ingest, retrieved by
`turn_emotion`), open threads on Conversation State, a message window scoped to
the current topic, and long-term memory (summaries and facts, recalled by
keyword overlap under a count budget). What does not: `horizon`,
`relevant_<id>`, and a token-level `ContextItem[]` budget. See §12–13.

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

Jev does **not** retrieve records. Candidate summaries go into the turn's Jev
state, and the same request asks a `horizon` Choice plus one
`relevant_<id>` Noul per candidate (doc 04 §1). The System turns that into a
plan:

```json
{
  "horizon": "recent_topic",
  "include": ["topic_18", "memory_4"]
}
```

`include` = candidates whose Noul ≥ threshold. Everything else is excluded by
default, so there is no separate `exclude` list. Candidates are capped (start:
20, ranked by recency + tag match) to keep the request small.

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
3. Read horizon + relevant_* from the turn's Jev answers (or default)
4. Retrieve selected items                            (messages/summaries/memories/examples)
5. Deduplicate + order by priority                    (immediate → conversational → long-term)
6. Apply token/size budget                            (trim lowest priority first)
7. Attach character state + behavior decision
8. Emit ordered LLM input
```

Steps 3 and 4 are merged when no Jev context plan exists: use the default
horizon `recent`.

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

1. **Manual + tag selection** (MVP). **Built**, with one tag: an exchange is
   tagged `emotion` by Jev in batch at ingest, and a turn is tagged `emotion` by
   the same question live, so selection is a filter on
   `(characterId, emotion)` plus a seeded draw. `scenario` and the behaviour
   tags are not built — nothing reads them until a turn carries a scenario, and
   the ingest is idempotent and offline, so adding one later costs minutes.
2. **Keyword/topic scoring** (Next, cheap). Not built. Rank topic summaries and
   memories by term overlap with the current turn and topic.
3. **Semantic retrieval** (Next). Only when keyword/topic recall is measurably
   insufficient.
4. **Vector search** (Experimental). Only when corpus size and recall demands
   it. Not in the MVP.

The "PC history drowning out the keyboard topic" problem that §2 names as the
motivation for rungs 2–4 is **solved without either**: the message window is
scoped to `topicStartedAt` (see §7), which is a lower bound on the same query
rather than a ranking over it. Ranking becomes worth building when the window is
right but the messages inside it are still the wrong ones.

This honors §30.7 (topic-based retrieval before semantic) and the constraint to
avoid premature vector databases (§26).

### 5.1 Example source: show transcripts

The first characters are **Rick** and **Morty**. Their examples come from a
transcript CSV of the show, so nobody hand-writes example conversations.

**Offline ingest** (a script, never on the reply path):

1. Read the CSV. The assumed columns are episode, speaker, and line; the
   mapping is confirmed when the file arrives.
2. Normalize speaker names (`RICK`, `Rick Sanchez` → `rick`).
3. Cut **exchanges**: windows of 4–8 consecutive lines in which the target
   character speaks at least twice. A Rick-and-Morty exchange counts for both
   characters.
4. **Tag with Jev in batch.** For each exchange, one request with:
   - an emotion Choice (the same set as `turn_emotion`, doc 04 §1)
   - a scenario Choice (`banter`, `argument`, `explaining`, `panic`,
     `comforting`, `bragging`, `goodbye`, `other`)
   - Nouls for brief behaviours (`joke`, `disagreement`, `confusion`,
     `interruption`, `topic_switch`)

   This makes "tag-based retrieval" (MVP) possible without hand-tagging
   thousands of lines.
5. Store as `Example { id, characterId, episode, lines[], tags[] }` in SQLite.

**At reply time:** pick up to `maxExamples` (3) whose emotion matches the turn's
`turn_emotion`, with a seeded draw so the same examples don't repeat every turn.
The pool is the emotion bucket ordered by id and cut at `examplePool` (40), which
keeps the read bounded and the draw reproducible: the same generation seed always
selects the same examples, so a surprising reply can be explained.

**What the file actually contains.** The transcription interleaves narration with
speech — `stumbles in drunkenly, and turns on the lights. Morty! You gotta come
on.` — plus HTML fragments, parenthetical asides and a leading `:` where the
speaker was split from the line. All of it is written lowercase, and the spoken
part is the longest run of consecutive sentences that isn't. `spokenText` keeps
only that run, and never empties a line: a short all-lowercase line is speech the
rule cannot read, and losing it is worse than keeping one stray direction. This
matters because the direction the model would otherwise learn is the one thing
the prompt bans twice and `humanize` strips.

**Voice vs format.** Show lines are *spoken, multi-party* dialogue, not text
messages. Examples teach **voice**: vocabulary, attitude, catchphrases, how
the character treats the other person. **Texting format** (short, lowercase,
split messages, occasional typos) comes from `speechStyle` and the prompt. The
prompt labels examples as "how <name> talks", not "how <name> texts", so the
LLM doesn't copy screenplay formatting.

**Persona** (`CharacterProfile.persona`) is written once by hand (an
LLM-drafted version, reviewed, is fine). It is never derived at runtime.

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

- version mismatch → cancel. The turn that bumped the version runs its own
  decision and context build, so the gate does not replan.
- context retrieval for that new build fails → degrade to immediate context.

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

## 12. Notes from the context pass

What shipped, what did not, and what brings the rest back.

**Shipped.**

- `examples` — a table, an offline ingest (`npm run ingest`), a `turn_emotion`
  question, and seeded selection. 800 examples across the two shipped
  characters, tagged by Jev, 0 failed batches.
- **Open threads** — `opens_thread` (or a topic set aside with `ignore` /
  `acknowledge_return`, so `ask` can bring it back later) → `LLMOutput.openThread` → the
  `conversations.unresolved` column → back into Jev's state and the prompt when
  Jev chooses `topic_action: "ask"`. The stored list is the open set: an item is
  removed once the reply that asked about it was generated, and expires after 7
  days if nobody asked. That is what makes "the reply must never fail because
  optional context failed" true here as well — a failed generation leaves every
  thread open, because nothing was asked.
- **The topic-scoped window** — §7 with no planner in front of it. `recent_topic`
  is the default whenever a topic is active, with a floor of `minRecentMessages`
  (6) below which it falls back to the ordinary recent window. The floor is the
  whole point: a topic raised one message ago would otherwise return a single
  message and blank out the conversation the character is replying into, which is
  a worse failure than the crowding the scope exists to fix.

**Not shipped, and why together.**

Doc 05's §2 planner, §4 budget, §5 rungs 2–4, and summaries are one piece of
work rather than four. Candidates are summaries; `horizon` chooses among
candidate sets that do not exist; `relevant_<id>` votes on candidates that do not
exist; the budget trims a `ContextItem[]` that has nothing in it but raw messages
a store query already bounds. Build the summarizer first, and the rest has
something to be about.

The trigger is specific: **the first time the raw window is measurably wrong** —
a conversation long enough that `recentMessages` truncates the topic, or a user
who has to repeat something they said days ago. Until then every question the
planner would ask has one answer, and a question with one answer is not a
judgement.

**Fixed: thin buckets.** `neutral` and `sad` held 3–5 examples each against 213
`joking` for Rick, because the show has almost no calm scenes and Jev's argmax
almost never lands there. The fix was at ingest, as planned: every emotion Jev
gives ≥ 0.15 probability is stored as a `secondary` tag, retrieval matches either
tag with primary matches first, and the ingest takes the whole show instead of
400 exchanges per character. `neutral` now draws from 17–34, `sad` from 17–26.
The ingest also strips dialogue dashes, skips spans where a stage direction runs
into the speech with no sentence break, and prunes rows the cut no longer
produces (only after a run with no failed batch).

## 13. Notes from the memory pass

**Shipped.**

- **Summaries and facts** (`src/context/memory.ts`, table `memories`). Once
  `summaryMinChunk` (10) messages have fallen out of the `recentMessages` window,
  one LLM call (`LLMClient.summarize`, its own `notes` tool) summarizes the
  oldest chunk, up to `summaryMaxChunk` (40), and lists durable facts about the
  user. It runs after the reply is queued, outside the conversation's critical
  path; `conversations.summarized_until` is its own column with its own write, so
  it cannot race `saveConversation`. A failure leaves the mark where it was and
  the chunk is tried again on a later turn.
- **Dates are dates.** Measured on the first live run: without the date of the
  messages, "thesis defense on Thursday" was stored, and is wrong a week later.
  The summarizer is told the day range and asked for "Thu 1 Oct".
- **Recall is §5 rung 2.** Facts and summaries are ranked by 4-letter-prefix
  overlap with the turn and topic, newest first on a tie, and capped by
  `maxFacts` (12) and `maxSummaries` (2). With nothing in common it is simply
  the newest notes, which is what just left the window.
- **Relationship and user behaviour** (doc 06 §2.25–2.26) are derived per turn
  from `messages` and never stored: first message, message count, average
  length, median reply gap. Jev gets the numbers; the prompt gets a line only
  where there is enough data to back it.

**Still not built, and why.** The Jev planner (`horizon`, `relevant_<id>`). Now
that candidates exist it has something to vote on, but keyword ranking already
picks at most two summaries, and every new field in Jev's state has so far
moved some *other* answer (see `opens_thread`). Add it the first time recall
measurably picks the wrong note; measure the raw answer distribution first.
Facts have no expiry or contradiction handling: a newer fact sits next to the
older one, and the prompt says they may be out of date.
