export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms)),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Test clock. advance() fires due timers synchronously; async work they start is not awaited. */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.UTC(2026, 0, 1, 12, 0, 0)) {
    this.t = start;
  }

  now() {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }

  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let next: { at: number; fn: () => void } | undefined;
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && (!next || tm.at < next.at)) {
          nextId = id;
          next = tm;
        }
      }
      if (!next) break;
      this.timers.delete(nextId);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }

  pendingTimers() {
    return this.timers.size;
  }
}
