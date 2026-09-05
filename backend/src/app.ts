import express from "express";
import cors from "cors";
import { effectiveMarketDataMode } from "./config/env";
import { authRouter } from "./modules/auth/auth.routes";
import { watchlistRouter } from "./modules/watchlist/watchlist.routes";
import { symbolsRouter } from "./modules/symbols/symbols.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { assistantRouter } from "./modules/assistant/assistant.routes";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", marketDataMode: effectiveMarketDataMode });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/watchlist", watchlistRouter);
  app.use("/api/symbols", symbolsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/assistant", assistantRouter);

  // Unknown /api paths get JSON, not Express's HTML "Cannot POST /api/..." page — the
  // client parses every API response as JSON, and an HTML body there surfaces as a
  // confusing parse error rather than "that endpoint doesn't exist".
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // express.json() rejects a malformed body by throwing here. That is the client's
    // mistake, not the server's, and reporting it as 500 sends the client retrying
    // against a server that is working fine.
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "INVALID_JSON" });
    }
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}
