import { redis } from "../../infrastructure/db/redis";
import { prisma } from "../../infrastructure/db/prisma";
import type { DailyBar } from "../../domain/ports/market-data.port";

export async function readHistory(symbol: string): Promise<DailyBar[]> {
  const raw = await redis.zrange(`market:history:${symbol}`, 0, -1);
  return raw.map((r) => JSON.parse(r) as DailyBar);
}

// Shared by historical-backfill.ts (first computation) and stats-job.ts (periodic
// recompute) so both paths derive SymbolStats the same way.
export async function computeAndStoreStats(symbol: string, bars: DailyBar[]): Promise<void> {
  if (bars.length === 0) return;
  const last20 = bars.slice(-20);
  const avgVolume20d = average(last20.map((b) => b.volume));

  const dailyReturns: number[] = [];
  const overnightGaps: number[] = [];
  for (let i = 1; i < last20.length; i++) {
    dailyReturns.push((last20[i].close - last20[i - 1].close) / last20[i - 1].close);
    overnightGaps.push(Math.abs((last20[i].open - last20[i - 1].close) / last20[i - 1].close));
  }
  const stdevReturn20d = Math.max(stdev(dailyReturns), 0.0001);
  const avgOvernightGapPct = Math.max(average(overnightGaps), 0.0001);

  const high52w = Math.max(...bars.map((b) => b.high));
  const low52w = Math.min(...bars.map((b) => b.low));

  await prisma.symbolStats.upsert({
    where: { symbol },
    create: { symbol, avgVolume20d, stdevReturn20d, high52w, low52w, avgOvernightGapPct, historyDays: bars.length },
    update: { avgVolume20d, stdevReturn20d, avgOvernightGapPct, historyDays: bars.length },
    // Note: high52w/low52w are NOT overwritten on periodic recompute — they're the
    // running extremes market-state-writer.ts maintains live as new prices arrive
    // (see checkFiftyTwoWeekExtreme). A batch recompute from a limited history window
    // could otherwise incorrectly shrink them back down.
  });
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((v) => (v - mean) ** 2));
  return Math.sqrt(variance);
}
