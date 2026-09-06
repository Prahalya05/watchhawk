import { defineConfig } from "vitest/config";

// The frontend's unit tier. Deliberately narrow: it covers lib/ — the pure functions the
// dashboard's presentation is derived from (money and time formatting, the filter/sort/
// summary pipeline, the event and severity vocabulary). Those hold the rules that are
// easy to break silently and expensive to notice, because a wrong sort order or a drifted
// label still renders perfectly.
//
// vite.config.ts is not reused here. Nothing in this tier renders a component, so the
// React plugin, the dev server port and the JSX transform would all be setup for work
// that never happens; a separate config keeps the run at "node, no DOM, ~1s".
//
// TZ is pinned because formatRelativeTime and the clock helpers read the ambient zone:
// without this the suite passes in Asia/Calcutta and fails on a CI runner in UTC, which
// is the least useful kind of red build.
export default defineConfig({
  test: {
    name: "unit",
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    env: { TZ: "UTC" },
  },
});
