# Architecture

This document describes how the backend and frontend are structured, how a request flows
through the system, and where each responsibility lives in the source tree.

## 1. Runtime components

```
                    ┌─────────────┐       Redis pub/sub        ┌──────────────┐
   HTTP / WS  ┌────► │  Express    │ ─── market:ticks ────────► │  WS server   │ ──► dashboards
 ────────────►│      │  API        │ ─── market:events ───────► │  (one Redis  │
   clients    │      └─────┬───────┘                            │  subscriber) │
              │            │                                    └──────────────┘
              │            │ reads/writes
              │            ▼
              │      ┌─────────────┐        ┌───────────────────────────────┐
              │      │  Postgres   │        │  Redis                        │
              │      │  (Prisma)   │        │  market:refcount:<sym>        │
              │      │  durable    │        │  market:state:<sym>  (hash)   │
              │      │  per-user   │        │  market:history:<sym> (zset)  │
              │      │  state      │        │  llm:budget:*                 │
              │      └─────────────┘        └───────────────┬───────────────┘
              │                                             ▲ writes market:state
              │      ┌──────────────────────────────────────┴───────────────┐
              └────► │  Composite market-data provider (poll loop)          │
                     │  Yahoo (primary) │ Twelve Data (cross-check) │ Replay │
                     └──────────────────────────────────────────────────────┘
```

- **Postgres** holds everything that must survive a restart: users, watchlist rows, the
  per-user last-seen snapshot, the discrete event log, and computed per-symbol
  statistics.
- **Redis** holds only regenerable state: the current market state per symbol, cached
  daily-bar history, subscription reference counts, and the LLM budget counters. All of
  it is rebuilt on boot or on demand.
- The **composite provider** runs a single poll loop in the API process. It is the only
  writer of `market:state`.
- The **WebSocket server** shares the API's HTTP server and holds one Redis subscriber
  for the whole process.

## 2. Process startup sequence

`backend/src/server.ts`, in order:

1. `prisma.$connect()`.
2. **Reconcile refcounts.** `market:refcount:*` is rebuilt from the `WatchlistItem`
   table (`groupBy` symbol). Redis is not durable, so this must run every boot or the
   "only poll watched symbols" invariant breaks after any Redis restart.
3. **Replay-mode backfill.** In `replay` mode, `backfillMissingHistory()` is awaited so
   the app is fully seeded before it serves a request. Synthetic history is instant.
4. Build the Express app, create the HTTP server, attach the WebSocket server.
5. **Bind the port**, and only then start ingestion. The port acts as a mutex: a second
   instance fails `listen()` with `EADDRINUSE` and exits, rather than starting a second
   poll loop that would fight the first one for `market:state`.
6. `compositeProvider.start(MARKET_POLL_INTERVAL_MS)` — one immediate poll cycle, then
   fixed-rate scheduling.
7. `startScheduledJobs()` — staleness sweep, stats recompute, refcount reconcile, the
   52-week history refresh and event-feed ingestion (the last two also run once
   immediately, and the feed logs whether it is enabled either way).
8. **Live-mode backfill.** In `live` mode, `backfillMissingHistory()` is kicked off in
   the background after `listen()` so the port is not held closed during the fetch.

## 3. Data stores

### 3.1 Postgres schema (`backend/prisma/schema.prisma`)

| Model             | Purpose                                                                                                           | Key fields                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `User`            | Account                                                                                                           | `id`, `email` (unique, normalized), `passwordHash` (bcrypt)                                                             |
| `WatchlistItem`   | One row per watched symbol per user                                                                               | `userId`, `symbol`, unique `(userId, symbol)`                                                                           |
| `UserSymbolState` | The per-user last-seen snapshot — the basis of every diff                                                         | `lastSeenAt`, `lastSeenPrice`, `lastSeenVolume`, `lastSeen52wHigh`, `lastSeen52wLow`, unique `(userId, symbol)`         |
| `SymbolEvent`     | Append-only log of discrete events (52-week breaks, feed-sourced news / corporate actions, admin-triggered demos) | `symbol`, `eventType`, `eventTime`, `severity`, `payload` (JSON), `source`, `externalId`, unique `(symbol, externalId)` |
| `SymbolStats`     | Computed per-symbol statistics the scorer reads                                                                   | `avgVolume20d`, `stdevReturn20d`, `high52w`, `low52w`, `avgOvernightGapPct`, `historyDays`, `computedAt`                |

