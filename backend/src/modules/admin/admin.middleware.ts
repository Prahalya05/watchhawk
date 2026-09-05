import { createHash, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../../config/env";

// Admin demo-trigger endpoints are guarded by a shared secret, not a user JWT — this is
// operator/presenter tooling, not a user-facing feature. Checked from day one per plan
// gap #7 (easy to forget since it's "just for the demo," but it's an open door otherwise).

// Compared through fixed-width SHA-256 digests rather than `!==`. Two reasons: string
// comparison short-circuits at the first differing byte, which leaks how much of a guess
// was right, and timingSafeEqual itself throws on length mismatch, which would leak the
// secret's length. Hashing first makes both operands 32 bytes whatever was submitted.
const expectedDigest = createHash("sha256").update(env.ADMIN_KEY).digest();

export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header("X-Admin-Key");
  if (!key) return res.status(401).json({ error: "INVALID_ADMIN_KEY" });

  const providedDigest = createHash("sha256").update(key).digest();
  if (!timingSafeEqual(providedDigest, expectedDigest)) {
    return res.status(401).json({ error: "INVALID_ADMIN_KEY" });
  }
  next();
}
