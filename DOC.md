# Human-Like Chatbot Architecture — Idea Analysis Brief

## Purpose

Analyze a proposed architecture for a human-like messaging chatbot built from three major layers:

1. **Custom application system** — deterministic state, timing, queues, persistence, scheduling, and delivery.
2. **Jev** — structured decisions and behavioral orchestration.
3. **LLM** — natural-language interpretation and generation.

The goal is to determine which ideas are possible, useful, and best implemented by each layer. The analyzer should also identify which seemingly different features can share the same underlying state, queues, scheduler, event system, or interaction manager.

Do not blindly accept every idea. Distinguish **technically possible** from **worth implementing**.

---

# 1. Starting Architecture

```text
                    ┌─────────────────────┐
                    │   Custom System     │
                    │                     │
                    │ State / Timing     │
                    │ Queues / Scheduler │
                    │ Persistence        │
                    │ Delivery           │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │        Jev          │
                    │                     │
                    │ Decisions           │
                    │ Classification      │
                    │ Behavioral policy  │
                    │ Interaction choice │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │        LLM          │
                    │                     │
                    │ Language            │
                    │ Dialogue            │
                    │ Character voice     │
                    │ Candidate messages  │
                    └─────────────────────┘
```

This is a hypothesis, not a fixed design. The analyzer should challenge it where appropriate.

Core principle:

> **The system executes. Jev decides. The LLM communicates.**

Some features will necessarily use all three.

---

# 2. Ideas to Analyze

Analyze each of the following.

## 2.1 Human-like message length

Support:

- Very short messages.
- Medium/long messages.
- One thought split across multiple messages.
- Context-dependent response length.

Determine whether this belongs to the character profile, Jev, LLM, message planner, or a combination.

## 2.2 Imperfect grammar

Support:

- Lowercase.
- Missing punctuation.
- Casual grammar.
- Slang.
- Abbreviations.
- Occasional typos.

Determine how to make this a tendency rather than a repetitive artificial rule.

## 2.3 Self-corrections

Example:

```text
i'll see you tomorow
*tomorrow
```

Analyze:

- LLM generation.
- Jev deciding whether to correct.
- Scheduler.
- Multiple-message infrastructure.

## 2.4 Multiple user messages

Example:

```text
wait
i forgot
what was i gonna say
oh yeah
my boss quit
```

Analyze:

- Message buffering.
- Quiet periods.
- Debouncing.
- Turn detection.
- Jev deciding whether the user is finished.

Determine whether this becomes a reusable input-turn manager.

## 2.5 Multiple bot messages

Example:

```text
wait what
your boss actually quit??
lmao
```

Analyze:

- Structured LLM output.
- Message scheduler.
- Timing.
- Cancellation.
- Interruption.

## 2.6 Message timing

Timing can depend on:

- Character.
- Activity.
- Time of day.
- Message importance.
- Attention.
- Conversation state.
- Previous message timing.
- Random variation.

Determine who decides timing and who actually executes timers.

## 2.7 Interruptions

A user can send another message while bot messages are scheduled.

Possible outcomes:

```text
continue
cancel
delay
replace
generate a new response
```

Determine whether this requires a general interaction manager.

## 2.8 Cancel vs continue scheduled messages

Jev should potentially inspect pending messages and decide per message:

```json
{
  "messageId": "msg_123",
  "action": "cancel"
}
```

or:

```json
{
  "messageId": "msg_123",
  "action": "continue"
}
```

Potentially also:

```text
delay
replace
```

Analyze message lifecycle states and scheduler ownership.

## 2.9 Topic switching / latching

The bot can:

- Continue the current topic.
- Switch to a new topic.
- Acknowledge a new topic and return.
- Ignore it temporarily.
- Ask about it.

Determine whether this is primarily a Jev decision, conversation-state problem, topic-tracking problem, LLM problem, or combination.

## 2.10 Conversation momentum

Possible state:

```ts
{
  topic: string
  strength: number
  startedAt: number
}
```

Determine whether explicit topic momentum is useful or redundant with normal LLM context.

## 2.11 Character activity

Possible activities:

