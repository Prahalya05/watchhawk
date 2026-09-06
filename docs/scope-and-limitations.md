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
- **A symbol can hold less than 52 weeks of history, and says so when it does.** The
  window itself is a real rolling 52 weeks now (see `domain/market/history-window.ts`),
  but a recently-added symbol, or one the provider only partly serves, still has fewer
  bars behind it than the window can hold. `SymbolStats.historyDays` records the true
  depth and the "why?" panel states it outright when it is short of a full window, rather
  than presenting a 90-day extreme as a 52-week one. It deepens on its own as the daily
  refresh accumulates sessions.
- **Severity thresholds are starting values**, not tuned against real data. They are
  centralized in `backend/src/domain/diff/scoring.ts`.
- **`NEWS` and `CORPORATE_ACTION` come from real feeds; `RATING_CHANGE` has no source
  that covers NSE.** Headlines come from Google News' region-scoped RSS search, dividends
  and splits from Yahoo's chart endpoint (`?events=div,split`), both ingested by
  `application/ingestion/event-feed-ingestor.ts`. Analyst ratings are the exception, and
  the reason is coverage rather than plumbing: Yahoo's `upgradeDowngradeHistory` returns
  972 entries for `AAPL` and `404 "No fundamentals data found"` for `RELIANCE.NS` and
  `TCS.NS` even with a valid crumb. `EventFeedProvider.capabilities` reports the feed as
  unsupported rather than returning an empty list, so "no source" is never rendered as
  "nothing happened", and every event records the `source` that produced it — the "why?"
  panel says which. The admin control panel still triggers all three by hand for demos,
  labelled `ADMIN_DEMO`.
- **News severity measures how much is being published, never what it says.** The count of
  distinct stories in a six-hour window is scored against what that symbol normally draws
  over the previous week — the same "compare it to itself" rule as `PRICE_MOVE`, and for
  the same reason: HDFCBANK draws eight stories on an ordinary weekday and an absolute
  threshold would pin it at `CRITICAL` forever. Until a symbol has a day of observed
  coverage, severity is capped at `NOTABLE`, because `CRITICAL` claims "unusual for this
  symbol" and that cannot be claimed without knowing usual.
- **Syndication is collapsed by headline similarity, which catches re-runs but not
  rewrites.** One announcement carried by four outlets in near-identical words becomes one
  event; four outlets writing genuinely different headlines about it stay four. The count
  is of reports, not of underlying facts. Translations into another script share no tokens
  and are never collapsed.
- **Headlines are matched to a symbol by company name, then re-checked against the ticker
  as a whole word.** A story that names the company only in its body is missed. That is
  the intended direction to fail in: a live run had a `"Reliance Industries"` query return
  an `Itl Industries` share-price page, and attributing another company's news to a
  watchlist row costs more trust than a missed headline costs attention.

## Statistics

- `high52w` / `low52w` are written from two directions, on purpose.
  `market-state-writer.ts` still advances them the instant a tick clears the previous
  extreme, so the event fires on the tick that earned it; the periodic stats job then
  recomputes them from the rolling window plus the current session's in-progress bar.
  Both agree because the writer folds each tick into that in-progress bar _before_
  checking the extreme. The job used to skip these two fields — correct while history was
  only ~90 days deep, since a recompute could only shrink a genuine 52-week figure, but
  wrong once the window is real: a value that only ever ratchets upward is a high-water
  mark, and an extreme that has aged out has to be allowed to fall.

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

- **The WebSocket upgrade carries a single-use ticket, not the session JWT.** A browser
  `WebSocket` still cannot set an `Authorization` header — that constraint has not
  changed — so the credential is exchanged first: `POST /api/auth/ws-ticket` mints a
  30-second, single-use ticket over an ordinary bearer-authenticated request, and the
  upgrade offers it in `Sec-WebSocket-Protocol` rather than in the query string. Only the
  ticket's SHA-256 is stored, redemption is a single atomic `GETDEL`, and the server
  negotiates only the scheme marker so the ticket is absent from the response headers
  too. A captured URL, access log line or `Referer` now yields nothing; a captured ticket
  yields at most one socket within 30 seconds.
- Residual, and accepted: a ticket is not bound to the client that requested it. Binding
  to an IP would break behind the NAT and proxy changes a normal browser session goes
  through, for a window that is already 30 seconds wide and single-use.
