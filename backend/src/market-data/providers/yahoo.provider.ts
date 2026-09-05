import type { DailyBar, MarketDataProvider, Quote } from "../provider.interface";

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        regularMarketVolume?: number;
        regularMarketOpen?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }>;
      };
    }>;
  };
}

// Primary provider for NSE quotes: Yahoo Finance's unofficial chart endpoint. No API key,
// no signup, but no batch endpoint and no stability guarantee — this is an undocumented
// endpoint that can change or start blocking without notice (flagged risk in the plan,
// documented in README). It ended up primary rather than a pure fallback because Twelve
// Data's free plan doesn't serve NSE symbols at all (confirmed via verify:live); Twelve
// Data is still polled as a cross-check every cycle in composite-provider.ts. Self-
// throttled client-side (bounded concurrency + spaced request slots, see below) since
// there's no published rate limit to respect.
// Yahoo's NSE payloads routinely omit meta.regularMarketOpen entirely, so the session's
// real opening price has to come from the first non-null bar of the intraday series.
// This matters more than it looks: dayOpen feeds GAP_OPEN, and defaulting it to the
// *current* price would recast the entire day's move as an overnight gap — on RELIANCE
// that turned a true 0.12% gap into a fabricated 1.50% one, comfortably over the
// CRITICAL threshold. Falling back to prevClose instead yields a zero gap, i.e. "no gap
// known", which is the honest default when the real open is unavailable.
type YahooChartResult = NonNullable<NonNullable<YahooChartResponse["chart"]>["result"]>[number];

function extractSessionOpen(result: YahooChartResult | undefined): number | null {
  const opens = result?.indicators?.quote?.[0]?.open;
  if (!Array.isArray(opens)) return null;
  return opens.find((o) => typeof o === "number" && Number.isFinite(o)) ?? null;
}

// Yahoo has no batch endpoint, so a poll cycle is inherently N requests. What it is NOT
// is N *serialised* requests: the previous version awaited each symbol in turn behind a
// 1 req/sec throttle, which made a cycle take ~1 second per watched symbol. At the
// shipped 34-symbol universe that already pushed the real cadence past the configured
// 45s interval, and it crossed STALE_THRESHOLD_MS — every symbol permanently flagged
// stale, no crash, no error — somewhere around 100-150 symbols.
//
// So requests now go out from a small worker pool, spaced by a reserved-slot limiter
// rather than a per-request sleep. The rate ceiling is still deliberately modest
// (~7 req/sec) because this is an undocumented endpoint with no published quota and
// getting blocked costs far more than a slow cycle, but decoupling "how many can be in
// flight" from "how fast may we start them" is what turns an O(N) wall into O(N/6).
const MAX_CONCURRENT_REQUESTS = 6;
const MIN_REQUEST_GAP_MS = 150;

// An unbounded fetch is the other half of the same problem: one hung connection used to
// stall the whole sequential cycle indefinitely. Bounded here so a bad symbol costs one
// slot, not the cycle.
const REQUEST_TIMEOUT_MS = 10_000;

export class YahooProvider implements MarketDataProvider {
  readonly name = "YAHOO" as const;
  // Next instant a request is allowed to *start*. Reserved rather than slept on, so N
  // concurrent callers queue into distinct slots instead of all reading the same
  // "last request was long ago" and firing at once.
  private nextSlotAt = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    // Written by index into a pre-sized array rather than pushed, so the result order
    // still matches the requested order regardless of which worker finishes first.
    const results: Array<Quote | null> = new Array(symbols.length).fill(null);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (let i = cursor++; i < symbols.length; i = cursor++) {
        try {
          results[i] = await this.fetchOne(symbols[i]);
        } catch (err) {
          // Per-symbol failure stays per-symbol: composite-provider.ts falls the missing
          // ones back to replay rather than blanking the whole watchlist.
          console.warn(`[yahoo] failed to fetch ${symbols[i]}:`, (err as Error).message);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, symbols.length) }, () => worker()),
    );
    return results.filter((q): q is Quote => q !== null);
  }

  // Claims the next free slot and waits only until it comes round. The read-and-advance
  // of nextSlotAt is synchronous, so two concurrent callers can never be handed the same
  // slot even though the awaits below interleave.
  private async reserveSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + MIN_REQUEST_GAP_MS;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }

  private async fetchOne(symbol: string): Promise<Quote | null> {
    await this.reserveSlot();
    const url = `${CHART_URL}/${encodeURIComponent(symbol)}.NS?range=1d&interval=1m`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const body = (await res.json()) as YahooChartResponse;
    const result = body?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice) return null;

    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;

    return {
      symbol,
      price: meta.regularMarketPrice,
      volume: meta.regularMarketVolume ?? 0,
      dayOpen: extractSessionOpen(result) ?? meta.regularMarketOpen ?? prevClose,
      prevClose,
      fetchedAt: Date.now(),
      source: "YAHOO",
    };
  }

  async fetchDailyHistory(symbol: string, days: number): Promise<DailyBar[]> {
    // Shares the same slot limiter as the quote path, so a backfill running alongside a
    // poll cycle cannot double the outbound rate.
    await this.reserveSlot();
    const url = `${CHART_URL}/${encodeURIComponent(symbol)}.NS?range=${days}d&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];

    const body = (await res.json()) as YahooChartResponse;
    const result = body?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp ?? [];
    const quote: { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] } =
      result.indicators?.quote?.[0] ?? { open: [], high: [], low: [], close: [], volume: [] };
    const bars: DailyBar[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (quote.close?.[i] == null) continue;
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open: quote.open[i],
        high: quote.high[i],
        low: quote.low[i],
        close: quote.close[i],
        volume: quote.volume?.[i] ?? 0,
      });
    }
    return bars;
  }
}