Enums: `EventType` (7 values), `Severity` (`MINOR`, `NOTABLE`, `CRITICAL`).

### 3.2 Redis keyspace

| Key / channel                      | Type                   | Written by               | Contents                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `market:refcount:<symbol>`         | string (int)           | subscription manager     | Number of watchlists referencing the symbol; `> 0` means "poll this"                                                                                                                                                                |
| `market:state:<symbol>`            | hash                   | `market-state-writer.ts` | `price`, `primarySource`, `primaryPrice`, `secondaryPrice`, `isDivergent`, `divergencePct`, `volume`, `dayOpen`, `prevClose`, `sessionOpenedAt`, `sessionElapsedFraction`, `updatedAt`, `marketStatus`, `isStale`, `mode`, `source` |
| `market:history:<symbol>`          | sorted set             | `history.store.ts`       | Closed daily bars as JSON, score = bar date in epoch ms. Retained by time: a rolling 52 weeks (`HISTORY_WINDOW_DAYS`), capped at `MAX_HISTORY_BARS`                                                                                 |
| `market:intraday:<symbol>`         | string (JSON bar)      | `market-state-writer.ts` | The current session's in-progress daily bar, widened on every tick. Promoted into `market:history` once its session date has passed                                                                                                 |
| `market:history:refreshed:<sym>`   | string (ISO date)      | `history-refresh.ts`     | Session date this symbol was last re-fetched from the provider for; caps the refetch at once per symbol per day                                                                                                                     |
| `ws:ticket:<sha256>`               | string (JSON), TTL 30s | `ws-ticket.service.ts`   | Identity behind one single-use WebSocket ticket, keyed by the ticket's hash so the stored value cannot be replayed. Removed by the `GETDEL` that redeems it                                                                         |
| `llm:budget:minute:<epoch-minute>` | string (int), TTL 120s | LLM budget guard         | Gemini requests this minute                                                                                                                                                                                                         |
| `llm:budget:day:<UTC-date>`        | string (int), TTL 48h  | LLM budget guard         | Gemini requests today                                                                                                                                                                                                               |
| `market:ticks`                     | pub/sub channel        | `market-state-writer.ts` | Price/volume tick payloads                                                                                                                                                                                                          |
| `market:events`                    | pub/sub channel        | `market-state-writer.ts` | Discrete-event payloads                                                                                                                                                                                                             |

`market:state` is read back through `read-state.ts`, which treats a hash without a
`price` field as "no state" so a symbol touched only by the staleness sweep does not
render as ₹0.00.

## 4. Market-data ingestion

### 4.1 Reference-counted subscriptions (`backend/src/application/ingestion/subscription-manager.ts`)

- `subscribe(symbol)` / `unsubscribe(symbol)` `INCR` / `DECR` `market:refcount:<symbol>`;
  the key is deleted at zero.
- `getActiveSymbols()` returns every symbol with a live refcount, using `SCAN` (not
  `KEYS`) so it never blocks the Redis event loop. The poll loop, the staleness sweep and
  the stats job all iterate this set.
- `reconcileRefcounts(map)` rebuilds the whole keyspace from Postgres on boot.

### 4.2 Provider interface (`backend/src/domain/ports/market-data.port.ts`)

```ts
interface MarketDataProvider {
  readonly name: "TWELVE_DATA" | "YAHOO" | "REPLAY";
  start(): Promise<void>;
  stop(): Promise<void>;
  fetchQuotes(symbols: string[]): Promise<Quote[]>;
  fetchDailyHistory(symbol: string, days: number): Promise<DailyBar[]>;
}
```

Three implementations:

