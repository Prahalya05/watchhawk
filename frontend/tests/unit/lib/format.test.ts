import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatClock,
  formatCompact,
  formatDateTime,
  formatPercent,
  formatPrice,
  formatRelativeTime,
  formatSignedNumber,
} from "../../../src/lib/format";

// This is an Indian-market watchlist, so the money helpers pin the en-IN conventions
// rather than a generic locale: the 2,2,3 digit grouping and the lakh/crore compact
// scale. Both are explicit in the source (`new Intl.NumberFormat("en-IN", ...)`), which
// is what makes them safe to assert exactly here — the machine's own locale cannot move
// them. The clock helpers below pass no locale, so they are asserted by shape instead.

describe("formatPrice", () => {
  it("groups in the Indian 2,2,3 pattern, not in thousands", () => {
    expect(formatPrice(123456.7)).toBe("₹1,23,456.70");
    expect(formatPrice(1234567.891)).toBe("₹12,34,567.89");
  });

  it("always shows both paise, so a column of prices stays decimal-aligned", () => {
    expect(formatPrice(0)).toBe("₹0.00");
    expect(formatPrice(1500)).toBe("₹1,500.00");
  });

  it("puts the minus outside the symbol", () => {
    expect(formatPrice(-45.5)).toBe("-₹45.50");
  });
});

describe("formatCompact", () => {
  // Volume is the only caller. A raw 12345678 in a table cell is unreadable and, worse,
  // invites a misread by an order of magnitude; the compact form is the point.
  it("uses the Indian scale — thousand, lakh, crore", () => {
    expect(formatCompact(12500)).toBe("12.5K");
    expect(formatCompact(1234567)).toBe("12.3L");
    expect(formatCompact(45000000)).toBe("4.5Cr");
  });

  it("leaves small numbers alone rather than inventing a suffix", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(950)).toBe("950");
  });
});

describe("formatPercent", () => {
  it("signs a gain explicitly, because '+1.2%' and '1.2%' read differently at a glance", () => {
    expect(formatPercent(1.234)).toBe("+1.23%");
  });

  it("relies on the number's own minus for a loss", () => {
    expect(formatPercent(-1.235)).toBe("-1.24%");
  });

  it("does not sign a flat day", () => {
    expect(formatPercent(0)).toBe("0.00%");
  });

  it("can be asked to drop the plus, for contexts that already say 'change'", () => {
    expect(formatPercent(1.234, false)).toBe("1.23%");
    expect(formatPercent(-1.234, false)).toBe("-1.23%");
  });
});

describe("formatSignedNumber", () => {
  it("signs gains and honours the requested precision", () => {
    expect(formatSignedNumber(2.5)).toBe("+2.50");
    expect(formatSignedNumber(-2.5)).toBe("-2.50");
    expect(formatSignedNumber(2.5, 0)).toBe("+3");
  });

  // Documenting a rough edge rather than endorsing it: toFixed keeps the sign of a value
  // that rounds away to nothing, so a -0.004 delta renders as "-0.00". Harmless in the
  // places this is used today; worth knowing before it is pointed at a headline number.
  it("still shows a minus on a loss too small to survive rounding", () => {
    expect(formatSignedNumber(-0.004)).toBe("-0.00");
  });
});

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-09-05T12:00:00.000Z");

  afterEach(() => {
    vi.useRealTimers();
  });

  function at(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    return formatRelativeTime(iso);
  }

  it("collapses the last few seconds to 'just now'", () => {
    // A feed that flickers "1s ago / 2s ago / 3s ago" draws the eye to the timestamp
    // instead of to the event.
    expect(at("2026-09-05T11:59:56.000Z")).toBe("just now");
    expect(at("2026-09-05T12:00:00.000Z")).toBe("just now");
  });

  it("climbs one unit at a time as the gap widens", () => {
    expect(at("2026-09-05T11:59:30.000Z")).toBe("30s ago");
    expect(at("2026-09-05T11:57:00.000Z")).toBe("3m ago");
    expect(at("2026-09-05T10:00:00.000Z")).toBe("2h ago");
    expect(at("2026-07-05T12:00:00.000Z")).toBe("2mo ago");
    expect(at("2024-09-05T12:00:00.000Z")).toBe("2y ago");
  });

  // `numeric: "auto"` is what buys these: at exactly one unit the formatter reaches for
  // the word instead of the count. It is the nicer reading, and it is also the reason a
  // test that expected "1mo ago" would be wrong rather than the code.
  it("names a distance of exactly one unit rather than counting it", () => {
    expect(at("2026-09-04T12:00:00.000Z")).toBe("yesterday");
    expect(at("2026-08-05T12:00:00.000Z")).toBe("last mo.");
  });

  it("reads a Date as happily as an ISO string", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeTime(new Date("2026-09-05T11:57:00.000Z"))).toBe("3m ago");
  });

  // Clock skew between the browser and the server is normal, so a timestamp can arrive
  // from the near future. It should read as a time, not as a negative age.
  it("phrases a future timestamp forwards", () => {
    expect(at("2026-09-05T12:02:00.000Z")).toBe("in 2m");
  });
});

// formatClock and formatDateTime intentionally pass no locale — they follow whoever is
// looking at the screen. That makes their exact output a property of the runtime, not of
// this code, so these assert the shape and the fields, which is all the code decides.

describe("formatClock", () => {
  it("renders hours, minutes and seconds", () => {
    // 14:07:09 UTC, read back on either a 24-hour or a 12-hour clock.
    expect(formatClock("2026-09-05T14:07:09.000Z")).toMatch(/\b(14|0?2):07:09\b/);
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(formatClock(new Date("2026-09-05T14:07:09.000Z"))).toBe(formatClock("2026-09-05T14:07:09.000Z"));
  });
});

describe("formatDateTime", () => {
  it("carries the date, because a provenance timestamp days old must not look like today", () => {
    const rendered = formatDateTime("2026-09-05T14:07:09.000Z");
    expect(rendered).toMatch(/Sep/);
    expect(rendered).toMatch(/\b5\b/);
    expect(rendered).toMatch(/\b(14|0?2):07\b/);
  });

  it("drops seconds — a baseline is not a tick", () => {
    expect(formatDateTime("2026-09-05T14:07:09.000Z")).not.toMatch(/:09\b/);
  });
});
