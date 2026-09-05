import type { NextFunction, Request, Response } from "express";
import { TokenExpiredError, verifyToken } from "../../../application/auth/auth.service";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  // Scheme matching is case-insensitive per RFC 7235, and a client that sends the
  // literal string "Bearer null" (an absent token stringified) should read as missing
  // rather than as a malformed token.
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  const token = match?.[1]?.trim();
  if (!token || token === "null" || token === "undefined") {
    return res.status(401).json({ error: "MISSING_TOKEN" });
  }

  try {
    req.auth = verifyToken(token);
    next();
  } catch (err) {
    // Distinct codes so the client can drop an expired session and send the user to
    // the login page, instead of showing the same dead end for every 401.
    if (err instanceof TokenExpiredError) return res.status(401).json({ error: "TOKEN_EXPIRED" });
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }
}
