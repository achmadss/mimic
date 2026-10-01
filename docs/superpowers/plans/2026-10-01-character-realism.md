# Mimic Character Realism + Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a character behave like someone with a life — activity that actually changes through the day, a mood, visible typing — and make a new persona something you can author in one JSON file and bind to Telegram, Discord, or both, with no code change.

**Architecture:** The core loop is unchanged (turn aggregation → one Jev request → LLM → scheduled delivery). This plan adds a **Routine Engine** that owns `character_state.activity`, derives it from a per-character daily `routine` in the character's own timezone, and notifies the conversations that have a reply in flight so Jev can re-decide. Mood is a second scalar on the same row, set by Jev and read by the prompt. Typing and Discord presence are **views** of scheduled messages (doc 06 §2.27), never new state. Authoring is a wider profile schema plus a template file.

**Tech Stack:** unchanged — TypeScript (strict, ESM) on Node ≥ 22, `better-sqlite3`, `zod` v4, `grammy`, `discord.js`; tests on `node:test` + `tsx`.

**Spec:** `docs/02-state-model.md` §1 (`CharacterState`, `RoutineSlot`), `docs/03-events-and-scheduling.md` §6, `docs/04-jev-and-llm.md` §1 (question table), `docs/06-feature-matrix.md` §2.21 (mood), §2.27 (presence).

## Global Constraints

- Everything in the core-loop plan's Global Constraints still holds: no new runtime dependencies, all time through `Clock`, every state write commits in one `store.tx(...)` with its event, conversation id = `${characterId}:${platform}:${chatId}`.
- `npm test` and `npm run typecheck` must both pass at the end of every task.
- **Activity is derived, not scheduled.** The stored row is a cache with an event trail; `activityAt(profile, now)` is the truth. Boot recomputes it rather than replaying a missed transition.

## Spec deltas (deliberate, keep the docs' intent)

- **Routine transitions are not rows in `actions`.** Doc 02 lists `routine_transition` as a `ScheduledAction`. It does not need to be durable: `activityAt()` is a pure function of the clock, so a transition missed during downtime is recomputed at boot instead of fired late — strictly better than the catch-up rule in doc 03 §6. The engine holds its own `Clock` timer per character.
- **Mood is persisted on `character_state`, not "transient".** Doc 02 §1 calls it transient. A value that has to survive a restart and be visible to the *next* turn is persisted state by definition; it expires on a TTL instead (Task 3).
- **Character-level actions still live outside `actions`.** `actions.conversation_id` is `NOT NULL` and the table is conversation-scoped. Both new timers (routine, typing) are in-memory because both are recomputable from the clock — no schema change, no rebuild migration.
- **`delayHint` is still out.** Jev owns pace; letting the LLM also choose a delay gives two owners to one decision.
- **No per-character fallbacks.** The audit suggested a shy character falling back to `later` when Jev is unsure. Doc 03 §6 deliberately fixes the Jev-unavailable default at `now` + cancel-all ("a stale reply is worse than a missing one"). A profile knob that can silently contradict a safety decision is not worth the schema surface.

## Review Focus

1. **The bot is down across a routine boundary** (e.g. asleep 02:30 → 07:00). On boot the character must be in the *current* slot, not the one it was in when it stopped. Test: Task 2 "activityAt is a function of the clock, not of history".
2. **Activity changes while a reply is in flight.** A message scheduled 2 min out must not be sent by a character who has since gone to sleep. Test: Task 7 "activity change re-decides pending".
3. **Jev unavailable during an activity change** → pending sends cancel rather than fire. Test: Task 7.
4. **A persona authored only in JSON** works end to end, on Telegram, Discord, or both, with no code edit. Test: Task 1 "template loads"; manual check in Task 8.
5. **Typing never outlives its message.** A cancelled or delivered message must stop the typing indicator. Test: Task 6 "typing plan follows the message".
6. **Timezone correctness.** `"07:00"` in the profile means 07:00 *for the character*, at any month of the year. Test: Task 2 "routine respects the character timezone across DST".

