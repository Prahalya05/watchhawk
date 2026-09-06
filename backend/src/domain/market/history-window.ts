import type { DailyBar } from "../ports/market-data.port";

// The rolling 52-week window, and everything derived from it.
//
// This file exists because "52-week high" was previously computed from ~90 days of bars.
// A 90-day high is a different statistic wearing a well-known name: on a symbol that ran
// up nine months ago, it reads as a breakout when nothing has broken out. Labelling the
// window honestly (SymbolStats.historyDays) made it non-misleading, not correct — so the
// window is now a real 52 weeks, and the two things a real 52-week window needs that a
// one-shot 90-day backfill never did are handled here:
//
//   1. It has to *roll*. Bars older than the window leave it, which means the high can go
//      down as well as up. A ratchet that only ever rises is a high-water mark, not a
//      52-week high.
//   2. It has to reach *now*. The last closed daily bar is yesterday's, so today's live
//      prices are tracked as an in-progress bar and folded into the extremes; without
//      that, an intraday breakout is invisible until tomorrow's bar exists.

const DAY_MS = 24 * 60 * 60 * 1000;

export const HISTORY_WINDOW_WEEKS = 52;
export const HISTORY_WINDOW_DAYS = HISTORY_WINDOW_WEEKS * 7; // 364 — literally 52 weeks

// Requested depth, not retained depth. Yahoo's chart endpoint takes a calendar range and
// returns trading days, and its earliest bar can land a few days inside the range, so the
// fetch asks for slack and selectWindow() below decides what actually counts.
export const HISTORY_FETCH_DAYS = HISTORY_WINDOW_DAYS + 21;

// NSE trades roughly 250 sessions a year. Below this a symbol's window is genuinely
// shorter than 52 weeks (a recent listing, or a backfill the provider only partly served)
// and the explanation says so rather than calling it a 52-week extreme.
export const FULL_WINDOW_MIN_BARS = 200;

// Hard ceiling on stored bars, independent of the time-based trim. The time trim is the
// real retention rule; this only bounds the key if a provider ever returns something
// unexpected (intraday bars mislabelled as daily, duplicated dates at distinct scores).
export const MAX_HISTORY_BARS = 400;

// Rounding a return's stdev or an average gap to zero divides a later z-score by almost
// nothing and rates everything CRITICAL, so both carry a floor. Kept here beside the
// window rather than in scoring.ts because it is a property of the estimate, not of the
// threshold ladder that consumes it.
const MIN_POSITIVE_ESTIMATE = 0.0001;

export function windowStartMs(now: number = Date.now()): number {
  return now - HISTORY_WINDOW_DAYS * DAY_MS;
}

// Bars are keyed and scored by their ISO date, which Date.parse reads as UTC midnight.
// Consistent on both sides (write score and read filter), which is all this needs to be.
export function barTimestamp(bar: DailyBar): number {
  return Date.parse(bar.date);
}

// The NSE session date for an instant, as an ISO date string. Not the server's local
// date: a process running in UTC would roll the "current day" over at 05:30 IST, in the
// middle of the night but also three and a half hours before the session it is supposed
// to name has even opened.
export function nseSessionDate(now: Date = new Date()): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Bars inside the window, oldest first. Anything unparseable is dropped rather than
// sorted to the front, where a NaN score would otherwise make it the "oldest" bar.
export function selectWindow(bars: DailyBar[], now: number = Date.now()): DailyBar[] {
  const start = windowStartMs(now);
  return bars
    .filter((bar) => {
      const t = barTimestamp(bar);
      return Number.isFinite(t) && t >= start;
    })
    .sort((a, b) => barTimestamp(a) - barTimestamp(b));
}

