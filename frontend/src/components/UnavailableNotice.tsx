import type { WatchlistUnavailable } from "../types";
import Tag from "./ui/Tag";

const LABELS: Record<WatchlistUnavailable["reason"], string> = {
  DELISTED: "Not tracked",
  NO_DATA: "No data yet",
};

// The visible half of the fix for silently-dropped rows. A watchlist that quietly
// shortens itself is indistinguishable from one that is working, so the row stays and
// says why it has no numbers — with the message the server supplied rather than a guess
// made here, so the two can never drift apart.
export default function UnavailableNotice({ unavailable }: { unavailable: WatchlistUnavailable }) {
  return (
    <Tag tone="neutral" title={unavailable.message}>
      {LABELS[unavailable.reason]}
    </Tag>
  );
}
