# pg-hybrid-rag

Hybrid RAG search pipeline with vector + trigram + full-text search, fused via Reciprocal Rank Fusion (RRF). Postgres-native multilingual stemming, per-tenant stop words, synonym expansion, and optional CJK support via pg_bigm. Zero npm dependencies.

## Why pg-hybrid-rag?

Most RAG implementations rely on vector search alone. That works for semantic queries ("comfortable running shoes") but fails on exact matches ("Nike Air Max 270"), product codes, and keyword-heavy searches. pg-hybrid-rag runs three search strategies in parallel — vector similarity, trigram matching, and full-text search — then fuses them with RRF so you get the best of all three without tuning each one independently.

Everything runs inside Postgres. No Elasticsearch, no Redis, no external search engine. If you already have Postgres with pgvector, you can add hybrid search without new infrastructure. Stemming, stop words, synonyms, and language detection are all handled natively — 14 languages supported out of the box, with CJK support via pg_bigm. The library has zero npm dependencies and injects all I/O through interfaces, so it works with any database driver, any embedding provider, and any framework.

## Installation

```bash
npm install pg-hybrid-rag
# or
pnpm add pg-hybrid-rag
# or
bun add pg-hybrid-rag
```

In a monorepo, if this package lives alongside your consumer (e.g. `packages/rag` and `packages/api`), you can reference it locally instead. With pnpm/bun workspaces configured, use `workspace:*`. Without workspaces, use a relative path:

```json
{
  "dependencies": {
    "pg-hybrid-rag": "workspace:*"
  }
}
```

```json
{
  "dependencies": {
    "pg-hybrid-rag": "file:../rag"
  }
}
```

**Prerequisites:**
- **Node.js 18+** or **Bun 1.0+**
- PostgreSQL with `pgvector` and `pg_trgm` extensions
- Optional: `pg_bigm` extension for CJK keyword search
- For non-Bun runtimes, add `@types/node` as a dev dependency for type checking

## Quick Start

```typescript
import {
  RagPipeline,
  RagIndexer,
  Chunker,
  PostgresRagDatabase,
  OpenAiCompatibleEmbedder,
  ragMigrate,
} from "pg-hybrid-rag";

// 1. Apply migrations
await ragMigrate(sqlClient);
// With CJK support: await ragMigrate(sqlClient, { cjk: true });

// 2. Set up adapters
const embedder = new OpenAiCompatibleEmbedder({
  baseUrl: "https://api.example.com",
  apiKey: "sk-...",
  model: "multilingual-e5-small",
});

const db = new PostgresRagDatabase(txProvider);
// With CJK: new PostgresRagDatabase(txProvider, { cjk: true });

// 3. Search
const pipeline = new RagPipeline({
  tenantId: "my-tenant",
  db,
  embedder,
});
const results = await pipeline.search("blue cotton shirt", { language: "en" });

// 4. Index
const indexer = new RagIndexer({ tenantId: "my-tenant", db, embedder });
const chunker = new Chunker({
  tokenLimit: 512,
  overlap: 75,
  prefixFn: (m) => m.brand ? `[${m.name} | ${m.brand}]` : m.name ? `[${m.name}]` : undefined,
});
const chunks = chunker.chunk(text, { name: "Product Name", language: "en" });
await indexer.index("product", productId, chunks, "en");
```

## Language Support

Stemming is handled by Postgres via language-specific FTS configurations. The `rag_fts_config()` SQL function maps language codes to Postgres `regconfig` names. Both short codes (`en`) and BCP-47 locale codes (`en-US`, `fr-FR`) are supported.

| Language | Accepted Codes | Postgres FTS Config | Stemming | Keyword Search |
|----------|---------------|---------------------|----------|---------------|
| English | `en`, `en-US`, `en-IN` | `english` | Yes | pg_trgm |
| Spanish | `es`, `es-ES`, `es-MX` | `spanish` | Yes | pg_trgm |
| French | `fr`, `fr-FR` | `french` | Yes | pg_trgm |
| German | `de`, `de-DE` | `german` | Yes | pg_trgm |
| Italian | `it`, `it-IT` | `italian` | Yes | pg_trgm |
| Portuguese | `pt`, `pt-PT` | `portuguese` | Yes | pg_trgm |
| Romanian | `ro`, `ro-RO` | `romanian` | Yes | pg_trgm |
| Hindi | `hi`, `hi-IN` | `simple` | No | pg_trgm |
| Arabic | `ar`, `ar-SA` | `simple` | No | pg_trgm |
| Malay | `ms` | `simple` | No | pg_trgm |
| Sinhalese | `si`, `si-LK` | `simple` | No | pg_trgm |
| Thai | `th`, `th-TH` | `simple` | No | pg_trgm (segmenter-aware; see below) |
| Chinese | `zh`, `zh-CN` | `simple` | No | pg_bigm (requires `cjk: true`; or trgm with segmenter) |
| Japanese | `ja`, `ja-JP` | `simple` | No | pg_bigm (requires `cjk: true`; or trgm with segmenter) |
| Korean | `ko`, `ko-KR` | `simple` | No | pg_bigm (requires `cjk: true`; or trgm with segmenter) |
| Other | any string | `simple` | No | pg_trgm |

**Notes:**
- Languages with native Postgres stemming get morphological normalization in the FTS leg (e.g. "running" → "run").
- Languages using `simple` config get word-level tokenization and lowercase matching only. The vector and keyword legs compensate — vector search handles semantics, pg_trgm handles fuzzy character overlap.
- CJK languages need `pg_bigm` for effective keyword search because they lack whitespace between words. Without `cjk: true`, CJK keyword search falls back to pg_trgm (degraded).
- To add new language codes, update the `rag_fts_config()` function in `sql/008_postgres_stemming.sql`. Postgres supports additional configs including `dutch`, `danish`, `finnish`, `hungarian`, `norwegian`, `russian`, `swedish`, and `turkish`.
- **The FTS leg is single-language by construction.** Each document's tsvector is built with *its own* language's stemmer at index time, while a query is stemmed with the *query's* language (`language` option). The stemmed lexemes only align when the two match, so the FTS leg contributes meaningfully only when the query language ≈ the document language. For cross-language search (no `languages` filter, or a query whose language differs from the documents'), the FTS leg degrades toward no contribution — the language-agnostic vector leg (embeddings) and keyword leg (character trigrams) carry recall in that case. For best FTS results, set `language` to match the documents you're searching, or scope to one language via `languages` (see below).

## API Reference

### Search

