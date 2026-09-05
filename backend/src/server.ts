import { createServer } from "http";
import { createApp } from "./interfaces/http/app";
import { env, effectiveMarketDataMode } from "./config/env";
import { prisma } from "./infrastructure/db/prisma";
import { reconcileRefcounts } from "./application/ingestion/subscription-manager";
import { backfillMissingHistory } from "./application/market-data/historical-backfill";
import { compositeProvider } from "./application/market-data/composite-provider";
import { attachWsServer } from "./interfaces/ws/ws.server";
import { startScheduledJobs } from "./application/jobs/scheduler";

async function main() {
  await prisma.$connect();

  // Required startup step, not optional polish (plan gap #5/#2): Redis holds no
  // durable state, so refcounts must be rebuilt from the durable WatchlistItem table
  // on every boot, or the shared-cache "only poll watched symbols" architecture
  // silently breaks after any Redis restart.
  const grouped = await prisma.watchlistItem.groupBy({ by: ["symbol"], _count: { symbol: true } });
  await reconcileRefcounts(new Map(grouped.map((g) => [g.symbol, g._count.symbol])));

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
