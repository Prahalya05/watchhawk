# The assistant

Two features share one module (`backend/src/modules/assistant/`): a natural-language
command bar and a plain-English event explainer. Both run on deterministic code by
default; Google Gemini is used only where the deterministic path cannot produce an
answer, and every LLM call has a working fallback.

## 1. Command bar

### 1.1 Endpoint

`POST /api/assistant/command`, body `{ text: string (1–500 chars), confirm?: boolean }`.
Returns:

```ts
{
  intent: { action, symbol?, symbols?, query?, reason? },
  interpretedBy: "RULES" | "GEMINI",
  status: "EXECUTED" | "NEEDS_CONFIRMATION" | "REJECTED",
  message: string,
  data?: unknown,
  llm: { enabled: boolean, used: boolean, reason?: string }
}
```

`GET /api/assistant/status` returns LLM availability, the model name, the current budget
counters, and a list of example commands derived from the live symbol universe.

### 1.2 Pipeline (`command.service.ts`)

```
text ──► parseWithRules ──► matched & unambiguous ──────────────► intent (interpretedBy: RULES)
             │
             ├─ verb matched, target ambiguous ────────────────► REJECTED ("could mean X, Y")
             │
             └─ no match ──► llmEnabled? ── no ────────────────► REJECTED (hint list)
                                    │
                                    yes
                                    ▼
                         generateJson (Gemini, schema mode)
                                    │
                    ┌───────────────┼────────────────┐
                    ▼               ▼                ▼
              call failed     shape invalid     raw intent
                    │               │                │
                    ▼               ▼                ▼
                REJECTED        REJECTED       normalizeIntent
                                              (resolve every ticker
                                               against the universe)
                                                     │
                                        ┌────────────┴───────────┐
                                        ▼                        ▼
                              unresolved / ambiguous       resolved intent
                                        │                        │
                                        ▼                        ▼
                                    REJECTED         confirmation gate ──► execute
```

- **Rules first.** `command.rules.ts` matches a verb (`add` / `watch` / `track` / …) and
  resolves the target in order: exact ticker, exact company name, unique word-prefix
  match on the name. Generic name words (`company`, `limited`, `industries`, …) are
  excluded from fragment matching so "the paint company" does not silently resolve to
  `TITAN`. Stopwords (`all`, `the`, `my`, …) are never treated as tickers.
- **Ambiguity is never guessed.** `add tata` returns `REJECTED` listing the candidates.
  If the rules recognised the verb but not the target, they short-circuit with their own
  (better) error rather than calling the model.
- **Gemini only for the remainder.** The model receives the full symbol catalogue in
  its system instruction, runs in JSON-schema mode at `temperature: 0`, and is
  instructed to act as a parser — one action from a closed list, tickers from the
  catalogue only, `UNKNOWN` with a reason otherwise.
- **Model output is not trusted.** Every ticker Gemini returns is re-resolved against
  the universe in `normalizeIntent`; a hallucinated symbol becomes a clean rejection.
  The raw shape is validated with Zod before anything executes.
- **Confirmation gate.** Actions in `CONFIRMATION_REQUIRED` (currently `REMOVE_SYMBOL`)
  return `NEEDS_CONFIRMATION` unless `confirm: true` was sent. The gate sits after
  parsing and before any write, so it applies identically to rules- and model-derived
  intents. Removing a symbol also discards its last-seen baseline, which re-adding does
  not restore — hence the extra round-trip.
- **Domain errors are answers.** "You already watch that" comes back as `REJECTED` with
  a sentence, not a 500.

### 1.3 Intent set

| Action | Effect | Confirmation |
| ------ | ------ | ------------ |
| `ADD_SYMBOL` | `watchlistService.addItem` | no |
| `REMOVE_SYMBOL` | `watchlistService.removeItem` | **yes** |
| `ACK_SYMBOL` | Ack one symbol | no |
| `ACK_ALL` | Ack the whole watchlist | no |
| `SHOW_WATCHLIST` | Summarise what changed since last look | no |
| `EXPLAIN_SYMBOL` | Return the event summaries for one symbol | no |
| `SEARCH_SYMBOLS` | Universe search | no |
| `UNKNOWN` | Return the parser's reason | n/a |

## 2. Event explainability

### 2.1 The trace

