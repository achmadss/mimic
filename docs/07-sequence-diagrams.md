# 07 — Sequence Diagrams

All flows enter through the Interaction Manager (IM), which is serialized per
conversation. `v` = `conversationVersion`.

## 1. Normal response

```
User        Ingester      IM              Jev          LLM        Scheduler   Delivery
 │  msg        │           │               │            │           │           │
 ├────────────►│           │               │            │           │           │
 │             ├─ append ─►│               │            │           │           │
 │             │           ├─ buffer turn  │            │           │           │
 │             │           ├─ (debounce)   │            │           │           │
 │             │           ├─ USER_TURN_READY, v++      │           │           │
 │             │           ├──────────────►│            │           │           │
 │             │           │◄─ decision ───┤            │           │           │
 │             │           ├─ build context ───────────►│           │           │
 │             │           │◄─ messages[] ─────────────┤           │           │
 │             │           ├─ schedule(dueAt=v-guarded) ───────────►│           │
 │             │           │               │            │           │           │
 │             │           │            (dueAt) TIMER_EXPIRED        │           │
 │             │           │◄───────────────────────────────────────┤           │
 │             │           ├─ version check │            │           │           │
 │             │           ├─────────────────────────────────────────►│ send      │
 │             │           │◄────────────────────────────────────────── ok        │
 │             │           ├─ OUTGOING_MESSAGE_SENT     │           │           │
 │◄───────────────────────────────────────────────────────────────────┘           │
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
 │                 │                 │              │◄─ 1 decision ┤
 │                 │                 │   (all buffered messages treated as one turn)
```

## 3. User interrupts bot (pending messages)

```
User        IM          Pending Store      Jev                  Scheduler
 │ "never mind" │            │              │                     │
 ├─────────────►│            │              │                     │
 │              ├─ append + buffer          │                     │
 │              ├─ receive pending list ───►│                     │
 │              │            │              ├─ decision:           │
 │              │            │              │  action=replace,     │
 │              │            │              │  cancel=[msg_1]      │
 │              │◄───────────┴──────────────┤                     │
 │              ├─ cancel(msg_1) ────────────────────────────────►│
 │              ├─ v++ (turn ready)         │                     │
 │              ├─ generate fresh response ─► ...                 │
```

## 4. Topic switch

```
User        IM              Conversation State       Jev            LLM
 │ "forget pc, i got an interview"
 ├──────────►│               │                       │              │
 │           ├─ append; v++  │                       │              │
 │           ├─ turn ready ──┼──────────────────────►│              │
 │           │               │                       ├─ topicAction │
 │           │               │                       │  = "switch"  │
 │           │               │                       │  newTopic    │
 │           │◄──────────────┴───────────────────────┤              │
 │           ├─ TOPIC_CHANGED, update topic/topicStartedAt         │
 │           ├─ context horizon = recent_topic ────────────────────►│
 │           │               │                       │◄─ reply ─────┤
```

## 5. Activity change (async, no user input)

```
Clock/Routine        Routine Engine     Character State      Scheduler/IM        Jev
     │                    │                  │                   │               │
     ├─ slot boundary ───►│                  │                   │               │
     │                    ├─ ACTIVITY_CHANGED►                  │               │
     │                    │                  ├─ activity=idle    │               │
     │                    │                  ├─ derive speed/interruptibility     │
     │                    │                  ├─ if reply pending & sleeping:      │
     │                    │                  │   cancel/delay via IM ────────────►│
     │                    │                  │                   │  (decision)   │
```

## 6. Delayed follow-up (async, reuses scheduler)

```
User            IM                 Jev              Scheduler          Delivery
 │ "what are you doing"
 ├───────────────►│                │                 │
 │                ├───────────────►│                 │
 │                │◄─ respond now ("working")        │
 │                ├─ schedule reply ────────────────►│
 │◄─────────────────────────────────────────────────── ("working")
 │                │                │                 │
 │                │   (20 min later) TIMER_EXPIRED    │
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
   │
Scheduler fires original message (version 7)
   → IM checks: 7 !== 8  → do NOT send
   → replan with version 8 context
```

## 8. Context planning

```
IM            Context Store      Jev (context plan)     Context Builder      LLM
 │ candidates ─────►│                  │                     │              │
 │──────────────────┼─────────────────►│                     │              │
 │                  │◄─ horizon + include/exclude            │              │
 │                  ├───────────────────────────────────────►│             │
 │                  │   retrieve selected ──────────────────►│             │
 │                  │                  │   order + dedupe + budget           │
 │                  │                  │                     ├─────────────►│
 │                  │                  │                     │◄─ messages ──┤
```
