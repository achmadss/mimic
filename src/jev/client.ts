export type JevInstructions = string | Record<string, unknown>;
export type JevQuestion =
  | { type: "noul"; instructions: JevInstructions }
  | { type: "choice"; instructions: JevInstructions; criteria: Record<string, string | null> }
  | { type: "score"; instructions: JevInstructions; criteria: string[] };
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };
export type JevAnswers = Record<string, JevAnswer>;

export interface JevClient {
  ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevAnswers>;
}

export function httpJevClient(opts: { apiKey: string; baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch }): JevClient {
  const f = opts.fetchFn ?? fetch;
  const url = `${opts.baseUrl ?? "https://api.typesafe.ai"}/v1/systemone`;
  return {
    async ask(state, questions) {
      const res = await f(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state, questions }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      if (!res.ok) throw new Error(`jev ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { answers?: JevAnswers };
      if (!body.answers) throw new Error("jev: response has no answers");
      return body.answers;
    },
  };
}
