import type { Clock } from "../clock.ts";
import type { Store } from "../store.ts";
import type { Activity } from "../types.ts";
import type { CharacterProfile } from "./profile.ts";
import { activityAt, nextTransitionAt } from "./routine.ts";

export interface Transition {
  characterId: string;
  from: Activity;
  to: Activity;
}

/**
 * Owns `character_state.activity`. It holds one timer per character and writes the activity the clock
 * says is running — the routine itself (`routine.ts`) is a pure function, and this only keeps the
 * stored copy and the `ACTIVITY_CHANGED` trail in step with it.
 *
 * Transitions are deliberately not rows in `actions`: a boundary crossed while the process was down
 * resolves to the slot running at boot, which is better than firing the stale one late.
 */
export class RoutineEngine {
  private handles = new Map<string, unknown>();

  constructor(
    private readonly o: {
      store: Store;
      clock: Clock;
      profiles: Map<string, CharacterProfile>;
      onTransition: (t: Transition) => void;
      log: (msg: string, err?: unknown) => void;
    },
  ) {}

  /** Boot: land every character in the slot running *now*, then arm each next boundary. */
  start() {
    for (const characterId of this.o.profiles.keys()) this.sync(characterId);
    for (const characterId of this.o.profiles.keys()) this.arm(characterId);
  }

  /** A profile was edited or added: land it in the slot its new routine says, and re-arm. */
  reload(characterId: string) {
    const h = this.handles.get(characterId);
    if (h !== undefined) this.o.clock.clearTimeout(h);
    this.handles.delete(characterId);
    this.sync(characterId);
    this.arm(characterId);
  }

  stop() {
    for (const h of this.handles.values()) this.o.clock.clearTimeout(h);
    this.handles.clear();
  }

  /** Reconcile the stored activity with the clock. Returns the activity now running. */
  sync(characterId: string): Activity {
    const profile = this.o.profiles.get(characterId);
    if (!profile) return "idle";
    const { store, clock } = this.o;
    const now = clock.now();
    const { activity, since } = activityAt(profile, now);
    const prev = store.getCharacterState(characterId, now);
    if (prev.activity === activity) {
      // same slot, but a restart re-derives when it actually began; no event, nothing changed
      if (prev.activitySince !== since) store.tx(() => store.saveCharacterState({ ...prev, activitySince: since }));
      return activity;
    }
    store.tx(() => {
      store.saveCharacterState({ ...prev, activity, activitySince: since });
      // character-scoped: the events table is keyed by conversation, and this belongs to none of them
      store.appendEvent(`character:${characterId}`, now, "ACTIVITY_CHANGED", { from: prev.activity, to: activity });
    });
    this.o.onTransition({ characterId, from: prev.activity, to: activity });
    return activity;
  }

  private arm(characterId: string) {
    const profile = this.o.profiles.get(characterId);
    if (!profile) return;
    const now = this.o.clock.now();
    // +500 ms so the timer lands inside the new slot rather than exactly on its boundary
    const delay = Math.max(0, nextTransitionAt(profile, now) - now) + 500;
    this.handles.set(
      characterId,
      this.o.clock.setTimeout(() => {
        this.handles.delete(characterId);
        try {
          this.sync(characterId);
        } catch (e) {
          this.o.log(`routine transition for ${characterId} failed`, e);
        }
        this.arm(characterId);
      }, delay),
    );
  }
}
