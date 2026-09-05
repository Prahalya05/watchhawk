import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // min(1) let a one-character secret through, which forges as easily as no secret at
  // all. 32 chars is the shortest length worth calling a secret for HS256, and failing
  // at boot is the only place this can be caught before it matters.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ADMIN_KEY: z.string().min(16, "ADMIN_KEY must be at least 16 characters"),
  MARKET_DATA_MODE: z.enum(["live", "replay"]).default("live"),
  TWELVE_DATA_API_KEY: z.string().optional().default(""),
  MARKET_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(45000),
  STALE_THRESHOLD_MS: z.coerce.number().int().positive().default(120000),
  PORT: z.coerce.number().int().positive().default(4000),

  // Gemini. Entirely optional: with no key the assistant falls back to its deterministic
  // command parser and its deterministic explanation text, exactly as the market-data
  // layer falls back to replay. Nothing in the product requires an LLM to function.
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  // Google does not publish free-tier quotas any more (the docs point you at AI Studio),
  // so these are conservative self-imposed ceilings rather than a claim about the real
  // limit — set them to whatever AI Studio shows for your key.
  GEMINI_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(8),
  GEMINI_MAX_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(200),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// If no Twelve Data key is configured, there is nothing "live" to fall back FROM,
// so force replay mode rather than starting a composite provider that can never succeed.
export const effectiveMarketDataMode: "live" | "replay" =
  env.MARKET_DATA_MODE === "live" && env.TWELVE_DATA_API_KEY.length === 0
    ? "replay"
    : env.MARKET_DATA_MODE;

// Same shape of decision as effectiveMarketDataMode above: a missing key is a supported
// configuration, not an error, so it is resolved once here rather than re-checked at
// every call site.
export const llmEnabled: boolean = env.GEMINI_API_KEY.length > 0;