```text
idle
working
studying
gaming
eating
watching something
commuting
sleeping
away
```

Activity can affect:

- Response speed.
- Message length.
- Interruptibility.
- Attention.
- Willingness to talk.

Determine how activity should be represented and who changes it.

## 2.12 Device/local time

A loose daily routine may affect:

```text
morning → waking/getting ready
day → working
evening → free time
night → winding down/sleeping
```

Analyze whether this should be deterministic, probabilistic, or Jev-controlled.

## 2.13 Availability

Possible states:

```text
available
busy
away
sleeping
offline
```

Determine whether binary availability is enough or whether it should be derived from activity, attention, interruptibility, and response speed.

## 2.14 Interruptibility

Examples:

```text
idle → high
gaming → medium
working → low
sleeping → almost none
```

Analyze how message importance can override normal interruptibility.

## 2.15 Attention capture

A new message can change attention:

```text
attention = 0.2
```

becoming:

```text
attention = 0.9
```

for an important message.

Determine whether this adds meaningful behavior or unnecessary state.

## 2.16 Response speed

Possible values:

```text
very fast
fast
normal
slow
very slow
```

Determine whether speed should be character state, Jev output, or a deterministic calculation.

## 2.17 Not responding

The bot can decide not to respond immediately because it is:

- Busy.
- Sleeping.
- Distracted.
- Not given anything requiring a response.
- Choosing to respond later.

Analyze how to avoid random/frustrating non-response and whether a follow-up action should be scheduled.

## 2.18 Delayed follow-up

Example:

```text
User: what are you doing
Bot: working

20 minutes later:
Bot: done finally
```

Determine whether this can reuse the normal scheduler.

## 2.19 Daily routine

A character can have a loose routine with variation.

Determine whether routines should generate:

- Activity state.
- Availability.
- Response speed.
- Style changes.
- Scheduled events.

## 2.20 Social state

Potential state:

```ts
{
  energy: number
  sociability: number
  patience: number
  interest: number
}
```

Determine whether these variables add useful behavior or unnecessary complexity, and whether they can be derived from other state.

## 2.21 Mood

Possible states:

```text
neutral
happy
tired
annoyed
excited
distracted
```

Analyze whether mood should be explicit, inferred, transient, persisted, controlled by Jev, or simply expressed by the LLM.

## 2.22 Character personality

Profiles may contain:

```text
personality
interests
dislikes
speech patterns
quirks
habits
communication style
```

Determine which are static profile data and which should be dynamic state.

## 2.23 Example conversations

Examples should demonstrate:

- Normal behavior.
- Multiple messages.
- Interruptions.
- Corrections.
- Topic switching.
- Jokes.
- Disagreement.
- Confusion.
- Excitement.
- Conversation endings.
- Activity-related behavior.

Analyze whether examples should be static, tagged, retrieved, or eventually vector-searched.

## 2.24 Character quirks

Examples:

```text
sometimes says "wait"
sometimes says "lol"
sometimes corrects herself
occasionally changes topics
sometimes sends a second message immediately
```

Analyze how to model tendencies without producing deterministic repetitive behavior.

## 2.25 User behavior modeling

Potential signals:

- User sends many short messages.
- User sends long paragraphs.
- User replies quickly.
- User disappears for hours.
- User changes topics frequently.
- User asks many questions.
- User tells long stories.

Determine whether and how the bot should adapt to these patterns.

## 2.26 Relationship state

Potential future state:

```text
familiarity
trust
closeness
conversational comfort
```

Determine whether this is useful and what behaviors it should actually affect.

## 2.27 Typing/presence indicators

Analyze whether:

```text
typing...
online
away
last seen
```

are worth simulating and which are controlled by the external platform versus the custom system.

## 2.28 Stale response detection

Example:

```text
LLM generates:
"what happened?"

User:
"never mind"
```

Analyze whether generated responses need:

```text
generationId
conversationVersion
creation timestamp
```

and whether the scheduler should verify that a response is still valid before sending.

## 2.29 Event-driven architecture

Potential events:

