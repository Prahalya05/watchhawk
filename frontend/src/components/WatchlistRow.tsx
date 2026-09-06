import { useEffect, useRef, useState } from "react";
import type { WatchlistEntry } from "../types";
import type { LiveTick } from "../ws/useMarketSocket";
import { SEVERITY_META } from "../lib/eventMeta";
import { formatPrice, formatPercent, formatCompact } from "../lib/format";
import { cn } from "../lib/cn";
import EventBadge from "./EventBadge";
import SeverityIcon from "./SeverityIcon";
import StalenessIndicator from "./StalenessIndicator";
import DivergenceIndicator from "./DivergenceIndicator";
import DataModeIndicator from "./DataModeIndicator";
import UnavailableNotice from "./UnavailableNotice";
import Sparkline from "./ui/Sparkline";
import Button from "./ui/Button";
import { eventKey } from "../lib/eventKey";

interface Props {
  entry: WatchlistEntry;
  tick?: LiveTick;
  history: number[];
  highlighted: boolean;
  onExplain: (symbol: string, key: string) => void;
  onAck: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}

export default function WatchlistRow({ entry, tick, history, highlighted, onExplain, onAck, onRemove }: Props) {
  const unavailable = entry.unavailable;
  const live = unavailable ? undefined : tick;
  const price = live?.price ?? entry.current.price;
  const changePct = live?.changePct ?? entry.current.changePct;
  const isStale = live?.isStale ?? entry.current.isStale;
  const isDivergent = live?.isDivergent ?? entry.current.isDivergent;
  const mode = live?.mode ?? entry.current.mode;
  const volume = live?.volume ?? entry.current.volume;

  const sev = SEVERITY_META[entry.maxSeverity];
  const hiddenEvents = Math.max(0, entry.eventCount - entry.events.length);

  // Flash the price cell green/red for a beat when a live tick moves it.
  const prevPrice = useRef(price);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (price === prevPrice.current) return;
    setFlash(price > prevPrice.current ? "up" : "down");
    prevPrice.current = price;
    const id = window.setTimeout(() => setFlash(null), 1000);
    return () => window.clearTimeout(id);
  }, [price]);

  return (
    <div
      id={`wl-${entry.symbol}`}
      className={cn(
        "group scroll-mt-24 border-l-2 px-4 py-3 transition-colors",
        sev.border,
        highlighted ? "bg-accent/5 ring-1 ring-inset ring-accent/30" : "hover:bg-white/[0.02]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <SeverityIcon severity={entry.maxSeverity} size="md" halo />
          <div className="min-w-0">
            <div className="truncate font-semibold text-gray-100">{entry.symbol}</div>
            <div className="truncate text-xs text-gray-500">{entry.name}</div>
          </div>
        </div>

        {!unavailable && (
          <div className="hidden shrink-0 sm:block">
            <Sparkline points={history} />
          </div>
        )}

        <div
          className={cn(
            "w-28 shrink-0 rounded-md px-1.5 text-right",
            flash === "up" && "animate-flash-up",
            flash === "down" && "animate-flash-down",
          )}
        >
          {unavailable ? (
            <div className="text-sm text-gray-600">—</div>
          ) : (
            <>
              <div className="num text-sm text-gray-100">{formatPrice(price)}</div>
              <div className={cn("num text-xs", changePct >= 0 ? "text-up" : "text-down")}>
                {formatPercent(changePct)}
              </div>
            </>
          )}
        </div>

        <div className="hidden w-24 shrink-0 text-right lg:block">
          {!unavailable && (
            <>
              <div className="num text-xs text-gray-400">{formatCompact(volume)}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-600">vol</div>
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {unavailable ? (
            <UnavailableNotice unavailable={unavailable} />
          ) : (
            <>
              <DataModeIndicator mode={mode} />
              <StalenessIndicator isStale={isStale} />
              <DivergenceIndicator isDivergent={isDivergent} divergencePct={entry.current.divergencePct} />
            </>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          {entry.events.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => onAck(entry.symbol)}>
              Dismiss
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onRemove(entry.symbol)}>
            Remove
          </Button>
        </div>
      </div>

      {(entry.events.length > 0 || hiddenEvents > 0 || (!unavailable && entry.events.length === 0)) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
          {entry.events.map((event) => (
            <EventBadge
              key={eventKey(event)}
              event={event}
              onExplain={() => onExplain(entry.symbol, eventKey(event))}
            />
          ))}
          {hiddenEvents > 0 && (
            <span
              className="text-xs text-gray-600"
              title={`${hiddenEvents} lower-severity event${hiddenEvents === 1 ? "" : "s"} not shown — dismiss to clear, or open one above`}
            >
              +{hiddenEvents} more
            </span>
          )}
          {!unavailable && entry.events.length === 0 && (
            <span className="text-xs text-gray-600">No changes since your last visit</span>
          )}
        </div>
      )}
    </div>
  );
}
