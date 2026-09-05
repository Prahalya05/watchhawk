export interface WatchlistItemDto {
  symbol: string;
  addedAt: string;
}

export class UnknownSymbolError extends Error {}
export class AlreadyWatchedError extends Error {}
export class NotWatchedError extends Error {}
