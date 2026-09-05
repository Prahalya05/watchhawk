import { redis } from "../db/redis";
import { env } from "../config/env";

// Self-imposed spend guard for the Gemini free tier.
//
// Counters live in Redis rather than in process memory for the same reason market:state
// does: the budget is a property of the deployment, not of one Node process, so a restart
// (or a second instance) must not hand out a fresh allowance. Both keys carry a TTL, so
// there is nothing to clean up.
//
// Google no longer publishes free-tier quotas, so the ceilings are configuration
// (GEMINI_MAX_REQUESTS_PER_MINUTE / _PER_DAY), not a claim about the real limit. They are
// deliberately conservative: running out degrades the assistant to its deterministic path
// rather than failing, so under-spending costs nothing.

const MINUTE_PREFIX = "llm:budget:minute:";
const DAY_PREFIX = "llm:budget:day:";

export interface BudgetStatus {
  minuteUsed: number;
  minuteLimit: number;
  dayUsed: number;
  dayLimit: number;
  exhausted: boolean;
}

function minuteKey(now: Date): string {
  return MINUTE_PREFIX + Math.floor(now.getTime() / 60_000);
}

function dayKey(now: Date): string {
  return DAY_PREFIX + now.toISOString().slice(0, 10); // UTC day, matching Google's reset
}

export async function readBudget(now: Date = new Date()): Promise<BudgetStatus> {
  const [minuteRaw, dayRaw] = await redis.mget(minuteKey(now), dayKey(now));
  const minuteUsed = minuteRaw ? parseInt(minuteRaw, 10) : 0;
  const dayUsed = dayRaw ? parseInt(dayRaw, 10) : 0;

  return {
    minuteUsed,
    minuteLimit: env.GEMINI_MAX_REQUESTS_PER_MINUTE,
    dayUsed,
    dayLimit: env.GEMINI_MAX_REQUESTS_PER_DAY,
    exhausted: minuteUsed >= env.GEMINI_MAX_REQUESTS_PER_MINUTE || dayUsed >= env.GEMINI_MAX_REQUESTS_PER_DAY,
  };
}

// Increment-then-check rather than check-then-increment: two concurrent requests that
// both read "7 of 8 used" would both proceed under the latter. INCR is atomic, so the
// loser here sees 9, refunds its own increment and backs off. Overshooting a self-imposed
// ceiling by one is harmless; overshooting Google's is not.
export async function tryConsume(now: Date = new Date()): Promise<{ allowed: boolean; status: BudgetStatus }> {
  const mKey = minuteKey(now);
  const dKey = dayKey(now);

  const results = await redis
    .multi()
    .incr(mKey)
    .expire(mKey, 120)
    .incr(dKey)
    .expire(dKey, 60 * 60 * 48)
    .exec();

  const minuteUsed = Number(results?.[0]?.[1] ?? 0);
  const dayUsed = Number(results?.[2]?.[1] ?? 0);

  const status: BudgetStatus = {
    minuteUsed,
    minuteLimit: env.GEMINI_MAX_REQUESTS_PER_MINUTE,
    dayUsed,
    dayLimit: env.GEMINI_MAX_REQUESTS_PER_DAY,
    exhausted: false,
  };

  if (minuteUsed > env.GEMINI_MAX_REQUESTS_PER_MINUTE || dayUsed > env.GEMINI_MAX_REQUESTS_PER_DAY) {
    await redis.multi().decr(mKey).decr(dKey).exec();
    return {
      allowed: false,
      status: { ...status, minuteUsed: minuteUsed - 1, dayUsed: dayUsed - 1, exhausted: true },
    };
  }

  return { allowed: true, status };
}
