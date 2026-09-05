interface Props {
  isDivergent: boolean;
  divergencePct: number | null;
}

// Surfaces cross-source disagreement rather than silently resolving it — the diff
// engine's writer picks a primary/authoritative price regardless, but this tells the
// user the sources didn't agree, per the brief's "conflicting data" requirement.
export default function DivergenceIndicator({ isDivergent, divergencePct }: Props) {
  if (!isDivergent) return null;
  return (
    <span
      className="rounded bg-red-900/60 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
      title={`Primary and fallback data sources disagree by ${((divergencePct ?? 0) * 100).toFixed(2)}%`}
    >
      SOURCES DIFFER
    </span>
  );
}
