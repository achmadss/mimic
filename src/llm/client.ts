import { createHash } from "node:crypto";
import type { z } from "zod";
import type { LLMOutput, SummaryOutput } from "../types.ts";
import { LLMOutputSchema, LLM_OUTPUT_JSON_SCHEMA, SUMMARY_OUTPUT_JSON_SCHEMA, SummaryOutputSchema } from "./schema.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface LLMClient {
  generate(messages: ChatMessage[], opts?: GenerateOptions): Promise<LLMOutput>;
  /** Off the reply path: notes on a stretch of conversation that is leaving the recent window. */
  summarize(messages: ChatMessage[], opts?: GenerateOptions): Promise<SummaryOutput>;
}

interface Shape<T> {
  name: string;
  description: string;
  zod: z.ZodType<T>;
  json: object;
}
const REPLY: Shape<LLMOutput> = { name: "reply", description: "Send the character's reply", zod: LLMOutputSchema, json: LLM_OUTPUT_JSON_SCHEMA };
const NOTES: Shape<SummaryOutput> = { name: "notes", description: "Save notes on the conversation", zod: SummaryOutputSchema, json: SUMMARY_OUTPUT_JSON_SCHEMA };

export interface GenerateOptions {
  /** Stable id for one conversation, so the provider can route and cache prompts per conversation. */
  sessionId?: string;
}
/** Hashed: the provider gets a stable per-conversation routing key, not the user's platform chat id. */
export function sessionIdFor(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 32);
}

export type StructuredMode = "json_schema" | "tool" | "json_object";
export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: StructuredMode;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  userAgent?: string;
}

class RetryableError extends Error {}

/** Accepts bare JSON, ```json fences, or prose around one JSON object. */
export function parseJsonLoose(s: string): unknown {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new RetryableError("no JSON object in LLM output");
  return JSON.parse(body.slice(start, end + 1));
}

export function openAICompatibleClient(o: OpenAICompatibleOptions): LLMClient {
  const f = o.fetchFn ?? fetch;
  const url = `${o.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  function requestBody<T>(messages: ChatMessage[], shape: Shape<T>) {
    const base = { model: o.model, messages };
    if (o.mode === "json_schema") {
      return { ...base, response_format: { type: "json_schema", json_schema: { name: shape.name, strict: true, schema: shape.json } } };
    }
    if (o.mode === "tool") {
      return {
        ...base,
        tools: [{ type: "function", function: { name: shape.name, description: shape.description, parameters: shape.json } }],
        tool_choice: { type: "function", function: { name: shape.name } },
      };
    }
    return {
      ...base,
      response_format: { type: "json_object" },
      messages: [...messages, { role: "system", content: `Respond with only a JSON object matching this JSON schema:\n${JSON.stringify(shape.json)}` }],
    };
  }

  async function once<T>(messages: ChatMessage[], shape: Shape<T>, opts?: GenerateOptions): Promise<T> {
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${o.apiKey}`,
          "content-type": "application/json",
          "user-agent": o.userAgent ?? "mimic/0.1",
          // OpenCode Go requires a stable per-conversation session id for routing and prompt caching
          ...(opts?.sessionId ? { "x-opencode-session": opts.sessionId } : {}),
        },
        body: JSON.stringify(requestBody(messages, shape)),
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new RetryableError(`LLM request failed: ${(e as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`LLM HTTP ${res.status}`);
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message;
    const raw = o.mode === "tool" ? msg?.tool_calls?.[0]?.function?.arguments : msg?.content;
    if (typeof raw !== "string") throw new RetryableError("LLM returned no content");
    let parsed: unknown;
    try {
      parsed = parseJsonLoose(raw);
    } catch (e) {
      throw e instanceof RetryableError ? e : new RetryableError(`invalid JSON: ${(e as Error).message}`);
    }
    const out = shape.zod.safeParse(parsed);
    if (!out.success) throw new RetryableError(`schema mismatch: ${out.error.message}`);
    return out.data;
  }

  async function withRetries<T>(messages: ChatMessage[], shape: Shape<T>, opts?: GenerateOptions): Promise<T> {
    const attempts = 1 + (o.retries ?? 2);
    for (let i = 0; ; i++) {
      try {
        return await once(messages, shape, opts);
      } catch (e) {
        if (!(e instanceof RetryableError) || i + 1 >= attempts) throw e;
        await new Promise((r) => setTimeout(r, (o.retryDelayMs ?? 500) * 2 ** i));
      }
    }
  }

  return {
    generate: (messages, opts) => withRetries(messages, REPLY, opts),
    summarize: (messages, opts) => withRetries(messages, NOTES, opts),
  };
}
