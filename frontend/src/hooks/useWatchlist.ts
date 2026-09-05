import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as watchlistApi from "../api/watchlist.api";

export const WATCHLIST_DIFF_KEY = ["watchlist", "diff"];
export const WATCHLIST_ITEMS_KEY = ["watchlist", "items"];

export function useWatchlistDiff() {
  return useQuery({
    queryKey: WATCHLIST_DIFF_KEY,
    queryFn: watchlistApi.fetchDiff,
    refetchInterval: 15_000, // WS covers live price movement; this catches new discrete events
  });
}

export function useWatchlistItems() {
  return useQuery({ queryKey: WATCHLIST_ITEMS_KEY, queryFn: watchlistApi.fetchItems });
}

export function useAddSymbol() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: watchlistApi.addItem,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WATCHLIST_ITEMS_KEY });
      queryClient.invalidateQueries({ queryKey: WATCHLIST_DIFF_KEY });
    },
  });
}

export function useRemoveSymbol() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: watchlistApi.removeItem,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WATCHLIST_ITEMS_KEY });
      queryClient.invalidateQueries({ queryKey: WATCHLIST_DIFF_KEY });
    },
  });
}
