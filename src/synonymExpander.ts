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
 */
export function expandQueryWithSynonyms(query: string, lookup: SynonymLookup): string {
  const { merged, maxN: mergedMaxN } = mergeLookup(lookup);
  if (merged.size === 0) return query;

  const words = query.split(/\s+/).filter(Boolean);
  const lowers = words.map((w) => w.toLowerCase());
  const maxN = Math.min(mergedMaxN, words.length);
  const result: string[] = [];
  const seen = new Set<string>();

  let i = 0;
  while (i < words.length) {
    let matched = false;

    // Try longest n-gram first, then shorter
    for (let n = Math.min(maxN, words.length - i); n > 1; n--) {
      const key = buildNgramKey(lowers, i, n);
      const expansions = merged.get(key);
      if (expansions) {
        // Emit all original words in the matched span
        for (let j = i; j < i + n; j++) {
          if (!seen.has(lowers[j])) {
            result.push(words[j]);
            seen.add(lowers[j]);
          }
        }
        for (const exp of expansions) {
          if (!seen.has(exp)) {
            result.push(exp);
            seen.add(exp);
          }
        }
        i += n;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Single-word lookup
      const lower = lowers[i];
      if (!seen.has(lower)) {
        result.push(words[i]);
        seen.add(lower);
      }
      const expansions = merged.get(lower);
      if (expansions) {
        for (const exp of expansions) {
          if (!seen.has(exp)) {
            result.push(exp);
            seen.add(exp);
          }
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
        // The matched phrase as a tsquery phrase
        const phraseTerms = words
          .slice(i, i + n)
          .map(sanitizeTsqueryTerm)
          .filter(Boolean);
        const phrase = phraseTerms.join(" <-> ");
        const terms = [phrase, ...expansions.map(sanitizeTsqueryExpansion).filter(Boolean)];
        const unique = [...new Set(terms)];
        groups.push(unique.length > 1 ? `(${unique.join(" | ")})` : unique[0]);
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
