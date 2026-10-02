import { httpJevClient, type JevClient } from "./jev/client.ts";
import { openAICompatibleClient, type LLMClient, type StructuredMode } from "./llm/client.ts";

/** Reads one stored setting (the `settings` table): an API key, a bot token, a model. */
export type Lookup = (name: string) => string | undefined;

/**
 * The model and keys a character talks with, stored as settings. A character's own
 * `<ID>_<VAR>` (e.g. RICK_LLM_MODEL) wins over the global one, so characters can sit on
 * different providers, models and accounts, and an unset one just uses the default.
 */
// in the order the dashboard asks for them: the model list needs the URL and key first
export const AI_VARS = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_STRUCTURED_MODE", "TYPESAFE_API_KEY"] as const;
export type AiVar = (typeof AI_VARS)[number];
const SECRET: ReadonlySet<AiVar> = new Set(["LLM_API_KEY", "TYPESAFE_API_KEY"]);
const MODES: StructuredMode[] = ["json_schema", "tool", "json_object"];

/** `null` = the global default. */
export const aiVarName = (characterId: string | null, v: AiVar) => (characterId ? `${characterId.toUpperCase()}_${v}` : v);

const effective = (get: Lookup, characterId: string | null, v: AiVar) =>
  (characterId && get(aiVarName(characterId, v))) || get(v) || undefined;

/** Throws on a value that would break the client, so a bad save is refused instead of failing every turn. */
export function checkAiValue(v: AiVar, value: string) {
  if (v === "LLM_STRUCTURED_MODE" && !MODES.includes(value as StructuredMode)) throw new Error(`LLM_STRUCTURED_MODE must be one of ${MODES.join(", ")}`);
  if (v === "LLM_BASE_URL" && !/^https?:\/\/\S+$/.test(value)) throw new Error("LLM_BASE_URL must be an http(s) URL");
}

export interface AiVarStatus {
  name: string;
  secret: boolean;
  /** This scope's own value: shown in full, or as `…abcd` for a key. Null = unset here. */
  own: string | null;
  /** What actually runs: `own`, or the default it falls back to. */
  effective: string | null;
}

const show = (v: AiVar, value: string | undefined) => (value ? (SECRET.has(v) ? `…${value.slice(-4)}` : value) : null);

export function aiStatus(get: Lookup, characterId: string | null): Record<AiVar, AiVarStatus> {
  const out = {} as Record<AiVar, AiVarStatus>;
  for (const v of AI_VARS) {
    const name = aiVarName(characterId, v);
    out[v] = { name, secret: SECRET.has(v), own: show(v, get(name)), effective: show(v, effective(get, characterId, v)) };
  }
  return out;
}

/** The base URL and key a character's LLM calls go to, for listing that provider's models. */
export function llmEndpoint(get: Lookup, characterId: string | null) {
  return { baseUrl: effective(get, characterId, "LLM_BASE_URL"), apiKey: effective(get, characterId, "LLM_API_KEY") };
}

/**
 * Clients per character, rebuilt when any of its resolved values changes — so a key or model
 * saved in the dashboard applies on the next call, with no restart.
 * A missing value throws at call time: the reply path logs it and that character goes quiet,
 * while every other character carries on.
 */
export function aiClients(get: Lookup) {
  const cache = new Map<string, { key: string; clients: { llm: LLMClient; jev: JevClient } }>();
  return (characterId: string) => {
    const r = Object.fromEntries(AI_VARS.map((v) => [v, effective(get, characterId, v)])) as Record<AiVar, string | undefined>;
    const key = JSON.stringify(r);
    const hit = cache.get(characterId);
    if (hit?.key === key) return hit.clients;
    for (const v of ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "TYPESAFE_API_KEY"] as const) {
      if (!r[v]) throw new Error(`${characterId} has no ${v}: set it in the dashboard`);
    }
    const mode = (r.LLM_STRUCTURED_MODE ?? "tool") as StructuredMode;
    checkAiValue("LLM_STRUCTURED_MODE", mode);
    const clients = {
      llm: openAICompatibleClient({ baseUrl: r.LLM_BASE_URL!, apiKey: r.LLM_API_KEY!, model: r.LLM_MODEL!, mode }),
      jev: httpJevClient({ apiKey: r.TYPESAFE_API_KEY! }),
    };
    cache.set(characterId, { key, clients });
    return clients;
  };
}

/**
 * `.env` is for the app. A key or token still there (from before they moved to the database)
 * is copied in once, where nothing is stored under that name yet; returns what it copied.
 */
export function importFromEnv(env: NodeJS.ProcessEnv, names: Iterable<string>, get: Lookup, set: (name: string, value: string) => void) {
  const moved = [...new Set(names)].filter((n) => env[n] && get(n) === undefined);
  for (const n of moved) set(n, env[n]!);
  return moved;
}
