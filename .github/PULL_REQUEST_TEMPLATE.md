## What this changes

<!-- One or two sentences. What does the system do after this that it did not before? -->

## Why

<!-- The problem, not the solution. If it fixes an issue, link it. -->

## How it was verified

<!-- The section that matters. "CI is green" is not verification of new behaviour.
     Say what you actually ran or observed:
       - test added: tests/unit/domain/diff/scoring.test.ts covers the boundary at 2 sigma
       - checked by hand: added RELIANCE, forced a NEWS event, badge appeared
       - not verified: <say so plainly> -->

## Checklist

- [ ] `npm run format:check && npm run lint && npm run typecheck && npm test` passes locally
- [ ] Commits follow Conventional Commits
- [ ] Mechanical changes (renames, formatting) are in separate commits from behavioural ones
- [ ] Ring boundaries respected — or the rule was changed with an ADR explaining why
- [ ] Tests added or updated for changed behaviour, in the tier that matches what they need
- [ ] Docs updated if this changes setup, the API, or the architecture
      (`docs/diagrams.md` lives next to the code precisely so it can change in this PR)
- [ ] New dependencies justified in the description

## Anything a reviewer should look at closely

<!-- Trade-offs you are unsure about, a shortcut you took deliberately, a file to read first. -->
