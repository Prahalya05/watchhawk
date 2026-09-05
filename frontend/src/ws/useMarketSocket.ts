import { useEffect, useRef, useState } from "react";
import { TOKEN_KEY } from "../api/client";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000/ws";

export interface LiveTick {
  symbol: string;
  price: number;
  changePct: number;
  volume: number;
  source: string;
  mode: string;
  isStale: boolean;
  isDivergent: boolean;
  updatedAt: string;
}

interface LiveEvent {
  symbol: string;
  eventType: string;
  severity: string;
  eventTime: string;
  payload: Record<string, unknown>;
}

// Merges live WS ticks over the last GET /watchlist snapshot on the dashboard — this
// hook only tracks the raw tick stream; the dashboard decides how to combine it with
// the diff response.
export function useMarketSocket(symbols: string[]) {
  const [ticks, setTicks] = useState<Record<string, LiveTick>>({});
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const symbolsRef = useRef<string[]>(symbols);
  symbolsRef.current = symbols;

  useEffect(() => {
    let cancelled = false;
    let retryDelay = 1000;

    function connect() {
      const token = localStorage.getItem(TOKEN_KEY);
      // No token means the session is gone (logged out, or cleared by the 401 handler in
      // client.ts). Reconnecting would just be rejected at the upgrade, so stop.
      if (!token || cancelled) return;

      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        retryDelay = 1000;
        if (symbolsRef.current.length > 0) {
          ws.send(JSON.stringify({ type: "SUBSCRIBE", symbols: symbolsRef.current }));
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "TICK") {
          setTicks((prev) => ({ ...prev, [msg.symbol]: msg }));
        } else if (msg.type === "EVENT") {
          setLiveEvents((prev) => [msg, ...prev].slice(0, 20));
        } else if (msg.type === "PING") {
          ws.send(JSON.stringify({ type: "PONG" }));
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15_000);
      };
    }

    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, []);

  // Keep the server-side subscription in sync as the watchlist changes.
  useEffect(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && symbols.length > 0) {
      ws.send(JSON.stringify({ type: "SUBSCRIBE", symbols }));
    }
  }, [symbols]);

  return { ticks, liveEvents };
}
