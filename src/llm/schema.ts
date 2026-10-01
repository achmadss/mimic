import { z } from "zod";

export const LLMOutputSchema = z.object({
  messages: z.array(z.object({ text: z.string().trim().min(1), correction: z.string().nullish() })).min(1),
  topic: z.string().nullish(),
});

/** Strict-mode compatible: every property required, optionals expressed as nullable. */
export const LLM_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["messages", "topic"],
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
  },
} as const;
