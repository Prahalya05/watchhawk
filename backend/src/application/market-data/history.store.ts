import { redis } from "../../infrastructure/db/redis";
import {
  MAX_HISTORY_BARS,
  barTimestamp,
  extendIntradayBar,
  nseSessionDate,
  selectWindow,
  windowStartMs,
} from "../../domain/market/history-window";
import type { DailyBar } from "../../domain/ports/market-data.port";

// The one place that knows how daily history is stored. Two keys per symbol:
//
//   market:history:<symbol>   sorted set of closed daily bars, scored by the bar's date
//   market:intraday:<symbol>  the single in-progress bar for the current session
//
// Both used to be implicit: the backfill wrote the sorted set directly with a fixed
// 90-entry rank trim and nobody else ever touched it again, which is why the "52-week"
// window was neither 52 weeks nor rolling. Retention is now by time — bars leave the
// window when they age out of it, which is the only trim rule that makes the extremes
// mean what they are called.

export function historyKey(symbol: string): string {
  return `market:history:${symbol}`;
}

function intradayKey(symbol: string): string {
  return `market:intraday:${symbol}`;
}

function refreshMarkerKey(symbol: string): string {
  return `market:history:refreshed:${symbol}`;
}

export async function readHistory(symbol: string): Promise<DailyBar[]> {
  const raw = await redis.zrange(historyKey(symbol), 0, -1);
  return raw.map((r) => JSON.parse(r) as DailyBar);
}

export async function readWindow(symbol: string, now: number = Date.now()): Promise<DailyBar[]> {
  return selectWindow(await readHistory(symbol), now);
}

export async function countHistory(symbol: string): Promise<number> {
  return redis.zcard(historyKey(symbol));
}

// Writes bars and applies both retention rules in one pipeline.
//
// The per-bar zremrangebyscore is what makes this an upsert rather than an append. The
// sorted-set member is the serialised bar, so re-adding a *revised* bar for a date we
// already hold would otherwise leave two members sharing one score — and a window whose
// bar count no longer matches its day count reports a nonsense historyDays.
export async function saveBars(symbol: string, bars: DailyBar[], now: number = Date.now()): Promise<void> {
  const key = historyKey(symbol);
  const pipeline = redis.pipeline();
  let wrote = false;

  for (const bar of bars) {
    const score = barTimestamp(bar);
    if (!Number.isFinite(score)) continue;
    pipeline.zremrangebyscore(key, score, score);
    pipeline.zadd(key, score, JSON.stringify(bar));
    wrote = true;
  }
  if (!wrote) return;

  pipeline.zremrangebyscore(key, "-inf", `(${windowStartMs(now)}`);
  pipeline.zremrangebyrank(key, 0, -(MAX_HISTORY_BARS + 1));
  await pipeline.exec();
}

// Drops bars that have aged out of the window without writing any. Called on the refresh
// pass so the window keeps rolling even for a symbol whose provider fetch failed — an
// outage should stop the window growing, not freeze the trailing edge in place.
export async function trimToWindow(symbol: string, now: number = Date.now()): Promise<void> {
  await redis.zremrangebyscore(historyKey(symbol), "-inf", `(${windowStartMs(now)}`);
}

export async function readIntradayBar(symbol: string): Promise<DailyBar | null> {
  const raw = await redis.get(intradayKey(symbol));
  return raw === null ? null : (JSON.parse(raw) as DailyBar);
}

// Folds one live quote into today's in-progress bar. Called from the single market-state
// writer on every tick, in both live and replay mode, which is what lets the 52-week
// extremes reach the current price instead of stopping at the last closed session.
export async function recordIntradayPrice(
  symbol: string,
  observation: { price: number; dayOpen: number; volume: number },
  at: Date = new Date(),
): Promise<DailyBar> {
  const date = nseSessionDate(at);
  const current = await readIntradayBar(symbol);
  const next = extendIntradayBar(current, {
    date,
    open: observation.dayOpen,
    price: observation.price,
    volume: observation.volume,
  });
  await redis.set(intradayKey(symbol), JSON.stringify(next));
  return next;
}

// Turns yesterday's in-progress bar into a closed one. This is what rolls the window
// forward with no network at all, and it is the only mechanism that does so in replay
// mode — ReplayProvider.fetchDailyHistory() generates a fresh random walk on every call,
// so re-fetching it would rewrite the past rather than extend it.
//
// It never overwrites a bar the provider has already closed for that date: the provider's
// figure is authoritative and ours is a poll-sampled approximation of it.
export async function promoteClosedIntradayBar(symbol: string, at: Date = new Date()): Promise<DailyBar | null> {
  const pending = await readIntradayBar(symbol);
  if (pending === null || pending.date === nseSessionDate(at)) return null;

  const score = barTimestamp(pending);
  const alreadyClosed = Number.isFinite(score) ? await redis.zcount(historyKey(symbol), score, score) : 1;
  if (alreadyClosed === 0) {
    await saveBars(symbol, [pending], at.getTime());
  }
  await redis.del(intradayKey(symbol));
  return alreadyClosed === 0 ? pending : null;
}

// One provider refresh per symbol per session date. The marker is the date that was last
// fetched for, not a timestamp, so a restart inside the same session does not re-spend a
// provider request and a restart after midnight does not skip one.
export async function shouldRefreshFromProvider(symbol: string, at: Date = new Date()): Promise<boolean> {
  return (await redis.get(refreshMarkerKey(symbol))) !== nseSessionDate(at);
}

export async function markRefreshedFromProvider(symbol: string, at: Date = new Date()): Promise<void> {
  await redis.set(refreshMarkerKey(symbol), nseSessionDate(at));
}
