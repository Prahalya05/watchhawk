import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "stream";
import { WS_TICKET_SUBPROTOCOL, authenticateUpgrade } from "./ws.auth";
import { subscribeToChannels, CHANNELS } from "../../infrastructure/pubsub/redis-pubsub";
import { MAX_SUBSCRIPTIONS_PER_CONNECTION, parseClientMessage, type ServerMessage } from "./ws.protocol";

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
// (normally just that client's watchlist). This avoids one Redis subscription per
// symbol or per connection.
export function attachWsServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    // The client offers [marker, ticket]; the server selects the marker. A server that
    // selects nothing makes the browser close the connection immediately, so this is
    // also the check that rejects a client which never offered the scheme at all.
    // Selecting the marker rather than the ticket keeps the ticket out of the response
    // headers — echoing it back would re-expose exactly what moving it out of the URL
    // was meant to prevent.
    handleProtocols: (protocols) => (protocols.has(WS_TICKET_SUBPROTOCOL) ? WS_TICKET_SUBPROTOCOL : false),
  });
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
    // Cleared with the subscription, not just on disconnect. It is only a throttle
    // bookkeeping entry, but it is keyed by symbol and lives as long as the connection,
    // so a client that cycles through symbols accumulates one entry per symbol it has
    // ever been sent a tick for.
    conn.lastTickSentAt.delete(symbol);
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

  // Authentication is asynchronous now — redeeming a single-use ticket is a Redis round
  // trip — so the handler hands the socket to an async task rather than deciding inline.
  // Two things that were free while it was synchronous have to be paid for explicitly:
  // the socket needs an "error" listener for the duration of the await (a raw socket that
  // emits "error" with no listener throws, and that is an uncaught exception in the
  // upgrade path), and it may have been closed by the client before the await resolves.
  httpServer.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) return;

    const onEarlyError = () => socket.destroy();
    socket.on("error", onEarlyError);

    void (async () => {
      let auth = null;
      try {
        auth = await authenticateUpgrade(req);
      } catch (err) {
        // A Redis outage must not take the process down through an unhandled rejection
        // here. It fails closed: no identity, no upgrade.
        console.error("[ws] upgrade authentication failed", err);
      }

      if (socket.destroyed) return;
      socket.off("error", onEarlyError);

      if (!auth) {
        rejectUpgrade(socket);
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    })();
  });

  wss.on("connection", (ws) => {
    const conn: ConnectionState = {
      socket: ws,
      subscribedSymbols: new Set(),
      lastPongAt: Date.now(),
      lastTickSentAt: new Map(),
    };
    connections.add(conn);

    // The try/catch is the outer guard, not the validation. ws emits "message" with no
    // error handling of its own, so anything thrown in here leaves as an uncaught
    // exception and ends the process — one malformed frame from one client would
    // disconnect every other client. A bad message is that client's problem.
    ws.on("message", (raw) => {
      try {
        const parsed = parseClientMessage(raw.toString());
        if (!parsed) return send(ws, { type: "ERROR", message: "INVALID_MESSAGE" });

        const { message, knownSymbols } = parsed;
        if (message.type === "SUBSCRIBE") {
          for (const symbol of knownSymbols) {
            if (conn.subscribedSymbols.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) break;
            addSubscription(conn, symbol);
          }
          // Echoes what is actually subscribed, not what was asked for: a client whose
          // watchlist holds a delisted ticker learns it was dropped from the reply rather
          // than waiting for ticks that will never arrive.
          send(ws, { type: "SUBSCRIBED", symbols: [...conn.subscribedSymbols] });
        } else if (message.type === "UNSUBSCRIBE") {
          for (const symbol of knownSymbols) removeSubscription(conn, symbol);
        } else {
          conn.lastPongAt = Date.now();
        }
      } catch (err) {
        console.error("[ws] message handler failed", err);
        send(ws, { type: "ERROR", message: "INVALID_MESSAGE" });
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

// A complete HTTP response, not a bare status line. Without Connection: close and a
// Content-Length, a browser is left waiting on a response body that never arrives and
// reports a generic network failure rather than a 401 — which is the difference between
// "your ticket expired, get another" and "the server is down".
function rejectUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\n" + "Connection: close\r\n" + "Content-Length: 0\r\n" + "\r\n");
  socket.destroy();
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
