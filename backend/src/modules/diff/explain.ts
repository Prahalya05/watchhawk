import type {
  EventExplanation,
  ExplanationProvenance,
  ExplanationThreshold,
  MarketStateSnapshot,
  Severity,
  SymbolStatsSnapshot,
  UserSymbolBaseline,
} from "./diff.types";
import {
  GAP_RATIO_THRESHOLDS,
  MAX_HORIZON_SESSIONS,
  MIN_STDEV_RETURN_20D,
  VOLUME_RATIO_THRESHOLDS,
  Z_THRESHOLDS,
  horizonScale,
  type SeverityThresholds,
} from "./scoring";

// Builds the "why did I see this?" trace for each event the diff engine emits.
//
// Two rules govern everything in this file:
//   1. Nothing here re-derives a decision. Every number is passed in from the pass that
//      actually decided the severity, so the trace cannot disagree with the outcome.
//   2. Nothing here is model-generated. An LLM may later narrate one of these objects
//      (see modules/assistant/explain.service.ts), but the numbers, the comparisons and
//      the caveats are all computed. The narration is a view of this, never a source.

const ENGINE = "backend/src/modules/diff/diff.engine.ts";
const SCORING = "backend/src/modules/diff/scoring.ts";

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const num = (n: number, digits = 2) => n.toFixed(digits);
const compact = (n: number) => {
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
};

// Renders every band that was tested, not just the one that won. Seeing that a move
// cleared MINOR and NOTABLE but missed CRITICAL by 0.2 is most of the value here — a
// bare "NOTABLE" label tells you the answer without telling you how close the call was.
function thresholdLadder(value: number, thresholds: SeverityThresholds, unit: string): ExplanationThreshold[] {
  return [
    { severity: "CRITICAL" as const, bound: thresholds.critical },
    { severity: "NOTABLE" as const, bound: thresholds.notable },
    { severity: "MINOR" as const, bound: thresholds.minor },
  ].map(({ severity, bound }) => ({
    severity,
    test: `${unit} >= ${bound}`,
    met: value >= bound,
  }));
}

function buildProvenance(
  state: MarketStateSnapshot,
  stats: SymbolStatsSnapshot,
  baseline: UserSymbolBaseline,
): ExplanationProvenance {
  return {
    source: state.source,
    mode: state.mode,
    observedAt: new Date(state.updatedAt).toISOString(),
    isStale: state.isStale,
    isDivergent: state.isDivergent,
    divergencePct: state.divergencePct,
    baselineAt: baseline.lastSeenAt.toISOString(),
    statsComputedAt: stats.computedAt ? stats.computedAt.toISOString() : null,
    statsHistoryDays: stats.historyDays ?? null,
  };
}

// Caveats that depend on the data rather than on the rule. These are the same honest
// scope notes the README carries, surfaced at the exact moment they'd change how much
// weight a reader should put on a specific number.
function dataCaveats(state: MarketStateSnapshot, stats: SymbolStatsSnapshot): string[] {
  const caveats: string[] = [];
  if (state.mode === "REPLAY") {
    caveats.push("This quote is synthetic (replay mode), not real market data.");
  }
  if (state.isStale) {
    caveats.push(
      `The underlying quote is stale — last updated ${new Date(state.updatedAt).toISOString()}, so this comparison may be against an old price.`,
    );
  }
  if (state.isDivergent && state.divergencePct !== null) {
    caveats.push(
      `The two live sources disagreed by ${num(Math.abs(state.divergencePct))}% on this symbol, so the price itself is uncertain.`,
    );
  }
  if (stats.historyDays !== undefined && stats.historyDays < 20) {
    caveats.push(
      `Baseline statistics come from only ${stats.historyDays} daily bars, which is thin for a 20-day average.`,
    );
  }
  return caveats;
}

