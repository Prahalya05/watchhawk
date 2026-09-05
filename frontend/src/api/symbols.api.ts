import { apiClient } from "./client";
import type { SymbolSearchResult } from "../types";

export async function searchSymbols(query: string): Promise<SymbolSearchResult[]> {
  const { data } = await apiClient.get<SymbolSearchResult[]>("/symbols/search", { params: { q: query } });
  return data;
}
