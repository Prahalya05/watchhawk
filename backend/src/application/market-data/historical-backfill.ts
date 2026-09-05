import { redis } from "../../infrastructure/db/redis";
import { SYMBOL_MAP, SYMBOL_UNIVERSE } from "../../domain/market/symbol-universe";
import { compositeProvider } from "./composite-provider";
import { getActiveSymbols } from "../ingestion/subscription-manager";
import type { DailyBar } from "../../domain/ports/market-data.port";
import { ReplayProvider } from "../../infrastructure/market-data/providers/replay.provider";
import { computeAndStoreStats } from "../stats/stats.service";
import { seedMarketStateFromHistory } from "../ingestion/market-state-writer";

const HISTORY_DAYS = 90; // Depth requested from the live provider's daily-chart endpoint;
// SymbolStats.historyDays records whatever we actually got rather than assuming this
// exact number, so the UI can be honest about it.
const MAX_HISTORY_ENTRIES = 90;

// No external spacing needed here: the backfill provider in live mode is the composite
// provider's shared Yahoo instance, which reserves slots from the same client-side rate
// limiter the poll loop uses (see YahooProvider.reserveSlot) regardless of caller, so a
// backfill running alongside a poll cycle cannot double the outbound request rate.
// Twelve Data's free plan can't serve NSE history at all (verify:live), so its per-minute
// cap is moot here. Replay mode makes no network calls and needs no spacing either.

// Runs once at startup for any *watched* symbol with no cached history (first boot, or
// after a Redis restart — Redis durability gap flagged in the plan). Scoped to watched
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
// until some later sweep. A no-op once history exists, so repeat adds cost one ZCARD.
export async function ensureHistory(symbol: string): Promise<void> {
  if (!SYMBOL_MAP.has(symbol)) return;
  if ((await redis.zcard(historyKey(symbol))) > 0) return;

  const replayFallback = new ReplayProvider();
  await replayFallback.start();
  await backfillSymbol(symbol, replayFallback);
}

async function backfillSymbol(symbol: string, replayFallback: ReplayProvider): Promise<void> {
  const key = historyKey(symbol);
  if ((await redis.zcard(key)) > 0) {
    // History survived but state may not have (e.g. a Redis snapshot restored without
    // the live keys). Seeding is a no-op when real state is already present, so it is
    // safe to attempt on every boot.
    await seedMarketStateFromHistory(symbol);
    return;
  }

  let bars: DailyBar[] = [];
  try {
    bars = await compositeProvider.getBackfillProvider().fetchDailyHistory(symbol, HISTORY_DAYS);
  } catch (err) {
    console.warn(`[backfill] real history fetch failed for ${symbol}, using synthetic:`, (err as Error).message);
  }
  if (bars.length === 0) {
    bars = await replayFallback.fetchDailyHistory(symbol, HISTORY_DAYS);
  }
  if (bars.length === 0) return;

  const pipeline = redis.pipeline();
  for (const bar of bars) {
    pipeline.zadd(key, new Date(bar.date).getTime(), JSON.stringify(bar));
  }
  pipeline.zremrangebyrank(key, 0, -(MAX_HISTORY_ENTRIES + 1));
  await pipeline.exec();

  await computeAndStoreStats(symbol, bars);
  // Give the symbol an initial (honestly-labelled stale) state off its last bar, so it
  // is renderable the moment someone adds it rather than only after a poll cycle —
  // which in live mode may not come until the market next opens.
  await seedMarketStateFromHistory(symbol);
}

function historyKey(symbol: string): string {
  return `market:history:${symbol}`;
}
