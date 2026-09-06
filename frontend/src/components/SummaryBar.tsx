import type { WatchlistSummary, FilterMode } from "../lib/watchlistView";
import { cn } from "../lib/cn";

interface Props {
  summary: WatchlistSummary;
  filter: FilterMode;
  onFilter: (mode: FilterMode) => void;
}

interface Stat {
  key: string;
  label: string;
  value: number;
  tone: string;
  filter?: FilterMode;
  hideWhenZero?: boolean;
}

// A read of the whole list at a glance, and a filter control at the same time — clicking
// "Changed" or "Critical" narrows the table rather than just reporting a number.
export default function SummaryBar({ summary, filter, onFilter }: Props) {
  const stats: Stat[] = [
    { key: "total", label: "Watching", value: summary.total, tone: "text-gray-100", filter: "all" },
    { key: "changed", label: "Changed", value: summary.changed, tone: "text-accent", filter: "changed" },
    { key: "critical", label: "Critical", value: summary.critical, tone: "text-severity-critical", filter: "critical" },
    { key: "notable", label: "Notable", value: summary.notable, tone: "text-severity-notable" },
    { key: "stale", label: "Stale", value: summary.stale, tone: "text-severity-notable", hideWhenZero: true },
    {
      key: "divergent",
      label: "Sources differ",
      value: summary.divergent,
      tone: "text-severity-critical",
      hideWhenZero: true,
    },
    { key: "unavailable", label: "No data", value: summary.unavailable, tone: "text-gray-500", hideWhenZero: true },
  ];

  return (
    <div className="card flex flex-wrap divide-x divide-hairline">
      {stats
        .filter((s) => !s.hideWhenZero || s.value > 0)
        .map((s) => {
          const selectable = s.filter !== undefined;
          const active = s.filter !== undefined && s.filter === filter;
          return (
            <button
              key={s.key}
              type="button"
              disabled={!selectable}
              onClick={() => s.filter && onFilter(active && s.filter !== "all" ? "all" : s.filter)}
              className={cn(
                "flex min-w-[6.5rem] flex-col gap-0.5 px-4 py-3 text-left transition-colors",
                selectable && "hover:bg-white/5",
                active && "bg-white/5",
                !selectable && "cursor-default",
              )}
            >
              <span className={cn("num text-lg font-semibold leading-none", s.tone)}>{s.value}</span>
              <span className="text-[11px] uppercase tracking-wide text-gray-500">{s.label}</span>
            </button>
          );
        })}
    </div>
  );
}
