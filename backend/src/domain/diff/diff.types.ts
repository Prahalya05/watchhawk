export type Severity = "MINOR" | "NOTABLE" | "CRITICAL" | "NONE";

export interface DiffEvent {
  type:
    | "PRICE_MOVE"
    | "VOLUME_SPIKE"
    | "FIFTY_TWO_WEEK_EXTREME"
    | "GAP_OPEN"
    | "NEWS"
    | "RATING_CHANGE"
    | "CORPORATE_ACTION";
  severity: Severity;
  occurredAt: string;
  detail: Record<string, unknown>;
  explanation: EventExplanation;
}

// Everything needed to answer "why am I being shown this, and how much should I trust
// it?" without the caller having to re-derive anything. Built by the same pass that
// decides the severity (see explain.ts) so the trace can never drift from the decision.
export interface EventExplanation {
  rule: string; // human-readable name of the rule that fired
  ruleSource: string; // repo path of the code that implements it, for "show me"
  summary: string; // deterministic one-liner; never model-generated
  inputs: ExplanationInput[]; // the raw numbers that went in, and where each came from
  steps: ExplanationStep[]; // the arithmetic, shown rather than asserted
  thresholds: ExplanationThreshold[]; // every severity band tested, and which ones passed
  provenance: ExplanationProvenance; // how trustworthy the underlying data is
  caveats: string[]; // known limitations that actually apply to THIS event
}

export interface ExplanationInput {
  label: string;
  value: string;
  source: string;
}

export interface ExplanationStep {
  label: string;
  expression: string;
  value: string;
}

export interface ExplanationThreshold {
  severity: Exclude<Severity, "NONE">;
  test: string;
  met: boolean;
}

export interface ExplanationProvenance {
  source: string;
  mode: string;
  observedAt: string;
  isStale: boolean;
  isDivergent: boolean;
  divergencePct: number | null;
  baselineAt: string;
  statsComputedAt: string | null;
  statsHistoryDays: number | null;
}

export interface MarketStateSnapshot {
  price: number;
  volume: number;
  dayOpen: number;
  prevClose: number;
  sessionOpenedAt: number;
  sessionElapsedFraction: number;
  updatedAt: number;
  source: string;
  mode: string;
  isStale: boolean;
  isDivergent: boolean;
  divergencePct: number | null;
}

export interface UserSymbolBaseline {
  lastSeenAt: Date;
  lastSeenPrice: number;
  lastSeenVolume: number;
}

export interface SymbolStatsSnapshot {
  avgVolume20d: number;
  stdevReturn20d: number;
  avgOvernightGapPct: number;
  // Provenance for the derived stats themselves: how old the baseline is and how many
  // daily bars it was computed from. Optional so existing callers keep compiling; the
  // explanation renders "unknown" rather than inventing a figure when absent.
  computedAt?: Date;
  historyDays?: number;
}

export interface DiscreteEventInput {
  eventType: DiffEvent["type"];
  severity: Severity;
  eventTime: Date;
  payload: Record<string, unknown>;
  /**
   * Which feed recorded this, or `ADMIN_DEMO` for one triggered from the control panel.
   * Optional so older callers keep compiling; absent reads as "provenance not recorded",
   * which the explanation says outright rather than assuming either answer.
   */
  source?: string;
}

export interface DiffEntry {
  symbol: string;
  maxSeverity: Severity;
  eventCount: number;
  overflow: boolean;
  events: DiffEvent[];
}
