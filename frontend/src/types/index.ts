export type Severity = "MINOR" | "NOTABLE" | "CRITICAL" | "NONE";

export type EventType =
  "PRICE_MOVE" | "VOLUME_SPIKE" | "FIFTY_TWO_WEEK_EXTREME" | "GAP_OPEN" | "NEWS" | "RATING_CHANGE" | "CORPORATE_ACTION";

export type MarketStatus = "OPEN" | "CLOSED";
export type DataMode = "LIVE" | "REPLAY";
// "SEEDED" = a previous close read from cached history, not a live quote — always
// accompanied by isStale. "DIVERGENT" = the two live sources disagreed beyond threshold.
// "NONE" accompanies an `unavailable` row: there is no source, because nothing priced it.
export type SourceName = "TWELVE_DATA" | "YAHOO" | "REPLAY" | "SEEDED" | "DIVERGENT" | "NONE";

// Mirrors backend/src/modules/watchlist/watchlist.service.ts. DELISTED = the ticker left
// the tracked universe (renamed or delisted); NO_DATA = still tracked, nothing cached yet.
export type UnavailableReason = "DELISTED" | "NO_DATA";

export interface WatchlistUnavailable {
  reason: UnavailableReason;
  message: string;
}

export interface WatchlistItemDto {
  symbol: string;
  addedAt: string;
}

export interface DiffEvent {
  type: EventType;
  severity: Severity;
  occurredAt: string;
  detail: Record<string, unknown>;
  explanation: EventExplanation;
}

// Mirrors backend/src/modules/diff/diff.types.ts. Every event arrives with the full
// decision trace attached, so opening the "why?" panel needs no extra request — only
// the optional plain-English narration does.
export interface EventExplanation {
  rule: string;
  ruleSource: string;
  summary: string;
  inputs: Array<{ label: string; value: string; source: string }>;
  steps: Array<{ label: string; expression: string; value: string }>;
  thresholds: Array<{ severity: Exclude<Severity, "NONE">; test: string; met: boolean }>;
  provenance: {
    source: SourceName;
    mode: DataMode;
    observedAt: string;
    isStale: boolean;
    isDivergent: boolean;
    divergencePct: number | null;
    baselineAt: string;
    statsComputedAt: string | null;
    statsHistoryDays: number | null;
  };
  caveats: string[];
}

export type AssistantAction =
  | "ADD_SYMBOL"
  | "REMOVE_SYMBOL"
  | "ACK_SYMBOL"
  | "ACK_ALL"
  | "SHOW_WATCHLIST"
  | "EXPLAIN_SYMBOL"
  | "SEARCH_SYMBOLS"
  | "UNKNOWN";

export interface AssistantResult {
  intent: { action: AssistantAction; symbol?: string; symbols?: string[]; query?: string; reason?: string };
  interpretedBy: "RULES" | "GEMINI";
  status: "EXECUTED" | "NEEDS_CONFIRMATION" | "REJECTED";
  message: string;
  data?: unknown;
  llm: { enabled: boolean; used: boolean; reason?: string };
}

export interface AssistantStatus {
  available: boolean;
  model: string;
  examples: string[];
  budget: { minuteUsed: number; minuteLimit: number; dayUsed: number; dayLimit: number; exhausted: boolean } | null;
}

export interface ExplainResponse {
  symbol: string;
  eventType: EventType;
  severity: Severity;
  occurredAt: string;
  explanation: EventExplanation;
  narration: { text: string; generatedBy: "GEMINI" | "DETERMINISTIC"; reason?: string };
}

export interface WatchlistEntry {
  symbol: string;
  name: string;
  current: {
    price: number;
    changePct: number;
    volume: number;
    source: SourceName;
    mode: DataMode | "NONE";
    isStale: boolean;
    isDivergent: boolean;
    divergencePct: number | null;
  };
  // Non-null means `current` holds placeholders, not a quote. Render the reason instead
  // of the numbers — a confident ₹0.00 is worse than an honest "not tracked".
  unavailable: WatchlistUnavailable | null;
  maxSeverity: Severity;
  eventCount: number;
  overflow: boolean;
  events: DiffEvent[];
}

export interface WatchlistResponse {
  generatedAt: string;
  marketStatus: MarketStatus;
  entries: WatchlistEntry[];
}

export interface SymbolSearchResult {
  symbol: string;
  name: string;
  sector: string;
  volatilityTier: "LOW" | "MED" | "HIGH";
}

export interface AuthUser {
  id: string;
  email: string;
}
