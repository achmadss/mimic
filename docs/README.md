# Mimic — Human-Like Chatbot Engine

Mimic is a conversation engine that makes AI characters feel human. It does not
only generate human-like text. It models **state, timing, attention,
interruptions, memory, activity, and asynchronous messaging**, then lets a
language model put words on top of those decisions.

This `docs/` folder is the system design. It answers the brief in `DOC.md`
feature by feature, but the result is one **consolidated architecture**, not a
feature list.

## Core principle

> **The System executes. Jev decides. The LLM communicates.**

- **System** — deterministic. Owns clocks, queues, persistence, delivery,
  versioning, limits, and state transitions. Never guesses.
- **Jev** — the behavioral brain. Reads state and makes one structured
  decision per turn. Never holds a timer.
- **LLM** — the mouth. Turns a decision plus context into natural language.
  Never touches the scheduler.

## Document map

| Doc | Contents |
|---|---|
| [`01-architecture.md`](./01-architecture.md) | Layers, responsibilities, shared infrastructure, interaction manager, multi-character |
| [`02-state-model.md`](./02-state-model.md) | Smallest coherent state, ownership, derived vs persisted, redundant-concept cleanup |
| [`03-events-and-scheduling.md`](./03-events-and-scheduling.md) | Event model, scheduler, timing ownership, message lifecycle, concurrency, stale responses, failure handling |
| [`04-jev-and-llm.md`](./04-jev-and-llm.md) | Jev decision model (one call), LLM contract, what stays deterministic |
| [`05-context-engine.md`](./05-context-engine.md) | Context planner + builder, layers, budget, retrieval strategy, invalidation |
| [`06-feature-matrix.md`](./06-feature-matrix.md) | Every DOC.md feature: possible?, layer, infrastructure, complexity, value, recommendation |
| [`07-sequence-diagrams.md`](./07-sequence-diagrams.md) | Normal response, multi-message, interruption, topic switch, async activity change, delayed follow-up |
| [`08-roadmap-and-risks.md`](./08-roadmap-and-risks.md) | MVP scope, future features, implementation order, risks and mitigations |

## Executive summary (plain language)

1. **One engine, many characters.** All characters share one scheduler, one
   state store, one interaction manager, one Jev integration, and one LLM
   integration. A character is configuration plus data: profile, routine,
   activity tendencies, examples, and behavior tuning.
2. **One ingester, one owner per conversation.** Every incoming event (user
   message, timer expiry, activity change) enters a single **Interaction
   Manager**, which processes events **serially per conversation**. This alone
   removes most race conditions, so exotic concurrency machinery is not needed.
3. **A conversation is an append-only log with a version counter.** User turn
   completion and topic change bump the version. Every generated message
   records the version it was built from. The scheduler refuses to send a
   message whose version no longer matches. This is the whole stale-response
   solution — no `stateVersion` + `generationId` + `actionId` explosion.
4. **Timing is a contract.** Jev picks a *category* (`instant`, `fast`,
   `normal`, `slow`, `very_slow`) or a bounded delay range. The System turns
   that into a concrete millisecond timestamp with jitter and typing time. Jev
   never says "execute at 14:03:22.417".
5. **One structured Jev call per turn** decides respond/wait/topic/pace/
   message-split/cancel. Dozens of micro-calls are replaced by one decision
   object.
6. **The LLM returns structured messages, not a blob.** It returns an ordered
   list of short message fragments with optional self-corrections. Splitting a
   thought across messages is a plan the System can schedule and cancel.
7. **Context is planned, not dumped.** A Context Planner (Jev-informed) picks a
   horizon and relevance; a Context Builder retrieves, orders, dedupes, and
   enforces a token budget. First implementation is topic + recency + tags. No
   vector database until measured need.
8. **Routine and activity are one state machine, not four variables.**
   `activity` is persisted; `availability`, `interruptibility`, and
   `responseSpeed` are derived from it. `energy`, `patience`, and `sociability`
   are dropped until proven.

## What we deliberately refuse

- No separate event bus/broker in the MVP — an in-process event log plus a
  serialized per-conversation queue is enough.
- No vector search until keyword/tag retrieval demonstrably fails.
- No independent persistence of `availability`, `interruptibility`,
  `responseSpeed` if they can be derived from `activity`.
- No LLM access to the scheduler, and no Jev access to timers.
- No "more randomness = more human" — randomness is bounded and seeded per
  character.

See [`08-roadmap-and-risks.md`](./08-roadmap-and-risks.md) for scope and risks.
