# Scope and limitations

These are deliberate simplifications and known gaps. Each is also marked with a comment
at the relevant point in the code. They are grouped by area.

## Market data

- **Live mode requires a Twelve Data key to activate.** `effectiveMarketDataMode`
  (`config/env.ts`) downgrades `live` to `replay` when `TWELVE_DATA_API_KEY` is empty,
  even though Yahoo — the primary live source — needs no key. To run against live data,
  set both `MARKET_DATA_MODE=live` and a non-empty `TWELVE_DATA_API_KEY` (any value the
  Twelve Data client will accept; NSE coverage still depends on the plan, below).
- **Twelve Data's free/basic tier does not cover NSE at all.** Every quote and history
  call 404s with "available starting with the Grow or Venture plan" (confirmed by
  `npm run verify:live`). Yahoo is therefore the primary source for NSE quotes and
  history; Twelve Data is polled each cycle only as a cross-check and as an automatic
  upgrade path for a key whose plan does cover NSE. Its absence never blocks a cycle.
- **Yahoo Finance's endpoint is unofficial and unsupported.** It can change or start
  blocking without notice — real risk for a primary source. It has no published rate
  limit, so it is self-throttled client-side: ≤ 6 requests in flight, request starts
  spaced 150 ms apart, 10 s timeout each. There is no batch endpoint, so a poll cycle is
  one request per watched symbol; the scheduler is fixed-rate (timed from the cycle's
  start), so `MARKET_POLL_INTERVAL_MS` is the actual cadence, not a floor. Cycle
  duration is logged every cycle and warns as it approaches `STALE_THRESHOLD_MS`, past
  which every symbol reads as stale.
- **No NSE holiday calendar.** `getMarketStatus()` uses day-of-week + time-of-day only.
  A market holiday reads as `OPEN` with unchanged prices, and the `PRICE_MOVE` session
  scaling counts it as a trading session.
- **A ticker that leaves the universe keeps its row, marked `DELISTED`.** Renames and
  demergers happen (Zomato → `ETERNAL`, Tata Motors → `TMPV`). Such a row previously
  vanished from `GET /api/watchlist`, which is indistinguishable from a working
  watchlist. It now renders with no price and an explanation so it can be seen and
  removed.

## Event scoring

- **`PRICE_MOVE`'s z-score is scaled by elapsed trading time under a √t random-walk
  assumption.** `stdevReturn20d` is a daily figure, so a return accumulated over four
  sessions is judged against twice the bar of one accumulated in an afternoon. Elapsed
  time counts only NSE session overlap, so a weekend contributes nothing. Two clamps: it
  never scales below one session (√t under-states minute-scale volatility) and never past
  20 sessions (the window the stdev covers). Both are disclosed per-event in the "why?"
  panel when they decided the score.
- **"52-week" high/low is actually a ~90-day window.** `SymbolStats.historyDays` records
  the true figure, and the UI shows it, rather than mislabeling the window.
- **Severity thresholds are starting values**, not tuned against real data. They are
  centralized in `backend/src/domain/diff/scoring.ts`.
- **`NEWS` / `RATING_CHANGE` / `CORPORATE_ACTION` events are demo-triggered only.** They
  enter through the admin control panel's command queue, not a news provider. The event
  model, severity scoring and diff path around them are real; the feed is not.

## Statistics

- `high52w` / `low52w` are maintained live by `market-state-writer.ts` off incoming
  prices and are deliberately **not** recomputed by the periodic stats job — a batch
  recompute from a limited history window could shrink them incorrectly.

## Assistant (Gemini)

- **The Gemini path has not been exercised against the live API.** No key was available
  during development, so the deterministic parser, every fallback, the budget guard and
  the explanation traces are verified end-to-end, but the actual `generateContent` call
  is not.
- **The Gemini budget ceilings are self-imposed, not Google's.** Google no longer
  publishes free-tier quotas, so `GEMINI_MAX_REQUESTS_PER_MINUTE` / `_PER_DAY` default to
  conservative values — check your key in AI Studio and set them accordingly. Exhausting
  them degrades the assistant to its deterministic path; it never errors.
- **Command coverage without a key is narrower than with one.** The pattern parser
  handles the verbs and phrasings in `command.rules.ts`; anything outside them is
  rejected with a hint rather than guessed at. A wrongly auto-executed command is worse
  than a "say that another way".

## Testing

- **Coverage is deliberately narrow.** `npm test` (Vitest) covers the diff engine, the
  severity scorer, the explanation traces, the command parser and the auth service —
  the parts where a silent mistake would be invisible (a wrong severity still renders a
  plausible badge; a wrong "why?" panel looks as authoritative as a right one; a
  guessing command parser executes the wrong action confidently).
- The routes, providers and ingestion path are verified by running the application and
  by `npm run verify:live`, not by unit tests. They fail loudly when they fail.

## Transport

- The WebSocket JWT is passed as a `?token=` query parameter because a browser
  `WebSocket` cannot set an `Authorization` header. This can land in access logs and is
  acceptable for a local demo only.
