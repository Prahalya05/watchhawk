import { useEffect, useRef, useState } from "react";
import { searchSymbols } from "../api/symbols.api";
import type { SymbolSearchResult } from "../types";
import { cn } from "../lib/cn";

const TIER_TONE: Record<SymbolSearchResult["volatilityTier"], string> = {
  LOW: "text-up",
  MED: "text-severity-notable",
  HIGH: "text-severity-critical",
};

export default function SymbolSearch({ onSelect }: { onSelect: (symbol: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      searchSymbols(query)
        .then((r) => {
          setResults(r);
          setActive(0);
        })
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      onSelect(results[active].symbol);
    }
  }

  return (
    <div>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search by symbol or company name…"
        className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-raised px-3 text-sm text-gray-100 placeholder:text-gray-600"
      />
      <ul ref={listRef} className="mt-2 max-h-72 overflow-y-auto">
        {results.length === 0 && query.trim().length > 0 && (
          <li className="px-3 py-6 text-center text-xs text-gray-600">No matches in the tracked universe.</li>
        )}
        {results.map((r, idx) => (
          <li key={r.symbol}>
            <button
              data-idx={idx}
              onMouseEnter={() => setActive(idx)}
              onClick={() => onSelect(r.symbol)}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm",
                idx === active ? "bg-white/5" : "hover:bg-white/[0.03]",
              )}
            >
              <span className="min-w-0">
                <span className="font-semibold text-gray-100">{r.symbol}</span>{" "}
                <span className="text-gray-500">{r.name}</span>
                <span className="block truncate text-[11px] text-gray-600">{r.sector}</span>
              </span>
              <span className={cn("shrink-0 text-[10px] font-semibold uppercase", TIER_TONE[r.volatilityTier])}>
                {r.volatilityTier} vol
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
