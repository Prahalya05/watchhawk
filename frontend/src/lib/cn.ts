type ClassValue = string | number | false | null | undefined;

/** Minimal classnames joiner — no dependency, no variant merging, just filtering. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
