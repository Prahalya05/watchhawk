import { useState } from "react";
import type { DiffEvent, ExplainResponse } from "../types";
import SeverityIcon from "./SeverityIcon";
import * as assistantApi from "../api/assistant.api";

interface Props {
  symbol: string;
  event: DiffEvent;
  onClose: () => void;
}

const TYPE_LABELS: Record<DiffEvent["type"], string> = {
  PRICE_MOVE: "Price move",
  VOLUME_SPIKE: "Volume spike",
  FIFTY_TWO_WEEK_EXTREME: "52-week extreme",
  GAP_OPEN: "Gap open",
  NEWS: "News",
  RATING_CHANGE: "Rating change",
  CORPORATE_ACTION: "Corporate action",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-gray-900 px-5 py-4">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
      {children}
    </section>
  );
}

const timestamp = (iso: string) => new Date(iso).toLocaleString();

// The "why am I seeing this?" panel.
//
// Everything except the optional narration is already in hand — the trace ships with
// GET /api/watchlist — so the panel opens fully populated with no request and no spinner.
// Only the plain-English rewording costs an API call, and it is opt-in per event so
// browsing explanations never quietly burns the free-tier budget.
export default function ExplainDrawer({ symbol, event, onClose }: Props) {
  const { explanation } = event;
  const [narration, setNarration] = useState<ExplainResponse["narration"] | null>(null);
  const [narrating, setNarrating] = useState(false);
  const [narrationError, setNarrationError] = useState<string | null>(null);

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
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />

      <aside
        role="dialog"
        aria-label={`Why ${symbol} shows a ${TYPE_LABELS[event.type]}`}
        className="relative z-50 flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-gray-800 bg-gray-950 shadow-2xl"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-gray-900 bg-gray-950 px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <SeverityIcon severity={event.severity} />
              <h2 className="font-semibold text-gray-100">
                {symbol} · {TYPE_LABELS[event.type]}
              </h2>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {explanation.rule} · flagged {event.severity.toLowerCase()} at {timestamp(event.occurredAt)}
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md border border-gray-800 px-2 py-1 text-xs text-gray-400 hover:bg-gray-900">
            Close
          </button>
        </header>

        <div className="px-5 py-4">
          <p className="text-sm leading-relaxed text-gray-200">{explanation.summary}</p>

          <div className="mt-3">
            {narration ? (
              <div className="rounded-md border border-gray-800 bg-gray-900/50 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">In plain English</span>
                  {/* Labelled on the output itself, not just in a tooltip: a reader has to
                      be able to tell computed text from generated text at a glance. */}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      narration.generatedBy === "GEMINI" ? "bg-indigo-900/60 text-indigo-300" : "bg-gray-800 text-gray-400"
                    }`}
                    title={
                      narration.generatedBy === "GEMINI"
                        ? "Worded by Gemini from the computed trace below. The numbers come from the trace, not from the model."
                        : narration.reason ?? "Generated from the rule itself, with no model involved."
                    }
                  >
                    {narration.generatedBy === "GEMINI" ? "AI-worded" : "Rule-generated"}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-gray-300">{narration.text}</p>
                {narration.generatedBy === "DETERMINISTIC" && narration.reason && (
                  <p className="mt-2 text-[11px] text-gray-600">Model unavailable ({narration.reason}) — showing the computed summary.</p>
                )}
              </div>
            ) : (
              <button
                onClick={handleNarrate}
                disabled={narrating}
                className="rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-900 disabled:opacity-50"
              >
                {narrating ? "Wording it…" : "Explain in plain English"}
              </button>
            )}
            {narrationError && <p className="mt-2 text-xs text-red-400">{narrationError}</p>}
          </div>
        </div>

        <Section title="What went in">
          <dl className="space-y-3">
            {explanation.inputs.map((input, i) => (
              <div key={i}>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-sm text-gray-400">{input.label}</dt>
                  <dd className="shrink-0 font-mono text-sm tabular-nums text-gray-100">{input.value}</dd>
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
                <div key={i} className="rounded-md bg-gray-900/60 p-2.5">
                  <div className="text-xs text-gray-400">{step.label}</div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-2 font-mono text-xs">
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
                  <span className={`w-4 shrink-0 text-center ${t.met ? "text-green-400" : "text-gray-700"}`}>{t.met ? "✓" : "·"}</span>
                  <span className={t.met ? "text-gray-200" : "text-gray-600"}>{t.severity}</span>
                  <span className="font-mono text-xs text-gray-600">{t.test}</span>
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
            <dd className="text-gray-200">{timestamp(explanation.provenance.observedAt)}</dd>

            <dt className="text-gray-500">Your baseline</dt>
            <dd className="text-gray-200">{timestamp(explanation.provenance.baselineAt)}</dd>

            <dt className="text-gray-500">Stats computed</dt>
            <dd className="text-gray-200">
              {explanation.provenance.statsComputedAt ? timestamp(explanation.provenance.statsComputedAt) : "unknown"}
              {explanation.provenance.statsHistoryDays !== null && (
                <span className="ml-1.5 text-xs text-gray-500">from {explanation.provenance.statsHistoryDays} bars</span>
              )}
            </dd>
          </dl>

          {(explanation.provenance.isStale || explanation.provenance.isDivergent) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {explanation.provenance.isStale && (
                <span className="rounded bg-yellow-900/60 px-1.5 py-0.5 text-[10px] font-medium text-yellow-300">STALE QUOTE</span>
              )}
              {explanation.provenance.isDivergent && (
                <span className="rounded bg-orange-900/60 px-1.5 py-0.5 text-[10px] font-medium text-orange-300">
                  SOURCES DISAGREE
                  {explanation.provenance.divergencePct !== null && ` (${Math.abs(explanation.provenance.divergencePct).toFixed(2)}%)`}
                </span>
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
