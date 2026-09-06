import type { WatchlistEntry } from "../types";
import type { LiveTick } from "../ws/useMarketSocket";
import { severityRank } from "./eventMeta";

export type FilterMode = "all" | "changed" | "critical";
export type SortKey = "severity" | "symbol" | "change" | "price";

export interface ViewState {
  search: string;
  filter: FilterMode;
  sort: SortKey;
}

export const DEFAULT_VIEW: ViewState = { search: "", filter: "all", sort: "severity" };

/** The change% actually on screen for a row — live tick if we have one, else the snapshot. */
export function effectiveChangePct(entry: WatchlistEntry, tick?: LiveTick): number {
  if (entry.unavailable) return 0;
  return tick?.changePct ?? entry.current.changePct;
}

function effectivePrice(entry: WatchlistEntry, tick?: LiveTick): number {
  if (entry.unavailable) return 0;
  return tick?.price ?? entry.current.price;
}

export function applyView(
  entries: WatchlistEntry[],
  ticks: Record<string, LiveTick>,
  view: ViewState,
): WatchlistEntry[] {
  const needle = view.search.trim().toUpperCase();

  const filtered = entries.filter((entry) => {
    if (needle && !entry.symbol.includes(needle) && !entry.name.toUpperCase().includes(needle)) {
      return false;
    }
    if (view.filter === "changed") return entry.events.length > 0;
    if (view.filter === "critical") return entry.maxSeverity === "CRITICAL";
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (view.sort) {
      case "symbol":
        return a.symbol.localeCompare(b.symbol);
      case "change":
        return Math.abs(effectiveChangePct(b, ticks[b.symbol])) - Math.abs(effectiveChangePct(a, ticks[a.symbol]));
      case "price":
        return effectivePrice(b, ticks[b.symbol]) - effectivePrice(a, ticks[a.symbol]);
      case "severity":
      default: {
        const bySeverity = severityRank(b.maxSeverity) - severityRank(a.maxSeverity);
        if (bySeverity !== 0) return bySeverity;
        return b.eventCount - a.eventCount;
      }
    }
  });

  return sorted;
}

export interface WatchlistSummary {
  total: number;
  changed: number;
  critical: number;
  notable: number;
  minor: number;
  stale: number;
  divergent: number;
  unavailable: number;
}

export function summarise(entries: WatchlistEntry[]): WatchlistSummary {
  const s: WatchlistSummary = {
    total: entries.length,
    changed: 0,
    critical: 0,
    notable: 0,
    minor: 0,
    stale: 0,
    divergent: 0,
    unavailable: 0,
  };
  for (const e of entries) {
    if (e.events.length > 0) s.changed++;
    if (e.maxSeverity === "CRITICAL") s.critical++;
    else if (e.maxSeverity === "NOTABLE") s.notable++;
    else if (e.maxSeverity === "MINOR") s.minor++;
    if (e.unavailable) s.unavailable++;
    else {
      if (e.current.isStale) s.stale++;
      if (e.current.isDivergent) s.divergent++;
    }
  }
  return s;
}
