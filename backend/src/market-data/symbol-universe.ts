export type VolatilityTier = "LOW" | "MED" | "HIGH";

export interface UniverseSymbol {
  symbol: string; // NSE ticker, no suffix (providers append their own convention)
  name: string;
  sector: string;
  volatilityTier: VolatilityTier;
  basePrice: number; // seed price for replay mode / historical backfill starting point
  baseDailyVolume: number;
}

// A deliberately mixed universe: large-cap/LOW-tier names sit next to small-cap/HIGH-tier
// names so the same z-score-based severity thresholds visibly mean different things for
// each (see diff.engine.ts) — a 2% move is routine for a HIGH-tier name, notable for LOW.
//
// Every ticker here was checked to resolve against the live NSE feed (`npm run
// verify:live` covers a sample of them). Two did not, and are worth knowing about because
// both are recent corporate actions rather than typos: Zomato renamed to ETERNAL, and
// Tata Motors demerged, with the passenger-vehicle entity listing as TMPV. A stale ticker
// is silent in live mode — the provider just returns nothing for it and the symbol falls
// back to synthetic data while still looking healthy on screen.
//
// basePrice values are real NSE closes as of the last universe refresh. They only seed
// replay mode (live mode overwrites them from the real backfill), but keeping them
// roughly honest matters: a demo showing RELIANCE at ₹2,950 when it trades near ₹1,320
// undermines the thing it is trying to demonstrate.
export const SYMBOL_UNIVERSE: UniverseSymbol[] = [
  // LOW volatility — large-cap
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy", volatilityTier: "LOW", basePrice: 1322, baseDailyVolume: 6_000_000 },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT", volatilityTier: "LOW", basePrice: 2304, baseDailyVolume: 2_500_000 },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking", volatilityTier: "LOW", basePrice: 712, baseDailyVolume: 8_000_000 },
  { symbol: "INFY", name: "Infosys", sector: "IT", volatilityTier: "LOW", basePrice: 1130, baseDailyVolume: 5_500_000 },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking", volatilityTier: "LOW", basePrice: 1423, baseDailyVolume: 9_000_000 },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", sector: "FMCG", volatilityTier: "LOW", basePrice: 1973, baseDailyVolume: 1_800_000 },
  { symbol: "ITC", name: "ITC Limited", sector: "FMCG", volatilityTier: "LOW", basePrice: 264, baseDailyVolume: 7_000_000 },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking", volatilityTier: "LOW", basePrice: 1016, baseDailyVolume: 12_000_000 },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom", volatilityTier: "LOW", basePrice: 1840, baseDailyVolume: 4_500_000 },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Banking", volatilityTier: "LOW", basePrice: 424, baseDailyVolume: 3_200_000 },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Infrastructure", volatilityTier: "LOW", basePrice: 3964, baseDailyVolume: 2_000_000 },
  { symbol: "ASIANPAINT", name: "Asian Paints", sector: "Consumer", volatilityTier: "LOW", basePrice: 2527, baseDailyVolume: 1_200_000 },

  // MED volatility — mid/large-cap, cyclical or sector-sensitive
  { symbol: "TMPV", name: "Tata Motors Passenger Vehicles", sector: "Auto", volatilityTier: "MED", basePrice: 311, baseDailyVolume: 10_000_000 },
  { symbol: "MARUTI", name: "Maruti Suzuki", sector: "Auto", volatilityTier: "MED", basePrice: 12694, baseDailyVolume: 700_000 },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical", sector: "Pharma", volatilityTier: "MED", basePrice: 1899, baseDailyVolume: 2_100_000 },
  { symbol: "TITAN", name: "Titan Company", sector: "Consumer", volatilityTier: "MED", basePrice: 5020, baseDailyVolume: 1_500_000 },
  { symbol: "WIPRO", name: "Wipro", sector: "IT", volatilityTier: "MED", basePrice: 176, baseDailyVolume: 6_500_000 },
  { symbol: "ULTRACEMCO", name: "UltraTech Cement", sector: "Cement", volatilityTier: "MED", basePrice: 11408, baseDailyVolume: 500_000 },
  { symbol: "NESTLEIND", name: "Nestle India", sector: "FMCG", volatilityTier: "MED", basePrice: 1410, baseDailyVolume: 400_000 },
  { symbol: "POWERGRID", name: "Power Grid Corp", sector: "Energy", volatilityTier: "MED", basePrice: 266, baseDailyVolume: 9_500_000 },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "Financial Services", volatilityTier: "MED", basePrice: 1060, baseDailyVolume: 1_900_000 },
  { symbol: "ADANIENT", name: "Adani Enterprises", sector: "Conglomerate", volatilityTier: "MED", basePrice: 2938, baseDailyVolume: 3_000_000 },
  { symbol: "TATASTEEL", name: "Tata Steel", sector: "Metals", volatilityTier: "MED", basePrice: 188, baseDailyVolume: 20_000_000 },
  { symbol: "ONGC", name: "Oil & Natural Gas Corp", sector: "Energy", volatilityTier: "MED", basePrice: 234, baseDailyVolume: 8_000_000 },

  // HIGH volatility — smaller-cap / newer listings
  { symbol: "ETERNAL", name: "Eternal (formerly Zomato)", sector: "Internet", volatilityTier: "HIGH", basePrice: 322, baseDailyVolume: 25_000_000 },
  { symbol: "PAYTM", name: "One97 Communications (Paytm)", sector: "Fintech", volatilityTier: "HIGH", basePrice: 1659, baseDailyVolume: 6_000_000 },
  { symbol: "IRCTC", name: "Indian Railway Catering & Tourism", sector: "Travel", volatilityTier: "HIGH", basePrice: 476, baseDailyVolume: 4_000_000 },
  { symbol: "IDEA", name: "Vodafone Idea", sector: "Telecom", volatilityTier: "HIGH", basePrice: 15, baseDailyVolume: 200_000_000 },
  { symbol: "SUZLON", name: "Suzlon Energy", sector: "Renewable Energy", volatilityTier: "HIGH", basePrice: 45, baseDailyVolume: 80_000_000 },
  { symbol: "RVNL", name: "Rail Vikas Nigam", sector: "Infrastructure", volatilityTier: "HIGH", basePrice: 212, baseDailyVolume: 15_000_000 },
  { symbol: "IRFC", name: "Indian Railway Finance Corp", sector: "Financial Services", volatilityTier: "HIGH", basePrice: 83, baseDailyVolume: 30_000_000 },
  { symbol: "JIOFIN", name: "Jio Financial Services", sector: "Fintech", volatilityTier: "HIGH", basePrice: 239, baseDailyVolume: 18_000_000 },
  { symbol: "IEX", name: "Indian Energy Exchange", sector: "Energy", volatilityTier: "HIGH", basePrice: 118, baseDailyVolume: 10_000_000 },
  { symbol: "YESBANK", name: "Yes Bank", sector: "Banking", volatilityTier: "HIGH", basePrice: 22, baseDailyVolume: 100_000_000 },
];

export const SYMBOL_MAP = new Map(SYMBOL_UNIVERSE.map((s) => [s.symbol, s]));

export function searchSymbols(query: string): UniverseSymbol[] {
  const q = query.trim().toUpperCase();
  if (!q) return SYMBOL_UNIVERSE.slice(0, 10);
  return SYMBOL_UNIVERSE.filter(
    (s) => s.symbol.includes(q) || s.name.toUpperCase().includes(q)
  ).slice(0, 20);
}
