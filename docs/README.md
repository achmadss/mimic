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
   Five primitives: Event Log, Conversation State, Scheduler (which *is* the
   durable pending-action queue), Interaction Manager, Character State Engine.
3. **A conversation is an append-only log with a version counter.** User turn
   completion bumps the version. Every generated message
   records the version it was built from; pending messages Jev chooses to keep
   are re-stamped with the new version. The Interaction Manager refuses to send
   a message whose version no longer matches. This is the whole stale-response
   solution — no `stateVersion` or `contextVersion` on top of it.
4. **Timing is a contract.** Jev picks a *category* (`instant`, `fast`,
   `normal`, `slow`, `very_slow`) or a bounded delay range. The System turns
   that into a concrete millisecond timestamp with jitter and typing time. Jev
   never says "execute at 14:03:22.417".
5. **One Jev request per turn.** Jev (TypeSafe's System One model) answers
   many typed questions (respond/wait, topic, pace, message count, each pending
   message, context relevance) in a single request. Code turns the
   probabilities into one `BehaviorDecision`.
6. **The LLM returns structured messages, not a blob.** It returns an ordered
   list of short message fragments with optional self-corrections. Splitting a
   thought across messages is a plan the System can schedule and cancel.
7. **Context is planned, not dumped.** A Context Planner (Jev-informed) picks a
   horizon and relevance; a Context Builder retrieves, orders, dedupes, and
   enforces a token budget. First implementation is recency + topic + tags;
   keyword scoring next. No vector database until measured need.
8. **Routine and activity are one state machine, not four variables.**
   `activity` is persisted; `availability`, `interruptibility`, and
   `responseSpeed` are derived from it. `energy`, `patience`, and `sociability`
   are dropped until proven.

## Implementation decisions

| Area | Decision |
|---|---|
| Runtime | TypeScript on Node.js ≥ 20 |
| Storage | SQLite, single process. Each event append and its state update share one transaction; scheduled actions are a table. |
| Recovery | Load state tables and scheduled actions on boot. The event log is for audit, memory, and debugging, not for rebuilding state. |
| Jev | TypeSafe `jev-latest` via `@typesafe-ai/sdk` (doc 04 §1) |
| LLM | `LLMClient` interface; the first implementation is **OpenAI-compatible** `/chat/completions` (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`). Testing runs on OpenCode Go (`https://opencode.ai/zen/go/v1`). See doc 04 §2. |
| Platforms | Telegram and Discord, **direct messages only**, behind one `DeliveryAdapter` interface. Group chats are out of scope. |
| Characters | **Rick** and **Morty** (Rick and Morty). Two profiles, two bots per platform. Voice examples come from show transcripts (CSV), ingested offline (doc 05 §5.1). |
| Language | English |
| Identity | One bot account per character per platform. A conversation is `(characterId, platform, chatId)`; the same person on two platforms is two conversations. |
| Time | Each character has a configured IANA timezone; routine and `localTime` use it. |
| Clock | All timing goes through an injected `Clock`, so tests use a fake clock. |

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