| Provider             | Role                     | Notes                                                                                                                                                                                        |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YahooProvider`      | Live **primary**         | Unofficial endpoint, no key. Self-throttled: ≤ 6 requests in flight, request starts spaced 150 ms apart, 10 s timeout each. No batch endpoint — one request per symbol per cycle.            |
| `TwelveDataProvider` | Live **cross-check**     | Batched, keyed. On the free/basic plan every NSE symbol 404s, so it contributes only when an upgraded key is present. Its absence never blocks a cycle.                                      |
| `ReplayProvider`     | Fallback / `replay` mode | Fully synthetic, no network. Driven by a virtual clock (`SESSION_LENGTH_MS = 4 min` per simulated trading day) and per-tier volatility profiles. Also serves synthetic history for backfill. |

### 4.3 Composite provider poll cycle (`backend/src/application/market-data/composite-provider.ts`)

`start()` runs one cycle immediately, then `scheduleNextCycle()` re-arms from the
**cycle's start time** (fixed-rate), so the configured `MARKET_POLL_INTERVAL_MS` is the
actual cadence rather than a floor that grows with symbol count. A `pollInFlight` guard
skips (does not queue) a tick if the previous cycle is still running. Cycle duration is
logged every cycle and escalated to a warning as it approaches `STALE_THRESHOLD_MS`.

`pollOnce()` decision table, for the current set of active symbols:

| Condition                                   | Behaviour                                                                                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARKET_DATA_MODE` effective = `replay`     | Replay quotes for all symbols → `writeMarketState(q, null)`                                                                                                                              |
| Live mode, `getMarketStatus() === "CLOSED"` | Replay quotes for all symbols, labeled `mode/source = REPLAY` (dashboard keeps moving instead of aging into "stale")                                                                     |
| Live mode, market open                      | Yahoo + Twelve Data fetched **in parallel**; Yahoo is authoritative; symbols Yahoo did not answer for → replay fallback; Twelve Data quote (if any) passed as the divergence cross-check |

Every path funnels through the single writer.

### 4.4 The single writer (`backend/src/application/ingestion/market-state-writer.ts`)

`writeMarketState(primary, secondary)` is the one place event-detection logic lives,
independent of which provider produced the quote. Per call it:

1. Drains any queued admin commands for the symbol and applies overrides
   (`VOLUME_SPIKE` ×4 volume, `GAP_OPEN` synthetic gap, `FIFTY_TWO_WEEK_EXTREME` ±5 %
   price nudge, `DIVERGE` fabricated secondary price).
2. Computes divergence (`checkDivergence`, threshold per volatility tier) or applies a
   forced one.
3. `checkFiftyTwoWeekExtreme` — updates the running `high52w` / `low52w` in `SymbolStats`
   on every tick, but records a `FIFTY_TWO_WEEK_EXTREME` event only once per 15-minute
   cooldown per direction.
4. Detects a new session by comparing `dayOpen` to the stored value.
5. `HSET`s the `market:state` hash and `PUBLISH`es a tick (and any discrete event).

### 4.5 Historical backfill (`backend/src/application/market-data/historical-backfill.ts`)

| Entry point                | Trigger                               | Scope                                                 |
| -------------------------- | ------------------------------------- | ----------------------------------------------------- |
| `backfillMissingHistory()` | Boot                                  | Watched symbols with no cached history                |
| `ensureHistory(symbol)`    | Called by `watchlist.service.addItem` | The one symbol just added; no-op once a window exists |
| `backfillUniverse()`       | `npm run seed`                        | The entire symbol universe                            |

Backfill requests `HISTORY_FETCH_DAYS` (52 weeks plus slack) of daily bars, falls back to
synthetic bars if the real fetch returns nothing, stores them in
`market:history:<symbol>`, computes `SymbolStats`, and seeds an honestly-labeled stale
`market:state` from the last bar so a freshly added symbol is renderable before its first
poll.

### 4.6 The rolling 52-week window (`backend/src/domain/market/history-window.ts`, `application/market-data/history-refresh.ts`)

Backfill fills the window; it does not keep it current. Three mechanisms do that, and all
three are needed for `high52w` / `low52w` to mean what their names say:

| Mechanism                                             | Runs                   | Keeps honest                                                                         |
| ----------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `history.store.recordIntradayPrice()`                 | Every tick, both modes | The leading edge reaches _now_, not the last closed session                          |
| `history-refresh.promoteClosedIntradayBar()`          | Every 30 min           | Yesterday's in-progress bar becomes a closed one, with no network and in replay mode |
| `history-refresh` provider refetch + `trimToWindow()` | Once per symbol/day    | Provider-authoritative bars replace poll-sampled ones; aged-out bars leave           |

