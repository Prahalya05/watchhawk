import { describe, expect, it } from "vitest";
import { parseWithRules, resolveSymbol } from "./command.rules";

// These rules auto-execute. A parser that guesses is worse than one that gives up, so
// most of what's tested here is the refusals: the cases where the right answer is "say
// that another way" rather than a plausible-looking action on the wrong symbol.

describe("resolveSymbol", () => {
  it("matches an exact ticker regardless of case", () => {
    expect(resolveSymbol("tcs").symbol).toBe("TCS");
    expect(resolveSymbol("TCS").symbol).toBe("TCS");
  });

  it("matches a distinctive company-name word", () => {
    expect(resolveSymbol("reliance").symbol).toBe("RELIANCE");
    expect(resolveSymbol("suzlon").symbol).toBe("SUZLON");
  });

  it("refuses generic corporate words that happen to appear in one company name", () => {
    // "Titan Company" would otherwise make "company" resolve to TITAN with full
    // confidence, so "track the paint company" would silently add the wrong stock.
    expect(resolveSymbol("company").symbol).toBeNull();
    expect(resolveSymbol("limited").symbol).toBeNull();
    expect(resolveSymbol("services").symbol).toBeNull();
  });

  it("reports ambiguity instead of picking the first match", () => {
    const result = resolveSymbol("tata");
    expect(result.symbol).toBeNull();
    expect(result.ambiguous.length).toBeGreaterThan(1);
  });

  it("prefers a fully-typed ticker over its own prefix collisions", () => {
    // TATASTEEL shouldn't be called ambiguous merely because other TATA* names exist.
    expect(resolveSymbol("TATASTEEL").symbol).toBe("TATASTEEL");
  });

  it("returns nothing for a symbol outside the universe", () => {
    expect(resolveSymbol("TESLA").symbol).toBeNull();
    expect(resolveSymbol("").symbol).toBeNull();
  });

  it("matches a word prefix but not an arbitrary substring", () => {
    expect(resolveSymbol("paint").symbol).toBe("ASIANPAINT"); // "Asian Paints"
    expect(resolveSymbol("ndustries").symbol).toBeNull(); // mid-word, not a prefix
  });
});

describe("parseWithRules — verbs", () => {
  it("reads the common add phrasings", () => {
    for (const input of ["add TCS", "watch TCS", "track TCS", "follow TCS"]) {
      expect(parseWithRules(input)?.intent, input).toEqual({ action: "ADD_SYMBOL", symbol: "TCS" });
    }
  });

  it("reads the common remove phrasings", () => {
    for (const input of ["remove TCS", "drop TCS", "unwatch TCS", "delete TCS"]) {
      expect(parseWithRules(input)?.intent, input).toEqual({ action: "REMOVE_SYMBOL", symbol: "TCS" });
    }
  });

  it("prefers the longest matching verb phrase", () => {
    // "stop watching X" contains "watch"; the longer phrase has to win or a remove
    // silently becomes an add.
    expect(parseWithRules("stop watching TCS")?.intent).toEqual({ action: "REMOVE_SYMBOL", symbol: "TCS" });
  });

  it("treats ack-with-all as ACK_ALL rather than a symbol lookup", () => {
    for (const input of ["dismiss all", "clear everything", "ack all"]) {
      expect(parseWithRules(input)?.intent, input).toEqual({ action: "ACK_ALL" });
    }
  });

  it("reads a single-symbol ack", () => {
    expect(parseWithRules("dismiss TCS")?.intent).toEqual({ action: "ACK_SYMBOL", symbol: "TCS" });
  });

  it("maps why/explain to an explain intent", () => {
    expect(parseWithRules("why is SUZLON flagged")?.intent).toEqual({ action: "EXPLAIN_SYMBOL", symbol: "SUZLON" });
    expect(parseWithRules("explain SUZLON")?.intent).toEqual({ action: "EXPLAIN_SYMBOL", symbol: "SUZLON" });
  });

  it("reads the show phrasings without needing a symbol", () => {
    for (const input of ["what changed", "show my watchlist", "catch me up"]) {
      expect(parseWithRules(input)?.intent.action, input).toBe("SHOW_WATCHLIST");
    }
  });

  it("captures the search terms rather than resolving them", () => {
    expect(parseWithRules("search bank")?.intent).toEqual({ action: "SEARCH_SYMBOLS", query: "bank" });
  });
});

describe("parseWithRules — refusals", () => {
  it("returns null when there is no verb it recognises, so the caller can escalate", () => {
    // Null means "not confident", not "invalid": this is precisely the input worth
    // spending a Gemini request on.
    expect(parseWithRules("buy me some suzlon")).toBeNull();
    expect(parseWithRules("make me a sandwich")).toBeNull();
    expect(parseWithRules("")).toBeNull();
  });

  it("returns the verb with an ambiguity list rather than guessing the symbol", () => {
    const result = parseWithRules("add tata");
    expect(result?.intent.action).toBe("ADD_SYMBOL");
    expect(result?.intent.symbol).toBeUndefined();
    expect(result?.ambiguous?.length).toBeGreaterThan(1);
  });

  it("escalates when the verb is clear but the target isn't a known symbol", () => {
    expect(parseWithRules("add tesla")).toBeNull();
  });

  it("ignores filler words when finding the symbol", () => {
    expect(parseWithRules("please add TCS to my list")?.intent).toEqual({ action: "ADD_SYMBOL", symbol: "TCS" });
  });

  it("does not let a two-letter word match a name fragment", () => {
    // Short tokens are only ever accepted as exact tickers (LT, ITC), never as name
    // fragments, where they would match almost anything.
    expect(parseWithRules("add LT")?.intent).toEqual({ action: "ADD_SYMBOL", symbol: "LT" });
    expect(parseWithRules("add it")).toBeNull();
  });
});
