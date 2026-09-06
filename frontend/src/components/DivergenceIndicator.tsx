import Tag from "./ui/Tag";

interface Props {
  isDivergent: boolean;
  divergencePct: number | null;
}

// Surfaces cross-source disagreement rather than silently resolving it — the diff
// engine's writer picks a primary/authoritative price regardless, but this tells the
// user the sources didn't agree.
export default function DivergenceIndicator({ isDivergent, divergencePct }: Props) {
  if (!isDivergent) return null;
  return (
    <Tag
      tone="danger"
      title={`Primary and fallback data sources disagree by ${((divergencePct ?? 0) * 100).toFixed(2)}%`}
    >
      Sources differ
    </Tag>
  );
}
