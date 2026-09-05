import { SYMBOL_MAP } from "./symbol-universe";
import { VOLATILITY_PROFILES } from "./volatility-profiles";
import type { Quote } from "../ports/market-data.port";

export interface DivergenceResult {
  isDivergent: boolean;
  divergencePct: number | null;
  primaryPrice: number;
  secondaryPrice: number | null;
}

// Real cross-vendor disagreement check: primary (Twelve Data) vs secondary (Yahoo)
// prices for the same symbol, fetched moments apart from different venues/snapshots.
// This is genuine data the brief asks us to handle, not scripted — except when forced
// via the admin DIVERGE command for guaranteed demo timing (see market-state-writer.ts).
export function checkDivergence(primary: Quote, secondary: Quote | null): DivergenceResult {
  if (!secondary) {
    return { isDivergent: false, divergencePct: null, primaryPrice: primary.price, secondaryPrice: null };
  }

  const tier = SYMBOL_MAP.get(primary.symbol)?.volatilityTier ?? "MED";
  const threshold = VOLATILITY_PROFILES[tier].divergenceThresholdPct;
  const divergencePct = Math.abs(primary.price - secondary.price) / primary.price;

  return {
    isDivergent: divergencePct > threshold,
    divergencePct,
    primaryPrice: primary.price,
    secondaryPrice: secondary.price,
  };
}
