import { availability, PRESENCE } from "./character/derived.ts";
import { loadProfiles } from "./character/profile.ts";
import { RoutineEngine } from "./character/routine-engine.ts";
import { realClock } from "./clock.ts";
import { applyConfig, DEFAULT_CONFIG, readConfigFile, type Config } from "./config.ts";
import { startDashboard } from "./dashboard/server.ts";
import { openDb } from "./db.ts";
import { CliAdapter } from "./delivery/cli.ts";
import { AdapterRegistry, BOT_PLATFORMS } from "./delivery/registry.ts";
import { DiscordAdapter } from "./delivery/discord.ts";
import { TelegramAdapter } from "./delivery/telegram.ts";
import { InteractionManager } from "./im/manager.ts";
import { httpJevClient } from "./jev/client.ts";
import { openAICompatibleClient, type StructuredMode } from "./llm/client.ts";
import { Store } from "./store.ts";

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

const log = (m: string, e?: unknown) => console.error(`[mimic] ${m}`, e ?? "");

// env, then whatever the dashboard saved on top: the last thing someone set is what runs
const CONFIG_PATH = process.env.MIMIC_CONFIG ?? "mimic.config.json";
const ENV_PATH = process.env.MIMIC_ENV_FILE ?? ".env";
const config = configFromEnv();
applyConfig(config, readConfigFile(CONFIG_PATH));

const cliIdx = process.argv.indexOf("--cli");
const dashboardOn = process.env.DASHBOARD !== "off";

/** Derived from activity, so it is mirror-only and never stored (doc 06 §2.27). */
const presenceOf = (characterId: string) => PRESENCE[availability(store.getCharacterState(characterId, realClock.now()).activity)];

// `im` and the registry need each other: the registry delivers into the manager, the manager sends through the registry
let im!: InteractionManager;
const adapters = new AdapterRegistry({
  // a CLI run is a local test: it must never put a character live on Telegram or Discord
  allowed: cliIdx >= 0 ? [] : BOT_PLATFORMS,
  env: process.env,
  create: (platform, token) => (platform === "telegram" ? new TelegramAdapter(token) : new DiscordAdapter(token)),
  receive: (characterId, platform, m) => im.receive(characterId, platform, m),
  onStart: async (characterId, platform, adapter) => {
    adapter.setPresence?.(presenceOf(characterId));
    await im.adopt(characterId, platform);
  },
  onStop: (characterId, platform) => im.release(characterId, platform),
  log,
});

im = new InteractionManager({ store, clock: realClock, jev, llm, profiles, config, log }, (characterId, platform) => adapters.get(characterId, platform));

const routine = new RoutineEngine({
  store,
  clock: realClock,
  profiles,
  onTransition: ({ characterId }) => {
    adapters.each((c, _p, a) => c === characterId && a.setPresence?.(presenceOf(characterId)));
    im.onActivityChanged(characterId);
  },
  log,
});
routine.start();

if (cliIdx >= 0) {
  const id = process.argv[cliIdx + 1] ?? "rick";
  const p = profiles.get(id);
  if (!p) throw new Error(`no character "${id}" (have: ${[...profiles.keys()].join(", ")})`);
  await adapters.add(id, new CliAdapter(p.name));
}
for (const p of profiles.values()) await adapters.sync(p.characterId, p);
if (adapters.size === 0 && !dashboardOn) throw new Error("no adapters: set bot token env vars, or run `npm run cli -- rick`");
if (adapters.size === 0) log("no bot is running yet: add a token in the dashboard");

if (dashboardOn) {
  startDashboard(
    { store, clock: realClock, im, routine, profiles, config, configPath: CONFIG_PATH, charactersDir: CHARACTERS_DIR, adapters, envPath: ENV_PATH, env: process.env },
    { host: process.env.DASHBOARD_HOST ?? "127.0.0.1", port: Number(process.env.DASHBOARD_PORT ?? 8787), password: process.env.DASHBOARD_PASSWORD || undefined },
  );
}

// SIGINT from a terminal, SIGTERM from `docker stop`
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    routine.stop();
    await adapters.stopAll();
    process.exit(0);
  });
}
