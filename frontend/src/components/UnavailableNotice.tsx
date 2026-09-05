import type { WatchlistUnavailable } from "../types";

const LABELS: Record<WatchlistUnavailable["reason"], string> = {
  DELISTED: "NOT TRACKED",
  NO_DATA: "NO DATA YET",
};

// The visible half of the fix for silently-dropped rows. A watchlist that quietly
// shortens itself is indistinguishable from one that is working, so the row stays and
// says why it has no numbers — with the message the server supplied rather than a guess
// made here, so the two can never drift apart.
export default function UnavailableNotice({ unavailable }: { unavailable: WatchlistUnavailable }) {
  return (
    <span
      className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-300"
      title={unavailable.message}
    >
      {LABELS[unavailable.reason]}
    </span>
  );
}
