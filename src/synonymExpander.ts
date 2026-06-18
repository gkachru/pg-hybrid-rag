import type { SynonymLookup } from "./types.js";

/**
 * Merge all language maps into a single lookup (language-agnostic at query time).
 * Returns the merged map and the max word count among all keys.
 */
function mergeLookup(lookup: SynonymLookup): { merged: Map<string, string[]>; maxN: number } {
  const merged = new Map<string, string[]>();
  let maxN = 1;

  const addEntry = (key: string, expansions: string[]) => {
    const existing = merged.get(key) ?? [];
    for (const exp of expansions) {
      if (!existing.includes(exp) && existing.length < 5) {
        existing.push(exp);
      }
    }
    merged.set(key, existing);

    const wc = key.split(/\s+/).length;
    if (wc > maxN) maxN = wc;
  };

  for (const langMap of lookup.values()) {
    for (const [term, expansions] of langMap) {
      addEntry(term, expansions);
    }
  }
  return { merged, maxN };
}

/**
 * Build a lookup key from consecutive words.
 */
function buildNgramKey(words: string[], start: number, len: number): string {
  const parts: string[] = [];
  for (let j = start; j < start + len; j++) {
    parts.push(words[j]);
  }
  return parts.join(" ");
}

/**
 * Expand a query by appending synonym terms for each word/phrase found in the lookup.
 * Supports multi-word synonym keys via longest-match-first sliding window.
 * Expansions are deduped and capped at 5 per key.
 * Returns the expanded query string for the keyword/FTS legs.
 *
 * Original query words are always emitted, preserving multiplicity — a word the
 * user repeats survives so the term-frequency-ranked BM25 leg (which is built on
 * this function via `buildBm25Query`) weights it accordingly. Only synonym
 * EXPANSIONS are de-duped: an expansion is skipped if it restates a word the
 * query already contains or one already appended, so we never inflate a synonym.
 */
