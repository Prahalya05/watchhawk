import { useState } from "react";
import type { LiveEvent } from "../ws/useMarketSocket";
import type { EventType, Severity } from "../types";
import { EVENT_META, SEVERITY_META } from "../lib/eventMeta";
import { formatRelativeTime } from "../lib/format";
import { cn } from "../lib/cn";

interface Props {
  events: LiveEvent[];
  onSelectSymbol: (symbol: string) => void;
}

function isEventType(v: string): v is EventType {
  return v in EVENT_META;
}
function isSeverity(v: string): v is Severity {
  return v in SEVERITY_META;
}

// The live event stream from the WebSocket used to be captured and thrown away. This is
// where it lands: a running log of every discrete event the server pushed this session,
// newest first, each row a jump to that symbol.
export default function ActivityFeed({ events, onSelectSymbol }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-white/5"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-200">
          Live activity
          {events.length > 0 && (
            <span className="num rounded-full bg-accent/15 px-1.5 text-[11px] font-semibold text-indigo-300">
              {events.length}
            </span>
          )}
        </span>
        <span className="text-xs text-gray-600">{collapsed ? "▸" : "▾"}</span>
      </button>

      {!collapsed && (
        <div className="max-h-64 overflow-y-auto border-t border-hairline">
          {events.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-600">
              Nothing yet. New price moves, volume spikes and other events will stream in here.
            </p>
          ) : (
            <ul className="divide-y divide-hairline/60">
              {events.map((e) => {
                const meta = isEventType(e.eventType) ? EVENT_META[e.eventType] : null;
                const sev = isSeverity(e.severity) ? SEVERITY_META[e.severity] : SEVERITY_META.NONE;
                return (
                  <li key={`${e.symbol}-${e.eventTime}-${e.receivedAt}`}>
                    <button
                      type="button"
                      onClick={() => onSelectSymbol(e.symbol)}
                      className="flex w-full animate-slide-up items-center gap-3 px-4 py-2 text-left hover:bg-white/5"
                    >
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", sev.dot)} />
                      <span className="w-16 shrink-0 truncate text-xs font-semibold text-gray-100">{e.symbol}</span>
                      <span className="flex-1 truncate text-xs text-gray-400">
                        <span className="text-gray-500">{meta?.glyph ?? "•"}</span> {meta?.label ?? e.eventType}
                      </span>
                      <span className="shrink-0 text-[11px] text-gray-600">{formatRelativeTime(e.receivedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
