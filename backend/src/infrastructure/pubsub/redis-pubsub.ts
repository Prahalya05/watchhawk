import { redis, createSubscriber } from "../db/redis";

export const CHANNELS = {
  TICKS: "market:ticks",
  EVENTS: "market:events",
} as const;

export async function publish(channel: string, payload: unknown): Promise<void> {
  await redis.publish(channel, JSON.stringify(payload));
}

// One dedicated subscriber connection shared by whoever needs to listen (the WS server).
// ioredis puts a connection into subscriber-only mode on first SUBSCRIBE call, so this
// must never share a connection with command traffic.
export function subscribeToChannels(channels: string[], onMessage: (channel: string, payload: unknown) => void) {
  const sub = createSubscriber();
  sub.subscribe(...channels);
  sub.on("message", (channel, message) => {
    try {
      onMessage(channel, JSON.parse(message));
    } catch (err) {
      console.error("[pubsub] failed to parse message", err);
    }
  });
  return sub;
}