```text
USER_MESSAGE_RECEIVED
USER_TURN_READY
JEV_DECISION_CREATED
LLM_RESPONSE_GENERATED
OUTGOING_MESSAGE_SCHEDULED
OUTGOING_MESSAGE_CANCELLED
OUTGOING_MESSAGE_SENT
ACTIVITY_CHANGED
ATTENTION_CHANGED
CONVERSATION_TOPIC_CHANGED
TIMER_EXPIRED
```

Determine whether an event-driven design is justified or unnecessarily complex.

---

# 3. Layer Responsibility Analysis

For every feature, classify it as:

### Application System

Best for:

- Timers.
- Persistent state.
- Queues.
- Scheduling.
- Cancellation mechanics.
- External API calls.
- Message delivery.
- Deterministic constraints.
- State transitions.
- Validation.

### Jev

Best for:

- Structured decisions.
- Choosing among actions.
- Deciding whether to respond.
- Deciding whether to wait.
- Comparing conversation priorities.
- Deciding whether to interrupt.
- Deciding whether to continue/cancel/delay.
- Choosing high-level response behavior.

### LLM

Best for:

- Natural-language generation.
- Nuanced interpretation.
- Dialogue.
- Character voice.
- Candidate responses.
- Expressing emotion naturally.
- Producing self-corrections or conversational phrasing.

### Combined

Many features should use all three:

```text
Incoming message
    ↓
System captures event/state
    ↓
Jev decides behavior
    ↓
LLM generates candidate language
    ↓
System schedules messages
    ↓
Jev can reconsider pending actions
    ↓
System sends/cancels
```

---

# 4. Find Shared Infrastructure

Actively identify features that can share the same implementation.

Investigate whether the following can become reusable primitives.

## Conversation State

Potentially shared by:

- Topic tracking.
- Momentum.
- User turn aggregation.
- Interruptions.
- Memory.
- Response generation.

## Event Scheduler

Potentially shared by:

- Response delays.
- Multiple messages.
- Follow-ups.
- Delayed replies.
- Activity changes.
- Routine transitions.
- Message cancellation.

## Pending Action Queue

Potentially shared by:

- Outgoing messages.
- Follow-ups.
- Activity changes.
- Routine events.
- Other future actions.

## Interaction Manager

Potentially shared by:

- Interruptions.
- Topic switching.
- Cancellation.
- Delay changes.
- New user messages.
- Stale response detection.
- Replanning.

## Character State

Potentially shared by:

- Activity.
- Availability.
- Attention.
- Interruptibility.
- Response speed.
- Mood.
- Energy.

## Behavior Decision

Potentially shared by:

- Should respond.
- Should wait.
- Should interrupt.
- Should cancel.
- Should continue.
- Should switch topic.
- Should ask a question.
- Should split messages.

---

# 5. Find Redundant Concepts

Explicitly identify state that may overlap.

Investigate combinations such as:

```text
mood
energy
attention
activity
availability
interruptibility
```

For example:

```text
activity = working
    ↓
attention = low
response speed = slow
interruptibility = low
```

might be preferable to independently persisting all four.

Also investigate overlap between:

```text
current topic
topic momentum
conversation priority
```

Recommend the smallest coherent state model.

---

# 6. Determine Which Decisions Should Be Jev Decisions

Evaluate decisions such as:

```text
Should I respond?
Should I wait?
Should I interrupt my activity?
Should I continue the current topic?
Should I switch topics?
Should I cancel a scheduled message?
Should I delay a scheduled message?
Should I generate a new response?
How many messages should I send?
How short should they be?
Should I ask a question?
Should I acknowledge the new topic?
```

Determine:

- Which decisions are actually useful.
- Which can be deterministic.
- Which can be combined into one structured Jev call.
- Which do not justify a Jev call.

Avoid dozens of tiny Jev calls if one structured decision can reasonably handle the same state.

---

# 7. Determine Which Decisions Should Be Deterministic

Look for behaviors that should remain in application code:

```text
Message scheduling.
Timer execution.
Cancellation mechanics.
Message persistence.
Conversation versioning.
Maximum message count.
Maximum delay.
Rate limits.
Routine boundaries.
State persistence.
External API delivery.
```

