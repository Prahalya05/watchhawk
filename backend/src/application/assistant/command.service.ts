import { llmEnabled } from "../../config/env";
import { generateJson } from "../../infrastructure/llm/gemini.client";
import { INTENT_RESPONSE_SCHEMA } from "../../infrastructure/llm/intent.schema";
import { SYMBOL_MAP, SYMBOL_UNIVERSE, searchSymbols } from "../../domain/market/symbol-universe";
import * as watchlistService from "../watchlist/watchlist.service";
import { AlreadyWatchedError, NotWatchedError, UnknownSymbolError } from "../../domain/watchlist/watchlist.types";
import { parseWithRules, resolveSymbol } from "../../domain/assistant/command.rules";
import {
  CONFIRMATION_REQUIRED,
  rawIntentSchema,
  type AssistantIntent,
  type AssistantResult,
  type InterpretedBy,
  type RawIntent,
} from "../../domain/assistant/assistant.types";

// The catalogue is small enough (35 names) to hand to the model in full, which is what
// lets it map "the paint company" to ASIANPAINT without a retrieval step. It also bounds
// the output: every ticker it can name is one that exists.
const SYMBOL_CATALOGUE = SYMBOL_UNIVERSE.map((s) => `${s.symbol} (${s.name}, ${s.sector})`).join("\n");

const SYSTEM_INSTRUCTION = `You translate a user's natural-language request into one structured command for a stock watchlist app.

Rules:
- Choose exactly one action from the allowed list.
- Only use tickers from the catalogue below. Never invent a ticker.
- If the request names no symbol from the catalogue, or asks for something outside the action list, return action UNKNOWN with a short reason.
- Never guess between two similar companies. If it is genuinely ambiguous, return UNKNOWN and say which ones it could be.
- You are a parser. Do not answer questions, give investment advice, or add commentary.

Catalogue:
${SYMBOL_CATALOGUE}`;

// Built from the live universe rather than written out, so a rename or delisting can
// never leave the help text suggesting a ticker the app no longer tracks — the universe
// already carries two (Zomato to ETERNAL, Tata Motors to TMPV).
export const COMMAND_HINT_LIST = [
  `add ${SYMBOL_UNIVERSE[0]?.symbol ?? "TCS"}`,
  `remove ${SYMBOL_UNIVERSE[1]?.symbol ?? "INFY"}`,
  "dismiss all",
  `why ${SYMBOL_UNIVERSE[SYMBOL_UNIVERSE.length - 1]?.symbol ?? "SUZLON"}`,
  "show my watchlist",
];

const COMMAND_HINTS = COMMAND_HINT_LIST.join(" · ");

function normalizeIntent(raw: RawIntent): { intent: AssistantIntent; rejection?: string } {
  const intent: AssistantIntent = { action: raw.action };

  if (raw.reason) intent.reason = raw.reason;
  if (raw.query) intent.query = raw.query;

  // Never trust the model's ticker: resolve everything it returns against the universe.
  // A hallucinated symbol becomes a clean rejection here rather than a 404 from the
  // watchlist service or, worse, a row for a symbol nothing will ever poll.
  if (raw.symbol) {
    const resolved = resolveSymbol(raw.symbol);
    if (!resolved.symbol) {
      return {
        intent,
        rejection: resolved.ambiguous.length
          ? `"${raw.symbol}" could mean ${resolved.ambiguous.join(", ")} — say which one.`
          : `"${raw.symbol}" isn't a symbol this app tracks.`,
      };
    }
    intent.symbol = resolved.symbol;
  }

  if (raw.symbols?.length) {
    const resolved = raw.symbols.map((s) => resolveSymbol(s).symbol).filter((s): s is string => s !== null);
    if (resolved.length === 0) {
      return { intent, rejection: "None of those are symbols this app tracks." };
    }
    intent.symbols = resolved;
  }

  return { intent };
}

