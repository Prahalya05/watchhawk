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
    const url = `${BASE_URL}/quote?symbol=${encodeURIComponent(tdSymbols)}&apikey=${env.TWELVE_DATA_API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Twelve Data quote request failed: ${res.status}`);
    const body = (await res.json()) as Record<string, Record<string, string>>;

    // Single-symbol requests return one object; multi-symbol requests return
    // { "SYMBOL.NS": {...}, ... } keyed by the requested symbol string.
    const entries: Record<string, Record<string, string>> = symbols.length === 1 ? { [tdSymbols]: body as unknown as Record<string, string> } : body;
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
    const url = `${BASE_URL}/time_series?symbol=${encodeURIComponent(toTwelveDataSymbol(symbol))}&interval=1day&outputsize=${days}&apikey=${env.TWELVE_DATA_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Twelve Data time_series request failed: ${res.status}`);
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

// NSE convention for Twelve Data — confirmed at build/verify time per the plan's flagged
// item; adjust here if the actual free-tier symbol format differs (e.g. plain ticker
// without suffix, or a different exchange code).
function toTwelveDataSymbol(symbol: string): string {
  return `${symbol}.NS`;
}
