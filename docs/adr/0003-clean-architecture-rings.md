# 3. Organise the backend as clean-architecture rings

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

The backend was previously organised by feature — `src/modules/auth/`,
`src/modules/diff/`, `src/modules/watchlist/` — alongside a set of technical folders
(`src/db/`, `src/llm/`, `src/ws/`, `src/market-data/`).

The dependency direction under that layout was already almost correct: the diff engine
imported no Prisma, no Redis and no Express, and `market-data/provider.interface.ts` was a
genuine port with three interchangeable adapters. But the layout did not _say_ so. Two
things followed from that:

1. **The intent was invisible.** Nothing in the name `modules/diff` told a reader that it
   was the one part of the system that must never touch I/O, or that
   `modules/watchlist/watchlist.service.ts` was allowed to. The rule lived in the head of
   whoever wrote it.
2. **Violations were indistinguishable from normal code.** Two had already crept in and
   read as perfectly ordinary lines: `domain` intent types imported `GeminiSchema`,
   welding the assistant's vocabulary to one vendor's wire format; and the `/me` route
   queried `prisma.user` directly, so an HTTP handler knew the shape of a database table.
   Neither looked wrong in a feature-shaped tree, because in a feature-shaped tree there is
   no direction to be wrong about.

`market-data/` was the clearest symptom: it held a pure port, pure reference data, pure
comparison logic, a Redis-backed read model, an in-memory queue, three vendor adapters and
the poll-loop orchestrator — six different distances from the outside world in one folder.

## Decision

Reorganise `backend/src` into four rings, ordered by how often the code inside them changes:

| Ring              | Holds                                                                                                      | May import                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `domain/`         | Diff engine, scoring, explanations, command rules, symbol universe, volatility profiles, divergence, ports | `domain/` only                          |
| `application/`    | Use cases: watchlist, auth, assistant, ingestion, stats, market-data orchestration, scheduler              | `domain/`, `infrastructure/`, `config/` |
| `infrastructure/` | Prisma, Redis, pub/sub, the three provider adapters, Gemini client and budget                              | `domain/`, `config/`                    |
| `interfaces/`     | Express app, routes, middleware, WebSocket server                                                          | anything except `infrastructure/db`     |

`src/server.ts` stays at the root as the composition root and the single obvious entry
point. `src/config/` stays as a cross-cutting concern that the domain is forbidden to read.

Tests move to `backend/tests/`, mirroring the ring they cover, split into `unit/` (no I/O,
runs in seconds) and `integration/` (boots the real app over real HTTP).

## Consequences

- The architecture is now readable from `ls`. A reviewer can see that a change touches
  `domain/` and know immediately that it must not need a database to test.
- The two pre-existing violations were found _by the act of classifying files_, and both
  are fixed: the Gemini schema moved to `infrastructure/llm/intent.schema.ts` (importing
  `ASSISTANT_ACTIONS` from the domain, so the model's enum cannot drift from the
  validator's), and `getUserById` moved into the auth service.
- 115 import specifiers were rewritten. This was a large, purely mechanical diff, verified
  by the unchanged test count (106 passing before and after) and a clean typecheck. It was
  committed on its own, with the behavioural fixes in a separate commit, so the mechanical
  change stays reviewable.
- Relative imports get longer — `../../domain/diff/diff.engine`. Path aliases would fix
  the cosmetics but need a runtime resolver (`tsc-alias` or equivalent) for
  `node dist/server.js` to keep working. Not worth a build-time dependency and a new
  failure mode for shorter strings; revisit if the depth grows.
- A folder name still cannot enforce anything on its own, which is what
  [ADR 0004](0004-lint-enforced-architecture-boundaries.md) addresses.
