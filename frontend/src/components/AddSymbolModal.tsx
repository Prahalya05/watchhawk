import { useEffect } from "react";
import SymbolSearch from "./SymbolSearch";
import { useAddSymbol } from "../hooks/useWatchlist";

export default function AddSymbolModal({ onClose }: { onClose: () => void }) {
  const addSymbol = useAddSymbol();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleSelect(symbol: string) {
    addSymbol.mutate(symbol, { onSuccess: onClose });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-24 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Add to watchlist"
        className="w-full max-w-md animate-slide-up rounded-xl border border-hairline bg-surface-overlay p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-100">Add to watchlist</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300" aria-label="Close">
            ✕
          </button>
        </div>
        <SymbolSearch onSelect={handleSelect} />
        {addSymbol.isError && (
          <p className="mt-2 text-xs text-severity-critical">Couldn't add that symbol — try another.</p>
        )}
        <p className="mt-3 text-[11px] text-gray-600">↑↓ to navigate · Enter to add · Esc to close</p>
      </div>
    </div>
  );
}
