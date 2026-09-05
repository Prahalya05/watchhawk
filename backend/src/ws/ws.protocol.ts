export type ClientMessage =
  | { type: "SUBSCRIBE"; symbols: string[] }
  | { type: "UNSUBSCRIBE"; symbols: string[] }
  | { type: "PONG" };

export type ServerMessage =
  | { type: "SUBSCRIBED"; symbols: string[] }
  | {
      type: "TICK";
      symbol: string;
      price: number;
      changePct: number;
      volume: number;
      source: string;
      mode: string;
      isStale: boolean;
      isDivergent: boolean;
      updatedAt: string;
    }
  | { type: "EVENT"; symbol: string; eventType: string; severity: string; eventTime: string; payload: Record<string, unknown> }
  | { type: "PING" }
  | { type: "ERROR"; message: string };