interface ParseOutcome {
  intent: AssistantIntent;
  interpretedBy: InterpretedBy;
  llmUsed: boolean;
  llmReason?: string;
  rejection?: string;
}

async function parseCommand(text: string): Promise<ParseOutcome> {
  const ruleResult = parseWithRules(text);
  if (ruleResult && !ruleResult.ambiguous) {
    return { intent: ruleResult.intent, interpretedBy: "RULES", llmUsed: false };
  }

  // The rules recognised the verb but not the target, and know exactly why. That is a
  // better error than anything the model would produce, so it short-circuits here.
  if (ruleResult?.ambiguous?.length) {
    return {
      intent: ruleResult.intent,
      interpretedBy: "RULES",
      llmUsed: false,
      rejection: `That could mean ${ruleResult.ambiguous.join(", ")} — say which one.`,
    };
  }

  if (!llmEnabled) {
    return {
      intent: { action: "UNKNOWN", reason: "no matching command pattern" },
      interpretedBy: "RULES",
      llmUsed: false,
      llmReason: "GEMINI_API_KEY is not set — only the built-in command patterns are available",
      rejection: `I couldn't read that as a command. Try: ${COMMAND_HINTS}`,
    };
  }

  const response = await generateJson<RawIntent>({
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt: text,
    schema: INTENT_RESPONSE_SCHEMA,
    maxOutputTokens: 256,
  });

  if (!response.ok) {
    return {
      intent: { action: "UNKNOWN", reason: response.reason },
      interpretedBy: "RULES",
      llmUsed: false,
      llmReason: `${response.reason}: ${response.detail}`,
      rejection: `I couldn't read that as a command, and the language model wasn't available to help. Try: ${COMMAND_HINTS}`,
    };
  }

  // Schema mode makes the shape likely, not certain — validate before acting on it.
  const parsed = rawIntentSchema.safeParse(response.value);
  if (!parsed.success) {
    return {
      intent: { action: "UNKNOWN", reason: "model returned an unrecognised command shape" },
      interpretedBy: "GEMINI",
      llmUsed: true,
      rejection: "I couldn't turn that into a command I know how to run.",
    };
  }

  const { intent, rejection } = normalizeIntent(parsed.data);
  return { intent, interpretedBy: "GEMINI", llmUsed: true, rejection };
}

async function execute(userId: string, intent: AssistantIntent): Promise<{ message: string; data?: unknown }> {
  switch (intent.action) {
    case "ADD_SYMBOL": {
      if (!intent.symbol) throw new UnknownSymbolError();
      await watchlistService.addItem(userId, intent.symbol);
      return { message: `Added ${intent.symbol} (${SYMBOL_MAP.get(intent.symbol)?.name}) to your watchlist.` };
    }

    case "REMOVE_SYMBOL": {
      if (!intent.symbol) throw new UnknownSymbolError();
      await watchlistService.removeItem(userId, intent.symbol);
      return { message: `Removed ${intent.symbol} from your watchlist.` };
    }

    case "ACK_SYMBOL": {
      if (!intent.symbol) throw new UnknownSymbolError();
      const result = await watchlistService.ackSymbols(userId, [intent.symbol]);
      return { message: `Marked ${intent.symbol} as seen. Its next diff starts from now.`, data: result };
    }

    case "ACK_ALL": {
      const result = await watchlistService.ackSymbols(userId, "ALL");
      return {
        message:
          result.acked.length > 0
            ? `Marked ${result.acked.length} symbol${result.acked.length === 1 ? "" : "s"} as seen.`
            : "Nothing to mark — your watchlist is empty.",
        data: result,
      };
    }

    case "SHOW_WATCHLIST": {
      const diff = await watchlistService.getWatchlistDiff(userId);
      const changed = diff.entries.filter((e) => e.events.length > 0);
      return {
        message:
          changed.length === 0
            ? `Nothing has changed across ${diff.entries.length} symbol${diff.entries.length === 1 ? "" : "s"} since you last looked.`
            : `${changed.length} of ${diff.entries.length} symbols changed: ${changed.map((e) => `${e.symbol} (${e.maxSeverity.toLowerCase()})`).join(", ")}.`,
        data: diff,
      };
    }

    case "EXPLAIN_SYMBOL": {
      if (!intent.symbol) throw new UnknownSymbolError();
      const diff = await watchlistService.getWatchlistDiff(userId);
      const entry = diff.entries.find((e) => e.symbol === intent.symbol);
      if (!entry) {
        return { message: `${intent.symbol} isn't on your watchlist, so there's nothing to explain yet.` };
      }
      if (entry.events.length === 0) {
        return { message: `${intent.symbol} hasn't changed since you last looked.`, data: entry };
      }
      return {
        message: `${intent.symbol}: ${entry.events.map((e) => e.explanation.summary).join(" ")}`,
        data: entry,
      };
    }

    case "SEARCH_SYMBOLS": {
      const results = searchSymbols(intent.query ?? "");
      return {
        message:
          results.length === 0
            ? `Nothing in the universe matches "${intent.query}".`
            : `${results.length} match${results.length === 1 ? "" : "es"}: ${results.map((r) => r.symbol).join(", ")}.`,
        data: results,
      };
    }

    case "UNKNOWN":
      return { message: intent.reason ?? "I couldn't read that as a command." };
  }
}

