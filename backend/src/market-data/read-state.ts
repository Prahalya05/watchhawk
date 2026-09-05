import { redis } from "../db/redis";
import type { MarketStateSnapshot } from "../modules/diff/diff.types";

const STATE_PREFIX = "market:state:";

export async function readMarketState(symbol: string): Promise<MarketStateSnapshot | null> {
  const raw = await redis.hgetall(STATE_PREFIX + symbol);
  if (!hasRealState(raw)) return null;
  return parseState(raw);
}

// The staleness sweep (staleness.ts) writes an isStale flag for every actively-watched
// symbol on its own interval, independent of whether market-state-writer.ts has ever
// written real price data for it yet — for a symbol just added seconds ago, that HSET
// would otherwise create a hash with only isStale set. Require `price` specifically
// (not just "the hash has some keys") so a not-yet-polled symbol reads as no state
// rather than as a spurious ₹0.00.
function hasRealState(raw: Record<string, string> | null | undefined): raw is Record<string, string> {
  return !!raw && raw.price !== undefined;
}

export async function readMarketStates(symbols: string[]): Promise<Map<string, MarketStateSnapshot>> {
  const result = new Map<string, MarketStateSnapshot>();
  if (symbols.length === 0) return result;

  const pipeline = redis.pipeline();
  for (const symbol of symbols) pipeline.hgetall(STATE_PREFIX + symbol);
  const responses = await pipeline.exec();
  if (!responses) return result;

  responses.forEach(([, raw], i) => {
    const record = raw as Record<string, string>;
    if (hasRealState(record)) {
      result.set(symbols[i], parseState(record));
    }
  });
  return result;
}

function parseState(raw: Record<string, string>): MarketStateSnapshot {
  return {
    price: parseFloat(raw.price ?? "0"),
    volume: parseFloat(raw.volume ?? "0"),
    dayOpen: parseFloat(raw.dayOpen ?? "0"),
    prevClose: parseFloat(raw.prevClose ?? "0"),
    sessionOpenedAt: parseInt(raw.sessionOpenedAt ?? "0", 10),
    sessionElapsedFraction: parseFloat(raw.sessionElapsedFraction ?? "0.5"),
    updatedAt: parseInt(raw.updatedAt ?? "0", 10),
    source: raw.source ?? "REPLAY",
    mode: raw.mode ?? "REPLAY",
    isStale: raw.isStale === "1",
    isDivergent: raw.isDivergent === "1",
    divergencePct: raw.divergencePct ? parseFloat(raw.divergencePct) : null,
  };
}
