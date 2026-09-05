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
7. `startScheduledJobs()` — staleness sweep and stats recompute intervals.
8. **Live-mode backfill.** In `live` mode, `backfillMissingHistory()` is kicked off in
   the background after `listen()` so the port is not held closed during the fetch.

## 3. Data stores

### 3.1 Postgres schema (`backend/prisma/schema.prisma`)

| Model             | Purpose                                                                                  | Key fields                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `User`            | Account                                                                                  | `id`, `email` (unique, normalized), `passwordHash` (bcrypt)                                                     |
| `WatchlistItem`   | One row per watched symbol per user                                                      | `userId`, `symbol`, unique `(userId, symbol)`                                                                   |
| `UserSymbolState` | The per-user last-seen snapshot — the basis of every diff                                | `lastSeenAt`, `lastSeenPrice`, `lastSeenVolume`, `lastSeen52wHigh`, `lastSeen52wLow`, unique `(userId, symbol)` |
| `SymbolEvent`     | Append-only log of discrete events (52-week breaks + admin-triggered news/rating/action) | `symbol`, `eventType`, `eventTime`, `severity`, `payload` (JSON)                                                |
| `SymbolStats`     | Computed per-symbol statistics the scorer reads                                          | `avgVolume20d`, `stdevReturn20d`, `high52w`, `low52w`, `avgOvernightGapPct`, `historyDays`, `computedAt`        |

Enums: `EventType` (7 values), `Severity` (`MINOR`, `NOTABLE`, `CRITICAL`).

### 3.2 Redis keyspace

| Key / channel                      | Type                   | Written by               | Contents                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `market:refcount:<symbol>`         | string (int)           | subscription manager     | Number of watchlists referencing the symbol; `> 0` means "poll this"                                                                                                                                                                |
| `market:state:<symbol>`            | hash                   | `market-state-writer.ts` | `price`, `primarySource`, `primaryPrice`, `secondaryPrice`, `isDivergent`, `divergencePct`, `volume`, `dayOpen`, `prevClose`, `sessionOpenedAt`, `sessionElapsedFraction`, `updatedAt`, `marketStatus`, `isStale`, `mode`, `source` |
| `market:history:<symbol>`          | sorted set             | historical backfill      | Up to 90 daily bars as JSON, score = bar date in epoch ms                                                                                                                                                                           |
| `llm:budget:minute:<epoch-minute>` | string (int), TTL 120s | LLM budget guard         | Gemini requests this minute                                                                                                                                                                                                         |
| `llm:budget:day:<UTC-date>`        | string (int), TTL 48h  | LLM budget guard         | Gemini requests today                                                                                                                                                                                                               |
| `market:ticks`                     | pub/sub channel        | `market-state-writer.ts` | Price/volume tick payloads                                                                                                                                                                                                          |
| `market:events`                    | pub/sub channel        | `market-state-writer.ts` | Discrete-event payloads                                                                                                                                                                                                             |

`market:state` is read back through `read-state.ts`, which treats a hash without a
`price` field as "no state" so a symbol touched only by the staleness sweep does not
render as ₹0.00.

## 4. Market-data ingestion

### 4.1 Reference-counted subscriptions (`backend/src/ingestion/subscription-manager.ts`)

- `subscribe(symbol)` / `unsubscribe(symbol)` `INCR` / `DECR` `market:refcount:<symbol>`;
  the key is deleted at zero.
- `getActiveSymbols()` returns every symbol with a live refcount, using `SCAN` (not
  `KEYS`) so it never blocks the Redis event loop. The poll loop, the staleness sweep and
  the stats job all iterate this set.
- `reconcileRefcounts(map)` rebuilds the whole keyspace from Postgres on boot.

### 4.2 Provider interface (`backend/src/market-data/provider.interface.ts`)

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

### 4.3 Composite provider poll cycle (`backend/src/market-data/composite-provider.ts`)

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

### 4.4 The single writer (`backend/src/ingestion/market-state-writer.ts`)

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

### 4.5 Historical backfill (`backend/src/market-data/historical-backfill.ts`)

| Entry point                | Trigger                               | Scope                                                              |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `backfillMissingHistory()` | Boot                                  | Watched symbols with no cached history                             |
| `ensureHistory(symbol)`    | Called by `watchlist.service.addItem` | The one symbol just added; no-op (one `ZCARD`) once history exists |
| `backfillUniverse()`       | `npm run seed`                        | The entire symbol universe                                         |

Backfill requests 90 daily bars, falls back to synthetic bars if the real fetch returns
nothing, stores them in `market:history:<symbol>`, computes `SymbolStats`, and seeds an
honestly-labeled stale `market:state` from the last bar so a freshly added symbol is
renderable before its first poll.

## 5. The snapshot / diff model

### 5.1 Read vs. acknowledge

