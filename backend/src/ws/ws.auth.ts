import type { IncomingMessage } from "http";
import { verifyToken } from "../modules/auth/auth.service";
import type { JwtPayload } from "../modules/auth/auth.types";

// Token-in-query-string: a browser WebSocket can't set an Authorization header, so the
// token travels as ?token=... instead. Known weaker pattern (can land in access logs) —
// acceptable for a local demo, flagged in the plan as not to carry beyond that.
export function authenticateUpgrade(req: IncomingMessage): JwtPayload | null {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    if (!token) return null;
    return verifyToken(token);
  } catch {
    return null;
  }
}
