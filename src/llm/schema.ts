import { z } from "zod";

export const LLMOutputSchema = z.object({
  messages: z.array(z.object({ text: z.string().trim().min(1), correction: z.string().nullish() })).min(1),
  topic: z.string().nullish(),
  /** Doc 05 §6: the summary Jev cannot write, when it marked a thread open. */
  openThread: z.string().nullish(),
});

/** Strict-mode compatible: every property required, optionals expressed as nullable. */
export const LLM_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["messages", "topic", "openThread"],
  properties: {
    messages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "correction"],
        properties: { text: { type: "string" }, correction: { type: ["string", "null"] } },
      },
    },
    topic: { type: ["string", "null"] },
    openThread: { type: ["string", "null"] },
  },
} as const;

/** Doc 05 §1 long-term layer: what falls out of the recent window, kept as notes. */
export const SummaryOutputSchema = z.object({
  summary: z.string().trim().min(1),
  facts: z.array(z.string().trim().min(1)),
});

export const SUMMARY_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "facts"],
  properties: {
    summary: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
  },
} as const;
