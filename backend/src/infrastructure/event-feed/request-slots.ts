// The same reserved-slot limiter the Yahoo quote provider uses, extracted so the event
// feeds pace themselves too.
//
// Both feeds are undocumented endpoints with no published quota, and the failure mode for
// exceeding one is being blocked rather than being told. Reserving a slot (rather than
// sleeping a fixed amount per request) is what keeps N concurrent callers from all reading
// "the last request was ages ago" and firing at once.
export class RequestSlots {
  private nextSlotAt = 0;

  constructor(private readonly minGapMs: number) {}

  async reserve(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    // Read-and-advance is synchronous, so two concurrent callers can never be handed the
    // same slot even though the await below interleaves them.
    this.nextSlotAt = slot + this.minGapMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

export async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/xml,application/xml,*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  return res.text();
}