`domain/market/history-window.ts` holds the arithmetic — window selection, bar merging,
in-progress bar extension and the whole of `SymbolStats` — as pure functions, so the
window's behaviour is testable without Redis or a provider.

The 20-day statistics use closed bars only; the 52-week extremes additionally fold in the
in-progress bar. That split is deliberate: a partial session's volume would drag
`avgVolume20d` down all day, whereas an intraday high is a real high the moment it prints.

## 5. The snapshot / diff model

### 5.1 Read vs. acknowledge

| Endpoint                  | Writes?         | Effect                                                                                                    |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/watchlist`      | No              | Recomputes the diff fresh from `market:state` + `SymbolStats` + `UserSymbolState` + recent `SymbolEvent`s |
| `POST /api/watchlist/ack` | Yes (only this) | Advances `UserSymbolState` to the current price/volume/52-week band, server-clock timestamp only          |

Because the read never writes, refreshing the page cannot lose an unseen change.
Concurrent devices converge on `max(lastSeenAt)` with no conflict resolution.

### 5.2 Event catalogue

| Event type               | Produced where                           | Rule                                                                                                                                    |
| ------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PRICE_MOVE`             | Diff engine (pure)                       | z-score of return since `lastSeenPrice` vs `stdevReturn20d`, scaled by √(trading sessions elapsed), clamped to `[1, 20]` sessions       |
| `VOLUME_SPIKE`           | Diff engine (pure)                       | Current session volume vs `avgVolume20d × sessionElapsedFraction`; also requires `volume > lastSeenVolume`                              |
| `GAP_OPEN`               | Diff engine (pure)                       | Only if a session boundary occurred after `lastSeenAt`; `                                                                               | open − prevClose | / prevClose`vs`avgOvernightGapPct` |
| `FIFTY_TWO_WEEK_EXTREME` | `market-state-writer.ts` → `SymbolEvent` | Price breaks stored `high52w` / `low52w`; 15-min per-direction cooldown                                                                 |
| `NEWS`                   | `event-feed-ingestor.ts` → `SymbolEvent` | Distinct stories in a 6 h window vs what this symbol normally draws over the previous week; capped at `NOTABLE` until a baseline exists |
| `CORPORATE_ACTION`       | `event-feed-ingestor.ts` → `SymbolEvent` | Dividend scored by yield against the current price; a split is always `CRITICAL`                                                        |
| `RATING_CHANGE`          | Admin panel → `SymbolEvent`              | Scored by distance moved on the analyst ladder. No free feed covers NSE, so in practice only the demo trigger produces these            |

Discrete events are filtered to `eventTime > lastSeenAt` before they reach the engine.

All three of the last group can also be produced by the admin panel for demos, recorded
with `source = ADMIN_DEMO`. The explanation layer branches on that field, so a real
dividend is never described as demo-triggered and a demo headline is never presented as
reporting.

### 5.2.1 Event feeds (`backend/src/domain/ports/event-feed.port.ts`)

| Provider                    | Serves            | Endpoint                                             |
| --------------------------- | ----------------- | ---------------------------------------------------- |
| `GoogleNewsFeed`            | News              | `news.google.com/rss/search`, region-scoped to India |
| `YahooCorporateActionsFeed` | Corporate actions | The chart endpoint with `?events=div,split`          |
| _(none)_                    | Rating changes    | —                                                    |

`CompositeEventFeed` unions its members' `capabilities`, and the ingestor reports a feed
with no provider as **unsupported** rather than returning zero items — "no source" and
"nothing happened" must not look the same. Deduplication is by `(symbol, externalId)`
unique constraint, so re-polling a feed is idempotent and two concurrent passes are safe.

### 5.3 Scoring (`backend/src/domain/diff/scoring.ts`)

Thresholds are exported as data (not inlined) so the explanation layer renders the exact
comparison that ran:

