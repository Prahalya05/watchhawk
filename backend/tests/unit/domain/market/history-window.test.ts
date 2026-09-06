import { describe, it, expect } from "vitest";
import {
  FULL_WINDOW_MIN_BARS,
  HISTORY_WINDOW_DAYS,
  computeSymbolStats,
  extendIntradayBar,
  mergeDailyBars,
  nseSessionDate,
  selectWindow,
} from "../../../../src/domain/market/history-window";
import type { DailyBar } from "../../../../src/domain/ports/market-data.port";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-06T10:00:00.000Z");

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString().slice(0, 10);
}

function bar(overrides: Partial<DailyBar> & { date: string }): DailyBar {
  return { open: 100, high: 101, low: 99, close: 100, volume: 1_000, ...overrides };
}

// A run of ordinary bars, oldest first, so a test only has to state the ones it cares
// about. Flat by construction: any extreme a test asserts on is one it put there.
function series(count: number, from = count): DailyBar[] {
  return Array.from({ length: count }, (_, i) => bar({ date: isoDaysAgo(from - i) }));
}

describe("selectWindow", () => {
  it("keeps bars inside 52 weeks and drops the ones that have aged out", () => {
    const bars = [
      bar({ date: isoDaysAgo(HISTORY_WINDOW_DAYS + 1) }),
      bar({ date: isoDaysAgo(HISTORY_WINDOW_DAYS - 1) }),
      bar({ date: isoDaysAgo(1) }),
    ];

    expect(selectWindow(bars, NOW).map((b) => b.date)).toEqual([isoDaysAgo(HISTORY_WINDOW_DAYS - 1), isoDaysAgo(1)]);
  });

  it("returns bars oldest-first regardless of input order", () => {
    const bars = [bar({ date: isoDaysAgo(1) }), bar({ date: isoDaysAgo(10) }), bar({ date: isoDaysAgo(5) })];
    expect(selectWindow(bars, NOW).map((b) => b.date)).toEqual([isoDaysAgo(10), isoDaysAgo(5), isoDaysAgo(1)]);
  });

  it("drops an unparseable date rather than sorting it to the front as the oldest bar", () => {
    const bars = [bar({ date: "not-a-date" }), bar({ date: isoDaysAgo(1) })];
    expect(selectWindow(bars, NOW)).toHaveLength(1);
  });
});

describe("mergeDailyBars", () => {
  it("replaces a bar we already hold for the same date instead of keeping both", () => {
    const merged = mergeDailyBars(
      [bar({ date: "2026-09-04", volume: 100 })],
      [bar({ date: "2026-09-04", volume: 900 })],
    );

    expect(merged).toHaveLength(1);
    // Incoming wins: it is the provider's closed figure replacing our poll-sampled one.
    expect(merged[0].volume).toBe(900);
  });

  it("keeps the union sorted by date", () => {
    const merged = mergeDailyBars([bar({ date: "2026-09-04" })], [bar({ date: "2026-09-01" })]);
    expect(merged.map((b) => b.date)).toEqual(["2026-09-01", "2026-09-04"]);
  });
});

describe("extendIntradayBar", () => {
  const observation = { date: "2026-09-06", open: 100, price: 105, volume: 5_000 };

  it("starts a new bar when there is none", () => {
    expect(extendIntradayBar(null, observation)).toEqual({
      date: "2026-09-06",
      open: 100,
      high: 105,
      low: 105,
      close: 105,
      volume: 5_000,
    });
  });

  it("widens the high and low as prices print, and tracks the latest as the close", () => {
    const first = extendIntradayBar(null, observation);
    const second = extendIntradayBar(first, { ...observation, price: 110, volume: 6_000 });
    const third = extendIntradayBar(second, { ...observation, price: 95, volume: 7_000 });

    expect(third.high).toBe(110);
    expect(third.low).toBe(95);
    expect(third.close).toBe(95);
  });

  it("never lets cumulative volume go backwards on a bad print", () => {
    const first = extendIntradayBar(null, { ...observation, volume: 9_000 });
    expect(extendIntradayBar(first, { ...observation, volume: 10 }).volume).toBe(9_000);
  });

  it("starts a fresh bar on a new session date rather than extending yesterday's", () => {
    const yesterday = extendIntradayBar(null, { ...observation, date: "2026-09-05", price: 200 });
    const today = extendIntradayBar(yesterday, observation);

    expect(today.date).toBe("2026-09-06");
    // 200 belonged to yesterday's session. Carrying it forward would make today's bar
    // claim a high that never printed today, and yesterday's bar unpromotable.
    expect(today.high).toBe(105);
  });
});

