import { SYMBOL_MAP, SYMBOL_UNIVERSE } from "../market/symbol-universe";
import type { AssistantIntent } from "./assistant.types";

// Deterministic first pass over the command text.
//
// This exists ahead of Gemini rather than behind it. "add tcs" is not a language problem;
// spending a free-tier request on it would be slower, less reliable and less private than
// a switch statement, and would make the assistant stop working the moment the quota ran
// out. The model is reserved for input this pass genuinely cannot read.
//
// Returning null means "not confident", not "invalid" — the caller escalates to Gemini
// (if configured) and only then gives up.

const VERBS: Array<{ action: AssistantIntent["action"]; words: string[] }> = [
  { action: "ADD_SYMBOL", words: ["add", "watch", "track", "follow", "start watching"] },
  { action: "REMOVE_SYMBOL", words: ["remove", "delete", "drop", "unwatch", "untrack", "stop watching"] },
  { action: "ACK_SYMBOL", words: ["ack", "acknowledge", "dismiss", "clear", "mark as read", "mark read", "seen"] },
  { action: "EXPLAIN_SYMBOL", words: ["explain", "why", "how come", "reason for", "justify"] },
  { action: "SEARCH_SYMBOLS", words: ["search", "find", "look up", "lookup"] },
  {
    action: "SHOW_WATCHLIST",
    words: ["show", "list", "what changed", "whats changed", "what's new", "whats new", "catch me up", "refresh"],
  },
];

const ALL_WORDS = ["all", "everything", "every symbol", "them all"];

// Words that look like tickers but are just English. Without this, "clear all" resolves
// "ALL" against the universe and "show me LT" competes with the verb list.
const STOPWORDS = new Set([
  "ADD",
  "THE",
  "MY",
  "TO",
  "FROM",
  "AND",
  "FOR",
  "ME",
  "PLEASE",
  "ALL",
  "NEW",
  "SHOW",
  "LIST",
  "WHY",
  "HOW",
  "WHAT",
  "IS",
  "IT",
  "ON",
  "OF",
  "IN",
  "A",
  "AN",
  "WATCH",
  "TRACK",
  "REMOVE",
  "DROP",
  "CLEAR",
  "DISMISS",
  "EXPLAIN",
  "SEARCH",
  "FIND",
  "FLAGGED",
  "CHANGED",
  "ABOUT",
  "THAT",
  "THIS",
  "WITH",
  "WAS",
  "ARE",
  "DID",
  "DOES",
]);

// Generic words that appear inside real company names and would otherwise resolve to a
// single ticker with false confidence: "the paint company" would match "Titan Company"
// on the word "company" and silently add TITAN. These are excluded from name-fragment
// matching only — a real ticker is still matched exactly, so nothing legitimate is lost.
const GENERIC_NAME_WORDS = new Set([
  "COMPANY",
  "LIMITED",
  "LTD",
  "CORP",
  "CORPORATION",
  "INDUSTRIES",
  "SERVICES",
  "FINANCIAL",
  "FINANCE",
  "ENTERPRISES",
  "TECHNOLOGIES",
  "CONSULTANCY",
  "COMMUNICATIONS",
  "CATERING",
  "TOURISM",
  "NATIONAL",
  "INDIAN",
  "INDIA",
  "EXCHANGE",
  "GROUP",
  "HOLDINGS",
]);

// Name fragments have to look like the start of a word in the company name, not merely
// appear somewhere inside it. "paint" matching "Asian Paints" is a real signal; "ran"
// matching "UltraTech" is not.
function matchesNameFragment(name: string, token: string): boolean {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((word) => word.startsWith(token));
}

export interface SymbolResolution {
  symbol: string | null;
  ambiguous: string[];
}

