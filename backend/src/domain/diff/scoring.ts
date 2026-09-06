import type { Severity } from "./diff.types";

export const SEVERITY_ORDER: Record<Severity, number> = { NONE: 0, MINOR: 1, NOTABLE: 2, CRITICAL: 3 };
export const MAX_EVENTS_PER_SYMBOL = 5;

// Starting thresholds, deliberately not final-tuned — env-configurable
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

// Feed-sourced discrete events are scored once, when they are ingested, from measurable
// properties of the item — never from a reading of what it says.
//
// DIVIDEND_YIELD_THRESHOLDS: a dividend matters to a returning user mainly because the
// price drops by roughly the dividend on the ex-date, so the yield against the current
// price is the size of the thing they are about to see and fail to explain.
export const DIVIDEND_YIELD_THRESHOLDS: SeverityThresholds = { critical: 0.03, notable: 0.01, minor: 0.002 };

// News is scored on *how much* is being published about a symbol inside
// NEWS_BURST_WINDOW_MS, never on what any of it says. Judging a headline's importance from
// its text is exactly the guess this codebase refuses to make elsewhere (see the command
// parser), and a confidently wrong CRITICAL on a misread headline is worse than an honest
// MINOR. Publication volume is real and countable; the "why?" panel says outright that it
// is the only signal used.
//
// The count is measured against the symbol's *own* normal, not an absolute bar — the same
// reason PRICE_MOVE is a z-score and VOLUME_SPIKE is a ratio. HDFCBANK draws several
// stories on a completely uneventful morning; a mid-cap drawing the same number is the
// story. An absolute threshold would have pinned every mega-cap at CRITICAL permanently,
// which is alert fatigue wearing a severity badge.
export const NEWS_BURST_RATIO_THRESHOLDS: SeverityThresholds = { critical: 3, notable: 2, minor: 1 };
export const NEWS_BURST_WINDOW_MS = 6 * 60 * 60 * 1000;
export const NEWS_BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Floor on the expected count, for the same reason MIN_STDEV_RETURN_20D floors volatility:
// a symbol that normally draws no coverage would otherwise divide by ~0 and rate its first
// headline in a week CRITICAL. With the floor, a quiet symbol needs three stories in six
// hours to reach CRITICAL, which is a genuine burst by any reading.
export const MIN_EXPECTED_NEWS_PER_WINDOW = 1;

// A split restates every share count and quoted price the user remembers, so it is always
// the loudest of these. Not a threshold ladder because there is nothing to measure
// against: a 2:1 and a 5:1 both invalidate the number the user last looked at.
export const SPLIT_SEVERITY: Severity = "CRITICAL";

// Rating changes are scored by how far the grade moved on the analyst ladder below, and
// in which direction. An initiation has no "from" to measure against.
export const RATING_LADDER = ["Sell", "Underperform", "Hold", "Outperform", "Buy"] as const;
export const RATING_STEP_THRESHOLDS: SeverityThresholds = { critical: 3, notable: 2, minor: 1 };

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
