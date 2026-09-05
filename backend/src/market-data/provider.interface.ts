export type SourceName = "TWELVE_DATA" | "YAHOO" | "REPLAY";

export interface Quote {
  symbol: string;
  price: number;
  volume: number; // cumulative volume for the current session, as reported by the source
  dayOpen: number;
  prevClose: number;
  fetchedAt: number; // epoch ms — when this provider observed the quote
  source: SourceName;
}

export interface DailyBar {
  date: string; // ISO date, no time component
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Implemented by TwelveDataProvider, YahooProvider, and ReplayProvider. This is what
// makes market data pluggable: the rest of the system (ingestion, diff engine) only
// ever depends on this interface, never on a specific vendor's API shape.
export interface MarketDataProvider {
  readonly name: SourceName;
  start(): Promise<void>;
  stop(): Promise<void>;
  fetchQuotes(symbols: string[]): Promise<Quote[]>;
  fetchDailyHistory(symbol: string, days: number): Promise<DailyBar[]>;
}