// Resolution order is exact ticker, then exact company name, then a unique word-prefix
// match on the name. Anything matching more than one symbol is returned as ambiguous
// rather than silently picking the first — guessing between TATAMOTORS and TATASTEEL on
// a command that auto-executes is exactly the wrong place to be helpful.
export function resolveSymbol(raw: string): SymbolResolution {
  const text = raw.trim();
  if (!text) return { symbol: null, ambiguous: [] };

  const upper = text.toUpperCase();
  if (SYMBOL_MAP.has(upper)) return { symbol: upper, ambiguous: [] };

  const nameExact = SYMBOL_UNIVERSE.filter((s) => s.name.toUpperCase() === upper);
  if (nameExact.length === 1) return { symbol: nameExact[0].symbol, ambiguous: [] };

  if (GENERIC_NAME_WORDS.has(upper)) return { symbol: null, ambiguous: [] };

  const matches = SYMBOL_UNIVERSE.filter((s) => s.symbol.startsWith(upper) || matchesNameFragment(s.name, upper));
  if (matches.length === 1) return { symbol: matches[0].symbol, ambiguous: [] };
  if (matches.length > 1) {
    // A ticker typed in full always wins over its own prefix matches: "TATAMOTORS"
    // should not be called ambiguous just because "TATASTEEL" also starts with "TATA".
    const exact = matches.find((m) => m.symbol === upper);
    if (exact) return { symbol: exact.symbol, ambiguous: [] };
    return { symbol: null, ambiguous: matches.slice(0, 5).map((m) => m.symbol) };
  }

  return { symbol: null, ambiguous: [] };
}

// Scans the raw words for anything that resolves to a known symbol. Used after the verb
// is identified, so word order doesn't matter: "add tcs" and "put tcs on my list" both
// land on the same ticker.
function findSymbolIn(text: string): SymbolResolution {
  const tokens = text
    .split(/[^A-Za-z0-9&.-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t.toUpperCase()));

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (SYMBOL_MAP.has(upper)) return { symbol: upper, ambiguous: [] };
  }

  // No exact ticker — try the longest token as a name fragment, which is what catches
  // "add reliance" and "remove vodafone". Longest first because the distinctive word in
  // a phrase is usually the long one ("vodafone" over "idea").
  // The length floor matters: a two-character token is only ever accepted as an exact
  // ticker (LT, ITC) above, never as a name fragment, where it would match almost anything.
  const byLength = [...tokens].filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
  for (const token of byLength) {
    const resolved = resolveSymbol(token);
    if (resolved.symbol || resolved.ambiguous.length > 0) return resolved;
  }

  return { symbol: null, ambiguous: [] };
}

export interface RuleParseResult {
  intent: AssistantIntent;
  ambiguous?: string[];
}

export function parseWithRules(input: string): RuleParseResult | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const matchedVerb = VERBS.map((v) => {
    const word = v.words.find((w) => text === w || text.startsWith(`${w} `) || text.includes(` ${w} `));
    return word ? { action: v.action, word } : null;
  })
    // Longest matched phrase wins, so "stop watching X" is a remove rather than an add
    // via its trailing "watching".
    .filter((m): m is { action: AssistantIntent["action"]; word: string } => m !== null)
    .sort((a, b) => b.word.length - a.word.length)[0];

  if (!matchedVerb) return null;

  const targetsAll = ALL_WORDS.some((w) => text === w || text.endsWith(` ${w}`) || text.includes(` ${w} `));

  if (matchedVerb.action === "ACK_SYMBOL" && targetsAll) {
    return { intent: { action: "ACK_ALL" } };
  }

  if (matchedVerb.action === "SHOW_WATCHLIST") {
    return { intent: { action: "SHOW_WATCHLIST" } };
  }

  if (matchedVerb.action === "SEARCH_SYMBOLS") {
    const query = text.replace(new RegExp(`^.*?${matchedVerb.word}\\s*`), "").trim();
    if (!query) return null;
    return { intent: { action: "SEARCH_SYMBOLS", query } };
  }

  const resolution = findSymbolIn(input);
  if (resolution.symbol) {
    return { intent: { action: matchedVerb.action, symbol: resolution.symbol } };
  }
  if (resolution.ambiguous.length > 0) {
    return { intent: { action: matchedVerb.action }, ambiguous: resolution.ambiguous };
  }

  // Verb understood, target not. Escalating to the model here is worthwhile: this is the
  // "unwatch the paint company" case, which is a language problem rather than a typo.
  return null;
}
