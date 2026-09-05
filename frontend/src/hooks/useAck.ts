import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as watchlistApi from "../api/watchlist.api";
import { WATCHLIST_DIFF_KEY } from "./useWatchlist";

// Acking, not refreshing, is what clears a symbol's diff — see backend
// watchlist.service.ts. The dashboard calls this on explicit dismiss, not on every
// GET /watchlist poll, so a glance-and-refresh never silently loses the diff.
export function useAckSymbol() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (symbol: string) => watchlistApi.ackSymbols([symbol]),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WATCHLIST_DIFF_KEY }),
  });
}

export function useAckAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: watchlistApi.ackAll,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WATCHLIST_DIFF_KEY }),
  });
}
