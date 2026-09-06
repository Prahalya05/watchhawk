import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface MenuItem {
  key: string;
  label: ReactNode;
  onSelect: () => void;
  active?: boolean;
  danger?: boolean;
}

interface Props {
  /** The trigger. Rendered inside a button. */
  label: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  buttonClassName?: string;
}

// Small dependency-free dropdown: closes on outside click, on Escape, and after a pick.
export default function Menu({ label, items, align = "right", buttonClassName }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-lg border border-hairline-strong bg-surface-raised px-3 text-sm text-gray-200 hover:bg-surface-overlay",
          buttonClassName,
        )}
      >
        {label}
        <span className="text-[10px] text-gray-500">▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-50 mt-1.5 min-w-[11rem] animate-slide-up overflow-hidden rounded-lg border border-hairline bg-surface-overlay p-1 shadow-2xl",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              onClick={() => {
                item.onSelect();
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-white/5",
                item.danger ? "text-severity-critical" : "text-gray-300",
              )}
            >
              {item.label}
              {item.active && <span className="text-accent">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
