import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { AlreadyWatchedError, NotWatchedError, UnknownSymbolError } from "../../../domain/watchlist/watchlist.types";
import * as watchlistService from "../../../application/watchlist/watchlist.service";
import { asyncHandler } from "../async-handler";

export const watchlistRouter = Router();
watchlistRouter.use(requireAuth);

watchlistRouter.get("/items", asyncHandler(async (req, res) => {
  const items = await watchlistService.listItems(req.auth!.userId);
  res.json(items);
}));

const addItemSchema = z.object({ symbol: z.string().min(1) });

watchlistRouter.post("/items", asyncHandler(async (req, res) => {
  const parsed = addItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY" });

  try {
    const item = await watchlistService.addItem(req.auth!.userId, parsed.data.symbol.toUpperCase());
    res.status(201).json(item);
  } catch (err) {
    if (err instanceof UnknownSymbolError) return res.status(404).json({ error: "UNKNOWN_SYMBOL" });
    if (err instanceof AlreadyWatchedError) return res.status(409).json({ error: "ALREADY_WATCHED" });
    throw err;
  }
}));

watchlistRouter.delete("/items/:symbol", asyncHandler(async (req, res) => {
  try {
    await watchlistService.removeItem(req.auth!.userId, req.params.symbol.toUpperCase());
    res.status(204).send();
  } catch (err) {
    if (err instanceof NotWatchedError) return res.status(404).json({ error: "NOT_WATCHED" });
    throw err;
  }
}));

// GET /api/watchlist — the diff-returning, read-only endpoint (see watchlist.service.ts)
watchlistRouter.get("/", asyncHandler(async (req, res) => {
  const diff = await watchlistService.getWatchlistDiff(req.auth!.userId);
  res.json(diff);
}));

const ackSchema = z.union([
  z.object({ symbols: z.array(z.string()) }),
  z.object({ ackAll: z.literal(true) }),
]);

watchlistRouter.post("/ack", asyncHandler(async (req, res) => {
  const parsed = ackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY" });

  const target = "ackAll" in parsed.data ? "ALL" : parsed.data.symbols.map((s) => s.toUpperCase());
  const result = await watchlistService.ackSymbols(req.auth!.userId, target);
  res.json(result);
}));
