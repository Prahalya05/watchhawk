import { sweepStaleness } from "../market-data/staleness";
import { runStatsJob } from "../stats/stats-job";

const STALENESS_SWEEP_INTERVAL_MS = 10_000;
const STATS_RECOMPUTE_INTERVAL_MS = 60_000;

export function startScheduledJobs(): void {
  setInterval(() => {
    sweepStaleness().catch((err) => console.error("[scheduler] staleness sweep failed", err));
  }, STALENESS_SWEEP_INTERVAL_MS);

  setInterval(() => {
    runStatsJob().catch((err) => console.error("[scheduler] stats job failed", err));
  }, STATS_RECOMPUTE_INTERVAL_MS);
}
