import { availability, PRESENCE } from "./character/derived.ts";
import { loadProfiles } from "./character/profile.ts";
import { RoutineEngine } from "./character/routine-engine.ts";
import { realClock } from "./clock.ts";
import { applyConfig, DEFAULT_CONFIG, readConfigFile, type Config } from "./config.ts";
import { startDashboard } from "./dashboard/server.ts";
import { openDb } from "./db.ts";
import { CliAdapter } from "./delivery/cli.ts";
import { DiscordAdapter } from "./delivery/discord.ts";
import { TelegramAdapter } from "./delivery/telegram.ts";
import type { DeliveryAdapter } from "./delivery/types.ts";
import { InteractionManager } from "./im/manager.ts";
import { httpJevClient } from "./jev/client.ts";
import { openAICompatibleClient, type StructuredMode } from "./llm/client.ts";
import { Store } from "./store.ts";
import type { Activity, Platform } from "./types.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (see .env.example)`);
  return v;
}

const MODES: StructuredMode[] = ["json_schema", "tool", "json_object"];
const mode = (process.env.LLM_STRUCTURED_MODE ?? "tool") as StructuredMode;
if (!MODES.includes(mode)) throw new Error(`LLM_STRUCTURED_MODE must be one of ${MODES.join(", ")}`);

/** Optional env overrides, so tuning a running character doesn't mean editing source. */
function configFromEnv(): Config {
  const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);
  return {
    ...structuredClone(DEFAULT_CONFIG),
    quietMs: num("MIMIC_QUIET_MS", DEFAULT_CONFIG.quietMs),
    followUpThreshold: num("MIMIC_FOLLOW_UP_THRESHOLD", DEFAULT_CONFIG.followUpThreshold),
    openThreadThreshold: num("MIMIC_OPEN_THREAD_THRESHOLD", DEFAULT_CONFIG.openThreadThreshold),
  };
}

const store = new Store(openDb(process.env.DB_PATH ?? "mimic.db"));
const CHARACTERS_DIR = process.env.MIMIC_CHARACTERS ?? "characters";
const profiles = loadProfiles(CHARACTERS_DIR);
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

const log = (m: string, e?: unknown) => console.error(`[mimic] ${m}`, e ?? "");

// env, then whatever the dashboard saved on top: the last thing someone set is what runs
const CONFIG_PATH = process.env.MIMIC_CONFIG ?? "mimic.config.json";
const config = configFromEnv();
applyConfig(config, readConfigFile(CONFIG_PATH));

const im = new InteractionManager(
  { store, clock: realClock, jev, llm, profiles, config, log },
  (characterId, platform) => {
    const a = adapters.get(key(characterId, platform));
    if (!a) throw new Error(`no adapter for ${characterId} on ${platform}`);
    return a.adapter;
  },
);

/** Derived from activity, so it is mirror-only and never stored (doc 06 §2.27). */
const setPresence = (characterId: string, activity: Activity) => {
  for (const platform of ["telegram", "discord"] as const) {
    adapters.get(key(characterId, platform))?.adapter.setPresence?.(PRESENCE[availability(activity)]);
  }
};

const routine = new RoutineEngine({
  store,
  clock: realClock,
  profiles,
  onTransition: ({ characterId, to }) => {
    setPresence(characterId, to);
    im.onActivityChanged(characterId);
  },
  log,
});

for (const { characterId, adapter } of adapters.values()) {
  await adapter.start((m) => im.receive(characterId, adapter.platform, m));
  console.error(`[mimic] ${characterId} listening on ${adapter.platform}`);
}
await im.recover();
routine.start();
// start() reports only what moved; a character who did not change still needs their status set
for (const characterId of profiles.keys()) setPresence(characterId, store.getCharacterState(characterId, realClock.now()).activity);

if (process.env.DASHBOARD !== "off") {
  startDashboard(
    { store, clock: realClock, im, routine, profiles, config, configPath: CONFIG_PATH, charactersDir: CHARACTERS_DIR, running: new Set(adapters.keys()), env: process.env },
    { host: process.env.DASHBOARD_HOST ?? "127.0.0.1", port: Number(process.env.DASHBOARD_PORT ?? 8787), password: process.env.DASHBOARD_PASSWORD || undefined },
  );
}

process.on("SIGINT", async () => {
  routine.stop();
  for (const { adapter } of adapters.values()) await adapter.stop();
  process.exit(0);
});