| Endpoint                  | Writes?         | Effect                                                                                                    |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/watchlist`      | No              | Recomputes the diff fresh from `market:state` + `SymbolStats` + `UserSymbolState` + recent `SymbolEvent`s |
| `POST /api/watchlist/ack` | Yes (only this) | Advances `UserSymbolState` to the current price/volume/52-week band, server-clock timestamp only          |

Because the read never writes, refreshing the page cannot lose an unseen change.
Concurrent devices converge on `max(lastSeenAt)` with no conflict resolution.

### 5.2 Event catalogue

| Event type                                  | Produced where                           | Rule                                                                                                                              |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PRICE_MOVE`                                | Diff engine (pure)                       | z-score of return since `lastSeenPrice` vs `stdevReturn20d`, scaled by √(trading sessions elapsed), clamped to `[1, 20]` sessions |
| `VOLUME_SPIKE`                              | Diff engine (pure)                       | Current session volume vs `avgVolume20d × sessionElapsedFraction`; also requires `volume > lastSeenVolume`                        |
| `GAP_OPEN`                                  | Diff engine (pure)                       | Only if a session boundary occurred after `lastSeenAt`; `                                                                         | open − prevClose | / prevClose`vs`avgOvernightGapPct` |
| `FIFTY_TWO_WEEK_EXTREME`                    | `market-state-writer.ts` → `SymbolEvent` | Price breaks stored `high52w` / `low52w`; 15-min per-direction cooldown                                                           |
| `NEWS`, `RATING_CHANGE`, `CORPORATE_ACTION` | Admin panel → `SymbolEvent`              | Demo-triggered; no news feed is wired up                                                                                          |

Discrete events are filtered to `eventTime > lastSeenAt` before they reach the engine.

### 5.3 Scoring (`backend/src/modules/diff/scoring.ts`)

Thresholds are exported as data (not inlined) so the explanation layer renders the exact
comparison that ran:

| Metric       | `CRITICAL` | `NOTABLE`      | `MINOR` |
| ------------ | ---------- | -------------- | ------- |
| `            | z          | ` (price move) | ≥ 3     | ≥ 1.5 | ≥ 0.75 |
| volume ratio | ≥ 3        | ≥ 2            | ≥ 1.5   |
| gap ratio    | ≥ 3        | ≥ 2            | ≥ 1.25  |

Guards: `stdevReturn20d` is floored at `0.001`; the √t horizon scale is clamped to
`[1, 20]` sessions; weekends contribute zero elapsed sessions (no holiday calendar).

### 5.4 Assembly (`backend/src/modules/diff/diff.engine.ts`)

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

### 5.5 Explanation traces (`backend/src/modules/diff/explain.ts`)

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
- `ws/ws.auth.ts` — the JWT is passed as `?token=` on the upgrade request (browsers
  cannot set an `Authorization` header on a WebSocket). Documented as a local-demo
  pattern only.

## 7. Background jobs (`backend/src/jobs/scheduler.ts`)

| Job                                          | Interval | Scope          | Action                                                                                                                                                                                                |
| -------------------------------------------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staleness sweep (`market-data/staleness.ts`) | 10 s     | Active symbols | Sets `market:state.isStale` when `now − updatedAt > STALE_THRESHOLD_MS`                                                                                                                               |
| Stats recompute (`stats/stats-job.ts`)       | 60 s     | Active symbols | Recomputes `avgVolume20d`, `stdevReturn20d`, `avgOvernightGapPct` from `market:history`. `high52w` / `low52w` are **not** overwritten here — they are the running extremes the writer maintains live. |

`getMarketStatus()` derives `OPEN` / `CLOSED` from NSE hours (09:15–15:30 IST, Mon–Fri),
with no holiday calendar.

## 8. HTTP API

All `/api` routes except `/api/auth/register` and `/api/auth/login` require
`Authorization: Bearer <jwt>`. `/api/admin/*` uses `X-Admin-Key` instead. Unknown `/api`
paths return `404 {"error":"NOT_FOUND"}` as JSON; a malformed JSON body returns
`400 {"error":"INVALID_JSON"}`.

