# pg-hybrid-rag

Hybrid RAG search library using pgvector, pg_trgm (+ optional pg_bigm for CJK), and PostgreSQL full-text search with Postgres-native stemming and Reciprocal Rank Fusion.

## Build & Test

```bash
bun run build          # tsup → dual ESM/CJS in dist/
bun run typecheck      # tsc --noEmit
bun run lint           # biome check
bun test               # bun:test, all tests in tests/
bun test tests/pipeline.test.ts  # single file
```

No test database needed — tests use mocks for all DB and embedding calls.

## Architecture

Three-way hybrid search fused via RRF:
1. **Vector** — cosine similarity via pgvector (`embedding <=> vector`)
2. **Keyword** — pg_trgm `word_similarity` on `content` (or pg_bigm `bigm_similarity` for CJK)
3. **FTS** — tsvector/tsquery with language-specific Postgres stemming + synonym expansion

### Core flow

**Search** (`RagPipeline.search`): strip punctuation → normalize query → remove stop words → embed → run 3 parallel DB queries → RRF fusion → optional relevance cutoff → optional cross-encoder reranking

**Index** (`RagIndexer.index`): embed chunks → delete old chunks for source → insert into `rag_documents` (Postgres tsvector trigger handles stemming)

**Chunk** (`Chunker.chunk`): split by paragraphs → sentences → fixed-size, with 75-char word-boundary overlap. Auto-prefixes chunks with `[Name | Brand]` from metadata.

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
| `src/interfaces.ts` | Provider interfaces (SqlClient, EmbeddingProvider, RagDatabase, etc.) |
| `src/migrate.ts` | SQL migration runner |
| `src/adapters/PostgresRagDatabase.ts` | Postgres adapter — 3-way search SQL, insert, delete, optional CJK |
| `src/adapters/OpenAiCompatibleEmbedder.ts` | Fetch-based OpenAI-compatible embedding client |
| `src/adapters/CachingStopWordsLoader.ts` | 30s TTL per-tenant stop words cache |
| `src/adapters/CachingSynonymLoader.ts` | 30s TTL per-tenant synonym cache |
| `sql/001-009_*.sql` | Database migrations (extensions, tables, indexes, triggers, RLS, stemming, CJK) |

## Design patterns

- **Dependency injection** — all providers passed at construction. Library owns no I/O; consumers provide SqlClient, TransactionProvider, EmbeddingProvider, optional RerankerProvider.
- **Multi-tenant** — every table has `tenant_id`. Optional RLS via migration 007.
- **Interface-first** — core logic depends on interfaces in `interfaces.ts`, not concrete adapters.
- **No env vars** — all config is explicit constructor params.
- **No runtime dependencies** — zero npm dependencies. Stemming handled by Postgres via `rag_fts_config()` SQL function.
- **Postgres-native stemming** — tsvector trigger uses language-specific Postgres FTS configs (english, spanish, french, etc.). Languages without a native config fall back to `'simple'`.
- **Optional CJK support** — pg_bigm for keyword search on Chinese/Japanese/Korean. Enabled via `{ cjk: true }` in migration and adapter constructor.
- **Parallel search** — PostgresRagDatabase runs all 3 search legs concurrently via separate connections.
- **Batch inserts** — PostgresRagDatabase inserts all chunks in a single INSERT statement.
- **Punctuation handling** — trailing punctuation stripped before matching (Latin, Hindi, Arabic, CJK).

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
- Exports barrel: `src/index.ts` — all public API re-exported from here
- Tests mock `RagDatabase`, `EmbeddingProvider`, and `RerankerProvider` interfaces — no real DB in tests
- Language detection via Unicode character ranges, not external libraries