| Metric       | `CRITICAL` | `NOTABLE`      | `MINOR` |
| ------------ | ---------- | -------------- | ------- |
| `            | z          | ` (price move) | ≥ 3     | ≥ 1.5 | ≥ 0.75 |
| volume ratio | ≥ 3        | ≥ 2            | ≥ 1.5   |
| gap ratio    | ≥ 3        | ≥ 2            | ≥ 1.25  |

Guards: `stdevReturn20d` is floored at `0.001`; the √t horizon scale is clamped to
`[1, 20]` sessions; weekends contribute zero elapsed sessions (no holiday calendar).

### 5.4 Assembly (`backend/src/domain/diff/diff.engine.ts`)

`computeSymbolDiff(state, stats, baseline, discreteEvents)` is a **pure function** — no
Prisma, no Redis. `watchlist.service.ts` fetches everything up front and calls it per
symbol. It:

- collapses repeated same-direction `FIFTY_TWO_WEEK_EXTREME` events,
- sorts events by severity then recency,
- caps at `MAX_EVENTS_PER_SYMBOL = 5` and sets `overflow` if there were more,
- returns `maxSeverity`, `eventCount`, `overflow`, `events`.

`rankEntries()` orders watchlist rows by `maxSeverity` then `eventCount`. Rows for a
symbol that left the universe (`DELISTED`) or has no cached data yet (`NO_DATA`) are
returned with placeholder numbers, `maxSeverity = NONE`, and an `unavailable` object, so
the client renders a reason instead of a fake quote and the row never outranks a real
change.

### 5.5 Explanation traces (`backend/src/domain/diff/explain.ts`)

Each event is emitted with an `EventExplanation` built in the **same pass** that decided
its severity, from the same locals — so the "why?" panel cannot disagree with the badge.
The trace contains: `rule` + `ruleSource`, a `summary`, `inputs` (label / value /
source), `steps` (expression + value), the full `thresholds` ladder (every band tested,
not just the winner), `provenance` (source, mode, `isStale`, `isDivergent`,
`divergencePct`, `baselineAt`, `statsComputedAt`, `statsHistoryDays`), and `caveats`.
None of it is model-generated.

## 6. Real-time delivery

- `pubsub/redis-pubsub.ts` — `publish()` on the shared client; `subscribeToChannels()`
  opens one dedicated subscriber connection (ioredis puts a connection into
  subscriber-only mode on first `SUBSCRIBE`).
- `ws/ws.server.ts` — one `WebSocketServer` sharing the HTTP server. It keeps a
  `symbol → Set<connection>` reverse index so fan-out is O(interested connections), not
  O(all connections), per tick. Ticks are throttled to one per symbol per second per
  connection. Heartbeat: server `PING` every 30 s, connection dropped after 90 s with no
  `PONG`.
- `ws/ws.auth.ts` — the upgrade authenticates with a **single-use ticket**, never the
  session JWT. A browser `WebSocket` cannot set an `Authorization` header, so the client
  first calls `POST /api/auth/ws-ticket` (bearer-authenticated, over normal HTTP), then
  offers `Sec-WebSocket-Protocol: grow.ws-ticket.v1, <ticket>` on the upgrade. The server
  redeems the ticket with `GETDEL` and selects only the marker as the negotiated
  subprotocol, so the ticket appears in no response header. See
  `application/auth/ws-ticket.service.ts` for why each property is there.

## 7. Background jobs (`backend/src/application/jobs/scheduler.ts`)

| Job                                                       | Interval | Scope          | Action                                                                                                                                                            |
| --------------------------------------------------------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staleness sweep (`market-data/staleness.ts`)              | 10 s     | Active symbols | Sets `market:state.isStale` when `now − updatedAt > STALE_THRESHOLD_MS`                                                                                           |
| Stats recompute (`stats/stats-job.ts`)                    | 60 s     | Active symbols | Recomputes the whole of `SymbolStats` — including `high52w` / `low52w` — from the rolling 52-week window plus the current session's in-progress bar               |
| History refresh (`market-data/history-refresh.ts`)        | 30 min   | Active symbols | Promotes yesterday's in-progress bar, re-fetches from the provider once per symbol per session date (live mode only), trims bars that have aged out of the window |
| Event feed ingestion (`ingestion/event-feed-ingestor.ts`) | 15 min   | Active symbols | Polls the real news and corporate-action feeds, scores each item, writes new `SymbolEvent` rows. Skipped entirely unless `eventFeedEnabled` (`config/env.ts`)     |
| Refcount reconcile (`ingestion/subscription-manager.ts`)  | 5 min    | All watchlists | Rebuilds Redis refcounts from the durable `WatchlistItem` table                                                                                                   |

