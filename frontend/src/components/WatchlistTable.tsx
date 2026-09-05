import type { WatchlistEntry } from "../types";
import type { LiveTick } from "../ws/useMarketSocket";
import EventBadge from "./EventBadge";
import SeverityIcon from "./SeverityIcon";
import StalenessIndicator from "./StalenessIndicator";
import DivergenceIndicator from "./DivergenceIndicator";
import DataModeIndicator from "./DataModeIndicator";
import UnavailableNotice from "./UnavailableNotice";
import { eventKey } from "../lib/eventKey";
import { useAckSymbol } from "../hooks/useAck";
import { useRemoveSymbol } from "../hooks/useWatchlist";

interface Props {
  entries: WatchlistEntry[];
  liveTicks: Record<string, LiveTick>;
  // Lifted to the dashboard so the drawer renders above the whole page rather than inside
  // a table row, and so only one can be open at a time. Identified by a content-derived
  // key rather than a position, since the list re-ranks on every refetch.
  onExplain: (symbol: string, key: string) => void;
}

// Entries arrive from GET /watchlist already ranked by severity — this table doesn't
// re-sort. Live WS ticks are overlaid on top of price/volume/staleness/divergence
// fields only; the event list itself only changes on the next diff fetch or ack.
export default function WatchlistTable({ entries, liveTicks, onExplain }: Props) {
  const ack = useAckSymbol();
  const remove = useRemoveSymbol();

  if (entries.length === 0) {
    return <p className="p-8 text-sm text-gray-500">Your watchlist is empty. Add a symbol to get started.</p>;
  }

  return (
    <div className="divide-y divide-gray-900">
      {entries.map((entry) => {
        // An unavailable row has no quote to overlay and no placeholder worth showing,
        // so live ticks are ignored for it and the price column is replaced outright.
        const live = entry.unavailable ? undefined : liveTicks[entry.symbol];
        const price = live?.price ?? entry.current.price;
        const changePct = live?.changePct ?? entry.current.changePct;
        const isStale = live?.isStale ?? entry.current.isStale;
        const isDivergent = live?.isDivergent ?? entry.current.isDivergent;
        const mode = live?.mode ?? entry.current.mode;

        return (
          <div key={entry.symbol} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex min-w-0 items-center gap-2">
                <SeverityIcon severity={entry.maxSeverity} />
                <div className="min-w-0">
                  <div className="truncate font-semibold text-gray-100">{entry.symbol}</div>
                  <div className="truncate text-xs text-gray-500">{entry.name}</div>
                </div>
              </div>

              <div className="shrink-0">
                {entry.unavailable ? (
                  <div className="text-sm text-gray-600">—</div>
                ) : (
                  <>
                    <div className="tabular-nums text-gray-100">₹{price.toFixed(2)}</div>
                    <div className={`text-xs tabular-nums ${changePct >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {changePct >= 0 ? "+" : ""}
                      {changePct.toFixed(2)}%
                    </div>
                  </>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {entry.unavailable ? (
                  <UnavailableNotice unavailable={entry.unavailable} />
                ) : (
                  <>
                    <DataModeIndicator mode={mode} />
                    <StalenessIndicator isStale={isStale} />
                    <DivergenceIndicator isDivergent={isDivergent} divergencePct={entry.current.divergencePct} />
                  </>
                )}
              </div>

              <div className="ml-auto flex shrink-0 gap-2">
                {entry.events.length > 0 && (
                  <button
                    onClick={() => ack.mutate(entry.symbol)}
                    className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                  >
                    Dismiss
                  </button>
                )}
                <button
                  onClick={() => remove.mutate(entry.symbol)}
                  className="rounded-md border border-gray-800 px-2 py-1 text-xs text-gray-500 hover:bg-gray-800"
                >
                  Remove
                </button>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {entry.events.map((event) => (
                <EventBadge
                  key={eventKey(event)}
                  event={event}
                  onExplain={() => onExplain(entry.symbol, eventKey(event))}
                />
              ))}
              {entry.overflow && <span className="self-center text-xs text-gray-600">+more</span>}
              {entry.unavailable ? (
                <span className="self-center text-xs text-gray-500">{entry.unavailable.message}</span>
              ) : (
                entry.events.length === 0 && (
                  <span className="self-center text-xs text-gray-600">No changes since your last visit</span>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
