import { useEffect, useState } from "react";
import type { DiffEvent, ExplainResponse } from "../types";
import SeverityIcon from "./SeverityIcon";
import Button from "./ui/Button";
import Tag from "./ui/Tag";
import { EVENT_META } from "../lib/eventMeta";
import { formatDateTime } from "../lib/format";
import { cn } from "../lib/cn";
import * as assistantApi from "../api/assistant.api";

interface Props {
  symbol: string;
  event: DiffEvent;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-hairline px-5 py-4">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
      {children}
    </section>
  );
}

// The "why am I seeing this?" panel.
//
// Everything except the optional narration is already in hand — the trace ships with
// GET /api/watchlist — so the panel opens fully populated with no request and no spinner.
// Only the plain-English rewording costs an API call, and it is opt-in per event so
// browsing explanations never quietly burns the free-tier budget.
export default function ExplainDrawer({ symbol, event, onClose }: Props) {
  const { explanation } = event;
  const label = EVENT_META[event.type].label;
  const [narration, setNarration] = useState<ExplainResponse["narration"] | null>(null);
  const [narrating, setNarrating] = useState(false);
  const [narrationError, setNarrationError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleNarrate() {
    setNarrating(true);
    setNarrationError(null);
    try {
      const result = await assistantApi.explainEvent(symbol, event.type, event.occurredAt);
      setNarration(result.narration);
    } catch {
      setNarrationError("Couldn't reach the explanation service. The trace below is unaffected.");
    } finally {
      setNarrating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <aside
        role="dialog"
        aria-label={`Why ${symbol} shows a ${label}`}
        className="relative z-50 flex h-full w-full max-w-xl animate-slide-in-right flex-col overflow-y-auto border-l border-hairline bg-surface shadow-2xl"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-hairline bg-surface/95 px-5 py-4 backdrop-blur">
          <div>
            <div className="flex items-center gap-2">
              <SeverityIcon severity={event.severity} size="md" />
              <h2 className="font-semibold text-gray-100">
                {symbol} · {label}
              </h2>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {explanation.rule} · flagged {event.severity.toLowerCase()} at {formatDateTime(event.occurredAt)}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close · Esc
          </Button>
        </header>

        <div className="px-5 py-4">
          <p className="text-sm leading-relaxed text-gray-200">{explanation.summary}</p>

          <div className="mt-3">
            {narration ? (
              <div className="rounded-lg border border-hairline bg-surface-raised p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                    In plain English
                  </span>
                  {/* Labelled on the output itself, not just in a tooltip: a reader has to
                      be able to tell computed text from generated text at a glance. */}
                  <Tag
                    tone={narration.generatedBy === "GEMINI" ? "accent" : "neutral"}
                    title={
                      narration.generatedBy === "GEMINI"
                        ? "Worded by Gemini from the computed trace below. The numbers come from the trace, not from the model."
                        : (narration.reason ?? "Generated from the rule itself, with no model involved.")
                    }
                  >
                    {narration.generatedBy === "GEMINI" ? "AI-worded" : "Rule-generated"}
                  </Tag>
                </div>
                <p className="text-sm leading-relaxed text-gray-300">{narration.text}</p>
                {narration.generatedBy === "DETERMINISTIC" && narration.reason && (
                  <p className="mt-2 text-[11px] text-gray-600">
                    Model unavailable ({narration.reason}) — showing the computed summary.
                  </p>
                )}
              </div>
            ) : (
              <Button size="sm" variant="secondary" onClick={handleNarrate} loading={narrating}>
                {narrating ? "Wording it…" : "Explain in plain English"}
              </Button>
            )}
            {narrationError && <p className="mt-2 text-xs text-severity-critical">{narrationError}</p>}
          </div>
        </div>

        <Section title="What went in">
          <dl className="space-y-3">
            {explanation.inputs.map((input, i) => (
              <div key={i}>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-sm text-gray-400">{input.label}</dt>
                  <dd className="num shrink-0 text-sm text-gray-100">{input.value}</dd>
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-gray-600">{input.source}</p>
              </div>
            ))}
          </dl>
        </Section>

        {explanation.steps.length > 0 && (
          <Section title="How it was scored">
            <div className="space-y-2">
              {explanation.steps.map((step, i) => (
                <div key={i} className="rounded-lg bg-surface-raised p-2.5">
                  <div className="text-xs text-gray-400">{step.label}</div>
                  <div className="num mt-1 flex flex-wrap items-baseline gap-2 text-xs">
                    <span className="text-gray-500">{step.expression}</span>
                    <span className="text-gray-600">=</span>
                    <span className="text-gray-100">{step.value}</span>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {explanation.thresholds.length > 0 && (
          <Section title="Thresholds tested">
            <ul className="space-y-1.5">
              {explanation.thresholds.map((t, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className={cn("w-4 shrink-0 text-center", t.met ? "text-up" : "text-gray-700")}>
                    {t.met ? "✓" : "·"}
                  </span>
                  <span className={t.met ? "text-gray-200" : "text-gray-600"}>{t.severity}</span>
                  <span className="num text-xs text-gray-600">{t.test}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-gray-600">
              The highest band that passed is the severity you see. Bands are defined in {explanation.ruleSource}.
            </p>
          </Section>
        )}

        <Section title="Where the data came from">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-gray-500">Source</dt>
            <dd className="text-gray-200">
              {explanation.provenance.source}
              <span className="ml-1.5 text-xs text-gray-500">({explanation.provenance.mode})</span>
            </dd>

            <dt className="text-gray-500">Quote observed</dt>
            <dd className="text-gray-200">{formatDateTime(explanation.provenance.observedAt)}</dd>

            <dt className="text-gray-500">Your baseline</dt>
            <dd className="text-gray-200">{formatDateTime(explanation.provenance.baselineAt)}</dd>

            <dt className="text-gray-500">Stats computed</dt>
            <dd className="text-gray-200">
              {explanation.provenance.statsComputedAt
                ? formatDateTime(explanation.provenance.statsComputedAt)
                : "unknown"}
              {explanation.provenance.statsHistoryDays !== null && (
                <span className="ml-1.5 text-xs text-gray-500">
                  from {explanation.provenance.statsHistoryDays} bars
                </span>
              )}
            </dd>
          </dl>

          {(explanation.provenance.isStale || explanation.provenance.isDivergent) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {explanation.provenance.isStale && <Tag tone="warn">Stale quote</Tag>}
              {explanation.provenance.isDivergent && (
                <Tag tone="danger">
                  Sources disagree
                  {explanation.provenance.divergencePct !== null &&
                    ` (${Math.abs(explanation.provenance.divergencePct).toFixed(2)}%)`}
                </Tag>
              )}
            </div>
          )}
        </Section>

        {explanation.caveats.length > 0 && (
          <Section title="What this doesn't account for">
            <ul className="space-y-2">
              {explanation.caveats.map((caveat, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed text-gray-400">
                  <span className="text-gray-700">—</span>
                  <span>{caveat}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </aside>
    </div>
  );
}
