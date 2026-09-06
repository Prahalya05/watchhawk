import type { IncomingMessage } from "http";
import { redeemWsTicket } from "../../application/auth/ws-ticket.service";
import type { JwtPayload } from "../../domain/auth/auth.types";

// The credential never appears in the URL.
//
// A browser `WebSocket` cannot set an `Authorization` header, which is why this used to
// read `?token=<session JWT>` from the query string. The subprotocol list is the one
// request header a browser WebSocket *does* let a page control — it is the second
// argument to the `WebSocket` constructor — so the ticket rides there instead. Nothing
// credential-shaped reaches the access log, the proxy log, or a `Referer`.
//
// The offered list is `[WS_TICKET_SUBPROTOCOL, "<ticket>"]`: a marker naming the scheme,
// followed by the ticket. The server selects the marker (see handleProtocols in
// ws.server.ts) because that is the only value in the list that is actually a protocol
// name — echoing the ticket back would put it in a response header, undoing the point.
export const WS_TICKET_SUBPROTOCOL = "grow.ws-ticket.v1";

// Subprotocol values are comma-separated in the header and may be split across repeated
// headers; Node presents repeated headers as an array. Both are flattened here so the
// parse does not depend on which shape a given proxy produced.
export function extractTicket(req: IncomingMessage): string | null {
  const header = req.headers["sec-websocket-protocol"];
  if (header === undefined) return null;

  const offered = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const markerIndex = offered.indexOf(WS_TICKET_SUBPROTOCOL);
  if (markerIndex === -1) return null;
  return offered[markerIndex + 1] ?? null;
}

// Returns the identity the ticket was minted for, and burns the ticket doing it. A
// rejected upgrade is indistinguishable from any other — expired, already redeemed,
// forged and absent all return null, because the client can do nothing different in any
// of those cases except ask for a new ticket.
export async function authenticateUpgrade(req: IncomingMessage): Promise<JwtPayload | null> {
  const ticket = extractTicket(req);
  if (ticket === null) return null;
  return redeemWsTicket(ticket);
}
