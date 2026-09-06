import type { EventType, Severity } from "../types";

// One source of truth for how an event type and a severity are labelled and coloured.
// EventBadge, ExplainDrawer and the activity feed all used to carry their own copies of
// these maps; they drifted (one said "52w extreme", another "52-week extreme").

interface EventMeta {
  label: string;
  short: string;
  /** A single glyph — cheap, dependency-free, readable at 12px. */
  glyph: string;
}

export const EVENT_META: Record<EventType, EventMeta> = {
  PRICE_MOVE: { label: "Price move", short: "Price", glyph: "△" },
  VOLUME_SPIKE: { label: "Volume spike", short: "Volume", glyph: "▮" },
  GAP_OPEN: { label: "Gap open", short: "Gap", glyph: "⇅" },
  FIFTY_TWO_WEEK_EXTREME: { label: "52-week extreme", short: "52wk", glyph: "◆" },
  NEWS: { label: "News", short: "News", glyph: "✎" },
  RATING_CHANGE: { label: "Rating change", short: "Rating", glyph: "★" },
  CORPORATE_ACTION: { label: "Corporate action", short: "Corp", glyph: "§" },
};

export function eventLabel(type: EventType): string {
  return EVENT_META[type]?.label ?? type;
}

interface SeverityMeta {
  label: string;
  rank: number;
  dot: string;
  text: string;
  chip: string;
  border: string;
}

export const SEVERITY_META: Record<Severity, SeverityMeta> = {
  CRITICAL: {
    label: "Critical",
    rank: 3,
    dot: "bg-severity-critical",
    text: "text-severity-critical",
    chip: "bg-severity-critical/15 text-severity-critical",
    border: "border-l-severity-critical",
  },
  NOTABLE: {
    label: "Notable",
    rank: 2,
    dot: "bg-severity-notable",
    text: "text-severity-notable",
    chip: "bg-severity-notable/15 text-severity-notable",
    border: "border-l-severity-notable",
  },
  MINOR: {
    label: "Minor",
    rank: 1,
    dot: "bg-severity-minor",
    text: "text-severity-minor",
    chip: "bg-severity-minor/15 text-severity-minor",
    border: "border-l-severity-minor",
  },
  NONE: {
    label: "Quiet",
    rank: 0,
    dot: "bg-severity-none",
    text: "text-gray-500",
    chip: "bg-hairline text-gray-400",
    border: "border-l-transparent",
  },
};

export function severityRank(severity: Severity): number {
  return SEVERITY_META[severity]?.rank ?? 0;
}