---

## File Structure

```
characters/_template.json          NEW  copy this to add a persona
characters/README.md               NEW  how to author one, token env vars, platform choice
src/
  types.ts                         mood type, CharacterState.mood
  character/profile.ts             wider schema, skips `_`-prefixed files
  character/routine.ts             NEW  activityAt / nextTransitionAt / slotTimes
  character/routine-engine.ts      NEW  owns timers + character_state writes (needs a class; below)
  character/mood.ts                NEW  moodNow (TTL)
  jev/questions.ts                 mood question, activity_changed question set
  jev/state.ts                     timestamps + mood into Jev's state
  jev/decide.ts                    mood out of the answers
  llm/prompt.ts                    structured character, mood line, slang suppression
  im/respond.ts                    activity_changed trigger, count safety net
  im/manager.ts                    routine engine wiring, typing plan
  delivery/types.ts                showTyping?, typingRefreshMs?, setPresence?
  delivery/telegram.ts             showTyping
  delivery/discord.ts              showTyping, setPresence
  main.ts                          start/stop the routine engine
test/  routine.test.ts, mood.test.ts, typing.test.ts + edits to character/jev/llm/manager
```

---

### Task 1: A character you can author

**Files:**
- Modify: `src/character/profile.ts`, `characters/rick.json`, `characters/morty.json`
- Create: `characters/_template.json`, `characters/README.md`
- Test: `test/character.test.ts`

**Interfaces:**
- Produces: `ProfileSchema` gaining `identity`, `traits`, `likes`, `dislikes`, `quirks`, `stats?`, `routine`, and keeping `persona` as the prose summary. `loadProfiles(dir)` skips files whose name starts with `_`.

- [ ] **Step 1: Extend the schema**

```ts
const RoutineSlotSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "start must be HH:MM"),
  activity: z.enum(ACTIVITIES),
  /** Boundary varies by ± this many minutes, seeded per character per day. 0 = exact. */
  jitterMin: z.number().int().min(0).max(180),
});

// in ProfileSchema:
  identity: z.object({
    age: z.string().min(1),
    occupation: z.string().min(1),
    background: z.string().min(10),
    /** Who the person they are texting is to them. */
    relationship: z.string().min(5),
  }),
  traits: z.array(z.string().min(1)).min(1),
  likes: z.array(z.string().min(1)),
  dislikes: z.array(z.string().min(1)),
  /** Habits and verbal tics the model should reach for. */
  quirks: z.array(z.string().min(1)),
  /** Optional character sheet, rendered as "intelligence 10/10, patience 2/10". Nothing computes on it. */
  stats: z.record(z.string(), z.number()).optional(),
  routine: z.array(RoutineSlotSchema).min(1),
```

- [ ] **Step 2: Skip template files in the loader**

```ts
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
```

- [ ] **Step 3: Write `characters/_template.json` and `characters/README.md`**

The template is a complete, loadable persona (a third character: a night-shift nurse) that doubles as the documentation. `README.md` covers: copy the template to `<id>.json`, set `characterId` to match the filename, pick `platforms` (telegram, discord, both, or neither for `--cli`), add the token env vars to `.env`, and restart — `main.ts` already loops over every profile.

- [ ] **Step 4: Fill in Rick and Morty**

Rick — traits `["arrogant","sarcastic","brutally honest","easily bored","nihilistic"]`, likes `["his own inventions","cheap vodka","being right","his granddaughter"]`, dislikes `["Jerry","authority","sentimentality","explaining himself"]`, quirks `["calls people by insulting nicknames","answers a question with a better question"]`, stats `{ "intelligence": 10, "patience": 2, "empathy": 3, "chaos": 10 }`.

Morty — traits `["anxious","kind-hearted","easily flustered","loyal","quick to apologise"]`, quirks `["stammers when nervous","asks permission before stating an opinion"]`, stats `{ "intelligence": 5, "patience": 8, "empathy": 9, "chaos": 3 }`.

