/** A BM25 partial-index language group: one Postgres text_config + the language codes it covers. */
export interface Bm25LanguageGroup {
  config: string;
  languages: string[];
}

/**
 * Language groups for the per-language partial BM25 indexes.
 *
 * SINGLE SOURCE OF TRUTH: the language-code literals here MUST stay in sync with
 * sql/011_pg_textsearch.sql (a test asserts this). Partial-index predicate matching
 * requires literal arrays, so the migration cannot call a function. Mirrors
 * rag_fts_config() (sql/008) but as literal arrays.
 */
export const BM25_LANGUAGE_GROUPS: Bm25LanguageGroup[] = [
  { config: "english", languages: ["en", "en-US", "en-IN"] },
  { config: "spanish", languages: ["es", "es-ES", "es-MX"] },
  { config: "french", languages: ["fr", "fr-FR"] },
  { config: "german", languages: ["de", "de-DE"] },
  { config: "italian", languages: ["it", "it-IT"] },
  { config: "portuguese", languages: ["pt", "pt-PT"] },
  { config: "romanian", languages: ["ro", "ro-RO"] },
];

/** Every language code with a dedicated (non-simple) BM25 partial index. */
export function bm25SupportedLanguages(): string[] {
  return BM25_LANGUAGE_GROUPS.flatMap((g) => g.languages);
}

/**
 * Name of the partial BM25 index matching `language`.
 * Must stay in sync with the index names in sql/011_pg_textsearch.sql.
 * Used by Bm25Fts to pass explicitly to to_bm25query() (required by pg_textsearch >=1.0).
 */
export function bm25IndexName(language: string): string {
  const group = BM25_LANGUAGE_GROUPS.find((g) => g.languages.includes(language));
  if (group) return `idx_rag_bm25_${group.languages[0]}`;
  return "idx_rag_bm25_simple";
}

/**
 * SQL predicate that selects the partial BM25 index matching `language`.
 * Returns `language IN (...)` for a supported group, or `language NOT IN (...all supported...)`
 * for the 'simple' catch-all index. Values come from BM25_LANGUAGE_GROUPS (trusted constant,
 * never user input) so inlining as SQL literals is safe.
 */
export function bm25LanguagePredicate(language: string): string {
  const quote = (s: string) => `'${s}'`;
  const group = BM25_LANGUAGE_GROUPS.find((g) => g.languages.includes(language));
  if (group) {
    return `language IN (${group.languages.map(quote).join(", ")})`;
  }
  return `language NOT IN (${bm25SupportedLanguages().map(quote).join(", ")})`;
}
