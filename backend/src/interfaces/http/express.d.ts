import type { JwtPayload } from "../../domain/auth/auth.types";

// `req.auth` is populated by requireAuth (middleware/auth.middleware.ts) and read by the
// routes. The augmentation lives in the HTTP ring because it describes Express's Request,
// not the token: JwtPayload is a domain concept and stays in domain/auth/auth.types.ts,
// where it can be verified and signed without Express being installed at all.
declare global {
  namespace Express {
    interface Request {
      auth?: JwtPayload;
    }
  }
}
