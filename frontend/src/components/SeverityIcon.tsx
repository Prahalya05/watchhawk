import type { Severity } from "../types";

const COLORS: Record<Severity, string> = {
  CRITICAL: "bg-severity-critical",
  NOTABLE: "bg-severity-notable",
  MINOR: "bg-severity-minor",
  NONE: "bg-severity-none",
};

export default function SeverityIcon({ severity }: { severity: Severity }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${COLORS[severity]}`} title={severity} />;
}
