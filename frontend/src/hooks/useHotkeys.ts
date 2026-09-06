import { useEffect } from "react";

type Handler = (e: KeyboardEvent) => void;

/**
 * Global single-key shortcuts. Ignores keystrokes while the user is typing in an input,
 * textarea or contenteditable, so "a" in the command bar does not also open Add Symbol.
 */
export function useHotkeys(map: Record<string, Handler>) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing && e.key !== "Escape") return;

      const handler = map[e.key];
      if (handler) {
        e.preventDefault();
        handler(e);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [map]);
}
