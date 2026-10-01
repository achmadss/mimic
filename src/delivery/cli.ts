import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { DeliveryAdapter, IncomingText } from "./types.ts";

export class CliAdapter implements DeliveryAdapter {
  readonly platform = "cli" as const;
  readonly idempotent = true;
  private rl?: Interface;

  constructor(
    private readonly name: string,
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  async start(onMessage: (m: IncomingText) => void) {
    this.rl = createInterface({ input: this.input });
    // ids must be unique across runs: the DB dedupes on them
    this.rl.on("line", (line) => onMessage({ chatId: "local", platformMessageId: randomUUID(), text: line }));
  }

  async send(_chatId: string, text: string, _idempotencyKey: string) {
    this.output.write(`${this.name}: ${text}\n`);
    return { platformMessageId: randomUUID() };
  }

  async stop() {
    this.rl?.close();
  }
}
