import { redis } from "../db/redis";

const REFCOUNT_PREFIX = "market:refcount:";

// Reference-counted subscription: a symbol is only actively polled/ticked while at
// least one user's watchlist references it. This is what keeps ingestion cost scaling
// with distinct symbols demanded, not with user count — the whole point of the shared
// market:state cache architecture from the plan.
export async function subscribe(symbol: string): Promise<number> {
  return redis.incr(REFCOUNT_PREFIX + symbol);
}

export async function unsubscribe(symbol: string): Promise<number> {
  const newCount = await redis.decr(REFCOUNT_PREFIX + symbol);
  if (newCount <= 0) {
    await redis.del(REFCOUNT_PREFIX + symbol);
    return 0;
  }
  return newCount;
}

export async function getRefcount(symbol: string): Promise<number> {
  const val = await redis.get(REFCOUNT_PREFIX + symbol);
  return val ? parseInt(val, 10) : 0;
}

export async function getActiveSymbols(): Promise<string[]> {
  return (await scanRefcountKeys()).map((k) => k.slice(REFCOUNT_PREFIX.length));
}

// SCAN, not KEYS. This runs on every poll cycle and every 10-second staleness sweep, and
// KEYS is O(entire keyspace) *and* blocks the Redis event loop for the whole scan — on a
// shared instance that stalls every other client too. SCAN walks in bounded slices
// instead; the trade is that it can return the same key twice across iterations, hence
// the Set, and that a key added mid-scan may or may not appear (harmless here — a symbol
// subscribed a millisecond ago simply gets polled on the next cycle).
const SCAN_BATCH = 500;

async function scanRefcountKeys(): Promise<string[]> {
  const found = new Set<string>();
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", REFCOUNT_PREFIX + "*", "COUNT", SCAN_BATCH);
    cursor = nextCursor;
    for (const key of keys) found.add(key);
  } while (cursor !== "0");
  return [...found];
}

// Rebuilds market:refcount:* from the durable WatchlistItem table. Required on every
// startup because Redis is not durable (see plan gap #5) — without this, a Redis
// restart would silently break the "only poll watched symbols" architecture.
export async function reconcileRefcounts(symbolCounts: Map<string, number>): Promise<void> {
  const existingKeys = await scanRefcountKeys();

  // Deletes and writes go through one pipeline, in chunks: a single DEL with thousands
  // of key arguments is itself a long-blocking command, which is the problem SCAN was
  // brought in to avoid.
  const pipeline = redis.pipeline();
  for (let i = 0; i < existingKeys.length; i += SCAN_BATCH) {
    pipeline.del(...existingKeys.slice(i, i + SCAN_BATCH));
  }
  for (const [symbol, count] of symbolCounts) {
    if (count > 0) pipeline.set(REFCOUNT_PREFIX + symbol, count);
  }
  await pipeline.exec();
}
