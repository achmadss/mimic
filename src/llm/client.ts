import type { LLMOutput } from "../types.ts";
import { LLMOutputSchema, LLM_OUTPUT_JSON_SCHEMA } from "./schema.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface LLMClient {
  generate(messages: ChatMessage[]): Promise<LLMOutput>;
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

  function requestBody(messages: ChatMessage[]) {
    const base = { model: o.model, messages };
    if (o.mode === "json_schema") {
      return { ...base, response_format: { type: "json_schema", json_schema: { name: "reply", strict: true, schema: LLM_OUTPUT_JSON_SCHEMA } } };
    }
    if (o.mode === "tool") {
      return {
        ...base,
        tools: [{ type: "function", function: { name: "reply", description: "Send the character's reply", parameters: LLM_OUTPUT_JSON_SCHEMA } }],
        tool_choice: { type: "function", function: { name: "reply" } },
      };
    }
    return {
      ...base,
      response_format: { type: "json_object" },
      messages: [...messages, { role: "system", content: `Respond with only a JSON object matching this JSON schema:\n${JSON.stringify(LLM_OUTPUT_JSON_SCHEMA)}` }],
    };
  }

  async function once(messages: ChatMessage[]): Promise<LLMOutput> {
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody(messages)),
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
    const out = LLMOutputSchema.safeParse(parsed);
    if (!out.success) throw new RetryableError(`schema mismatch: ${out.error.message}`);
    return out.data;
  }

  return {
    async generate(messages) {
      const attempts = 1 + (o.retries ?? 2);
      for (let i = 0; ; i++) {
        try {
          return await once(messages);
        } catch (e) {
          if (!(e instanceof RetryableError) || i + 1 >= attempts) throw e;
          await new Promise((r) => setTimeout(r, (o.retryDelayMs ?? 500) * 2 ** i));
        }
      }
    },
  };
}
