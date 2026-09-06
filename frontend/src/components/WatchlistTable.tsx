import type { WatchlistEntry } from "../types";
import type { LiveTick } from "../ws/useMarketSocket";
import WatchlistRow from "./WatchlistRow";

interface Props {
  entries: WatchlistEntry[];
  totalCount: number;
  liveTicks: Record<string, LiveTick>;
  history: Record<string, number[]>;
  grouped: boolean;
  highlightSymbol: string | null;
  onClearFilters: () => void;
  onAddSymbol: () => void;
  // Lifted to the dashboard so the drawer renders above the whole page rather than inside
  // a table row, and so only one can be open at a time. Identified by a content-derived
  // key rather than a position, since the list re-ranks on every refetch.
  onExplain: (symbol: string, key: string) => void;
  onAck: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 bg-surface-raised/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
      {label}
      <span className="num text-gray-600">{count}</span>
    </div>
  );
}

// Entries arrive already filtered and ranked (see lib/watchlistView) — this component
// only decides between a flat list and the two status groups.
export default function WatchlistTable({
  entries,
  totalCount,
  liveTicks,
  history,
  grouped,
  highlightSymbol,
  onClearFilters,
  onAddSymbol,
  onExplain,
  onAck,
  onRemove,
}: Props) {
  if (totalCount === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-8 py-16 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-raised text-xl text-gray-600">★</div>
        <p className="text-sm text-gray-400">Your watchlist is empty.</p>
        <button onClick={onAddSymbol} className="text-sm font-medium text-accent hover:underline">
          Add your first symbol
        </button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-8 py-16 text-center">
        <p className="text-sm text-gray-400">No symbols match this filter.</p>
        <button onClick={onClearFilters} className="text-sm font-medium text-accent hover:underline">
          Clear filters
        </button>
      </div>
    );
  }

  const renderRow = (entry: WatchlistEntry) => (
    <WatchlistRow
      key={entry.symbol}
      entry={entry}
      tick={liveTicks[entry.symbol]}
      history={history[entry.symbol] ?? []}
      highlighted={highlightSymbol === entry.symbol}
      onExplain={onExplain}
      onAck={onAck}
      onRemove={onRemove}
    />
  );

  if (!grouped) {
    return <div className="divide-y divide-hairline">{entries.map(renderRow)}</div>;
  }

  const changed = entries.filter((e) => e.events.length > 0);
  const quiet = entries.filter((e) => e.events.length === 0);

  return (
    <div>
      {changed.length > 0 && (
        <div className="divide-y divide-hairline">
          <GroupHeading label="Changed" count={changed.length} />
          {changed.map(renderRow)}
        </div>
      )}
      {quiet.length > 0 && (
        <div className="divide-y divide-hairline border-t border-hairline">
          <GroupHeading label="Quiet" count={quiet.length} />
          {quiet.map(renderRow)}
        </div>
      )}
    </div>
  );
}
