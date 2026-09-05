import { prisma } from "../src/db/prisma";
import { redis } from "../src/db/redis";
import { backfillUniverse } from "../src/market-data/historical-backfill";

// Whole-universe warm-up, run explicitly via `npm run seed` right after a fresh
// `prisma migrate dev`, so SymbolStats is populated before the first `npm run dev`.
//
// Deliberately the universe-wide variant, not the one server.ts runs on boot: that one
// covers only symbols someone is actually watching (and a symbol gains its history the
// moment it is added), which on a fresh database is none at all. Here the whole point is
// to pay that cost up front, once, on purpose.
async function main() {
  console.log("Backfilling historical bars + SymbolStats for the symbol universe...");
  await backfillUniverse();
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  // Both clients have to be closed explicitly: ioredis keeps an open socket and
  // therefore the event loop alive, so disconnecting Prisma alone leaves this script
  // hanging after it prints "Done." instead of exiting.
  .finally(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });
