import { describe, expect, it } from "vitest";
import type { EventType, Severity } from "../../../src/types";
import { EVENT_META, SEVERITY_META, eventLabel, severityRank } from "../../../src/lib/eventMeta";

// eventMeta exists because three components each carried their own copy of these maps and
// they drifted — one said "52w extreme", another "52-week extreme". Centralising the
// vocabulary only helps if the map stays complete and the ranking stays monotonic, which
// nothing else checks: a missing entry renders as a raw enum name, and a wrong rank
// quietly reorders the dashboard.

// Listing the union members as keys rather than as an array is deliberate. Adding a case
// to EventType or Severity without extending these breaks the build here, which is the
// only moment anyone is thinking about the new case.
const ALL_EVENT_TYPES: Record<EventType, true> = {
  PRICE_MOVE: true,
  VOLUME_SPIKE: true,
  GAP_OPEN: true,
  FIFTY_TWO_WEEK_EXTREME: true,
  NEWS: true,
  RATING_CHANGE: true,
  CORPORATE_ACTION: true,
};

const ALL_SEVERITIES: Record<Severity, true> = {
  CRITICAL: true,
  NOTABLE: true,
  MINOR: true,
  NONE: true,
};

const eventTypes = Object.keys(ALL_EVENT_TYPES) as EventType[];
const severities = Object.keys(ALL_SEVERITIES) as Severity[];

describe("EVENT_META", () => {
  it("describes every event type the backend can emit", () => {
    expect(Object.keys(EVENT_META).sort()).toEqual([...eventTypes].sort());
  });

  it("gives each type a label, a shorter label and a glyph, none of them blank", () => {
    for (const type of eventTypes) {
      const meta = EVENT_META[type];
      expect(meta.label.trim(), type).not.toBe("");
      expect(meta.short.trim(), type).not.toBe("");
      expect(meta.glyph.trim(), type).not.toBe("");
    }
  });

  it("keeps the short label short enough for a badge", () => {
    for (const type of eventTypes) {
      expect(EVENT_META[type].short.length, type).toBeLessThanOrEqual(6);
    }
  });

  it("uses a distinct glyph per type, since the badge is often read by shape alone", () => {
    const glyphs = eventTypes.map((type) => EVENT_META[type].glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe("eventLabel", () => {
  it("spells out the wire enum", () => {
    expect(eventLabel("FIFTY_TWO_WEEK_EXTREME")).toBe("52-week extreme");
    expect(eventLabel("VOLUME_SPIKE")).toBe("Volume spike");
  });

  // A backend that ships a new event type before the frontend knows about it should show
  // the raw name — ugly, but honest and searchable — rather than an empty badge.
  it("falls back to the raw name for a type it has never heard of", () => {
    expect(eventLabel("SOMETHING_NEW" as EventType)).toBe("SOMETHING_NEW");
  });
});

describe("SEVERITY_META", () => {
  it("describes every severity band", () => {
    expect(Object.keys(SEVERITY_META).sort()).toEqual([...severities].sort());
  });

  it("ranks the bands strictly in order of how much they should interrupt someone", () => {
    expect(severityRank("CRITICAL")).toBeGreaterThan(severityRank("NOTABLE"));
    expect(severityRank("NOTABLE")).toBeGreaterThan(severityRank("MINOR"));
    expect(severityRank("MINOR")).toBeGreaterThan(severityRank("NONE"));
    expect(severityRank("NONE")).toBe(0);
  });

  // applyView sorts on this. An unknown severity ranking above a known one would put an
  // unrenderable row at the top of the list.
  it("ranks an unrecognised severity at the bottom rather than crashing", () => {
    expect(severityRank("SEVERE" as Severity)).toBe(0);
  });

  // The realistic drift here is copy-paste: a block cloned from CRITICAL keeps a
  // `severity-critical` class under NOTABLE, and a whole band renders in the wrong colour
  // while every test that only checks labels still passes.
  it("colours each band from its own token", () => {
    for (const severity of ["CRITICAL", "NOTABLE", "MINOR"] as const) {
      const token = `severity-${severity.toLowerCase()}`;
      const meta = SEVERITY_META[severity];
      for (const className of [meta.dot, meta.text, meta.chip, meta.border]) {
        expect(className, `${severity} / ${className}`).toContain(token);
      }
    }
  });

  // NONE is the deliberate exception: a quiet row is styled neutrally, not in a fourth
  // colour that competes with the three that mean something.
  it("styles the quiet band neutrally, borrowing no severity colour", () => {
    const meta = SEVERITY_META.NONE;
    expect(meta.label).toBe("Quiet");
    expect(meta.text).not.toContain("severity-");
    expect(meta.chip).not.toContain("severity-");
    expect(meta.border).toBe("border-l-transparent");
  });

  it("labels every band in prose, for the places a colour alone will not do", () => {
    for (const severity of severities) {
      expect(SEVERITY_META[severity].label.trim(), severity).not.toBe("");
      expect(SEVERITY_META[severity].label, severity).not.toBe(severity);
    }
  });
});