Explain why each should or should not remain deterministic.

---

# 8. Determine What Actually Needs the LLM

Look for places where an LLM is appropriate:

```text
Natural response wording.
Character voice.
Nuanced interpretation.
Dialogue coherence.
Storytelling.
Expressing reactions.
Writing a self-correction.
Generating candidate messages.
```

Also identify places where using an LLM would be unnecessary or wasteful.

---

# 9. Avoid Overengineering

Categorize every feature into:

### MVP

Required for a useful initial system.

### Useful Next

Meaningfully improves behavior but depends on the MVP.

### Experimental

Interesting enough to prototype but not proven necessary.

### Probably Unnecessary

Adds complexity without a clear behavioral benefit.

The analyzer should justify these classifications.

---

# 10. Analyze State Ownership

For every important state variable, answer:

1. Who creates it?
2. Who modifies it?
3. Who reads it?
4. Is it persisted?
5. Is it derived?
6. Does Jev need it?
7. Does the LLM need it?
8. Can it become stale?
9. What invalidates it?

Consider:

```text
Character profile
Character activity
Attention
Availability
Interruptibility
Response speed
Conversation topic
Topic momentum
Pending user messages
Pending bot messages
Scheduled actions
Conversation version
User behavior
Memory
Mood
Routine
```

---

# 11. Analyze Timing Ownership

For every timing behavior, determine:

### Who decides?

For example:

```text
Jev:
"respond slowly"

System:
"delay = 4.2 seconds"
```

is potentially preferable to:

```text
Jev:
"wait exactly 4.237 seconds and execute at timestamp X"
```

The application should own actual clock/timer execution.

Jev may select a behavioral timing category or bounded delay.

Analyze the best division.

---

# 12. Analyze Concurrency and Race Conditions

Consider:

```text
LLM generating response
+
user sends another message
+
activity changes
+
scheduled message becomes due
```

Determine how to prevent stale/conflicting actions.

Potential primitives:

```text
generationId
conversationVersion
actionId
scheduledMessageId
stateVersion
```

Do not introduce all of them automatically. Determine which are necessary.

Consider:

- Per-conversation queues.
- Serialized event processing.
- Cancellation tokens.
- Optimistic version checks.
- Concurrent LLM generations.

---

# 13. Analyze Human-Likeness vs Complexity

For every feature, distinguish:

> Technically possible.

from:

> Likely to improve the experience.

Assess:

```text
Behavioral value
Implementation complexity
Potential annoyance
Potential unpredictability
Interaction with other features
Maintenance cost
```

More randomness should not automatically be considered more human-like.

---

# 14. Recommended Feature Matrix

Produce a table like:

| Feature | Possible? | Primary Layer | Supporting Layers | Shared Infrastructure | Complexity | Value | Recommendation |
|---|---|---|---|---|---|---|---|
| Multiple user messages | Yes | System | Jev | Message buffer / turn manager | Low | High | MVP |
| Scheduled bot messages | Yes | System | Jev | Scheduler | Medium | High | MVP |
| Cancel pending messages | Yes | System | Jev | Scheduler / interaction manager | Medium | High | MVP |
| Topic switching | Yes | Jev | LLM + System | Conversation state | Medium | High | Next |
| Daily routine | Yes | System | Jev | Character state / scheduler | Medium | Medium | Next |
| Mood | Yes | TBD | TBD | Character state | TBD | TBD | Evaluate |

The actual classifications must be based on the analysis.

---

# 15. Analyze Data Flow

Produce sequence diagrams for at least:

## Normal response

```text
User
 ↓
System
 ↓
Jev
 ↓
LLM
 ↓
System
 ↓
Scheduler
 ↓
User
```

## Multiple user messages

```text
User
 ↓
Message Buffer
 ↓
Turn Detection
 ↓
Jev
 ↓
LLM
```

## User interrupts bot

```text
User
 ↓
System
 ↓
Pending Actions
 ↓
Jev
 ↓
Cancel / Continue / Delay / Replace
 ↓
Scheduler
```

