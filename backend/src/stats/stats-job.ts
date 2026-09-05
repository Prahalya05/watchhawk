import { getActiveSymbols } from "../ingestion/subscription-manager";
import { readHistory, computeAndStoreStats } from "./stats.service";

// Periodic recompute of the derived, non-live parts of SymbolStats (avgVolume20d,
// stdevReturn20d, avgOvernightGapPct) from whatever's currently cached in
// market:history. high52w/low52w are deliberately left to market-state-writer.ts,
// which tracks them live off actual incoming prices (see stats.service.ts comment).
//
// Scoped to actively-watched symbols, not the whole static universe. The README's claim
// is that cost scales with symbols people actually watch rather than with the universe
// size, and this job ran every 60 seconds over all of it — one Redis history read per
// symbol per minute for symbols nobody had on a watchlist. The poll loop was already
// refcount-scoped; this is what makes the claim true end to end.
export async function runStatsJob(): Promise<string[]> {
  const symbols = await getActiveSymbols();
  const recomputed: string[] = [];

  for (const symbol of symbols) {
    const bars = await readHistory(symbol);
    if (bars.length > 0) {
      await computeAndStoreStats(symbol, bars);
      recomputed.push(symbol);
    }
  }
  return recomputed;
}
