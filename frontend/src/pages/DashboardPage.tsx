import { useState } from "react";
import { Link } from "react-router-dom";
import { useWatchlistDiff } from "../hooks/useWatchlist";
import { useAckAll } from "../hooks/useAck";
import { useMarketSocket } from "../ws/useMarketSocket";
import { useAuth } from "../context/AuthContext";
import { getApiErrorMessage } from "../api/errors";
import WatchlistTable from "../components/WatchlistTable";
import AddSymbolModal from "../components/AddSymbolModal";
import MarketStatusPill from "../components/MarketStatusPill";
import CommandBar from "../components/CommandBar";
import ExplainDrawer from "../components/ExplainDrawer";
import { eventKey } from "../lib/eventKey";

export default function DashboardPage() {
  const { data, isLoading, error } = useWatchlistDiff();
  const ackAll = useAckAll();
  const { logout, user } = useAuth();
  const [showAddModal, setShowAddModal] = useState(false);
  // Identified by (symbol, eventKey) rather than by holding the event object itself, so a
  // background refetch re-reads the current event through the same lookup instead of
  // leaving the drawer pinned to a stale copy of the trace. The key is derived from the
  // event's own content, not its position: GET /watchlist re-ranks events by severity and
  // recency, so an index would quietly start pointing at a different event after a poll.
  const [explaining, setExplaining] = useState<{ symbol: string; key: string } | null>(null);

  const symbols = data?.entries.map((e) => e.symbol) ?? [];
  const { ticks } = useMarketSocket(symbols);

  const hasChanges = (data?.entries ?? []).some((e) => e.events.length > 0);

  // Resolved from the live query data every render. If an ack or a refetch removes the
  // event under the open drawer, this goes null and the drawer closes itself rather than
  // explaining something the user is no longer being shown.
  const explainingEntry = explaining ? data?.entries.find((e) => e.symbol === explaining.symbol) : undefined;
  const resolvedEvent = explaining ? explainingEntry?.events.find((e) => eventKey(e) === explaining.key) : undefined;
  const explainingEvent = explaining && resolvedEvent ? { symbol: explaining.symbol, event: resolvedEvent } : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-100">Smart Watchlist</h1>
          <p className="text-sm text-gray-500">What's changed since you last checked.</p>
        </div>
        <div className="flex items-center gap-3">
          {data && <MarketStatusPill status={data.marketStatus} />}
          <span className="text-xs text-gray-500">{user?.email}</span>
          <Link to="/admin" className="text-xs text-gray-600 hover:text-gray-400">
            Demo panel
          </Link>
          <button onClick={logout} className="text-xs text-gray-600 hover:text-gray-400">
            Log out
          </button>
        </div>
      </header>

      <CommandBar />

      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={() => setShowAddModal(true)}
          className="rounded-md bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-white"
        >
          + Add symbol
        </button>
        {hasChanges && (
          <button
            onClick={() => ackAll.mutate()}
            className="rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
          >
            Dismiss all
          </button>
        )}
      </div>

      <div className="rounded-lg border border-gray-900">
        {isLoading && <p className="p-8 text-sm text-gray-500">Loading…</p>}
        {error && (
          <p className="p-8 text-sm text-red-400">{getApiErrorMessage(error, "Couldn't load your watchlist.")}</p>
        )}
        {data && (
          <WatchlistTable
            entries={data.entries}
            liveTicks={ticks}
            onExplain={(symbol, key) => setExplaining({ symbol, key })}
          />
        )}
      </div>

      {showAddModal && <AddSymbolModal onClose={() => setShowAddModal(false)} />}

      {explainingEvent && (
        <ExplainDrawer
          symbol={explainingEvent.symbol}
          event={explainingEvent.event}
          onClose={() => setExplaining(null)}
        />
      )}
    </div>
  );
}
