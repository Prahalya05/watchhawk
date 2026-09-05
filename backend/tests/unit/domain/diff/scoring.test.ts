import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS_PER_SYMBOL,
  MAX_HORIZON_SESSIONS,
  MIN_STDEV_RETURN_20D,
  effectiveStdev,
  horizonScale,
  maxSeverity,
  severityFromRatio,
  severityFromZ,
  tradingSessionsBetween,
} from "../../../../src/domain/diff/scoring";

// These thresholds are the tuning surface of the whole product — they decide what counts
// as worth interrupting someone for. Pinning the exact boundaries here means a future
// adjustment has to be deliberate rather than accidental.

describe("severityFromZ", () => {
  it("treats each threshold as inclusive", () => {
    expect(severityFromZ(0.75)).toBe("MINOR");
    expect(severityFromZ(1.5)).toBe("NOTABLE");
    expect(severityFromZ(3)).toBe("CRITICAL");
  });

  it("stays one band lower just below each threshold", () => {
    expect(severityFromZ(0.749)).toBe("NONE");
    expect(severityFromZ(1.499)).toBe("MINOR");
    expect(severityFromZ(2.999)).toBe("NOTABLE");
  });

  it("says nothing about a stock sitting still", () => {
    expect(severityFromZ(0)).toBe("NONE");
  });

  it("has no band above CRITICAL, however extreme the move", () => {
    expect(severityFromZ(50)).toBe("CRITICAL");
    expect(severityFromZ(Number.MAX_SAFE_INTEGER)).toBe("CRITICAL");
  });

  // Callers pass Math.abs(z); this documents that the function itself expects that and
  // does not silently rate a large negative move as unremarkable.
  it("expects a pre-absolute-valued input", () => {
    expect(severityFromZ(Math.abs(-4))).toBe("CRITICAL");
  });
});

describe("severityFromRatio", () => {
  const volumeThresholds = { critical: 3, notable: 2, minor: 1.5 };

  it("bands a ratio against the supplied thresholds inclusively", () => {
    expect(severityFromRatio(1.49, volumeThresholds)).toBe("NONE");
    expect(severityFromRatio(1.5, volumeThresholds)).toBe("MINOR");
    expect(severityFromRatio(2, volumeThresholds)).toBe("NOTABLE");
    expect(severityFromRatio(3, volumeThresholds)).toBe("CRITICAL");
  });

  it("supports a different threshold set per event type", () => {
    // Gaps use a lower MINOR bar (1.25) than volume (1.5) — the same ratio is therefore
    // allowed to mean different things for different signals.
    const gapThresholds = { critical: 3, notable: 2, minor: 1.25 };

    expect(severityFromRatio(1.3, gapThresholds)).toBe("MINOR");
    expect(severityFromRatio(1.3, volumeThresholds)).toBe("NONE");
  });

  it("treats a zero ratio as nothing to report", () => {
    expect(severityFromRatio(0, volumeThresholds)).toBe("NONE");
  });
});

describe("maxSeverity", () => {
  it("returns the more severe of the two, in either argument order", () => {
    expect(maxSeverity("MINOR", "CRITICAL")).toBe("CRITICAL");
    expect(maxSeverity("CRITICAL", "MINOR")).toBe("CRITICAL");
    expect(maxSeverity("NONE", "MINOR")).toBe("MINOR");
    expect(maxSeverity("NOTABLE", "MINOR")).toBe("NOTABLE");
  });

  it("is stable when both sides are equal", () => {
    expect(maxSeverity("NOTABLE", "NOTABLE")).toBe("NOTABLE");
    expect(maxSeverity("NONE", "NONE")).toBe("NONE");
  });

  it("folds over a list to yield the highest severity present", () => {
    const severities = ["NONE", "MINOR", "NOTABLE", "MINOR"] as const;

    expect(severities.reduce<string>((acc, s) => maxSeverity(acc as never, s), "NONE")).toBe("NOTABLE");
  });
});

describe("MAX_EVENTS_PER_SYMBOL", () => {
  // The cap is the product's answer to alert fatigue; a silent bump to something large
  // would quietly undo that, so it is asserted rather than left implicit.
  it("keeps the per-symbol event cap small enough to stay scannable", () => {
    expect(MAX_EVENTS_PER_SYMBOL).toBe(5);
  });
});

