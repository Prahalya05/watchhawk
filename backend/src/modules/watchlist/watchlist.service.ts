import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { SYMBOL_MAP } from "../../market-data/symbol-universe";
import { readMarketState, readMarketStates } from "../../market-data/read-state";
import { subscribe, unsubscribe } from "../../ingestion/subscription-manager";
import { seedMarketStateFromHistory } from "../../ingestion/market-state-writer";
import { ensureHistory } from "../../market-data/historical-backfill";
import { getMarketStatus } from "../../market-data/staleness";
import { computeSymbolDiff, rankEntries } from "../diff/diff.engine";
import type { DiscreteEventInput, EventExplanation } from "../diff/diff.types";
import { AlreadyWatchedError, NotWatchedError, UnknownSymbolError, type WatchlistItemDto } from "./watchlist.types";

export async function listItems(userId: string): Promise<WatchlistItemDto[]> {
  const items = await prisma.watchlistItem.findMany({ where: { userId }, orderBy: { addedAt: "asc" } });
  return items.map((i) => ({ symbol: i.symbol, addedAt: i.addedAt.toISOString() }));
}

export async function addItem(userId: string, symbol: string): Promise<WatchlistItemDto> {
  if (!SYMBOL_MAP.has(symbol)) throw new UnknownSymbolError();

  // Startup backfill only covers symbols that were already watched, so a symbol being
  // added for the first time may have no cached history at all — and with no history
  // there are no SymbolStats, which means no volatility to score against. Fetched here
  // instead of at boot for the whole universe: this is the moment demand actually
  // exists. A no-op (one ZCARD) once the symbol has history.
  await ensureHistory(symbol);

  // A symbol nobody was watching has no market:state (nothing polls it at refcount 0),
  // and without state its row reads as "no data yet" — so seed from the last cached bar.
  // That also gives the baseline below a real previous close to diff against instead of
  // a meaningless zero.
  await seedMarketStateFromHistory(symbol);

  // Baseline is snapshotted at add time, from whatever's currently in market:state
  // (falling back to neutral zeros if the symbol hasn't ticked yet) — this is what
  // guarantees "no phantom diff on first view" with no null-baseline branch anywhere
  // else in the diff path.
  const state = await readMarketState(symbol);
  const stats = await prisma.symbolStats.findUnique({ where: { symbol } });

  // No upfront existence check — a check-then-create here would race two concurrent
  // requests (e.g. a double-click) straight past it, since neither sees the other's
  // row before both attempt to create. The unique constraint on (userId, symbol) is
  // the actual source of truth; catching its violation (P2002) is what turns that
  // race into a clean 409 instead of an unhandled 500.
  let item;
  try {
    item = await prisma.$transaction(async (tx) => {
      const created = await tx.watchlistItem.create({ data: { userId, symbol } });
      await tx.userSymbolState.create({
        data: {
          userId,
          symbol,
          lastSeenAt: new Date(),
          lastSeenPrice: state?.price ?? 0,
          lastSeenVolume: state?.volume ?? 0,
          lastSeen52wHigh: stats?.high52w ?? state?.price ?? 0,
          lastSeen52wLow: stats?.low52w ?? state?.price ?? 0,
        },
      });
      return created;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AlreadyWatchedError();
    }
    throw err;
  }

  await subscribe(symbol);
  return { symbol: item.symbol, addedAt: item.addedAt.toISOString() };
}

export async function removeItem(userId: string, symbol: string): Promise<void> {
  // Same reasoning as addItem: rely on the delete itself failing (P2025, "record not
  // found") rather than a separate existence check that a concurrent remove could
  // race past.
  try {
    await prisma.$transaction([
      prisma.watchlistItem.delete({ where: { userId_symbol: { userId, symbol } } }),
      prisma.userSymbolState.delete({ where: { userId_symbol: { userId, symbol } } }),
    ]);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw new NotWatchedError();
    }
    throw err;
  }

  await unsubscribe(symbol);
}

