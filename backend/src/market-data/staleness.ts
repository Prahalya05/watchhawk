import { redis } from "../db/redis";
import { env } from "../config/env";
import { getActiveSymbols } from "../ingestion/subscription-manager";

// NSE regular trading session: 9:15–15:30 IST, Monday–Friday. No holiday calendar
// (flagged scope reduction in the plan) — a market holiday will read as OPEN with
// unchanged prices rather than CLOSED.
export function getMarketStatus(now: Date = new Date()): "OPEN" | "CLOSED" {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffsetMs + now.getTimezoneOffset() * 60 * 1000);
  const day = ist.getUTCDay(); // after the manual offset above, getUTC* reads as IST wall-clock
  if (day === 0 || day === 6) return "CLOSED";

  const minutesOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const marketOpen = 9 * 60 + 15;
  const marketClose = 15 * 60 + 30;
  return minutesOfDay >= marketOpen && minutesOfDay <= marketClose ? "OPEN" : "CLOSED";
}

// Runs on an interval (see jobs/scheduler.ts) so staleness is reflected even for symbols
// nobody is actively diffing right now, including via WS ticks. Independent of which
// provider/mode last wrote the state.
export async function sweepStaleness(): Promise<void> {
  const symbols = await getActiveSymbols();
  if (symbols.length === 0) return;

  const pipeline = redis.pipeline();
  for (const symbol of symbols) {
    pipeline.hget(`market:state:${symbol}`, "updatedAt");
  }
  const results = await pipeline.exec();
  if (!results) return;

  const now = Date.now();
  const writePipeline = redis.pipeline();
  let hasWrites = false;
  results.forEach(([, value], i) => {
    // No updatedAt yet means market-state-writer.ts hasn't written this symbol's first
    // real quote — skip it rather than HSET-ing a placeholder hash with only isStale
    // set (which read-state.ts would otherwise have to specifically guard against).
    if (value === null) return;
    const updatedAt = parseInt(value as string, 10);
    const isStale = now - updatedAt > env.STALE_THRESHOLD_MS;
    writePipeline.hset(`market:state:${symbols[i]}`, "isStale", isStale ? "1" : "0");
    hasWrites = true;
  });
  if (hasWrites) await writePipeline.exec();
}
