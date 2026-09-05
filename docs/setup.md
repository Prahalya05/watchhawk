# Setup

## 1. Prerequisites

- Node.js 18+ and npm
- Docker Desktop (for local Postgres + Redis)

## 2. Backing services

`docker-compose.yml` defines Postgres 16 and Redis 7 with the connection strings the
default `.env` expects:

```bash
docker compose up -d
```

| Service  | Port | Credentials                                     |
| -------- | ---- | ----------------------------------------------- |
| Postgres | 5432 | `watchlist` / `watchlist`, database `watchlist` |
| Redis    | 6379 | none                                            |

Postgres data persists in the `watchlist_pg_data` volume; Redis is not persisted, and the
backend rebuilds all Redis state on boot.

## 3. Backend

```bash
cd backend
npm install
cp .env.example .env
npm run prisma:migrate      # apply the schema
npm run seed                # optional: backfill history + SymbolStats for the whole universe
npm run dev                 # http://localhost:4000
```

- `npm run seed` populates `SymbolStats` for every universe symbol up front. It is
  optional — `server.ts` backfills any watched symbol on boot, and a symbol gains its
  history the moment it is added — but on a fresh database nothing is watched yet, so
  seeding gives every symbol real statistics before the first request. Instant in replay
  mode; in live mode it fetches from Yahoo through the same client-side rate limiter the
  poll loop uses and takes a few minutes for the full universe, which is why the server
  runs it in the background rather than blocking startup.
- Health check: `curl http://localhost:4000/health` → `{ "status": "ok", "marketDataMode": "replay" | "live" }`.

### npm scripts

| Script                            | Purpose                                                           |
| --------------------------------- | ----------------------------------------------------------------- |
| `npm run dev`                     | `tsx watch src/server.ts`                                         |
| `npm run build` / `npm start`     | Compile to `dist/` and run                                        |
| `npm run typecheck`               | `tsc --noEmit`                                                    |
| `npm run prisma:migrate`          | `prisma migrate dev`                                              |
| `npm run prisma:generate`         | Regenerate the Prisma client                                      |
| `npm run prisma:studio`           | Prisma Studio                                                     |
| `npm run seed`                    | Whole-universe history + stats backfill                           |
| `npm test` / `npm run test:watch` | Vitest (diff engine, scoring, explanations, command parser, auth) |
| `npm run verify:live`             | Call the real provider classes against the real APIs              |

### Tests

```bash
npm test
```

No database or network is needed — the covered units (diff engine, scorer, explanation
traces, command parser, auth service) are pure or self-contained. `src/test/env.ts`
supplies fallback environment values so the suite runs in a fresh checkout.

### Live-data check

```bash
npm run verify:live
```

Calls `YahooProvider` and `TwelveDataProvider` against the live endpoints. Live mode
fails quietly — a stale ticker or a renamed vendor field makes a symbol fall back to
synthetic data while still looking healthy on screen — so this is worth running before
any demo that claims live data. Yahoo needs no key and is always checked; Twelve Data is
skipped with instructions if no key is set. It has already caught Yahoo omitting
`regularMarketOpen` on NSE symbols (which would have recast each day's move as an
overnight gap) and two tickers retired by corporate actions (Zomato → `ETERNAL`, Tata
Motors → `TMPV`).

