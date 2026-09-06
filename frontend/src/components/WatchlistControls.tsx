import { forwardRef } from "react";
import type { FilterMode, SortKey, ViewState } from "../lib/watchlistView";
import { cn } from "../lib/cn";
import Menu from "./ui/Menu";

interface Props {
  view: ViewState;
  onChange: (patch: Partial<ViewState>) => void;
  grouped: boolean;
  onGroupedChange: (v: boolean) => void;
  resultCount: number;
  totalCount: number;
}

const FILTERS: Array<{ key: FilterMode; label: string }> = [
  { key: "all", label: "All" },
  { key: "changed", label: "Changed" },
  { key: "critical", label: "Critical" },
];

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "severity", label: "Severity" },
  { key: "symbol", label: "Symbol (A–Z)" },
  { key: "change", label: "Biggest move" },
  { key: "price", label: "Price (high–low)" },
];

const WatchlistControls = forwardRef<HTMLInputElement, Props>(function WatchlistControls(
  { view, onChange, grouped, onGroupedChange, resultCount, totalCount },
  searchRef,
) {
  const sortLabel = SORTS.find((s) => s.key === view.sort)?.label ?? "Severity";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 sm:min-w-[14rem] sm:flex-none">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600">⌕</span>
        <input
          ref={searchRef}
          value={view.search}
          onChange={(e) => onChange({ search: e.target.value })}
          placeholder="Filter symbols…  ( / )"
          className="h-9 w-full rounded-lg border border-hairline-strong bg-surface-raised pl-7 pr-3 text-sm text-gray-100 placeholder:text-gray-600 focus:border-hairline-strong"
        />
      </div>

      <div className="inline-flex h-9 items-center rounded-lg border border-hairline-strong bg-surface-raised p-0.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange({ filter: f.key })}
            className={cn(
              "h-8 rounded-md px-2.5 text-xs font-medium transition-colors",
              view.filter === f.key ? "bg-surface-overlay text-gray-100" : "text-gray-500 hover:text-gray-300",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Menu
        label={
          <span className="text-gray-400">
            Sort: <span className="text-gray-200">{sortLabel}</span>
          </span>
        }
        items={SORTS.map((s) => ({
          key: s.key,
          label: s.label,
          active: view.sort === s.key,
          onSelect: () => onChange({ sort: s.key }),
        }))}
      />

      <button
        type="button"
        onClick={() => onGroupedChange(!grouped)}
        aria-pressed={grouped}
        className={cn(
          "h-9 rounded-lg border px-3 text-xs font-medium transition-colors",
          grouped
            ? "border-accent/40 bg-accent/10 text-indigo-300"
            : "border-hairline-strong bg-surface-raised text-gray-400 hover:text-gray-200",
        )}
      >
        Group by status
      </button>

      <span className="ml-auto text-xs text-gray-600">
        {resultCount === totalCount ? `${totalCount} symbols` : `${resultCount} of ${totalCount}`}
      </span>
    </div>
  );
});

export default WatchlistControls;
