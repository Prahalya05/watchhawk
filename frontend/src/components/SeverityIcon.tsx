import type { Severity } from "../types";
import { SEVERITY_META } from "../lib/eventMeta";
import { cn } from "../lib/cn";

interface Props {
  severity: Severity;
  size?: "sm" | "md";
  /** Draw a soft halo — used on the row rail where the dot carries more weight. */
  halo?: boolean;
}

export default function SeverityIcon({ severity, size = "sm", halo = false }: Props) {
  const meta = SEVERITY_META[severity];
  return (
    <span
      title={meta.label}
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3",
        meta.dot,
        halo && severity !== "NONE" && "ring-4 ring-inset ring-white/5",
      )}
    />
  );
}