Routines: Rick `07:00 idle / 10:00 working / 18:30 eating / 20:00 working / 02:30 sleeping`, jitter 30–90. Morty `07:00 commuting / 08:30 studying / 15:30 idle / 18:00 eating / 21:00 gaming / 23:30 sleeping`, jitter 20–45.

- [ ] **Step 5: Test, typecheck, commit**

Tests: schema rejects a bad `start` (`"25:00"`) and an empty `routine`; `loadProfiles("characters")` returns exactly `morty`, `rick` (the template is skipped); the template parses.

```bash
git add -A && git commit -m "feat: widen the character profile into something you can author"
```

---

### Task 2: `routine.ts` — activity as a function of the clock

**Files:**
- Create: `src/character/routine.ts`
- Test: `test/routine.test.ts`

**Interfaces:**
- Consumes: `CharacterProfile`, `Activity`, `seededUnit`.
- Produces: `slotBoundaries(profile, now): number[]` (epoch ms, ascending, for the local day containing `now`), `activityAt(profile, now): { activity: Activity; since: number }`, `nextTransitionAt(profile, now): number`.

**Design — the one tricky part, timezone conversion:**

```ts
/** Minutes since local midnight for the character's timezone at instant `at`. */
function localMinutes(tz: string, at: number): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
    .formatToParts(at);
  return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
}

/** The instant local midnight started, for the local day containing `at`. */
function localDayStart(tz: string, at: number): number {
  return at - localMinutes(tz, at) * 60_000;
}

/** "HH:MM" on the local day containing `at`, as epoch ms. */
function atLocalTime(tz: string, at: number, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return localDayStart(tz, at) + (h * 60 + m) * 60_000;
}
```

Jitter is seeded `seededBetween(-jitterMin, jitterMin, characterId, "routine", localDateKey, slot.start)` so a given character gets the same boundaries all day and different ones tomorrow — reproducible in tests, varied in life.

`activityAt` sorts today's boundaries, takes the last one `≤ now`; if `now` is before the first, it rolls back to yesterday's last slot. That is what makes Review Focus #1 pass: nothing about the answer depends on when the process started.

- [ ] **Step 1: Write the failing test** — including the review-focus cases:

```ts
test("activityAt is a function of the clock, not of history", () => {
  // 03:00 local is inside Rick's 02:30 sleeping slot; 09:00 is idle; 12:00 is working
  assert.equal(activityAt(rick, at("03:00")).activity, "sleeping");
  assert.equal(activityAt(rick, at("09:00")).activity, "idle");
  assert.equal(activityAt(rick, at("12:00")).activity, "working");
});

test("an instant before the first slot belongs to yesterday's last slot", () => {
  const r = { ...rick, routine: [{ start: "07:00", activity: "idle", jitterMin: 0 }, { start: "20:00", activity: "sleeping", jitterMin: 0 }] };
  assert.equal(activityAt(r, at("05:00")).activity, "sleeping"); // yesterday 20:00
});

test("jitter is seeded per character per day: stable within a day, different across days", () => {
  const a = slotBoundaries(rick, at("12:00"));
  assert.deepEqual(a, slotBoundaries(rick, at("18:00")));
  assert.notDeepEqual(a, slotBoundaries(rick, at("12:00", +1))); // next day
});

test("nextTransitionAt is the next boundary strictly after now, and moves forward", () => {
  const t = nextTransitionAt(rick, at("12:00"));
  assert.ok(t > at("12:00"));
  assert.ok(nextTransitionAt(rick, t) > t);
});

test("routine respects the character timezone across DST", () => {
  // 2026-03-08 is the US spring-forward. 07:00 local must still be 07:00 local.
  const p = { ...rick, timezone: "America/Los_Angeles" };
  for (const day of ["2026-03-07", "2026-03-08", "2026-03-09", "2026-11-01"]) {
    const noon = Date.parse(`${day}T20:00:00Z`); // midday LA
    const sevenAm = slotBoundaries(p, noon).find((t) => activityAt(p, t).activity === "idle")!;
    assert.equal(localMinutes("America/Los_Angeles", sevenAm), 7 * 60);
  }
});
```

