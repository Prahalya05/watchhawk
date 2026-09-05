import { useEffect, useState } from "react";
import { searchSymbols } from "../api/symbols.api";
import type { SymbolSearchResult } from "../types";

export default function SymbolSearch({ onSelect }: { onSelect: (symbol: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolSearchResult[]>([]);

  useEffect(() => {
    const handle = setTimeout(() => {
      searchSymbols(query)
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by symbol or company name…"
        className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 focus:border-gray-500 focus:outline-none"
      />
      <ul className="mt-2 max-h-64 overflow-y-auto">
        {results.map((r) => (
          <li key={r.symbol}>
            <button
              onClick={() => onSelect(r.symbol)}
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-gray-800"
            >
              <span>
                <span className="font-medium text-gray-100">{r.symbol}</span>{" "}
                <span className="text-gray-500">{r.name}</span>
              </span>
              <span className="text-xs text-gray-600">{r.volatilityTier}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
