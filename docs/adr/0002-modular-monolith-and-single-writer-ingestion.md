# 2. Deploy as a modular monolith with single-writer ingestion

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

The system has two clearly different workloads inside one process: serving the HTTP and
WebSocket API, and running the market-data poll loop that keeps Redis warm. That shape
invites the obvious question — should ingestion be its own service?

Splitting is justified by one of two pressures: parts that must **scale independently**, or
**teams that must deploy independently**. Neither applies here. Ingestion cost scales with
the number of _distinct watched symbols_, not with users, because the subscription manager
reference-counts symbols and polls each one once no matter how many users watch it. There
is no second team.

Splitting anyway would buy network latency, partial failure, distributed tracing and
eventual consistency between the poll loop and the readers, in exchange for nothing that is
currently needed.

There is a real constraint pulling the other way, though. `market:state` in Redis is shared
mutable state with no coordination. A second process running the poll loop is not a
harmless duplicate: the two writers fight, and if either is running older code or an older
symbol universe, it overwrites live prices with stale ones. This is not hypothetical — a
leftover instance from an earlier run kept polling for over an hour after losing the HTTP
port, and the dashboard showed the two writers' values alternating.

## Decision

Deploy as a **single-process modular monolith**: one container serves the API, the
WebSocket fan-out and ingestion, with the internal boundaries maintained by the ring
structure ([ADR 0003](0003-clean-architecture-rings.md)) rather than by process boundaries.

Enforce the single-writer requirement with the resource the system already contends for:
**bind the HTTP port before starting ingestion.** The port becomes the mutex. A duplicate
process fails `listen()` with `EADDRINUSE` and exits, instead of silently starting a second
poll loop against the same Redis.

Rebuild Redis refcounts from the durable `WatchlistItem` table on every boot. Redis holds
no durable state, so without reconciliation the "only poll what is watched" design breaks
silently after any Redis restart — symbols keep being served from a cache nothing refreshes.

## Consequences

- One `npm run dev`, one deploy, one log stream, one place to attach a debugger.
- The startup ordering in `server.ts` is **load-bearing and must not be tidied**. Moving
  `listen()` after `compositeProvider.start()` reintroduces the duplicate-writer bug, and
  it will present as bad prices rather than as a crash. The ordering is commented in place
  and pointed here.
- The process cannot be horizontally scaled as-is. When that pressure arrives, the fix is
  to move ingestion behind a real lock (a Redis lease, or a single-replica deployment) and
  extract it — the ring boundaries already keep `application/ingestion` free of any HTTP
  dependency, so the extraction is a packaging change, not a rewrite.
- Boot is slower in `replay` mode, which awaits synthetic backfill so the app is fully
  seeded before serving. Live-mode backfill is deliberately kicked off _after_ `listen()`,
  since it is rate-limited and would otherwise hold the port closed for minutes.
