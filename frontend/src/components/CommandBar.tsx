import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as assistantApi from "../api/assistant.api";
import type { AssistantResult } from "../types";
import { WATCHLIST_DIFF_KEY, WATCHLIST_ITEMS_KEY } from "../hooks/useWatchlist";

const STATUS_STYLES: Record<AssistantResult["status"], string> = {
  EXECUTED: "border-green-900 bg-green-950/40 text-green-200",
  NEEDS_CONFIRMATION: "border-yellow-900 bg-yellow-950/40 text-yellow-200",
  REJECTED: "border-red-900/70 bg-red-950/30 text-red-200",
};

// Natural-language command bar.
//
// Two things it deliberately does NOT do. It doesn't hide how a command was understood —
// every result says whether the built-in patterns or Gemini read it, because a user who
// can't tell can't learn which phrasings are free and reliable. And it doesn't
// auto-execute a removal: the server returns NEEDS_CONFIRMATION for destructive intents
// and this renders the confirm step rather than deciding on the user's behalf.
export default function CommandBar() {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [result, setResult] = useState<AssistantResult | null>(null);
  // The exact text the pending result was parsed from. Confirming used to re-send
  // whatever was in the input box at that moment, so editing the box between "remove X?"
  // and "Yes, remove X" executed the edited command while the button still promised X.
  // Pinning it here means the confirmed action is the action that was described.
  const [pendingInput, setPendingInput] = useState("");

  const status = useQuery({
    queryKey: ["assistant", "status"],
    queryFn: assistantApi.fetchAssistantStatus,
    staleTime: 60_000,
  });

  const command = useMutation({
    mutationFn: ({ input, confirm }: { input: string; confirm: boolean }) => assistantApi.runCommand(input, confirm),
    onSuccess: (data, variables) => {
      setResult(data);
      if (data.status === "NEEDS_CONFIRMATION") setPendingInput(variables.input);
      if (data.status === "EXECUTED") {
        setText("");
        queryClient.invalidateQueries({ queryKey: WATCHLIST_DIFF_KEY });
        queryClient.invalidateQueries({ queryKey: WATCHLIST_ITEMS_KEY });
        // A command may have spent budget, so the remaining allowance shown below is
        // stale the moment one runs.
        queryClient.invalidateQueries({ queryKey: ["assistant", "status"] });
      }
    },
  });

  const pendingConfirmation = result?.status === "NEEDS_CONFIRMATION" ? result : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const input = text.trim();
    if (!input) return;
    setResult(null);
    command.mutate({ input, confirm: false });
  }

  return (
    <div className="mb-4">
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a command — add TCS, why is SUZLON flagged, dismiss all…"
          maxLength={500}
          className="flex-1 rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:border-gray-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={command.isPending || text.trim().length === 0}
          className="rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-900 hover:bg-white disabled:opacity-40"
        >
          {command.isPending ? "Running…" : "Run"}
        </button>
      </form>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600">
        <span>Try:</span>
        {(status.data?.examples ?? []).map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setText(example)}
            className="rounded border border-gray-900 px-1.5 py-0.5 hover:border-gray-700 hover:text-gray-400"
          >
            {example}
          </button>
        ))}

        <span
          className="ml-auto"
          title={
            status.data?.budget
              ? `Gemini handles phrasings the built-in patterns can't read. ${status.data.budget.dayUsed}/${status.data.budget.dayLimit} requests used today.`
              : "No Gemini key configured — commands are read by the built-in pattern parser, which covers the common phrasings."
          }
        >
          {status.data
            ? status.data.available
              ? `AI fallback on · ${status.data.model}`
              : status.data.budget
                ? "AI fallback paused (budget spent) · built-in patterns still work"
                : "Built-in patterns only · no AI key"
            : ""}
        </span>
      </div>

      {command.isError && (
        <p className="mt-2 rounded-md border border-red-900/70 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          Couldn't reach the assistant.
        </p>
      )}

      {result && (
        <div className={`mt-2 rounded-md border px-3 py-2 text-sm ${STATUS_STYLES[result.status]}`}>
          <p>{result.message}</p>

          {pendingConfirmation && (
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => command.mutate({ input: pendingInput, confirm: true })}
                disabled={command.isPending}
                className="rounded-md bg-yellow-200 px-2.5 py-1 text-xs font-medium text-yellow-950 hover:bg-yellow-100 disabled:opacity-50"
              >
                Yes, remove {pendingConfirmation.intent.symbol}
              </button>
              <button
                onClick={() => setResult(null)}
                className="rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-900"
              >
                Cancel
              </button>
            </div>
          )}

          <p className="mt-1.5 text-[11px] opacity-70">
            Read by {result.interpretedBy === "GEMINI" ? "Gemini" : "built-in patterns (no AI call)"}
            {result.intent.action !== "UNKNOWN" && ` → ${result.intent.action}`}
            {result.intent.symbol && ` ${result.intent.symbol}`}
            {result.llm.reason && ` · ${result.llm.reason}`}
          </p>
        </div>
      )}
    </div>
  );
}
