import { forwardRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as assistantApi from "../api/assistant.api";
import type { AssistantResult } from "../types";
import { WATCHLIST_DIFF_KEY, WATCHLIST_ITEMS_KEY } from "../hooks/useWatchlist";
import { cn } from "../lib/cn";
import Button from "./ui/Button";

const STATUS_STYLES: Record<AssistantResult["status"], string> = {
  EXECUTED: "border-l-up bg-up/5 text-up",
  NEEDS_CONFIRMATION: "border-l-severity-notable bg-severity-notable/5 text-severity-notable",
  REJECTED: "border-l-severity-critical bg-severity-critical/5 text-severity-critical",
};

// Natural-language command bar.
//
// Two things it deliberately does NOT do. It doesn't hide how a command was understood —
// every result says whether the built-in patterns or Gemini read it, because a user who
// can't tell can't learn which phrasings are free and reliable. And it doesn't
// auto-execute a removal: the server returns NEEDS_CONFIRMATION for destructive intents
// and this renders the confirm step rather than deciding on the user's behalf.
const CommandBar = forwardRef<HTMLInputElement>(function CommandBar(_props, inputRef) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [history, setHistory] = useState<string[]>([]);
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
        setHistory((prev) => [variables.input, ...prev.filter((h) => h !== variables.input)].slice(0, 6));
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

  const suggestions = history.length > 0 ? history : (status.data?.examples ?? []);
  const suggestionLabel = history.length > 0 ? "Recent" : "Try";

  return (
    <div className="card p-3">
      <form onSubmit={submit} className="flex gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-accent">⌘</span>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask or command — add TCS · why is SUZLON flagged · dismiss all"
            maxLength={500}
            className="h-9 w-full rounded-lg border border-hairline-strong bg-surface-raised pl-9 pr-3 text-sm text-gray-100 placeholder:text-gray-600"
          />
        </div>
        <Button type="submit" variant="primary" loading={command.isPending} disabled={text.trim().length === 0}>
          {command.isPending ? "Running" : "Run"}
        </Button>
      </form>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-600">
        <span className="text-gray-500">{suggestionLabel}:</span>
        {suggestions.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setText(example)}
            className="rounded border border-hairline px-1.5 py-0.5 text-gray-500 hover:border-hairline-strong hover:text-gray-300"
          >
            {example}
          </button>
        ))}

        <span
          className="ml-auto flex items-center gap-1.5"
          title={
            status.data?.budget
              ? `Gemini handles phrasings the built-in patterns can't read. ${status.data.budget.dayUsed}/${status.data.budget.dayLimit} requests used today.`
              : "No Gemini key configured — commands are read by the built-in pattern parser, which covers the common phrasings."
          }
        >
          {status.data && (
            <>
              <span className={cn("h-1.5 w-1.5 rounded-full", status.data.available ? "bg-up" : "bg-gray-600")} />
              {status.data.available
                ? `AI fallback · ${status.data.model}`
                : status.data.budget
                  ? "AI paused · patterns still work"
                  : "Built-in patterns only"}
            </>
          )}
        </span>
      </div>

      {command.isError && (
        <p className="mt-2 rounded-lg border border-l-2 border-hairline border-l-severity-critical bg-severity-critical/5 px-3 py-2 text-sm text-severity-critical">
          Couldn't reach the assistant.
        </p>
      )}

      {result && (
        <div
          className={cn(
            "mt-2 rounded-lg border border-hairline border-l-2 px-3 py-2 text-sm",
            STATUS_STYLES[result.status],
          )}
        >
          <p className="text-gray-200">{result.message}</p>

          {pendingConfirmation && (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() => command.mutate({ input: pendingInput, confirm: true })}
                loading={command.isPending}
                className="border-severity-notable/40 bg-severity-notable/15 text-severity-notable hover:bg-severity-notable/25"
              >
                Yes, remove {pendingConfirmation.intent.symbol}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setResult(null)}>
                Cancel
              </Button>
            </div>
          )}

          <p className="mt-1.5 text-[11px] text-gray-500">
            Read by {result.interpretedBy === "GEMINI" ? "Gemini" : "built-in patterns (no AI call)"}
            {result.intent.action !== "UNKNOWN" && ` → ${result.intent.action}`}
            {result.intent.symbol && ` ${result.intent.symbol}`}
            {result.llm.reason && ` · ${result.llm.reason}`}
          </p>
        </div>
      )}
    </div>
  );
});

export default CommandBar;
