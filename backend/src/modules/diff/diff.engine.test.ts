import { describe, expect, it } from "vitest";
import { computeSymbolDiff, rankEntries } from "./diff.engine";
import type {
  DiscreteEventInput,
  MarketStateSnapshot,
  SymbolStatsSnapshot,
  UserSymbolBaseline,
} from "./diff.types";

// computeSymbolDiff is deliberately a pure function — no Prisma, no Redis — which is
// what makes the scoring rules directly testable without a database or any mocking.

const NOW = Date.UTC(2026, 0, 15, 6, 0, 0);
const HOUR = 60 * 60 * 1000;

function makeState(overrides: Partial<MarketStateSnapshot> = {}): MarketStateSnapshot {
  return {
    price: 100,
    volume: 0,
    dayOpen: 100,
    prevClose: 100,
    // Session opened before the baseline below, so GAP_OPEN stays off unless a test
    // explicitly moves it forward.
    sessionOpenedAt: NOW - 4 * HOUR,
    sessionElapsedFraction: 0.5,
    updatedAt: NOW,
    source: "REPLAY",
    mode: "REPLAY",
    isStale: false,
    isDivergent: false,
    divergencePct: null,
    ...overrides,
  };
}

function makeStats(overrides: Partial<SymbolStatsSnapshot> = {}): SymbolStatsSnapshot {
  return { avgVolume20d: 1_000_000, stdevReturn20d: 0.01, avgOvernightGapPct: 0.005, ...overrides };
}

function makeBaseline(overrides: Partial<UserSymbolBaseline> = {}): UserSymbolBaseline {
  return {
    lastSeenAt: new Date(NOW - 2 * HOUR),
    lastSeenPrice: 100,
    lastSeenVolume: 0,
    ...overrides,
  };
}

function diff(
  state = makeState(),
  stats = makeStats(),
  baseline = makeBaseline(),
  events: DiscreteEventInput[] = []
) {
  return computeSymbolDiff(state, stats, baseline, events);
}

describe("PRICE_MOVE — volatility normalisation", () => {
  // This is the central claim of the product: "meaningful" is relative to how much a
  // given stock normally moves, not an absolute percentage. A blue chip and a small cap
  // moving the same 2% are NOT equally interesting.
  const blueChip = makeStats({ stdevReturn20d: 0.01 }); // 1% daily stdev
  const smallCap = makeStats({ stdevReturn20d: 0.05 }); // 5% daily stdev

  it("rates the same absolute move higher for a low-volatility stock", () => {
    const movedTwoPercent = makeState({ price: 102 });

    const blueChipResult = diff(movedTwoPercent, blueChip);
    const smallCapResult = diff(movedTwoPercent, smallCap);

    // 2% is z=2.0 for the blue chip but only z=0.4 for the small cap.
    expect(blueChipResult.maxSeverity).toBe("NOTABLE");
    expect(smallCapResult.maxSeverity).toBe("NONE");
    expect(smallCapResult.events).toHaveLength(0);
  });

  it("rates different absolute moves equally when their z-scores match", () => {
    // 2% on a 1%-stdev stock and 10% on a 5%-stdev stock are both z=2.0.
    const blueChipResult = diff(makeState({ price: 102 }), blueChip);
    const smallCapResult = diff(makeState({ price: 110 }), smallCap);

    expect(blueChipResult.maxSeverity).toBe(smallCapResult.maxSeverity);
    expect(blueChipResult.events[0].detail.zScore).toBeCloseTo(2, 5);
    expect(smallCapResult.events[0].detail.zScore).toBeCloseTo(2, 5);
  });

  it("escalates severity as the z-score crosses each threshold", () => {
    // Thresholds: |z| >= 0.75 MINOR, >= 1.5 NOTABLE, >= 3 CRITICAL.
    const severityAt = (price: number) => diff(makeState({ price }), blueChip).maxSeverity;

    expect(severityAt(100.5)).toBe("NONE"); // z = 0.5
    expect(severityAt(100.8)).toBe("MINOR"); // z = 0.8
    expect(severityAt(102)).toBe("NOTABLE"); // z = 2.0
    expect(severityAt(104)).toBe("CRITICAL"); // z = 4.0
  });

  it("scores downward moves by magnitude, and records the direction", () => {
    const down = diff(makeState({ price: 96 }), blueChip);
    const up = diff(makeState({ price: 104 }), blueChip);

    expect(down.maxSeverity).toBe("CRITICAL");
    expect(up.maxSeverity).toBe("CRITICAL");
    expect(down.events[0].detail.direction).toBe("DOWN");
    expect(up.events[0].detail.direction).toBe("UP");
    expect(down.events[0].detail.returnPct).toBeCloseTo(-4, 5);
  });

  it("emits nothing when there is no baseline price to diff against", () => {
    // A zero baseline would make the percentage return divide by zero; the guard has to
    // suppress the event rather than emit Infinity/NaN.
    const result = diff(makeState({ price: 100 }), blueChip, makeBaseline({ lastSeenPrice: 0 }));

    expect(result.events.filter((e) => e.type === "PRICE_MOVE")).toHaveLength(0);
  });
});

