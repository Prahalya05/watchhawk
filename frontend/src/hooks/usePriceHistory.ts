import { useEffect, useRef, useState } from "react";
import type { LiveTick } from "../ws/useMarketSocket";

const MAX_POINTS = 40;

/**
 * Rolling in-memory price history per symbol, built from the live WS tick stream. There
 * is no historical-bars endpoint on the client, so this starts empty on page load and
 * fills in over the session — enough to draw a "since you opened this" sparkline, which
 * is exactly the window this app cares about ("what changed since you last looked").
 */
export function usePriceHistory(ticks: Record<string, LiveTick>): Record<string, number[]> {
  const [history, setHistory] = useState<Record<string, number[]>>({});
  const lastStamp = useRef<Record<string, string>>({});

  useEffect(() => {
    setHistory((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [symbol, tick] of Object.entries(ticks)) {
        if (lastStamp.current[symbol] === tick.updatedAt) continue;
        lastStamp.current[symbol] = tick.updatedAt;
        const series = [...(next[symbol] ?? []), tick.price].slice(-MAX_POINTS);
        next[symbol] = series;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [ticks]);

  return history;
}
