# Language-keyed setup recommender — design

**Date:** 2026-06-25
**Status:** approved (design), pending implementation plan

## Motivation

Configuring pg-hybrid-rag for a given language currently requires the consumer to know
a scattered set of facts that live in the code, the SQL migrations, and two benchmark
logs:

- which embedding model to use and at what dimension (and therefore what to pass to
  `ragMigrate({ embeddingDimensions })`),
- a sensible `vectorMinScore` for that embedder's cosine calibration (the `0.8` default is
  e5-calibrated and silently zeroes the dense leg for bge-m3 — see `src/types.ts`),
- whether the language has a native Postgres FTS stemmer or falls back to `simple`,
- whether it needs a word segmenter (no whitespace word boundaries),
- whether it needs orthographic normalization,
- whether it is CJK (pg_bigm keyword path).

This spec adds a single pure function that returns those facts for a language code, so a
consumer gets one place to read "how do I wire this library up for Thai / Arabic / German"
instead of re-deriving it. It encodes the calibration knowledge we earned from benchmarks
(Arabic, Thai) plus the structural facts the codebase already knows deterministically.

## Goals / non-goals

**Goals**
- One exported pure function, `recommendForLanguage(language)`, returning a structured
  `LanguageRecommendation`.
- Encode the **structural** facts deterministically from existing sources of truth
  (`rag_fts_config`, the CJK set, `normalizeForLanguage`) so they cannot drift.
- Encode the **measured** embedder + threshold recommendation (bge-m3 / 1024 / 0.4) we
  validated for Arabic and Thai, applied as the multilingual default for all languages.
- Always return a usable object for any language code (no throw), so it is safe to call
  on user-supplied codes.

**Non-goals**
- Auto-applying the recommendation. The function is advisory; the consumer maps each field
  to the right place (search options, migration options, embedder/provider construction).
  This matches the library's "no env vars, explicit config" ethos.
- Recommending a *different embedder per language*. Our evidence (two languages, two
  scripts, both → bge-m3) does not support per-language model differentiation; the embedder
  fields are a constant multilingual pick. Only the structural fields vary by language.
- Per-corpus threshold tuning. `vectorMinScore` and the rest remain starting points to
  validate per corpus, exactly as the README already insists.
- Any schema change to support mixed embedding dimensions in one table (see Constraints).

## Architecture decision: pure function (not an injected interface)

The codebase has two extensibility taxonomies (see the linear-fusion spec):
- **I/O providers → construction-injected interfaces:** `SqlClient`, `EmbeddingProvider`,
  `RerankerProvider`, `FtsStrategy`, `ChunkingProvider`, `Normalizer`, `Segmenter`.
- **Pure transforms / lookups → exported functions:** `detectLanguage`, `applyRRF`,
  `normalizeForLanguage`, `removeStopWords`, `stripTrailingPunctuation`.

The recommender is a pure, I/O-free lookup over a language code, so it belongs with the
second group — a new module `src/recommend.ts`, exported from the barrel under "Utilities",
alongside `detectLanguage`. No state, no injection.

## API

```ts
export interface LanguageRecommendation {
  /** Canonical HuggingFace repo id of the recommended embedding model. */
  embedder: string;
  /** Embedding dimension of `embedder`. Feed into ragMigrate({ embeddingDimensions }). */
  dimensions: number;
  /** Suggested vectorMinScore for `embedder`'s cosine calibration (a starting point). */
  vectorMinScore: number;
  /** Postgres FTS regconfig for this language ('english', 'arabic', …), or 'none' (simple). */
  stemming: string;
  /** Script lacks whitespace word boundaries → keyword/FTS leg benefits from a Segmenter. */
  needsSegmenter: boolean;
  /** normalizeForLanguage applies more than NFC for this language (Arabic folding, Thai digits). */
  needsNormalization: boolean;
  /** CJK language → enable the pg_bigm keyword path (cjk: true on adapter + migration). */
  isCjk: boolean;
}

/**
 * Recommend a full setup for working in `language`. Pure/advisory — the consumer maps each
 * field to the right place. Accepts BCP-47-style codes; the region subtag is ignored
 * ("ar-SA" → "ar"). Unknown codes return the multilingual default with whitespace/simple
 * structural assumptions.
 */
export function recommendForLanguage(language: string): LanguageRecommendation;
```

Input normalization mirrors `normalizeForLanguage`: `language.split("-")[0].toLowerCase()`,
so `"ar-SA"`, `"en-US"`, `"de-DE"` resolve to their base code.

