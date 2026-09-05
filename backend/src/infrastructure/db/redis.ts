import Redis from "ioredis";
import { env } from "../../config/env";

// Command client: used for all normal GET/SET/HSET/etc. Never used for SUBSCRIBE —
// ioredis puts a connection into subscriber-only mode once SUBSCRIBE is called on it,
// so pub/sub gets its own dedicated connection(s) via createSubscriber() below.
export const redis = new Redis(env.REDIS_URL);

export function createSubscriber(): Redis {
  return new Redis(env.REDIS_URL);
}

redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});
