import { ASSISTANT_ACTIONS } from "../../domain/assistant/assistant.types";
import type { GeminiSchema } from "./gemini.client";

// Mirrors rawIntentSchema (domain/assistant/assistant.types.ts) for Gemini's
// structured-output mode. The model is asked for exactly the shape the validator
// accepts, and the validator still runs on the result — the schema is a hint to the
// model, never a guarantee about what arrives.
//
// This lives in infrastructure rather than beside the intent vocabulary because the
// `OBJECT`/`STRING`/`nullable` shape is Gemini's wire format, not the assistant's
// domain model. Keeping it here means swapping the LLM vendor touches this file and
// gemini.client.ts, and leaves the closed action set — the thing that actually makes
// the assistant safe — untouched. `ASSISTANT_ACTIONS` is imported from the domain, so
// the enum offered to the model cannot drift from the enum the validator enforces.
export const INTENT_RESPONSE_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    action: {
      type: "STRING",
      enum: [...ASSISTANT_ACTIONS],
      description: "The single operation the user is asking for.",
    },
    symbol: {
      type: "STRING",
      description: "NSE ticker the command targets, if any. Prefer the ticker over the company name.",
      nullable: true,
    },
    symbols: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Multiple tickers, when the command names more than one.",
      nullable: true,
    },
    query: {
      type: "STRING",
      description: "Free-text search terms, for SEARCH_SYMBOLS only.",
      nullable: true,
    },
    reason: {
      type: "STRING",
      description: "For UNKNOWN only: a short plain-English note on why the command could not be mapped.",
      nullable: true,
    },
  },
  required: ["action"],
};
