# Architecture diagrams

Four diagrams at three zoom levels, following the [C4 model](https://c4model.com/), plus
two sequence diagrams for the flows that cross the most boundaries.

They are written in Mermaid and committed next to the source rather than exported as
images into a wiki. That is not a stylistic preference. A PNG rots because updating it
means opening a drawing tool, so nobody does — and a stale diagram is worse than no
diagram, because it is confidently wrong. A diagram defined in text can be changed in the
same pull request as the code it describes, and a reviewer can see when it wasn't.

Mermaid's own `C4Context` / `C4Container` syntax is still marked experimental and renders
inconsistently, so these use `flowchart` with the C4 _semantics_: one box per person,
system, container or component, with every arrow labelled by intent and technology.

---

## Level 1 — System Context

**Audience:** anyone, including non-engineers.
**Question it answers:** what is this, and what does it talk to?

```mermaid
flowchart TB
    user["<b>Trader</b><br/><i>[Person]</i><br/>Watches a set of NSE symbols and wants<br/>to know what changed since they last looked"]

    system["<b>Smart Market Watchlist</b><br/><i>[Software System]</i><br/>Stores what each user last saw per symbol<br/>and reports the difference as typed,<br/>severity-scored events"]

    yahoo["<b>Yahoo Finance</b><br/><i>[External System]</i><br/>Primary live quotes and daily history"]
    twelve["<b>Twelve Data</b><br/><i>[External System]</i><br/>Secondary quotes, used as a per-cycle cross-check"]
    gemini["<b>Google Gemini</b><br/><i>[External System]</i><br/>Optional. Command parsing and event explanation"]

    user -->|"Reads watchlist, acknowledges changes,<br/>issues commands <i>[HTTPS + WebSocket]</i>"| system
    system -->|"Polls quotes for watched symbols only <i>[HTTPS]</i>"| yahoo
    system -->|"Cross-checks the primary price <i>[HTTPS]</i>"| twelve
    system -.->|"Interprets a command,<br/>explains an event <i>[HTTPS]</i>"| gemini

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef internal fill:#1168bd,stroke:#0b4884,color:#fff
    classDef external fill:#999999,stroke:#6b6b6b,color:#fff
    class user person
    class system internal
    class yahoo,twelve,gemini external
```

Every external dependency is optional in a specific, tested way. With no
`TWELVE_DATA_API_KEY` the system runs in `MARKET_DATA_MODE=replay` against a synthetic
engine and makes no outbound calls at all; with no `GEMINI_API_KEY` the assistant falls
back to its deterministic parser. The dashed arrow marks the one that stays optional even
when it _is_ configured — the budget guard degrades the assistant to its deterministic
path rather than failing the request.

---

## Level 2 — Containers

**Audience:** engineers and operators onboarding.
**Question it answers:** what are the separately runnable moving parts?

```mermaid
flowchart TB
    user["<b>Trader</b><br/><i>[Person]</i>"]

    subgraph system ["Smart Market Watchlist"]
        spa["<b>Dashboard</b><br/><i>[Container: React 18 + Vite 5]</i><br/>Watchlist table, event badges,<br/>explanation drawer, command bar"]
        api["<b>API and Ingestion Process</b><br/><i>[Container: Node 20, Express 4, ws]</i><br/>Serves the HTTP API, owns the WebSocket<br/>fan-out, runs the market-data poll loop<br/>and the background jobs"]
        pg[("<b>PostgreSQL 16</b><br/><i>[Container: via Prisma 5]</i><br/>Users, watchlist items, per-user<br/>snapshots, symbol stats, events")]
        redis[("<b>Redis 7</b><br/><i>[Container: via ioredis]</i><br/>market:state cache, symbol refcounts,<br/>pub/sub channel, LLM budget counters")]
    end

    yahoo["<b>Yahoo Finance</b><br/><i>[External System]</i>"]
    twelve["<b>Twelve Data</b><br/><i>[External System]</i>"]
    gemini["<b>Google Gemini</b><br/><i>[External System]</i>"]

    user -->|"<i>[HTTPS]</i>"| spa
    spa -->|"JSON, bearer JWT <i>[HTTPS]</i>"| api
    spa <-->|"Live ticks and events <i>[WebSocket]</i>"| api
    api -->|"Durable per-user state <i>[TCP / Prisma]</i>"| pg
    api -->|"Shared quote cache,<br/>refcounts, pub/sub <i>[TCP / RESP]</i>"| redis
    api -->|"<i>[HTTPS]</i>"| yahoo
    api -->|"<i>[HTTPS]</i>"| twelve
    api -.->|"<i>[HTTPS]</i>"| gemini

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef container fill:#438dd5,stroke:#2e6295,color:#fff
    classDef external fill:#999999,stroke:#6b6b6b,color:#fff
    class user person
    class spa,api,pg,redis container
    class yahoo,twelve,gemini external
```

**Why the API and the ingestion loop are one container.** They are separable in principle
and are deliberately not separated, because nothing yet forces it: no part needs to scale
independently of another, and no second team owns a piece of it. Splitting now would buy
network latency, partial failure and distributed debugging in exchange for nothing.

What the single container does cost is that exactly one instance may run the poll loop.
`market:state` is shared mutable state, so a second writer is not a harmless duplicate —
it overwrites live prices with stale ones. That is enforced by binding the HTTP port
_before_ ingestion starts, which makes the port the mutex: a duplicate process exits with
`EADDRINUSE` instead of quietly corrupting the cache. See `backend/src/server.ts` and
[ADR 0002](adr/0002-modular-monolith-and-single-writer-ingestion.md).

---

## Level 3 — Components inside the API process

**Audience:** the engineer working inside the backend.
**Question it answers:** what are the internal parts, and which way do they depend?

The four boxes are the four rings. **Every arrow points inward or sideways; none points
outward.** That is the whole design — and it is enforced by the boundary rules in
`eslint.config.mjs`, not merely drawn here.

```mermaid
flowchart TB
    subgraph interfaces ["interfaces/ — delivery (outermost, most volatile)"]
        direction LR
        routes["HTTP routes<br/>auth · watchlist · symbols<br/>admin · assistant"]
        mw["Middleware<br/>requireAuth · requireAdmin"]
        wss["WebSocket server<br/>ws.server · ws.auth · ws.protocol"]
    end

    subgraph application ["application/ — use cases"]
        direction LR
        wsvc["watchlist.service<br/>read · add · remove · ack"]
        asvc["auth.service"]
        cmd["command.service<br/>explain.service"]
        ing["ingestion<br/>subscription-manager<br/>market-state-writer"]
        md["market-data<br/>composite-provider<br/>historical-backfill<br/>staleness"]
        jobs["stats.service<br/>scheduler"]
    end

    subgraph domain ["domain/ — business rules (innermost, most stable)"]
        direction LR
        diff["diff.engine<br/>scoring · explain"]
        market["symbol-universe<br/>volatility-profiles<br/>divergence"]
        rules["command.rules"]
        ports["ports/<br/>MarketDataProvider"]
    end

    subgraph infrastructure ["infrastructure/ — technology detail"]
        direction LR
        prisma["db/prisma"]
        rds["db/redis<br/>pubsub/redis-pubsub"]
        provs["market-data/providers<br/>yahoo · twelve-data · replay"]
        llm["llm/gemini.client<br/>llm.budget · intent.schema"]
    end

    routes --> wsvc
    routes --> asvc
    routes --> cmd
    mw --> asvc
    wss --> asvc
    wss --> rds

    wsvc --> diff
    wsvc --> market
    wsvc --> prisma
    wsvc --> rds
    asvc --> prisma
    cmd --> rules
    cmd --> llm
    ing --> rds
    ing --> market
    md --> provs
    md --> ports
    jobs --> prisma

    provs -.->|"implements"| ports
    llm -.->|"reads the closed action set from"| rules

    classDef ifc fill:#85bbf0,stroke:#5d82a8,color:#000000
    classDef app fill:#438dd5,stroke:#2e6295,color:#fff
    classDef dom fill:#1168bd,stroke:#0b4884,color:#fff
    classDef inf fill:#b0b0b0,stroke:#6b6b6b,color:#000000
    class routes,mw,wss ifc
    class wsvc,asvc,cmd,ing,md,jobs app
    class diff,market,rules,ports dom
    class prisma,rds,provs,llm inf
```

The dotted arrows are the inversions that matter.
`infrastructure/market-data/providers` **implements** `domain/ports/MarketDataProvider`:
the poll loop depends on the interface, which is what makes Yahoo, Twelve Data and the
synthetic replay engine interchangeable and lets a test substitute a fake with no network.
`infrastructure/llm/intent.schema` reads `ASSISTANT_ACTIONS` from the domain, so the enum
offered to the model cannot drift from the enum the validator enforces.

---

## Sequence — reading the watchlist, then acknowledging

The core interaction, and the one that explains why the snapshot is stored server-side.
The read is **non-destructive**: it never advances the baseline. Only an explicit ack does,
which is what makes a page refresh unable to silently clear an unseen change.

```mermaid
sequenceDiagram
    autonumber
    actor U as Trader
    participant SPA as Dashboard
    participant R as watchlist.routes<br/>[interfaces]
    participant S as watchlist.service<br/>[application]
    participant D as diff.engine<br/>[domain]
    participant PG as PostgreSQL
    participant RD as Redis

    U->>SPA: Opens dashboard
    SPA->>R: GET /api/watchlist (Bearer JWT)
    R->>R: requireAuth verifies signature<br/>and payload shape
    R->>S: getWatchlistDiff(userId)

    par One round trip each, in parallel
        S->>RD: readMarketStates(symbols) — shared quote cache
    and
        S->>PG: symbolStats, userSymbolState,<br/>recent symbolEvent rows
    end

    loop For each watched symbol
        S->>D: computeSymbolDiff(state, stats, lastSeen, events)
        D->>D: Score against this symbol's own<br/>volatility, not a fixed percentage
        D-->>S: Typed events, severity, decision trace
    end

    S-->>R: entries[]
    R-->>SPA: 200 JSON
    SPA-->>U: Rows with event badges

    Note over PG: The baseline is untouched.<br/>A refresh shows the same changes again.

    U->>SPA: Clicks acknowledge
    SPA->>R: POST /api/watchlist/ack
    R->>S: ackSymbols(userId, symbols)
    S->>RD: Read current price and volume
    S->>PG: $transaction: advance lastSeenAt<br/>and snapshot, per symbol
    Note over S,PG: updateMany, not update — a symbol removed<br/>concurrently matches zero rows instead of<br/>failing the whole all-or-nothing transaction.
    S-->>SPA: { acked, ackedAt }
```

---

## Sequence — one ingestion poll cycle

Why cost scales with distinct watched symbols rather than with user count.

```mermaid
sequenceDiagram
    autonumber
    participant CP as composite-provider<br/>[application]
    participant SM as subscription-manager<br/>[application]
    participant Y as yahoo.provider<br/>[infrastructure]
    participant T as twelve-data.provider<br/>[infrastructure]
    participant DV as divergence<br/>[domain]
    participant W as market-state-writer<br/>[application]
    participant RD as Redis
    participant WS as ws.server<br/>[interfaces]

    loop Every MARKET_POLL_INTERVAL_MS
        CP->>SM: Which symbols does anyone watch?
        SM->>RD: Read refcounts
        RD-->>SM: Symbols with refcount > 0
        Note over SM: A symbol nobody watches is never polled.<br/>Ten users on RELIANCE is still one request.

        CP->>Y: fetchQuotes(symbols) — primary
        CP->>T: fetchQuotes(symbols) — cross-check
        CP->>DV: checkDivergence(primary, secondary)
        DV-->>CP: isDivergent, against this symbol's<br/>volatility-tier threshold

        CP->>W: Quote + divergence + provenance
        W->>RD: SET market:state:SYMBOL
        W->>RD: PUBLISH state change
        RD-->>WS: Pub/sub delivery
        WS-->>WS: Fan out TICK / EVENT to<br/>subscribed sockets
    end
```

On boot the refcounts are rebuilt from the durable `WatchlistItem` table, because Redis
holds no durable state and the "poll only what is watched" design silently breaks after a
Redis restart otherwise. That reconciliation is a required startup step in
`backend/src/server.ts`, not optional polish.
