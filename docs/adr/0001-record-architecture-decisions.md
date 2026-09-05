# 1. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

The interesting decisions in this codebase are not visible in the code that resulted from
them. `server.ts` binds the HTTP port before it starts ingestion; nothing about that line
says it is a mutex protecting a shared cache from a second writer. `domain/` imports no
framework; nothing about an absence says it was deliberate.

Decisions like these get re-litigated. Someone sees the odd startup ordering, tidies it,
and the bug it was preventing comes back — six months later, in production, looking like a
data problem rather than a process problem. The knowledge lived in one person's head and
the code recorded only the conclusion, not the reason.

## Decision

Significant architectural decisions are recorded as Architecture Decision Records in
`docs/adr/`, numbered sequentially and never rewritten once accepted. A decision that is
later reversed gets a new ADR that supersedes the old one; the original stays, so the
history of the reasoning stays readable.

An ADR is warranted when a choice is (a) hard to reverse, (b) constrains later work, or
(c) will look arbitrary to someone who wasn't there. Routine choices do not need one.

Each record states the **context** (the pain that forced the decision), the **decision**,
and the **consequences** — including the ones that are bad. An ADR that lists only benefits
is marketing, and it is the costs a future reader most needs.

## Consequences

- A reviewer can ask "which ADR covers this?" and get a real answer instead of an argument.
- Code comments explaining _why_ can point at an ADR instead of repeating it, and the
  comment stops drifting from the reasoning.
- It costs a few minutes per significant decision, and the discipline decays if ADRs are
  written after the fact to justify something already built. Write them when deciding.
