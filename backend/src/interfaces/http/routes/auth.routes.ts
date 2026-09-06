import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../async-handler";
import { requireAuth } from "../middleware/auth.middleware";
import {
  EmailTakenError,
  InvalidCredentialsError,
  getUserById,
  loginUser,
  registerUser,
} from "../../../application/auth/auth.service";
import { issueWsTicket } from "../../../application/auth/ws-ticket.service";

export const authRouter = Router();

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  // bcrypt hashes at most the first 72 bytes and silently discards the rest, which
  // would make two different long passwords interchangeable at login. Rejecting them
  // is honest; truncating them is not.
  password: z.string().min(8, "Password must be at least 8 characters").max(72),
});

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }

    try {
      const result = await registerUser(parsed.data.email, parsed.data.password);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof EmailTakenError) return res.status(409).json({ error: "EMAIL_TAKEN" });
      throw err;
    }
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    // Login deliberately does not echo field-level validation: which half of the pair
    // was malformed is information about the account, and the client has nothing useful
    // to do with it beyond "these credentials don't work".
    if (!parsed.success) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

    try {
      const result = await loginUser(parsed.data.email, parsed.data.password);
      res.json(result);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
      throw err;
    }
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await getUserById(req.auth!.userId);
    // A signature-valid token for a deleted user is an unusable session, so it gets the
    // same 401 the client already knows how to clear rather than a 404 it would treat
    // as a transient fetch failure and keep retrying with.
    if (!user) return res.status(401).json({ error: "USER_NOT_FOUND" });
    res.json(user);
  }),
);

// Mints the credential the WebSocket upgrade actually uses. POST rather than GET because
// each call creates something: a GET that mints a single-use secret is cacheable by
// anything between here and the client, and browsers prefetch GETs.
//
// This is the whole reason the session JWT no longer travels in the socket's URL — the
// exchange happens here, over a normal authenticated request where the token sits in an
// Authorization header. The response is explicitly uncacheable for the same reason the
// method is POST.
authRouter.post(
  "/ws-ticket",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ticket = await issueWsTicket(req.auth!);
    res.set("Cache-Control", "no-store");
    res.status(201).json(ticket);
  }),
);