// Why a row cannot be diffed, when it can't. DELISTED means the symbol is gone from
// SYMBOL_UNIVERSE entirely — the app's own README names two real cases (Zomato renamed
// to ETERNAL, Tata Motors demerged into TMPV), and a watchlist created before such a
// change still points at the old ticker. NO_DATA means the symbol is still known but has
// no market state or stats cached yet.
export type UnavailableReason = "DELISTED" | "NO_DATA";

export interface WatchlistUnavailable {
  reason: UnavailableReason;
  message: string;
}

export interface WatchlistDiffResponse {
  generatedAt: string;
  marketStatus: "OPEN" | "CLOSED";
  entries: Array<{
    symbol: string;
    name: string;
    current: {
      price: number;
      changePct: number;
      volume: number;
      source: string;
      mode: string;
      isStale: boolean;
      isDivergent: boolean;
      divergencePct: number | null;
    };
    // null on a normal row. Non-null means the numbers alongside it are placeholders and
    // the UI must say so rather than render a confident ₹0.00.
    unavailable: WatchlistUnavailable | null;
    maxSeverity: string;
    eventCount: number;
    overflow: boolean;
    events: Array<{
      type: string;
      severity: string;
      occurredAt: string;
      detail: Record<string, unknown>;
      explanation: EventExplanation;
    }>;
  }>;
}

