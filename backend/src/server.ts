import { createServer } from "http";
import { createApp } from "./interfaces/http/app";
import { env, effectiveMarketDataMode } from "./config/env";
import { prisma } from "./infrastructure/db/prisma";
import { reconcileRefcountsFromDatabase } from "./application/ingestion/subscription-manager";
import { backfillMissingHistory } from "./application/market-data/historical-backfill";
import { compositeProvider } from "./application/market-data/composite-provider";
import { attachWsServer } from "./interfaces/ws/ws.server";
import { startScheduledJobs } from "./application/jobs/scheduler";

async function main() {
  await prisma.$connect();

  // Required startup step, not optional polish: Redis holds no durable state, so
  // refcounts must be rebuilt from the durable WatchlistItem table on every boot, or the
  // shared-cache "only poll watched symbols" architecture silently breaks after any
  // Redis restart. startScheduledJobs() below repeats it periodically, for drift that
  // appears while the process is up rather than across a restart.
  await reconcileRefcountsFromDatabase();

  // Replay-mode backfill is synthetic and instant, so it's awaited — the app is fully
  // seeded before it serves a single request. Live-mode backfill fetches from Yahoo
  // through the same client-side rate limiter the poll loop uses, so it can still take a
  // while across a large watchlist; it is kicked off after listen() below instead of
  // holding the port closed that whole time. Both paths cover only watched symbols
  // (see historical-backfill.ts); `npm run seed` is the whole-universe warm-up.
  if (effectiveMarketDataMode === "replay") {
    await backfillMissingHistory();
  }

  const app = createApp();
  const httpServer = createServer(app);
  attachWsServer(httpServer);

  // Claim the port BEFORE starting ingestion. market:state is shared mutable state, so a
  // second instance polling into the same Redis is not a harmless duplicate — it fights
  // the first one, and if its code is any older it overwrites live prices with stale
  // ones. That is not hypothetical: a leftover instance from an earlier run kept polling
  // for over an hour after losing the port, writing prices from a superseded symbol
  // universe, and the dashboard showed the two writers' values alternating.
  //
  // Binding first makes the port the mutex: exactly one instance can own ingestion,
  // and a duplicate exits immediately instead of quietly corrupting the cache.
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(env.PORT, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  console.log(`[server] listening on http://localhost:${env.PORT} (market data mode: ${effectiveMarketDataMode})`);

  await compositeProvider.start(env.MARKET_POLL_INTERVAL_MS);
  startScheduledJobs();

  if (effectiveMarketDataMode === "live") {
    console.log("[server] starting background historical backfill");
    backfillMissingHistory().catch((err) => console.error("[server] background history backfill failed:", err));
  }
}

// Last line of defence, not a substitute for handling errors where they happen. Node's
// default for an uncaught exception is to print and exit, which is the right outcome —
// this only makes the exit deliberate and legible, so a crash leaves a labelled line in
// the log rather than a bare stack trace. An unhandled rejection is not treated as fatal
// for the same reason the poll loop catches per-provider: a vendor call that rejects
// somewhere unawaited should not take ingestion down with it.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception — exiting:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled promise rejection:", reason);
});

main().catch((err: NodeJS.ErrnoException) => {
  if (err?.code === "EADDRINUSE") {
    console.error(
      `[server] port ${env.PORT} is already in use — another instance is running. ` +
        `Exiting rather than starting a second ingestion loop against the same Redis.`,
    );
  } else {
    console.error("[server] fatal startup error:", err);
  }
  process.exit(1);
});
