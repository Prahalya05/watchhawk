import { useEffect, useState } from "react";
import axios from "axios";

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

// Operator/presenter tooling for live demos — real market movement can't be scripted,
// so this is what guarantees on-demand control over every event type. Guarded by the
// admin key server-side (X-Admin-Key), not user auth.
export default function AdminDemoPage() {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem("admin_key") ?? "");
  const [symbol, setSymbol] = useState("");
  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]>("VOLUME_SPIKE");
  const [rows, setRows] = useState<AdminSymbolRow[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    localStorage.setItem("admin_key", adminKey);
  }, [adminKey]);

  async function refresh() {
    if (!adminKey) return;
    try {
      const { data } = await axios.get<AdminSymbolRow[]>(`${API_URL}/admin/symbols`, {
        headers: { "X-Admin-Key": adminKey },
      });
      setRows(data);
    } catch {
      setMessage("Failed to load symbols — check the admin key.");
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  async function trigger() {
    if (!symbol) return;
    try {
      await axios.post(
        `${API_URL}/admin/trigger`,
        { symbol, eventType },
        { headers: { "X-Admin-Key": adminKey } }
      );
      setMessage(`Triggered ${eventType} on ${symbol}`);
      setTimeout(refresh, 1000);
    } catch {
      setMessage("Trigger failed — check the admin key.");
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-4 text-xl font-bold text-gray-100">Demo control panel</h1>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-400">
          Admin key
          <input
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            className="mt-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-100"
          />
        </label>
        <label className="flex flex-col text-xs text-gray-400">
          Symbol
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="RELIANCE"
            className="mt-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-100"
          />
        </label>
        <label className="flex flex-col text-xs text-gray-400">
          Event
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value as (typeof EVENT_TYPES)[number])}
            className="mt-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-100"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button onClick={trigger} className="rounded-md bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-900">
          Trigger
        </button>
      </div>

      {message && <p className="mb-4 text-xs text-gray-500">{message}</p>}

      <table className="w-full text-left text-sm">
        <thead className="text-xs text-gray-500">
          <tr>
            <th className="pb-2">Symbol</th>
            <th className="pb-2">Price</th>
            <th className="pb-2">Source</th>
            <th className="pb-2">Mode</th>
            <th className="pb-2">Flags</th>
            <th className="pb-2">Refcount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-900">
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td className="py-1.5 text-gray-100">{r.symbol}</td>
              <td className="py-1.5 tabular-nums text-gray-300">{r.state ? `₹${r.state.price.toFixed(2)}` : "—"}</td>
              <td className="py-1.5 text-gray-400">{r.state?.source ?? "—"}</td>
              <td className="py-1.5 text-gray-400">{r.state?.mode ?? "—"}</td>
              <td className="py-1.5 text-xs text-gray-500">
                {r.state?.isStale && <span className="mr-1 text-yellow-400">STALE</span>}
                {r.state?.isDivergent && <span className="text-red-400">DIVERGENT</span>}
              </td>
              <td className="py-1.5 text-gray-500">{r.refcount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