- [ ] **Step 2: Run to verify it fails.** `npm test` → cannot find module `../src/character/routine.ts`.

- [ ] **Step 3: Implement.** A `ponytail:` comment on `localDayStart`: it uses the offset at `now`, so a boundary that lands inside a DST jump within the same local day lands an hour off. Bounded and rare; the alternative is a real tz library, which is a dependency not worth adding for a bedtime.

- [ ] **Step 4: `npm test && npm run typecheck`, commit.**

```bash
git commit -am "feat: derive character activity from a daily routine in their timezone"
```

---

### Task 3: Mood, and the character row that holds it

**Files:**
- Modify: `src/types.ts`, `src/db.ts`, `src/store.ts`
- Create: `src/character/mood.ts`
- Test: `test/mood.test.ts`, `test/store.test.ts`

**Interfaces:**
- Produces: `MOODS = ["neutral","happy","tired","annoyed","excited","distracted"]`, `type Mood`; `CharacterState` gaining `mood: Mood | null`, `moodChangedAt: number | null`; `Store.saveCharacterState(cs)`; `moodNow(cs, now): Mood` (neutral once the TTL has passed).

- [ ] **Step 1: Add the columns.** `CREATE TABLE` gains `mood TEXT, mood_changed_at INTEGER`. For a pre-existing DB, run an idempotent, `PRAGMA table_info`-guarded `ALTER TABLE` in `openDb` — do **not** use a bare try/catch, which hides real errors:

```ts
const cols = db.prepare("PRAGMA table_info(character_state)").all() as { name: string }[];
if (!cols.some((c) => c.name === "mood")) {
  db.exec("ALTER TABLE character_state ADD COLUMN mood TEXT");
  db.exec("ALTER TABLE character_state ADD COLUMN mood_changed_at INTEGER");
}
```

- [ ] **Step 2: `moodNow`.**

```ts
/** Doc 02 §1: mood is transient. It reads as neutral once it has had time to pass. */
const MOOD_TTL_MS = 45 * 60_000;
export function moodNow(cs: CharacterState, now: number): Mood {
  if (cs.mood === null || cs.moodChangedAt === null) return "neutral";
  return now - cs.moodChangedAt < MOOD_TTL_MS ? cs.mood : "neutral";
}
```

A TTL rather than a decay: attention is a magnitude and decays; mood is a category and either lingers or passes.

- [ ] **Step 3: Tests** — a fresh row reads neutral; a mood set 10 min ago still reads itself; one set 46 min ago reads neutral; `saveCharacterState` round-trips. Then `npm test && npm run typecheck`, commit.

```bash
git commit -am "feat: add a transient mood to character state"
```

---

### Task 4: The Routine Engine

**Files:**
- Create: `src/character/routine-engine.ts`
- Modify: `src/main.ts` (start/stop), `src/store.ts` (`conversationsForCharacter`)
- Test: `test/manager.test.ts`

**Interfaces:**
- Produces: `class RoutineEngine { constructor(o: { store; clock; profiles; onTransition(c: { characterId; from: Activity; to: Activity }): void; log }); start(): void; stop(): void; sync(characterId: string): Activity }`.
- `Store.conversationsForCharacter(characterId): ConversationState[]`.
- `DELIVERY_PRESENCE: Record<Availability, "online" | "idle" | "dnd" | "invisible">` for Task 6.

**Behavior:**

- `sync(characterId)` — computes `activityAt(profile, clock.now())`, and if it differs from the stored row, writes `character_state` + the `ACTIVITY_CHANGED` event in one `store.tx`, then calls `onTransition`. Returns the current activity.
- `start()` — `sync` every profile once (this is what makes boot land in the *current* slot), then arm one timer per character at `nextTransitionAt(now) - now`.
- On fire — `sync`, then re-arm. `stop()` clears every handle.

`onTransition` is wired in `main.ts` to `im.onActivityChanged(...)` (Task 7).

