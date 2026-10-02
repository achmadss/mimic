import { existsSync, readFileSync, writeFileSync } from "node:fs";

const NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Bot tokens are `123:AbC-_` (Telegram) or dotted base64 (Discord); nothing that needs quoting. */
const VALUE = /^[A-Za-z0-9_.:\-]+$/;

/**
 * Set (or with `null`, remove) one `NAME=value` line in a dotenv file, leaving every other line —
 * comments, order, other keys — as it was. Also updates `env`, so the running process sees it.
 */
export function setEnvVar(path: string, env: NodeJS.ProcessEnv, name: string, value: string | null) {
  if (!NAME.test(name)) throw new Error(`env var name must be UPPER_SNAKE_CASE: ${name}`);
  if (value !== null && !VALUE.test(value)) throw new Error("that does not look like a bot token");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const at = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
  if (value === null) {
    if (at >= 0) lines.splice(at, 1);
    delete env[name];
  } else {
    if (at >= 0) lines[at] = `${name}=${value}`;
    else {
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(`${name}=${value}`, "");
    }
    env[name] = value;
  }
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
}