// Deduplicates by date, incoming wins. A re-fetched bar for a date we already hold is the
// provider's corrected figure (exchanges do revise volume, and our own promoted
// in-progress bar is a strictly worse estimate than the provider's closed one), so the
// newer copy replaces the older instead of both surviving as separate entries.
export function mergeDailyBars(existing: DailyBar[], incoming: DailyBar[]): DailyBar[] {
  const byDate = new Map<string, DailyBar>();
  for (const bar of existing) byDate.set(bar.date, bar);
  for (const bar of incoming) byDate.set(bar.date, bar);
  return [...byDate.values()].sort((a, b) => barTimestamp(a) - barTimestamp(b));
}

// Folds one live price into the day's in-progress bar. A price for a different session
// date starts a new bar rather than extending yesterday's — that is what makes the
// previous day's bar final and promotable (see history.store.ts).
export function extendIntradayBar(
  current: DailyBar | null,
  observation: { date: string; open: number; price: number; volume: number },
): DailyBar {
  const { date, open, price, volume } = observation;
  if (!current || current.date !== date) {
    return { date, open, high: price, low: price, close: price, volume };
  }
  return {
    date,
    open: current.open,
    high: Math.max(current.high, price),
    low: Math.min(current.low, price),
    close: price,
    // Cumulative session volume as the source reports it, so the running maximum is the
    // right reducer: a provider that momentarily reports a lower cumulative figure is
    // wrong, and taking it would make the promoted bar under-report the day.
    volume: Math.max(current.volume, volume),
  };
}

export interface SymbolStatsComputation {
  avgVolume20d: number;
  stdevReturn20d: number;
  avgOvernightGapPct: number;
  high52w: number;
  low52w: number;
  historyDays: number;
  // False when the symbol simply does not have 52 weeks of history behind it. Carried
  // through to the explanation so a thin window is disclosed at the point it would
  // otherwise be mistaken for a full one.
  windowComplete: boolean;
}

// The whole of SymbolStats, derived in one pure pass so it can be tested without Redis or
// Postgres. Two deliberately different sample sets:
//
//   - the 20-day figures use *closed* bars only. Including today's in-progress bar would
//     average a partial session's volume into a full-day average and drag it down all day,
//     every day, which would then over-report every volume ratio scored against it.
//   - the 52-week extremes include the in-progress bar, because an intraday high is a
//     real high the moment it prints.
export function computeSymbolStats(args: {
  bars: DailyBar[];
  intradayBar?: DailyBar | null;
  now?: number;
}): SymbolStatsComputation | null {
  const now = args.now ?? Date.now();
  const window = selectWindow(args.bars, now);
  if (window.length === 0) return null;

  const last20 = window.slice(-20);
  const avgVolume20d = average(last20.map((b) => b.volume));

  const dailyReturns: number[] = [];
  const overnightGaps: number[] = [];
  for (let i = 1; i < last20.length; i++) {
    dailyReturns.push((last20[i].close - last20[i - 1].close) / last20[i - 1].close);
    overnightGaps.push(Math.abs((last20[i].open - last20[i - 1].close) / last20[i - 1].close));
  }

  // The in-progress bar counts toward the extremes only if it is genuinely inside the
  // window and is not a duplicate of a bar the provider has already closed for that date.
  const intraday = args.intradayBar ?? null;
  const intradayCounts =
    intraday !== null &&
    Number.isFinite(barTimestamp(intraday)) &&
    barTimestamp(intraday) >= windowStartMs(now) &&
    !window.some((bar) => bar.date === intraday.date);

  const highs = window.map((b) => b.high);
  const lows = window.map((b) => b.low);
  if (intradayCounts && intraday) {
    highs.push(intraday.high);
    lows.push(intraday.low);
  }

  return {
    avgVolume20d,
    stdevReturn20d: Math.max(stdev(dailyReturns), MIN_POSITIVE_ESTIMATE),
    avgOvernightGapPct: Math.max(average(overnightGaps), MIN_POSITIVE_ESTIMATE),
    high52w: Math.max(...highs),
    low52w: Math.min(...lows),
    historyDays: window.length,
    windowComplete: window.length >= FULL_WINDOW_MIN_BARS,
  };
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
