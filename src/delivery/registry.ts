import type { CharacterProfile } from "../character/profile.ts";
import type { Platform } from "../types.ts";
import type { DeliveryAdapter, IncomingText } from "./types.ts";

export const BOT_PLATFORMS = ["telegram", "discord"] as const;
export type BotPlatform = (typeof BOT_PLATFORMS)[number];

export interface PlatformStatus {
  /** The setting the token is stored under: the profile's `botTokenEnv`. */
  name: string;
  tokenSet: boolean;
  /** The last 4 characters, so you can tell two tokens apart without seeing either. */
  tokenHint: string | null;
  running: boolean;
  /** Why it is not running, when it should be: a rejected token, a network error. */
  error: string | null;
}

export interface RegistryOptions {
  /** Which platforms this process may start. Empty in CLI mode: a test run must not go live. */
  allowed: readonly BotPlatform[];
  /** Reads a stored token by name. */
  secret: (name: string) => string | undefined;
  create: (platform: BotPlatform, token: string) => DeliveryAdapter;
  receive: (characterId: string, platform: Platform, m: IncomingText) => void;
  /** After an adapter is listening: arm its conversations' timers, mirror presence. */
  onStart: (characterId: string, platform: Platform, adapter: DeliveryAdapter) => Promise<void> | void;
  /** Before an adapter goes away: disarm its conversations' timers. */
  onStop: (characterId: string, platform: Platform) => void;
  /** A bot that would not start: a rejected token, a network error. */
  onFail?: (characterId: string, platform: Platform, error: string) => void;
  log: (msg: string, err?: unknown) => void;
}

const key = (characterId: string, platform: Platform) => `${characterId}:${platform}`;

/**
 * The live adapters, one per (character, platform). `sync` reconciles one character with its profile
 * and the current tokens, so a binding or token change takes effect without a restart: an adapter
 * whose token changed is stopped and a new one started, and one that is no longer wanted is stopped.
 */
export class AdapterRegistry {
  private live = new Map<string, { adapter: DeliveryAdapter; token: string | null }>();
  private errors = new Map<string, string>();
  /** One sync at a time per character: two quick saves must not start the same bot twice. */
  private syncing = new Map<string, Promise<void>>();

  constructor(private readonly o: RegistryOptions) {}

  get(characterId: string, platform: Platform): DeliveryAdapter {
    const a = this.live.get(key(characterId, platform));
    if (!a) throw new Error(`no adapter for ${characterId} on ${platform}`);
    return a.adapter;
  }

  /** Adapters started outside `sync` (the CLI). Never stopped by it. */
  async add(characterId: string, adapter: DeliveryAdapter) {
    await adapter.start((m) => this.o.receive(characterId, adapter.platform, m));
    this.live.set(key(characterId, adapter.platform), { adapter, token: null });
    await this.o.onStart(characterId, adapter.platform, adapter);
  }

  each(fn: (characterId: string, platform: Platform, adapter: DeliveryAdapter) => void) {
    for (const [k, { adapter }] of this.live) fn(k.slice(0, k.lastIndexOf(":")), adapter.platform, adapter);
  }

  get size() {
    return this.live.size;
  }

  sync(characterId: string, profile: CharacterProfile | undefined): Promise<void> {
    const prev = this.syncing.get(characterId) ?? Promise.resolve();
    const next = prev.then(() => this.reconcile(characterId, profile));
    this.syncing.set(characterId, next.catch(() => {}));
    return next;
  }

  private async reconcile(characterId: string, profile: CharacterProfile | undefined) {
    for (const platform of BOT_PLATFORMS) {
      const k = key(characterId, platform);
      const binding = profile?.platforms[platform];
      const want = binding && this.o.allowed.includes(platform) ? this.o.secret(binding.botTokenEnv) || null : null;
      const cur = this.live.get(k);
      if (cur && cur.token === want) continue;
      if (cur) {
        this.o.onStop(characterId, platform);
        this.live.delete(k);
        try {
          await cur.adapter.stop();
        } catch (e) {
          this.o.log(`stopping ${k} failed`, e);
        }
        this.o.log(`${characterId} stopped on ${platform}`);
      }
      this.errors.delete(k);
      if (!want) continue;
      const adapter = this.o.create(platform, want);
      try {
        await adapter.start((m) => this.o.receive(characterId, platform, m));
      } catch (e) {
        this.errors.set(k, e instanceof Error ? e.message : String(e));
        this.o.log(`${characterId} could not start on ${platform}`, e);
        this.o.onFail?.(characterId, platform, this.errors.get(k)!);
        await adapter.stop().catch(() => {});
        continue;
      }
      this.live.set(k, { adapter, token: want });
      this.o.log(`${characterId} listening on ${platform}`);
      await this.o.onStart(characterId, platform, adapter);
    }
  }

  status(profile: CharacterProfile): Partial<Record<BotPlatform, PlatformStatus>> {
    const out: Partial<Record<BotPlatform, PlatformStatus>> = {};
    for (const platform of BOT_PLATFORMS) {
      const binding = profile.platforms[platform];
      if (!binding) continue;
      const token = this.o.secret(binding.botTokenEnv);
      const k = key(profile.characterId, platform);
      out[platform] = {
        name: binding.botTokenEnv,
        tokenSet: Boolean(token),
        tokenHint: token ? `…${token.slice(-4)}` : null,
        running: this.live.has(k),
        error: this.errors.get(k) ?? (token && !this.o.allowed.includes(platform) ? "not started: this process is running in CLI mode" : null),
      };
    }
    return out;
  }

  async stopAll() {
    for (const { adapter } of this.live.values()) await adapter.stop().catch(() => {});
    this.live.clear();
  }
}