Every event returned by `GET /api/watchlist` already carries its full
`EventExplanation` (structure in [architecture.md §5.5](architecture.md#55-explanation-traces-backendsrcmodulesdiffexplaints)).
It is built in `diff/explain.ts` in the same pass that decides the severity, from the
same local variables, so it cannot drift from the badge it explains. Thresholds are read
from the single exported constant in `scoring.ts`. The trace renders **every** severity
band that was tested, not just the one that matched.

None of the trace is model-generated.

### 2.2 Optional narration

`POST /api/assistant/explain` with `{ symbol, eventType, occurredAt? }`:

1. Recomputes the caller's own diff (it does **not** accept an explanation object from
   the client — that would let a caller narrate numbers the engine never produced and
   attribute them to the system).
2. Finds the matching event.
3. Calls `narrateExplanation`, which hands the computed trace to Gemini with instructions
   to use only the numbers present, add no predictions or advice, and answer in two or
   three sentences of plain prose.

The response includes `narration: { text, generatedBy: "GEMINI" | "DETERMINISTIC", reason? }`.
With no key, an exhausted budget, or a failed call, `text` is the deterministic
`explanation.summary` and `generatedBy` is `DETERMINISTIC`. The UI labels a model-worded
answer as **AI-worded**.

## 3. Gemini client (`backend/src/llm/gemini.client.ts`)

- `fetch`-only, no SDK. Knows how to send a prompt and return text or schema-validated
  JSON; knows nothing about watchlists.
- Returns a discriminated result — `{ ok: true, value }` or
  `{ ok: false, reason, detail }` — never throws. Failure reasons: `NO_API_KEY`,
  `BUDGET_EXHAUSTED`, `TIMEOUT`, `RATE_LIMITED`, `HTTP_ERROR`, `EMPTY_RESPONSE`,
  `INVALID_JSON`.
- Key is sent as the `x-goog-api-key` header, not `?key=`, so it cannot land in a proxy
  log line.
- Timeout via `AbortController` (aborts the underlying request, freeing the rate-limit
  slot), configurable with `GEMINI_TIMEOUT_MS`.
- Schema mode uses Google's OpenAPI-subset schema type, kept as a local TypeScript type
  so a mismatch is a compile error rather than a runtime 400.

## 4. Budget guard (`backend/src/llm/llm.budget.ts`)

- Counters live in Redis (`llm:budget:minute:*`, `llm:budget:day:*`), not process memory,
  so a restart or a second instance does not hand out a fresh allowance. Both keys carry
  a TTL; nothing to clean up.
- `tryConsume()` increments then checks (atomic `INCR`); a caller that overshoots refunds
  its own increment and is denied. Overshooting a self-imposed ceiling by one is
  harmless.
- Ceilings are `GEMINI_MAX_REQUESTS_PER_MINUTE` / `_PER_DAY`. Google no longer publishes
  free-tier quotas, so these default to conservative values — check your key in
  [AI Studio](https://aistudio.google.com/rate-limit) and set them accordingly.
  Exhausting the budget degrades the assistant to its deterministic path; it never
  errors.

## 5. Configuration

Add a free key from [AI Studio](https://aistudio.google.com/apikey) to `backend/.env`:

```bash
GEMINI_API_KEY="..."
# optional overrides:
GEMINI_MODEL="gemini-2.5-flash"
GEMINI_TIMEOUT_MS="8000"
GEMINI_MAX_REQUESTS_PER_MINUTE="8"
GEMINI_MAX_REQUESTS_PER_DAY="200"
```

`llmEnabled` in `config/env.ts` is simply `GEMINI_API_KEY.length > 0`. Without the key
the command bar runs on its built-in patterns and event explanations render in full from
the computed trace; `GET /api/assistant/status` and the `llm` block on each command
response report which mode is active.

## 6. Module files

| File | Responsibility |
| ---- | -------------- |
| `assistant.routes.ts` | `/command`, `/explain`, `/status` routes; request validation |
| `assistant.types.ts` | Intent types, `CONFIRMATION_REQUIRED`, Zod schemas, Gemini response schema |
| `command.rules.ts` | Deterministic verb + symbol resolution, stopwords, generic-name-word exclusions |
| `command.service.ts` | Full parse → normalize → confirm → execute pipeline; example-command list |
| `explain.service.ts` | Recompute diff, find event, narrate; deterministic fallback |
| `../diff/explain.ts` | Builds the computed `EventExplanation` (the source of truth) |
| `../../llm/gemini.client.ts` | Gemini transport |
| `../../llm/llm.budget.ts` | Redis-backed request budget |
