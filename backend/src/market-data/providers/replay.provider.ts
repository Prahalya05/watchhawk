import type { DailyBar, MarketDataProvider, Quote } from "../provider.interface";
import { SYMBOL_MAP, SYMBOL_UNIVERSE } from "../symbol-universe";
import { VOLATILITY_PROFILES, gaussianSample } from "../volatility-profiles";
import { virtualClock } from "./virtual-clock";
import { isFrozen } from "../command-queue";

interface ReplayState {
  price: number;
  dayOpen: number;
  prevClose: number;
  volume: number;
  sessionOpenedAt: number;
}

// Tertiary provider: fully synthetic, dependency-free. Used as the demo-safety-net when
// both real providers are unavailable, when MARKET_DATA_MODE=replay is forced, or for
// historical backfill when no Twelve Data key is configured. Not discarded work from the
// original simulator-only design — repositioned as the fallback-of-last-resort per plan.
export class ReplayProvider implements MarketDataProvider {
  readonly name = "REPLAY" as const;
  private state = new Map<string, ReplayState>();

  async start(): Promise<void> {
    for (const s of SYMBOL_UNIVERSE) {
      this.state.set(s.symbol, {
        price: s.basePrice,
        dayOpen: s.basePrice,
        prevClose: s.basePrice,
        volume: 0,
        sessionOpenedAt: virtualClock.currentSessionStartedAt(),
      });
    }

    virtualClock.on("sessionBoundary", (startedAt: number) => {
      for (const [symbol, st] of this.state) {
        const profile = VOLATILITY_PROFILES[SYMBOL_MAP.get(symbol)!.volatilityTier];
        const gapPct = gaussianSample(0, profile.gapStdevPct);
        st.prevClose = st.price;
        st.dayOpen = st.price * (1 + gapPct);
        st.price = st.dayOpen;
        st.volume = 0;
        st.sessionOpenedAt = startedAt;
      }
    });
  }

  async stop(): Promise<void> {
    // no external connections to tear down
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    const now = Date.now();
    const results: Quote[] = [];

    for (const symbol of symbols) {
      const st = this.state.get(symbol);
      const def = SYMBOL_MAP.get(symbol);
      if (!st || !def) continue;

      // FREEZE means "stop reporting altogether", not "report an unchanging price" —
      // the latter would still refresh market:state's updatedAt every poll cycle via
      // market-state-writer.ts, which would defeat the whole point of using FREEZE to
      // demo staleness (isStale is purely a function of how long updatedAt has been
      // unrefreshed). Skipping the quote entirely is what actually lets it go stale.
      if (isFrozen(symbol)) continue;

      const profile = VOLATILITY_PROFILES[def.volatilityTier];
      const step = gaussianSample(0, profile.tickStdevPct);
      st.price = Math.max(0.5, st.price * (1 + step));

      // U-shaped intraday volume curve: heavier near session open/close.
      const frac = virtualClock.elapsedSessionFraction();
      const uShape = 0.4 + 1.6 * Math.pow(2 * frac - 1, 2);
      st.volume += (def.baseDailyVolume / 240) * uShape * (0.5 + Math.random());

      results.push({
        symbol,
        price: st.price,
        volume: st.volume,
        dayOpen: st.dayOpen,
        prevClose: st.prevClose,
        fetchedAt: now,
        source: "REPLAY",
      });
    }

    return results;
  }

  async fetchDailyHistory(symbol: string, days: number): Promise<DailyBar[]> {
    const def = SYMBOL_MAP.get(symbol);
    if (!def) return [];
    const profile = VOLATILITY_PROFILES[def.volatilityTier];

    // Walk backward from basePrice so the series ends exactly at today's seed price.
    const closes: number[] = [def.basePrice];
    for (let i = 1; i < days; i++) {
      const prevReturn = gaussianSample(0, profile.dailyStdevPct);
      closes.push(closes[i - 1] / (1 + prevReturn));
    }
    closes.reverse();

    const bars: DailyBar[] = [];
    const today = new Date();
    for (let i = 0; i < closes.length; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - (closes.length - 1 - i));
      const close = closes[i];
      const open = i === 0 ? close : closes[i - 1];
      const high = Math.max(open, close) * (1 + Math.random() * 0.005);
      const low = Math.min(open, close) * (1 - Math.random() * 0.005);
      const volume = def.baseDailyVolume * (0.7 + Math.random() * 0.6);
      bars.push({ date: date.toISOString().slice(0, 10), open, high, low, close, volume });
    }
    return bars;
  }
}
