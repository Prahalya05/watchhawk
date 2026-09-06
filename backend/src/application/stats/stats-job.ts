import { getActiveSymbols } from "../ingestion/subscription-manager";
import { readWindow } from "../market-data/history.store";
import { computeAndStoreStats } from "./stats.service";

// Periodic recompute of SymbolStats from the rolling 52-week window in market:history,
// plus the current session's in-progress bar (folded in by computeAndStoreStats).
//
// This now recomputes high52w/low52w as well, which it deliberately did not before. The
// old reason was sound for the old data: a recompute over ~90 days could only shrink a
// genuine 52-week extreme, so the running high maintained by market-state-writer.ts was
// the better of two bad options. A real rolling window removes the trade-off — see the
// comment in stats.service.ts for why refusing to recompute is now the wrong answer.
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
    const bars = await readWindow(symbol);
    if (bars.length > 0) {
      await computeAndStoreStats(symbol, bars);
      recomputed.push(symbol);
    }
  }
  return recomputed;
}
