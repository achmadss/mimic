import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { dueChunk, recall, summarizeIfDue } from "../src/context/memory.ts";
import { sessionIdFor } from "../src/llm/client.ts";
import { makeDeps } from "./helpers.ts";

const config = { ...DEFAULT_CONFIG, recentMessages: 4, summaryMinChunk: 3, summaryMaxChunk: 5 };
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "user" as const, text: `m${i}`, at: i + 1 }));

test("a chunk is due only once enough has left the recent window, oldest first, capped", () => {
  assert.deepEqual(dueChunk(msgs(6), config), [], "2 outside the window is under the minimum");
  assert.deepEqual(dueChunk(msgs(7), config).map((m) => m.text), ["m0", "m1", "m2"]);
  assert.deepEqual(dueChunk(msgs(20), config).map((m) => m.text), ["m0", "m1", "m2", "m3", "m4"]);
});

test("the summarizer writes a summary and new facts, then moves its mark past the chunk", async () => {
  const { deps, store, llm, convId } = makeDeps();
  deps.config = config;
  for (let i = 0; i < 9; i++) store.insertUserMessage(`u${i}`, convId, `message ${i}`, 1000 + i);
  store.saveMemories(convId, [{ id: "f0", conversationId: convId, kind: "fact", text: "Their dog is Biscuit.", fromAt: 1, toAt: 1 }], 0);
  llm.summaries.push({ summary: "they talked about the move", facts: ["They are moving to Leeds in May.", "their dog is biscuit"] });

  assert.equal(await summarizeIfDue(deps, convId), true);
  assert.equal(llm.summaryOpts[0]?.sessionId, sessionIdFor(convId), "OpenCode Go rejects a request without it");
  assert.match(llm.summaryCalls[0][0].content, /These messages are from Wed 31 Dec\. Write any day they mention as a date/);
  assert.match(llm.summaryCalls[0][0].content, /Already known about the person: Their dog is Biscuit\./);
  assert.equal(llm.summaryCalls[0][1].content.split("\n").length, 5, "9 messages, 4 stay in the window");
  assert.equal(store.summarizedUntil(convId), 1004);
  assert.deepEqual(store.memories(convId, "fact", 10).map((f) => f.text), ["They are moving to Leeds in May.", "Their dog is Biscuit."], "a known fact is not stored twice");
  assert.equal(store.memories(convId, "summary", 10)[0].text, "they talked about the move");

  assert.equal(await summarizeIfDue(deps, convId), false, "nothing new has left the window");
});

test("a failed summary leaves the chunk to be tried again", async () => {
  const { deps, store, llm, convId } = makeDeps();
  deps.config = config;
  for (let i = 0; i < 9; i++) store.insertUserMessage(`u${i}`, convId, `message ${i}`, 1000 + i);
  llm.summaries.push(new Error("down"));
  assert.equal(await summarizeIfDue(deps, convId), false);
  assert.equal(store.summarizedUntil(convId), 0);
  assert.equal(await summarizeIfDue(deps, convId), true);
});

test("recall ranks by overlap with the turn, newest first on a tie, and reaches the prompt", () => {
  const { store, convId } = makeDeps();
  const at = (id: string, kind: "fact" | "summary", text: string, t: number) => ({ id, conversationId: convId, kind, text, fromAt: t, toAt: t });
  store.saveMemories(convId, [
    at("f1", "fact", "They work at a bakery.", 1),
    at("f2", "fact", "Their sister is called Ana.", 2),
    at("f3", "fact", "They hate mornings.", 3),
    at("s1", "summary", "We argued about the bakery shifts.", 1),
    at("s2", "summary", "They told me about a concert.", 2),
    at("s3", "summary", "Small talk about the weather.", 3),
  ], 0);
  const got = recall(store, convId, "ugh my bakery boss again", { ...DEFAULT_CONFIG, maxFacts: 2, maxSummaries: 2 });
  assert.deepEqual(got.facts.map((f) => f.id), ["f1", "f3"]);
  assert.deepEqual(got.summaries.map((f) => f.id), ["s1", "s3"], "the match, plus the newest, in time order");
});
