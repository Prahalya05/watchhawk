// Surfaces when a price is coming from the synthetic replay engine rather than a real
// quote — happens whenever no live feed can currently report (market closed, or a
// live-mode outage falling back per-symbol), so it's not limited to fully-replay
// deployments. Without this, a moving-but-fake price looks identical to a real one.
// `mode` is typed as plain string (not DataMode) because it can come from either the
// GET /watchlist response (DataMode) or a WS LiveTick (declared string there) — see
// WatchlistTable's `mode` merge.
export default function DataModeIndicator({ mode }: { mode: string }) {
  if (mode !== "REPLAY") return null;
  return (
    <span
      className="rounded bg-blue-900/60 px-1.5 py-0.5 text-[10px] font-medium text-blue-300"
      title="No live market feed right now — this price is moving on the synthetic replay engine, not a real quote"
    >
      SIMULATED
    </span>
  );
}
