// Imported first by any test that pulls in config/env, which validates the environment
// at import time and calls process.exit(1) when a required variable is missing. Tests
// normally inherit backend/.env via dotenv, but they must not silently depend on a file
// that isn't in version control — these fallbacks keep the suite runnable in a fresh
// checkout or CI, and defer to whatever is already set everywhere else.
process.env.DATABASE_URL ??= "postgresql://watchlist:watchlist@localhost:5432/watchlist";
process.env.REDIS_URL ??= "redis://localhost:6379";
// Long enough to clear the minimum lengths config/env.ts now enforces — a short secret
// is a boot failure there, and a test suite that quietly used one would be testing a
// configuration the app refuses to run in.
process.env.JWT_SECRET ??= "test-jwt-secret-at-least-32-characters-long";
process.env.ADMIN_KEY ??= "test-admin-key-16+";
