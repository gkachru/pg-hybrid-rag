/** Recommended embedding model for all languages: measured best for ar/th and a strong multilingual default. */
export const RECOMMENDED_EMBEDDER = "BAAI/bge-m3";
/** Embedding dimension of RECOMMENDED_EMBEDDER. Feed into ragMigrate({ embeddingDimensions }). */
export const RECOMMENDED_DIMENSIONS = 1024;
/**
 * Max input sequence length (tokens) of RECOMMENDED_EMBEDDER. This is a CEILING, not a target:
 * inputs longer than this are silently truncated (multilingual-e5 caps at 512, so it would lose
 * the tail of larger chunks; bge-m3 allows up to 8192). Keep your Chunker's tokenLimit well under
 * it — larger chunks dilute a single embedding vector and hurt retrieval precision; the optimal
 * value is corpus-dependent (commonly ~256–512), so validate rather than chunking to the ceiling.
 */
export const RECOMMENDED_MAX_TOKENS = 8192;
/** Starting-point vectorMinScore for RECOMMENDED_EMBEDDER's cosine calibration (validate per corpus). */
export const RECOMMENDED_VECTOR_MIN_SCORE = 0.4;

/** A Postgres FTS stemming group: one regconfig + the language codes it covers. */
export interface FtsStemmingGroup {
  config: string;
  languages: string[];
}

/**
 * Language → Postgres FTS regconfig groups. SINGLE SOURCE OF TRUTH mirroring the
 * rag_fts_config() CASE map in sql/014_arabic_fts.sql (tests/recommend.sync.test.ts asserts this).
 * Superset of BM25_LANGUAGE_GROUPS, which omits Arabic. Codes not covered here stem as the
 * Postgres 'simple' config, reported by recommendForLanguage as "none".
 */
export const FTS_STEMMING_GROUPS: FtsStemmingGroup[] = [
  { config: "english", languages: ["en", "en-US", "en-IN"] },
  { config: "spanish", languages: ["es", "es-ES", "es-MX"] },
  { config: "french", languages: ["fr", "fr-FR"] },
  { config: "german", languages: ["de", "de-DE"] },
  { config: "italian", languages: ["it", "it-IT"] },
  { config: "portuguese", languages: ["pt", "pt-PT"] },
  { config: "romanian", languages: ["ro", "ro-RO"] },
  { config: "arabic", languages: ["ar", "ar-SA", "ar-EG"] },
];

/** CJK languages routed to the pg_bigm keyword path. Matches detectLanguage's CJK outputs. */
export const CJK_LANGUAGES: string[] = ["zh", "ja", "ko"];

/** Languages for which normalizeForLanguage applies more than NFC (orthographic folds / digit folding). */
export const NORMALIZED_LANGUAGES: string[] = ["ar", "th"];

/** A recommended setup for working in a given language. Advisory — the consumer maps each field. */
export interface LanguageRecommendation {
  /** Canonical HuggingFace repo id of the recommended embedding model. */
  embedder: string;
  /** Embedding dimension of `embedder`. Feed into ragMigrate({ embeddingDimensions }). */
  dimensions: number;
  /**
   * Max input length (tokens) of `embedder` — a truncation CEILING, not a target chunk size.
   * Cap your Chunker's tokenLimit below this; chunking to the ceiling dilutes retrieval precision.
   */
  maxTokens: number;
  /** Suggested vectorMinScore for `embedder`'s cosine calibration (a starting point). */
  vectorMinScore: number;
  /** Postgres FTS regconfig for this language ('english', 'arabic', …), or 'none' (simple). */
  stemming: string;
  /** normalizeForLanguage applies more than NFC for this language (Arabic folding, Thai digits). */
  needsNormalization: boolean;
  /** CJK language → enable the pg_bigm keyword path (cjk: true on adapter + migration). */
  isCjk: boolean;
}

/** Base language code: region subtag stripped and lowercased ("ar-SA" → "ar"). Mirrors normalizeForLanguage. */
function baseCode(language: string): string {
  return (language ?? "").split("-")[0].toLowerCase();
}

/** Postgres FTS regconfig for `language`, or "none". Matches by exact code or base code. */
function stemmingForLanguage(language: string): string {
  const base = baseCode(language);
  for (const group of FTS_STEMMING_GROUPS) {
    if (group.languages.includes(language) || group.languages.includes(base)) {
      return group.config;
    }
  }
  return "none";
}

/**
 * Recommend a full setup for working in `language`. Pure/advisory — the consumer maps each field
 * to the right place (search options, ragMigrate options, provider construction). Accepts
 * BCP-47-style codes; the region subtag is ignored ("ar-SA" → "ar"). Unknown/empty codes return
 * the multilingual default with whitespace/simple structural assumptions. Never throws.
 */
export function recommendForLanguage(language: string): LanguageRecommendation {
  const base = baseCode(language);
  return {
    embedder: RECOMMENDED_EMBEDDER,
    dimensions: RECOMMENDED_DIMENSIONS,
    maxTokens: RECOMMENDED_MAX_TOKENS,
    vectorMinScore: RECOMMENDED_VECTOR_MIN_SCORE,
    stemming: stemmingForLanguage(language),
    needsNormalization: NORMALIZED_LANGUAGES.includes(base),
    isCjk: CJK_LANGUAGES.includes(base),
  };
}
