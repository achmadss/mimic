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
| 2.9 | Topic switching / latching | Yes | Jev | LLM + Sys | Conversation State | Med | High | Built (set-aside topic becomes an open thread) |
| 2.10 | Conversation momentum | Yes | Sys (derived) | Jev | Timestamps | Low | Med | Derived (`since` in Jev state), not stored |
| 2.11 | Character activity | Yes | Sys | Jev | Character State engine | Med | High | MVP |
| 2.12 | Device/local time routine | Yes | Sys | Jev | Routine Engine | Med | High | Built |
| 2.13 | Availability | Yes | Sys (derived) | Jev | Derived from activity | Low | Med | MVP (derived) |
| 2.14 | Interruptibility | Yes | Sys (derived) | Jev | Derived from activity | Low | High | MVP |
| 2.15 | Attention capture | Yes | Jev | Sys | Per-conversation scalar | Low | Med | MVP |
| 2.16 | Response speed | Yes | Sys (derived) | Jev (pace) | Derived + Scheduler | Low | High | MVP |
| 2.17 | Not responding | Yes | Jev | Sys | Behavior decision | Low | High | MVP |
| 2.18 | Delayed follow-up | Yes | Jev | Sys | Scheduler (reuse) | Low | Med | Built |
| 2.19 | Daily routine | Yes | Sys | Jev | Routine Engine (own timers, not `actions`) | Med | High | Built |
| 2.20 | Social state (energy etc.) | Yes | — | — | (drop) | Low | Low | Probably unnecessary |
| 2.21 | Mood | Yes | Jev | LLM prompt | Expires on a 45 min TTL | Low | Med | Built (deliberately small) |
| 2.22 | Character personality | Yes | Sys (profile) | LLM | Config | Low | High | MVP |
| 2.23 | Example conversations | Yes | Sys (retrieval) | LLM | Context store | Med | Med | Built (emotion + secondary tags) |
| 2.24 | Character quirks | Yes | LLM | Sys (seeded tendency) | Profile `quirks` + prompt | Low | Med | Built (repeats suppressed) |
| 2.25 | User behavior modeling | Yes | Sys (derived) | Jev | `messages` projection | Low | Med | Built (derived per turn) |
| 2.26 | Relationship state | Yes | Sys (derived) | Jev + LLM | `messages` + `memories` | Med | Med | Built (derived, plus facts) |
| 2.30 | Unresolved threads | Yes | Jev | LLM + Sys | `ConversationState.unresolved` | Low | Med | Built (one JSON column) |
| 2.27 | Typing/presence indicators | Yes | Sys | — | View of a scheduled message's `dueAt` | Low | Med | Built |
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
per-conversation scalar with decay computed on read, not a state machine.
**MVP**, because interruptibility (MVP) is derived from it.

### 2.20 Social state — dropped

`energy`, `sociability`, `patience`, `interest` have no behavior wired to them
yet. Persisting them creates drift and complexity. Drop until a concrete
behavior *requires* one; then derive it from activity + routine + time.

### 2.21 Mood — built, still deliberately small

Explicit mood that nothing reads is decoration, so it is kept to exactly one
reader: a line in the LLM prompt (`You are feeling annoyed right now`) when it is
not neutral. **There is still no mood engine** — Jev answers one Choice per user
turn, a torn answer is ignored, and the value expires on a 45-minute TTL instead
of decaying or interacting with anything. Nothing in the timing path reads it.

### 2.23 / 30.13 Examples — retrieve this way

Manual → tags → keyword/topic scoring → semantic → vector.

**Built:** rung 1, with one tag. `scripts/ingest-transcripts.ts` cuts exchanges
out of the show transcript, Jev tags each with an `emotion` in batch, and a turn
is tagged by the same question (`turn_emotion`) so selection is a filter on
`(characterId, emotion)` plus a seeded draw. **Not built:** the scenario and
behaviour tags, and rungs 2–4 — see doc 05 §11.
What the ingest has to fix up in the source file is in doc 05 §5.1: the
transcription writes narration lowercase and interleaves it with the speech, and
a model taught that narration is what a character does will start narrating.

### 2.25 User behavior modeling — derived, not stored

Compute signals (short messages?, fast replies?, frequent topic shifts?) from
the Event Log on demand. Store a cached summary only. Avoid a second state
store.

### 2.27 Presence — platform-owned

`online` / `last seen` are usually platform features. Mimic can simulate a
`typing...` indicator as a **view** of a scheduled message's `dueAt`, but
should not duplicate platform presence. Only build what the target platform
does not already provide.

On the chosen platforms:

- **Typing** — Telegram `sendChatAction("typing")` lasts ~5 s and Discord
  `sendTyping` lasts ~10 s; both must be re-sent while the typing window is
  open. Start it at `dueAt − typingTime`. **Built**: the manager holds one
  in-memory timer per conversation, refreshed every `typingRefreshMs` (4000 /
  8000), and re-reads the queued message each tick so a cancelled or rescheduled
  message stops or moves its own indicator. Nothing is persisted: if the process
  dies mid-typing the indicator expires on the platform by itself.
- **Presence** — Telegram bots have no online/last-seen. Discord bots do have
  a status (online / idle / dnd), and it can mirror derived `availability`.
  That status is global for the bot account, which fits one bot per
  character. **Built** for Discord: `PRESENCE` maps `available → online`,
  `busy → idle`, `away → idle`, `sleeping → invisible`, and it is set on every
  routine transition and once at boot.

### 2.28 Stale detection — one counter

Covered by `conversationVersion`; see doc 03.

### 2.29 Event-driven — yes, but in-process

An in-process event log + serial per-conversation queue. No external bus.

## 2. Feature → shared-infrastructure map (§4)

| Shared primitive | Features that reuse it |
|---|---|
| Conversation State | 2.4, 2.9, 2.10, 2.25, 2.28, context |
| Scheduler (incl. pending actions) | 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.12, 2.17, 2.18, 2.19, 2.27 |
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
