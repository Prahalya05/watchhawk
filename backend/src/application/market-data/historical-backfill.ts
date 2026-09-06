import { SYMBOL_MAP, SYMBOL_UNIVERSE } from "../../domain/market/symbol-universe";
import { HISTORY_FETCH_DAYS, FULL_WINDOW_MIN_BARS } from "../../domain/market/history-window";
import { compositeProvider } from "./composite-provider";
import { readWindow, saveBars } from "./history.store";
import { getActiveSymbols } from "../ingestion/subscription-manager";
import type { DailyBar } from "../../domain/ports/market-data.port";
import { ReplayProvider } from "../../infrastructure/market-data/providers/replay.provider";
import { computeAndStoreStats } from "../stats/stats.service";
import { seedMarketStateFromHistory } from "../ingestion/market-state-writer";

// Depth requested from the provider's daily-chart endpoint: a full 52 weeks plus slack,
// because a calendar range does not map cleanly onto trading days. It used to be 90,
// which is what made "52-week high" a ~90-day high. Retention and scoring are decided by
// the window in domain/market/history-window.ts, not by this number —
// SymbolStats.historyDays still records what we actually got rather than what we asked
// for, so a symbol the provider only partly serves is reported at its true depth.

// Runs once at startup for any *watched* symbol with no cached history (first boot, or
// after a Redis restart, since Redis holds no durable state). Scoped to watched
// symbols rather than the whole static universe for the same reason the poll loop is:
// backfilling 34 symbols nobody has on a watchlist is ~34 seconds of provider budget
// spent on data no one will read, and the cost grows with the universe rather than with
// demand. ensureHistory below is what covers a symbol the moment someone does add it.
export async function backfillMissingHistory(): Promise<void> {
  const symbols = await getActiveSymbols();
  if (symbols.length === 0) return;

  const replayFallback = new ReplayProvider();
  await replayFallback.start();

  for (const symbol of symbols) {
    await backfillSymbol(symbol, replayFallback);
  }
}

// Whole-universe warm-up, used only by `npm run seed`. Deliberately not what boot does:
// as an explicit operator command "prime everything before the demo" is exactly the
// intent, whereas doing it automatically on every boot spends provider budget on symbols
// nobody watches. Same per-symbol work, different trigger.
export async function backfillUniverse(): Promise<void> {
  const replayFallback = new ReplayProvider();
  await replayFallback.start();

  for (const def of SYMBOL_UNIVERSE) {
    await backfillSymbol(def.symbol, replayFallback);
  }
}

// Called when a symbol gains its first watcher, so an added symbol has real history (and
// therefore real SymbolStats) before its first diff rather than showing up as NO_DATA
// until some later sweep. Cheap and idempotent once history exists: backfillSymbol's own
// "already have a window" check is the guard, so both entry points agree on what counts
// as present — a key holding nothing but bars that have aged out of the window is not.
export async function ensureHistory(symbol: string): Promise<void> {
  if (!SYMBOL_MAP.has(symbol)) return;

  const replayFallback = new ReplayProvider();
  await replayFallback.start();
  await backfillSymbol(symbol, replayFallback);
}

async function backfillSymbol(symbol: string, replayFallback: ReplayProvider): Promise<void> {
  const existing = await readWindow(symbol);
  if (existing.length > 0) {
    // History survived but state may not have (e.g. a Redis snapshot restored without
    // the live keys). Seeding is a no-op when real state is already present, so it is
    // safe to attempt on every boot.
    await seedMarketStateFromHistory(symbol);
    // A window this short is not a 52-week window. It happens on an upgrade from the old
    // 90-day retention, and after a provider that only partly served the range — either
    // way the next refresh pass is where it gets deepened, so say so once rather than
    // letting the shortfall sit silently behind a "52-week" label.
    if (existing.length < FULL_WINDOW_MIN_BARS) {
      console.log(
        `[backfill] ${symbol} holds ${existing.length} bars, short of a full 52-week window ` +
          `(~${FULL_WINDOW_MIN_BARS}+); extremes are reported over the shorter window until it fills`,
      );
    }
    return;
  }

  let bars: DailyBar[] = [];
  try {
    bars = await compositeProvider.getBackfillProvider().fetchDailyHistory(symbol, HISTORY_FETCH_DAYS);
  } catch (err) {
    console.warn(`[backfill] real history fetch failed for ${symbol}, using synthetic:`, (err as Error).message);
  }
  if (bars.length === 0) {
    bars = await replayFallback.fetchDailyHistory(symbol, HISTORY_FETCH_DAYS);
  }
  if (bars.length === 0) return;

  await saveBars(symbol, bars);
  await computeAndStoreStats(symbol, bars);
  // Give the symbol an initial (honestly-labelled stale) state off its last bar, so it
  // is renderable the moment someone adds it rather than only after a poll cycle —
  // which in live mode may not come until the market next opens.
  await seedMarketStateFromHistory(symbol);
}
