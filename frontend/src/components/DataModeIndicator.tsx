import Tag from "./ui/Tag";

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
    <Tag
      tone="info"
      title="No live market feed right now — this price is moving on the synthetic replay engine, not a real quote"
    >
      Simulated
    </Tag>
  );
}