describe("nseSessionDate", () => {
  it("uses the IST calendar day, not the server's", () => {
    // 20:00 UTC is already the next day in IST (01:30). A server running in UTC would
    // name the previous session; the NSE session that is about to open is the right one.
    expect(nseSessionDate(new Date("2026-09-06T20:00:00.000Z"))).toBe("2026-09-07");
    expect(nseSessionDate(new Date("2026-09-06T10:00:00.000Z"))).toBe("2026-09-06");
  });
});

describe("computeSymbolStats", () => {
  it("returns null when nothing is inside the window", () => {
    expect(computeSymbolStats({ bars: [bar({ date: isoDaysAgo(400) })], now: NOW })).toBeNull();
  });

  it("takes the 52-week extremes from the whole window, not just the recent bars", () => {
    const bars = [...series(60), bar({ date: isoDaysAgo(300), high: 500, low: 5 })];
    const stats = computeSymbolStats({ bars, now: NOW });

    expect(stats?.high52w).toBe(500);
    expect(stats?.low52w).toBe(5);
  });

  it("lets an old extreme age out of the window", () => {
    // The same 500 high, one day past the window's trailing edge. This is the behaviour
    // the previous ratchet could not express: a 52-week high that is no longer within 52
    // weeks must stop being the 52-week high.
    const bars = [...series(60), bar({ date: isoDaysAgo(HISTORY_WINDOW_DAYS + 1), high: 500, low: 5 })];
    const stats = computeSymbolStats({ bars, now: NOW });

    expect(stats?.high52w).toBe(101);
    expect(stats?.low52w).toBe(99);
  });

  it("folds today's in-progress bar into the extremes", () => {
    const stats = computeSymbolStats({
      bars: series(60),
      intradayBar: bar({ date: isoDaysAgo(0), high: 250, low: 50 }),
      now: NOW,
    });

    expect(stats?.high52w).toBe(250);
    expect(stats?.low52w).toBe(50);
  });

  it("keeps the in-progress bar out of the 20-day averages", () => {
    // A partial session's volume is not a full day's volume. Averaging it in would drag
    // avgVolume20d down all day, every day, and over-report every volume ratio scored
    // against it — so the extremes see the in-progress bar and the averages do not.
    const bars = series(60);
    const withIntraday = computeSymbolStats({
      bars,
      intradayBar: bar({ date: isoDaysAgo(0), volume: 1 }),
      now: NOW,
    });

    expect(withIntraday?.avgVolume20d).toBe(computeSymbolStats({ bars, now: NOW })?.avgVolume20d);
    expect(withIntraday?.avgVolume20d).toBe(1_000);
  });

  it("ignores an in-progress bar for a date the provider has already closed", () => {
    // Otherwise a stale intraday key left over from before a provider refetch would
    // double-count the day and could hold an extreme the closed bar disagrees with.
    const bars = [...series(60), bar({ date: isoDaysAgo(0), high: 101, low: 99 })];
    const stats = computeSymbolStats({
      bars,
      intradayBar: bar({ date: isoDaysAgo(0), high: 999, low: 1 }),
      now: NOW,
    });

    expect(stats?.high52w).toBe(101);
  });

  it("ignores an in-progress bar that has itself aged out of the window", () => {
    const stats = computeSymbolStats({
      bars: series(60),
      intradayBar: bar({ date: isoDaysAgo(HISTORY_WINDOW_DAYS + 5), high: 999 }),
      now: NOW,
    });

    expect(stats?.high52w).toBe(101);
  });

  it("reports historyDays as the bars actually inside the window", () => {
    const bars = [...series(30), bar({ date: isoDaysAgo(HISTORY_WINDOW_DAYS + 2) })];
    expect(computeSymbolStats({ bars, now: NOW })?.historyDays).toBe(30);
  });

  it("marks a window complete only once it holds a full 52 weeks of sessions", () => {
    expect(computeSymbolStats({ bars: series(FULL_WINDOW_MIN_BARS), now: NOW })?.windowComplete).toBe(true);
    expect(computeSymbolStats({ bars: series(FULL_WINDOW_MIN_BARS - 1), now: NOW })?.windowComplete).toBe(false);
  });

  it("floors a degenerate volatility estimate instead of returning zero", () => {
    // Every close identical. Without the floor the z-score divides by ~0 and every move
    // scores CRITICAL.
    const stats = computeSymbolStats({ bars: series(30), now: NOW });
    expect(stats?.stdevReturn20d).toBeGreaterThan(0);
    expect(stats?.avgOvernightGapPct).toBeGreaterThan(0);
  });
});