```typescript
const pipeline = new RagPipeline({
  tenantId: string,
  db: RagDatabase,
  embedder: EmbeddingProvider,
  stopWords?: StopWordsProvider,   // optional
  synonyms?: SynonymProvider,      // optional
  reranker?: RerankerProvider,     // optional (cross-encoder)
  logger?: RagLogger,              // optional
  tracer?: RagTracer,              // optional (OTel)
});

const results = await pipeline.search(query, {
  topK?: number,                   // default: 5
  vectorMinScore?: number,         // default: 0.8
  keywordMinScore?: number,        // default: 0.35
  vectorWeight?: number,           // default: 1
  keywordWeight?: number,          // default: 1
  ftsWeight?: number,              // default: 1
  rrfK?: number,                   // default: 60
  sourceTypes?: string[],          // filter by source type
  sourceIds?: string[],            // filter by source ID
  languages?: string[],            // filter by document language (omit for cross-language)
  minRelevance?: number,           // 0-1, drop below top * threshold
  language?: string,               // REQUIRED (or a single-entry `languages`); no default
  normalizer?: { normalize(text, lang): string },
  rerank?: boolean,                // default: false
  rerankerMinRelativeScore?: number, // fraction of top reranked score, default: 0.01
  rerankerMinAbsoluteScore?: number, // hard floor in model's units, default: 0 (off)
});
```

#### Search pipeline flow

The search pipeline processes a query through these stages in order:

1. **Normalize** — lowercase, strip trailing punctuation, optionally expand abbreviations via `normalizer`
2. **Remove stop words** — drop common words (loaded per-tenant from `rag_stop_words`) so they don't dilute search
3. **Embed + load synonyms** — run in parallel: embed the cleaned query and load tenant synonyms
4. **3-way hybrid search** — run vector, keyword (pg_trgm), and FTS (tsvector) searches concurrently against Postgres
5. **RRF fusion** — merge the three ranked lists into one using Reciprocal Rank Fusion
6. **Relevance cutoff** — optionally drop results scoring below a fraction of the top result
7. **Rerank** — optionally re-score with a cross-encoder for final ordering

#### Search options explained

| Option | Default | What it does |
|--------|---------|-------------|
| `topK` | `5` | Number of final results to return. Also controls how many candidates each search leg fetches (`topK * candidateMultiplier`). |
| `vectorMinScore` | `0.8` | Minimum cosine similarity for the vector search leg. Chunks below this threshold are excluded before RRF. Higher values mean stricter semantic matching — raise if you get too many loosely related results, lower if relevant results are being missed. |
| `keywordMinScore` | `0.35` | Minimum `word_similarity` score for the pg_trgm keyword leg (or `bigm_similarity` for CJK). Controls fuzzy character-overlap matching. Lower than vectorMinScore because trigram similarity scores are naturally lower than cosine similarity. |
| `vectorWeight` | `1` | Weight multiplier for the vector leg in RRF fusion. Setting to `2` makes semantic matches count twice as much as the other legs. Set to `0` to disable vector search entirely. |
| `keywordWeight` | `1` | Weight multiplier for the keyword (pg_trgm) leg in RRF fusion. Useful for queries where exact character overlap matters (product names, SKUs, codes). |
| `ftsWeight` | `1` | Weight multiplier for the full-text search leg in RRF fusion. FTS uses Postgres stemming, so "running shoes" matches "run shoe". Boost this for natural-language queries where morphological matching helps. |
| `rrfK` | `60` | Smoothing constant in the RRF formula: `score = weight / (rrfK + rank)`. Higher values flatten score differences between ranks (all results score similarly). Lower values amplify the gap between top-ranked and lower-ranked results. `60` is the standard value from the original RRF paper. |
| `fusion` | `"rrf"` | Leg fusion method. `"rrf"` (default) = Reciprocal Rank Fusion (rank-only). `"linear"` = per-leg score normalization + weighted sum, using the legs' actual relevance scores (cosine, word_similarity, bm25). Reuses the `*Weight` options as linear weights. |
| `fusionNormalizer` | `"minmax"` | Per-leg normalization for `fusion: "linear"`: `"minmax"` (best→1, worst→0 within each leg) or `"l2"` (divide by the leg's score vector norm; preserves relative magnitude). Ignored for `"rrf"`. |
| `sourceTypes` | — | Filter results to specific source types (e.g. `["product", "article"]`). Applied as a SQL WHERE clause before search, not post-filter. |
| `sourceIds` | — | Filter results to specific source IDs. Useful for scoping search to a known set of documents. |
| `languages` | — | Filter results to specific document languages (e.g. `["en", "hi"]`). Applied as a SQL WHERE clause in all three search legs. Omit for cross-language search (default). When exactly one language is given and `language` is not set, it is also used as the query `language` (FTS stemming) so the FTS leg stays effective. A multi-entry filter does **not** infer a query language — pass `language` explicitly, or `search()` throws. |
| `minRelevance` | — | Fraction of the top result's RRF score used as a floor (0–1). For example, `0.5` drops any result scoring below 50% of the best result. Applied after RRF fusion but before reranking. |
| `language` | **required** | Language code for FTS stemming (Postgres `regconfig`) and keyword search. Accepts short codes (`en`) or BCP-47 (`en-US`). Determines which Postgres stemmer is used — e.g. `english` stems "running" → "run", while `simple` does lowercase-only tokenization. Required: set this, or pass a single-entry `languages` filter (used as the query language). `search()` throws if neither is given — there is no `"en"` default, so a non-English corpus is never silently stemmed/scoped as English. |
| `normalizer` | — | Optional pre-processing hook called before stop-word removal. Receives the cleaned query and language. Useful for expanding abbreviations (e.g. "dept" → "department") or domain-specific normalization. |
| `rerank` | `false` | Enable cross-encoder reranking after RRF fusion. A cross-encoder scores each query-document pair jointly, which is more accurate than the independent scoring of the three search legs, but slower. Requires a `RerankerProvider` on the pipeline. If the reranker throws, results gracefully fall back to RRF order. |
| `rerankerMinRelativeScore` | `0.01` | Relative reranker cutoff: drop reranked results scoring below this fraction of the top reranked score. Model-agnostic — it keys off the gap between relevant and unrelated results rather than an absolute scale, so it works across rerankers. This is the everyday "drop unrelated results" knob. Set to `0` to disable. Skipped when the top score is not positive (e.g. raw logits). Only applies when reranking is active. |
| `rerankerMinAbsoluteScore` | `0` (off) | Absolute reranker score floor, in the model's own score units. Reranker scales are model-specific (e.g. `bge-reranker-v2-m3` via TEI scores even a perfect match around `0.07`), so a fixed absolute floor over-filters unless calibrated — that's why it defaults to off and the relative cutoff is preferred. Enable only when you've calibrated a value to your reranker. Only applies when reranking is active. |

#### Tuning tips

- **Precision over recall**: raise `vectorMinScore` and `keywordMinScore`, add `minRelevance: 0.5`
- **Recall over precision**: lower `vectorMinScore` to `0.6`, `keywordMinScore` to `0.2`, increase `topK`
- **Exact-match heavy** (product search, codes): set `keywordWeight: 2` or `ftsWeight: 2`
- **Semantic-heavy** (natural language questions): set `vectorWeight: 2`
- **Disable a leg**: set its weight to `0` (e.g. `ftsWeight: 0` to skip full-text search)

#### Recommended configurations

All numbers below come from a *single* Arabic-dialect FAQ benchmark (`bge-m3` embeddings + `bge-reranker-v2-m3`; see [`examples/benchmark/BENCHMARKING_LOG.md`](examples/benchmark/BENCHMARKING_LOG.md)). But most of these recommendations aren't *about* Arabic — what matters is what each one is **driven by**. Four are driven by language-independent factors (the pipeline's own mechanics, your embedder, or the *shape* of your corpus), so the mechanism should carry to any language and only the magnitudes need re-measuring. One — BM25 — is genuinely language-dependent. Treat all of them as starting points to validate on your own corpus and embedder, not universal defaults.

