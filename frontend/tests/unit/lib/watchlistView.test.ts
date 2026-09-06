import { describe, expect, it } from "vitest";
import type { DiffEvent, Severity, WatchlistEntry } from "../../../src/types";
import type { LiveTick } from "../../../src/ws/useMarketSocket";
import { DEFAULT_VIEW, applyView, effectiveChangePct, summarise } from "../../../src/lib/watchlistView";

// applyView is the whole dashboard in one function: what the user sees, and in what
// order. Its failure mode is that it never looks broken — a row filtered out or ranked
// below the fold is indistinguishable from a quiet market. That is what these pin.

type Current = WatchlistEntry["current"];

function entry(symbol: string, over: Partial<WatchlistEntry> = {}): WatchlistEntry {
  const events = over.events ?? [];
  return {
    symbol,
    name: `${symbol} Ltd`,
    unavailable: null,
    maxSeverity: "NONE",
    eventCount: events.length,
    overflow: false,
    ...over,
    events,
    current: {
      price: 100,
      changePct: 0,
      volume: 1_000_000,
      source: "TWELVE_DATA",
      mode: "LIVE",
      isStale: false,
      isDivergent: false,
      divergencePct: null,
      ...over.current,
    },
  };
}

function event(severity: Severity = "MINOR"): DiffEvent {
  return { type: "PRICE_MOVE", severity, occurredAt: "2026-09-05T09:30:00.000Z", detail: {} } as DiffEvent;
}

function tick(symbol: string, over: Partial<LiveTick> = {}): LiveTick {
  return {
    symbol,
    price: 100,
    changePct: 0,
    volume: 1_000_000,
    source: "TWELVE_DATA",
    mode: "LIVE",
    isStale: false,
    isDivergent: false,
    updatedAt: "2026-09-05T09:30:00.000Z",
    ...over,
  };
}

const symbols = (entries: WatchlistEntry[]) => entries.map((e) => e.symbol);

describe("effectiveChangePct", () => {
  it("prefers the live tick over the snapshot the page loaded with", () => {
    const e = entry("INFY", { current: { changePct: 1.2 } as Current });
    expect(effectiveChangePct(e, tick("INFY", { changePct: 3.4 }))).toBe(3.4);
  });

  it("falls back to the snapshot when no tick has arrived for that symbol", () => {
    expect(effectiveChangePct(entry("INFY", { current: { changePct: 1.2 } as Current }))).toBe(1.2);
  });

  // An unavailable row carries placeholders, not measurements. Reading it as flat keeps
  // it out of the ranking rather than letting a fabricated figure compete for the top.
  it("reads flat for an unavailable row, whatever the placeholders say", () => {
    const e = entry("XXXX", {
      unavailable: { reason: "NO_DATA", message: "Nothing cached yet" },
      current: { changePct: 9.9 } as Current,
    });
    expect(effectiveChangePct(e, tick("XXXX", { changePct: 9.9 }))).toBe(0);
  });
});

describe("applyView search", () => {
  const entries = [entry("INFY"), entry("TCS"), entry("RELIANCE")];

  it("matches on ticker and on company name", () => {
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, search: "INF" }))).toEqual(["INFY"]);
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, search: "Ltd" }))).toHaveLength(3);
  });

  it("ignores case and surrounding whitespace, because the box is typed into in a hurry", () => {
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, search: "  tcs " }))).toEqual(["TCS"]);
  });

  it("treats an all-whitespace box as no filter at all", () => {
    expect(applyView(entries, {}, { ...DEFAULT_VIEW, search: "   " })).toHaveLength(3);
  });

  it("returns nothing rather than everything when the query matches nothing", () => {
    expect(applyView(entries, {}, { ...DEFAULT_VIEW, search: "ZZZZ" })).toEqual([]);
  });
});

describe("applyView filters", () => {
  const quiet = entry("TCS");
  const minor = entry("INFY", { events: [event("MINOR")], maxSeverity: "MINOR" });
  const critical = entry("RELIANCE", { events: [event("CRITICAL")], maxSeverity: "CRITICAL" });
  const entries = [quiet, minor, critical];

  it("shows everything under 'all'", () => {
    expect(applyView(entries, {}, { ...DEFAULT_VIEW, filter: "all" })).toHaveLength(3);
  });

  it("keeps only rows with something to report under 'changed'", () => {
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, filter: "changed" }))).toEqual(["RELIANCE", "INFY"]);
  });

  it("narrows to the interrupt-worthy under 'critical'", () => {
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, filter: "critical" }))).toEqual(["RELIANCE"]);
  });

  it("applies search and filter together, not one or the other", () => {
    expect(symbols(applyView(entries, {}, { search: "TCS", filter: "changed", sort: "severity" }))).toEqual([]);
  });
});