## Topic switch

```text
User
 ↓
Conversation State
 ↓
Jev
 ↓
Switch / Continue / Acknowledge
 ↓
LLM
```

## Activity change

```text
Clock / Timer
 ↓
Routine Engine
 ↓
Character State
 ↓
Jev uses updated state
```

---

# 16. Analyze the Core Interaction Manager

Determine whether the following should be one reusable subsystem:

```text
Incoming user events
        +
Current conversation state
        +
Pending generated messages
        +
Scheduled actions
        +
Jev decisions
        ↓
Interaction Manager
        ↓
send / cancel / delay / replace / replan
```

If this is a useful abstraction, define its responsibilities and boundaries.

Do not let the LLM directly manipulate the scheduler.

Do not let Jev directly execute timers.

---

# 17. Analyze Candidate Message Lifecycle

Determine whether outgoing messages should have a lifecycle such as:

```text
generated
    ↓
planned
    ↓
scheduled
    ↓
ready
    ↓
sending
    ↓
sent
```

with possible cancellation:

```text
planned → cancelled
scheduled → cancelled
ready → cancelled (if still safe)
```

Determine when cancellation should no longer be allowed.

---

# 18. Analyze Stale Responses

A response may become invalid after generation.

Example:

```text
LLM:
"what happened?"

User:
"never mind"
```

Determine whether the system needs response validity checks immediately before delivery.

Possible concepts:

```text
conversationVersion
generationId
stateVersion
```

Recommend the simplest reliable solution.

---

# 19. Analyze Character State vs Derived State

Determine which values should be persisted and which should be calculated.

For example:

```text
activity = working
```

may be persisted.

But:

```text
responseSpeed = slow
interruptibility = low
```

might be derived from:

```text
activity + character profile + current attention
```

Avoid duplicating derived values unless there is a concrete performance or architectural reason.

---

# 20. Analyze Example Conversations

Determine the best way to represent examples.

Potential metadata:

```ts
{
  scenario: string
  topic?: string
  emotionalContext?: string
  behaviors: string[]
  messages: Message[]
}
```

Analyze whether retrieval should initially be:

1. Manually selected.
2. Tag-based.
3. Keyword-based.
4. Semantic retrieval.
5. Vector search.

Prefer the simplest approach that is likely to work.

---

# 21. Analyze Multi-Character Support

The same conversation engine should ideally support:

```text
Mika
Alex
Jordan
Sara
...
```

without duplicating:

- Message buffers.
- Scheduler.
- Interaction Manager.
- Jev integration.
- LLM integration.
- Conversation state engine.

Character-specific behavior should live primarily in:

```text
Character Profile
Examples
Routine
Activity tendencies
Behavior configuration
```

Determine whether this separation is sufficient.

---

# 22. Analyze Failure Handling

Consider:

### Jev unavailable

Can the system fall back to deterministic defaults?

### LLM unavailable

Can the system retry without sending malformed output?

### Scheduler failure

Can scheduled messages be recovered?

### Delivery failure

Can messages be retried safely?

### User sends a message while generation is running

What happens?

### Character state changes while a response is pending

What happens?

### Application restarts

What happens to scheduled actions?

Recommend concrete behavior for each.

---

# 23. Analyze the Minimal State Model

Propose the smallest useful version of:

```ts
CharacterState
ConversationState
PendingUserTurn
PendingOutgoingAction
ScheduledMessage
BehaviorDecision
```

Do not create state objects simply because they sound conceptually useful.

Explain why each field exists.

---

# 24. Analyze Event Model

Determine whether the following are useful:

```text
USER_MESSAGE_RECEIVED
USER_TURN_READY
BEHAVIOR_DECISION_CREATED
LLM_GENERATION_STARTED
LLM_RESPONSE_GENERATED
OUTGOING_MESSAGE_SCHEDULED
OUTGOING_MESSAGE_CANCELLED
OUTGOING_MESSAGE_SENT
ACTIVITY_CHANGED
ATTENTION_CHANGED
TOPIC_CHANGED
TIMER_EXPIRED
CONVERSATION_INTERRUPTED
```