export function explainPriceMove(args: {
  state: MarketStateSnapshot;
  stats: SymbolStatsSnapshot;
  baseline: UserSymbolBaseline;
  returnSinceLastSeen: number;
  sessionsElapsed: number;
  scaledStdev: number;
  zScore: number;
  severity: Severity;
}): EventExplanation {
  const { state, stats, baseline, returnSinceLastSeen, sessionsElapsed, scaledStdev, zScore, severity } = args;
  const absZ = Math.abs(zScore);
  const scale = horizonScale(sessionsElapsed);
  const clampedSessions = Math.min(Math.max(sessionsElapsed, 1), MAX_HORIZON_SESSIONS);

  return {
    rule: "Price move, scored against this symbol's own volatility over the time you were away",
    ruleSource: `${ENGINE} (thresholds: ${SCORING})`,
    summary:
      `Price moved ${pct(returnSinceLastSeen * 100)} since you last looked, ${num(sessionsElapsed, 1)} ` +
      `trading session${sessionsElapsed === 1 ? "" : "s"} ago. That is ${num(absZ, 2)}x this symbol's typical ` +
      `swing over that stretch of time, which clears the ${severity} threshold.`,
    inputs: [
      {
        label: "Price now",
        value: `₹${num(state.price)}`,
        source: `${state.source} quote observed ${new Date(state.updatedAt).toISOString()}`,
      },
      {
        label: "Price when you last looked",
        value: `₹${num(baseline.lastSeenPrice)}`,
        source: `your own snapshot, taken ${baseline.lastSeenAt.toISOString()}`,
      },
      {
        label: "Typical daily move (20d stdev of returns)",
        value: pct(stats.stdevReturn20d * 100),
        source: stats.computedAt
          ? `SymbolStats.stdevReturn20d, computed ${stats.computedAt.toISOString()} from ${stats.historyDays ?? "?"} daily bars`
          : "SymbolStats.stdevReturn20d",
      },
      {
        label: "Trading sessions since you last looked",
        value: num(sessionsElapsed, 2),
        source: "NSE 9:15–15:30 IST weekday session overlap, computed by scoring.ts",
      },
    ],
    steps: [
      {
        label: "Return since last seen",
        expression: `(${num(state.price)} − ${num(baseline.lastSeenPrice)}) ÷ ${num(baseline.lastSeenPrice)}`,
        value: pct(returnSinceLastSeen * 100),
      },
      // Its own step rather than folded into the z-score line, because this is the whole
      // reason the same move can score differently for two users: a return accumulated
      // over more sessions is measured against a proportionally wider bar.
      {
        label: "Volatility expected over that many sessions",
        expression: `${num(stats.stdevReturn20d * 100)}% × √${num(clampedSessions, 2)} (= ×${num(scale, 2)})`,
        value: pct(scaledStdev * 100),
      },
      {
        label: "z-score vs that scaled volatility",
        expression: `${num(returnSinceLastSeen * 100)}% ÷ ${num(scaledStdev * 100)}%`,
        value: num(zScore, 2),
      },
    ],
    thresholds: thresholdLadder(absZ, Z_THRESHOLDS, "|z|"),
    provenance: buildProvenance(state, stats, baseline),
    caveats: [
      // What the rule now does, and — just as importantly — where its own clamps bite.
      "The bar this move is judged against grows with √time, so a move spread over several sessions has to be proportionally larger to score the same as one that happened in a single afternoon.",
      ...horizonCaveats(sessionsElapsed, stats.stdevReturn20d),
      ...dataCaveats(state, stats),
    ],
  };
}

