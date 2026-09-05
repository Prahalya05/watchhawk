# 4. Enforce architecture boundaries with lint rules

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

[ADR 0003](0003-clean-architecture-rings.md) arranged the backend into rings whose value
depends entirely on the direction of the arrows between them. But a directory name is
documentation, and documentation does not fail a build.

The evidence that convention alone is insufficient is in this repository's own history: the
ring discipline was followed correctly in almost every file, and still drifted in two
places. Both drifts were single, unremarkable-looking import lines. Neither would have been
caught by code review unless the reviewer happened to be thinking about layering that day,
because nothing marked them as different from the hundred other imports around them.

The failure mode is specific and slow. An architecture does not collapse in one commit; it
erodes one reasonable-looking shortcut at a time, and by the time the cost is felt — the
domain can no longer be tested without a database — the shortcuts are load-bearing and
unwinding them is a project rather than a fix.

## Decision

Encode each ring's permitted dependencies as ESLint rules in `eslint.config.mjs`, so a
violation fails `npm run lint` and therefore CI:

- `domain/**` may not import `application`, `infrastructure`, `interfaces` or `config`, nor
  any of `express`, `cors`, `ws`, `ioredis`, `@prisma/client`, `bcryptjs`, `jsonwebtoken`,
  `dotenv`.
- `application/**` may not import `interfaces/**`, nor a transport (`express`, `cors`, `ws`).
- `infrastructure/**` may not import `application/**` or `interfaces/**`.
- `interfaces/**` may not import `infrastructure/db/**` — routes go through a service.

Two details are deliberate:

**Use `@typescript-eslint/no-restricted-imports`, not the base rule.** The base rule does
not reliably cover `import type`. That is not an edge case here: the exact violation ADR
0003 found was `import type { GeminiSchema }`. A type-only import of a vendor's wire format
couples the domain to that vendor just as firmly as a value import does — it is a
compile-time dependency on a shape you do not control.

**Match on the literal specifier, not a resolved path.** This works because any relative
import that reaches another ring must traverse that ring's directory name:
`../../infrastructure/db/prisma` contains `infrastructure` at every nesting depth. It keeps
the rule dependency-free — no `eslint-import-resolver-typescript`, no resolver
configuration to drift out of sync.

Each rule carries a message explaining _why_ and what to do instead, because a developer
who hits a boundary at 6pm needs the alternative, not a citation.

## Consequences

- The rules were verified by deliberately introducing one violation per ring and confirming
  each was caught with its intended message. A boundary rule that never fires is worse than
  no rule, because it manufactures confidence.
- New violations are caught in seconds, in the author's editor, by the person with the most
  context — instead of in review, or never.
- The rules describe the structure as it is **today**. When a legitimate need crosses a
  boundary, the correct response is to change the rule and say why in an ADR — not to add
  an inline `eslint-disable`, which moves the decision out of the architecture and into a
  comment nobody will find.
- `backend/tests/**` is exempt: tests exist precisely to reach across boundaries and
  substitute fakes.
- On the frontend, only `react-hooks/rules-of-hooks` and `exhaustive-deps` are enabled
  rather than the plugin's full current `recommended` set. The newer additions
  (`set-state-in-effect`, `refs`) flag patterns in `AdminDemoPage` and `useMarketSocket`
  that work correctly today, and acting on them means rewriting live components. That is a
  real cleanup, but it is a behavioural change and belongs in its own pull request, not
  bundled into a structural one.