**Test:** with a `FakeClock` and a profile whose routine is two slots, `start()` at 09:00 → activity `idle`; `advance` past 20:00 → activity `sleeping`, one `ACTIVITY_CHANGED` event, `onTransition` called once with `{ from: "idle", to: "sleeping" }`; `stop()` leaves no pending timers.

---

### Task 5: Jev sees time, mood, and the new trigger

**Files:**
- Modify: `src/types.ts` (`Trigger`), `src/jev/state.ts`, `src/jev/questions.ts`, `src/jev/decide.ts`
- Test: `test/jev.test.ts`

**Interfaces:**
- `Trigger = "user_turn" | "followup_due" | "activity_changed"`.
- `BehaviorDecision.mood?: Mood`.
- `buildQuestions(trigger, pending)` — on `activity_changed` returns **only** `pace` + `pending_<id>` (no topic, no reply-shaping questions: nothing is being written).
- `buildJevState` gains `mood` and a `since` block.

- [ ] **Step 1: The `since` block — audit item 1, and the highest-value change in this plan.**

Jev currently receives `{ from, text }` with no timestamps at all, so a reply 5 seconds later mid-flow and one 8 hours later out of the blue are the same input. Every number already exists in the database. `respond` computes them:

```ts
const since = {
  lastUserMsgAgoMs: now - conv.lastUserAt,
  lastBotMsgAgoMs: conv.lastBotAt ? now - conv.lastBotAt : null,
  turnStartedAgoMs: turn ? now - turn.firstAt : null,
  turnLastMsgAgoMs: turn ? now - turn.lastAt : null,
  activityChangedAgoMs: now - cs.activitySince,
  moodChangedAgoMs: cs.moodChangedAt ? now - cs.moodChangedAt : null,
  oldestPendingInMs: pending.length ? Math.min(...pending.map((m) => m.dueAt)) - now : null,
};
```

Recent messages each carry `agoMs` too. `buildJevState` renders them under `since`, with a comment stating the unit is milliseconds.

- [ ] **Step 2: The `mood` question** (doc 04 §1, experimental column). One `choice` over `MOODS`, asked on `user_turn` only:

```ts
mood: {
  type: "choice",
  instructions: "What is `character`'s mood right now, given `mood` and `currentTurn`? Most of the time it does not change.",
  criteria: { neutral: "No particular mood", happy: "Buoyant", tired: "Worn down", annoyed: "Irritated", excited: "Wound up about something", distracted: "Elsewhere in their head" },
},
```

`decide()` maps it through the same relative choice gate, and only overwrites the stored mood when the answer clears it — so "most of the time it does not change" is enforced by the maths, not just the prompt.

- [ ] **Step 3: `activity_changed` in `decide`.** It must never generate a reply:

```ts
// an activity change decides only what to do with what is already queued; it never writes new text
const generating = c.trigger !== "activity_changed";
let respondMode = generating ? choice("respond_mode", RESPOND_MODES, "now") : "no_reply";
```

`followUp` stays gated on `trigger === "user_turn"`, so it is already `undefined` here.

- [ ] **Step 4: Tests** — `buildJevState` includes `since` and `mood`; `activity_changed` asks no `topic_action`/`respond_mode`/`message_count`; a low-confidence `mood` answer leaves `decision.mood` `undefined`; an `activity_changed` decision has `respondMode: "no_reply"` and honours `pending_m1: cancel`. Then commit.

```bash
git commit -am "feat: give Jev the clock, a mood, and an activity-change trigger"
```

---

### Task 6: Typing and presence as views of the schedule

**Files:**
- Modify: `src/delivery/types.ts`, `src/delivery/telegram.ts`, `src/delivery/discord.ts`
- Test: `test/typing.test.ts`

**Interfaces:**

```ts
export interface DeliveryAdapter {
  // …existing…
  /** Best-effort: a character who cannot type is still allowed to send. */
  showTyping?(chatId: string): Promise<void>;
  /** How long the platform's typing state lasts before it must be re-sent. */
  readonly typingRefreshMs?: number;
  setPresence?(presence: "online" | "idle" | "dnd" | "invisible"): void;
}
```

