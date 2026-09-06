import type { ReactNode } from "react";

interface Props {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}

export default function AuthLayout({ title, subtitle, children, footer }: Props) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      {/* Soft accent glow behind the card — the only decoration on an otherwise flat canvas. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[36rem] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]"
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/15 text-lg text-accent">◎</span>
          <div>
            <h1 className="text-base font-bold text-gray-100">Smart Watchlist</h1>
            <p className="text-xs text-gray-500">Reports what changed, not the current quote</p>
          </div>
        </div>

        <div className="card p-6 shadow-2xl">
          <h2 className="text-lg font-semibold text-gray-100">{title}</h2>
          <p className="mb-5 mt-1 text-sm text-gray-500">{subtitle}</p>
          {children}
        </div>

        <p className="mt-4 text-center text-xs text-gray-500">{footer}</p>
      </div>
    </div>
  );
}

export function AuthField({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-gray-400">{label}</span>
      <input
        {...props}
        className="h-10 rounded-lg border border-hairline-strong bg-surface-raised px-3 text-sm text-gray-100 placeholder:text-gray-600"
      />
      {hint && <span className="text-[11px] text-gray-600">{hint}</span>}
    </label>
  );
}
