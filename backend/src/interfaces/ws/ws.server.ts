import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { authenticateUpgrade } from "./ws.auth";
import { subscribeToChannels, CHANNELS } from "../../infrastructure/pubsub/redis-pubsub";
import type { ClientMessage, ServerMessage } from "./ws.protocol";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;
const TICK_THROTTLE_MS = 1_000;

interface ConnectionState {
  socket: WebSocket;
  subscribedSymbols: Set<string>;
  lastPongAt: number;
  lastTickSentAt: Map<string, number>;
}

// One server-side Redis subscription to market:ticks/market:events for the whole
// process, fanned out in-process to each connection's own subscribed-symbol set
// (normally just that client's watchlist) — per the plan, this avoids one Redis
// subscription per symbol or per connection.
export function attachWsServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<ConnectionState>();

  // Reverse index: symbol -> the connections watching it. Fan-out used to walk every
  // open connection for every tick and ask "is this symbol in your set?", which is
  // O(connections) per tick — and ticks arrive per symbol per poll cycle, so the cost
  // was (connections x symbols) while the answer is almost always "no". Looking the
  // symbol up directly makes it O(interested connections), which is what actually gets
  // sent anyway. connections stays the authority on liveness; this only routes.
  const subscribersBySymbol = new Map<string, Set<ConnectionState>>();

  function addSubscription(conn: ConnectionState, symbol: string): void {
    conn.subscribedSymbols.add(symbol);
    let subscribers = subscribersBySymbol.get(symbol);
    if (!subscribers) subscribersBySymbol.set(symbol, (subscribers = new Set()));
    subscribers.add(conn);
  }

  function removeSubscription(conn: ConnectionState, symbol: string): void {
    conn.subscribedSymbols.delete(symbol);
    const subscribers = subscribersBySymbol.get(symbol);
    if (!subscribers) return;
    subscribers.delete(conn);
    // Dropped when empty, or the index would grow monotonically with every symbol ever
    // subscribed to and never shrink for the life of the process.
    if (subscribers.size === 0) subscribersBySymbol.delete(symbol);
  }

  // Every path that stops serving a connection goes through here, so the index can never
  // keep a terminated socket alive as a phantom subscriber.
  function dropConnection(conn: ConnectionState): void {
    for (const symbol of conn.subscribedSymbols) {
      const subscribers = subscribersBySymbol.get(symbol);
      if (!subscribers) continue;
      subscribers.delete(conn);
      if (subscribers.size === 0) subscribersBySymbol.delete(symbol);
    }
    conn.subscribedSymbols.clear();
    connections.delete(conn);
  }

  httpServer.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) return;

    const auth = authenticateUpgrade(req);
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    const conn: ConnectionState = {
      socket: ws,
      subscribedSymbols: new Set(),
      lastPongAt: Date.now(),
      lastTickSentAt: new Map(),
    };
    connections.add(conn);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "ERROR", message: "INVALID_JSON" });
      }

      if (msg.type === "SUBSCRIBE") {
        for (const s of msg.symbols) addSubscription(conn, s.toUpperCase());
        send(ws, { type: "SUBSCRIBED", symbols: [...conn.subscribedSymbols] });
      } else if (msg.type === "UNSUBSCRIBE") {
        for (const s of msg.symbols) removeSubscription(conn, s.toUpperCase());
      } else if (msg.type === "PONG") {
        conn.lastPongAt = Date.now();
      }
    });

    ws.on("close", () => dropConnection(conn));
  });

  const pingHandle = setInterval(() => {
    const now = Date.now();
    for (const conn of connections) {
      if (now - conn.lastPongAt > PONG_TIMEOUT_MS) {
        conn.socket.terminate();
        dropConnection(conn);
        continue;
      }
      send(conn.socket, { type: "PING" });
    }
  }, PING_INTERVAL_MS);

  const subscriber = subscribeToChannels([CHANNELS.TICKS, CHANNELS.EVENTS], (channel, payload) => {
    const data = payload as { symbol: string };
    const now = Date.now();
    const subscribers = subscribersBySymbol.get(data.symbol);
    if (!subscribers) return;

    for (const conn of subscribers) {
      if (channel === CHANNELS.TICKS) {
        const lastSent = conn.lastTickSentAt.get(data.symbol) ?? 0;
        if (now - lastSent < TICK_THROTTLE_MS) continue;
        conn.lastTickSentAt.set(data.symbol, now);
        send(conn.socket, { type: "TICK", ...(payload as Omit<ServerMessage & { type: "TICK" }, "type">) });
      } else {
        send(conn.socket, { type: "EVENT", ...(payload as Omit<ServerMessage & { type: "EVENT" }, "type">) });
      }
    }
  });

  wss.on("close", () => {
    clearInterval(pingHandle);
    subscriber.disconnect();
  });

  return wss;
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