Recommend the minimum event set required.

---

# 25. Final Deliverable Required From the Analyzing AI

Produce a comprehensive technical architecture review containing:

## A. Executive Summary

Recommended architecture in plain language.

## B. Feature Feasibility Matrix

Every proposed feature.

## C. Layer Responsibility Matrix

System vs Jev vs LLM vs Combined.

## D. Shared Infrastructure Map

Show which features reuse:

- State.
- Queues.
- Scheduler.
- Event system.
- Interaction Manager.
- Character-state engine.

## E. State Model

Smallest coherent state representation.

## F. Event Model

Important events and transitions.

## G. Timing Model

Who decides timing and who executes it.

## H. Jev Decision Model

Which decisions should be bundled into Jev calls.

## I. LLM Contract

What the LLM receives and what structured output it should return.

## J. Architecture Diagram

Clear system diagram.

## K. Sequence Diagrams

Important interaction flows.

## L. MVP Scope

Smallest useful implementation.

## M. Future Features

Group by dependency.

## N. Risks

Include:

- Overengineering.
- State explosion.
- Excessive Jev calls.
- Excessive LLM calls.
- Timing complexity.
- Race conditions.
- Stale responses.
- Unnatural behavior.
- Excessive randomness.
- Maintenance complexity.

## O. Implementation Order

Give a dependency-aware sequence for building the system.

---

# 26. Constraints for the Analysis

The analyzer should:

- Be critical rather than simply agreeing.
- Prefer simple reusable primitives.
- Avoid duplicated state.
- Keep deterministic execution in application code.
- Keep structured decisions in Jev.
- Keep natural language in the LLM.
- Look for features that are actually the same underlying problem.
- Consider failure, concurrency, and stale state.
- Distinguish feasibility from usefulness.
- Avoid assuming every behavior needs Jev.
- Avoid assuming every behavior needs the LLM.
- Prefer one reusable conversation engine for many characters.
- Avoid prematurely introducing vector databases, complex event buses, or other infrastructure unless the analysis establishes a concrete need.
- Explain tradeoffs when multiple architectures are viable.

The final result should be a **technical architecture analysis and consolidation plan**, not merely a list of chatbot features.


---

# 30. Context Management and Context Planning

The system should have an explicit context-management subsystem rather than simply sending the latest N conversation messages to the LLM.

The purpose is to give the LLM enough information to understand the current situation while avoiding irrelevant history and unnecessary token usage.

Conceptual flow:

```text
Conversation History
       │
       ▼
┌──────────────────────┐
│ Context Store        │
│                      │
│ Recent messages      │
│ Older messages       │
│ Summaries            │
│ Topics               │
│ Memories             │
│ Examples             │
│ Current state        │
└──────────┬───────────┘
           │
           ▼
     ┌───────────┐
     │    Jev    │
     │ Context   │
     │ Planning  │
     └─────┬─────┘
           │
           ▼
┌──────────────────────┐
│ Context Builder      │
│                      │
│ Retrieve             │
│ Filter               │
│ Order                │
│ Deduplicate          │
│ Apply token budget   │
│ Annotate             │
└──────────┬───────────┘
           │
           ▼
         LLM
```

## 30.1 Context Layers

Analyze whether context should be divided into layers such as:

### Immediate Context

Usually highest priority:

```text
Current user turn
Recent user messages
Recent bot messages
Pending bot messages
Current interaction state
```

### Conversational Context

Relevant to the active discussion:

```text
Current topic
Previous discussion of the topic
Unresolved questions
Recent topic switches
Conversation momentum
```

### Long-Term Context

Potentially relevant older information:

```text
User preferences
Known facts
Important past events
Past conversations
Relationship state
```

### Character Context

Information about the character:

```text
Character profile
Communication style
Current activity
Current state
Relevant example conversations
```

### System Context

Current execution state:

```text
Current time
Current activity
Attention
Interruptibility
Pending actions
Jev behavior decision
Response constraints
```

Determine which layers are necessary and which should be derived.

---

## 30.2 Jev as Context Planner

Jev may be used to determine what context is relevant.

