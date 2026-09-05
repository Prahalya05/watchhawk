import type { Severity } from "./diff.types";

export const SEVERITY_ORDER: Record<Severity, number> = { NONE: 0, MINOR: 1, NOTABLE: 2, CRITICAL: 3 };
export const MAX_EVENTS_PER_SYMBOL = 5;

// Starting thresholds, deliberately not final-tuned (plan gap #8) — env-configurable
// would be the next step if these need adjusting live against real data behavior.
//
// Exported as data, not inlined as literals, because the explainability layer
// (diff/explain.ts) renders the exact comparison that decided a severity. If the numbers
// lived in two places, a threshold tweak would silently make every "why did I see this?"
// panel lie about the rule that actually ran.
export interface SeverityThresholds {
  critical: number;
  notable: number;
  minor: number;
}

export const Z_THRESHOLDS: SeverityThresholds = { critical: 3, notable: 1.5, minor: 0.75 };
export const VOLUME_RATIO_THRESHOLDS: SeverityThresholds = { critical: 3, notable: 2, minor: 1.5 };
export const GAP_RATIO_THRESHOLDS: SeverityThresholds = { critical: 3, notable: 2, minor: 1.25 };

export function severityFromZ(absZ: number): Severity {
  return severityFromRatio(absZ, Z_THRESHOLDS);
}

export function severityFromRatio(ratio: number, thresholds: SeverityThresholds): Severity {
  if (ratio >= thresholds.critical) return "CRITICAL";
  if (ratio >= thresholds.notable) return "NOTABLE";
  if (ratio >= thresholds.minor) return "MINOR";
  return "NONE";
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Time scaling for the PRICE_MOVE z-score.
//
// stdevReturn20d is a *daily* volatility estimate, but the gap between a user's
// last-seen baseline and now is unbounded. Dividing a three-day return by a
// one-day stdev makes ordinary drift look extraordinary, so the longer someone
// stayed away the louder the app got — the exact opposite of "ranked by how
// meaningful it actually is". Under a random walk, return variance grows with
// elapsed time, so the stdev the return is judged against scales with sqrt(t).
//
// Two deliberate clamps:
//   - Never scale *below* one session. Sub-daily returns really do have smaller
//     stdev, but microstructure noise means sqrt(t) badly under-estimates it at
//     short horizons; scaling down there would flag every intraday wiggle. One
//     session is the floor, which leaves short-gap behavior exactly as it was.
//   - Never scale beyond MAX_HORIZON_SESSIONS. Past the window the stats
//     themselves cover, sqrt(t) is extrapolation, and letting it grow without
//     bound would eventually mute genuinely large moves for a long-absent user.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_START_MIN = 9 * 60 + 15; // NSE regular session, 9:15 IST
const SESSION_END_MIN = 15 * 60 + 30; // 15:30 IST
const SESSION_MS = (SESSION_END_MIN - SESSION_START_MIN) * 60 * 1000;

/** Upper clamp on the horizon, matched to the 20-day window stdevReturn20d is computed over. */
export const MAX_HORIZON_SESSIONS = 20;

/**
 * Floor on the daily volatility estimate. A symbol whose 20 bars barely moved can
 * produce a near-zero (or zero) stdev, which turns the z-score into Infinity and
 * pins every tick at CRITICAL. 0.1% daily is far below any liquid NSE equity, so
 * this only ever engages on a degenerate estimate.
 */
export const MIN_STDEV_RETURN_20D = 0.001;

/**
 * Trading sessions elapsed between two instants, counting only the overlap with
 * NSE's 9:15–15:30 IST weekday session. Weekends contribute nothing: a Friday-close
 * baseline read on Monday morning is one session of accrued variance, not three
 * days of it. No holiday calendar (same acknowledged scope limit as
 * market-data/staleness.ts), so a holiday counts as a session it shouldn't.
 */
export function tradingSessionsBetween(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;

  // Bail out before looping over a months-old baseline: anything past the clamp
  // horizon scores identically anyway, so the exact count stops mattering.
  const maxScanMs = (MAX_HORIZON_SESSIONS * 2 + 7) * DAY_MS;
  if (toMs - fromMs > maxScanMs) return MAX_HORIZON_SESSIONS;

  let sessions = 0;
  for (let dayStart = istDayStartUtcMs(fromMs); dayStart <= toMs; dayStart += DAY_MS) {
    const weekday = new Date(dayStart + IST_OFFSET_MS).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    const sessionOpen = dayStart + SESSION_START_MIN * 60 * 1000;
    const overlap = Math.min(toMs, sessionOpen + SESSION_MS) - Math.max(fromMs, sessionOpen);
    if (overlap > 0) sessions += overlap / SESSION_MS;
  }
  return sessions;
}

/** sqrt-of-time multiplier applied to the daily stdev, clamped at both ends (see above). */
export function horizonScale(sessionsElapsed: number): number {
  const clamped = Math.min(Math.max(sessionsElapsed, 1), MAX_HORIZON_SESSIONS);
  return Math.sqrt(clamped);
}

/** The daily stdev actually used by the scorer: floored, then scaled to the horizon. */
export function effectiveStdev(stdevReturn20d: number, sessionsElapsed: number): number {
  const floored = Number.isFinite(stdevReturn20d)
    ? Math.max(stdevReturn20d, MIN_STDEV_RETURN_20D)
    : MIN_STDEV_RETURN_20D;
  return floored * horizonScale(sessionsElapsed);
}

// Start of the IST calendar day containing `ms`, expressed as a UTC epoch.
function istDayStartUtcMs(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}
