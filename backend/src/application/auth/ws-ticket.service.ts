import { createHash, randomBytes } from "crypto";
import { redis } from "../../infrastructure/db/redis";
import type { JwtPayload } from "../../domain/auth/auth.types";

// Short-lived, single-use credentials for the WebSocket upgrade.
//
// The session JWT used to be the WS credential itself, passed as `?token=...` because a
// browser `WebSocket` cannot set an `Authorization` header. That put a seven-day bearer
// token into a URL, and URLs are the one part of a request that everything logs by
// default: access logs, proxy logs, `Referer` on any resource the page loads afterwards,
// shell history, error trackers. Anyone who could read a log line held a working session
// for a week.
//
// A ticket is the standard answer, and it removes the exposure rather than relocating it:
//
//   - it is minted only over an authenticated HTTP request, where the JWT travels in a
//     header as it always should;
//   - it lives for WS_TICKET_TTL_SECONDS, which is long enough to open a socket and
//     nothing else;
//   - it is redeemed exactly once — the upgrade that uses it destroys it — so a captured
//     ticket cannot even open a second connection;
//   - only its SHA-256 lands in Redis, so a Redis dump, replica, or RDB file on disk
//     contains nothing that can be replayed.
//
// The transport is the second half of the fix: ws.auth.ts reads the ticket from the
// `Sec-WebSocket-Protocol` header, so nothing at all is in the URL. Even so, the ticket
// is built to survive being logged — the two protections are independent on purpose.

export const WS_TICKET_TTL_SECONDS = 30;

// 32 random bytes, base64url-encoded. base64url matters: an HTTP subprotocol value must
// be a bare token, and standard base64's `+`, `/` and `=` are not.
const TICKET_BYTES = 32;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const KEY_PREFIX = "ws:ticket:";

function ticketKey(ticket: string): string {
  return KEY_PREFIX + createHash("sha256").update(ticket).digest("hex");
}

export async function issueWsTicket(auth: JwtPayload): Promise<{ ticket: string; expiresInSeconds: number }> {
  const ticket = randomBytes(TICKET_BYTES).toString("base64url");
  await redis.set(
    ticketKey(ticket),
    JSON.stringify({ userId: auth.userId, email: auth.email }),
    "EX",
    WS_TICKET_TTL_SECONDS,
  );
  return { ticket, expiresInSeconds: WS_TICKET_TTL_SECONDS };
}

// GETDEL, not GET-then-DEL: the read and the invalidation have to be one operation, or
// two upgrades racing the same captured ticket both read it before either deletes it and
// single-use silently becomes use-as-often-as-you-can-race.
export async function redeemWsTicket(ticket: string): Promise<JwtPayload | null> {
  // Checked before hashing so an arbitrarily long or oddly-shaped value is rejected
  // without doing any work on it.
  if (!TICKET_PATTERN.test(ticket)) return null;

  const raw = await redis.getdel(ticketKey(ticket));
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as JwtPayload;
    if (typeof parsed?.userId !== "string" || typeof parsed?.email !== "string") return null;
    return { userId: parsed.userId, email: parsed.email };
  } catch {
    return null;
  }
}