describe("applyView sorting", () => {
  it("ranks by severity first, then by how much happened", () => {
    const entries = [
      entry("A", { maxSeverity: "MINOR", eventCount: 5 }),
      entry("B", { maxSeverity: "CRITICAL", eventCount: 1 }),
      entry("C", { maxSeverity: "NOTABLE", eventCount: 2 }),
      entry("D", { maxSeverity: "CRITICAL", eventCount: 3 }),
    ];
    expect(symbols(applyView(entries, {}, DEFAULT_VIEW))).toEqual(["D", "B", "C", "A"]);
  });

  it("is the default view, so an untouched dashboard opens on the worst news", () => {
    expect(DEFAULT_VIEW).toEqual({ search: "", filter: "all", sort: "severity" });
  });

  it("sorts by magnitude of change, so a crash outranks a smaller rally", () => {
    const entries = [
      entry("A", { current: { changePct: 1.5 } as Current }),
      entry("B", { current: { changePct: -8.2 } as Current }),
      entry("C", { current: { changePct: 4.0 } as Current }),
    ];
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, sort: "change" }))).toEqual(["B", "C", "A"]);
  });

  it("re-ranks on live ticks, so the order matches the numbers on screen", () => {
    const entries = [
      entry("A", { current: { changePct: 1.5 } as Current }),
      entry("B", { current: { changePct: 4.0 } as Current }),
    ];
    expect(
      symbols(applyView(entries, { A: tick("A", { changePct: 9.0 }) }, { ...DEFAULT_VIEW, sort: "change" })),
    ).toEqual(["A", "B"]);
  });

  it("sorts price high to low, and symbol A to Z", () => {
    const entries = [
      entry("TCS", { current: { price: 3900 } as Current }),
      entry("INFY", { current: { price: 1450 } as Current }),
      entry("ADANI", { current: { price: 2600 } as Current }),
    ];
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, sort: "price" }))).toEqual(["TCS", "ADANI", "INFY"]);
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, sort: "symbol" }))).toEqual(["ADANI", "INFY", "TCS"]);
  });

  it("sinks unavailable rows under the numeric sorts instead of ranking placeholders", () => {
    const entries = [
      entry("DEAD", {
        unavailable: { reason: "DELISTED", message: "No longer tracked" },
        current: { price: 9999, changePct: 99 } as Current,
      }),
      entry("INFY", { current: { price: 1450, changePct: -2.1 } as Current }),
    ];
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, sort: "price" }))).toEqual(["INFY", "DEAD"]);
    expect(symbols(applyView(entries, {}, { ...DEFAULT_VIEW, sort: "change" }))).toEqual(["INFY", "DEAD"]);
  });

  // React re-renders on every tick; a sort that mutated its input would reorder the
  // caller's array underneath the list it is mapping over.
  it("leaves the caller's array untouched", () => {
    const entries = [entry("A", { maxSeverity: "MINOR" }), entry("B", { maxSeverity: "CRITICAL" })];
    applyView(entries, {}, DEFAULT_VIEW);
    expect(symbols(entries)).toEqual(["A", "B"]);
  });
});

describe("summarise", () => {
  it("counts each row in exactly one severity band", () => {
    const s = summarise([
      entry("A", { maxSeverity: "CRITICAL", events: [event("CRITICAL")] }),
      entry("B", { maxSeverity: "NOTABLE", events: [event("NOTABLE")] }),
      entry("C", { maxSeverity: "MINOR", events: [event("MINOR")] }),
      entry("D"),
    ]);
    expect(s).toMatchObject({ total: 4, changed: 3, critical: 1, notable: 1, minor: 1 });
  });

  // Stale and divergent are data-quality flags on a live quote. An unavailable row has no
  // quote to be stale about, so counting it in both places double-reports one problem.
  it("keeps unavailable rows out of the stale and divergent counts", () => {
    const s = summarise([
      entry("A", { current: { isStale: true } as Current }),
      entry("B", { current: { isDivergent: true, divergencePct: 1.4 } as Current }),
      entry("C", {
        unavailable: { reason: "NO_DATA", message: "Nothing cached yet" },
        current: { isStale: true, isDivergent: true } as Current,
      }),
    ]);
    expect(s).toMatchObject({ total: 3, stale: 1, divergent: 1, unavailable: 1 });
  });

  it("counts a row that is both stale and divergent once in each", () => {
    const s = summarise([entry("A", { current: { isStale: true, isDivergent: true } as Current })]);
    expect(s).toMatchObject({ stale: 1, divergent: 1 });
  });

  it("returns zeroes rather than undefined for an empty watchlist", () => {
    expect(summarise([])).toEqual({
      total: 0,
      changed: 0,
      critical: 0,
      notable: 0,
      minor: 0,
      stale: 0,
      divergent: 0,
      unavailable: 0,
    });
  });
});
