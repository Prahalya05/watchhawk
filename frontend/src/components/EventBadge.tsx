import type { DiffEvent } from "../types";
import { EVENT_META, SEVERITY_META } from "../lib/eventMeta";
import { cn } from "../lib/cn";

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// Feed-sourced events carry the numbers that decided their severity, so the badge can say
// what actually happened — "Dividend ₹57.00 (2.5%)" rather than "Corporate action
// announced". The generic strings remain as the fallback for a demo trigger from the
// admin panel, whose payload is whatever the operator typed.
function describeCorporateAction(d: Record<string, unknown>): string {
  if (d.action === "SPLIT") {
    const ratio = str(d.splitRatio);
    return ratio ? `Stock split ${ratio}` : "Stock split";
  }
  if (d.action === "DIVIDEND") {
    const amount = num(d.amount);
    const dividendYield = num(d.yield);
    if (amount === null) return "Dividend announced";
    return dividendYield === null
      ? `Dividend ₹${amount.toFixed(2)}`
      : `Dividend ₹${amount.toFixed(2)} (${(dividendYield * 100).toFixed(2)}%)`;
  }
  return str(d.summary) ?? "Corporate action announced";
}

function describeRatingChange(d: Record<string, unknown>): string {
  const from = str(d.fromGrade);
  const to = str(d.toGrade);
  const firm = str(d.firm);
  if (to === null) return str(d.summary) ?? "Analyst rating changed";
  const move = from ? `${from} → ${to}` : `initiated at ${to}`;
  return firm ? `${firm}: ${move}` : move;
}

function describeDetail(event: DiffEvent): string {
  const d = event.detail as Record<string, unknown>;
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
      return str(d.headline) ?? "New headline";
    case "RATING_CHANGE":
      return describeRatingChange(d);
    case "CORPORATE_ACTION":
      return describeCorporateAction(d);
    default:
      return "";
  }
}

// The badge is the click target for the explanation panel rather than a separate "?"
// icon: the thing you want explained is the thing you are looking at, and every badge is
// explainable, so a per-badge affordance would just be noise repeated five times a row.
export default function EventBadge({ event, onExplain }: { event: DiffEvent; onExplain?: () => void }) {
  const meta = EVENT_META[event.type];
  const sev = SEVERITY_META[event.severity];

  const content = (
    <>
      <span className={cn("grid h-4 w-4 place-items-center rounded text-[10px]", sev.chip)}>{meta.glyph}</span>
      <span className="font-medium text-gray-200">{meta.label}</span>
      <span className="text-gray-500">{describeDetail(event)}</span>
    </>
  );

  const base = "flex items-center gap-1.5 rounded-md border border-hairline bg-surface-raised px-2 py-1 text-xs";

  if (!onExplain) {
    return <div className={base}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onExplain}
      title={`Why is this flagged ${event.severity.toLowerCase()}?`}
      className={cn(base, "group transition-colors hover:border-hairline-strong hover:bg-surface-overlay")}
    >
      {content}
      <span className="text-gray-600 group-hover:text-accent">why?</span>
    </button>
  );
}
