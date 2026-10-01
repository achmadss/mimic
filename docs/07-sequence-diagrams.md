# 07 — Sequence Diagrams

All flows enter through the Interaction Manager (IM), which is serialized per
conversation. `v` = `conversationVersion`.

## 1. Normal response

```
User        IM                Jev        LLM        Scheduler     Delivery
 │  msg     │                  │          │            │             │
 ├─────────►│ append, buffer   │          │            │             │
 │          ├─ arm quiet timer ──────────────────────►│             │
 │          │◄──────────────── TIMER_EXPIRED (quiet) ─┤             │
 │          ├─ USER_TURN_READY, v++       │            │             │
 │          ├─────────────────►│          │            │             │
 │          │◄── answers ──────┤          │            │             │
 │          ├─ build context ────────────►│            │             │
 │          │◄── messages[] ──────────────┤            │             │
 │          ├─ schedule(msg, v, dueAt) ──────────────►│             │
 │          │◄──────────────── TIMER_EXPIRED (dueAt) ─┤             │
 │          ├─ version check: ok                       │             │
 │          ├─ ready → sending ──────────────────────────────────────►│
 │          │◄──────────────────────────── OUTGOING_MESSAGE_SENT ────┤
 │◄────────────────────────────────────────────────────────────────── message
```

## 2. Multiple user messages (turn aggregation)

```
User            TurnBuffer        Scheduler         IM            Jev
 │ "wait"          │                 │              │              │
 ├────────────────►│ firstAt=now     │              │              │
 │                 ├── arm quiet timer ────────────►│              │
 │ "i forgot"      │                 │              │              │
 ├────────────────►│ lastAt=now      │              │              │
 │                 ├── reset timer ──┤              │              │
 │ "oh yeah"       │                 │              │              │
 ├────────────────►│ lastAt=now      │              │              │
 │                 ├── reset timer ──┤              │              │
 │                 │      (quiet expires)           │              │
 │                 │                 ├─ TIMER_EXPIRED►             │
 │                 │                 │              ├─ USER_TURN_READY
 │                 │                 │              ├─────────────►│
 │                 │                 │              │◄─ 1 request ─┤
 │                 │                 │   (all buffered messages treated as one turn)
```

## 3. User interrupts bot (pending messages)

```
User          IM                         Jev                    Scheduler
 │ "never mind" │                          │                        │
 ├─────────────►│ append + buffer          │                        │
 │              ├─ hold pending sends while collecting              │
 │              │◄──────────────────── TIMER_EXPIRED (quiet) ───────┤
 │              ├─ USER_TURN_READY, v++    │                        │
 │              ├─ turn + pending list ───►│                        │
 │              │◄─ answers: respond_mode=now,                      │
 │              │   pending_msg_1=cancel   │                        │
 │              ├─ cancel(msg_1) ──────────────────────────────────►│
 │              ├─ (kept msgs: re-stamp v) │                        │
 │              ├─ generate fresh response ─► ...                   │
```

## 4. Topic switch

```
User        IM              Conversation State       Jev            LLM
 │ "forget pc, i got an interview"
 ├──────────►│ append, buffer │                       │              │
 │           ├─ USER_TURN_READY, v++                  │              │
 │           ├─ turn + state ─┼──────────────────────►│              │
 │           │               │                       ├─ topic_action│
 │           │               │                       │  = "switch"  │
 │           │◄──────────────┴───────────────────────┤              │
 │           ├─ context horizon = recent_topic ────────────────────►│
 │           │◄───────────────────────── reply + topic="interview" ─┤
 │           ├─ TOPIC_CHANGED, update topic/topicStartedAt         │
```

## 5. Activity change (async, no user input)

```
Clock/Routine     Routine Engine      IM (each conversation)       Jev
     │                  │                     │                     │
     ├─ slot boundary ─►│                     │                     │
     │                  ├─ activity=sleeping  │                     │
     │                  ├─ ACTIVITY_CHANGED ─►│                     │
     │                  │                     ├─ recompute derived  │
     │                  │                     │  speed/interruptibility
     │                  │                     ├─ reply pending?     │
     │                  │                     │  reschedule dueAt   │
     │                  │                     ├─ if sleeping/away: ─►│
     │                  │                     │◄─ cancel / delay ────┤
```

Routine transitions themselves need no Jev call (doc 04). Jev is consulted only
when a pending reply might need to be cancelled or delayed.

## 6. Delayed follow-up (async, reuses scheduler)

```
User            IM                 Jev              Scheduler          Delivery
 │ "what are you doing"
 ├───────────────►│                │                 │
 │                ├───────────────►│                 │
 │                │◄─ respond_mode=now,              │
 │                │   follow_up=yes, follow_up_after=15m
 │                ├─ schedule reply ────────────────►│
 │                ├─ schedule delayed_followup ─────►│
 │◄─────────────────────────────────────────────────── "working"
 │                │                │                 │
 │                │   (~15 min + jitter) TIMER_EXPIRED │
 │                │◄─────────────────────────────────┤
 │                ├─ (optional) new generation ──────► ... schedule "done finally"
 │◄──────────────────────────────────────────────────── "done finally"
```

## 7. Stale response prevention

```
v = 7
LLM generates: "what happened?"  (captured version = 7)
   │
   │  user: "never mind"  →  USER_TURN_READY  →  v = 8
   │  turn decision: cancel "what happened?", answer "never mind"
   │
If the cancel was missed and the Scheduler fires the original (version 7):
   → IM checks: 7 !== 8  → cancel, do NOT send
   → no replan; the v = 8 turn already has its own reply
```

## 8. Context planning

```
IM              Context Store      Jev (context plan)     Context Builder      LLM
 ├─ candidates? ──►│                     │                     │               │
 │◄─ summaries ────┤                     │                     │               │
 ├─ summaries (in the turn request) ───►│                     │               │
 │◄─ horizon + relevant_* answers ───────┤                     │               │
 ├─ build(plan) ──────────────────────────────────────────────►│               │
 │                 │◄─ retrieve selected ─────────────────────┤               │
 │                 │                     │   order + dedupe + budget           │
 │◄─ ordered ContextItem[] ────────────────────────────────────┤               │
 ├─ LLM input ────────────────────────────────────────────────────────────────►│
 │◄─ messages[] ───────────────────────────────────────────────────────────────┤
```
