# pg-hybrid-rag

Hybrid RAG search library using pgvector, pg_trgm (+ optional pg_bigm for CJK), and PostgreSQL full-text search with Postgres-native stemming and Reciprocal Rank Fusion.

## Build & Test

```bash
bun run build          # tsup → dual ESM/CJS in dist/
bun run typecheck      # tsc --noEmit
bun run lint           # biome check
bun run lint:fix       # biome check --write (auto-fix)
bun test               # bun:test, all tests in tests/
bun test tests/pipeline.test.ts  # single file
bun run examples/playground.ts   # live integration test (needs DB + embedding API)
```

No test database needed — tests use mocks for all DB and embedding calls. The playground example creates and drops an isolated database automatically.

### Playground setup

```bash
cp examples/.env.example examples/.env   # fill in EMBEDDING_API_KEY; playground builds DATABASE_URL from POSTGRES_* vars
cp examples/.env .env                    # playground reads .env from project root (bun CWD)
cd examples && docker compose up -d      # or: podman compose up -d
bun run examples/playground.ts           # basic run
bun run examples/playground.ts --vectorchord --bm25 --cjk   # all optional extensions
```

## Architecture

Three-way hybrid search fused via RRF:
1. **Vector** — cosine similarity via pgvector (`embedding <=> vector`)
2. **Keyword** — pg_trgm `word_similarity` on `content` (or pg_bigm `bigm_similarity` for CJK)
3. **FTS** — tsvector/tsquery with language-specific Postgres stemming + synonym expansion

### Core flow

**Search** (`RagPipeline.search`): strip punctuation → normalize query → remove stop words → embed → run 3 parallel DB queries (with optional `languages` filter) → RRF fusion → optional relevance cutoff → optional cross-encoder reranking

**Index** (`RagIndexer.index`): embed chunks → delete old chunks for source → insert into `rag_documents` (Postgres tsvector trigger handles stemming)

**Chunk** (`Chunker.chunk`): split by paragraphs → sentences → fixed-size, with 75-char word-boundary overlap. Optionally prefixes chunks via a pluggable `prefixFn` callback. Supports token-limit mode (`new Chunker({ tokenLimit: 512 })`) with language-aware char-per-token heuristics for denser chunks.

### Key files

| File | Role |
|------|------|
| `src/RagPipeline.ts` | Search orchestrator |
| `src/RagIndexer.ts` | Indexing orchestrator |
| `src/Chunker.ts` | Semantic recursive chunker |
| `src/punctuation.ts` | Trailing punctuation stripping (Latin/Hindi/Arabic/CJK) |
| `src/language.ts` | Unicode script-based language detection |
| `src/synonymExpander.ts` | Synonym expansion + tsquery builder |
| `src/rrf.ts` | Reciprocal Rank Fusion |
| `src/stopWords.ts` | Stop word removal |
| `src/types.ts` | All type definitions |
| `src/interfaces.ts` | Provider interfaces (SqlClient, EmbeddingProvider, RagDatabase, ChunkingProvider, etc.) |
| `src/migrate.ts` | SQL migration runner |
| `src/adapters/PostgresRagDatabase.ts` | Postgres adapter — 3-way search SQL, insert, delete, optional CJK |
| `src/adapters/OpenAiCompatibleEmbedder.ts` | Fetch-based OpenAI-compatible embedding client with batched requests (`batchSize`, `concurrency`) and per-request timeout + retry-with-backoff (`timeoutMs`, `maxRetries`, `retryBaseDelayMs`) |
| `src/adapters/CachingStopWordsLoader.ts` | 30s TTL per-tenant stop words cache |
| `src/adapters/CachingSynonymLoader.ts` | 30s TTL per-tenant synonym cache |
| `src/adapters/fts/TsvectorFts.ts` | Default FTS strategy (tsvector/tsquery) |
| `src/adapters/fts/Bm25Fts.ts` | BM25 FTS strategy (pg_textsearch) |
| `src/adapters/fts/bm25LanguageGroups.ts` | BM25 language groups + partial-index predicate |
| `src/adapters/sqlHelpers.ts` | Shared filter-clause + row-mapping helpers |
| `sql/010_vectorchord.sql` | Optional vchordrq index (gated by `vectorchord`) |
| `sql/011_pg_textsearch.sql` | Optional BM25 indexes (gated by `bm25`) |
| `sql/001-011_*.sql` | Database migrations (extensions, tables, indexes, triggers, RLS, stemming, CJK) |

## Design patterns

