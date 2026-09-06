import { describe, expect, it } from "vitest";
import type { DiffEvent, EventType } from "../../../src/types";
import { eventKey } from "../../../src/lib/eventKey";

// eventKey replaced addressing the explanation drawer by array index. GET /api/watchlist
// re-ranks a symbol's events on every background refetch, so an index could silently
// point at a different event under an open drawer. These pin the property that fixed it:
// the key survives a re-sort, and it distinguishes the events that can coexist.

function event(type: EventType, occurredAt: string): DiffEvent {
  return { type, severity: "MINOR", occurredAt, detail: {} } as DiffEvent;
}

describe("eventKey", () => {
  it("identifies an event by what it is and when it happened, not by where it sits", () => {
    const e = event("PRICE_MOVE", "2026-09-05T09:30:00.000Z");
    expect(eventKey(e)).toBe("PRICE_MOVE|2026-09-05T09:30:00.000Z");
  });

  it("is unchanged when the list is re-sorted around it", () => {
    const move = event("PRICE_MOVE", "2026-09-05T09:30:00.000Z");
    const spike = event("VOLUME_SPIKE", "2026-09-05T09:45:00.000Z");
    const before = [move, spike].map(eventKey);
    const after = [spike, move].map(eventKey);
    expect(after).toEqual([...before].reverse());
  });

  it("separates two events of different types recorded at the same instant", () => {
    const at = "2026-09-05T09:30:00.000Z";
    expect(eventKey(event("PRICE_MOVE", at))).not.toBe(eventKey(event("GAP_OPEN", at)));
  });

  it("separates two events of the same type at different instants", () => {
    expect(eventKey(event("NEWS", "2026-09-05T09:30:00.000Z"))).not.toBe(
      eventKey(event("NEWS", "2026-09-05T09:30:00.001Z")),
    );
  });

  // The documented collision: the diff engine emits at most one of each discrete type per
  // symbol, so two NEWS events at the identical millisecond would be needed to break it.
  // Pinning it means the assumption is visible if that ever stops holding.
  it("collides only when type and timestamp are both identical", () => {
    const at = "2026-09-05T09:30:00.000Z";
    expect(eventKey(event("NEWS", at))).toBe(eventKey(event("NEWS", at)));
  });
});
