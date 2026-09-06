import { useId } from "react";

interface Props {
  points: number[];
  width?: number;
  height?: number;
  /** Overrides the auto colour (last vs first). Pass a Tailwind text-* colour value. */
  className?: string;
}

// Hand-drawn SVG sparkline — no charting dependency. Fed by the rolling in-memory tick
// history (see usePriceHistory); it starts empty and fills in as live ticks arrive, so a
// symbol that has not moved since the page opened simply shows a flat baseline.
export default function Sparkline({ points, width = 96, height = 28, className }: Props) {
  const gradientId = useId();

  if (points.length < 2) {
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="2 3"
          className="text-hairline-strong"
        />
      </svg>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const pad = 3;
  const usableH = height - pad * 2;

  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = pad + usableH - ((p - min) / span) * usableH;
    return [x, y] as const;
  });

  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  const rising = points[points.length - 1] >= points[0];
  const tone = className ?? (rising ? "text-up" : "text-down");
  const [lastX, lastY] = coords[coords.length - 1];

  return (
    <svg width={width} height={height} className={tone} aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="2" fill="currentColor" />
    </svg>
  );
}
