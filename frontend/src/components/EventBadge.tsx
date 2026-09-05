import type { DiffEvent } from "../types";
import SeverityIcon from "./SeverityIcon";

const LABELS: Record<DiffEvent["type"], string> = {
  PRICE_MOVE: "Price move",
  VOLUME_SPIKE: "Volume spike",
  FIFTY_TWO_WEEK_EXTREME: "52w extreme",
  GAP_OPEN: "Gap open",
  NEWS: "News",
  RATING_CHANGE: "Rating change",
  CORPORATE_ACTION: "Corporate action",
};

function describeDetail(event: DiffEvent): string {
  const d = event.detail as Record<string, number | string>;
  switch (event.type) {
    case "PRICE_MOVE":
      return `${(d.returnPct as number) >= 0 ? "+" : ""}${(d.returnPct as number).toFixed(2)}% (z=${(d.zScore as number).toFixed(1)})`;
    case "VOLUME_SPIKE":
      return `${(d.volumeRatio as number).toFixed(1)}x expected volume`;
    case "GAP_OPEN":
      return `${(d.gapPct as number) >= 0 ? "+" : ""}${(d.gapPct as number).toFixed(2)}% gap`;
    case "FIFTY_TWO_WEEK_EXTREME":
      return `New 52w ${d.direction === "LOW" ? "low" : "high"}`;
    case "NEWS":
      return (d.headline as string) ?? "New headline";
    case "RATING_CHANGE":
      return (d.summary as string) ?? "Analyst rating changed";
    case "CORPORATE_ACTION":
      return (d.summary as string) ?? "Corporate action announced";
    default:
      return "";
  }
}

// The badge is the click target for the explanation panel rather than a separate "?"
// icon: the thing you want explained is the thing you are looking at, and every badge is
// explainable, so a per-badge affordance would just be noise repeated five times a row.
export default function EventBadge({ event, onExplain }: { event: DiffEvent; onExplain?: () => void }) {
  const content = (
    <>
      <SeverityIcon severity={event.severity} />
      <span className="font-medium text-gray-200">{LABELS[event.type]}</span>
      <span className="text-gray-400">{describeDetail(event)}</span>
    </>
  );

  if (!onExplain) {
    return <div className="flex items-center gap-2 rounded-md bg-gray-900 px-2 py-1 text-xs">{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onExplain}
      title={`Why is this flagged ${event.severity.toLowerCase()}?`}
      className="group flex items-center gap-2 rounded-md bg-gray-900 px-2 py-1 text-xs hover:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-600"
    >
      {content}
      <span className="text-gray-600 group-hover:text-gray-400">why?</span>
    </button>
  );
}
