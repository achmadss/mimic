# 08 — MVP Scope, Roadmap, and Risks

## 1. MVP scope (§9, §25.L)

The smallest system that feels human and is honest about what it defers.

### Must build

1. **Event Log** — append-only per conversation.
2. **Conversation State** — version, topic, timestamps, unresolved items.
3. **Turn Buffer + debounce** — multiple user messages become one turn.
4. **Character State engine** — persisted `activity` and per-conversation
   `attention`; derived `availability`, `interruptibility`, `responseSpeed`.
5. **Scheduler** — one durable delay queue; restart-safe. It is also the
   pending action queue.
6. **Message lifecycle** — planned → scheduled → ready →
   sending → sent, with cancellation.
7. **Interaction Manager** — serialized per conversation.
8. **Jev integration** — one `BehaviorDecision` per turn (respondMode, topic,
   pace, messageCount, attention raise, pending actions).
9. **LLM integration** — structured `messages[]` output, including
   self-corrections and the imperfect-grammar tendency.
10. **Context Builder (simple)** — recent messages + current turn + topic +
    character profile; fixed budget.
11. **Stale-response guard** — `conversationVersion` check before send.
12. **Coarse routine** — 3–4 slots (morning/day/evening/night) driving
    `activity`.
13. **Two characters (Rick, Morty)** — hand-written persona + transcript-derived,
    Jev-tagged examples (doc 05 §5.1).
14. **Telegram + Discord DM adapters** behind one `DeliveryAdapter`.

### Explicitly out of MVP

- Discord DM reach (how users find and DM the bots: shared server or user-installed app).
- Languages other than English.
- Vector search, semantic retrieval.
- Mood engine, social-state variables.
- Momentum as stored state.
- Relationship state.
- Typing indicators / presence.
- Delayed follow-ups (design present, wiring later).
- Full topic latching modes (acknowledge-return, ignore-with-return).

## 2. Roadmap by dependency (§25.M)

### Stage 0 — Foundation
Event Log → Conversation State → Scheduler → serialized Interaction Manager.
*Everything depends on these; nothing else can be tested without them.*

### Stage 1 — MVP conversation loop
Turn buffer + debounce, Jev behavior decision, LLM structured output, message
lifecycle, version guard, delivery adapter, one character.

### Stage 2 — Character realism
Coarse routine → activity, derived interruptibility/speed, attention capture,
message length/pace tuning, self-corrections, multi-message bursts, imperfect
grammar tendency.

### Stage 3 — Context
Context Builder budget + ordering, keyword/topic retrieval, tagged examples,
unresolved items, simple summaries.

### Stage 4 — Async behaviors
Delayed follow-ups, activity change while a reply is pending, "not responding"
with scheduled retry, presence/typing simulation.

### Stage 5 — Depth
Topic-latching modes, relationship state, mood (optional), user-behavior
adaptation.

### Stage 6 — Experimental
Semantic retrieval, vector search, full social-state model, multi-conversation
memory graph.

### Status (2026-10-02)

Stages 0–5 are built. Stage 3's planner is the one deliberate gap: context is
selected by topic scope, emotion tags and keyword overlap, with count budgets,
and Jev does not yet vote on candidates (doc 05 §13). Stage 5 mood is the
small version (doc 06 §2.21). Stage 6 is untouched, by design: nothing has yet
measured keyword recall as insufficient.

## 3. Implementation order (§25.O)

```
1. Event Log + persistence
2. Conversation State + version counter
3. Scheduler (SQLite action table + in-process timers)
4. Interaction Manager (serial queue, event dispatch)
5. Delivery adapter stub (CLI / log-only) — the test harness for everything after
6. Jev client (`@typesafe-ai/sdk`): question builder + answers → BehaviorDecision
7. LLMClient interface + OpenAI-compatible client (structured-mode switch) + LLMOutput validation
8. Turn buffer + debounce
9. Message lifecycle + version guard
10. Character State engine + profile + derived values
11. Context Builder (recent + topic + profile)
12. Coarse routine engine
13. Attention capture
14. Multi-message bursts + self-corrections
15. Transcript ingest (CSV → exchanges → Jev tags) + tagged example retrieval
16. Unresolved items
17. Delayed follow-ups
18. Presence / typing simulation (view of scheduler)
19. Summaries + long-term memory
20. Topic-latching modes
21. Telegram adapter, then Discord adapter (can move up to right after 9 once
    the CLI loop works; they only implement `DeliveryAdapter`)
```

Rationale: each step is independently testable and only depends on earlier
steps. Steps 1–9 form a runnable loop against the CLI adapter; 10–13 add
character; the rest add depth. Every timing step is tested with the fake
`Clock`.

## 4. Risks and mitigations (§25.N)

| Risk | Manifestation | Mitigation |
|---|---|---|
| **Overengineering** | Building social state, mood engine, vector DB before need | Strict MVP list; derive before persist; tag retrieval first |
| **State explosion** | Many booleans that drift | One owner per field; derived values recomputed; redundancy removed (doc 02) |
| **Excessive Jev calls** | A call per micro-decision | One `BehaviorDecision` per turn; deterministic defaults otherwise |
| **Excessive LLM calls** | LLM for activity, presence, acks | LLM only for fresh natural language |
| **Timing complexity** | Absolute timestamps leaking from Jev | Jev gives a pace category; System owns the clock |
| **Race conditions** | Concurrent edits to one conversation | Serialize per conversation; event log ordering |
| **Stale responses** | "what happened?" after "never mind" | Single `conversationVersion` gate before send |
| **Unnatural behavior** | Deterministic tics ("always says lol") | Seeded probability + suppression of repeated patterns |
| **Excessive randomness** | Chaotic, unreproducible behavior | Seeded RNG per character; bounded jitter; no random non-response |
| **Non-response frustration** | Bot silently ignores user | "Not responding" must schedule a follow-up or be rare and configured; never pure random silence |
| **Maintenance complexity** | Many subsystems | Five primitives; one scheduler; one interaction manager |
| **Restart data loss** | Scheduled messages vanish | State + event in one transaction; load + re-arm; catch-up policy |
| **Context bloat** | Irrelevant history floods prompt | Budget + priority ordering; topic filtering; explainable selection |
| **Context conflict** | Old context contradicts current turn | Current turn + version win; discard contradictory items |

## 5. Human-likeness vs complexity (§13)

Guidance for every future feature:

- **Behavioral value** must be demonstrable, not assumed. If you cannot name
  the observable behavior change, do not build it.
- **Randomness ≠ human.** Bounded, seeded variation reads as human; unbounded
  randomness reads as buggy or annoying.
- **Interaction risk**: timing and non-response features can frustrate users
  more than they delight. Default to responsive; make latency a character trait,
  not a random penalty.
- **Maintenance**: every persisted field is a migration and a drift source.
  Prefer derivation.

## 6. Recommendation summary

Build the five primitives; run one serialized Interaction Manager; make Jev one
structured decision per turn; make the LLM return structured messages; guard
every send with one version counter; derive everything derivable. Ship
tag/topic context retrieval first. Add mood, relationship state, and vector
search only when a measured behavior needs them.
