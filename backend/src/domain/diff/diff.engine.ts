import type {
  DiffEntry,
  DiffEvent,
  DiscreteEventInput,
  MarketStateSnapshot,
  SymbolStatsSnapshot,
  UserSymbolBaseline,
} from "./diff.types";
import {
  GAP_RATIO_THRESHOLDS,
  MAX_EVENTS_PER_SYMBOL,
  VOLUME_RATIO_THRESHOLDS,
  effectiveStdev,
  maxSeverity,
  severityFromRatio,
  severityFromZ,
  tradingSessionsBetween,
} from "./scoring";
import { explainDiscreteEvent, explainGapOpen, explainPriceMove, explainVolumeSpike } from "./explain";

// Pure function: no reads, no writes. GET /watchlist is read-only by design — this
// is the one place that guarantee needs to hold, so keep this function free of any
// Prisma/Redis calls. Callers (watchlist.service.ts) fetch everything up front.
export function computeSymbolDiff(
  state: MarketStateSnapshot,
  stats: SymbolStatsSnapshot,
  baseline: UserSymbolBaseline,
  discreteEvents: DiscreteEventInput[],
): Omit<DiffEntry, "symbol"> {
  const events: DiffEvent[] = [];
  const baselineAtMs = baseline.lastSeenAt.getTime();

  // PRICE_MOVE — z-score of return since last-seen vs the symbol's own volatility,
  // scaled to how long the user has actually been away. stdevReturn20d is a *daily*
  // figure; judging a three-day return against it made drift read as CRITICAL purely
  // because someone stopped by less often. sessionsElapsed/effectiveStdev live in
  // scoring.ts so the trace below renders the same numbers this decided on.
  if (baseline.lastSeenPrice > 0) {
    const returnSinceLastSeen = (state.price - baseline.lastSeenPrice) / baseline.lastSeenPrice;
    const sessionsElapsed = tradingSessionsBetween(baselineAtMs, state.updatedAt);
    const scaledStdev = effectiveStdev(stats.stdevReturn20d, sessionsElapsed);
    const zScore = returnSinceLastSeen / scaledStdev;
    const severity = severityFromZ(Math.abs(zScore));
    if (severity !== "NONE") {
      events.push({
        type: "PRICE_MOVE",
        severity,
        occurredAt: new Date(state.updatedAt).toISOString(),
        detail: {
          returnPct: returnSinceLastSeen * 100,
          zScore,
          direction: returnSinceLastSeen >= 0 ? "UP" : "DOWN",
          sessionsElapsed,
        },
        // Built here, from the same locals that just decided the severity above, rather
        // than recomputed later from the emitted detail — that is what stops the "why?"
        // panel from ever disagreeing with the badge it explains.
        explanation: explainPriceMove({
          state,
          stats,
          baseline,
          returnSinceLastSeen,
          sessionsElapsed,
          scaledStdev,
          zScore,
          severity,
        }),
      });
    }
  }

  // VOLUME_SPIKE — current session volume vs 20d average prorated to time-of-day.
  // sessionElapsedFraction is computed once by market-state-writer.ts at write time
  // (mode-aware: replay's compressed clock vs live's real NSE session length), not
  // re-derived here, so the diff engine never needs to know which mode is active.
  const expectedByNow = stats.avgVolume20d * state.sessionElapsedFraction;
  const volumeRatio = state.volume / Math.max(expectedByNow, 1);
  const volSeverity = severityFromRatio(volumeRatio, VOLUME_RATIO_THRESHOLDS);
  if (volSeverity !== "NONE" && state.volume > baseline.lastSeenVolume) {
    events.push({
      type: "VOLUME_SPIKE",
      severity: volSeverity,
      occurredAt: new Date(state.updatedAt).toISOString(),
      detail: { volumeRatio, currentVolume: state.volume },
      explanation: explainVolumeSpike({ state, stats, baseline, expectedByNow, volumeRatio, severity: volSeverity }),
    });
  }

  // GAP_OPEN — only if a new session boundary occurred since last-seen.
  if (state.sessionOpenedAt > baselineAtMs && state.prevClose > 0) {
    const gapPct = (state.dayOpen - state.prevClose) / state.prevClose;
    const gapRatio = Math.abs(gapPct) / stats.avgOvernightGapPct;
    const gapSeverity = severityFromRatio(gapRatio, GAP_RATIO_THRESHOLDS);
    if (gapSeverity !== "NONE") {
      events.push({
        type: "GAP_OPEN",
        severity: gapSeverity,
        occurredAt: new Date(state.sessionOpenedAt).toISOString(),
        detail: { gapPct: gapPct * 100 },
        explanation: explainGapOpen({ state, stats, baseline, gapPct, gapRatio, severity: gapSeverity }),
      });
    }
  }

  // Discrete events (FIFTY_TWO_WEEK_EXTREME / NEWS / RATING_CHANGE / CORPORATE_ACTION)
  // — caller has already filtered these to eventTime > baseline.lastSeenAt.
  for (const e of collapseRedundantEvents(discreteEvents)) {
    events.push({
      type: e.eventType,
      severity: e.severity,
      occurredAt: e.eventTime.toISOString(),
      detail: e.payload,
      explanation: explainDiscreteEvent({
        eventType: e.eventType,
        severity: e.severity,
        eventTime: e.eventTime,
        payload: e.payload,
        state,
        stats,
        baseline,
      }),
    });
  }

  events.sort(
    (a, b) =>
      SEVERITY_RANK(b.severity) - SEVERITY_RANK(a.severity) ||
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  const capped = events.slice(0, MAX_EVENTS_PER_SYMBOL);
  const overallMax = capped.reduce<DiffEvent["severity"]>((m, e) => maxSeverity(m, e.severity), "NONE");

  return {
    maxSeverity: overallMax,
    eventCount: events.length,
    overflow: events.length > MAX_EVENTS_PER_SYMBOL,
    events: capped,
  };
}

function SEVERITY_RANK(s: DiffEvent["severity"]): number {
  return { NONE: 0, MINOR: 1, NOTABLE: 2, CRITICAL: 3 }[s];
}

// "Made a new 52-week high" five times in a row is one fact, not five, so only the most
// recent per direction survives. News, ratings and corporate actions are left alone —
// two different headlines are two different things the user needs to see, and collapsing
// by type would silently swallow the second one.
//
// This is a backstop for duplicates already recorded; the write-side cooldown in
// market-state-writer.ts is what stops them being generated in the first place.
function collapseRedundantEvents(events: DiscreteEventInput[]): DiscreteEventInput[] {
  const seenExtremeDirections = new Set<string>();
  const kept: DiscreteEventInput[] = [];

  for (const e of [...events].sort((a, b) => b.eventTime.getTime() - a.eventTime.getTime())) {
    if (e.eventType === "FIFTY_TWO_WEEK_EXTREME") {
      const direction = String((e.payload as { direction?: string })?.direction ?? "UNKNOWN");
      if (seenExtremeDirections.has(direction)) continue;
      seenExtremeDirections.add(direction);
    }
    kept.push(e);
  }

  return kept;
}

export function rankEntries<T extends { maxSeverity: DiffEvent["severity"]; eventCount: number }>(entries: T[]): T[] {
  return [...entries].sort(
    (a, b) => SEVERITY_RANK(b.maxSeverity) - SEVERITY_RANK(a.maxSeverity) || b.eventCount - a.eventCount,
  );
}
