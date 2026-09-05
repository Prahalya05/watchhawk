import { z } from "zod";
import type { GeminiSchema } from "../../llm/gemini.client";

// The assistant's whole vocabulary. Keeping it a closed set is the safety property that
// matters: a natural-language string is turned into one of these and nothing else, so
// there is no path from user prose (or from model output) to an arbitrary operation.
// Adding a capability means adding a case here and an executor for it — never widening
// what a parsed intent is allowed to say.
export const ASSISTANT_ACTIONS = [
  "ADD_SYMBOL",
  "REMOVE_SYMBOL",
  "ACK_SYMBOL",
  "ACK_ALL",
  "SHOW_WATCHLIST",
  "EXPLAIN_SYMBOL",
  "SEARCH_SYMBOLS",
  "UNKNOWN",
] as const;

export type AssistantAction = (typeof ASSISTANT_ACTIONS)[number];

// Destructive in the sense that matters to a user mid-demo: it discards state they can't
// get back by re-running the command. Removing a symbol drops its UserSymbolState row,
// which is the baseline that makes "what changed since I last looked" mean anything —
// re-adding gives you a symbol with a fresh baseline, not the one you had. Acking is
// deliberately NOT on this list: it only advances a timestamp forward.
export const CONFIRMATION_REQUIRED: readonly AssistantAction[] = ["REMOVE_SYMBOL"];

export const rawIntentSchema = z.object({
  action: z.enum(ASSISTANT_ACTIONS),
  symbol: z.string().nullish(),
  symbols: z.array(z.string()).nullish(),
  query: z.string().nullish(),
  reason: z.string().nullish(),
});

export type RawIntent = z.infer<typeof rawIntentSchema>;

export interface AssistantIntent {
  action: AssistantAction;
  symbol?: string;
  symbols?: string[];
  query?: string;
  reason?: string;
}

// Mirrors rawIntentSchema for Gemini's structured-output mode. The two are kept adjacent
// on purpose: the model is asked for exactly the shape the validator accepts, and the
// validator still runs on the result — the schema is a hint to the model, never a
// guarantee about what arrives.
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

export type InterpretedBy = "RULES" | "GEMINI";
export type ExecutionStatus = "EXECUTED" | "NEEDS_CONFIRMATION" | "REJECTED";

export interface AssistantResult {
  intent: AssistantIntent;
  interpretedBy: InterpretedBy;
  status: ExecutionStatus;
  message: string;
  data?: unknown;
  // Surfaced to the client on every response, including the ones the model never touched,
  // so the UI can always say truthfully how a command was understood rather than letting
  // the user assume there was an LLM in the loop.
  llm: {
    enabled: boolean;
    used: boolean;
    reason?: string;
  };
}