describe("tradingSessionsBetween", () => {
  // NOW is Thursday 15 Jan 2026, 11:30 IST (mid-session).
  const THU_1130 = Date.UTC(2026, 0, 15, 6, 0, 0);
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it("counts only the overlap with the trading session, not wall-clock time", () => {
    // 09:30 IST to 11:30 IST is 120 of the session's 375 minutes.
    expect(tradingSessionsBetween(THU_1130 - 2 * HOUR, THU_1130)).toBeCloseTo(120 / 375, 6);
  });

  it("skips the weekend entirely", () => {
    // Friday 11:30 IST to Thursday 11:30 IST: 0.64 + Mon/Tue/Wed + 0.36 = 4 sessions,
    // not the 6 calendar days that separate them. This is the case that decides whether
    // a Monday-morning move is judged fairly after a Friday-evening visit.
    expect(tradingSessionsBetween(THU_1130 - 6 * DAY, THU_1130)).toBeCloseTo(4, 6);
  });

  it("counts overnight and pre-open time as nothing", () => {
    // 15:30 IST Wednesday to 09:15 IST Thursday is 17h45m of clock time and no trading.
    const wedClose = Date.UTC(2026, 0, 14, 10, 0, 0);
    const thuOpen = Date.UTC(2026, 0, 15, 3, 45, 0);
    expect(tradingSessionsBetween(wedClose, thuOpen)).toBeCloseTo(0, 6);
  });

  it("treats a reversed or zero-length interval as no elapsed time", () => {
    expect(tradingSessionsBetween(THU_1130, THU_1130)).toBe(0);
    expect(tradingSessionsBetween(THU_1130, THU_1130 - DAY)).toBe(0);
  });

  it("short-circuits a very old baseline to the clamp rather than looping over it", () => {
    // A year-old baseline scores the same as a MAX_HORIZON_SESSIONS-old one, so the
    // exact count stops mattering and walking 365 days would be pure waste.
    expect(tradingSessionsBetween(THU_1130 - 365 * DAY, THU_1130)).toBe(MAX_HORIZON_SESSIONS);
  });

  it("is not thrown by a non-finite timestamp", () => {
    expect(tradingSessionsBetween(NaN, THU_1130)).toBe(0);
    expect(tradingSessionsBetween(THU_1130 - DAY, Infinity)).toBe(0);
  });
});

describe("horizonScale", () => {
  // This is the fix for the app's most damaging silent behaviour: dividing a multi-day
  // return by a one-day stdev made ordinary drift score CRITICAL purely because the
  // user checked in less often.
  it("widens the bar with the square root of elapsed sessions", () => {
    expect(horizonScale(4)).toBeCloseTo(2, 6);
    expect(horizonScale(9)).toBeCloseTo(3, 6);
  });

  it("never shrinks below a single session", () => {
    // √time under-states short-horizon volatility, so scaling down here would flag
    // every intraday wiggle. Sub-session gaps keep the pre-fix behaviour exactly.
    expect(horizonScale(0)).toBe(1);
    expect(horizonScale(0.01)).toBe(1);
    expect(horizonScale(1)).toBe(1);
  });

  it("stops widening past the window the volatility estimate itself covers", () => {
    expect(horizonScale(MAX_HORIZON_SESSIONS)).toBeCloseTo(Math.sqrt(MAX_HORIZON_SESSIONS), 6);
    expect(horizonScale(500)).toBeCloseTo(Math.sqrt(MAX_HORIZON_SESSIONS), 6);
  });
});

describe("effectiveStdev", () => {
  it("floors a degenerate volatility estimate instead of dividing by nearly zero", () => {
    // Without the floor this is the one input that can make the z-score infinite and
    // pin a symbol at CRITICAL forever.
    expect(effectiveStdev(0, 1)).toBe(MIN_STDEV_RETURN_20D);
    expect(effectiveStdev(0.0000001, 1)).toBe(MIN_STDEV_RETURN_20D);
    expect(effectiveStdev(NaN, 1)).toBe(MIN_STDEV_RETURN_20D);
  });

  it("leaves a healthy estimate alone at a one-session horizon", () => {
    expect(effectiveStdev(0.02, 1)).toBeCloseTo(0.02, 9);
  });

  it("applies the floor first and the horizon scaling second", () => {
    expect(effectiveStdev(0, 4)).toBeCloseTo(MIN_STDEV_RETURN_20D * 2, 9);
  });
});
