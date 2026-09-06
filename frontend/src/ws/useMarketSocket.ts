import { useEffect, useRef, useState } from "react";
import { TOKEN_KEY } from "../api/client";
import { requestWsTicket } from "../api/auth.api";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000/ws";

// Must match WS_TICKET_SUBPROTOCOL in backend/src/interfaces/ws/ws.auth.ts. The socket
// authenticates with a single-use ticket carried in the subprotocol list rather than a
// token in the query string, so the session JWT never lands in a URL that some proxy,
// access log or error tracker will keep.
const WS_TICKET_SUBPROTOCOL = "grow.ws-ticket.v1";

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

export interface LiveEvent {
  symbol: string;
  eventType: string;
  severity: string;
  eventTime: string;
  payload: Record<string, unknown>;
  /** Client-assigned, so the activity feed has a stable key and arrival order. */
  receivedAt: string;
}

export type SocketStatus = "connecting" | "live" | "reconnecting";

// Merges live WS ticks over the last GET /watchlist snapshot on the dashboard — this
// hook only tracks the raw tick stream; the dashboard decides how to combine it with
// the diff response. It also surfaces its own connection state so the UI can show
// whether the prices on screen are actually flowing.
export function useMarketSocket(symbols: string[]) {
  const [ticks, setTicks] = useState<Record<string, LiveTick>>({});
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const symbolsRef = useRef<string[]>(symbols);
  symbolsRef.current = symbols;

  useEffect(() => {
    let cancelled = false;
    let retryDelay = 1000;

    function retryLater() {
      if (cancelled) return;
      setStatus("reconnecting");
      setTimeout(() => void connect(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15_000);
    }

    async function connect() {
      const token = localStorage.getItem(TOKEN_KEY);
      // No token means the session is gone (logged out, or cleared by the 401 handler in
      // client.ts). Reconnecting would just be rejected at the upgrade, so stop.
      if (!token || cancelled) return;

      // A fresh ticket per attempt, reconnects included: tickets are single-use and
      // expire in seconds, so the one that opened the previous socket is already dead.
      let ticket: string;
      try {
        ticket = await requestWsTicket();
      } catch {
        // A 401 here has already been handled by the client.ts interceptor, which clears
        // the token — so the guard above ends the loop on the next attempt rather than
        // this retry spinning forever against a dead session.
        retryLater();
        return;
      }
      if (cancelled) return;

      const ws = new WebSocket(WS_URL, [WS_TICKET_SUBPROTOCOL, ticket]);
      wsRef.current = ws;

      ws.onopen = () => {
        retryDelay = 1000;
        setStatus("live");
        if (symbolsRef.current.length > 0) {
          ws.send(JSON.stringify({ type: "SUBSCRIBE", symbols: symbolsRef.current }));
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        setLastMessageAt(Date.now());
        if (msg.type === "TICK") {
          setTicks((prev) => ({ ...prev, [msg.symbol]: msg }));
        } else if (msg.type === "EVENT") {
          setLiveEvents((prev) => [{ ...msg, receivedAt: new Date().toISOString() }, ...prev].slice(0, 30));
        } else if (msg.type === "PING") {
          ws.send(JSON.stringify({ type: "PONG" }));
        }
      };

      ws.onclose = () => retryLater();
    }

    void connect();
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

  return { ticks, liveEvents, status, lastMessageAt };
}
