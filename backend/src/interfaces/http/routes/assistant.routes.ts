import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { llmStatus } from "../../../infrastructure/llm/gemini.client";
import { COMMAND_HINT_LIST, runCommand } from "../../../application/assistant/command.service";
import { explainEvent } from "../../../application/assistant/explain.service";
import { asyncHandler } from "../async-handler";

export const assistantRouter = Router();
assistantRouter.use(requireAuth);

// Reports what the assistant can actually do right now, so the UI can say "no key
// configured, running on built-in patterns" instead of silently looking dumber than it is.
assistantRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    // Examples ship with the status rather than living in the client: they are derived from
    // the symbol universe, and only the server knows what is in it today.
    res.json({ ...(await llmStatus()), examples: COMMAND_HINT_LIST });
  }),
);

const commandSchema = z.object({
  // Bounded because it goes into a prompt: an unbounded string is a way to spend the
  // whole daily budget in one request.
  text: z.string().min(1).max(500),
  // Set by the client only after the user answers a NEEDS_CONFIRMATION prompt. The server
  // decides which actions need it; this just carries the answer back.
  confirm: z.boolean().optional().default(false),
});

assistantRouter.post(
  "/command",
  asyncHandler(async (req, res) => {
    const parsed = commandSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY" });

    const result = await runCommand(req.auth!.userId, parsed.data.text, parsed.data.confirm);
    res.json(result);
  }),
);

const explainSchema = z.object({
  symbol: z.string().min(1),
  eventType: z.string().min(1),
  occurredAt: z.string().optional(),
});

assistantRouter.post(
  "/explain",
  asyncHandler(async (req, res) => {
    const parsed = explainSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY" });

    const result = await explainEvent(
      req.auth!.userId,
      parsed.data.symbol.toUpperCase(),
      parsed.data.eventType,
      parsed.data.occurredAt,
    );
    if (!result) return res.status(404).json({ error: "EVENT_NOT_FOUND" });

    res.json(result);
  }),
);
