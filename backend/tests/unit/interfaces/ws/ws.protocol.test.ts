import { describe, expect, it } from "vitest";
import { MAX_SUBSCRIPTIONS_PER_CONNECTION, parseClientMessage } from "../../../../src/interfaces/ws/ws.protocol";
import { SYMBOL_MAP } from "../../../../src/domain/market/symbol-universe";

// This function is the entire client-input surface of the WebSocket. It used to not
// exist: the handler cast JSON.parse straight to ClientMessage, which asserts nothing at
// runtime, and a frame whose `symbols` was not an array threw out of the "message"
// listener — ws puts no try/catch around its emit — and killed the process for every
// connected client. So the malformed cases below are the point of the file, not padding.

const KNOWN = "RELIANCE";
const ALSO_KNOWN = "INFY";

function parse(value: unknown) {
  return parseClientMessage(JSON.stringify(value));
}

describe("parseClientMessage — well-formed messages", () => {
  it("accepts SUBSCRIBE and reports the symbols that exist", () => {
    const parsed = parse({ type: "SUBSCRIBE", symbols: [KNOWN, ALSO_KNOWN] });
    expect(parsed?.message.type).toBe("SUBSCRIBE");
    expect(parsed?.knownSymbols).toEqual([KNOWN, ALSO_KNOWN]);
  });

  it("accepts UNSUBSCRIBE the same way", () => {
    expect(parse({ type: "UNSUBSCRIBE", symbols: [KNOWN] })?.knownSymbols).toEqual([KNOWN]);
  });

  it("accepts PONG, which carries no symbols at all", () => {
    const parsed = parse({ type: "PONG" });
    expect(parsed?.message.type).toBe("PONG");
    expect(parsed?.knownSymbols).toEqual([]);
  });

  it("accepts an empty symbol list — unsubscribing from nothing is not an error", () => {
    expect(parse({ type: "SUBSCRIBE", symbols: [] })?.knownSymbols).toEqual([]);
  });
});

describe("parseClientMessage — normalisation", () => {
  it("upper-cases what the user typed, so 'infy' is the same subscription as 'INFY'", () => {
    expect(parse({ type: "SUBSCRIBE", symbols: ["infy", "Reliance"] })?.knownSymbols).toEqual([ALSO_KNOWN, KNOWN]);
  });

  // A repeated symbol would otherwise count twice against the per-connection cap while
  // only ever producing one subscription.
  it("de-duplicates, including across casings", () => {
    expect(parse({ type: "SUBSCRIBE", symbols: [KNOWN, KNOWN, "reliance"] })?.knownSymbols).toEqual([KNOWN]);
  });

  // A watchlist can legitimately hold a ticker that has left the universe (the DELISTED
  // path in watchlist.service.ts), and the client re-sends its whole list on reconnect.
  // Failing the message would break the subscription for every other symbol in it.
  it("drops unknown tickers instead of rejecting the whole message", () => {
    const parsed = parse({ type: "SUBSCRIBE", symbols: [KNOWN, "ZOMATO", ALSO_KNOWN] });
    expect(parsed).not.toBeNull();
    expect(parsed?.knownSymbols).toEqual([KNOWN, ALSO_KNOWN]);
  });

  it("keeps the raw request on the message, so the caller can still see what was asked", () => {
    const parsed = parse({ type: "SUBSCRIBE", symbols: ["ZOMATO"] });
    expect(parsed?.message).toEqual({ type: "SUBSCRIBE", symbols: ["ZOMATO"] });
    expect(parsed?.knownSymbols).toEqual([]);
  });
});

describe("parseClientMessage — malformed input returns null rather than throwing", () => {
  // The regression that motivated the schema. `for (const s of 5)` is a TypeError, and
  // there was nothing between JSON.parse and that loop.
  it("rejects a non-array symbols field", () => {
    expect(() => parse({ type: "SUBSCRIBE", symbols: 5 })).not.toThrow();
    expect(parse({ type: "SUBSCRIBE", symbols: 5 })).toBeNull();
    expect(parse({ type: "SUBSCRIBE", symbols: null })).toBeNull();
    expect(parse({ type: "SUBSCRIBE", symbols: { "0": KNOWN } })).toBeNull();
  });

  it("rejects a symbols array holding anything but strings", () => {
    expect(parse({ type: "SUBSCRIBE", symbols: [KNOWN, 7] })).toBeNull();
    expect(parse({ type: "SUBSCRIBE", symbols: [null] })).toBeNull();
    expect(parse({ type: "SUBSCRIBE", symbols: [{ symbol: KNOWN }] })).toBeNull();
  });

  it("rejects SUBSCRIBE with no symbols field at all", () => {
    expect(parse({ type: "SUBSCRIBE" })).toBeNull();
  });

  it("rejects an unknown or missing message type", () => {
    expect(parse({ type: "DROP_TABLE", symbols: [KNOWN] })).toBeNull();
    expect(parse({ symbols: [KNOWN] })).toBeNull();
    expect(parse({ type: 1 })).toBeNull();
  });

  it("rejects a payload that is valid JSON but not an object", () => {
    expect(parse("SUBSCRIBE")).toBeNull();
    expect(parse(42)).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse([{ type: "PONG" }])).toBeNull();
  });

  it("rejects a frame that is not JSON, without letting the parse error escape", () => {
    expect(() => parseClientMessage("{not json")).not.toThrow();
    expect(parseClientMessage("{not json")).toBeNull();
    expect(parseClientMessage("")).toBeNull();
  });
});

describe("parseClientMessage — bounds", () => {
  // SUBSCRIBE is an append into a Map that lives as long as the process. Without a
  // ceiling, a client sending fresh strings in a loop grows it until the process dies,
  // and no individual message looks abusive.
  it("rejects a symbol list longer than a connection could legitimately want", () => {
    const tooMany = Array.from({ length: MAX_SUBSCRIPTIONS_PER_CONNECTION + 1 }, (_, i) => `SYM${i}`);
    expect(parse({ type: "SUBSCRIBE", symbols: tooMany })).toBeNull();
  });

  it("accepts a list exactly at the cap", () => {
    const atCap = Array.from({ length: MAX_SUBSCRIPTIONS_PER_CONNECTION }, (_, i) => `SYM${i}`);
    expect(parse({ type: "SUBSCRIBE", symbols: atCap })).not.toBeNull();
  });

  it("caps at the size of the universe, since nothing beyond it can be subscribed to", () => {
    expect(MAX_SUBSCRIPTIONS_PER_CONNECTION).toBe(SYMBOL_MAP.size);
  });

  it("rejects an absurdly long string rather than storing it", () => {
    expect(parse({ type: "SUBSCRIBE", symbols: ["X".repeat(33)] })).toBeNull();
  });
});
