import { FakeClock } from "../src/clock.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { loadProfiles } from "../src/character/profile.ts";
import { openDb } from "../src/db.ts";
import type { DeliveryAdapter, IncomingText } from "../src/delivery/types.ts";
import type { JevAnswer, JevAnswers, JevClient, JevQuestion } from "../src/jev/client.ts";
import type { ChatMessage, LLMClient } from "../src/llm/client.ts";
import { InteractionManager } from "../src/im/manager.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";
import type { Deps } from "../src/im/respond.ts";
import type { LLMOutput, Platform } from "../src/types.ts";

export const choice = (c: string, confidence = 0.9): JevAnswer => ({ type: "choice", choice: c, confidence, probabilities: { [c]: confidence } });
export const noul = (p: number): JevAnswer => ({ type: "noul", noul: p });
export const score = (s: number, confidence = 0.9): JevAnswer => ({ type: "score", score: s, confidence, probabilities: {} });

type JevNext = JevAnswers | Error | ((q: Record<string, JevQuestion>) => JevAnswers);

export class FakeJev implements JevClient {
  calls: { state: any; questions: Record<string, JevQuestion> }[] = [];
  next: JevNext = {};
  async ask(state: unknown, questions: Record<string, JevQuestion>) {
    this.calls.push({ state, questions });
    if (this.next instanceof Error) throw this.next;
    return typeof this.next === "function" ? this.next(questions) : this.next;
  }
}

export class FakeLLM implements LLMClient {
  calls: ChatMessage[][] = [];
  outputs: (LLMOutput | Error)[] = [];
  async generate(messages: ChatMessage[]) {
    this.calls.push(messages);
    const o = this.outputs.shift() ?? { messages: [{ text: "ok" }] };
    if (o instanceof Error) throw o;
    return o;
  }
}

/** Deps with an inert scheduler (timers never fire unless the test advances the clock). */
export function makeDeps() {
  const clock = new FakeClock();
  const store = new Store(openDb(":memory:"));
  const fired: string[] = [];
  const scheduler = new Scheduler(store, clock, (r) => fired.push(r.id));
  const jev = new FakeJev();
  const llm = new FakeLLM();
  const logs: string[] = [];
  const deps: Deps = { store, scheduler, clock, jev, llm, profiles: loadProfiles("characters"), config: DEFAULT_CONFIG, log: (m) => logs.push(m) };
  const conv = store.getOrCreateConversation("rick", "cli", "local");
  return { deps, clock, store, jev, llm, logs, fired, convId: conv.conversationId };
}

export class FakeAdapter implements DeliveryAdapter {
  sent: { chatId: string; text: string; key: string }[] = [];
  fail: Error | null = null;
  constructor(readonly platform: Platform = "cli", readonly idempotent = true) {}
  async send(chatId: string, text: string, key: string) {
    if (this.fail) throw this.fail;
    this.sent.push({ chatId, text, key });
    return { platformMessageId: String(this.sent.length) };
  }
  async start(_onMessage: (m: IncomingText) => void) {}
  async stop() {}
}

/** Full IM on a fake clock. Pass `store`/`start` to simulate a restart against the same DB. */
export function setupIM(opts: { store?: Store; start?: number; idempotent?: boolean } = {}) {
  const clock = new FakeClock(opts.start);
  const store = opts.store ?? new Store(openDb(":memory:"));
  const jev = new FakeJev();
  const llm = new FakeLLM();
  const adapter = new FakeAdapter("cli", opts.idempotent ?? true);
  const logs: string[] = [];
  const im = new InteractionManager(
    { store, clock, jev, llm, profiles: loadProfiles("characters"), config: DEFAULT_CONFIG, log: (m) => logs.push(m) },
    () => adapter,
  );
  let seq = 0;
  const say = (text: string, id = `p${++seq}`) => im.receive("rick", "cli", { chatId: "local", platformMessageId: id, text });
  const tick = async (ms: number) => {
    await im.drain();
    clock.advance(ms);
    await im.drain();
  };
  return { clock, store, jev, llm, adapter, logs, im, say, tick, convId: "rick:cli:local" };
}
