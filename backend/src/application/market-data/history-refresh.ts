import { effectiveMarketDataMode } from "../../config/env";
import { HISTORY_FETCH_DAYS } from "../../domain/market/history-window";
import { compositeProvider } from "./composite-provider";
import {
  markRefreshedFromProvider,
  promoteClosedIntradayBar,
  readWindow,
  saveBars,
  shouldRefreshFromProvider,
  trimToWindow,
} from "./history.store";
import { getActiveSymbols } from "../ingestion/subscription-manager";
import { computeAndStoreStats } from "../stats/stats.service";

// What actually makes the 52-week window roll.
//
// The backfill fetches history once, when a symbol has none. Without this pass that was
// the end of it: the stored bars never gained a new session and never lost an old one, so
// "the last 52 weeks" silently became "the 52 weeks ending whenever this symbol was first
// watched" — and after a month of uptime the window's leading edge was a month stale
// while its trailing edge held highs that had already aged out.
//
// Each pass does three things per watched symbol, cheapest first:
//
//   1. Promotes yesterday's in-progress bar to a closed one. No network, works in replay
//      mode, and is what advances the leading edge on any day the provider fetch is
//      skipped or fails.
//   2. In live mode, re-fetches the full range once per session date. The provider is
//      authoritative — it fills the sessions this process was not running for, and
//      replaces our poll-sampled bars with real ones.
//   3. Trims the trailing edge and recomputes SymbolStats, so an expired high leaves the
//      window even when nothing new arrived.

// Backs off to hourly-ish rather than running on the stats cadence. Promotion only has
// anything to do once a day, and the provider fetch is explicitly rate-limited to once
// per symbol per session date, so a tighter interval would buy nothing but Redis reads.
export const HISTORY_REFRESH_INTERVAL_MS = 30 * 60_000;

export interface HistoryRefreshResult {
  promoted: string[];
  refetched: string[];
  failed: string[];
}

export async function refreshHistoryWindow(at: Date = new Date()): Promise<HistoryRefreshResult> {
  const symbols = await getActiveSymbols();
  const result: HistoryRefreshResult = { promoted: [], refetched: [], failed: [] };

  for (const symbol of symbols) {
    try {
      const promoted = await promoteClosedIntradayBar(symbol, at);
      if (promoted) result.promoted.push(symbol);

      if (await refetchFromProvider(symbol, at)) result.refetched.push(symbol);

      await trimToWindow(symbol, at.getTime());
      // Recomputed unconditionally: the trim above can have removed the bar that was
      // holding high52w, and a stats row that still quotes it is exactly the stale
      // high-water mark this whole change is meant to eliminate.
      const window = await readWindow(symbol, at.getTime());
      if (window.length > 0) await computeAndStoreStats(symbol, window, at.getTime());
    } catch (err) {
      // Per-symbol, like every other provider path here: one symbol the vendor refuses to
      // serve must not stop the other 33 from rolling their windows forward.
      console.warn(`[history-refresh] ${symbol} failed:`, (err as Error).message);
      result.failed.push(symbol);
    }
  }

  return result;
}

// Replay mode deliberately never re-fetches. ReplayProvider.fetchDailyHistory() walks a
// fresh random series backward from the symbol's base price on every call, so merging its
// output would not extend the history — it would overwrite the past with a different past
// each time, and the 52-week extremes would jump around for reasons no user could explain.
// Promotion alone keeps the replay window rolling, which is all a synthetic feed needs.
async function refetchFromProvider(symbol: string, at: Date): Promise<boolean> {
  if (effectiveMarketDataMode !== "live") return false;
  if (!(await shouldRefreshFromProvider(symbol, at))) return false;

  const bars = await compositeProvider.getBackfillProvider().fetchDailyHistory(symbol, HISTORY_FETCH_DAYS);
  if (bars.length === 0) return false;

  await saveBars(symbol, bars, at.getTime());
  // Marked only after a fetch that actually returned bars, so a vendor outage retries on
  // the next pass instead of burning this symbol's one attempt for the day.
  await markRefreshedFromProvider(symbol, at);
  return true;
}
