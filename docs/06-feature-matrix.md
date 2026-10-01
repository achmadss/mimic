# 06 — Feature Feasibility Matrix

Every feature from `DOC.md` §2. Layer codes: **Sys** = System, **Jev**,
**LLM**. Complexity/Value: Low/Med/High.

| # | Feature | Possible? | Primary | Supporting | Shared infra | Complexity | Value | Recommendation |
|---|---|---|---|---|---|---|---|---|
| 2.1 | Human-like message length | Yes | Jev | LLM + Sys | Message planner | Low | High | MVP |
| 2.2 | Imperfect grammar | Yes | LLM | Sys (tendency) | Character voice + seeded RNG | Low | High | MVP |
| 2.3 | Self-corrections | Yes | LLM | Jev + Scheduler | Multi-message infra | Low | Med | MVP |
| 2.4 | Multiple user messages | Yes | Sys | Jev | Turn buffer / debounce | Low | High | MVP |
| 2.5 | Multiple bot messages | Yes | LLM | Sys + Jev | Scheduler + lifecycle | Med | High | MVP |
| 2.6 | Message timing | Yes | Jev (category) | Sys (clock) | Scheduler | Med | High | MVP |
| 2.7 | Interruptions | Yes | Sys | Jev | Interaction Manager | Med | High | MVP |
| 2.8 | Cancel vs continue pending | Yes | Jev | Sys | Scheduler + lifecycle | Med | High | MVP |
| 2.9 | Topic switching / latching | Yes | Jev | LLM + Sys | Conversation State | Med | High | MVP (basic), Next (full) |
| 2.10 | Conversation momentum | Yes | Sys (derived) | Jev | Timestamps | Low | Med | Next |
| 2.11 | Character activity | Yes | Sys | Jev | Character State engine | Med | High | MVP |
| 2.12 | Device/local time routine | Yes | Sys | Jev | Routine Engine | Med | High | MVP (coarse), Next (fine) |
| 2.13 | Availability | Yes | Sys (derived) | Jev | Derived from activity | Low | Med | MVP (derived) |
| 2.14 | Interruptibility | Yes | Sys (derived) | Jev | Derived from activity | Low | High | MVP |
| 2.15 | Attention capture | Yes | Jev | Sys | Character State scalar | Low | Med | Next |
| 2.16 | Response speed | Yes | Sys (derived) | Jev (pace) | Derived + Scheduler | Low | High | MVP |
| 2.17 | Not responding | Yes | Jev | Sys | Behavior decision | Low | High | MVP |
| 2.18 | Delayed follow-up | Yes | Jev | Sys | Scheduler (reuse) | Low | Med | Next |
| 2.19 | Daily routine | Yes | Sys | Jev | Routine Engine + Scheduler | Med | High | MVP (coarse) |
| 2.20 | Social state (energy etc.) | Yes | — | — | (drop) | Low | Low | Probably unnecessary |
| 2.21 | Mood | Yes | Jev | LLM | Optional transient | Low | Med | Experimental |
| 2.22 | Character personality | Yes | Sys (profile) | LLM | Config | Low | High | MVP |
| 2.23 | Example conversations | Yes | Sys (retrieval) | LLM | Context store | Med | Med | MVP (tag/manual), Next (keyword) |
| 2.24 | Character quirks | Yes | LLM | Sys (seeded tendency) | Character voice + RNG | Low | Med | Next |
| 2.25 | User behavior modeling | Yes | Sys (derived) | Jev | Event Log projection | Med | Med | Experimental |
| 2.26 | Relationship state | Yes | Sys (persist) | Jev + LLM | Memory/conversation state | Med | Med | Next |
| 2.27 | Typing/presence indicators | Yes | Sys | — | Scheduler view | Low | Med | Next (platform-dependent) |
| 2.28 | Stale response detection | Yes | Sys | — | conversationVersion | Low | High | MVP |
| 2.29 | Event-driven architecture | Yes | Sys | — | Event Log + serial queue | Low | High | MVP (in-process only) |

## 1. Notes on contested features

### 2.2 Imperfect grammar — tendency, not rule

Model as a **per-message probability** drawn from seeded RNG and profile
weights (lowercase bias, typo rate, slang list). Never apply the same
transformation every message. The System can suppress consecutive identical
patterns to avoid "always says 'lol'".

### 2.10 Momentum — redundant with timestamps

Momentum `{topic, strength, startedAt}` is derivable from `topic`,
`topicStartedAt`, `lastUserAt`, `lastBotAt`. Store it only if profiling shows
the derivation is hot. **Next**, not MVP.

### 2.15 Attention — kept, but small

Kept because an important message must override an activity baseline. It is one
scalar with decay, not a state machine. **Next**.

### 2.20 Social state — dropped

`energy`, `sociability`, `patience`, `interest` have no behavior wired to them
yet. Persisting them creates drift and complexity. Drop until a concrete
behavior *requires* one; then derive it from activity + routine + time.

### 2.21 Mood — experimental

Explicit mood that nothing reads is decoration. Keep it only as an optional
input to LLM voice when Jev sets it. Do not build a mood engine.

### 2.23 / 30.13 Examples — retrieve this way

Manual → tags → keyword/topic scoring → semantic → vector. Ship the first two.

### 2.25 User behavior modeling — derived, not stored

Compute signals (short messages?, fast replies?, frequent topic shifts?) from
the Event Log on demand. Store a cached summary only. Avoid a second state
store.

### 2.27 Presence — platform-owned

`online` / `last seen` are usually platform features. Mimic can simulate a
`typing...` indicator as a **view** of a scheduled message's `dueAt`, but
should not duplicate platform presence. Only build what the target platform
does not already provide.

### 2.28 Stale detection — one counter

Covered by `conversationVersion`; see doc 03.

### 2.29 Event-driven — yes, but in-process

An in-process event log + serial per-conversation queue. No external bus.

## 2. Feature → shared-infrastructure map (§4)

| Shared primitive | Features that reuse it |
|---|---|
| Conversation State | 2.4, 2.9, 2.10, 2.25, 2.28, context |
| Scheduler | 2.3, 2.5, 2.6, 2.12, 2.18, 2.19, 2.27 |
| Pending Action Queue | 2.5, 2.7, 2.8, 2.17, 2.18, 2.19 |
| Interaction Manager | 2.4, 2.7, 2.8, 2.28, replanning |
| Character State Engine | 2.11, 2.13, 2.14, 2.15, 2.16, 2.21 |
| Behavior Decision | 2.1, 2.6, 2.9, 2.17, 2.16 |
| Context Builder | 2.22, 2.23, 2.25, 2.26, 30.* |

## 3. Layer responsibility matrix (§25.C)

| Capability | System | Jev | LLM | Combined |
|---|---|---|---|---|
| Message scheduling | ● | | | |
| Timer execution | ● | | | |
| Cancellation mechanics | ● | | | |
| Message persistence / versioning | ● | | | |
| Turn detection / buffering | ● | | | |
| Rate limits / max counts / max delay | ● | | | |
| Routine + activity transitions | ● | | | |
| Context retrieval + budget | ● | | | |
| Should respond / wait | | ● | | |
| Topic action | | ● | | |
| Pace category | | ● | | |
| Cancel/continue/delay/replace | | ● | | |
| Context horizon selection | | ● | | |
| Natural wording / voice | | | ● | |
| Nuanced interpretation | | | ● | |
| Self-correction phrasing | | | ● | |
| Structured multi-message text | | | ● | |
| Full reply pipeline | ● | ● | ● | ● |

● = primary owner.
