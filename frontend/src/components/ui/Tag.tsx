import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Tone = "neutral" | "warn" | "danger" | "info" | "positive" | "accent";

const TONES: Record<Tone, string> = {
  neutral: "bg-hairline text-gray-300",
  warn: "bg-severity-notable/15 text-severity-notable",
  danger: "bg-severity-critical/15 text-severity-critical",
  info: "bg-sky-500/15 text-sky-300",
  positive: "bg-up/15 text-up",
  accent: "bg-accent/15 text-indigo-300",
};

interface Props {
  tone?: Tone;
  title?: string;
  className?: string;
  children: ReactNode;
}

export default function Tag({ tone = "neutral", title, className, children }: Props) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