// The √time scaling is clamped at both ends and the stdev has a floor. Each of those
// only sometimes applies, and when one does it changed the score, so it is said out loud
// rather than left implicit in the code.
function horizonCaveats(sessionsElapsed: number, stdevReturn20d: number): string[] {
  const caveats: string[] = [];
  if (sessionsElapsed < 1) {
    caveats.push(
      "Less than a full trading session has passed, but the move is still measured against a full day of volatility — the scaling never shrinks below one session, because √time badly under-states how much prices jitter over minutes.",
    );
  }
  if (sessionsElapsed > MAX_HORIZON_SESSIONS) {
    caveats.push(
      `You last looked ${num(sessionsElapsed, 0)} sessions ago, but the scaling is capped at ${MAX_HORIZON_SESSIONS} — the window the volatility estimate itself covers. Past that this would be extrapolation, so the move is judged against a narrower bar than a strict √time model would use.`,
    );
  }
  if (!Number.isFinite(stdevReturn20d) || stdevReturn20d < MIN_STDEV_RETURN_20D) {
    caveats.push(
      `This symbol's measured volatility (${Number.isFinite(stdevReturn20d) ? pct(stdevReturn20d * 100) : "unavailable"}) was below the ${pct(MIN_STDEV_RETURN_20D * 100)} floor, so the floor was used instead. Without it a near-zero estimate would divide the move by almost nothing and rate everything CRITICAL.`,
    );
  }
  return caveats;
}

export function explainVolumeSpike(args: {
  state: MarketStateSnapshot;
  stats: SymbolStatsSnapshot;
  baseline: UserSymbolBaseline;
  expectedByNow: number;
  volumeRatio: number;
  severity: Severity;
}): EventExplanation {
  const { state, stats, baseline, expectedByNow, volumeRatio, severity } = args;

  return {
    rule: "Volume spike vs the volume expected by this point in the session",
    ruleSource: `${ENGINE} (thresholds: ${SCORING})`,
    summary:
      `${compact(state.volume)} shares have traded, against roughly ${compact(expectedByNow)} expected ` +
      `by this point in the session — ${num(volumeRatio, 1)}x normal, which clears the ${severity} threshold.`,
    inputs: [
      {
        label: "Volume so far today",
        value: compact(state.volume),
        source: `${state.source} quote observed ${new Date(state.updatedAt).toISOString()}`,
      },
      {
        label: "Average full-day volume (20d)",
        value: compact(stats.avgVolume20d),
        source: stats.computedAt
          ? `SymbolStats.avgVolume20d, computed ${stats.computedAt.toISOString()}`
          : "SymbolStats.avgVolume20d",
      },
      {
        label: "Session elapsed",
        value: `${num(state.sessionElapsedFraction * 100, 0)}%`,
        source: "computed at write time by ingestion/market-state-writer.ts (mode-aware)",
      },
    ],
    steps: [
      {
        label: "Volume expected by now",
        expression: `${compact(stats.avgVolume20d)} × ${num(state.sessionElapsedFraction, 2)}`,
        value: compact(expectedByNow),
      },
      {
        label: "Ratio vs expectation",
        expression: `${compact(state.volume)} ÷ ${compact(expectedByNow)}`,
        value: `${num(volumeRatio, 2)}x`,
      },
    ],
    thresholds: thresholdLadder(volumeRatio, VOLUME_RATIO_THRESHOLDS, "ratio"),
    provenance: buildProvenance(state, stats, baseline),
    caveats: [
      // Prorating a flat daily average across the session is the assumption most likely
      // to mislead: real volume is U-shaped, heavy at the open and close.
      "Expected volume is the 20-day average prorated linearly across the session. Real intraday volume is U-shaped, so this over-expects mid-session and under-expects near the open and close.",
      ...dataCaveats(state, stats),
    ],
  };
}

