import SymbolSearch from "./SymbolSearch";
import { useAddSymbol } from "../hooks/useWatchlist";

export default function AddSymbolModal({ onClose }: { onClose: () => void }) {
  const addSymbol = useAddSymbol();

  function handleSelect(symbol: string) {
    addSymbol.mutate(symbol, { onSuccess: onClose });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-24" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-gray-800 bg-gray-950 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">Add to watchlist</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            ✕
          </button>
        </div>
        <SymbolSearch onSelect={handleSelect} />
        {addSymbol.isError && <p className="mt-2 text-xs text-red-400">Couldn't add that symbol — try another.</p>}
      </div>
    </div>
  );
}