describe("VOLUME_SPIKE — prorated to time of day", () => {
  it("compares against expected volume so far, not the full-day average", () => {
    // Half a session elapsed against a 1M average = 500k expected. 1.1M traded is 2.2x
    // that, which should register — even though it is only 1.1x the *daily* average.
    const state = makeState({ volume: 1_100_000, sessionElapsedFraction: 0.5 });

    const result = diff(state);
    const spike = result.events.find((e) => e.type === "VOLUME_SPIKE");

    expect(spike?.severity).toBe("NOTABLE");
    expect(spike?.detail.volumeRatio).toBeCloseTo(2.2, 5);
  });

  it("does not fire early in a session for volume that is merely on pace", () => {
    // 10% into the session with 10% of average volume traded is exactly normal.
    const state = makeState({ volume: 100_000, sessionElapsedFraction: 0.1 });

    expect(diff(state).events.find((e) => e.type === "VOLUME_SPIKE")).toBeUndefined();
  });

  it("stays silent when volume has not grown since the user last looked", () => {
    // Guards the seeded-state path: a symbol seeded from its previous close carries
    // volume 0, and a stale figure the user has already seen is not new information.
    const state = makeState({ volume: 5_000_000, sessionElapsedFraction: 0.5 });
    const baseline = makeBaseline({ lastSeenVolume: 5_000_000 });

    expect(diff(state, makeStats(), baseline).events.find((e) => e.type === "VOLUME_SPIKE")).toBeUndefined();
  });
});

describe("GAP_OPEN — only across a session boundary the user missed", () => {
  const gapped = { dayOpen: 103, prevClose: 100 }; // +3% gap, vs 0.5% typical

  it("reports a gap when the session opened after the user last looked", () => {
    const state = makeState({ ...gapped, price: 100, sessionOpenedAt: NOW - HOUR });

    const gap = diff(state).events.find((e) => e.type === "GAP_OPEN");

    expect(gap?.severity).toBe("CRITICAL"); // 3% / 0.5% = 6x typical
    expect(gap?.detail.gapPct).toBeCloseTo(3, 5);
  });

  it("stays silent for a gap the user has already seen", () => {
    // Same gap, but the session opened three hours before the baseline — already seen.
    const state = makeState({ ...gapped, price: 100, sessionOpenedAt: NOW - 3 * HOUR });

    expect(diff(state).events.find((e) => e.type === "GAP_OPEN")).toBeUndefined();
  });

  it("does not divide by a missing previous close", () => {
    const state = makeState({ dayOpen: 103, prevClose: 0, sessionOpenedAt: NOW - HOUR });

    expect(diff(state).events.find((e) => e.type === "GAP_OPEN")).toBeUndefined();
  });
});

