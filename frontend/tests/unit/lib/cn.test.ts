import { describe, expect, it } from "vitest";
import { cn } from "../../../src/lib/cn";

// cn is four lines, and every conditional className in the app goes through it. These
// exist mainly to pin what it deliberately does *not* do — it is a joiner, not a variant
// merger, and a future reader reaching for `clsx`-style behaviour should find that
// written down rather than discover it in a rendered component.

describe("cn", () => {
  it("joins the classes it is given with single spaces", () => {
    expect(cn("rounded", "border", "px-2")).toBe("rounded border px-2");
  });

  // The whole point: a row built this way must not emit "row false" when it is fresh.
  it("drops the falsy branches of a conditional class", () => {
    const rowClass = (isStale: boolean) => cn("row", isStale && "opacity-60");
    expect(rowClass(true)).toBe("row opacity-60");
    expect(rowClass(false)).toBe("row");
  });

  it("skips null, undefined and the empty string as well as false", () => {
    expect(cn("row", null, undefined, "")).toBe("row");
  });

  it("keeps a numeric class but drops a zero, matching how falsiness is normally used", () => {
    expect(cn("gap", 2)).toBe("gap 2");
    expect(cn("gap", 0)).toBe("gap");
  });

  it("returns an empty string when nothing survives, so className stays valid", () => {
    expect(cn()).toBe("");
    expect(cn(false, null, undefined)).toBe("");
  });

  // Documented, not endorsed: later classes do not override earlier ones the way
  // tailwind-merge would. Both survive, and CSS order decides. Every caller today passes
  // mutually exclusive branches, which is why the dependency has not been earned.
  it("does not de-duplicate or resolve conflicting utilities", () => {
    expect(cn("px-2", "px-4")).toBe("px-2 px-4");
    expect(cn("flex", "flex")).toBe("flex flex");
  });
});
