import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import Button from "../components/ui/Button";
import Tag from "../components/ui/Tag";
import { cn } from "../lib/cn";
import { formatPrice, formatRelativeTime } from "../lib/format";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

const EVENT_TYPES = [
  "VOLUME_SPIKE",
  "GAP_OPEN",
  "FIFTY_TWO_WEEK_EXTREME",
  "NEWS",
  "RATING_CHANGE",
  "CORPORATE_ACTION",
  "DIVERGE",
  "FREEZE",
  "UNFREEZE",
] as const;

type EventTypeName = (typeof EVENT_TYPES)[number];

const SCENARIOS: Array<{ label: string; event: EventTypeName; tone: "warn" | "danger" | "info" }> = [
  { label: "Volume spike", event: "VOLUME_SPIKE", tone: "warn" },
  { label: "Gap open", event: "GAP_OPEN", tone: "warn" },
  { label: "52-week high", event: "FIFTY_TWO_WEEK_EXTREME", tone: "info" },
  { label: "Breaking news", event: "NEWS", tone: "info" },
  { label: "Force divergence", event: "DIVERGE", tone: "danger" },
  { label: "Freeze feed", event: "FREEZE", tone: "danger" },
];

interface AdminSymbolRow {
  symbol: string;
  name: string;
  tier: string;
  refcount: number;
  state: {
    price: number;
    isStale: boolean;
    isDivergent: boolean;
    mode: string;
    source: string;
  } | null;
}

type ConnState = "unknown" | "ok" | "bad";

// Operator/presenter tooling for live demos — real market movement can't be scripted,
// so this is what guarantees on-demand control over every event type. Guarded by the
// admin key server-side (X-Admin-Key), not user auth.
export default function AdminDemoPage() {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem("admin_key") ?? "");
  const [symbol, setSymbol] = useState("");
  const [eventType, setEventType] = useState<EventTypeName>("VOLUME_SPIKE");
  const [rows, setRows] = useState<AdminSymbolRow[]>([]);
  const [conn, setConn] = useState<ConnState>("unknown");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    localStorage.setItem("admin_key", adminKey);
  }, [adminKey]);

  const flash = useCallback((text: string, ok: boolean) => {
    setToast({ text, ok });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const refresh = useCallback(async () => {
    if (!adminKey) {
      setConn("unknown");
      return;
    }
    try {
      const { data } = await axios.get<AdminSymbolRow[]>(`${API_URL}/admin/symbols`, {
        headers: { "X-Admin-Key": adminKey },
      });
      setRows(data);
      setConn("ok");
      setLastRefresh(Date.now());
    } catch {
      setConn("bad");
    }
  }, [adminKey]);

  useEffect(() => {
    refresh();
    if (!autoRefresh) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh, autoRefresh]);

  async function trigger(evt: EventTypeName, sym: string) {
    if (!sym) {
      flash("Pick a symbol first.", false);
      return;
    }
    try {
      await axios.post(
        `${API_URL}/admin/trigger`,
        { symbol: sym, eventType: evt },
        { headers: { "X-Admin-Key": adminKey } },
      );
      flash(`Triggered ${evt} on ${sym}`, true);
      setTimeout(refresh, 800);
    } catch {
      flash("Trigger failed — check the admin key.", false);
    }
  }

  const connMeta: Record<ConnState, { label: string; tone: "positive" | "danger" | "neutral" }> = {
    ok: { label: "Connected", tone: "positive" },
    bad: { label: "Auth failed", tone: "danger" },
    unknown: { label: "Enter key", tone: "neutral" },
  };

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.refcount - a.refcount || a.symbol.localeCompare(b.symbol)),
    [rows],
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-gray-100">Demo control panel</h1>
          <p className="text-xs text-gray-500">Trigger any event type on demand — server-guarded by the admin key.</p>
        </div>
        <Link to="/" className="text-xs text-gray-500 hover:text-gray-300">
          ← Back to dashboard
        </Link>
      </div>

      <div className="card mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs text-gray-400 sm:flex-none">
            Admin key
            <input
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder="X-Admin-Key"
              className="h-9 w-full rounded-lg border border-hairline-strong bg-surface-raised px-3 text-sm text-gray-100 sm:w-64"
            />
          </label>
          <Tag tone={connMeta[conn].tone}>{connMeta[conn].label}</Tag>
          <label className="ml-auto flex items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-accent"
            />
            Auto-refresh
          </label>
          <Button size="sm" variant="secondary" onClick={refresh}>
            Refresh now
          </Button>
        </div>
        {lastRefresh && (
          <p className="mt-2 text-[11px] text-gray-600">Updated {formatRelativeTime(new Date(lastRefresh))}</p>
        )}
      </div>

      <div className="card mb-4 p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-200">Trigger an event</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Symbol
            <input
              list="admin-symbols"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="RELIANCE"
              className="h-9 w-40 rounded-lg border border-hairline-strong bg-surface-raised px-3 text-sm text-gray-100"
            />
            <datalist id="admin-symbols">
              {rows.map((r) => (
                <option key={r.symbol} value={r.symbol}>
                  {r.name}
                </option>
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Event
            <select
              value={eventType}
              onChange={(e) => setEventType(e.target.value as EventTypeName)}
              className="h-9 rounded-lg border border-hairline-strong bg-surface-raised px-2 text-sm text-gray-100"
            >
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <Button variant="primary" onClick={() => trigger(eventType, symbol)}>
            Trigger
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="self-center text-[11px] text-gray-600">Quick:</span>
          {SCENARIOS.map((s) => (
            <button
              key={s.event}
              onClick={() => trigger(s.event, symbol)}
              disabled={!symbol}
              className="rounded-md border border-hairline px-2 py-1 text-xs text-gray-300 hover:border-hairline-strong hover:bg-surface-overlay disabled:opacity-40"
            >
              {s.label}
            </button>
          ))}
        </div>

        {toast && <p className={cn("mt-3 text-xs", toast.ok ? "text-up" : "text-severity-critical")}>{toast.text}</p>}
      </div>

      <div className="card overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-hairline px-4 py-2 text-[11px] uppercase tracking-wide text-gray-500">
          <span>Symbol</span>
          <span className="text-right">Price</span>
          <span>Source</span>
          <span>Flags</span>
          <span className="text-right">Refs</span>
        </div>
        <div className="divide-y divide-hairline">
          {sortedRows.length === 0 && (
            <p className="px-4 py-8 text-center text-xs text-gray-600">
              {conn === "ok"
                ? "No symbols are being watched right now."
                : "Connect with a valid admin key to load symbols."}
            </p>
          )}
          {sortedRows.map((r) => (
            <button
              key={r.symbol}
              onClick={() => setSymbol(r.symbol)}
              className={cn(
                "grid w-full grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 px-4 py-2 text-left text-sm hover:bg-white/5",
                symbol === r.symbol && "bg-accent/5",
              )}
            >
              <span className="min-w-0">
                <span className="font-semibold text-gray-100">{r.symbol}</span>
                <span className="block truncate text-[11px] text-gray-600">{r.name}</span>
              </span>
              <span className="num text-right text-gray-300">{r.state ? formatPrice(r.state.price) : "—"}</span>
              <span className="text-xs text-gray-500">{r.state?.source ?? "—"}</span>
              <span className="flex gap-1">
                {r.state?.isStale && <Tag tone="warn">Stale</Tag>}
                {r.state?.isDivergent && <Tag tone="danger">Diverg</Tag>}
                {r.state?.mode === "REPLAY" && <Tag tone="info">Sim</Tag>}
              </span>
              <span className="num text-right text-gray-500">{r.refcount}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
