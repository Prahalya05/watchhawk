import { useEffect, useState } from "react";
import type { SocketStatus } from "../ws/useMarketSocket";
import { cn } from "../lib/cn";
import { formatRelativeTime } from "../lib/format";

interface Props {
  status: SocketStatus;
  lastMessageAt: number | null;
}

const META: Record<SocketStatus, { label: string; dot: string; text: string }> = {
  live: { label: "Live", dot: "bg-up animate-pulse-ring", text: "text-up" },
  connecting: { label: "Connecting", dot: "bg-severity-notable", text: "text-severity-notable" },
  reconnecting: { label: "Reconnecting", dot: "bg-severity-critical", text: "text-severity-critical" },
};

// Tells the user whether the numbers on screen are actually moving. Without it, a dead
// socket and a genuinely quiet market look identical.
export default function ConnectionPill({ status, lastMessageAt }: Props) {
  const meta = META[status];
  // Re-render on a slow tick so "3s ago" doesn't freeze while the socket is quiet.
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      title={lastMessageAt ? `Last update ${formatRelativeTime(new Date(lastMessageAt))}` : "No updates yet"}
      className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-raised px-2.5 py-1 text-xs font-medium"
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      <span className={meta.text}>{meta.label}</span>
    </span>
  );
}
