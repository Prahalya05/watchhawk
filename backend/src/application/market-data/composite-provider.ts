import { effectiveMarketDataMode, env } from "../../config/env";
import { getActiveSymbols } from "../ingestion/subscription-manager";
import { writeMarketState } from "../ingestion/market-state-writer";
import { TwelveDataProvider } from "../../infrastructure/market-data/providers/twelve-data.provider";
import { YahooProvider } from "../../infrastructure/market-data/providers/yahoo.provider";
import { ReplayProvider } from "../../infrastructure/market-data/providers/replay.provider";
import { getMarketStatus } from "./staleness";
import type { Quote } from "../../domain/ports/market-data.port";

// Orchestrates primary -> cross-check -> replay, per poll cycle, for every symbol with
// refcount > 0. This is the only place that decides which source is authoritative;
// market-state-writer.ts stays source-agnostic. See plan section 4 for the full
// decision tree this implements.
// Yahoo is primary, not Twelve Data: verify:live confirmed Twelve Data's free/basic plan
// 404s on every NSE symbol ("available starting with the Grow or Venture plan") — its
// batching and official support only matter on a paid plan. Twelve Data is still polled
// every cycle as a cross-check/upgrade path (see README), but its absence never gates
// anything, and the credit-budget math this app used to pace polling around only applied
// to a source that, on the free tier, can't serve NSE at all.
export class CompositeProvider {
  private twelveData = new TwelveDataProvider();
  private yahoo = new YahooProvider();
  private replay = new ReplayProvider();
  private pollHandle: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private basePollIntervalMs = 45_000;
  private stopped = false;

  async start(pollIntervalMs: number): Promise<void> {
    this.basePollIntervalMs = pollIntervalMs;
    this.stopped = false;
    await this.replay.start(); // always started: backfill fallback + tertiary safety net
    if (effectiveMarketDataMode === "live") {
      await this.twelveData.start();
      await this.yahoo.start();
    }

    const startedAt = Date.now();
    await this.runPollCycle(); // one immediate cycle so the app isn't empty on first load
    this.scheduleNextCycle(startedAt);
  }

  // Fixed-rate, not additive. The previous version waited a full basePollIntervalMs
  // *after* each cycle finished, so the real cadence was interval + cycle duration —
  // with a sequential Yahoo loop that meant ~80-90s against a configured 45s at the
  // shipped 34-symbol universe, and it only grew with the symbol count. Scheduling from
  // the cycle's start instead means the interval is the cadence, and a cycle that
  // overruns simply starts the next one immediately rather than compounding.
  //
  // Overlap is still impossible: runPollCycle's pollInFlight guard is what prevents two
  // concurrent writers, and it stays the safety net now that the delay can reach zero.
  private scheduleNextCycle(startedAt: number): void {
    if (this.stopped) return;
    const delay = Math.max(0, this.basePollIntervalMs - (Date.now() - startedAt));
    this.pollHandle = setTimeout(() => {
      const nextStartedAt = Date.now();
      void this.runPollCycle().then(() => this.scheduleNextCycle(nextStartedAt));
    }, delay);
  }

  // Guards against overlapping cycles: a slow Twelve Data / Yahoo response can take
  // longer than the poll interval, and without this a second cycle would start while
  // the first is still writing — two concurrent writeMarketState calls for the same
  // symbol could each read the same stale SymbolStats.high52w and both fire a
  // duplicate FIFTY_TWO_WEEK_EXTREME event. Skipping (not queueing) an overlapping
  // tick is the right call here: a missed cycle is made up by the next one.
  private async runPollCycle(): Promise<void> {
    if (this.pollInFlight) {
      console.warn("[composite] previous poll cycle still running, skipping this tick");
      return;
    }
    this.pollInFlight = true;
    const startedAt = Date.now();
    try {
      await this.pollOnce();
    } catch (err) {
      console.error("[composite] poll failed", err);
    } finally {
      this.pollInFlight = false;
      this.reportCycleDuration(Date.now() - startedAt);
    }
  }