The history refresh also runs once immediately at startup rather than waiting out its
first interval, so a process that restarts every few hours still rolls its window.

`getMarketStatus()` derives `OPEN` / `CLOSED` from NSE hours (09:15–15:30 IST, Mon–Fri),
with no holiday calendar.

## 8. HTTP API

All `/api` routes except `/api/auth/register` and `/api/auth/login` require
`Authorization: Bearer <jwt>`. `/api/admin/*` uses `X-Admin-Key` instead. Unknown `/api`
paths return `404 {"error":"NOT_FOUND"}` as JSON; a malformed JSON body returns
`400 {"error":"INVALID_JSON"}`.

| Method & path                         | Auth      | Purpose                                                              |
| ------------------------------------- | --------- | -------------------------------------------------------------------- |
| `GET /health`                         | none      | `{ status, marketDataMode }`                                         |
| `POST /api/auth/register`             | none      | Create account, returns `{ user, token }`                            |
| `POST /api/auth/login`                | none      | Returns `{ user, token }`                                            |
| `GET /api/auth/me`                    | bearer    | Current user; `401` for a valid-signature token of a deleted user    |
| `POST /api/auth/ws-ticket`            | bearer    | `201 { ticket, expiresInSeconds }` — single-use WebSocket credential |
| `GET /api/watchlist`                  | bearer    | The diff response: `{ generatedAt, marketStatus, entries[] }`        |
| `GET /api/watchlist/items`            | bearer    | Raw watchlist rows `{ symbol, addedAt }`                             |
| `POST /api/watchlist/items`           | bearer    | `{ symbol }` — add; `404 UNKNOWN_SYMBOL`, `409 ALREADY_WATCHED`      |
| `DELETE /api/watchlist/items/:symbol` | bearer    | Remove; also drops the last-seen snapshot                            |
| `POST /api/watchlist/ack`             | bearer    | `{ symbols: [...] }` or `{ ackAll: true }` — advance the snapshot    |
| `GET /api/symbols/search?q=`          | bearer    | Universe search `{ symbol, name, sector, volatilityTier }`           |
| `POST /api/assistant/command`         | bearer    | `{ text, confirm? }` — see [assistant.md](assistant.md)              |
| `POST /api/assistant/explain`         | bearer    | `{ symbol, eventType, occurredAt? }` — trace + optional narration    |
| `GET /api/assistant/status`           | bearer    | LLM availability, model, budget, example commands                    |
| `POST /api/admin/trigger`             | admin key | `{ symbol, eventType, severity?, payload? }` — queue a demo event    |
| `GET /api/admin/symbols`              | admin key | Every universe symbol with its `market:state` and refcount           |
| `POST /api/admin/recompute-stats`     | admin key | Runs the stats job now, returns the recomputed symbols               |

## 9. WebSocket protocol (`backend/src/interfaces/ws/ws.protocol.ts`)

Connect to `/ws`, offering the subprotocol list `["grow.ws-ticket.v1", "<ticket>"]` where
`<ticket>` comes from `POST /api/auth/ws-ticket`. Nothing credential-shaped is in the URL.
The server answers `401` for an absent, malformed, expired or already-redeemed ticket —
the client's response to all four is the same: fetch a new ticket and retry.

| Client → server                    | Server → client                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `{ type: "SUBSCRIBE", symbols }`   | `{ type: "SUBSCRIBED", symbols }`                                                                   |
| `{ type: "UNSUBSCRIBE", symbols }` | `{ type: "TICK", symbol, price, changePct, volume, source, mode, isStale, isDivergent, updatedAt }` |
| `{ type: "PONG" }`                 | `{ type: "EVENT", symbol, eventType, severity, eventTime, payload }`                                |
|                                    | `{ type: "PING" }`                                                                                  |
|                                    | `{ type: "ERROR", message }`                                                                        |