export function explainGapOpen(args: {
  state: MarketStateSnapshot;
  stats: SymbolStatsSnapshot;
  baseline: UserSymbolBaseline;
  gapPct: number;
  gapRatio: number;
  severity: Severity;
}): EventExplanation {
  const { state, stats, baseline, gapPct, gapRatio, severity } = args;

  return {
    rule: "Opening gap vs this symbol's typical overnight gap",
    ruleSource: `${ENGINE} (thresholds: ${SCORING})`,
    summary:
      `The session opened ${pct(gapPct * 100)} away from the previous close — ${num(gapRatio, 1)}x this ` +
      `symbol's typical overnight gap, which clears the ${severity} threshold.`,
    inputs: [
      { label: "Session open", value: `₹${num(state.dayOpen)}`, source: `${state.source} quote` },
      { label: "Previous close", value: `₹${num(state.prevClose)}`, source: `${state.source} quote` },
      {
        label: "Typical overnight gap",
        value: pct(stats.avgOvernightGapPct * 100),
        source: stats.computedAt
          ? `SymbolStats.avgOvernightGapPct, computed ${stats.computedAt.toISOString()}`
          : "SymbolStats.avgOvernightGapPct",
      },
    ],
    steps: [
      {
        label: "Gap size",
        expression: `(${num(state.dayOpen)} − ${num(state.prevClose)}) ÷ ${num(state.prevClose)}`,
        value: pct(gapPct * 100),
      },
      {
        label: "Ratio vs typical gap",
        expression: `${num(Math.abs(gapPct) * 100)}% ÷ ${num(stats.avgOvernightGapPct * 100)}%`,
        value: `${num(gapRatio, 2)}x`,
      },
    ],
    thresholds: thresholdLadder(gapRatio, GAP_RATIO_THRESHOLDS, "ratio"),
    provenance: buildProvenance(state, stats, baseline),
    caveats: [
      "This only fires when a session boundary fell after your last visit — a gap you have already seen is not re-reported.",
      ...dataCaveats(state, stats),
    ],
  };
}

// Discrete events aren't scored at read time: they were classified when they were
// recorded, and the diff engine's only job is deciding they are newer than your
// baseline. Saying so plainly matters more than dressing it up as a computation.
export function explainDiscreteEvent(args: {
  eventType: string;
  severity: Severity;
  eventTime: Date;
  payload: Record<string, unknown>;
  state: MarketStateSnapshot;
  stats: SymbolStatsSnapshot;
  baseline: UserSymbolBaseline;
}): EventExplanation {
  const { eventType, severity, eventTime, payload, state, stats, baseline } = args;
  const isExtreme = eventType === "FIFTY_TWO_WEEK_EXTREME";

  const caveats: string[] = [
    "This event was classified when it was recorded, not re-scored just now. You are seeing it because its timestamp is newer than your last-seen snapshot.",
  ];
  if (isExtreme) {
    caveats.push(
      `"52-week" is actually a ${stats.historyDays ?? 90}-day window — that is the depth of history the app holds, and it is labelled honestly rather than padded to 52 weeks.`,
    );
    caveats.push(
      "Repeat highs in the same direction are collapsed to the most recent one: making a new high five polls in a row is one fact, not five.",
    );
  } else {
    caveats.push(
      "News, rating and corporate-action events are demo-triggered through the admin control panel — there is no news provider behind them.",
    );
  }

  return {
    rule: isExtreme
      ? "52-week extreme recorded since your last visit"
      : `${eventType.replace(/_/g, " ").toLowerCase()} recorded since your last visit`,
    ruleSource: isExtreme
      ? "backend/src/ingestion/market-state-writer.ts (detection) + backend/src/modules/diff/diff.engine.ts (selection)"
      : "backend/src/modules/admin/admin.routes.ts (trigger) + backend/src/modules/diff/diff.engine.ts (selection)",
    summary: `Recorded ${eventTime.toISOString()}, which is after your last-seen snapshot (${baseline.lastSeenAt.toISOString()}), so it is new to you. Severity ${severity} was assigned when the event was written.`,
    inputs: [
      { label: "Event recorded at", value: eventTime.toISOString(), source: "SymbolEvent.eventTime (Postgres)" },
      {
        label: "Your last-seen snapshot",
        value: baseline.lastSeenAt.toISOString(),
        source: "UserSymbolState.lastSeenAt (Postgres), advanced only by POST /api/watchlist/ack",
      },
      ...Object.entries(payload).map(([key, value]) => ({
        label: key,
        value: typeof value === "object" ? JSON.stringify(value) : String(value),
        source: "SymbolEvent.payload, as recorded",
      })),
    ],
    steps: [
      {
        label: "Newer than your baseline?",
        expression: `${eventTime.toISOString()} > ${baseline.lastSeenAt.toISOString()}`,
        value: "true",
      },
    ],
    thresholds: [],
    provenance: buildProvenance(state, stats, baseline),
    caveats,
  };
}