  // Cycle duration is the number that decides whether this app works at all: once it
  // approaches STALE_THRESHOLD_MS every symbol reads as stale, silently and without an
  // error anywhere. It used to be invisible, so the wall was only findable by reading
  // the code. Logged every cycle, and escalated before it becomes user-visible.
  private reportCycleDuration(durationMs: number): void {
    if (durationMs >= env.STALE_THRESHOLD_MS) {
      console.error(
        `[composite] poll cycle took ${durationMs}ms, at or past STALE_THRESHOLD_MS ` +
          `(${env.STALE_THRESHOLD_MS}ms) — every watched symbol will read as stale. ` +
          `Reduce the watched symbol count or raise provider concurrency.`,
      );
    } else if (durationMs > this.basePollIntervalMs) {
      console.warn(
        `[composite] poll cycle took ${durationMs}ms, longer than the ${this.basePollIntervalMs}ms ` +
          `interval — cycles are now back-to-back and cadence is bound by fetch time.`,
      );
    } else {
      console.log(`[composite] poll cycle finished in ${durationMs}ms`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollHandle) clearTimeout(this.pollHandle);
    await this.twelveData.stop();
    await this.yahoo.stop();
    await this.replay.stop();
  }

  // Exposed for historical-backfill.ts, which needs a provider directly rather than
  // going through the live poll cycle. Yahoo, not Twelve Data: Twelve Data's free plan
  // 404s on NSE time_series the same way it does on quotes, so it would never produce
  // real history — Yahoo actually does (verified in verify:live).
  getBackfillProvider() {
    return effectiveMarketDataMode === "live" ? this.yahoo : this.replay;
  }

  // A provider that throws yields an empty result rather than failing the cycle: the
  // fallback path below is what a vendor outage is supposed to hit.
  private async fetchOrWarn(fetchQuotes: () => Promise<Quote[]>, label: string): Promise<Quote[]> {
    try {
      return await fetchQuotes();
    } catch (err) {
      console.warn(`[composite] ${label} unavailable this cycle:`, (err as Error).message);
      return [];
    }
  }

  private async pollOnce(): Promise<void> {
    const symbols = await getActiveSymbols();
    if (symbols.length === 0) return;

    if (effectiveMarketDataMode === "replay") {
      const replayQuotes = await this.replay.fetchQuotes(symbols);
      await Promise.all(replayQuotes.map((q) => writeMarketState(q, null)));
      return;
    }

    // Live providers only have anything real to report while NSE is open. Outside market
    // hours this app still keeps every watched symbol moving on the replay engine —
    // honestly labeled (mode/source: REPLAY, exactly like pure replay mode) rather than
    // freezing state and letting it silently age into "stale". A frozen dashboard reads
    // as "the app is broken"; a moving one tagged REPLAY reads as what it is: no live
    // feed available right now, here's a simulation so the UI stays demonstrable.
    if (getMarketStatus() === "CLOSED") {
      const replayQuotes = await this.replay.fetchQuotes(symbols);
      await Promise.all(replayQuotes.map((q) => writeMarketState(q, null)));
      return;
    }

    // Both providers in flight at once. They share nothing and neither gates the other,
    // so awaiting them in sequence just added the slower one's latency to every cycle —
    // and cycle duration is the constraint this whole loop lives under. Each keeps its
    // own failure boundary: an outage in one still leaves the other's quotes usable.
    //
    // Twelve Data is attempted every cycle as a cross-check and as the upgrade path for
    // an account whose plan does cover NSE, but it never gates anything: on the free
    // tier it 404s for every symbol, and requiring it would mean never getting live data.
    const [primaryQuotes, crossCheckQuotes] = await Promise.all([
      this.fetchOrWarn(() => this.yahoo.fetchQuotes(symbols), "Yahoo"),
      this.fetchOrWarn(() => this.twelveData.fetchQuotes(symbols), "Twelve Data"),
    ]);
    const crossCheckBySymbol = new Map(crossCheckQuotes.map((q) => [q.symbol, q]));

    // Symbols Yahoo didn't answer for this cycle fall back to replay, so a single
    // vendor outage never blanks the whole watchlist.
    const primaryBySymbol = new Map(primaryQuotes.map((q) => [q.symbol, q]));
    const missingFromPrimary = symbols.filter((s) => !primaryBySymbol.has(s));
    const fallbackQuotes = missingFromPrimary.length > 0 ? await this.replay.fetchQuotes(missingFromPrimary) : [];

    const writes = [
      ...primaryQuotes.map((q) => writeMarketState(q, crossCheckBySymbol.get(q.symbol) ?? null)),
      ...fallbackQuotes.map((q) => writeMarketState(q, null)),
    ];
    await Promise.all(writes);
  }
}

export const compositeProvider = new CompositeProvider();
