import type { Prisma } from "@prisma/client";
import { redis } from "../../infrastructure/db/redis";
import { prisma } from "../../infrastructure/db/prisma";
import { effectiveMarketDataMode } from "../../config/env";
import { publish, CHANNELS } from "../../infrastructure/pubsub/redis-pubsub";
import { checkDivergence } from "../../domain/market/divergence";
import { getMarketStatus } from "../market-data/staleness";
import { drainCommands } from "../../infrastructure/market-data/command-queue";
import { SESSION_LENGTH_MS } from "../../infrastructure/market-data/providers/virtual-clock";
import type { Quote } from "../../domain/ports/market-data.port";

const STATE_PREFIX = "market:state:";
const NOMINAL_LIVE_SESSION_MS = 6.25 * 60 * 60 * 1000; // NSE: 9:15-15:30 IST

// The single writer every provider funnels through (per the plan: "consistent
// event-detection logic no matter the data source"). It applies any pending admin
// commands, checks for genuine 52-week extremes against the durable SymbolStats table,
// writes the Redis hash, and publishes to subscribers — all in one place.
export async function writeMarketState(primary: Quote, secondary: Quote | null): Promise<void> {
  const symbol = primary.symbol;
  const commands = drainCommands(symbol);

  let effectivePrimary = primary;
  let effectiveSecondary = secondary;
  let forcedDivergence: { isDivergent: boolean; divergencePct: number } | null = null;

  for (const cmd of commands) {
    if (cmd.type === "VOLUME_SPIKE") {
      effectivePrimary = { ...effectivePrimary, volume: effectivePrimary.volume * 4 };
    } else if (cmd.type === "GAP_OPEN") {
      const direction = Math.random() > 0.5 ? 1 : -1;
      const dayOpen = effectivePrimary.price * (1 + direction * 0.03);
      effectivePrimary = { ...effectivePrimary, dayOpen, prevClose: effectivePrimary.price };
    } else if (cmd.type === "FIFTY_TWO_WEEK_EXTREME") {
      const direction = cmd.payload?.direction === "LOW" ? -1 : 1;
      effectivePrimary = { ...effectivePrimary, price: effectivePrimary.price * (1 + direction * 0.05) };
    } else if (cmd.type === "DIVERGE") {
      const fabricatedSecondaryPrice = effectivePrimary.price * (1 + (Math.random() > 0.5 ? 1 : -1) * 0.03);
      effectiveSecondary = { ...effectivePrimary, price: fabricatedSecondaryPrice, source: effectiveSecondary?.source ?? "YAHOO" };
      forcedDivergence = {
        isDivergent: true,
        divergencePct: Math.abs(effectivePrimary.price - fabricatedSecondaryPrice) / effectivePrimary.price,
      };
    } else if (cmd.type === "NEWS" || cmd.type === "RATING_CHANGE" || cmd.type === "CORPORATE_ACTION") {
      await writeDiscreteEvent(symbol, cmd.type, cmd.severity ?? "NOTABLE", cmd.payload ?? {});
    }
  }

  const divergence = forcedDivergence
    ? { ...forcedDivergence, primaryPrice: effectivePrimary.price, secondaryPrice: effectiveSecondary?.price ?? null }
    : checkDivergence(effectivePrimary, effectiveSecondary);

  await checkFiftyTwoWeekExtreme(symbol, effectivePrimary.price);

  const now = Date.now();

  // Detect a new trading session by comparing dayOpen to what was last stored — this
  // works uniformly whether the quote came from replay's own session clock or a real
  // provider's daily figures, without either provider needing to expose a timestamp.
  const previous = await redis.hmget(STATE_PREFIX + symbol, "dayOpen", "sessionOpenedAt");
  const previousDayOpen = previous[0] ? parseFloat(previous[0]) : null;
  const sessionOpenedAt =
    previousDayOpen === null || Math.abs(previousDayOpen - effectivePrimary.dayOpen) > 1e-9
      ? now
      : parseInt(previous[1] ?? String(now), 10);

  const isReplay = effectivePrimary.source === "REPLAY";
  const sessionLengthMs = isReplay ? SESSION_LENGTH_MS : NOMINAL_LIVE_SESSION_MS;
  const sessionElapsedFraction = Math.min(1, Math.max((now - sessionOpenedAt) / sessionLengthMs, 0.01));

  await redis.hset(STATE_PREFIX + symbol, {
    price: effectivePrimary.price,
    primarySource: effectivePrimary.source,
    primaryPrice: effectivePrimary.price,
    secondaryPrice: divergence.secondaryPrice ?? "",
    isDivergent: divergence.isDivergent ? "1" : "0",
    divergencePct: divergence.divergencePct ?? "",
    volume: effectivePrimary.volume,
    dayOpen: effectivePrimary.dayOpen,
    prevClose: effectivePrimary.prevClose,
    sessionOpenedAt,
    sessionElapsedFraction,
    updatedAt: now,
    marketStatus: getMarketStatus(),
    isStale: "0",
    mode: effectivePrimary.source === "REPLAY" ? "REPLAY" : "LIVE",
    source: divergence.isDivergent ? "DIVERGENT" : effectivePrimary.source,
  });

  await publish(CHANNELS.TICKS, {
    symbol,
    price: effectivePrimary.price,
    changePct: ((effectivePrimary.price - effectivePrimary.prevClose) / effectivePrimary.prevClose) * 100,
    volume: effectivePrimary.volume,
    source: divergence.isDivergent ? "DIVERGENT" : effectivePrimary.source,
    mode: effectivePrimary.source === "REPLAY" ? "REPLAY" : "LIVE",
    isStale: false,
    isDivergent: divergence.isDivergent,
    updatedAt: new Date(now).toISOString(),
  });
}