- Telegram: `bot.api.sendChatAction(Number(chatId), "typing")`, `typingRefreshMs = 4000` (the indicator lasts ~5 s).
- Discord: fetch the channel and `sendTyping()`, `typingRefreshMs = 8000` (~10 s lasts); `setPresence` → `client.user?.setPresence({ status })`.
- CLI: neither.

Both `showTyping` implementations swallow their own errors — an indicator is decoration, and failing to show one must never block a send.

The **typing plan** itself lives in the manager (Task 7). The rule from doc 06 §2.27: the window is `[dueAt − typingTimeMs(text), dueAt]`, refreshed every `typingRefreshMs`, cleared when the message is delivered or cancelled.

---

### Task 7: Wiring — manager, respond, prompt

**Files:**
- Modify: `src/im/manager.ts`, `src/im/respond.ts`, `src/llm/prompt.ts`, `src/main.ts`
- Test: `test/manager.test.ts`, `test/respond.test.ts`, `test/llm.test.ts`

- [ ] **Step 1: `manager.onActivityChanged(characterId)`.** For every conversation of that character that has a pending bot message, enqueue `respond(deps, conversationId, "activity_changed", null)`. No pending messages → no Jev call, which is the common case and keeps this free.

```ts
onActivityChanged(characterId: string) {
  for (const conv of this.deps.store.conversationsForCharacter(characterId)) {
    if (!this.deps.store.pendingBotMessages(conv.conversationId).length) continue;
    void this.enqueue(conv.conversationId, () => respond(this.deps, conv.conversationId, "activity_changed", null));
  }
}
```

- [ ] **Step 2: `respond` for `activity_changed`.** Gate the LLM call on the trigger:

```ts
const kept = store.tx(() => applyDecision(d, conv, decision, pending, now));
// an activity change re-decides what is queued; it never generates text
if (trigger === "activity_changed" || decision.respondMode !== "now") return;
```

Also pass `since`, `mood`, `characterState` into `buildJevState`, and `mood` into `buildPrompt`.

- [ ] **Step 3: The typing plan in the manager.** Two methods, ~30 lines, driven by the existing `Clock`:

```ts
private typing = new Map<string, unknown>();

/** Typing is a view of the earliest queued message (doc 06 §2.27) — recomputed, never stored. */
private syncTyping(conversationId: string) {
  const { store, clock } = this.deps;
  this.stopTyping(conversationId);
  const conv = store.getConversation(conversationId);
  const next = store.pendingBotMessages(conversationId)[0];
  if (!conv || !next) return;
  const adapter = this.delivery(conv.characterId, conv.platform);
  if (!adapter.showTyping) return;
  const refresh = adapter.typingRefreshMs ?? 4000;
  const start = next.dueAt - typingTimeMs(next.text);
  const tick = () => {
    const cur = store.getBotMessage(next.id);
    if (!cur || cur.status !== "scheduled") return this.stopTyping(conversationId);
    const t = clock.now();
    if (t >= cur.dueAt) return this.stopTyping(conversationId);
    if (t >= start) void adapter.showTyping!(conv.chatId).catch(() => {});
    this.typing.set(conversationId, clock.setTimeout(tick, Math.max(250, Math.min(refresh, cur.dueAt - t))));
  };
  this.typing.set(conversationId, clock.setTimeout(tick, Math.max(0, start - clock.now())));
}

private stopTyping(conversationId: string) {
  const h = this.typing.get(conversationId);
  if (h !== undefined) this.deps.clock.clearTimeout(h);
  this.typing.delete(conversationId);
}
```

`syncTyping` is called after `respond` returns in `onTurnReady` and in the follow-up branch, and from `stopTyping` when a message is delivered in `deliver`. Because `tick` re-reads the message each round, a cancelled or rescheduled message stops or moves its own indicator — Review Focus #5.

