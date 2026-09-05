import { llmEnabled } from "../../config/env";
import { generateText } from "../../llm/gemini.client";
import type { EventExplanation } from "../diff/diff.types";
import * as watchlistService from "../watchlist/watchlist.service";

// Plain-English narration of an explanation trace.
//
// The trace is the source of truth; this only rewords it. The model is given the computed
// object and forbidden from adding anything to it, because the moment a number in the
// narration can disagree with the number in the trace, the whole feature is worse than
// showing nothing — a confident wrong "why" is harder to catch than a raw formula.
//
// With no key, no budget, or a failed call, the deterministic summary is returned instead
// and labelled as such. The panel never loses its explanation because an API was down.

const SYSTEM_INSTRUCTION = `You explain why a stock watchlist flagged something, to an experienced investor.

Hard rules:
- Use ONLY the numbers, comparisons and caveats in the JSON you are given. Never introduce a number that is not there.
- Never give investment advice, a prediction, or a view on whether the move is good or bad.
- Explain what the rule measured and why it crossed the line it did.
- If the JSON lists caveats, work the most important one into your answer.
- Two or three sentences. Plain prose, no bullet points, no markdown, no preamble.`;

export type NarrationSource = "GEMINI" | "DETERMINISTIC";

export interface NarrationResult {
  text: string;
  generatedBy: NarrationSource;
  reason?: string;
}

export async function narrateExplanation(
  symbol: string,
  eventType: string,
  explanation: EventExplanation,
): Promise<NarrationResult> {
  if (!llmEnabled) {
    return {
      text: explanation.summary,
      generatedBy: "DETERMINISTIC",
      reason: "GEMINI_API_KEY is not set",
    };
  }

  const prompt = `Symbol: ${symbol}
Event type: ${eventType}

${JSON.stringify(
    {
      rule: explanation.rule,
      summary: explanation.summary,
      inputs: explanation.inputs,
      steps: explanation.steps,
      thresholds: explanation.thresholds,
      provenance: explanation.provenance,
      caveats: explanation.caveats,
    },
    null,
    2,
  )}`;

  const response = await generateText({ systemInstruction: SYSTEM_INSTRUCTION, prompt, maxOutputTokens: 300 });
  if (!response.ok) {
    return {
      text: explanation.summary,
      generatedBy: "DETERMINISTIC",
      reason: `${response.reason}: ${response.detail}`,
    };
  }

  return { text: response.value.trim(), generatedBy: "GEMINI" };
}

export interface ExplainEventResponse {
  symbol: string;
  eventType: string;
  severity: string;
  occurredAt: string;
  explanation: EventExplanation;
  narration: NarrationResult;
}

// Recomputes the caller's own diff rather than accepting an explanation from the client.
// The client already has the trace (it comes down with GET /api/watchlist), but echoing a
// client-supplied object into a prompt would let a caller narrate numbers the engine never
// produced — and attribute the result to this system.
export async function explainEvent(
  userId: string,
  symbol: string,
  eventType: string,
  occurredAt?: string,
): Promise<ExplainEventResponse | null> {
  const diff = await watchlistService.getWatchlistDiff(userId);
  const entry = diff.entries.find((e) => e.symbol === symbol);
  if (!entry) return null;

  const event =
    entry.events.find((e) => e.type === eventType && (!occurredAt || e.occurredAt === occurredAt)) ??
    entry.events.find((e) => e.type === eventType);
  if (!event) return null;

  const narration = await narrateExplanation(symbol, event.type, event.explanation);

  return {
    symbol,
    eventType: event.type,
    severity: event.severity,
    occurredAt: event.occurredAt,
    explanation: event.explanation,
    narration,
  };
}
