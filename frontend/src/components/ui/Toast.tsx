import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type ToastTone = "info" | "success" | "warn" | "danger";

interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
}

interface ToastInput {
  title: string;
  body?: string;
  tone?: ToastTone;
  /** ms before auto-dismiss; 0 keeps it until clicked. */
  duration?: number;
}

interface ToastContextValue {
  push: (t: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const TONE_STYLES: Record<ToastTone, string> = {
  info: "border-l-accent",
  success: "border-l-up",
  warn: "border-l-severity-notable",
  danger: "border-l-severity-critical",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    ({ title, body, tone = "info", duration = 5000 }: ToastInput) => {
      const id = nextId.current++;
      // Cap the stack so a burst of live events can't paper over the whole screen.
      setToasts((prev) => [...prev.slice(-3), { id, title, body, tone }]);
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={cn(
              "pointer-events-auto animate-slide-in-right rounded-lg border border-hairline border-l-2 bg-surface-overlay/95 p-3 text-left shadow-xl backdrop-blur",
              TONE_STYLES[t.tone],
            )}
          >
            <p className="text-sm font-semibold text-gray-100">{t.title}</p>
            {t.body && <p className="mt-0.5 text-xs leading-snug text-gray-400">{t.body}</p>}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
