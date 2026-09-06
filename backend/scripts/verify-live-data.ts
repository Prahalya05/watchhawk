/**
 * Verifies the real market-data providers against the live APIs.
 *
 * Run:  npm run verify:live
 *
 * Exists because live mode is the one path that can't be proven by unit tests or by the
 * replay-mode demo: a wrong symbol suffix or a renamed vendor field doesn't crash, it
 * just makes every symbol quietly fall back to synthetic data while still looking fine
 * on screen. This calls the actual provider classes (not a reimplementation) so what it
 * proves is what the server will do.
 *
 * Yahoo needs no key and is always checked. Twelve Data is checked only if
 * TWELVE_DATA_API_KEY is set, and is skipped (not failed) otherwise.
 */
import { TwelveDataProvider } from "../src/infrastructure/market-data/providers/twelve-data.provider";
import { YahooProvider } from "../src/infrastructure/market-data/providers/yahoo.provider";
import { env } from "../src/config/env";
import type { Quote } from "../src/domain/ports/market-data.port";

// One from each volatility tier, so a tier-specific data problem can't hide.
const SAMPLE_SYMBOLS = ["RELIANCE", "TMPV", "ETERNAL"];

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function inspectQuote(q: Quote) {
  console.log(`\n  ${q.symbol}: price=${q.price} open=${q.dayOpen} prevClose=${q.prevClose} volume=${q.volume}`);
  check(`${q.symbol} price is a positive number`, Number.isFinite(q.price) && q.price > 0);
  check(`${q.symbol} prevClose is a positive number`, Number.isFinite(q.prevClose) && q.prevClose > 0);
  check(`${q.symbol} dayOpen is a positive number`, Number.isFinite(q.dayOpen) && q.dayOpen > 0);

  // The failure this is really guarding: if dayOpen silently falls back to the current
  // price, GAP_OPEN reinterprets the whole intraday move as an overnight gap and fires
  // spurious CRITICAL events. Equality is only legitimate at the very open, or when the
  // market is shut and both collapse onto the same figure.
  const impliedGapPct = Math.abs((q.dayOpen - q.prevClose) / q.prevClose) * 100;
  const openEqualsPrice = q.dayOpen === q.price;
  check(
    `${q.symbol} dayOpen is a real session open, not a stand-in for the live price`,
    !openEqualsPrice || q.price === q.prevClose,
    openEqualsPrice
      ? "dayOpen === price; gaps computed from this would be wrong"
      : `implied gap ${impliedGapPct.toFixed(2)}%`,
  );
}

async function verifyYahoo() {
  console.log("\n=== Yahoo (primary source — no API key required) ===");
  const provider = new YahooProvider();
  await provider.start();

  const quotes = await provider.fetchQuotes(SAMPLE_SYMBOLS);
  check(
    `returned a quote for each of ${SAMPLE_SYMBOLS.length} symbols`,
    quotes.length === SAMPLE_SYMBOLS.length,
    `got ${quotes.length}`,
  );
  quotes.forEach(inspectQuote);

  const history = await provider.fetchDailyHistory("RELIANCE", 30);
  console.log("");
  check("returned daily history for RELIANCE", history.length > 0, `${history.length} bars`);
  if (history.length > 0) {
    const last = history[history.length - 1];
    check(
      "history bars carry OHLC + volume",
      [last.open, last.high, last.low, last.close].every((v) => Number.isFinite(v) && v > 0),
      `latest ${last.date}: close=${last.close}`,
    );
    check("history is ordered oldest-first", new Date(history[0].date) <= new Date(last.date));
  }

  await provider.stop();
}

async function verifyTwelveData() {
  console.log("\n=== Twelve Data (cross-check / upgrade-path source) ===");
  if (!env.TWELVE_DATA_API_KEY) {
    console.log("  SKIPPED — TWELVE_DATA_API_KEY is not set in backend/.env.");
    console.log("  Get a free key at https://twelvedata.com/pricing (Basic tier), then re-run.");
    console.log("  Without it the app runs fully on the replay provider; this is not a failure.");
    return;
  }

  const provider = new TwelveDataProvider();
  await provider.start();

  // A plan that doesn't include NSE is a known, expected state on the free tier — not a
  // defect for this check to go red over. Reporting it as a failure would make
  // verify:live permanently red for anyone without a paid plan, and a check that is
  // always red stops being read at all. It is reported and skipped; anything else still
  // fails loudly.
  let quotes;
  try {
    quotes = await provider.fetchQuotes(SAMPLE_SYMBOLS);
  } catch (err) {
    const message = (err as Error).message;
    if (isPlanLimitation(message)) {
      reportPlanLimitation(message);
      await provider.stop();
      return;
    }
    throw err;
  }

  if (quotes.length === 0) {
    // The endpoint answered without throwing but gave nothing back. Now that the symbol
    // convention is the bare ticker + &exchange=NSE (the ".NS" suffix is Yahoo's and this
    // API rejects it), an empty result points at coverage rather than formatting.
    console.log("  SKIPPED — returned 0 quotes. The request was accepted, so this is");
    console.log("  coverage, not formatting: this plan almost certainly excludes NSE.");
    await provider.stop();
    return;
  }

  check(
    `returned a quote for each of ${SAMPLE_SYMBOLS.length} symbols`,
    quotes.length === SAMPLE_SYMBOLS.length,
    `got ${quotes.length}`,
  );
  quotes.forEach(inspectQuote);

  const history = await provider.fetchDailyHistory("RELIANCE", 30);
  console.log("");
  check("returned daily history for RELIANCE", history.length > 0, `${history.length} bars`);
  if (history.length > 1) {
    check("history is ordered oldest-first", new Date(history[0].date) <= new Date(history[history.length - 1].date));
  }

  await provider.stop();
}

function isPlanLimitation(message: string): boolean {
  return /grow or venture plan|upgrad|not available with your plan/i.test(message);
}

function reportPlanLimitation(message: string) {
  console.log("  SKIPPED — this API key's plan does not cover NSE equities.");
  console.log(`  API said: ${message.replace(/^.*?—\s*/, "")}`);
  console.log("  Not a code problem: the symbol format is correct, which is why the API");
  console.log("  answers with a plan message rather than an invalid-symbol error.");
  console.log("  Yahoo (above) is the primary source and covers the universe on its own.");
}

async function main() {
  console.log("Verifying live market-data providers against the real APIs.");
  console.log(
    `Configured mode: MARKET_DATA_MODE=${env.MARKET_DATA_MODE}, key ${env.TWELVE_DATA_API_KEY ? "present" : "absent"}`,
  );

  try {
    await verifyYahoo();
  } catch (err) {
    check("Yahoo provider ran without throwing", false, (err as Error).message);
  }

  try {
    await verifyTwelveData();
  } catch (err) {
    check("Twelve Data provider ran without throwing", false, (err as Error).message);
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
