import type { DailyBar, MarketDataProvider, Quote } from "../../../domain/ports/market-data.port";
import { env } from "../../../config/env";

const BASE_URL = "https://api.twelvedata.com";

// Cross-check / upgrade-path provider: real data, requires a free API key from
// twelvedata.com (user-supplied, cannot be provisioned by us — see README). NOT the
// primary source here — verify:live confirmed the free/basic plan 404s on every NSE
// symbol ("available starting with the Grow or Venture plan"), so composite-provider.ts
// treats Yahoo as primary and polls this only as a best-effort cross-check that starts
// paying off automatically if the plan is ever upgraded. On a plan that does cover NSE,
// the /quote endpoint accepts comma-separated symbols in ONE call — batching all watched
// symbols into a single request per poll cycle is what would keep this inside the paid
// tier's own rate budget (800/day, 8/min on the free tier, for reference).
export class TwelveDataProvider implements MarketDataProvider {
  readonly name = "TWELVE_DATA" as const;

  async start(): Promise<void> {
    // stateless HTTP provider — nothing to connect
  }

  async stop(): Promise<void> {}

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    const tdSymbols = symbols.map(toTwelveDataSymbol).join(",");
    const url = `${BASE_URL}/quote?symbol=${encodeURIComponent(tdSymbols)}&exchange=${TWELVE_DATA_EXCHANGE}&apikey=${env.TWELVE_DATA_API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Twelve Data quote request failed: ${await describeError(res)}`);
    const body = (await res.json()) as Record<string, Record<string, string>>;

    // Single-symbol requests return one object; multi-symbol requests return
    // { "SYMBOL.NS": {...}, ... } keyed by the requested symbol string.
    const entries: Record<string, Record<string, string>> = symbols.length === 1
      ? { [tdSymbols]: body as unknown as Record<string, string> }
      : body;
    const now = Date.now();
    const quotes: Quote[] = [];

    for (const symbol of symbols) {
      const tdSymbol = toTwelveDataSymbol(symbol);
      const raw = entries[tdSymbol];
      if (!raw || raw.status === "error" || !raw.close) continue;

      quotes.push({
        symbol,
        price: parseFloat(raw.close),
        volume: parseFloat(raw.volume ?? "0"),
        dayOpen: parseFloat(raw.open ?? raw.close),
        prevClose: parseFloat(raw.previous_close ?? raw.close),
        fetchedAt: now,
        source: "TWELVE_DATA",
      });
    }

    return quotes;
  }

  async fetchDailyHistory(symbol: string, days: number): Promise<DailyBar[]> {
    const url = `${BASE_URL}/time_series?symbol=${encodeURIComponent(toTwelveDataSymbol(symbol))}&exchange=${TWELVE_DATA_EXCHANGE}&interval=1day&outputsize=${days}&apikey=${env.TWELVE_DATA_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Twelve Data time_series request failed: ${await describeError(res)}`);
    const body = (await res.json()) as { status?: string; values?: Record<string, string>[] };
    if (body.status === "error" || !Array.isArray(body.values)) return [];

    return body.values
      .map((v: Record<string, string>) => ({
        date: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseFloat(v.volume ?? "0"),
      }))
      .reverse(); // Twelve Data returns newest-first; we want oldest-first
  }
}

// Twelve Data identifies NSE stocks by the bare ticker plus an `exchange` parameter —
// the ".NS" suffix is a *Yahoo* convention and this API rejects it outright as an invalid
// symbol. The difference is worth keeping straight, because the two failures look alike
// from the outside and mean opposite things:
//
//   RELIANCE.NS -> "symbol parameter is missing or invalid"          (our bug)
//   RELIANCE    -> "available starting with the Grow or Venture plan" (their paywall)
//
// Sending the right identifier is what makes the second message the one we get, which is
// the point of keeping this provider around: nothing here needs changing if the plan is
// ever upgraded. `exchange` disambiguates NSE from BSE, which list the same tickers.
const TWELVE_DATA_EXCHANGE = "NSE";

function toTwelveDataSymbol(symbol: string): string {
  return symbol;
}

// Twelve Data puts the actual reason in the JSON body and only a bare status code on the
// response, so surfacing the status alone turns "your plan doesn't include NSE" into an
// anonymous 404 and sends the next person hunting through symbol formats for a problem
// that isn't there.
async function describeError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body?.message ? `${res.status} — ${body.message}` : `${res.status}`;
  } catch {
    return `${res.status}`;
  }
}
