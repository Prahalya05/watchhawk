import { apiClient } from "./client";
import type { WatchlistItemDto, WatchlistResponse } from "../types";

export async function fetchItems(): Promise<WatchlistItemDto[]> {
  const { data } = await apiClient.get<WatchlistItemDto[]>("/watchlist/items");
  return data;
}

export async function addItem(symbol: string): Promise<WatchlistItemDto> {
  const { data } = await apiClient.post<WatchlistItemDto>("/watchlist/items", { symbol });
  return data;
}

export async function removeItem(symbol: string): Promise<void> {
  await apiClient.delete(`/watchlist/items/${symbol}`);
}

export async function fetchDiff(): Promise<WatchlistResponse> {
  const { data } = await apiClient.get<WatchlistResponse>("/watchlist");
  return data;
}

export async function ackSymbols(symbols: string[]): Promise<{ acked: string[]; ackedAt: string }> {
  const { data } = await apiClient.post("/watchlist/ack", { symbols });
  return data;
}

export async function ackAll(): Promise<{ acked: string[]; ackedAt: string }> {
  const { data } = await apiClient.post("/watchlist/ack", { ackAll: true });
  return data;
}
