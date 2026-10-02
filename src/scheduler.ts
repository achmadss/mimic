import type { Clock } from "./clock.ts";
import type { Store } from "./store.ts";
import type { ActionRow } from "./types.ts";

/** The actions table is the pending-action queue; this class only keeps timers in sync with it. */
export class Scheduler {
  private handles = new Map<string, unknown>();

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly onDue: (row: ActionRow) => void,
  ) {}

  /** Persist (replacing any row with the same id) and arm. Call inside the caller's transaction. */
  schedule(row: ActionRow) {
    this.store.putAction(row);
    this.arm(row);
  }

  cancel(id: string) {
    this.store.deleteAction(id);
    this.disarm(id);
  }

  /** Boot: arm every stored row this process owns, earliest first. Overdue rows fire on the next tick, in order. */
  armAll(owns: (row: ActionRow) => boolean = () => true) {
    for (const row of this.store.allActions()) if (owns(row)) this.arm(row);
  }

  /** Stop the timers of matching rows without deleting them: another process, or a later adopt, re-arms them. */
  disarmWhere(match: (row: ActionRow) => boolean) {
    for (const row of this.store.allActions()) if (match(row)) this.disarm(row.id);
  }

  private arm(row: ActionRow) {
    this.disarm(row.id);
    const handle = this.clock.setTimeout(() => {
      this.handles.delete(row.id);
      // the scheduler sends nothing; it only says "this action came due" (doc 03 §3)
      this.store.appendEvent(row.conversationId, this.clock.now(), "TIMER_EXPIRED", { actionId: row.id, kind: row.kind, dueAt: row.dueAt });
      this.onDue(row);
    }, row.dueAt - this.clock.now());
    this.handles.set(row.id, handle);
  }

  private disarm(id: string) {
    const h = this.handles.get(id);
    if (h === undefined) return;
    this.clock.clearTimeout(h);
    this.handles.delete(id);
  }
}