export async function runCommand(userId: string, text: string, confirmed: boolean): Promise<AssistantResult> {
  const parsed = await parseCommand(text);
  const llm = { enabled: llmEnabled, used: parsed.llmUsed, reason: parsed.llmReason };

  if (parsed.rejection) {
    return { intent: parsed.intent, interpretedBy: parsed.interpretedBy, status: "REJECTED", message: parsed.rejection, llm };
  }

  if (parsed.intent.action === "UNKNOWN") {
    return {
      intent: parsed.intent,
      interpretedBy: parsed.interpretedBy,
      status: "REJECTED",
      message: parsed.intent.reason ?? "I couldn't read that as a command.",
      llm,
    };
  }

  // The confirmation gate sits here, after parsing and before any write, so it applies
  // identically whether the intent came from the rules or from the model. Auto-executing
  // everything was the ask; auto-executing a *destructive* action off a natural-language
  // guess is a different thing, and one round-trip is cheap insurance against it.
  if (CONFIRMATION_REQUIRED.includes(parsed.intent.action) && !confirmed) {
    return {
      intent: parsed.intent,
      interpretedBy: parsed.interpretedBy,
      status: "NEEDS_CONFIRMATION",
      message: `Remove ${parsed.intent.symbol} from your watchlist? This also discards its last-seen baseline, so re-adding it starts fresh.`,
      llm,
    };
  }

  try {
    const { message, data } = await execute(userId, parsed.intent);
    return { intent: parsed.intent, interpretedBy: parsed.interpretedBy, status: "EXECUTED", message, data, llm };
  } catch (err) {
    // Domain errors are answers, not failures: "you already watch that" is the correct
    // response to a valid command, and should read like one rather than a 500.
    if (err instanceof AlreadyWatchedError) {
      return { intent: parsed.intent, interpretedBy: parsed.interpretedBy, status: "REJECTED", message: `${parsed.intent.symbol} is already on your watchlist.`, llm };
    }
    if (err instanceof NotWatchedError) {
      return { intent: parsed.intent, interpretedBy: parsed.interpretedBy, status: "REJECTED", message: `${parsed.intent.symbol} isn't on your watchlist.`, llm };
    }
    if (err instanceof UnknownSymbolError) {
      return { intent: parsed.intent, interpretedBy: parsed.interpretedBy, status: "REJECTED", message: "I couldn't tell which symbol you meant.", llm };
    }
    throw err;
  }
}