- **Dependency injection** — all providers passed at construction. Library owns no I/O; consumers provide SqlClient, TransactionProvider, EmbeddingProvider, optional RerankerProvider.
- **Multi-tenant** — every table has `tenant_id`. Optional RLS via migration 007.
- **Interface-first** — core logic depends on interfaces in `interfaces.ts`, not concrete adapters.
- **No env vars** — all config is explicit constructor params.
- **No runtime dependencies** — zero npm dependencies. Stemming handled by Postgres via `rag_fts_config()` SQL function.
- **Postgres-native stemming** — tsvector trigger uses language-specific Postgres FTS configs (english, spanish, french, etc.). Languages without a native config fall back to `'simple'`.
- **Optional CJK support** — pg_bigm for keyword search on Chinese/Japanese/Korean. Enabled via `{ cjk: true }` in migration and adapter constructor.
- **Optional language scoping** — `languages` filter restricts all 3 search legs to specific document languages via `WHERE language = ANY(...)`. Omit for cross-language search (default). Uses `string_to_array($N::text, ',')` for driver-agnostic array parameter binding.
- **Parallel search** — PostgresRagDatabase runs all 3 search legs concurrently via separate connections.
- **Batched embedding** — OpenAiCompatibleEmbedder splits texts into configurable batches (`batchSize`, default 32) with configurable concurrency (default 1, sequential).
- **Resilient embedding** — OpenAiCompatibleEmbedder aborts each request after `timeoutMs` (default 30s, `0` disables) via AbortController, and retries transient failures (HTTP 429/5xx, network errors, timeouts) up to `maxRetries` times (default 2) with exponential backoff (`retryBaseDelayMs`, default 250ms). Non-retryable 4xx responses fail fast.
- **Token-limit chunking** — Chunker accepts `{ tokenLimit }` and computes per-language char limits using heuristic chars-per-token ratios (0.8 safety margin). Produces denser chunks for Latin scripts (~3x vs flat char limit).
- **Pluggable chunk prefix** — `prefixFn?: (metadata: Record<string, string>) => string | undefined` in `ChunkerConfig`. Called once per chunk batch; return a label (e.g. `[Name | Brand]`) or `undefined` to skip. Replaces the old hardcoded name/brand extraction.
- **Pluggable chunker** — `ChunkingProvider` interface lets consumers swap in alternative chunking libraries (e.g. chonkie).
- **Batch inserts** — PostgresRagDatabase inserts all chunks in a single INSERT statement.
- **Punctuation handling** — trailing punctuation stripped before matching (Latin, Hindi, Arabic, CJK).
- **Pluggable FTS strategy** — the FTS leg is an injectable `FtsStrategy` on `PostgresRagDatabase` (`fts` option). `TsvectorFts` (default) uses tsvector/tsquery + `rag_fts_config()`; `Bm25Fts` uses pg_textsearch BM25 (`content <@> query`). The pipeline passes `synonymLookup` (not a pre-built tsquery); the strategy builds its own query form (`buildFtsQuery` vs `buildBm25Query`).
- **BM25 per-language partial indexes** — `Bm25Fts` scopes the FTS leg to `params.language`'s group via `bm25LanguagePredicate()` so the planner uses the matching partial `bm25` index. `BM25_LANGUAGE_GROUPS` (TS) and `sql/011_pg_textsearch.sql` literals are kept in sync by a test.
- **Gated optional extensions** — `ragMigrate` flags `vectorchord` (migration 010, `vchordrq` index swap) and `bm25` (migration 011, pg_textsearch). Both require `shared_preload_libraries` + restart (ops prerequisite, not in the migration).

## Schema

- `rag_documents` — chunks with 384-dim embeddings, auto-populated tsvector (language-aware), metadata JSON, per-tenant
- `rag_stop_words` — per-tenant, per-language stop words
- `rag_synonyms` — per-tenant synonyms with `direction` (two_way/one_way)
- `_rag_migrations` — migration tracking
- `rag_fts_config()` — SQL function mapping language codes to Postgres regconfig

## Conventions

- Runtime: Bun (tests use `bun:test`, build uses tsup targeting ES2022)
- Linter: Biome (`bun run lint`)
- Strict TypeScript, no `any`
- All SQL uses parameterized queries — never interpolate user input
- Migration SQL splitter is `$$`-aware — semicolons inside PL/pgSQL function bodies are preserved
- `CachingSynonymLoader` handles JSONB synonyms as both parsed arrays and raw JSON strings (driver-dependent)
- Exports barrel: `src/index.ts` — all public API re-exported from here
- Tests mock `RagDatabase`, `EmbeddingProvider`, and `RerankerProvider` interfaces — no real DB in tests
- Language detection via Unicode character ranges, not external libraries
