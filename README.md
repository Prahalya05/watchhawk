# Smart Market Watchlist

A watchlist application that reports **what changed** on each tracked symbol since the
user last looked at it, rather than re-displaying the current quote. Every symbol a user
watches carries a server-side snapshot of what that user last saw; each request to the
watchlist recomputes the difference between that snapshot and the current state and
returns it as a list of typed, severity-scored events.

The project was built for Groww Code 2026.

## What the system does

- **Per-user snapshots.** For every `(user, symbol)` pair the backend stores the last
  price, volume and 52-week band the user acknowledged. Reading the watchlist never
  changes this snapshot; only an explicit acknowledge (`POST /api/watchlist/ack`) does.
  A page refresh therefore cannot silently clear an unseen change.
- **Typed event model.** Differences are classified into seven event types
  (`PRICE_MOVE`, `VOLUME_SPIKE`, `GAP_OPEN`, `FIFTY_TWO_WEEK_EXTREME`, `NEWS`,
  `RATING_CHANGE`, `CORPORATE_ACTION`) and each is scored `MINOR` / `NOTABLE` /
  `CRITICAL` against the symbol's own statistics, not against a fixed percentage.
- **Decision traces.** Every event carries the inputs, the arithmetic, the thresholds
  tested and the provenance of the underlying quote. The frontend renders this trace
  when an event badge is opened.
- **Two data-source modes.** In `live` mode a composite provider polls Yahoo Finance as
  the primary source and Twelve Data as a per-cycle cross-check, falling back to a
  synthetic replay engine per symbol. In `replay` mode the whole application runs on the
  replay engine with no external calls. The source and mode of every quote are labeled
  in the API response.
- **Shared ingestion.** Market data is polled once per distinct watched symbol and
  cached in Redis, reference-counted so a symbol is only polled while at least one user
  watches it. Cost scales with distinct symbols, not with user count.
- **Real-time updates.** State changes are published on Redis pub/sub and fanned out to
  dashboards over a single WebSocket server.
- **Optional assistant.** A natural-language command bar and a plain-English event
  explainer. Both run on deterministic code by default and use Google Gemini only when a
  key is configured; neither feature requires the LLM to function.

## Repository structure

```
.
├── docker-compose.yml       Postgres 16 + Redis 7 for local development
├── backend/                 Node + TypeScript API, ingestion, diff engine
│   ├── prisma/              Schema, migrations, universe seed script
│   ├── scripts/             verify-live-data.ts (live provider check)
│   └── src/
│       ├── config/          Environment parsing and validation
│       ├── db/              Prisma and Redis clients
│       ├── market-data/     Provider interface + Yahoo / Twelve Data / replay, composite
│       ├── ingestion/       Refcounted subscription manager, market:state writer
│       ├── modules/
│       │   ├── auth/        Registration, login, JWT middleware
│       │   ├── watchlist/   Watchlist CRUD, the read/ack diff endpoint
│       │   ├── diff/        Diff engine, severity scoring, explanation traces
│       │   ├── assistant/   Command parser and event explainer
│       │   ├── symbols/     Symbol search
│       │   └── admin/       Demo event-trigger endpoints
│       ├── llm/             Gemini client and Redis-backed budget guard
│       ├── stats/           Periodic SymbolStats recompute
│       ├── jobs/            Interval scheduler (staleness sweep, stats job)
│       ├── pubsub/          Redis pub/sub bridge
│       ├── ws/              WebSocket server, auth, protocol
│       ├── app.ts           Express app wiring
│       └── server.ts        Process startup sequence
└── frontend/                React + Vite dashboard
    └── src/
        ├── api/             axios client and typed endpoint wrappers
        ├── context/         Auth/session context
        ├── hooks/           TanStack Query hooks (watchlist, ack)
        ├── ws/              WebSocket hook
        ├── pages/           Login, Register, Dashboard, Admin demo
        ├── components/      Watchlist table, event badge, explain drawer, command bar
        └── types/           Shared response types mirroring the backend
```

## Technology

| Layer        | Components |
| ------------ | --------- |
| Backend      | Node, Express 4, TypeScript, `ws` |
| Persistence  | PostgreSQL 16 via Prisma 5 (durable per-user state); Redis 7 via ioredis (shared cache + pub/sub + LLM budget) |
| Market data  | Yahoo Finance (live primary), Twelve Data (live cross-check), synthetic replay engine |
| Frontend     | React 18, Vite 5, TanStack Query 5, React Router 6, Tailwind CSS 3 |
| Assistant    | Google Gemini (`generateContent`), optional; deterministic parser and computed explanations otherwise |
| Tests        | Vitest (diff engine, scoring, explanation traces, command parser, auth) |

## Running the project

```bash
docker compose up -d

cd backend && npm install && cp .env.example .env
npm run prisma:migrate && npm run dev        # http://localhost:4000

cd ../frontend && npm install && cp .env.example .env
npm run dev                                   # http://localhost:5173
```

With no `TWELVE_DATA_API_KEY` set the backend runs entirely on the replay engine and
needs no external services beyond Postgres and Redis. The full walkthrough — scripts,
environment reference, authentication model and the demo control panel — is in
[docs/setup.md](docs/setup.md).

## Documentation

| Document | Contents |
| -------- | -------- |
| [docs/setup.md](docs/setup.md) | Prerequisites, backend and frontend setup, npm scripts, full environment-variable reference, authentication model, demo control panel |
| [docs/architecture.md](docs/architecture.md) | Process startup, data stores, ingestion pipeline, provider composition, the snapshot/diff model, real-time delivery, background jobs, HTTP API and WebSocket protocol, source layout |
| [docs/assistant.md](docs/assistant.md) | Command-bar pipeline, intent set, the explanation-trace structure, the Gemini client and budget guard, configuration |
| [docs/scope-and-limitations.md](docs/scope-and-limitations.md) | Deliberate simplifications and known gaps, grouped by area; each is also marked in code |