**Driven by the pipeline or your setup — should generalize across languages** *(the mechanism isn't Arabic-specific; revalidate the magnitudes on your corpus):*

- **Rerank a bounded union, not just the top-K.** *Driver: RRF + rerank-window mechanics — language- and corpus-independent.* When `rerank: true`, set `rerankCandidates` to roughly 2–3× `topK` (e.g. `rerankCandidates: 30` with `topK: 10`). The default reranks only the RRF top-K, which discards true positives that a leg surfaced but RRF ranked just below the cut — before the cross-encoder ever sees them. Reranking the union recovers them and still returns `topK`. This is a property of how RRF and a fixed rerank window interact, not of any language. Cost scales with `rerankCandidates` (more cross-encoder calls), so this is the main quality⇄latency lever, especially on CPU-only deployments.

- **`vectorMinScore` is embedder-specific.** *Driver: your embedder's cosine calibration — nothing language-specific.* The `0.8` default is calibrated for e5-family models. Better-calibrated embedders (e.g. bge-m3) place true-positive cosines lower, so `0.8` can silently drop the dense leg — lower it (e.g. `0`–`0.5`) when you change embedders. This is purely about the embedding model's score distribution, so it applies regardless of language.

- **Linear fusion can cut rerank depth — when your embedder's scores are calibrated.** *Driver: your embedder's score calibration — validate per embedder, not per language.* With an embedder whose cosine scores cleanly separate relevant from irrelevant (e.g. bge-m3), `fusion: "linear"` (with the default `fusionNormalizer: "minmax"`) reorders the union by actual scores instead of rank, so a *smaller* union reaches the same quality. In our benchmark, `fusion: "linear"` + `rerankCandidates: 20` matched plain RRF + `rerankCandidates: 30` at ~⅓ less rerank work. Validate per embedder: use `"l2"` only if it measures better (it was worse for us), and don't expect linear fusion to replace reranking — it barely moved the no-rerank path.

- **For FAQ corpora, index the question alongside the answer.** *Driver: corpus shape (queries paraphrase the FAQ question), not language — the lift came through the dense and trgm legs, so it's not Arabic- or BM25-specific.* When queries are paraphrases of a curated FAQ *question* (the common FAQ-RAG case), indexing only the answer forces every lexical leg to match a question against an answer — low surface overlap. Making the chunk content `question` + `answer` creates query↔content overlap and lifted retrieval substantially across **all** legs and dialects in our benchmark (all-dialect nDCG@10 ≈ .80 → .97; the closest-to-canonical query set reached R@1 = 100%). Because the gain rides the dense and trgm legs (not just BM25), it should track *whether your corpus is FAQ-shaped* rather than which language it's in — so it stacks with the configs above. It also makes the cross-encoder nearly optional: with the question in content, the *no-rerank* fused result reached all-dialect nDCG@10 ≈ .96 vs ≈ .97 reranked (and saturated on the closest-to-canonical dialects), whereas on answer-only content reranking was worth ~+.17 and essential — so on a CPU-bound deployment where the reranker dominates latency, an FAQ corpus that indexes the question can skip reranking with little loss (low-resource dialects like our Darija set are the exception — they still benefit from it). Treat it as a corpus-construction choice (it's an easier, more realistic FAQ setup), not a universal substitute for answer-text retrieval.

**Driven by the language itself — Arabic evidence, revalidate per language** *(whether it helps depends on the specific language):*

- **BM25 for low-resource languages/dialects.** *Driver: the language's resource level — this is the one recommendation that is genuinely language-dependent.* The `Bm25Fts` strategy lifts recall where stemming and dense coverage are weak (it recovered low-resource-dialect recall in our tests), but it can add lexical noise where the dense leg is already strong — enable it when you have such content and measure before enabling it broadly. In our benchmark its incremental value stayed concentrated on the low-resource dialect (Darija) and was neutral-to-slightly-negative on the well-resourced ones (MSA, Saudi), even after we put the question in content — so it added nothing where the dense leg already saturated. The *principle* (BM25 helps where stemming + dense coverage are weak) should carry to other low-resource languages, but whether a given language is "low-resource enough" to benefit is exactly the language-dependent part — so keep it a targeted lever you measure per language, not a default. Requires migrations 011 + 015 and `shared_preload_libraries` (see Optional extensions).

#### Recommended setup per language

`recommendForLanguage(language)` returns the calibrated starting points for a language in one
object, so you don't have to re-derive them from the code and benchmark logs. It is **advisory
and pure** — it returns values; you decide where to apply them.

```typescript
import { recommendForLanguage, ragMigrate, RagPipeline, LanguageNormalizer } from "pg-hybrid-rag";

const rec = recommendForLanguage("ar");
// rec = {
//   embedder: "BAAI/bge-m3",   // measured best for ar/th; strong multilingual default elsewhere
//   dimensions: 1024,          // size the embedding column to match
//   vectorMinScore: 0.4,       // starting point for bge-m3's cosine calibration
//   stemming: "arabic",        // Postgres FTS regconfig ("english" | … | "none")
//   needsNormalization: true,  // construct a LanguageNormalizer for this language
//   isCjk: false,              // true for zh/ja/ko → pg_bigm keyword path
// }

// install-time: size the embedding column + enable the CJK migration leg if needed
await ragMigrate(db, { embeddingDimensions: rec.dimensions, cjk: rec.isCjk });

// construction-time: pick providers from the structural flags
const normalizer = rec.needsNormalization ? new LanguageNormalizer() : undefined;
const pipeline = new RagPipeline({ tenantId, db, embedder, normalizer });

// query-time: use the calibrated floor
await pipeline.search(query, { language: "ar", vectorMinScore: rec.vectorMinScore });
```

| Field | Meaning |
|-------|---------|
| `embedder` / `dimensions` / `vectorMinScore` | Constant `BAAI/bge-m3` / `1024` / `0.4` — **measured** best for Arabic and Thai, applied as a multilingual default for every language. Thresholds are starting points; validate on your corpus. |
| `stemming` | Postgres FTS regconfig for the language (`"english"`, `"arabic"`, …) or `"none"` (the `simple` config). Mirrors `rag_fts_config`. |
| `needsNormalization` | `true` where `normalizeForLanguage` does more than NFC (Arabic orthographic folds, Thai digit folding) — i.e. construct a `LanguageNormalizer`. |
| `isCjk` | `true` for `zh`/`ja`/`ko` → enable the pg_bigm keyword path (`cjk: true` in the migration and adapter). |

> **The embedding dimension is per-database, not per-tenant.** `rec.dimensions` feeds the one-time
> `ragMigrate({ embeddingDimensions })`; the `rag_documents.embedding` column is a single fixed
> dimension shared by all tenants in that database. You can use a different embedder per tenant only
> if it has the **same** dimension — genuinely different dimensions (e.g. multilingual-e5-small at
> 384 vs bge-m3 at 1024) require separate databases. Because the recommendation is bge-m3/1024 for
> every language, one 1024-dim database hosts all languages cleanly.

> **No segmenter is recommended.** A Thai segmentation A/B (attacut / ICU / pg_bigm vs unsegmented)
> was a clean negative — unsegmented `pg_trgm` matched or beat every segmented arm and lost at the
> default `keywordMinScore`. The `Segmenter` interface remains available for consumers who measure a
> win on their own corpus.

### Index

```typescript
const indexer = new RagIndexer({
  tenantId: string,
  db: RagDatabase,
  embedder: EmbeddingProvider,
  logger?: RagLogger,
});

await indexer.index(sourceType, sourceId, chunks, language);
await indexer.deleteSource(sourceType, sourceId);
```

Indexing is upsert-style: calling `index` for an existing `sourceType + sourceId` deletes old chunks before inserting new ones. All chunks are embedded in a single batched call and inserted in a single SQL `INSERT`.

### Chunk

```typescript
// Character-based (original API, backwards compatible)
const chunker = new Chunker(maxSize?, overlap?);
const chunks = chunker.chunk(text, metadata?);

// Token-limit mode (recommended) — computes char limit per language
const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
const chunks = chunker.chunk(text, { language: "en", name: "Product" });
```

#### Character-based mode

| Parameter | Default | What it does |
|-----------|---------|-------------|
| `maxSize` | `512` | Maximum chunk size in characters. The chunker splits by paragraphs first, then sentences, then fixed-size. |
| `overlap` | `75` | Characters from the end of one chunk prepended to the next, aligned to the nearest word boundary. Provides context continuity across chunk boundaries. |

#### Token-limit mode

When constructed with `{ tokenLimit }`, the chunker computes an effective character limit per language using heuristic chars-per-token ratios with a 0.8 safety margin. This produces denser chunks that better utilize the embedding model's context window while staying safely under the token limit.

| Parameter | Default | What it does |
|-----------|---------|-------------|
| `tokenLimit` | — | Max tokens per chunk. The effective character limit is `tokenLimit × charsPerToken × 0.8`, varying by language. |
| `overlap` | `75` | Same as character-based mode — overlap is always in characters. |

Pass `language` in the metadata to activate language-aware sizing:

| Language | Codes | Chars/token | Effective limit (512 tokens) |
|----------|-------|-------------|------------------------------|
| English, Spanish, French, German, Italian, Portuguese, Romanian, Malay | `en`, `es`, `fr`, `de`, `it`, `pt`, `ro`, `ms` + BCP-47 | ~4 | 1638 chars |
| Hindi | `hi` + BCP-47 | ~3 | 1228 chars |
| Arabic | `ar` + BCP-47 | ~3 | 1228 chars |
| Sinhalese | `si` + BCP-47 | ~3 | 1228 chars |
| Chinese, Japanese, Korean | `zh`, `ja`, `ko` + BCP-47 | ~1.5 | 614 chars |
| Thai | `th` + BCP-47 | ~1.5 | 614 chars |
| Unknown | any other | 1 | 512 chars |

To prefix chunks with entity context, pass a `prefixFn` to the constructor. It receives the first chunk's metadata and returns a label string (or `undefined` to skip):

```typescript
// The label is prepended after sizing and is not counted toward the chunk size
// limit, so keep it short (or leave headroom in tokenLimit) to avoid overflow.
prefixFn: (m) => m.brand ? `[${m.name} | ${m.brand}]` : m.name ? `[${m.name}]` : undefined
```

### Pure Utilities

```typescript
import {
  detectLanguage, removeStopWords, buildFtsQuery, buildBm25Query,
  expandQueryWithSynonyms, applyRRF, stripTrailingPunctuation,
  buildFilters, toRankedCandidate,
} from "pg-hybrid-rag";

detectLanguage("दौड़ते हुए जूते");                  // "hi" (also: en/ar/hinglish, and zh/ja/ko for CJK)
removeStopWords("the best phone", stops);          // "best phone"
buildFtsQuery(query, synonymLookup);               // tsquery string (tsvector leg)
buildBm25Query(query, synonymLookup);              // BM25 query string (pg_textsearch leg)
expandQueryWithSynonyms(query, synonymLookup);     // synonym-expanded plain query string
applyRRF(legs, rrfK, topK, weights);               // fused results
stripTrailingPunctuation("phones?");               // "phones"

// For custom RagDatabase implementations:
buildFilters({ sourceTypes: ["product"], languages: ["en"] }, 3);
// → { clause: "AND source_type = ANY(...) AND language = ANY(...)", params: [...] }
toRankedCandidate(dbRow);                          // maps a raw DB row to RankedCandidate
```

### Migrate

```typescript
import { ragMigrate } from "pg-hybrid-rag";

await ragMigrate(sqlClient);                          // apply pending migrations
await ragMigrate(sqlClient, { rls: true });           // also apply RLS policies
await ragMigrate(sqlClient, { cjk: true });           // also apply CJK (pg_bigm) support
await ragMigrate(sqlClient, { rls: true, cjk: true }); // both
```

**Atomic migrations:** `ragMigrate` also accepts a `TransactionProvider` (the same interface `PostgresRagDatabase` uses). When given one, each migration file's statements and its tracking-row insert run inside a single `withConnection` scope wrapped in `BEGIN`/`COMMIT`, rolling back on error so a failed migration never leaves a partial state. Provide a `withConnection` that yields a dedicated connection (e.g. `postgres(url, { max: 1 })` or `sql.reserve()`); a bare `SqlClient` keeps the legacy per-statement (non-atomic) behavior, since it can't guarantee a single session.

```typescript
await ragMigrate(migrationProvider); // each file applied atomically (BEGIN/COMMIT/ROLLBACK)
```

The `sql/` directory is auto-detected on all Node versions (18+) and module formats (ESM and CJS). If auto-detection fails, pass `sqlDir` explicitly:

```typescript
await ragMigrate(sqlClient, { sqlDir: "/path/to/node_modules/pg-hybrid-rag/sql" });
```

SQL files are also available at `pg-hybrid-rag/sql/*` for manual migration systems.

### Optional extensions

These extensions are not bundled with standard Postgres — you must install them first, then enable them in `shared_preload_libraries` and restart Postgres before applying the migrations. Because all three require a restart, you can enable them together with a single rolling restart.

For local development, `examples/docker-compose.yml` builds a ready-to-use image (`examples/Dockerfile`) that ships pgvector + VectorChord + pg_textsearch + pg_bigm together with `shared_preload_libraries` already set.

#### VectorChord (`vchordrq`) — faster vector index

VectorChord replaces the default IVFFlat index with a `vchordrq` (RaBitQ-quantized graph) index, giving significantly faster approximate nearest-neighbor search at high recall. No application code changes are needed — it keeps the same `<=>` cosine operator.

**Step 1 — install the extension.**
Use the [`tensorchord/vchord-postgres`](https://github.com/tensorchord/VectorChord) Docker image (ships pgvector + vchord), or install the `.deb`/`.rpm` from the VectorChord releases page into your existing Postgres.

**Step 2 — add to `shared_preload_libraries` and restart.**

```
# postgresql.conf
shared_preload_libraries = 'vchord'
```

**Step 3 — apply the migration.**

```typescript
import { ragMigrate } from "pg-hybrid-rag";

await ragMigrate(sqlClient, { vectorchord: true });
// Drops idx_rag_embedding_ivfflat, creates idx_rag_embedding_vchordrq
```

**Step 4 — no other changes.** `PostgresRagDatabase` uses the same `<=>` cosine operator regardless of which index is active; the planner automatically picks `idx_rag_embedding_vchordrq`.

> **Note:** Applying the migration on a populated table will block while the index builds. For large datasets, apply during a maintenance window or use `CREATE INDEX CONCURRENTLY` manually (the migration uses `CREATE INDEX IF NOT EXISTS` — safe to run more than once).

---

#### pg_textsearch — BM25 full-text search

pg_textsearch replaces the default tsvector/tsquery FTS leg with BM25 probabilistic ranking (via the `<@>` operator). BM25 typically produces better-calibrated scores than tsvector's TF-IDF weighting, especially for short queries and long documents.

**Step 1 — install the extension.**
Download the pre-built `.deb` from the [Timescale pg_textsearch releases](https://github.com/timescale/pg_textsearch/releases) page and install it into your Postgres. The `examples/Dockerfile` shows a multi-stage build that does this automatically.

**Step 2 — add to `shared_preload_libraries` and restart.**

```
# postgresql.conf
shared_preload_libraries = 'pg_textsearch'
```

**Step 3 — apply the migration.**

```typescript
import { ragMigrate } from "pg-hybrid-rag";

await ragMigrate(sqlClient, { bm25: true });
// Creates per-language partial BM25 indexes on rag_documents.content
```

The migration creates one partial BM25 index per language group (english, spanish, french, german, italian, portuguese, romanian) plus a `simple` catch-all for all other languages. The tsvector column and trigger from migration 004 are preserved — both strategies coexist in the schema.

**Step 4 — switch to `Bm25Fts` in your database adapter.**

```typescript
import { PostgresRagDatabase, Bm25Fts, ragMigrate } from "pg-hybrid-rag";

// Apply migration first (idempotent — safe to call on every startup)
await ragMigrate(sqlClient, { bm25: true });

// Pass Bm25Fts as the FTS strategy
const db = new PostgresRagDatabase(txProvider, { fts: new Bm25Fts() });

const pipeline = new RagPipeline({ tenantId, db, embedder });
```

**Step 5 — always pass `language` in search options.**

`Bm25Fts` uses the `language` value from each search call to route to the correct partial index. Without it the query falls back to the `simple` catch-all index (no stemming).

```typescript
// Good — planner uses idx_rag_bm25_en (english stemming)
await pipeline.search("running shoes", { language: "en" });

// Good — planner uses idx_rag_bm25_fr (french stemming)
await pipeline.search("chaussures de course", { language: "fr" });

// Falls back to idx_rag_bm25_simple (no stemming) for unsupported languages
await pipeline.search("दौड़ते हुए जूते", { language: "hi" });
```

**BM25 language coverage:**

| Index | Languages | Stemming |
|-------|-----------|---------|
| `idx_rag_bm25_en` | `en`, `en-US`, `en-IN` | Yes (english) |
| `idx_rag_bm25_es` | `es`, `es-ES`, `es-MX` | Yes (spanish) |
| `idx_rag_bm25_fr` | `fr`, `fr-FR` | Yes (french) |
| `idx_rag_bm25_de` | `de`, `de-DE` | Yes (german) |
| `idx_rag_bm25_it` | `it`, `it-IT` | Yes (italian) |
| `idx_rag_bm25_pt` | `pt`, `pt-PT` | Yes (portuguese) |
| `idx_rag_bm25_ro` | `ro`, `ro-RO` | Yes (romanian) |
| `idx_rag_bm25_simple` | all others | No (lowercase only) |

> **Switching back:** To revert to the default tsvector FTS, construct `PostgresRagDatabase` without the `fts` option (or pass `new TsvectorFts()`). The BM25 indexes remain but are unused, and the tsvector column is always kept up to date by the trigger.

---

#### Using both together

Enable VectorChord and BM25 with a single restart and a single migrate call:

```
# postgresql.conf
shared_preload_libraries = 'vchord,pg_textsearch'
```

```typescript
import { PostgresRagDatabase, Bm25Fts, ragMigrate } from "pg-hybrid-rag";

await ragMigrate(sqlClient, { vectorchord: true, bm25: true });

const db = new PostgresRagDatabase(txProvider, { fts: new Bm25Fts() });
const pipeline = new RagPipeline({ tenantId, db, embedder });
```

This gives you VectorChord's faster ANN search on the vector leg combined with BM25's better-calibrated scoring on the FTS leg.

---

#### pg_bigm — CJK keyword search

pg_bigm replaces the keyword leg's `word_similarity` (pg_trgm) with `bigm_similarity` for Chinese, Japanese, and Korean (`zh`, `zh-CN`, `ja`, `ja-JP`, `ko`, `ko-KR`). All other languages continue using pg_trgm unchanged.

**Why bigrams for CJK:** CJK scripts write words as runs of characters with no whitespace between them. pg_trgm's `word_similarity` produces near-zero scores on CJK text because short CJK queries generate too few trigrams to overlap with longer content strings. pg_bigm builds bigrams over character pairs, which works regardless of word boundaries — a query like `炊飯器` (rice cooker) correctly overlaps with text that contains `炊飯ジャー` or `ご飯炊き`.

**Step 1 — install the extension.** pg_bigm has no pre-built packages; build from source:

```bash
# Build pg_bigm from source (requires build-essential and postgresql-server-dev-17)
curl -fsSL https://github.com/pgbigm/pg_bigm/archive/refs/tags/v1.2-20240606.tar.gz \
  | tar xz && cd pg_bigm-1.2-20240606
make USE_PGXS=1 && make USE_PGXS=1 install
```

`examples/Dockerfile` automates this in a multi-stage build — running `podman compose up -d` (or `docker compose up -d`) in `examples/` gives you a ready-to-use image with pg_bigm already installed.

**Step 2 — add to `shared_preload_libraries` and restart.**

```
# postgresql.conf
shared_preload_libraries = 'pg_bigm'
```

**Step 3 — run the CJK migration.**

```typescript
await ragMigrate(sqlClient, { cjk: true });
// Creates pg_bigm extension and replaces the keyword index on zh/ja/ko rows
```

**Step 4 — enable CJK mode in the database adapter.**

```typescript
import { PostgresRagDatabase } from "pg-hybrid-rag";

const db = new PostgresRagDatabase(txProvider, { cjk: true });
const pipeline = new RagPipeline({ tenantId, db, embedder });
```

> **Note:** `cjk: true` only affects the keyword leg for `zh`, `ja`, and `ko` language codes. The vector and FTS legs are unaffected. Hindi and Arabic separate words with whitespace, so pg_trgm produces meaningful trigram overlap for them and pg_bigm is not needed.

---

#### Word segmentation (Thai/CJK)

Scripts without whitespace between words (Thai, Chinese, Japanese, Korean) traditionally use a word segmenter to produce word-boundary trigram overlap in the keyword leg, and to find clean word boundaries when chunking. (For Thai retrieval with a strong multilingual dense embedder, our benchmark found the keyword-leg segmenter *optional* — see **Recommended Thai configuration** below.) pg-hybrid-rag exposes a `Segmenter` interface so you can inject any segmentation backend — stdlib, dictionary-based, ML, or HTTP.

**The `Segmenter` interface and `segmentsLanguage` routing**

```typescript
interface Segmenter {
  /** Return text rewritten as space-joined word tokens, or unchanged for unsupported languages. */
  segment(text: string, language: string): string | Promise<string>;
  /** Whether this segmenter rewrites this language. Used for keyword-leg routing ONLY — never segments. */
  segmentsLanguage(language: string): boolean;
}
```

Inject the **same** `Segmenter` instance into `PostgresRagDatabase`, `RagPipeline`, and `RagIndexer` so indexing, querying, and keyword-leg routing all stay consistent. When `segmentsLanguage(language)` returns `true`, `PostgresRagDatabase` routes the keyword leg to trigram-on-`content_normalized` (segmented content) instead of pg_bigm (which assumes raw unsegmented content). When `segmentsLanguage` returns `false` the leg routes to pg_bigm as usual (for CJK without a segmenter) or pg_trgm (for all other languages).

**Index-time: `chunkSegmented` for word-aware boundaries**

When chunking Thai or CJK text, call `chunker.chunkSegmented(text, metadata)` (async) instead of `chunker.chunk()`. It uses the injected segmenter to find word boundaries but emits **natural, unsegmented** chunk content — the segmenter is boundary-finding only. It is safe to call unconditionally: with no segmenter or an unhandled language it falls back to `chunk()`.

**`IntlSegmenterAdapter` — zero-dep stdlib reference implementation**

```typescript
new IntlSegmenterAdapter({ languages: ["th"] })
```

Uses the runtime's built-in `Intl.Segmenter` (works on Node 18+ and Bun 1.0+). Zero npm dependencies.

**CAVEAT:** segmentation quality depends on the host ICU break dictionary. ICU's Thai dictionary handles native vocabulary reasonably but shreds loanwords not in its dictionary — verified identical behaviour on Node 24 (full ICU) and Bun 1.3. For loanword-heavy domains this is a runnable reference, not production-grade. For production Thai, inject a dictionary-based (PyThaiNLP-newmm), ML (deepcut/attacut), or HTTP segmenter instead.

**Full Thai setup example**

```ts
import { IntlSegmenterAdapter, RagPipeline, RagIndexer, PostgresRagDatabase, Chunker } from "pg-hybrid-rag";

const segmenter = new IntlSegmenterAdapter({ languages: ["th"] }); // reference impl; see caveat
const db = new PostgresRagDatabase(tx, { segmenter });
const pipeline = new RagPipeline({ tenantId, db, embedder, segmenter });
const indexer = new RagIndexer({ tenantId, db, embedder, segmenter });

// Index Thai: use chunkSegmented (async) for word-aware boundaries.
const chunks = await new Chunker({ tokenLimit: 512, segmenter }).chunkSegmented(text, { language: "th" });
await indexer.index("faq", "f-1", chunks, "th");

// Query Thai: lower vectorMinScore for BGE-M3-class embedders; enable rerank.
await pipeline.search("ราคาแพ็กเกจอินเทอร์เน็ต", { language: "th", vectorMinScore: 0.4, rerank: true });
```

**Recommended Thai configuration**

These come from a Thai-FAQ retrieval benchmark (`examples/benchmark-thai/`, BGE-M3 + `bge-reranker-v2-m3`, ~329 chunks, two query sets). Treat them as validated starting points, not universal defaults — re-measure on your corpus and embedder.

- **Embedder** *(the single biggest lever for Thai)*: use a strong multilingual dense embedder — **BGE-M3**. In our benchmark BGE-M3 dramatically outperformed `multilingual-e5-large` (fused baseline nDCG ≈ 0.75 vs 0.41; the gap held after reranking, 0.81 vs 0.53), and the default `multilingual-e5-small` is weaker still. e5-family models pack Thai texts into a narrow, low-contrast cosine band and can't separate hard same-domain candidates, so they are **not** a viable Thai substitute for BGE-M3.
- **`vectorMinScore`**: lower from the default `0.8` to `0.4` or lower. The `0.8` default is calibrated for e5-family models; better-calibrated embedders (BGE-M3) place true-positive cosines lower and `0.8` silently drops the dense leg.
- **Segmenter** *(optional — not required for retrieval quality)*: unsegmented pg_trgm + FTS matched or beat both ICU (`IntlSegmenterAdapter`) and attacut word segmentation across every config we measured (fused and lexical-only, both query sets) — segmentation never led by more than noise and lost outright at the default keyword threshold. A strong dense (BGE-M3) + FTS pair dominates fusion, and segmenting the keyword leg mainly inflates spurious short-token matches. Skipping the segmenter is the recommended default here and is simpler (no sidecar). This assumes a strong dense leg carries retrieval — with a weak or absent dense model the keyword leg matters more and a segmenter may help, so measure on your corpus. (A segmenter can still improve chunk **boundaries** via `chunkSegmented` — a separate concern this benchmark did not isolate.)
- **Reranking**: enable `rerank: true` with `rerankCandidates: 20–30` for best precision (baseline → reranked nDCG ≈ 0.75 → 0.81 in our benchmark). Reranking only reorders retrieved candidates — it cannot recover a true doc the retrieval legs missed, so embedder quality dominates.

**Runnable production example.** `examples/thai-segmenter/` ships a self-contained attacut
sidecar (FastAPI + PyThaiNLP, CPU) plus `examples/nestjs-thai-segmenter.ts` (`HttpThaiSegmenter`,
an HTTP `Segmenter` with timeout/retry/fail-fast + a space-insertion contract guard). Bring it
up with `docker compose up -d thai-segmenter` and exercise it via
`bun run examples/thai-segmenter/smoke.ts`. attacut is a neural tokenizer (good on loanwords,
no dictionary curation), unlike the ICU-based `IntlSegmenterAdapter`. The sidecar is
unauthenticated and does not bound request size — run it on a private network reachable only by
your app, not exposed publicly.

**CJK opt-in benchmark recipe**

To benchmark CJK with a segmenter instead of pg_bigm, inject the same `IntlSegmenterAdapter` (or your production segmenter) on pipeline + indexer + db, then re-index your content. The keyword leg automatically routes to trigram-on-segmented-content. To revert to pg_bigm, remove the `segmenter` option from all three and re-index — the routing reverts automatically.

## Adapter Interfaces

Consumers wire their own DB and embedding providers:

```typescript
interface TransactionProvider {
  withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

interface SqlClient {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
}

interface EmbeddingProvider {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

interface RerankerProvider {
  rerank(query: string, results: RagResult[], topN: number): Promise<RagResult[]>;
}

interface ChunkingProvider {
  chunk(text: string, metadata?: Record<string, string>): Chunk[];
}
```

### Custom Chunker Example (Chonkie)

The built-in `Chunker` implements `ChunkingProvider`. To use a different chunking library, wrap it to match the interface:

```typescript
import { RecursiveChunker } from "@chonkiejs/core";
import type { ChunkingProvider } from "pg-hybrid-rag";

// Pre-create the async chunker once
const chonkie = await RecursiveChunker.create({ chunkSize: 512 });

const chunker: ChunkingProvider = {
  chunk(text, metadata = {}) {
    // chonkie returns { text, tokenCount }[] — map to Chunk[]
    const result = chonkie.chunkSync(text);
    return result.map((c, i) => ({
      content: c.text,
      index: i,
      metadata,
    }));
  },
};

// Use with the indexer like any other chunker
const chunks = chunker.chunk(productText, { name: "Product", language: "en" });
await indexer.index("product", productId, chunks, "en");
```

### node-postgres (pg) Example

```typescript
const txProvider: TransactionProvider = {
  // pool.connect() reserves ONE connection for the whole callback, pinning every query to it
  // WITHOUT opening a transaction — so the default manageTransaction (each tuned leg wraps its
  // own BEGIN/COMMIT) is correct. Always release in finally.
  withConnection: async (fn) => {
    const client = await pool.connect();
    try {
      return await fn({ query: (sql, params) => client.query(sql, params).then((r) => r.rows) });
    } finally {
      client.release();
    }
  },
};
const db = new PostgresRagDatabase(txProvider); // manageTransaction defaults to true
```

### Prisma Example

```typescript
const txProvider: TransactionProvider = {
  withConnection: (fn) =>
    // $transaction(fn) reserves ONE pooled connection for the whole callback AND wraps it in its
    // own BEGIN/COMMIT, so every query the search legs issue lands on the same connection. Use the
    // interactive-transaction client `tx` — a top-level prisma.$queryRawUnsafe would escape back
    // to the pool and defeat the pinning.
    prisma.$transaction((tx) =>
      fn({ query: (sql, params) => tx.$queryRawUnsafe(sql, ...params) }),
    ),
};
// $transaction already opens a transaction, so disable the legs' own BEGIN/COMMIT (a nested BEGIN
// warns and the inner COMMIT would end Prisma's transaction early) — exactly like postgres.js below.
const db = new PostgresRagDatabase(txProvider, { manageTransaction: false });
```

### postgres.js Example

```typescript
const txProvider: TransactionProvider = {
  withConnection: (fn) => withTenantSql(tenantId, (sql) =>
    fn({ query: (text, params) => sql.unsafe(text, params) })
  ),
};

// withTenantSql opens its OWN interactive transaction (BEGIN + SET LOCAL app.current_tenant_id
// for RLS). Construct the adapter with manageTransaction: false so the tuned search legs do NOT
// nest their own BEGIN/COMMIT inside it — a nested BEGIN warns "transaction already in progress"
// and the inner COMMIT would end the tenant transaction (and discard the SET LOCAL) mid-search.
const db = new PostgresRagDatabase(txProvider, { manageTransaction: false });
```

> **Connection pinning (required).** `withConnection` MUST run every query in its callback on a single, pinned connection. The search path applies planner GUCs transaction-locally (`ivfflat.probes`, trigram `word_similarity_threshold`); if a pooled provider hands out a different connection per query, those `SET LOCAL` settings land on a connection that the actual search query never uses — vector recall silently drops to `probes = 1` and you get stray "no transaction in progress" warnings. With node-postgres reserve the connection via `pool.connect()`; with Prisma wrap the callback in `prisma.$transaction(...)` as shown above. Indexing and delete are single-statement and unaffected, so this fails silently on search quality only.

> **Transaction ownership (`manageTransaction`).** Two ways to pin a connection, two settings:
>
> - **Pin only, no ambient transaction** — node-postgres `pool.connect()`. Keep the default: the tuned search legs *and* `replaceSource` (re-indexing) wrap their work in their own `BEGIN`/`COMMIT` (`ROLLBACK` on error).
> - **Pin via an interactive transaction** — Prisma `prisma.$transaction(...)` or postgres.js `withTenantSql` (the latter also does `SET LOCAL app.current_tenant_id` for RLS). Construct the adapter with `new PostgresRagDatabase(txProvider, { manageTransaction: false })`. The legs and `replaceSource` then run `set_config(..., is_local => true)` and their SQL in that ambient transaction (GUCs stay transaction-local to it) and never issue `BEGIN`/`COMMIT`/`ROLLBACK`; on error they rethrow and the consumer's transaction owns rollback. Passing an interactive-transaction provider but leaving `manageTransaction` at its default makes the legs nest a `BEGIN` (which warns "transaction already in progress") and `COMMIT` the consumer's transaction early — discarding any `SET LOCAL`.
>
> RLS itself fails closed: the policies use the 2-arg `current_setting('app.current_tenant_id', true)`, so a connection that never set the tenant GUC matches zero rows instead of erroring.

## Default Adapters

- **PostgresRagDatabase** — parameterized SQL for 3-way hybrid search + CRUD; runs all 3 search legs in parallel; optional `{ cjk: true }` for pg_bigm keyword search on CJK languages
- **OpenAiCompatibleEmbedder** — fetch-based, works in Node + Bun; supports `batchSize` and `concurrency` for batched embedding. See [`examples/docker-compose.yml`](examples/docker-compose.yml) for running a self-hosted embedding API with HuggingFace TEI.
- **CachingStopWordsLoader** — 30s TTL, queries `rag_stop_words`; `loadMerged()` caches flattened Set across languages
- **CachingSynonymLoader** — 30s TTL, queries `rag_synonyms`, two-way direction

### Reranking

The library supports optional cross-encoder reranking post-RRF via a `RerankerProvider`. You provide the implementation — the library handles integration, graceful degradation, and score cutoff.

```typescript
// Example: TEI-compatible reranker
const reranker: RerankerProvider = {
  async rerank(query, results, topN) {
    const res = await fetch(`${RERANKER_URL}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        texts: results.map((r) => r.content),
        truncate: true,
      }),
    });
    const ranked = await res.json() as Array<{ index: number; score: number }>;
    return ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map((item) => ({ ...results[item.index], score: item.score }));
  },
};