export function expandQueryWithSynonyms(query: string, lookup: SynonymLookup): string {
  const { merged, maxN: mergedMaxN } = mergeLookup(lookup);
  if (merged.size === 0) return query;

  const words = query.split(/\s+/).filter(Boolean);
  const lowers = words.map((w) => w.toLowerCase());
  const maxN = Math.min(mergedMaxN, words.length);
  const result: string[] = [];
  const queryWords = new Set(lowers);
  const emittedExpansions = new Set<string>();

  const pushExpansion = (exp: string) => {
    // De-dup a (possibly multi-word) expansion per COMPONENT word, not as a whole
    // phrase: a synonym that restates a word the query already contains — or one an
    // earlier expansion already appended — must not re-add that word, or buildBm25Query
    // (which re-splits this string) would count it twice and bias the term-frequency
    // -ranked BM25 leg. Original query words are emitted by the spans below and are
    // never routed through here, so the user's own multiplicity is preserved.
    const kept: string[] = [];
    for (const w of exp.split(/\s+/).filter(Boolean)) {
      const lw = w.toLowerCase();
      if (queryWords.has(lw) || emittedExpansions.has(lw)) continue;
      emittedExpansions.add(lw);
      kept.push(w);
    }
    if (kept.length > 0) result.push(kept.join(" "));
  };

  let i = 0;
  while (i < words.length) {
    let matched = false;

    // Try longest n-gram first, then shorter
    for (let n = Math.min(maxN, words.length - i); n > 1; n--) {
      const key = buildNgramKey(lowers, i, n);
      const expansions = merged.get(key);
      if (expansions) {
        // Emit all original words in the matched span (multiplicity preserved)
        for (let j = i; j < i + n; j++) {
          result.push(words[j]);
        }
        for (const exp of expansions) {
          pushExpansion(exp);
        }
        i += n;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Single-word lookup
      result.push(words[i]);
      const expansions = merged.get(lowers[i]);
      if (expansions) {
        for (const exp of expansions) {
          pushExpansion(exp);
        }
      }
      i++;
    }
  }

  return result.join(" ");
}

/**
 * Build a tsquery-compatible string with OR groups for synonym expansions.
 * Supports multi-word synonym keys via longest-match-first sliding window.
 * Input: "best phones market", synonyms: phones -> [smartphones, iphone]
 * Output: "best & (phones | smartphones | iphone) & market"
 *
 * Terms are sanitized to prevent tsquery injection.
 * Postgres handles stemming via the language-specific FTS config at query time.
 */
export function buildFtsQuery(query: string, lookup: SynonymLookup): string {
  const { merged, maxN: mergedMaxN } = mergeLookup(lookup);
  const words = query.split(/\s+/).filter(Boolean);
  const lowers = words.map((w) => w.toLowerCase());
  const maxN = Math.min(mergedMaxN, words.length);
  const groups: string[] = [];

  let i = 0;
  while (i < words.length) {
    let matched = false;

    // Try longest n-gram first
    for (let n = Math.min(maxN, words.length - i); n > 1; n--) {
      const key = buildNgramKey(lowers, i, n);
      const expansions = merged.get(key);
      if (expansions && expansions.length > 0) {
        // The matched phrase as a tsquery phrase. If every word in the span
        // sanitizes away (e.g. a synonym key of tsquery-special chars), drop
        // the phrase so we never emit an invalid group like "( | cod)".
        const phraseTerms = words
          .slice(i, i + n)
          .map(sanitizeTsqueryTerm)
          .filter(Boolean);
        const phrase = phraseTerms.length > 0 ? phraseTerms.join(" <-> ") : "";
        const terms = [phrase, ...expansions.map(sanitizeTsqueryExpansion)].filter(Boolean);
        const unique = [...new Set(terms)];
        // Skip the group entirely if nothing survived sanitization.
        if (unique.length > 0) {
          groups.push(unique.length > 1 ? `(${unique.join(" | ")})` : unique[0]);
        }
        i += n;
        matched = true;
        break;
      }
    }

    if (!matched) {
      const sanitized = sanitizeTsqueryTerm(words[i]);
      if (!sanitized) {
        i++;
        continue;
      }

      const expansions = merged.get(lowers[i]);

      if (expansions && expansions.length > 0) {
        const terms = [sanitized, ...expansions.map(sanitizeTsqueryExpansion).filter(Boolean)];
        const unique = [...new Set(terms)];
        groups.push(unique.length > 1 ? `(${unique.join(" | ")})` : unique[0]);
      } else {
        groups.push(sanitized);
      }
      i++;
    }
  }

  return groups.join(" & ");
}

/**
 * Build a flat, space-separated term list for the BM25 (pg_textsearch) FTS leg.
 * Synonym-expands the query (longest-match-first), then strips characters special
 * to the query parser. BM25 is OR-ranked by definition, so a space-separated list
 * is functionally equivalent to a tsquery OR group — and ranks by term frequency.
 *
 * Input:  "best phones market", synonyms: phones -> [smartphones]
 * Output: "best phones smartphones market"
 */
export function buildBm25Query(query: string, lookup: SynonymLookup): string {
  const expanded = expandQueryWithSynonyms(query, lookup);
  return expanded.split(/\s+/).map(sanitizeTsqueryTerm).filter(Boolean).join(" ");
}

/** Strip characters that have special meaning in tsquery to prevent injection. */
function sanitizeTsqueryTerm(term: string): string {
  return term.replace(/[&|!():<>*\\'"]/g, "").trim();
}

/**
 * Sanitize a synonym expansion for use inside a tsquery OR group.
 * Multi-word synonyms like "apple watch" become "apple <-> watch" (phrase match).
 */
function sanitizeTsqueryExpansion(term: string): string {
  const words = term.split(/\s+/).map(sanitizeTsqueryTerm).filter(Boolean);
  if (words.length === 0) return "";
  return words.join(" <-> ");
}