## 10. Backend source layout

The backend is arranged as four concentric rings. The ordering below is the ordering that
matters: **dependencies point inward**, from volatile detail toward stable business rules,
and never the other way. Each ring's permitted imports are enforced as lint rules in
`eslint.config.mjs` — see [ADR 0003](adr/0003-clean-architecture-rings.md) and
[ADR 0004](adr/0004-lint-enforced-architecture-boundaries.md), and the component diagram in
[diagrams.md](diagrams.md#level-3--components-inside-the-api-process).

### Entry point and cross-cutting

| Path                | Responsibility                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/server.ts`     | Composition root: the startup sequence, and the only entry point                                              |
| `src/config/env.ts` | Zod-validated environment; `effectiveMarketDataMode`, `llmEnabled`. Readable from every ring except `domain/` |

### `domain/` — business rules

No framework, no driver, no vendor SDK, no environment. This code compiles with Express,
Prisma, Redis and Gemini all uninstalled, which is exactly what makes it testable without
any of them.

| Path                                                             | Responsibility                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/domain/diff/`                                               | `diff.engine`, `scoring`, `explain`, shared types — all unit-tested         |
| `src/domain/market/symbol-universe.ts`, `volatility-profiles.ts` | The static universe and per-tier synthetic parameters                       |
| `src/domain/market/divergence.ts`                                | Cross-source price disagreement, against the symbol's own tier              |
| `src/domain/assistant/command.rules.ts`, `assistant.types.ts`    | Deterministic command parser; the closed set of assistant actions           |
| `src/domain/watchlist/watchlist.types.ts`                        | Watchlist DTOs and domain errors                                            |
| `src/domain/auth/auth.types.ts`                                  | `JwtPayload`                                                                |
| `src/domain/ports/market-data.port.ts`                           | `MarketDataProvider`, `Quote`, `DailyBar` — the port the adapters implement |

### `application/` — use cases

Orchestration. Knows the domain and may drive infrastructure; knows nothing about HTTP or
WebSockets, so every use case is callable from a script, a job or a test.

| Path                                                 | Responsibility                                                |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `src/application/watchlist/watchlist.service.ts`     | Add / remove / diff / ack                                     |
| `src/application/auth/auth.service.ts`               | bcrypt, JWT issue and verify, `getUserById`                   |
| `src/application/assistant/`                         | `command.service`, `explain.service`                          |
| `src/application/ingestion/subscription-manager.ts`  | Refcount subscribe / unsubscribe / scan / reconcile           |
| `src/application/ingestion/market-state-writer.ts`   | The single `market:state` writer + event detection            |
| `src/application/market-data/composite-provider.ts`  | Poll loop and source orchestration                            |
| `src/application/market-data/historical-backfill.ts` | Boot / on-add / whole-universe history population             |
| `src/application/market-data/staleness.ts`           | Market-hours check and the staleness sweep                    |
| `src/application/stats/`                             | `stats.service` (compute + store), `stats-job` (periodic run) |
| `src/application/jobs/scheduler.ts`                  | Registers the interval jobs                                   |

### `infrastructure/` — technology detail

Concrete, swappable, and where every vendor-specific shape is confined.

| Path                                              | Responsibility                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `src/infrastructure/db/`                          | Prisma client, Redis client + subscriber factory                     |
| `src/infrastructure/market-data/providers/`       | `yahoo`, `twelve-data`, `replay` providers; `virtual-clock`          |
| `src/infrastructure/market-data/read-state.ts`    | Redis-backed `market:state` read model                               |
| `src/infrastructure/market-data/command-queue.ts` | In-memory queue for admin overrides, freeze set                      |
| `src/infrastructure/llm/gemini.client.ts`         | Fetch-only client, discriminated result                              |
| `src/infrastructure/llm/llm.budget.ts`            | Redis-backed spend ceilings                                          |
| `src/infrastructure/llm/intent.schema.ts`         | Gemini's structured-output shape, built from the domain's action set |
| `src/infrastructure/pubsub/redis-pubsub.ts`       | `publish` / `subscribeToChannels`, channel names                     |

### `interfaces/` — delivery

The outermost, most volatile ring. May use anything except `infrastructure/db` — a route
that queries a table would know that table's shape.

| Path                                   | Responsibility                                                        |
| -------------------------------------- | --------------------------------------------------------------------- |
| `src/interfaces/http/app.ts`           | Express wiring, `/health`, JSON 404 and error handlers                |
| `src/interfaces/http/async-handler.ts` | Promise-rejection → Express error path wrapper                        |
| `src/interfaces/http/routes/`          | `auth`, `watchlist`, `symbols`, `admin`, `assistant`                  |
| `src/interfaces/http/middleware/`      | `auth.middleware` (`requireAuth`), `admin.middleware` (`X-Admin-Key`) |
| `src/interfaces/http/express.d.ts`     | `Request.auth` augmentation                                           |
| `src/interfaces/ws/`                   | `ws.server`, `ws.auth`, `ws.protocol`                                 |

### `tests/` — mirrors the rings

| Path                 | Contents                                                             |
| -------------------- | -------------------------------------------------------------------- |
| `tests/unit/`        | Mirrors the ring under test; no I/O, runs in seconds                 |
| `tests/integration/` | Boots the real Express app over real HTTP                            |
| `tests/setup/env.ts` | Vitest `setupFile` supplying the environment `config/env.ts` demands |

## 11. Frontend source layout

| Path                                                                                               | Responsibility                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/main.tsx`                                                                                     | React root: `QueryClientProvider`, `BrowserRouter`, `AuthProvider`              |
| `src/App.tsx`                                                                                      | Routes: `/login`, `/register`, `/` (auth-gated dashboard), `/admin`             |
| `src/context/AuthContext.tsx`                                                                      | Session state, `login` / `register` / `logout`, session-expiry handling         |
| `src/api/client.ts`                                                                                | axios instance: bearer-token request interceptor, 401 → session-expired handler |
| `src/api/{auth,watchlist,symbols,assistant}.api.ts`                                                | Typed endpoint wrappers                                                         |
| `src/api/errors.ts`                                                                                | Server error-code → message mapping, `isAuthExpiry`                             |
| `src/hooks/useWatchlist.ts`                                                                        | Diff query (15 s refetch), items query, add/remove mutations                    |
| `src/hooks/useAck.ts`                                                                              | `ackSymbol` / `ackAll` mutations (invalidate the diff query)                    |
| `src/ws/useMarketSocket.ts`                                                                        | WebSocket connect + exponential-backoff reconnect, tick/event state             |
| `src/pages/`                                                                                       | `LoginPage`, `RegisterPage`, `DashboardPage`, `AdminDemoPage`                   |
| `src/components/WatchlistTable.tsx`                                                                | Renders rows, merges live ticks over the diff snapshot                          |
| `src/components/EventBadge.tsx`, `SeverityIcon.tsx`                                                | Per-event badge and severity glyph                                              |
| `src/components/ExplainDrawer.tsx`                                                                 | Renders an `EventExplanation` trace + optional narration                        |
| `src/components/CommandBar.tsx`                                                                    | Natural-language command input, shows how each command was interpreted          |
| `src/components/AddSymbolModal.tsx`, `SymbolSearch.tsx`                                            | Add-symbol flow                                                                 |
| `src/components/{MarketStatus,DataMode,Divergence,Staleness}Indicator.tsx`, `MarketStatusPill.tsx` | State pills                                                                     |
| `src/components/UnavailableNotice.tsx`                                                             | Renders the server's `unavailable` message for a `DELISTED` / `NO_DATA` row     |
| `src/lib/eventKey.ts`                                                                              | Content-derived stable identity for one event (drawer survives re-ranking)      |
| `src/types/index.ts`                                                                               | Response types mirroring the backend DTOs                                       |
| `tests/unit/lib/`                                                                                  | Unit tier over `src/lib/`; pure functions only, no DOM (see CONTRIBUTING.md)    |

## Design rationale

The complexity is concentrated in three places: the snapshot/diff engine, the
severity-scored event model with its decision traces, and the reference-counted
shared-cache ingestion path. The market-data layer is deliberately kept thin — one
interface with three interchangeable implementations — because the source of a quote is
not where the product's behaviour is defined.