However, Jev should not directly retrieve arbitrary database records.

The preferred conceptual separation is:

```text
System:
"These are the context candidates available."

Jev:
"These candidates are relevant."

System:
"Build the actual LLM context from that decision."
```

Example candidates:

```json
{
  "current_messages": [...],
  "recent_messages": [...],
  "older_topics": [
    {
      "id": "topic_12",
      "summary": "User was troubleshooting their PC."
    },
    {
      "id": "topic_18",
      "summary": "User recently discussed buying a keyboard."
    }
  ],
  "memories": [
    {
      "id": "memory_4",
      "text": "User uses a Windows PC."
    }
  ]
}
```

Jev might return a structured plan such as:

```json
{
  "include": [
    "current_messages",
    "recent_messages",
    "topic_18"
  ],
  "exclude": [
    "topic_12"
  ]
}
```

The analyzer should determine whether this is the best design or whether context selection can be made more deterministic.

---

## 30.3 Context Horizon

Analyze whether Jev should select a semantic context horizon rather than exact message indexes.

Potential horizons:

```text
current_turn
recent
recent_topic
current_conversation
long_term
```

Or:

```text
last N messages
since topic started
since last interruption
since last unresolved question
relevant historical context
```

The goal is to prevent Jev from becoming tightly coupled to the database implementation.

For example:

```json
{
  "historyDepth": "recent_topic"
}
```

could be translated by the application into actual message retrieval.

---

## 30.4 Context Budget

The context system should have explicit limits.

Potential configuration:

```ts
type ContextBudget = {
  maxTotalTokens: number
  maxRecentMessages: number
  maxMemories: number
  maxTopicHistory: number
  maxExamples: number
}
```

Analyze whether different context categories should have reserved budgets or whether the system should use a single dynamic budget.

The system should prioritize relevant information rather than simply filling the available context window.

---

## 30.5 Context Items

Consider representing retrieved context internally as:

```ts
type ContextItem = {
  id: string

  type:
    | "message"
    | "summary"
    | "memory"
    | "topic"
    | "example"
    | "state"

  content: string

  relevance?: number
  source?: string
  createdAt?: number
}
```

Metadata should primarily be for internal selection and debugging.

The analyzer should determine what metadata is actually useful.

---

## 30.6 Why Was Context Selected?

The system should ideally make context selection explainable.

For example:

```text
Context item:
"User was considering a Keychron keyboard."

Reason:
Relevant to current topic.

Selected by:
Jev context decision.

Source:
Conversation summary from two weeks ago.
```

This will help debug situations where the LLM appears to know something it should not have been given.

Analyze how much context provenance should be retained.

---

## 30.7 Topic-Relevant History

Do not assume the latest messages are always the most useful messages.

Example:

```text
User:
my pc keeps crashing

...

20 messages later

User:
also i finally bought that keyboard
```

The conversation may contain a large amount of irrelevant PC troubleshooting history.

The context system should potentially retrieve:

```text
Current topic:
keyboard

Relevant history:
User previously discussed wanting a Keychron keyboard.

Irrelevant history:
Old PC troubleshooting messages.
```

Analyze whether topic-based retrieval should be implemented before semantic/vector retrieval.

---

## 30.8 Unresolved Conversation Items

Track potentially unfinished conversational threads.

Example:

```text
User:
my interview is tomorrow

Bot:
wait what position?

User:
software engineer

Bot:
oh nice

User:
yeah i'm nervous
```

Potential unresolved context:

```ts
{
  topic: "user interview",
  state: "unresolved",
  possibleFollowUp: "ask how the interview went"
}
```

Later:

```text
User:
hey
```

The system can surface the unresolved topic.

Jev decides whether to bring it up.

The LLM decides how to phrase it.

Analyze whether unresolved-topic tracking should be part of:

- Conversation state.
- Memory.
- Context retrieval.
- Jev planning.

---

## 30.9 Context and Interruptions

Context should be re-evaluated when the conversation changes.

Example:

```text
Bot is preparing:
"what happened with your PC?"
```

User:

```text
actually forget the pc
i got an interview
```