const pipeline = new RagPipeline({ tenantId, db, embedder, reranker });
const results = await pipeline.search("blue shirt", { rerank: true, language: "en" });
```

Reranking is opt-in (`rerank: false` by default). If the reranker throws, the pipeline gracefully falls back to RRF results.

**Dropping unrelated results.** After reranking, two independent cutoffs decide what survives — a result must clear both:

- **`rerankerMinRelativeScore`** (default `0.01`, on) drops anything below that fraction of the top reranked score. This is the knob to reach for. Reranker score scales vary wildly between models, but the *gap* between relevant and unrelated results is large and consistent, so a relative cutoff drops the unrelated tail reliably without assuming a scale.
- **`rerankerMinAbsoluteScore`** (default `0`, off) is a hard floor in the model's own units, for the "return nothing when even the best match is weak" case. Calibrate it to your reranker first.

> **Why not a fixed absolute default?** Cross-encoder scores are not comparable across models. For example `bge-reranker-v2-m3` served via TEI applies a sigmoid and scores even a strong match around `0.07` (a second relevant result can land near `0.007`), while a relevant/unrelated cliff sits orders of magnitude below that. A fixed absolute floor like `0.01` silently drops relevant results for such a model — which is exactly why the relative cutoff is the default. The cross-encoder reads candidate **text**, not embeddings, so it's independent of your embedding model.

## Schema

The package manages 3 tables: `rag_documents`, `rag_stop_words`, `rag_synonyms`. All include `tenant_id` for multi-tenant isolation. RLS policies are optional (migration 007). CJK support via pg_bigm is optional (migration 009).

Stemming is handled by the `rag_fts_config()` SQL function which maps language codes to Postgres `regconfig` names. The tsvector trigger auto-applies the correct stemmer per row based on the `language` column.

## Examples

The [`examples/`](examples/) directory contains ready-to-use reference implementations:

| File | Description |
|------|-------------|
| [`playground.ts`](examples/playground.ts) | Full pipeline integration test against live infra (creates/drops an isolated DB automatically) |
| [`nestjs-rag-module.ts`](examples/nestjs-rag-module.ts) | NestJS module wiring with Prisma + Pino logger |
| [`nestjs-search.ts`](examples/nestjs-search.ts) | NestJS search service with multi-language support |
| [`nestjs-migrations.ts`](examples/nestjs-migrations.ts) | Running migrations on NestJS startup |
| [`nestjs-bullmq-reindex.ts`](examples/nestjs-bullmq-reindex.ts) | BullMQ worker for async reindexing |
| [`docker-compose.yml`](examples/docker-compose.yml) | Local Postgres (pgvector + VectorChord + pg_textsearch) + HuggingFace TEI embedding service |

## What This Package Does NOT Include

- No job queue — use your own (pg-boss, BullMQ, etc.)
- No text builders — domain-specific text generation stays in consumer apps
- No CRUD routes — admin APIs for stop words/synonyms are consumer concerns
- No config loading — tenant settings, feature flags, etc. are consumer concerns
- No NLP dependencies — stemming is fully delegated to Postgres

---

Built entirely by AI using [Claude Code](https://claude.ai/claude-code).
