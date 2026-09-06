import type { MarketStatus } from "../types";
import { cn } from "../lib/cn";

export default function MarketStatusPill({ status }: { status: MarketStatus }) {
  const isOpen = status === "OPEN";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        isOpen ? "border-up/30 bg-up/10 text-up" : "border-hairline bg-surface-raised text-gray-400",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", isOpen ? "bg-up" : "bg-gray-600")} />
      Market {isOpen ? "open" : "closed"}
    </span>
  );
}
