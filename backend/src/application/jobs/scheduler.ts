import { sweepStaleness } from "../market-data/staleness";
import { runStatsJob } from "../stats/stats-job";
import { reconcileRefcountsFromDatabase } from "../ingestion/subscription-manager";
import { HISTORY_REFRESH_INTERVAL_MS, refreshHistoryWindow } from "../market-data/history-refresh";
import { ingestEventFeeds } from "../ingestion/event-feed-ingestor";
import { env, eventFeedEnabled } from "../../config/env";

const STALENESS_SWEEP_INTERVAL_MS = 10_000;
const STATS_RECOMPUTE_INTERVAL_MS = 60_000;

// Slower than the other two on purpose. This is a repair job for a window that is already
// narrow (a crash between a watchlist transaction committing and its Redis refcount being
// written), and the whole pass is one groupBy plus one pipeline — cheap, but not so cheap
// that it should run every ten seconds to fix something that almost never happens. Five
// minutes is the bound on how long a symbol can be silently unpolled.
const REFCOUNT_RECONCILE_INTERVAL_MS = 5 * 60_000;

export function startScheduledJobs(): void {
  setInterval(() => {
    sweepStaleness().catch((err) => console.error("[scheduler] staleness sweep failed", err));
  }, STALENESS_SWEEP_INTERVAL_MS);

  setInterval(() => {
    runStatsJob().catch((err) => console.error("[scheduler] stats job failed", err));
  }, STATS_RECOMPUTE_INTERVAL_MS);

  setInterval(() => {
    reconcileRefcountsFromDatabase().catch((err) => console.error("[scheduler] refcount reconcile failed", err));
  }, REFCOUNT_RECONCILE_INTERVAL_MS);

  // Rolls the 52-week window: promotes yesterday's in-progress bar, re-fetches once per
  // session date in live mode, drops bars that have aged out. Run once immediately as
  // well as on the interval — a process that restarts every few hours would otherwise
  // never reach its first tick, and the window would stop rolling for exactly the reason
  // it used to: nothing ever asked it to.
  // `announceNoop` is true only for the startup pass. A refresh that finds everything
  // already current for today's session does nothing, and a silent no-op is
  // indistinguishable from a job that never ran — which is precisely the confusion the
  // event feed below is announced to avoid. Said once at startup, then quiet: repeating it
  // every thirty minutes would be noise rather than reassurance.
  const runHistoryRefresh = (announceNoop: boolean) =>
    refreshHistoryWindow()
      .then(({ promoted, refetched, failed }) => {
        const touched = promoted.length + refetched.length + failed.length;
        if (touched === 0) {
          if (announceNoop) {
            console.log("[scheduler] history window already current for this session — nothing to roll forward");
          }
          return;
        }
        console.log(
          `[scheduler] history window refreshed — ${promoted.length} promoted, ` +
            `${refetched.length} refetched, ${failed.length} failed`,
        );
      })
      .catch((err) => console.error("[scheduler] history refresh failed", err));

  void runHistoryRefresh(true);
  setInterval(() => void runHistoryRefresh(false), HISTORY_REFRESH_INTERVAL_MS);

  startEventFeedIngestion();
}

// Real NEWS / CORPORATE_ACTION ingestion. Announced either way at startup, because "no
// news events appeared" has two very different causes — the feed is off, or nothing was
// published — and a silent job leaves no way to tell them apart from the outside.
function startEventFeedIngestion(): void {
  if (!eventFeedEnabled) {
    console.log(
      `[scheduler] event feed ingestion disabled (EVENT_FEED_ENABLED=${env.EVENT_FEED_ENABLED}); ` +
        `NEWS / RATING_CHANGE / CORPORATE_ACTION will only appear when triggered from the admin panel`,
    );
    return;
  }

  const run = () =>
    ingestEventFeeds()
      .then(({ symbolsPolled, recorded, duplicates, belowThreshold, failed, unsupported }) => {
        if (symbolsPolled === 0) return;
        console.log(
          `[scheduler] event feed: ${recorded} new, ${duplicates} already known, ` +
            `${belowThreshold} below threshold, ${failed.length} failed across ${symbolsPolled} symbols` +
            (unsupported.length > 0 ? ` — no source for ${unsupported.join(", ")}` : ""),
        );
      })
      .catch((err) => console.error("[scheduler] event feed ingestion failed", err));

  void run();
  setInterval(run, env.EVENT_FEED_INTERVAL_MS);
}
