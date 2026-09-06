import { z } from "zod";
import { SYMBOL_MAP } from "../../domain/market/symbol-universe";

// A socket carries exactly as much trust as an HTTP body — none. Every route validates
// with zod before touching a field; this boundary did not, and `ClientMessage` being a
// *type* made that invisible: `JSON.parse(raw) as ClientMessage` compiles cleanly and
// asserts nothing at runtime. `{"type":"SUBSCRIBE","symbols":5}` then reached
// `for (const s of msg.symbols)`, and the TypeError escaped the "message" listener —
// ws does not wrap its emit — into an uncaught exception that took the process down.
//
// So the schema is the type now (`z.infer` below), and there is no way to add a field
// to the protocol without also saying how it is validated.

// One connection cannot want more symbols than exist. Without a ceiling, SUBSCRIBE is an
// append-only write into a process-lifetime Map: a client sending fresh strings in a loop
// grows subscribersBySymbol until the process dies, and no single message looks abusive.
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = SYMBOL_MAP.size;

// Unknown tickers are dropped rather than rejected. A watchlist can legitimately hold a
// symbol that has left the universe (see the DELISTED path in watchlist.service.ts), so
// the client re-sending its whole list is normal traffic, not an attack — failing the
// message would break subscription for every other symbol in it. GET /watchlist is where
// the user is told that ticker is gone.
const symbolList = z.array(z.string().max(32)).max(MAX_SUBSCRIPTIONS_PER_CONNECTION);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SUBSCRIBE"), symbols: symbolList }),
  z.object({ type: z.literal("UNSUBSCRIBE"), symbols: symbolList }),
  z.object({ type: z.literal("PONG") }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface ParsedClientMessage {
  message: ClientMessage;
  /** Requested symbols that are in the universe, upper-cased and de-duplicated. */
  knownSymbols: string[];
}

/**
 * The whole client-input surface of the WebSocket, in one pure function: parse, validate,
 * normalise. Returns null for anything malformed, so the caller has one branch rather
 * than a try/catch around every field access.
 */
export function parseClientMessage(raw: string): ParsedClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) return null;

  const message = parsed.data;
  if (message.type === "PONG") return { message, knownSymbols: [] };

  // Upper-cased before the universe check, not after: the client sends whatever the user
  // typed, and "infy" is the same subscription as "INFY". De-duplicated because a list
  // with the same symbol twice would otherwise count twice against the cap.
  const knownSymbols = [...new Set(message.symbols.map((s) => s.toUpperCase()))].filter((s) => SYMBOL_MAP.has(s));
  return { message, knownSymbols };
}

export type ServerMessage =
  | { type: "SUBSCRIBED"; symbols: string[] }
  | {
      type: "TICK";
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
  | {
      type: "EVENT";
      symbol: string;
      eventType: string;
      severity: string;
      eventTime: string;
      payload: Record<string, unknown>;
    }
  | { type: "PING" }
  | { type: "ERROR"; message: string };
