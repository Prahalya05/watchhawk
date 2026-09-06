import { prisma } from "../../infrastructure/db/prisma";
import { computeSymbolStats } from "../../domain/market/history-window";
import { readIntradayBar } from "../market-data/history.store";
import type { DailyBar } from "../../domain/ports/market-data.port";

export { readHistory, readWindow } from "../market-data/history.store";

// Shared by historical-backfill.ts (first computation) and stats-job.ts (periodic
// recompute) so both paths derive SymbolStats the same way. The arithmetic itself lives
// in domain/market/history-window.ts; this function is the I/O around it.
export async function computeAndStoreStats(symbol: string, bars: DailyBar[], now: number = Date.now()): Promise<void> {
  // The in-progress bar is read here rather than passed in because every caller would
  // otherwise have to remember to fetch it, and forgetting would silently reintroduce the
  // bug this replaced: extremes that stop at the last closed session.
  const intradayBar = await readIntradayBar(symbol);
  const computed = computeSymbolStats({ bars, intradayBar, now });
  if (!computed) return;

  const { avgVolume20d, stdevReturn20d, avgOvernightGapPct, high52w, low52w, historyDays } = computed;

  // high52w/low52w ARE recomputed here, which is a reversal of the previous behaviour and
  // the point of the change. They used to be excluded because a recompute over a 90-day
  // history could only shrink a genuine 52-week extreme — the window was too short to
  // hold the figure it was overwriting. With a real rolling 52-week window that argument
  // inverts: refusing to recompute is what is now wrong, because a ratchet that only ever
  // rises never lets last spring's high age out, and the "52-week high" stays pinned to a
  // price the last 52 weeks no longer contain.
  //
  // Nothing live is lost by recomputing: the in-progress bar folded in above carries
  // today's extremes, so a high set by a price that printed seconds ago survives the pass
  // that would otherwise drop it.
  // computedAt is stamped explicitly on update too. The column defaults to now() on
  // insert only, so leaving it out meant every recompute kept the row's *creation* time —
  // and the "why?" panel quotes that value verbatim as when the baseline was computed.
  await prisma.symbolStats.upsert({
    where: { symbol },
    create: { symbol, avgVolume20d, stdevReturn20d, high52w, low52w, avgOvernightGapPct, historyDays },
    update: {
      avgVolume20d,
      stdevReturn20d,
      high52w,
      low52w,
      avgOvernightGapPct,
      historyDays,
      computedAt: new Date(now),
    },
  });
}
