import { Router } from "express";
import { z } from "zod";
import { requireAdminKey } from "../middleware/admin.middleware";
import { enqueueCommand, type AdminCommandType } from "../../../infrastructure/market-data/command-queue";
import { writeDiscreteEvent } from "../../../application/ingestion/market-state-writer";
import { readMarketStates } from "../../../infrastructure/market-data/read-state";
import { getRefcount } from "../../../application/ingestion/subscription-manager";
import { SYMBOL_UNIVERSE } from "../../../domain/market/symbol-universe";
import { runStatsJob } from "../../../application/stats/stats-job";
import { asyncHandler } from "../async-handler";

export const adminRouter = Router();
adminRouter.use(requireAdminKey);

const triggerSchema = z.object({
  symbol: z.string().min(1),
  eventType: z.enum([
    "VOLUME_SPIKE",
    "GAP_OPEN",
    "FIFTY_TWO_WEEK_EXTREME",
    "NEWS",
    "RATING_CHANGE",
    "CORPORATE_ACTION",
    "DIVERGE",
    "FREEZE",
    "UNFREEZE",
  ]),
  severity: z.enum(["MINOR", "NOTABLE", "CRITICAL"]).optional(),
  payload: z.record(z.unknown()).optional(),
});

// Demo-only endpoint: real market movement can't be scripted for a live presentation,
// so this is what guarantees on-demand control over every event type during a demo
// (works fully in replay mode; VOLUME_SPIKE/GAP_OPEN/FIFTY_TWO_WEEK_EXTREME/DIVERGE
// are queued overrides applied by market-state-writer.ts on the next poll cycle
// regardless of which provider is currently authoritative).
adminRouter.post("/trigger", asyncHandler(async (req, res) => {
  const parsed = triggerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });

  const { symbol, eventType, severity, payload } = parsed.data;
  const upperSymbol = symbol.toUpperCase();

  if (eventType === "NEWS" || eventType === "RATING_CHANGE" || eventType === "CORPORATE_ACTION") {
    await writeDiscreteEvent(upperSymbol, eventType, severity ?? "NOTABLE", payload ?? {});
  } else {
    enqueueCommand({ symbol: upperSymbol, type: eventType as AdminCommandType, severity, payload });
  }

  res.json({ accepted: true });
}));

adminRouter.get("/symbols", asyncHandler(async (_req, res) => {
  const symbols = SYMBOL_UNIVERSE.map((s) => s.symbol);
  const states = await readMarketStates(symbols);
  const refcounts = await Promise.all(symbols.map((s) => getRefcount(s)));

  res.json(
    SYMBOL_UNIVERSE.map((def, i) => ({
      symbol: def.symbol,
      name: def.name,
      tier: def.volatilityTier,
      state: states.get(def.symbol) ?? null,
      refcount: refcounts[i],
    }))
  );
}));

adminRouter.post("/recompute-stats", asyncHandler(async (_req, res) => {
  // Reports what the job actually recomputed. It used to echo the whole universe, which
  // was already only coincidentally true and is plainly wrong now that the job is scoped
  // to watched symbols — a demo panel that overstates what ran is worse than no panel.
  const recomputed = await runStatsJob();
  res.json({ recomputed });
}));