| Method & path                         | Auth      | Purpose                                                           |
| ------------------------------------- | --------- | ----------------------------------------------------------------- |
| `GET /health`                         | none      | `{ status, marketDataMode }`                                      |
| `POST /api/auth/register`             | none      | Create account, returns `{ user, token }`                         |
| `POST /api/auth/login`                | none      | Returns `{ user, token }`                                         |
| `GET /api/auth/me`                    | bearer    | Current user; `401` for a valid-signature token of a deleted user |
| `GET /api/watchlist`                  | bearer    | The diff response: `{ generatedAt, marketStatus, entries[] }`     |
| `GET /api/watchlist/items`            | bearer    | Raw watchlist rows `{ symbol, addedAt }`                          |
| `POST /api/watchlist/items`           | bearer    | `{ symbol }` — add; `404 UNKNOWN_SYMBOL`, `409 ALREADY_WATCHED`   |
| `DELETE /api/watchlist/items/:symbol` | bearer    | Remove; also drops the last-seen snapshot                         |
| `POST /api/watchlist/ack`             | bearer    | `{ symbols: [...] }` or `{ ackAll: true }` — advance the snapshot |
| `GET /api/symbols/search?q=`          | bearer    | Universe search `{ symbol, name, sector, volatilityTier }`        |
| `POST /api/assistant/command`         | bearer    | `{ text, confirm? }` — see [assistant.md](assistant.md)           |
| `POST /api/assistant/explain`         | bearer    | `{ symbol, eventType, occurredAt? }` — trace + optional narration |
| `GET /api/assistant/status`           | bearer    | LLM availability, model, budget, example commands                 |
| `POST /api/admin/trigger`             | admin key | `{ symbol, eventType, severity?, payload? }` — queue a demo event |
| `GET /api/admin/symbols`              | admin key | Every universe symbol with its `market:state` and refcount        |
| `POST /api/admin/recompute-stats`     | admin key | Runs the stats job now, returns the recomputed symbols            |

## 9. WebSocket protocol (`backend/src/ws/ws.protocol.ts`)

Connect to `/ws?token=<jwt>`.

| Client → server                    | Server → client                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `{ type: "SUBSCRIBE", symbols }`   | `{ type: "SUBSCRIBED", symbols }`                                                                   |
| `{ type: "UNSUBSCRIBE", symbols }` | `{ type: "TICK", symbol, price, changePct, volume, source, mode, isStale, isDivergent, updatedAt }` |
| `{ type: "PONG" }`                 | `{ type: "EVENT", symbol, eventType, severity, eventTime, payload }`                                |
|                                    | `{ type: "PING" }`                                                                                  |
|                                    | `{ type: "ERROR", message }`                                                                        |

## 10. Backend source layout

| Path                                                           | Responsibility                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/config/env.ts`                                            | Zod-validated environment; `effectiveMarketDataMode`, `llmEnabled`                |
| `src/db/`                                                      | Prisma client, Redis client + subscriber factory                                  |
| `src/http/async-handler.ts`                                    | Promise-rejection → Express error path wrapper                                    |
| `src/market-data/provider.interface.ts`                        | `MarketDataProvider`, `Quote`, `DailyBar`                                         |
| `src/market-data/providers/`                                   | `yahoo`, `twelve-data`, `replay` providers; `virtual-clock`                       |
| `src/market-data/composite-provider.ts`                        | Poll loop and source orchestration                                                |
| `src/market-data/divergence.ts`, `staleness.ts`                | Cross-source check, market-hours + staleness sweep                                |
| `src/market-data/historical-backfill.ts`                       | Boot / on-add / whole-universe history population                                 |
| `src/market-data/symbol-universe.ts`, `volatility-profiles.ts` | The static universe and per-tier synthetic parameters                             |
| `src/market-data/command-queue.ts`                             | In-memory queue for admin overrides, freeze set                                   |
| `src/ingestion/subscription-manager.ts`                        | Refcount subscribe/unsubscribe/scan/reconcile                                     |
| `src/ingestion/market-state-writer.ts`                         | The single `market:state` writer + event detection                                |
| `src/modules/auth/`                                            | `auth.service` (bcrypt, JWT), `auth.middleware` (`requireAuth`), routes           |
| `src/modules/watchlist/`                                       | `watchlist.service` (add/remove/diff/ack), routes, DTO types                      |
| `src/modules/diff/`                                            | `diff.engine`, `scoring`, `explain`, shared types — all unit-tested               |
| `src/modules/assistant/`                                       | `command.rules`, `command.service`, `explain.service`, routes                     |
| `src/modules/symbols/`                                         | Symbol search route                                                               |
| `src/modules/admin/`                                           | `admin.middleware` (`X-Admin-Key`), trigger / symbols / recompute routes          |
| `src/llm/`                                                     | `gemini.client` (fetch-only, discriminated result), `llm.budget` (Redis counters) |
| `src/stats/`                                                   | `stats.service` (compute + store), `stats-job` (periodic run)                     |
| `src/jobs/scheduler.ts`                                        | Registers the interval jobs                                                       |
| `src/pubsub/redis-pubsub.ts`                                   | `publish` / `subscribeToChannels`, channel names                                  |
| `src/ws/`                                                      | `ws.server`, `ws.auth`, `ws.protocol`                                             |
| `src/app.ts` / `src/server.ts`                                 | Express wiring / startup sequence                                                 |

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

## Design rationale

The complexity is concentrated in three places: the snapshot/diff engine, the
severity-scored event model with its decision traces, and the reference-counted
shared-cache ingestion path. The market-data layer is deliberately kept thin — one
interface with three interchangeable implementations — because the source of a quote is
not where the product's behaviour is defined.
