import { defineConfig } from "vitest/config";

// Two tiers, split by what they need to run rather than by what they assert.
//
// `unit` covers the inner rings — the diff engine, severity scoring, explanation traces,
// the command parser, token handling. None of it touches a socket, so the whole tier runs
// in about two seconds and can gate every commit.
//
// `integration` boots the real Express app and drives it over real HTTP. It is slower and
// has a genuine dependency on process wiring, so CI runs it after the unit tier: a broken
// diff calculation should be reported in seconds, not after a server has finished booting.
//
// Both tiers load tests/setup/env.ts first. config/env.ts validates the environment at
// import time and calls process.exit(1) on anything missing, so the fallbacks have to be
// in place before any module under test is imported — doing it here rather than with an
// `import "../setup/env"` line at the top of each file means a new test cannot forget it.
const shared = {
  environment: "node" as const,
  setupFiles: ["./tests/setup/env.ts"],
};

export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      { test: { ...shared, name: "integration", include: ["tests/integration/**/*.test.ts"] } },
    ],
  },
});