describe("discrete events", () => {
  function extreme(direction: "HIGH" | "LOW", minutesAgo: number, price = 120): DiscreteEventInput {
    return {
      eventType: "FIFTY_TWO_WEEK_EXTREME",
      severity: "NOTABLE",
      eventTime: new Date(NOW - minutesAgo * 60 * 1000),
      payload: { direction, price },
    };
  }

  it("collapses a repeated 52-week break into its most recent occurrence", () => {
    // A price ratcheting up re-clears its own high on every poll; five rows in the
    // database are still one fact, and five identical badges are just noise.
    const result = diff(makeState(), makeStats(), makeBaseline(), [
      extreme("HIGH", 30, 118),
      extreme("HIGH", 20, 119),
      extreme("HIGH", 10, 120),
    ]);

    const extremes = result.events.filter((e) => e.type === "FIFTY_TWO_WEEK_EXTREME");
    expect(extremes).toHaveLength(1);
    expect(extremes[0].detail.price).toBe(120); // the latest, not the first
  });

  it("keeps a break in the opposite direction — that is a different fact", () => {
    const result = diff(makeState(), makeStats(), makeBaseline(), [
      extreme("HIGH", 30),
      extreme("LOW", 10, 80),
    ]);

    expect(result.events.filter((e) => e.type === "FIFTY_TWO_WEEK_EXTREME")).toHaveLength(2);
  });

  it("never collapses separate news items into one", () => {
    // Two headlines are two things the user needs to read; de-duplicating by type here
    // would silently swallow the second.
    const news = (headline: string, minutesAgo: number): DiscreteEventInput => ({
      eventType: "NEWS",
      severity: "NOTABLE",
      eventTime: new Date(NOW - minutesAgo * 60 * 1000),
      payload: { headline },
    });

    const result = diff(makeState(), makeStats(), makeBaseline(), [
      news("Earnings beat", 30),
      news("CEO steps down", 10),
    ]);

    expect(result.events.filter((e) => e.type === "NEWS")).toHaveLength(2);
  });
});

describe("ranking, capping and overall severity", () => {
  function news(minutesAgo: number, severity: DiscreteEventInput["severity"]): DiscreteEventInput {
    return {
      eventType: "NEWS",
      severity,
      eventTime: new Date(NOW - minutesAgo * 60 * 1000),
      payload: { headline: `headline ${minutesAgo}` },
    };
  }

  it("orders events by severity, then most recent first", () => {
    const result = diff(makeState(), makeStats(), makeBaseline(), [
      news(30, "MINOR"),
      news(20, "CRITICAL"),
      news(10, "NOTABLE"),
      news(5, "CRITICAL"),
    ]);

    expect(result.events.map((e) => e.severity)).toEqual(["CRITICAL", "CRITICAL", "NOTABLE", "MINOR"]);
    // Within equal severity, the newer of the two criticals comes first.
    expect(result.events[0].detail.headline).toBe("headline 5");
  });

  it("caps the surfaced events but still reports the true total", () => {
    // Alert fatigue is the failure mode: show at most five, but do not pretend the
    // rest do not exist.
    const many = Array.from({ length: 8 }, (_, i) => news(i + 1, "NOTABLE"));

    const result = diff(makeState(), makeStats(), makeBaseline(), many);

    expect(result.events).toHaveLength(5);
    expect(result.eventCount).toBe(8);
    expect(result.overflow).toBe(true);
  });

  it("does not flag overflow at exactly the cap", () => {
    const result = diff(
      makeState(),
      makeStats(),
      makeBaseline(),
      Array.from({ length: 5 }, (_, i) => news(i + 1, "MINOR"))
    );

    expect(result.events).toHaveLength(5);
    expect(result.overflow).toBe(false);
  });

  it("reports the highest severity present as the symbol's overall severity", () => {
    const result = diff(makeState(), makeStats(), makeBaseline(), [news(30, "MINOR"), news(10, "CRITICAL")]);

    expect(result.maxSeverity).toBe("CRITICAL");
  });

  it("reports NONE for a symbol with nothing worth surfacing", () => {
    const result = diff();

    expect(result.maxSeverity).toBe("NONE");
    expect(result.events).toHaveLength(0);
    expect(result.overflow).toBe(false);
  });
});

