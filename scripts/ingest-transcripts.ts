/**
 * Offline: a transcript CSV becomes the `examples` table (doc 05 §5.1).
 *
 *   npm run ingest -- --dry
 *   npm run ingest
 *
 * Never runs on the reply path, and writes only through `Store.saveExample`, which is
 * `INSERT OR REPLACE` — re-running is safe and is how a tag gets added later.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadProfiles } from "../src/character/profile.ts";
import { cutExchanges, exchangeId, readTags, taggingQuestions, transcriptLines, type Exchange } from "../src/context/ingest.ts";
import { openDb } from "../src/db.ts";
import { httpJevClient, type JevClient } from "../src/jev/client.ts";
import { Store } from "../src/store.ts";
import type { Emotion } from "../src/types.ts";

const DEFAULT_CSV = join(homedir(), "Downloads", "rickmorty-transcripts", "Rick-n-Morty.csv");

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : undefined;
};
const num = (name: string, fallback: number) => (arg(name) ? Number(arg(name)) : fallback);

async function pool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await fn(items[next], next++);
    }),
  );
}

async function tagBatch(jev: JevClient, character: string, batch: Exchange[]): Promise<{ exchange: Exchange; emotion: Emotion; secondary: Emotion[] }[]> {
  const questions = Object.assign({}, ...batch.map((e, i) => taggingQuestions(i, e.lines)));
  const answers = await jev.ask({ task: "tag_dialogue_exchange", character }, questions);
  return batch.map((e, i) => ({ exchange: e, ...readTags(answers, i) }));
}

async function main() {
  const store = new Store(openDb(process.env.DB_PATH ?? "mimic.db"));
  const profiles = loadProfiles("characters");
  const csvPath = arg("csv") ?? DEFAULT_CSV;
  const limit = num("limit", 2000); // every exchange: the rare registers need the whole show
  const batchSize = num("batch", 4);
  const concurrency = num("concurrency", 4);
  const dry = process.argv.includes("--dry");

  const lines = transcriptLines(readFileSync(csvPath, "utf8"));
  const byCharacter = new Map<string, Exchange[]>();
  for (const e of cutExchanges(lines, [...profiles.keys()])) {
    const list = byCharacter.get(e.characterId) ?? [];
    if (list.length < limit) list.push(e);
    byCharacter.set(e.characterId, list);
  }

  console.error(`[ingest] ${csvPath}: ${lines.length} lines`);
  for (const [id, list] of byCharacter) console.error(`[ingest] ${id}: ${list.length} exchanges`);

  if (dry) {
    for (const [id, list] of byCharacter) {
      console.error(`[ingest] ${id} sample:\n${list[0]?.lines.map((l) => `  ${l.speaker}: ${l.text}`).join("\n") ?? "  (none)"}`);
    }
    return;
  }

  // the key the bot uses (set in the dashboard); env still works for a one-off run
  const apiKey = process.env.TYPESAFE_API_KEY || store.setting("TYPESAFE_API_KEY");
  if (!apiKey) throw new Error("no TYPESAFE_API_KEY: set it in the dashboard (Settings), or in env for this run");
  const jev = httpJevClient({ apiKey, timeoutMs: 30_000 });

  const batches: Exchange[][] = [];
  for (const list of byCharacter.values()) {
    for (let i = 0; i < list.length; i += batchSize) batches.push(list.slice(i, i + batchSize));
  }
  console.error(`[ingest] tagging ${batches.length} batches of ${batchSize}, ${concurrency} at a time`);

  let done = 0;
  let failed = 0;
  await pool(batches, concurrency, async (batch) => {
    const name = profiles.get(batch[0].characterId)?.name ?? batch[0].characterId;
    try {
      const tagged = await tagBatch(jev, name, batch);
      store.tx(() => {
        for (const { exchange, emotion, secondary } of tagged) {
          store.saveExample({
            id: exchangeId(exchange),
            characterId: exchange.characterId,
            episode: exchange.episode,
            emotion,
            secondary,
            lines: exchange.lines,
          });
        }
      });
    } catch (e) {
      // a partial table is still useful: log the batch and keep going
      failed++;
      console.error(`[ingest] batch ${batch[0].characterId}:${batch[0].episode}:${batch[0].start} failed: ${String(e)}`);
    }
    if (++done % 10 === 0) console.error(`[ingest] ${done}/${batches.length} batches, ${failed} failed`);
  });

  // only after a clean run: a failed batch's rows are still the best copy of those exchanges
  if (failed === 0 && !arg("limit")) {
    for (const [id, list] of byCharacter) {
      const n = store.pruneExamples(id, new Set(list.map(exchangeId)));
      if (n) console.error(`[ingest] ${id}: pruned ${n} examples the cut no longer produces`);
    }
  }
  for (const id of profiles.keys()) console.error(`[ingest] ${id}: ${store.exampleCount(id)} examples stored`);
}

await main();