The context planner should now prioritize:

```text
new topic: interview
```

and potentially deprioritize:

```text
old topic: PC
```

Analyze whether context planning should run:

- Before every LLM generation.
- When a user turn completes.
- When a topic changes.
- When a scheduled response is reconsidered.
- When a stale-response check occurs.

---

## 30.10 Context and Pending Messages

The LLM may generate messages based on one context state, but that context can become stale before delivery.

Example:

```text
Context:
User is discussing PC problems.

Generated:
"what happened with it?"
```

Before sending:

```text
User:
never mind
```

The response may now be invalid.

The analyzer should determine whether pending messages need to retain:

```text
contextVersion
conversationVersion
generationId
```

and whether the scheduler should verify context validity before sending.

---

## 30.11 Context Assembly Contract

Analyze a possible pipeline:

```text
1. Collect current conversation state.
2. Collect context candidates.
3. Ask Jev for context priorities/horizon.
4. Retrieve the requested context.
5. Apply token/size budget.
6. Order the context.
7. Add character state and behavior decision.
8. Build the LLM input.
9. Generate response.
```

Determine whether some steps should be merged or reordered.

---

## 30.12 Context Sources

Analyze potential sources:

```text
Recent conversation
Conversation summaries
Topic summaries
Long-term memory
User profile
Character profile
Example conversations
Current character state
Current activity
Pending actions
Unresolved topics
Current time
```

Classify each as:

```text
always available
conditionally retrieved
derived
optional
probably unnecessary
```

---

## 30.13 Example Retrieval

Example conversations should be treated as a context source.

Potential selection signals:

```text
character
scenario
topic
emotion
behavior
response format
current activity
```

Determine whether examples should initially be selected through:

1. Manual selection.
2. Tags.
3. Keywords.
4. Simple scoring.
5. Semantic retrieval.
6. Vector search.

Prefer the simplest approach that works.

---

## 30.14 Context Ownership

For every context source, determine:

1. Where is it stored?
2. Who retrieves it?
3. Who decides whether it is relevant?
4. Who formats it?
5. Who enforces its size limit?
6. Does Jev see the raw content or a summary?
7. Does the LLM see the raw content or a summary?
8. How does it expire?
9. How is it updated?

---

## 30.15 Context Failure Handling

Analyze fallback behavior when:

- Context retrieval fails.
- Jev context planning fails.
- A summary is unavailable.
- Memory is unavailable.
- The token budget is exceeded.
- Retrieved context conflicts with current conversation.
- Old context is stale.
- Context selection is too broad.

The system should still be able to generate a reasonable response using immediate context.

---

## 30.16 Important Architectural Question

Determine whether context planning should be a separate subsystem:

```text
Conversation State
       ↓
Context Planner
       ↓
Context Builder
       ↓
LLM
```

or whether it should be integrated into the Interaction Manager.

Compare both approaches and recommend one based on complexity and reuse.

---

## 30.17 Context Analysis Deliverables

The analyzing AI should add the following to its final architecture review:

### Context Architecture

Show how context flows from storage to Jev to the LLM.

### Context Source Matrix

| Source | Always Included? | Jev Selects? | Retrieved Dynamically? | Stored? |
|---|---|---|---|---|
| Current user turn | Usually | No | No | Yes |
| Recent messages | Usually | Possibly | No | Yes |
| Topic history | No | Yes | Yes | Yes |
| Memory | No | Yes | Yes | Yes |
| Character profile | Usually | Possibly | No | Yes |
| Examples | No | Yes | Yes | Yes |
| Activity/state | Usually | Possibly | No | Yes/derived |

### Context State Model

Recommend the minimum state needed.

### Context Retrieval Strategy

Recommend the simplest viable first implementation and identify when more advanced retrieval would become justified.

### Context Invalidation

Explain when cached/retrieved context becomes stale.

### Context + Scheduler Interaction

Explain how context validity affects scheduled outgoing messages.

### Context + Jev Interaction

Explain which context decisions are worth delegating to Jev.

### Context + LLM Contract

Define exactly what the LLM receives and which information should remain outside its control.

