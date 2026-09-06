# Contributing

## Getting set up

```bash
docker compose up -d          # Postgres 16 + Redis 7
npm run install:all           # root tooling, then backend, then frontend
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm run prisma:migrate --prefix backend
```

Then `npm run dev --prefix backend` and `npm run dev --prefix frontend`. Full walkthrough
in [docs/setup.md](docs/setup.md).

## The one rule that is not negotiable

The backend is arranged as four rings and **dependencies point inward**. Before adding an
import, check which ring you are in:

| You are editing…  | You may import from                                         |
| ----------------- | ----------------------------------------------------------- |
| `domain/`         | `domain/` only — no framework, driver, vendor SDK or config |
| `application/`    | `domain/`, `infrastructure/`, `config/`                     |
| `infrastructure/` | `domain/`, `config/`                                        |
| `interfaces/`     | anything except `infrastructure/db/`                        |

This is enforced by lint, not by trust — `npm run lint` fails on a violation and tells you
what to do instead. The reasoning is in
[ADR 0003](docs/adr/0003-clean-architecture-rings.md) and
[ADR 0004](docs/adr/0004-lint-enforced-architecture-boundaries.md).

If you genuinely need to cross a boundary, **change the rule and write an ADR** explaining
why. Do not add an inline `eslint-disable`: that moves an architectural decision into a
comment nobody will ever find.

## Before you push

Run what CI runs, in the same order — cheapest first, so you fail fast:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test
```

The pre-commit hook already runs lint and formatting over staged files. It deliberately
does **not** run the test suite: a slow hook gets bypassed with `--no-verify` inside a week,
and a hook that is routinely bypassed protects nothing.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint on
`commit-msg`:

```
feat(watchlist): score gap-open events against the symbol's own volatility
fix(auth): normalise email before the uniqueness check
refactor(backend): move the diff engine into the domain ring
docs(adr): record the single-writer ingestion constraint
chore/build/test/perf/style/ci: as they sound
```

The type prefix earns its keep when history is being read under pressure — it is what lets
someone scanning `git log --oneline` during an incident tell a behaviour change from a
rename without opening either.

Write the subject as what the change _does_, not what you did. The body is for **why**;
the diff already shows what.

## Pull requests

- **Branch per change**, off `main`: `feat/…`, `fix/…`, `refactor/…`.
- **Keep them small.** A 200-line PR gets a real review; a 2000-line one gets an approval.
- **Separate mechanical from behavioural changes.** A rename that touches 115 imports and a
  logic fix in the same commit means neither can be reviewed — the logic fix is invisible
  inside the noise. Split them, and say in the message which is which.
- Fill in the PR template. The "how did you verify this" section is the one that matters:
  "tests pass" is not verification if you did not add a test for the thing you changed.

## Tests

| Tier                       | Location                     | Needs                                               |
| -------------------------- | ---------------------------- | --------------------------------------------------- |
| `npm run test:unit`        | `backend/tests/unit/`        | nothing — no I/O at all                             |
|                            | `frontend/tests/unit/`       | nothing — no DOM, no browser                        |
| `npm run test:integration` | `backend/tests/integration/` | nothing today; boots the real Express app over HTTP |

Tests mirror the ring they cover, so `tests/unit/domain/diff/` tests `src/domain/diff/`, and
`frontend/tests/unit/lib/` tests `frontend/src/lib/`.

The frontend tier covers `src/lib/` only, and deliberately: those are the pure functions the
dashboard is derived from — money and time formatting, the filter/sort/summary pipeline, the
event and severity vocabulary — and their failure mode is that the page still renders, just
wrong. Everything else in `frontend/src/` is a React component, which cannot be tested
without a DOM; adding one would mean a new tier with jsdom in it, not a wider `unit/`.

The environment that `config/env.ts` validates at import time is supplied by
`tests/setup/env.ts`, registered as a Vitest `setupFile` — you do not need to import it.

**Where to put a new test:** if it can be written without a socket, it belongs in `unit/`
and should be, because that tier gates every commit and finishes in seconds. Reach for
`integration/` only when the thing being tested _is_ the wiring.

## Dependencies

Every new dependency is attack surface, a supply-chain risk and a future breaking change.
Before adding one, say in the PR what it does that the standard library or an existing
dependency cannot. Lockfiles are committed; use `npm ci`, not `npm install`, in automation.
