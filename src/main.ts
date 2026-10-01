import { loadProfiles } from "./character/profile.ts";
import { realClock } from "./clock.ts";
import { DEFAULT_CONFIG, type Config } from "./config.ts";
import { openDb } from "./db.ts";
import { CliAdapter } from "./delivery/cli.ts";
import { DiscordAdapter } from "./delivery/discord.ts";
import { TelegramAdapter } from "./delivery/telegram.ts";
import type { DeliveryAdapter } from "./delivery/types.ts";
import { InteractionManager } from "./im/manager.ts";
import { httpJevClient } from "./jev/client.ts";
import { openAICompatibleClient, type StructuredMode } from "./llm/client.ts";
import { Store } from "./store.ts";
import type { Platform } from "./types.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (see .env.example)`);
  return v;
}

const MODES: StructuredMode[] = ["json_schema", "tool", "json_object"];
const mode = (process.env.LLM_STRUCTURED_MODE ?? "json_schema") as StructuredMode;
if (!MODES.includes(mode)) throw new Error(`LLM_STRUCTURED_MODE must be one of ${MODES.join(", ")}`);

/** Optional env overrides, so tuning a running character doesn't mean editing source. */
function configFromEnv(): Config {
  const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);
  return {
    ...DEFAULT_CONFIG,
    quietMs: num("MIMIC_QUIET_MS", DEFAULT_CONFIG.quietMs),
    followUpThreshold: num("MIMIC_FOLLOW_UP_THRESHOLD", DEFAULT_CONFIG.followUpThreshold),
  };
}

const store = new Store(openDb(process.env.DB_PATH ?? "mimic.db"));
const profiles = loadProfiles("characters");
const jev = httpJevClient({ apiKey: env("TYPESAFE_API_KEY") });
const llm = openAICompatibleClient({ baseUrl: env("LLM_BASE_URL"), apiKey: env("LLM_API_KEY"), model: env("LLM_MODEL"), mode });

const adapters = new Map<string, { characterId: string; adapter: DeliveryAdapter }>();
const key = (characterId: string, platform: Platform) => `${characterId}:${platform}`;

const cliIdx = process.argv.indexOf("--cli");
if (cliIdx >= 0) {
  const id = process.argv[cliIdx + 1] ?? "rick";
  const p = profiles.get(id);
  if (!p) throw new Error(`no character "${id}" (have: ${[...profiles.keys()].join(", ")})`);
  adapters.set(key(id, "cli"), { characterId: id, adapter: new CliAdapter(p.name) });
} else {
  for (const p of profiles.values()) {
    const tg = p.platforms.telegram && process.env[p.platforms.telegram.botTokenEnv];
    if (tg) adapters.set(key(p.characterId, "telegram"), { characterId: p.characterId, adapter: new TelegramAdapter(tg) });
    const dc = p.platforms.discord && process.env[p.platforms.discord.botTokenEnv];
    if (dc) adapters.set(key(p.characterId, "discord"), { characterId: p.characterId, adapter: new DiscordAdapter(dc) });
  }
}
if (adapters.size === 0) throw new Error("no adapters: set bot token env vars, or run `npm run cli -- rick`");

const im = new InteractionManager(
  { store, clock: realClock, jev, llm, profiles, config: configFromEnv(), log: (m, e) => console.error(`[mimic] ${m}`, e ?? "") },
  (characterId, platform) => {
    const a = adapters.get(key(characterId, platform));
    if (!a) throw new Error(`no adapter for ${characterId} on ${platform}`);
    return a.adapter;
  },
);

for (const { characterId, adapter } of adapters.values()) {
  await adapter.start((m) => im.receive(characterId, adapter.platform, m));
  console.error(`[mimic] ${characterId} listening on ${adapter.platform}`);
}
await im.recover();

process.on("SIGINT", async () => {
  for (const { adapter } of adapters.values()) await adapter.stop();
  process.exit(0);
});