// Gives a symbol a starting market:state derived from its last cached daily bar, for
// the case where no live quote has ever landed for it. Without this, a symbol reads as
// "no state at all" and gets dropped from GET /watchlist entirely — invisible to the
// user, who just added it. That window is one poll cycle in both modes now: even with
// NSE closed, pollOnce() keeps writing replay quotes for every watched symbol (see
// composite-provider.ts), so this only covers the moment between adding a symbol and
// the next tick, not an indefinite gap.
//
// Deliberately honest rather than convenient: volume starts at 0 (no session has
// happened yet, and seeding a full previous day's volume would trip a spurious
// VOLUME_SPIKE on the first diff), updatedAt is backdated to the bar's own date, and
// isStale/source say outright that this is a previous close, not a live quote.
export async function seedMarketStateFromHistory(symbol: string): Promise<boolean> {
  const existingPrice = await redis.hget(STATE_PREFIX + symbol, "price");
  if (existingPrice !== null) return false;

  const rawBars = await redis.zrange(`market:history:${symbol}`, -2, -1);
  if (rawBars.length === 0) return false;

  const bars = rawBars.map((b) => JSON.parse(b) as { date: string; open: number; close: number });
  const last = bars[bars.length - 1];
  const previous = bars.length > 1 ? bars[bars.length - 2] : null;
  const barAt = new Date(last.date).getTime();

  await redis.hset(STATE_PREFIX + symbol, {
    price: last.close,
    primarySource: "SEEDED",
    primaryPrice: last.close,
    secondaryPrice: "",
    isDivergent: "0",
    divergencePct: "",
    volume: 0,
    dayOpen: last.open,
    prevClose: previous?.close ?? last.open,
    sessionOpenedAt: barAt,
    sessionElapsedFraction: 1,
    updatedAt: barAt,
    marketStatus: getMarketStatus(),
    isStale: "1",
    mode: effectiveMarketDataMode === "live" ? "LIVE" : "REPLAY",
    source: "SEEDED",
  });

  return true;
}

// A price grinding upward past its own high clears the previous high again on every
// single poll, so a naive "price > high52w -> log an event" fires once per tick and
// buries the user under identical "new 52w high" badges — the exact alert fatigue this
// system is supposed to prevent. Breaking out of a 52-week range is one *episode*, not
// one event per tick, so the running high still updates every time (it has to, or the
// threshold is meaningless) while the event is only recorded once per cooldown window.
const FIFTY_TWO_WEEK_EVENT_COOLDOWN_MS = 15 * 60 * 1000;

async function checkFiftyTwoWeekExtreme(symbol: string, price: number): Promise<void> {
  const stats = await prisma.symbolStats.findUnique({ where: { symbol } });
  if (!stats) return;

  const direction = price > stats.high52w ? "HIGH" : price < stats.low52w ? "LOW" : null;
  if (!direction) return;

  await prisma.symbolStats.update({
    where: { symbol },
    data: direction === "HIGH" ? { high52w: price } : { low52w: price },
  });

  const lastEvent = await prisma.symbolEvent.findFirst({
    where: {
      symbol,
      eventType: "FIFTY_TWO_WEEK_EXTREME",
      eventTime: { gt: new Date(Date.now() - FIFTY_TWO_WEEK_EVENT_COOLDOWN_MS) },
    },
    orderBy: { eventTime: "desc" },
  });

  // Only suppress a repeat of the *same* direction: a symbol that breaks to a new high
  // and then collapses to a new low inside the window has genuinely done two different
  // things, and the second one is worth surfacing immediately.
  if (lastEvent && (lastEvent.payload as { direction?: string } | null)?.direction === direction) return;

  await writeDiscreteEvent(symbol, "FIFTY_TWO_WEEK_EXTREME", "NOTABLE", { direction, price });
}

export async function writeDiscreteEvent(
  symbol: string,
  eventType: "NEWS" | "RATING_CHANGE" | "CORPORATE_ACTION" | "FIFTY_TWO_WEEK_EXTREME",
  severity: "MINOR" | "NOTABLE" | "CRITICAL",
  payload: Record<string, unknown>
): Promise<void> {
  const event = await prisma.symbolEvent.create({
    data: { symbol, eventType, severity, eventTime: new Date(), payload: payload as Prisma.InputJsonValue },
  });
  await publish(CHANNELS.EVENTS, {
    symbol,
    eventType,
    severity,
    eventTime: event.eventTime.toISOString(),
    payload,
  });
}
