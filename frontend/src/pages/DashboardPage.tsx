import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWatchlistDiff, useRemoveSymbol } from "../hooks/useWatchlist";
import { useAckAll, useAckSymbol } from "../hooks/useAck";
import { useMarketSocket } from "../ws/useMarketSocket";
import { useAuth } from "../context/AuthContext";
import { usePriceHistory } from "../hooks/usePriceHistory";
import { useHotkeys } from "../hooks/useHotkeys";
import { getApiErrorMessage } from "../api/errors";
import { applyView, summarise, DEFAULT_VIEW, type ViewState } from "../lib/watchlistView";
import { EVENT_META } from "../lib/eventMeta";
import { eventKey } from "../lib/eventKey";
import WatchlistTable from "../components/WatchlistTable";
import WatchlistControls from "../components/WatchlistControls";
import SummaryBar from "../components/SummaryBar";
import ActivityFeed from "../components/ActivityFeed";
import AddSymbolModal from "../components/AddSymbolModal";
import MarketStatusPill from "../components/MarketStatusPill";
import ConnectionPill from "../components/ConnectionPill";
import CommandBar from "../components/CommandBar";
import ExplainDrawer from "../components/ExplainDrawer";
import Button from "../components/ui/Button";
import { WatchlistRowSkeleton } from "../components/ui/Skeleton";
import { useToast } from "../components/ui/Toast";

export default function DashboardPage() {
  const { data, isLoading, error } = useWatchlistDiff();
  const ackAll = useAckAll();
  const ackSymbol = useAckSymbol();
  const removeSymbol = useRemoveSymbol();
  const { logout, user } = useAuth();
  const toast = useToast();

  const [showAddModal, setShowAddModal] = useState(false);
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW);
  const [grouped, setGrouped] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);

  // Identified by (symbol, eventKey) rather than by holding the event object itself, so a
  // background refetch re-reads the current event through the same lookup instead of
  // leaving the drawer pinned to a stale copy of the trace.
  const [explaining, setExplaining] = useState<{ symbol: string; key: string } | null>(null);

  const symbols = useMemo(() => data?.entries.map((e) => e.symbol) ?? [], [data]);
  const { ticks, liveEvents, status, lastMessageAt } = useMarketSocket(symbols);
  const history = usePriceHistory(ticks);

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const summary = useMemo(() => summarise(entries), [entries]);
  const visible = useMemo(() => applyView(entries, ticks, view), [entries, ticks, view]);
  const hasChanges = summary.changed > 0;

  const patchView = (patch: Partial<ViewState>) => setView((v) => ({ ...v, ...patch }));

  // Toast + transient highlight when the socket pushes a discrete event.
  const seenEvents = useRef(0);
  useEffect(() => {
    if (liveEvents.length > seenEvents.current) {
      const latest = liveEvents[0];
      const meta = (EVENT_META as Record<string, { label: string }>)[latest.eventType];
      toast.push({
        title: `${latest.symbol} · ${meta?.label ?? latest.eventType}`,
        body: `Flagged ${latest.severity.toLowerCase()}. Click the row to see why.`,
        tone: latest.severity === "CRITICAL" ? "danger" : latest.severity === "NOTABLE" ? "warn" : "info",
      });
    }
    seenEvents.current = liveEvents.length;
  }, [liveEvents, toast]);

  function focusSymbol(symbol: string) {
    setHighlight(symbol);
    document.getElementById(`wl-${symbol}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlight((s) => (s === symbol ? null : s)), 2500);
  }

  const hotkeys = useMemo(
    () => ({
      "/": () => searchRef.current?.focus(),
      a: () => setShowAddModal(true),
      k: () => commandRef.current?.focus(),
      g: () => setGrouped((v) => !v),
      Escape: () => {
        setExplaining(null);
        setShowAddModal(false);
      },
    }),
    [],
  );
  useHotkeys(hotkeys);

  const explainingEntry = explaining ? entries.find((e) => e.symbol === explaining.symbol) : undefined;
  const resolvedEvent = explaining ? explainingEntry?.events.find((e) => eventKey(e) === explaining.key) : undefined;
  const explainingEvent = explaining && resolvedEvent ? { symbol: explaining.symbol, event: resolvedEvent } : null;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hairline bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent/15 text-sm text-accent">◎</span>
            <div>
              <h1 className="text-sm font-bold text-gray-100">Smart Watchlist</h1>
              <p className="text-[11px] text-gray-500">What's changed since you last checked</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {data && <MarketStatusPill status={data.marketStatus} />}
            <ConnectionPill status={status} lastMessageAt={lastMessageAt} />
            <span className="hidden text-xs text-gray-600 sm:inline">{user?.email}</span>
            <Link to="/admin" className="text-xs text-gray-600 hover:text-gray-300">
              Demo
            </Link>
            <Button size="sm" variant="ghost" onClick={logout}>
              Log out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <CommandBar ref={commandRef} />

        <SummaryBar summary={summary} filter={view.filter} onFilter={(f) => patchView({ filter: f })} />

        {liveEvents.length > 0 && <ActivityFeed events={liveEvents} onSelectSymbol={focusSymbol} />}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => setShowAddModal(true)}>
            + Add symbol
          </Button>
          {hasChanges && (
            <Button variant="secondary" onClick={() => ackAll.mutate()} loading={ackAll.isPending}>
              Dismiss all
            </Button>
          )}
          <span className="ml-auto hidden text-[11px] text-gray-600 md:inline">
            <kbd className="rounded border border-hairline px-1">/</kbd> filter ·{" "}
            <kbd className="rounded border border-hairline px-1">k</kbd> command ·{" "}
            <kbd className="rounded border border-hairline px-1">a</kbd> add ·{" "}
            <kbd className="rounded border border-hairline px-1">g</kbd> group
          </span>
        </div>

        {(data || isLoading) && (
          <WatchlistControls
            ref={searchRef}
            view={view}
            onChange={patchView}
            grouped={grouped}
            onGroupedChange={setGrouped}
            resultCount={visible.length}
            totalCount={entries.length}
          />
        )}

        <div className="card overflow-hidden">
          {isLoading && (
            <div className="divide-y divide-hairline">
              {Array.from({ length: 5 }).map((_, i) => (
                <WatchlistRowSkeleton key={i} />
              ))}
            </div>
          )}
          {error && (
            <p className="p-8 text-sm text-severity-critical">
              {getApiErrorMessage(error, "Couldn't load your watchlist.")}
            </p>
          )}
          {data && (
            <WatchlistTable
              entries={visible}
              totalCount={entries.length}
              liveTicks={ticks}
              history={history}
              grouped={grouped}
              highlightSymbol={highlight}
              onClearFilters={() => setView(DEFAULT_VIEW)}
              onAddSymbol={() => setShowAddModal(true)}
              onExplain={(symbol, key) => setExplaining({ symbol, key })}
              onAck={(s) => ackSymbol.mutate(s)}
              onRemove={(s) => removeSymbol.mutate(s)}
            />
          )}
        </div>
      </main>

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