- [ ] **Step 4: Prompt.** Render the authored character and the mood, and suppress repetition:

```ts
const used = new Set(p.recent.flatMap((m) => m.text.toLowerCase().match(/[a-z']+/g) ?? []));
const slang = s.slang.filter((w) => !used.has(w.toLowerCase()));
```

Identity/traits/likes/dislikes/quirks/stats render as labelled lines; `stats` renders as `intelligence 10/10, patience 2/10`. A mood line appears only when `p.mood !== "neutral"`.

- [ ] **Step 5: The count safety net.** Jev picks a count before the model writes; when the model returns fewer beats than it was asked for, one long paragraph goes out where three short messages belonged.

```ts
/**
 * Jev chooses the beat count before the model writes, so the model occasionally answers "3" with one
 * paragraph. Splitting only where the model already put a sentence break keeps its phrasing intact;
 * cutting on commas instead would produce "i know," / "right?".
 * ponytail: sentence boundaries only, and only ever splits — it never merges a burst the model chose.
 */
function splitToCount(texts: string[], want: number): string[] {
  if (texts.length >= want || texts.length !== 1) return texts;
  const parts = texts[0].split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length < want) return texts;
  const per = Math.ceil(parts.length / want);
  return Array.from({ length: want }, (_, i) => parts.slice(i * per, (i + 1) * per).join(" ")).filter(Boolean);
}
```

- [ ] **Step 6: `main.ts`.** Construct the `RoutineEngine`, wire `onTransition` to `im.onActivityChanged`, call `start()` after `im.recover()`, and call `setPresence` per adapter on each transition using `DELIVERY_PRESENCE[availability(activity)]`. `stop()` on SIGINT.

- [ ] **Step 7: Tests.**

```ts
test("activity change re-decides pending: sleeping cancels a queued reply", async () => {
  // queue a reply, then fire onActivityChanged with activity → sleeping and Jev answering cancel
  // assert: message status cancelled, OUTGOING_MESSAGE_CANCELLED event, and the LLM never ran
});

test("activity change with nothing queued does not call Jev");
test("Jev unavailable during an activity change cancels pending sends rather than sending them");
test("typing plan follows the message: starts at dueAt − typingTime, stops on deliver and on cancel");
test("splitToCount only splits, never merges");
```

Then `npm test && npm run typecheck`, and commit.

---

### Task 8: Docs and a live run

- [ ] **Step 1: Update the specs.** Doc 02 (mood is persisted + TTL'd; routine transitions are not durable rows), doc 03 §8 (typing refresh values, mood TTL), doc 04 (the `mood` question, the `activity_changed` trigger and its question subset, `since` in Jev's state), doc 06 (§2.21 mood → built; §2.27 presence → built for Discord, typing for both).
- [ ] **Step 2: Live run.** With the Telethon harness (see the `telethon-test-harness` memory), drive a real conversation across a routine boundary using a profile whose `routine` is compressed to a few minutes, and confirm: the activity line in the prompt changes, a reply queued before the boundary is cancelled rather than sent by a "sleeping" character, and `typing…` appears in Telegram before each message. Record the transcript.
- [ ] **Step 3: Author a third persona end to end** from `_template.json`, with its own token env var, and confirm it starts alongside Rick and Morty. This is Review Focus #4.

```bash
git commit -am "docs: record the realism pass and how to author a character"
```

---

## Skipped, and when to add them

- **`delayHint`** (LLM-chosen delay) — Jev owns pace. Add only if Jev's pace categories prove too coarse.
- **Per-character fallbacks** — contradicts doc 03 §6's Jev-unavailable policy. Add only with a separate "Jev unsure" path.
- **Send rate limit** (doc 03 §8) — unchanged from the core-loop plan: Telegram absorbs 429s, Discord does not. Still the fix to make if bursts across many conversations ever bite.
- **Explicit activity overrides** ("character is at a party tonight") — the engine writes `character_state`, so this is a new trigger on the same sync path, not a new mechanism.
