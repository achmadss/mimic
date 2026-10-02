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
