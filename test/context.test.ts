import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { contextWindow, nextOpenThreads, openThreads, selectExamples } from "../src/context/context.ts";
import type { Example, UnresolvedItem } from "../src/types.ts";

const config = DEFAULT_CONFIG;
const DAY = 24 * 3_600_000;

const msg = (at: number) => ({ role: "user" as const, text: `m${at}`, at });

/** A store stub: `fetch(since)` returns everything at or after `since`. */
const history = (ats: number[]) => (since: number) => ats.filter((a) => a >= since).map(msg);

test("no topic means the ordinary recent window", () => {
  const seen: number[] = [];
  const got = contextWindow({ topicStartedAt: null }, config, (s) => (seen.push(s), history([1, 2, 3])(s)));
  assert.deepEqual(seen, [0]);
  assert.equal(got.length, 3);
});

test("an established topic narrows the window to the topic", () => {
  // 10 messages, the topic started at 5 — enough to clear the floor
  const fetch = history([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const got = contextWindow({ topicStartedAt: 5 }, config, fetch);
  assert.deepEqual(got.map((m) => m.at), [5, 6, 7, 8, 9, 10]);
});

test("a new topic keeps a floor of history instead of blanking the conversation", () => {
  // the topic started one message ago: scoping to it would leave the character with nothing to
  // reply into, which is a worse failure than the crowding the scope exists to fix
  const ats = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const got = contextWindow({ topicStartedAt: 10 }, config, history(ats));
  assert.deepEqual(got.map((m) => m.at), ats);
});

const example = (id: string, emotion: Example["emotion"] = "joking"): Example => ({
  id, characterId: "rick", episode: "3", emotion, lines: [{ speaker: "rick", text: id }],
});

test("example selection is seeded: stable for a seed, different across seeds", () => {
  const pool = Array.from({ length: 20 }, (_, i) => example(`e${i}`));
  const a = selectExamples(pool, 3, "gen-a").map((e) => e.id);
  assert.deepEqual(a, selectExamples([...pool].reverse(), 3, "gen-a").map((e) => e.id), "pool order must not matter");
  assert.equal(a.length, 3);
  assert.notEqual(a.join(), selectExamples(pool, 3, "gen-b").map((e) => e.id).join());
  assert.deepEqual(selectExamples([], 3, "gen-a"), [], "a character with no examples selects nothing");
});

test("open threads drop expired ones and cap to the newest", () => {
  const now = 10 * DAY;
  const items: UnresolvedItem[] = [
    { id: "old", summary: "stale", raisedAt: now - 8 * DAY },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, summary: `s${i}`, raisedAt: now - i })),
  ];
  const got = openThreads(items, now, config);
  assert.equal(got.length, config.unresolvedMax);
  assert.ok(!got.some((t) => t.id === "old"), "a thread nobody asked about in a week is over");
  assert.equal(got.at(-1)!.id, "t0", "newest last");
});

test("nextOpenThreads consumes an asked thread and stores a raised one", () => {
  const now = 1000;
  const open: UnresolvedItem[] = [{ id: "t1", summary: "interview tomorrow", raisedAt: 0 }];
  const asked = nextOpenThreads(open, { asked: [open[0]], raised: "dentist on friday" }, now, config);
  assert.deepEqual(asked.map((t) => t.summary), ["dentist on friday"]);
  assert.ok(asked[0].id.length > 0 && asked[0].raisedAt === now);

  // nothing asked, nothing raised: the list is untouched
  assert.deepEqual(nextOpenThreads(open, { asked: [], raised: null }, now, config), open);

  // a repeat of something already open is not stored twice
  const repeat = nextOpenThreads(open, { asked: [], raised: "  Interview tomorrow! " }, now, config);
  assert.equal(repeat.length, 1);
  assert.equal(repeat[0].id, "t1");

  // a summary about the conversation rather than the message is not *this* thread (measured live:
  // the model answered a message about a landlord inspection with "thesis defense thursday
  // morning"). The thread is kept, in the user's own words, rather than quietly dropped.
  const turn = "my landlord is coming to inspect the flat on saturday";
  assert.deepEqual(nextOpenThreads([], { asked: [], raised: "thesis defense thursday morning", about: turn }, now, config).map((t) => t.summary), [turn]);
  assert.deepEqual(nextOpenThreads([], { asked: [], raised: "landlord inspection saturday", about: turn }, now, config).map((t) => t.summary), ["landlord inspection saturday"]);
  const long = "so anyway i finally booked the flight to see my parents next month and i am dreading it";
  assert.match(nextOpenThreads([], { asked: [], raised: "thesis defense", about: long }, now, config)[0].summary, /\.\.\.$/, "a fallback summary is clamped");
  // inflections read as the same word
  assert.deepEqual(nextOpenThreads([], { asked: [], raised: "quitting the job", about: "i think im gonna quit my job" }, now, config).length, 1);
  // and with nothing to compare against, the summary is taken as given
  assert.equal(nextOpenThreads([], { asked: [], raised: "anything at all" }, now, config).length, 1);

  // capped: the oldest falls off the front
  const many: UnresolvedItem[] = Array.from({ length: config.unresolvedMax + 2 }, (_, i) => ({ id: `t${i}`, summary: `s${i}`, raisedAt: i }));
  const capped = nextOpenThreads(many, { asked: [], raised: null }, now, config);
  assert.equal(capped.length, config.unresolvedMax);
  assert.equal(capped.at(-1)!.id, `t${config.unresolvedMax + 1}`);
});
