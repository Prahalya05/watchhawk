import Tag from "./ui/Tag";

export default function StalenessIndicator({ isStale }: { isStale: boolean }) {
  if (!isStale) return null;
  return (
    <Tag tone="warn" title="No fresh update recently — showing the last known price, not a live one">
      Stale
    </Tag>
  );
}