## Data

Each field has a **source of truth** so values are derived, not invented:

| Field | Source of truth | Provenance |
|-------|-----------------|------------|
| `embedder` / `dimensions` / `vectorMinScore` | constant `BAAI/bge-m3` / `1024` / `0.4` | **measured** for `ar`, `th`; **extrapolated** (multilingual default) for all others |
| `stemming` | `rag_fts_config` map (`sql/014_arabic_fts.sql`) | structural |
| `isCjk` | the set `{zh, ja, ko}` (matches `detectLanguage` + adapter `cjk` option) | structural |
| `needsSegmenter` | scripts without whitespace word boundaries: `{th, zh, ja, ko}` | structural |
| `needsNormalization` | `normalizeForLanguage` applies more than NFC: `{ar, th}` | structural |

Representative resolved values:

| lang | embedder | dims | vMinScore | stemming | needsSegmenter | needsNormalization | isCjk |
|------|----------|------|-----------|----------|----------------|--------------------|-------|
| `en` | BAAI/bge-m3 | 1024 | 0.4 | english | false | false | false |
| `de` | BAAI/bge-m3 | 1024 | 0.4 | german | false | false | false |
| `ar` | BAAI/bge-m3 | 1024 | 0.4 | arabic | false | true | false |
| `th` | BAAI/bge-m3 | 1024 | 0.4 | none | true | true | false |
| `zh` | BAAI/bge-m3 | 1024 | 0.4 | none | true | false | true |
| `ja` | BAAI/bge-m3 | 1024 | 0.4 | none | true | false | true |
| `xx` (unknown) | BAAI/bge-m3 | 1024 | 0.4 | none | false | false | false |

For CJK languages both `isCjk` and `needsSegmenter` are true: the pg_bigm bigram path
(`cjk: true`) is the supported keyword route and needs no segmenter, while a `Segmenter`
is an alternative that also helps the FTS leg — the recommendation surfaces both options
rather than choosing for the consumer.

## End-to-end usage

```ts
const rec = recommendForLanguage("th");
// install-time: size the column + pass the CJK flag through (false for Thai)
await ragMigrate(db, { embeddingDimensions: rec.dimensions, cjk: rec.isCjk });

// construction-time: pick providers from the structural flags
const normalizer = rec.needsNormalization ? new LanguageNormalizer() : undefined;
const segmenter  = rec.needsSegmenter ? myThaiSegmenter : undefined;
const pipeline = new RagPipeline({ tenantId, db, embedder, normalizer, segmenter });

// query-time: use the calibrated floor
await pipeline.search(q, { language: "th", vectorMinScore: rec.vectorMinScore });
```

## Constraints

**Embedding dimension is per-database, not per-tenant.** `rag_documents.embedding` is
`vector(__EMBEDDING_DIM__)` — one fixed dimension for the whole table, substituted once at
migration (`embeddingDimensions`, default 384). All tenants in one database share it. A
consumer can use a *different embedder* per tenant only if it has the *same dimension*;
genuinely different dimensions (e.g. multilingual-e5-small 384 vs bge-m3 1024) require
separate databases/schemas, each migrated with its own `embeddingDimensions` and pointed at
its own `SqlClient`. So `rec.dimensions` is a per-database decision. Because the
recommendation is bge-m3/1024 for every language, a single 1024-dim database hosts all
languages cleanly; the only reason to split databases is a deliberate smaller/cheaper model
for some tenant.

## Testing

- Unit: `recommendForLanguage` resolves the representative table above (including region
  subtags `ar-SA`→`ar` and the unknown-code default).
- **Sync guard** (precedent: the BM25 language-groups sync test): a test asserts the
  recommender's `stemming` map matches the languages enumerated in `rag_fts_config`
  (`sql/014`), so adding a stemmer to the SQL without updating the recommender (or vice
  versa) fails CI.
- `isCjk` agrees with `detectLanguage`'s CJK outputs (`zh`/`ja`/`ko`).
- `needsNormalization` agrees with `normalizeForLanguage` being non-identity for the code.

## Files

- `src/recommend.ts` — new module: `LanguageRecommendation` type + `recommendForLanguage`.
- `src/index.ts` — export both under "Utilities".
- `tests/recommend.test.ts` — unit + sync-guard tests.
- `README.md` — short "Recommended setup per language" subsection pointing at the function,
  reiterating that thresholds are starting points and dimension is per-database.
