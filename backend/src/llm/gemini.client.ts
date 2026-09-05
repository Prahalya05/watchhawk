import { env, llmEnabled } from "../config/env";
import { tryConsume, readBudget, type BudgetStatus } from "./llm.budget";

// Thin client for the Gemini generateContent endpoint. Deliberately dependency-free
// (fetch only) and deliberately narrow: it knows how to send a prompt and hand back
// either text or schema-validated JSON, and nothing about watchlists.
//
// Every call can fail — no key, budget exhausted, timeout, 429, malformed JSON — and
// every caller has a working non-LLM path, so this returns a discriminated result rather
// than throwing. An unavailable model degrades the feature; it never breaks a request.

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiFailureReason =
  | "NO_API_KEY"
  | "BUDGET_EXHAUSTED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "EMPTY_RESPONSE"
  | "INVALID_JSON";

export type GeminiResult<T> =
  | { ok: true; value: T; budget: BudgetStatus }
  | { ok: false; reason: GeminiFailureReason; detail: string };

// Google's structured-output schema is an OpenAPI subset, not JSON Schema: uppercase
// type names, no $ref, no additionalProperties. Kept as a local type so a mismatch is a
// compile error here rather than a 400 at runtime.
export interface GeminiSchema {
  type: "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN";
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: string[];
  description?: string;
  nullable?: boolean;
}

interface GenerateArgs {
  systemInstruction: string;
  prompt: string;
  // Omit for prose. Supplying one switches the model into JSON mode, which is what makes
  // command parsing safe to feed into a validator instead of regexing prose for intent.
  schema?: GeminiSchema;
  maxOutputTokens?: number;
}

async function generate(args: GenerateArgs): Promise<GeminiResult<string>> {
  if (!llmEnabled) {
    return { ok: false, reason: "NO_API_KEY", detail: "GEMINI_API_KEY is not set" };
  }

  const { allowed, status } = await tryConsume();
  if (!allowed) {
    return {
      ok: false,
      reason: "BUDGET_EXHAUSTED",
      detail: `self-imposed cap reached (${status.minuteUsed}/${status.minuteLimit} this minute, ${status.dayUsed}/${status.dayLimit} today)`,
    };
  }

  // AbortController rather than Promise.race: a race leaves the underlying request
  // running and still consuming a rate-limit slot after we have stopped waiting for it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header rather than ?key=, so the key cannot end up in a proxy or server log line.
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: args.prompt }] }],
        generationConfig: {
          // Zero temperature throughout: this model is being used as a parser and as a
          // renderer of numbers that were already computed. Neither job wants variety.
          temperature: 0,
          maxOutputTokens: args.maxOutputTokens ?? 512,
          ...(args.schema ? { responseMimeType: "application/json", responseSchema: args.schema } : {}),
        },
      }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      return { ok: false, reason: "RATE_LIMITED", detail: "Gemini returned 429 (quota exceeded)" };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: "HTTP_ERROR", detail: `Gemini returned ${res.status}: ${body.slice(0, 200)}` };
    }

    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (text.trim().length === 0) {
      const finish = body.candidates?.[0]?.finishReason ?? "unknown";
      return { ok: false, reason: "EMPTY_RESPONSE", detail: `no text in response (finishReason: ${finish})` };
    }

    return { ok: true, value: text, budget: status };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "TIMEOUT", detail: `no response within ${env.GEMINI_TIMEOUT_MS}ms` };
    }
    return { ok: false, reason: "HTTP_ERROR", detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export async function generateText(args: Omit<GenerateArgs, "schema">): Promise<GeminiResult<string>> {
  return generate(args);
}

export async function generateJson<T>(args: GenerateArgs & { schema: GeminiSchema }): Promise<GeminiResult<T>> {
  const result = await generate(args);
  if (!result.ok) return result;

  try {
    return { ok: true, value: JSON.parse(result.value) as T, budget: result.budget };
  } catch {
    // JSON mode makes this unlikely but not impossible (a truncated response still
    // parses as text). Callers validate the shape afterwards regardless — this only
    // catches the case where there is no object to validate at all.
    return { ok: false, reason: "INVALID_JSON", detail: result.value.slice(0, 200) };
  }
}

export async function llmStatus(): Promise<{
  available: boolean;
  model: string;
  budget: BudgetStatus | null;
}> {
  if (!llmEnabled) return { available: false, model: env.GEMINI_MODEL, budget: null };
  const budget = await readBudget();
  return { available: !budget.exhausted, model: env.GEMINI_MODEL, budget };
}