## 4. Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev                 # http://localhost:5173
```

| Script            | Purpose                    |
| ----------------- | -------------------------- |
| `npm run dev`     | Vite dev server            |
| `npm run build`   | `tsc -b && vite build`     |
| `npm run preview` | Serve the production build |

Register an account, then add a mix of symbols — e.g. `RELIANCE`, `TCS`, `ETERNAL`,
`SUZLON` — the universe deliberately mixes low- and high-volatility tiers so the same
severity thresholds produce visibly different results per symbol.

## 5. Environment variables

### Backend (`backend/.env`, annotated in `backend/.env.example`)

| Variable                         | Default                                                     | Purpose                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | `postgresql://watchlist:watchlist@localhost:5432/watchlist` | Postgres connection; matches `docker-compose.yml`                                                                                                         |
| `REDIS_URL`                      | `redis://localhost:6379`                                    | Redis connection                                                                                                                                          |
| `JWT_SECRET`                     | — (required)                                                | Auth signing key; rejected at boot below 32 characters                                                                                                    |
| `ADMIN_KEY`                      | — (required)                                                | `X-Admin-Key` value for the demo panel; minimum 16 characters                                                                                             |
| `MARKET_DATA_MODE`               | `live`                                                      | `live` or `replay`. `live` is downgraded to `replay` at boot if `TWELVE_DATA_API_KEY` is empty (see [scope-and-limitations.md](scope-and-limitations.md)) |
| `TWELVE_DATA_API_KEY`            | `""`                                                        | Required to enable live mode. NSE coverage still depends on the Twelve Data plan                                                                          |
| `MARKET_POLL_INTERVAL_MS`        | `45000`                                                     | Live-mode poll cadence (fixed-rate, timed from cycle start)                                                                                               |
| `STALE_THRESHOLD_MS`             | `120000`                                                    | Age past which a symbol's `market:state` is marked `isStale`                                                                                              |
| `PORT`                           | `4000`                                                      | HTTP port                                                                                                                                                 |
| `GEMINI_API_KEY`                 | `""`                                                        | Enables LLM command parsing and plain-English narration — see [assistant.md](assistant.md)                                                                |
| `GEMINI_MODEL`                   | `gemini-2.5-flash`                                          | Model id                                                                                                                                                  |
| `GEMINI_TIMEOUT_MS`              | `8000`                                                      | Per-call abort timeout                                                                                                                                    |
| `GEMINI_MAX_REQUESTS_PER_MINUTE` | `8`                                                         | Self-imposed ceiling; exhaustion degrades to the deterministic path                                                                                       |
| `GEMINI_MAX_REQUESTS_PER_DAY`    | `200`                                                       | Self-imposed daily ceiling                                                                                                                                |

`config/env.ts` validates all of this with Zod and calls `process.exit(1)` on a missing
or invalid required variable.

### Frontend (`frontend/.env`)

| Variable       | Default                     | Purpose       |
| -------------- | --------------------------- | ------------- |
| `VITE_API_URL` | `http://localhost:4000/api` | REST base URL |
| `VITE_WS_URL`  | `ws://localhost:4000/ws`    | WebSocket URL |

## 6. Authentication model

- Register at `/register`, log in at `/login`. Passwords are bcrypt-hashed (10 rounds)
  and must be 8–72 characters — 72 is bcrypt's own limit, and a longer password is
  rejected rather than silently truncated (which would make two different passwords
  interchangeable).
- Email is the login identifier and is normalized (trimmed, lowercased) on both register
  and login, so `You@Example.com` and `you@example.com` are one account.
- A successful register or login returns a JWT valid for 7 days. The frontend stores it
  in `localStorage` and sends it as `Authorization: Bearer <token>`.
- Every `/api` route except `/api/auth/register` and `/api/auth/login` requires the
  token. `/api/admin/*` uses the `X-Admin-Key` header instead. The WebSocket upgrade
  takes the token as `?token=` (a browser `WebSocket` cannot set headers).
- An expired, tampered, or deleted-user token returns `401`; the frontend clears the
  session and returns to login with an explanation. The error banner distinguishes an
  unreachable server ("Can't reach the server at …") from a real rejection ("An account
  with that email already exists").

## 7. Demo control panel

Visit `/admin` in the frontend and paste the `ADMIN_KEY` from `backend/.env`. The panel
triggers events on demand — volume spikes, gaps, 52-week breaks, news / rating /
corporate-action events, source divergence, and freezing a symbol to demonstrate
staleness. Overrides are applied by `market-state-writer.ts` on the next poll cycle
regardless of which provider is currently authoritative, so the panel works in both
`live` and `replay` mode. It exists because real market movement cannot be scripted for a
presentation.

Endpoints (all requiring `X-Admin-Key`): `POST /api/admin/trigger`,
`GET /api/admin/symbols`, `POST /api/admin/recompute-stats`.
