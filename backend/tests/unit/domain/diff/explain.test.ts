import { describe, expect, it } from "vitest";
import { computeSymbolDiff } from "../../../../src/domain/diff/diff.engine";
import { GAP_RATIO_THRESHOLDS, VOLUME_RATIO_THRESHOLDS, Z_THRESHOLDS } from "../../../../src/domain/diff/scoring";
import { ADMIN_DEMO_SOURCE } from "../../../../src/domain/diff/explain";
import type {
  DiscreteEventInput,
  MarketStateSnapshot,
  SymbolStatsSnapshot,
  UserSymbolBaseline,
} from "../../../../src/domain/diff/diff.types";

// The explanation trace is the one part of the app where being wrong is invisible: a bad
// number in a "why?" panel looks exactly as authoritative as a good one, and the reader
// opened the panel precisely because they couldn't check the claim themselves. So the
// property under test throughout is agreement — the trace must say what the engine did.

const NOW = Date.UTC(2026, 0, 15, 6, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeState(overrides: Partial<MarketStateSnapshot> = {}): MarketStateSnapshot {
  return {
    price: 100,
    volume: 0,
    dayOpen: 100,
    prevClose: 100,
    sessionOpenedAt: NOW - 4 * HOUR,
    sessionElapsedFraction: 0.5,
    updatedAt: NOW,
    source: "TWELVE_DATA",
    mode: "LIVE",
    isStale: false,
    isDivergent: false,
    divergencePct: null,
    ...overrides,
  };
}

function makeStats(overrides: Partial<SymbolStatsSnapshot> = {}): SymbolStatsSnapshot {
  return {
    avgVolume20d: 1_000_000,
    stdevReturn20d: 0.01,
    avgOvernightGapPct: 0.005,
    computedAt: new Date(NOW - HOUR),
    historyDays: 90,
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<UserSymbolBaseline> = {}): UserSymbolBaseline {
  return { lastSeenAt: new Date(NOW - 2 * HOUR), lastSeenPrice: 100, lastSeenVolume: 0, ...overrides };
}

function diff(state = makeState(), stats = makeStats(), baseline = makeBaseline(), events: DiscreteEventInput[] = []) {
  return computeSymbolDiff(state, stats, baseline, events);
}

const SEVERITY_RANK: Record<string, number> = { MINOR: 1, NOTABLE: 2, CRITICAL: 3 };

describe("trace agrees with the decision", () => {
  // The invariant that makes the whole panel trustworthy. If the thresholds shown as
  // passing don't imply the severity that was emitted, the panel is explaining a
  // different decision from the one the user is looking at.
  it("emits the highest severity band the trace shows as passing", () => {
    const cases: Array<[string, ReturnType<typeof diff>]> = [
      ["price move", diff(makeState({ price: 104 }))],
      ["volume spike", diff(makeState({ volume: 3_000_000 }))],
      [
        "gap open",
        diff(makeState({ dayOpen: 103, prevClose: 100, sessionOpenedAt: NOW - HOUR }), makeStats(), makeBaseline()),
      ],
    ];

    for (const [label, result] of cases) {
      for (const event of result.events) {
        const passing = event.explanation.thresholds.filter((t) => t.met);
        expect(passing.length, `${label}: ${event.type} passed no band but was emitted`).toBeGreaterThan(0);

        const highest = passing.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0].severity;
        expect(highest, `${label}: ${event.type} trace/severity mismatch`).toBe(event.severity);
      }
    }
  });

  it("renders the same threshold numbers the scorer actually uses", () => {
    // Guards the refactor that made scoring.ts the single source of these values. If
    // someone re-inlines a literal in diff.engine.ts, the panel starts quoting a bound
    // that no longer decides anything, and nothing else would catch it.
    const priceMove = diff(makeState({ price: 104 })).events.find((e) => e.type === "PRICE_MOVE");
    expect(priceMove?.explanation.thresholds.map((t) => t.test)).toEqual([
      `|z| >= ${Z_THRESHOLDS.critical}`,
      `|z| >= ${Z_THRESHOLDS.notable}`,
      `|z| >= ${Z_THRESHOLDS.minor}`,
    ]);

    const volume = diff(makeState({ volume: 3_000_000 })).events.find((e) => e.type === "VOLUME_SPIKE");
    expect(volume?.explanation.thresholds.map((t) => t.test)).toEqual([
      `ratio >= ${VOLUME_RATIO_THRESHOLDS.critical}`,
      `ratio >= ${VOLUME_RATIO_THRESHOLDS.notable}`,
      `ratio >= ${VOLUME_RATIO_THRESHOLDS.minor}`,
    ]);

    const gap = diff(makeState({ dayOpen: 103, prevClose: 100, sessionOpenedAt: NOW - HOUR })).events.find(
      (e) => e.type === "GAP_OPEN",
    );
    expect(gap?.explanation.thresholds.map((t) => t.test)).toEqual([
      `ratio >= ${GAP_RATIO_THRESHOLDS.critical}`,
      `ratio >= ${GAP_RATIO_THRESHOLDS.notable}`,
      `ratio >= ${GAP_RATIO_THRESHOLDS.minor}`,
    ]);
  });

  it("shows every band tested, not only the ones that passed", () => {
    // A MINOR move should still show CRITICAL as tested-and-missed: "how close was this
    // to being urgent?" is the question a severity label alone can't answer.
    const event = diff(makeState({ price: 101 })).events.find((e) => e.type === "PRICE_MOVE");
    expect(event?.severity).toBe("MINOR");
    expect(event?.explanation.thresholds).toHaveLength(3);
    expect(event?.explanation.thresholds.filter((t) => t.met).map((t) => t.severity)).toEqual(["MINOR"]);
  });
});

describe("provenance", () => {
  it("carries the source, the baseline and the age of the stats it scored against", () => {
    const statsComputedAt = new Date(NOW - 3 * HOUR);
    const event = diff(
      makeState({ price: 104, source: "YAHOO", mode: "LIVE" }),
      makeStats({ computedAt: statsComputedAt, historyDays: 42 }),
      makeBaseline({ lastSeenAt: new Date(NOW - 5 * HOUR), lastSeenPrice: 100 }),
    ).events[0];

    expect(event.explanation.provenance).toMatchObject({
      source: "YAHOO",
      mode: "LIVE",
      observedAt: new Date(NOW).toISOString(),
      baselineAt: new Date(NOW - 5 * HOUR).toISOString(),
      statsComputedAt: statsComputedAt.toISOString(),
      statsHistoryDays: 42,
    });
  });

  it("reports unknown rather than inventing a figure when stats provenance is absent", () => {
    // SymbolStatsSnapshot's provenance fields are optional so older callers still compile.
    // The panel has to degrade to "unknown" rather than implying the baseline is current.
    const stats = { avgVolume20d: 1_000_000, stdevReturn20d: 0.01, avgOvernightGapPct: 0.005 };
    const event = diff(makeState({ price: 104 }), stats).events[0];

    expect(event.explanation.provenance.statsComputedAt).toBeNull();
    expect(event.explanation.provenance.statsHistoryDays).toBeNull();
  });
});

describe("caveats are conditional on the data, not boilerplate", () => {
  it("stays quiet about staleness and divergence on a clean live quote", () => {
    const event = diff(makeState({ price: 104 })).events[0];
    const text = event.explanation.caveats.join(" ");

    expect(text).not.toMatch(/stale/i);
    expect(text).not.toMatch(/disagreed/i);
    expect(text).not.toMatch(/synthetic/i);
  });

  it("warns that the comparison is against a stale price when the quote is stale", () => {
    const event = diff(makeState({ price: 104, isStale: true })).events[0];
    expect(event.explanation.caveats.join(" ")).toMatch(/stale/i);
  });

  it("surfaces source disagreement with the actual gap between them", () => {
    const event = diff(makeState({ price: 104, isDivergent: true, divergencePct: 2.4 })).events[0];
    expect(event.explanation.caveats.join(" ")).toMatch(/2\.40%/);
  });

  it("says the quote is synthetic in replay mode", () => {
    const event = diff(makeState({ price: 104, mode: "REPLAY", source: "REPLAY" })).events[0];
    expect(event.explanation.caveats.join(" ")).toMatch(/synthetic/i);
  });

  it("always discloses that PRICE_MOVE is scaled by how long you were away", () => {
    // The scaling is the thing that most changes how a reader should weigh the number,
    // so it belongs on the event itself, not only in the README.
    const event = diff(makeState({ price: 104 })).events[0];
    expect(event.explanation.caveats.join(" ")).toMatch(/grows with √time/i);
  });

  it("says so when the one-session floor, not √time, decided the scaling", () => {
    // Under a session √time would shrink the bar and turn every wiggle CRITICAL. The
    // floor is what stops that, and a reader deserves to know the floor is what ran.
    const event = diff(makeState({ price: 104 }), makeStats(), makeBaseline({ lastSeenAt: new Date(NOW - HOUR) }))
      .events[0];
    expect(event.explanation.caveats.join(" ")).toMatch(/never shrinks below one session/i);
  });

  it("says so when a floored volatility estimate, not the measured one, was used", () => {
    // A degenerate stdev would otherwise divide the move by almost nothing and pin
    // every tick at CRITICAL without ever saying why.
    const event = diff(makeState({ price: 104 }), makeStats({ stdevReturn20d: 0.00001 })).events[0];
    expect(event.explanation.caveats.join(" ")).toMatch(/below the .* floor/i);
  });
});

describe("discrete events", () => {
  const newsEvent: DiscreteEventInput = {
    eventType: "NEWS",
    severity: "NOTABLE",
    eventTime: new Date(NOW - HOUR),
    payload: { headline: "Order win" },
  };

  it("explains selection by timestamp rather than pretending to have scored it", () => {
    const event = diff(makeState(), makeStats(), makeBaseline(), [newsEvent]).events[0];

    expect(event.explanation.thresholds).toEqual([]);
    expect(event.explanation.summary).toMatch(/after your last-seen snapshot/);
    expect(event.explanation.caveats.join(" ")).toMatch(/classified when it was recorded/i);
  });

  // Provenance is disclosed from what was actually recorded, never asserted for the
  // category. Blanket-labelling every news/rating/corporate-action event demo-triggered
  // was true when only the control panel could raise them; now that a real feed can, the
  // same blanket claim would describe a genuine dividend as a fabrication.
  it("names the feed when a real one recorded the event", () => {
    const event = diff(makeState(), makeStats(), makeBaseline(), [{ ...newsEvent, source: "GDELT" }]).events[0];

    const caveats = event.explanation.caveats.join(" ");
    expect(caveats).toMatch(/live feed \(GDELT\)/i);
    expect(caveats).not.toMatch(/demonstration/i);
  });

  it("discloses a control-panel trigger as not being a real headline", () => {
    const event = diff(makeState(), makeStats(), makeBaseline(), [{ ...newsEvent, source: ADMIN_DEMO_SOURCE }])
      .events[0];

    expect(event.explanation.caveats.join(" ")).toMatch(/admin control panel for demonstration/i);
  });

  it("admits ignorance for an event recorded before provenance was tracked", () => {
    // The honest answer for a legacy row is "unknown", not a guess in either direction.
    const event = diff(makeState(), makeStats(), makeBaseline(), [newsEvent]).events[0];

    const caveats = event.explanation.caveats.join(" ");
    expect(caveats).toMatch(/predates provenance tracking/i);
    expect(caveats).not.toMatch(/live feed/i);
  });

  const extremeEvent: DiscreteEventInput = {
    eventType: "FIFTY_TWO_WEEK_EXTREME",
    severity: "CRITICAL",
    eventTime: new Date(NOW - HOUR),
    payload: { direction: "HIGH" },
  };

  it("says the extreme came from a full rolling 52-week window when it did", () => {
    const event = diff(makeState(), makeStats({ historyDays: 248 }), makeBaseline(), [extremeEvent]).events[0];
    const caveats = event.explanation.caveats.join(" ");

    expect(caveats).toMatch(/rolling 52-week window/);
    expect(caveats).toMatch(/248 daily bars/);
    // The property that distinguishes a real 52-week high from the high-water mark this
    // replaced: old extremes leave the window, so the figure can go down.
    expect(caveats).toMatch(/can fall as well as rise/);
  });

  it("discloses a window that is genuinely shorter than 52 weeks rather than calling it one", () => {
    // A recently-added symbol, or one the provider only partly served. The number is the
    // symbol's real depth, and the caveat says outright that it is not a full 52 weeks.
    const event = diff(makeState(), makeStats({ historyDays: 90 }), makeBaseline(), [extremeEvent]).events[0];
    const caveats = event.explanation.caveats.join(" ");

    expect(caveats).toMatch(/only 90 daily bars/);
    expect(caveats).toMatch(/rather than a true 52 weeks/);
  });

  it("puts the recorded payload into the inputs so the raw record is visible", () => {
    const event = diff(makeState(), makeStats(), makeBaseline(), [newsEvent]).events[0];
    expect(event.explanation.inputs.find((i) => i.label === "headline")?.value).toBe("Order win");
  });
});

describe("arithmetic shown matches arithmetic done", () => {
  it("shows the return, the scaled volatility and the z-score that produced the severity", () => {
    // price 104 against a 100 baseline with 1% typical daily move = +4%. The baseline is
    // two hours old, so the one-session floor holds the bar at 1% and z stays 4.
    const event = diff(makeState({ price: 104 })).events.find((e) => e.type === "PRICE_MOVE");

    expect(event?.detail.zScore).toBeCloseTo(4, 6);
    expect(event?.explanation.steps[0].value).toBe("+4.00%");
    expect(event?.explanation.steps[1].value).toBe("+1.00%"); // 1% × √1
    expect(event?.explanation.steps[2].value).toBe("4.00");
    expect(event?.severity).toBe("CRITICAL");
  });

  it("shows the widened bar, not the raw daily stdev, once several sessions have passed", () => {
    // Same +4% move, but accumulated over exactly four sessions (Friday 11:30 IST to
    // Thursday 11:30 IST, weekend excluded): the bar doubles, so the arithmetic on
    // screen has to show 2.00%, not 1.00%.
    const event = diff(
      makeState({ price: 104 }),
      makeStats(),
      makeBaseline({ lastSeenAt: new Date(NOW - 6 * DAY) }),
    ).events.find((e) => e.type === "PRICE_MOVE");

    expect(event?.detail.sessionsElapsed).toBeCloseTo(4, 6);
    expect(event?.explanation.steps[1].value).toBe("+2.00%");
    expect(event?.explanation.steps[2].value).toBe("2.00");
  });

  it("shows expected volume as the prorated figure the ratio was divided by", () => {
    // 1M average, half the session elapsed = 500k expected; 1.5M traded = 3x.
    const event = diff(makeState({ volume: 1_500_000 })).events.find((e) => e.type === "VOLUME_SPIKE");

    expect(event?.detail.volumeRatio).toBeCloseTo(3, 6);
    expect(event?.explanation.steps[1].value).toBe("3.00x");
    expect(event?.severity).toBe("CRITICAL");
  });
});
