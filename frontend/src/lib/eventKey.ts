import type { DiffEvent } from "../types";

// A stable identity for one event within one symbol's list.
//
// The explanation drawer used to be addressed by array index. That is only stable while
// the array is: GET /api/watchlist re-ranks events by severity and recency on every
// background refetch, so an event appearing or a severity changing could shuffle the
// list under an open drawer and leave it silently explaining a different event than the
// badge that was clicked — with no visible transition to give it away.
//
// Type plus occurredAt is stable across those re-sorts. The diff engine emits at most one
// PRICE_MOVE / VOLUME_SPIKE / GAP_OPEN per symbol, so a collision would need two discrete
// events of the same type recorded at the identical millisecond.
export function eventKey(event: DiffEvent): string {
  return `${event.type}|${event.occurredAt}`;
}
