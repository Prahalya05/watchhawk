import { cn } from "../../lib/cn";

export default function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

/** A watchlist row's worth of placeholder, shaped like the real thing. */
export function WatchlistRowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-4 py-4">
      <Skeleton className="h-8 w-8 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-2.5 w-40" />
      </div>
      <Skeleton className="h-6 w-16" />
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-6 w-24" />
    </div>
  );
}
