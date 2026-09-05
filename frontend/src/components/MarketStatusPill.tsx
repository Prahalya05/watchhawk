import type { MarketStatus } from "../types";

export default function MarketStatusPill({ status }: { status: MarketStatus }) {
  const isOpen = status === "OPEN";
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
        isOpen ? "bg-green-900/60 text-green-300" : "bg-gray-800 text-gray-400"
      }`}
    >
      Market {isOpen ? "open" : "closed"}
    </span>
  );
}
