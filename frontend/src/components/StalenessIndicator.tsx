export default function StalenessIndicator({ isStale }: { isStale: boolean }) {
  if (!isStale) return null;
  return (
    <span
      className="rounded bg-yellow-900/60 px-1.5 py-0.5 text-[10px] font-medium text-yellow-300"
      title="No fresh update recently — showing the last known price, not a live one"
    >
      STALE
    </span>
  );
}
