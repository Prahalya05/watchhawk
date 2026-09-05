import type { VolatilityTier } from "./symbol-universe";

export interface VolatilityProfile {
  dailyStdevPct: number; // used to derive stdevReturn20d in synthetic history
  tickStdevPct: number; // per-tick random-walk step size
  gapStdevPct: number; // typical overnight gap size
  divergenceThresholdPct: number; // cross-source disagreement considered "real" above this
}

export const VOLATILITY_PROFILES: Record<VolatilityTier, VolatilityProfile> = {
  LOW: { dailyStdevPct: 0.01, tickStdevPct: 0.0008, gapStdevPct: 0.005, divergenceThresholdPct: 0.005 },
  MED: { dailyStdevPct: 0.025, tickStdevPct: 0.002, gapStdevPct: 0.012, divergenceThresholdPct: 0.01 },
  HIGH: { dailyStdevPct: 0.05, tickStdevPct: 0.004, gapStdevPct: 0.025, divergenceThresholdPct: 0.015 },
};

// Box-Muller transform — used everywhere we need a normally distributed random step
// (tick price moves, synthetic daily returns, synthetic overnight gaps).
export function gaussianSample(mean = 0, stdev = 1): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdev;
}
