import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { searchSymbols } from "../../market-data/symbol-universe";

export const symbolsRouter = Router();
symbolsRouter.use(requireAuth);

symbolsRouter.get("/search", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const results = searchSymbols(q).map((s) => ({
    symbol: s.symbol,
    name: s.name,
    sector: s.sector,
    volatilityTier: s.volatilityTier,
  }));
  res.json(results);
});