describe("rankEntries", () => {
  it("puts the most severe symbols first, breaking ties on event count", () => {
    const entries = [
      { symbol: "QUIET", maxSeverity: "NONE" as const, eventCount: 0 },
      { symbol: "BUSY", maxSeverity: "NOTABLE" as const, eventCount: 4 },
      { symbol: "URGENT", maxSeverity: "CRITICAL" as const, eventCount: 1 },
      { symbol: "MILD", maxSeverity: "NOTABLE" as const, eventCount: 1 },
    ];

    expect(rankEntries(entries).map((e) => e.symbol)).toEqual(["URGENT", "BUSY", "MILD", "QUIET"]);
  });

  it("does not mutate the caller's array", () => {
    const entries = [
      { maxSeverity: "NONE" as const, eventCount: 0 },
      { maxSeverity: "CRITICAL" as const, eventCount: 1 },
    ];
    const original = [...entries];

    rankEntries(entries);

    expect(entries).toEqual(original);
  });
});

describe("PRICE_MOVE scales with how long the user was away", () => {
  // The product promise is "ranked by how meaningful it actually is". Judging a return
  // accumulated over days against a one-day stdev broke exactly that: the same drift got
  // louder the longer someone stayed away. These cases pin the corrected behaviour.
  const DAY = 24 * HOUR;

  function priceMove(price: number, lastSeenAt: Date) {
    return diff(makeState({ price }), makeStats(), makeBaseline({ lastSeenAt })).events.find(
      (e) => e.type === "PRICE_MOVE",
    );
  }

  it("scores the same move lower when it took four sessions instead of an afternoon", () => {
    // +4% against a 1% daily stdev. Minutes later that is a z of 4 (CRITICAL); spread
    // over four sessions the bar doubles and it is a z of 2 (NOTABLE) — the same number
    // on screen, correctly reported as a less remarkable fact.
    const fresh = priceMove(104, new Date(NOW - 2 * HOUR));
    const stale = priceMove(104, new Date(NOW - 6 * DAY));

    expect(fresh?.severity).toBe("CRITICAL");
    expect(fresh?.detail.zScore).toBeCloseTo(4, 6);
    expect(stale?.severity).toBe("NOTABLE");
    expect(stale?.detail.zScore).toBeCloseTo(2, 6);
  });

  it("still flags a genuinely large multi-session move", () => {
    // Scaling must not become a mute button: +12% over four sessions is z = 6, still
    // comfortably CRITICAL.
    expect(priceMove(112, new Date(NOW - 6 * DAY))?.severity).toBe("CRITICAL");
  });

  it("leaves same-session scoring exactly where it was", () => {
    // Anything under one session is held at the floor, so the five-minute and two-hour
    // cases score identically to each other and to the pre-scaling behaviour.
    const fiveMinutes = priceMove(102, new Date(NOW - 5 * 60 * 1000));
    const twoHours = priceMove(102, new Date(NOW - 2 * HOUR));

    expect(fiveMinutes?.detail.zScore).toBeCloseTo(2, 6);
    expect(twoHours?.detail.zScore).toBeCloseTo(2, 6);
  });

  it("stops widening the bar past the clamp, so a long absence cannot mute everything", () => {
    // A year away and a month away score the same rather than the year silently
    // requiring a √250 move to register.
    const monthAway = priceMove(120, new Date(NOW - 40 * DAY));
    const yearAway = priceMove(120, new Date(NOW - 365 * DAY));

    expect(monthAway?.detail.zScore).toBeCloseTo(yearAway?.detail.zScore as number, 6);
    expect(yearAway?.severity).toBe("CRITICAL");
  });

  it("does not blow up on a symbol whose measured volatility is zero", () => {
    // Pre-fix this divided by zero: z = Infinity, CRITICAL on a 0.5% move, forever.
    const event = diff(
      makeState({ price: 100.5 }),
      makeStats({ stdevReturn20d: 0 }),
      makeBaseline(),
    ).events.find((e) => e.type === "PRICE_MOVE");

    expect(Number.isFinite(event?.detail.zScore as number)).toBe(true);
    expect(event?.detail.zScore).toBeCloseTo(5, 6); // 0.5% over the 0.1% floor
  });
});