// READ-ONLY — no writes anywhere in this function. Computes the diff fresh every call;
// only POST /watchlist/ack (below) advances a user's last-seen baseline. Keeping this
// split is what makes "return later and see what's changed" survive a page refresh.
export async function getWatchlistDiff(userId: string): Promise<WatchlistDiffResponse> {
  const items = await prisma.watchlistItem.findMany({ where: { userId } });
  if (items.length === 0) {
    return { generatedAt: new Date().toISOString(), marketStatus: getMarketStatus(), entries: [] };
  }

  const symbols = items.map((i) => i.symbol);
  const [states, statsRows, userStates, discreteEventRows] = await Promise.all([
    readMarketStates(symbols),
    prisma.symbolStats.findMany({ where: { symbol: { in: symbols } } }),
    prisma.userSymbolState.findMany({ where: { userId, symbol: { in: symbols } } }),
    prisma.symbolEvent.findMany({
      where: { symbol: { in: symbols } },
      orderBy: { eventTime: "desc" },
      take: 500, // bounded scan; per-symbol filtering against each baseline happens below
    }),
  ]);

  const statsBySymbol = new Map(statsRows.map((s) => [s.symbol, s]));
  const userStateBySymbol = new Map(userStates.map((u) => [u.symbol, u]));
  const eventsBySymbol = new Map<string, DiscreteEventInput[]>();
  for (const row of discreteEventRows) {
    const list = eventsBySymbol.get(row.symbol) ?? [];
    list.push({
      eventType: row.eventType as DiscreteEventInput["eventType"],
      severity: row.severity as DiscreteEventInput["severity"],
      eventTime: row.eventTime,
      payload: row.payload as Record<string, unknown>,
    });
    eventsBySymbol.set(row.symbol, list);
  }

  const entries = items.map((item) => {
    const state = states.get(item.symbol);
    const stats = statsBySymbol.get(item.symbol);
    const userState = userStateBySymbol.get(item.symbol);
    const def = SYMBOL_MAP.get(item.symbol);

    // These rows used to be dropped on the floor. Dropping them is the worst available
    // answer: the user added the symbol deliberately, and a watchlist that quietly
    // shortens itself looks like it is working. Say what happened instead — a row the
    // user can see is a row the user can remove.
    if (!def) return unavailableEntry(item.symbol, item.symbol, "DELISTED");
    if (!state || !stats || !userState) return unavailableEntry(item.symbol, def.name, "NO_DATA");

    const relevantEvents = (eventsBySymbol.get(item.symbol) ?? []).filter(
      (e) => e.eventTime.getTime() > userState.lastSeenAt.getTime()
    );

    // stats is the Prisma row, which already carries computedAt/historyDays — passing
    // it straight through is what lets the explanation say how old the baseline it
    // scored against actually is, instead of quietly implying it is current.
    const diff = computeSymbolDiff(state, stats, userState, relevantEvents);

    return {
      symbol: item.symbol,
      name: def.name,
      current: {
        price: state.price,
        changePct: state.prevClose > 0 ? ((state.price - state.prevClose) / state.prevClose) * 100 : 0,
        volume: state.volume,
        source: state.source,
        mode: state.mode,
        isStale: state.isStale,
        isDivergent: state.isDivergent,
        divergencePct: state.divergencePct,
      },
      unavailable: null,
      ...diff,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    marketStatus: getMarketStatus(),
    entries: rankEntries(entries),
  };
}

const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
  DELISTED:
    "This ticker is no longer in the tracked universe — it was most likely renamed or delisted (for example Zomato became ETERNAL). Nothing is being priced for it; remove it and add the current ticker.",
  NO_DATA:
    "No market data cached for this symbol yet. It should fill in on the next poll cycle; if it doesn't, nothing is currently pricing it.",
};

// Placeholder numbers rather than a partial shape, so the row keeps the same contract as
// every other row and the client needs no separate branch to render it. `unavailable`
// being non-null is what tells the UI the numbers mean nothing — and maxSeverity stays
// NONE so an undiffable row never outranks a real change in rankEntries.
function unavailableEntry(symbol: string, name: string, reason: UnavailableReason) {
  return {
    symbol,
    name,
    current: {
      price: 0,
      changePct: 0,
      volume: 0,
      source: "NONE",
      mode: "NONE",
      isStale: true,
      isDivergent: false,
      divergencePct: null,
    },
    unavailable: { reason, message: UNAVAILABLE_MESSAGES[reason] },
    maxSeverity: "NONE" as const,
    eventCount: 0,
    overflow: false,
    events: [],
  };
}

// The only mutating step in the read/ack split. Server-clock timestamp only — never
// client-supplied — so concurrent devices trivially converge to max(lastSeenAt)
// without any conflict-resolution logic.
export async function ackSymbols(userId: string, symbols: string[] | "ALL"): Promise<{ acked: string[]; ackedAt: string }> {
  const targetSymbols =
    symbols === "ALL" ? (await prisma.watchlistItem.findMany({ where: { userId } })).map((i) => i.symbol) : symbols;
  if (targetSymbols.length === 0) return { acked: [], ackedAt: new Date().toISOString() };

  const [states, statsRows] = await Promise.all([
    readMarketStates(targetSymbols),
    prisma.symbolStats.findMany({ where: { symbol: { in: targetSymbols } } }),
  ]);
  const statsBySymbol = new Map(statsRows.map((s) => [s.symbol, s]));
  const now = new Date();

  // updateMany rather than update: a symbol the client thinks it's acking may have
  // just been removed from the watchlist concurrently (or was never actually watched,
  // e.g. a stale client-side list) — updateMany silently matches zero rows in that
  // case instead of update's P2025, which would otherwise fail every other symbol in
  // this same batch too since $transaction is all-or-nothing.
  await prisma.$transaction(
    targetSymbols.map((symbol) => {
      const state = states.get(symbol);
      const stats = statsBySymbol.get(symbol);
      return prisma.userSymbolState.updateMany({
        where: { userId, symbol },
        data: {
          lastSeenAt: now,
          lastSeenPrice: state?.price ?? 0,
          lastSeenVolume: state?.volume ?? 0,
          lastSeen52wHigh: stats?.high52w ?? 0,
          lastSeen52wLow: stats?.low52w ?? 0,
        },
      });
    })
  );

  return { acked: targetSymbols, ackedAt: now.toISOString() };
}
