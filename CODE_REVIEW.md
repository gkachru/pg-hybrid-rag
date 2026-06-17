# Code Review: pg-hybrid-rag

> Whole-codebase review (refreshed). Date: 2026-06-17.
> Verification state: `bun test` ✅ 181 pass · `bun run typecheck` ✅ clean · `bun run lint` ✅ clean (43 files).
> Every finding below was read against current source and the line refs verified; agent-surfaced false positives were dropped (see "Verified non-issues").

## Overall assessment

The library is in noticeably better shape than the prior review captured — most of that review's findings have since been fixed (vector leg now embeds the natural-language query, embedder sorts by `data[].index` and has timeout/retry/abort, RRF dedups on stable `id`, metadata `JSON.parse` is guarded, `detectLanguage` now handles CJK, the playground SQL is parameterized, the compose healthcheck is fixed, migrations apply atomically under a `TransactionProvider`). See "Resolved since last review" at the bottom.

What remains is a mix of one clear performance correctness issue (the keyword leg can't use its index), a few robustness gaps on the index/embed hot paths, and a tail of polish items. SQL is parameterized throughout; no injection was found. Findings are ordered by impact.

---

## Notable findings

### 1. Keyword leg cannot use the trigram GIN index — every keyword search is a sequential scan — `PostgresRagDatabase.ts:82,84`, `sql/003_hybrid_indexes.sql:2-3`

```sql
AND word_similarity($2, content) > $3
ORDER BY word_similarity($2, content) DESC
```

`gin_trgm_ops` accelerates the trigram **operators** (`%`, `<%`, `%>`), not a bare `word_similarity(a, b) > threshold` function comparison. The planner cannot derive an index condition from a function result, so `idx_rag_content_trgm` is unused and the keyword leg computes `word_similarity` for every tenant row, then sorts them all. The same applies to the CJK `bigm_similarity($2, content) > $3` path vs `idx_rag_content_bigm`.

**Impact:** on any non-trivial corpus the keyword leg degrades to a full per-tenant scan and becomes the latency floor of the 3-way search.

**Recommendation:** use the word-similarity operator so the index applies — `WHERE $2 <% content` — with the threshold set via `SET LOCAL pg_trgm.word_similarity_threshold = $3` on the leg's connection, keeping `word_similarity($2, content)` only in `SELECT`/`ORDER BY` for the score. For pg_bigm the indexable form is `content =% $2`. Confirm with `EXPLAIN (ANALYZE)`.

### 2. `RagIndexer` never checks that the embedder returned one vector per chunk — `RagIndexer.ts:43,55`

```ts
const embeddings = await this.embedder.embedDocuments(texts);
// ...
embedding: embeddings[i],
```

No assertion that `embeddings.length === chunks.length`. If a provider returns fewer rows than texts (a real failure mode for batched OpenAI-compatible servers that drop empty inputs), `embeddings[i]` is `undefined` for trailing chunks — which then hits `chunk.embedding.join(",")` in `PostgresRagDatabase.insertChunks` (`:129`) and throws an opaque `TypeError` deep in the adapter. If a *middle* text is dropped, every subsequent chunk silently gets the wrong vector.

**Recommendation:** after embedding, assert the counts match and throw a clear error (`Embedder returned ${embeddings.length} embeddings for ${chunks.length} chunks`). The embedder itself does not validate this either (see #9), so the check belongs here.

### 3. Chunker has no fixed-size fallback — an oversized delimiter-free or CJK sentence is emitted uncapped — `Chunker.ts:160-170`, class JSDoc `:40`

The class doc and CLAUDE.md both state chunking degrades "paragraph → sentence → **fixed size**." There is no fixed-size step. `splitBySentences` is the deepest level, and a single "sentence" longer than `effectiveSize` is emitted whole:

```ts
} else {
  buffer = sentence;   // sentence may be >> effectiveSize, never split
}
```

A long URL, a CSV row, or CJK text with no `。！？` terminator produces one giant chunk that the embedding API then truncates server-side — silently dropping content from the index. This is a genuine overflow beyond the documented "near-limit paragraph + overlap" soft note.

**Recommendation:** add the promised hard fixed-size fallback (slice an over-limit sentence into `effectiveSize`-bounded pieces, carrying overlap), or correct the doc/CLAUDE.md to drop the "then fixed size" claim if the soft limit is intentional.

### 4. `CachingSynonymLoader` parses `synonyms` JSON unguarded — one bad row takes down synonym expansion for the whole tenant — `CachingSynonymLoader.ts:68-70`

```ts
const rawSyns =
  typeof row.synonyms === "string" ? (JSON.parse(row.synonyms) as string[]) : row.synonyms;
const syns = rawSyns.map((s) => s.toLowerCase());
```

Two failure modes: (a) `JSON.parse` throws on a malformed string, rejecting the entire tenant load (and since rejections aren't cached, every search retries the failing query); (b) a valid-but-non-array value (`null`, object, or `["a", 3]`) makes `rawSyns.map` / `s.toLowerCase` throw. The `as string[]` cast hides both. This is exactly the driver-dependent (string vs array) path CLAUDE.md flags as fragile. Contrast `rrf.ts` (#11), which *was* hardened with try/catch — this path wasn't.

**Recommendation:** guard the per-row parse — `Array.isArray` check after parse, filter non-string elements, and wrap in try/catch so one bad row is skipped (optionally logged) rather than failing the tenant.

### 5. Dead index on a perpetually-NULL column (`content_stemmed`) — `sql/003_hybrid_indexes.sql:11-12`

`idx_rag_content_stemmed_trgm` indexes `content_stemmed`, but nothing ever writes that column — `insertChunks` (`PostgresRagDatabase.ts:130-139`) inserts no `content_stemmed`, and `sql/008:19` states "app-level stemming via content_stemmed is no longer used." The column (declared `sql/002:8`) is always NULL, so the GIN index covers only NULLs.

**Impact:** wasted storage and write-time index maintenance on every insert for an index that can never match; misleads maintainers into thinking a stemmed keyword path exists.

**Recommendation:** drop the index (and ideally the column) in a follow-up migration: `DROP INDEX IF EXISTS idx_rag_content_stemmed_trgm;` and consider dropping `content_stemmed`.

---

## Medium / low findings

### 6. One failing leg fails the entire hybrid search — `PostgresRagDatabase.ts:43`
The three legs run via `Promise.all`. If any single leg throws (e.g. a CJK query when `pg_bigm` isn't installed, a missing BM25 partial index, or a dropped connection), the whole `hybridSearch` rejects — even though the other two succeeded and RRF could still return useful results. Fusion of independent retrievers is partly a resilience story; this throws that away. **Recommendation:** use `Promise.allSettled`, treat a rejected leg as an empty contributor (surface via `RagLogger.warn`), and let RRF degrade to the surviving legs. If fail-fast is deliberate, document it.

### 7. `splitStatements` only recognizes bare `$$`, not named dollar-quote tags — `migrate.ts:35-40`
The splitter matches `/\$\$/g` and toggles `inDollarBlock`. Today's migrations all use bare `$$` on their own delimiter lines, so this is latent — but the JSDoc/CLAUDE.md advertise it as "`$$`-aware," and a future migration using a named tag (`DO $do$ … $do$`, `CREATE FUNCTION … AS $func$ … $func$`) will have its body's line-ending semicolons split, silently corrupting the statement and failing mid-apply. (The splitter is also unaware of `--` comments / string literals ending a line with `;`, same latent class.) **Recommendation:** match the full tag grammar `\$[A-Za-z_]\w*\$|\$\$` and track the specific open tag (push/pop), closing only on the matching tag.

### 8. `string_to_array($N, ',')` filter binding splits on commas inside a value — `sqlHelpers.ts:30,35,41`
Filters join the array on `,` and re-split in SQL. If any element contains a comma (most plausibly a `source_type`; `source_id` is a UUID and `language` a short code, so lower risk), the round-trip turns one value into two and silently corrupts the filter — over- or mis-matching rather than erroring. **Recommendation:** bind as a typed array (`= ANY($N::text[])`) where the driver supports it, or document the no-comma constraint on filter values.

### 9. Embedder does not validate the response payload shape — `OpenAiCompatibleEmbedder.ts:141-152`
`payload` is cast to `{ data: [...] }`; if a 200 response has a different shape (`{ error }`, missing `data`, `data` not an array), `json.data.every(...)` throws `TypeError` — which `isRetryableError` (`:41`) treats as retryable, so a misconfigured endpoint retries `maxRetries` times then surfaces an opaque `TypeError` instead of a clear diagnostic. **Recommendation:** validate `Array.isArray(json?.data)` (and ideally that the count equals `input.length`, see #2) before mapping; throw a descriptive non-retryable error otherwise.

### 10. IVFFlat built with `lists=100` and `ivfflat.probes` never set — `sql/003_hybrid_indexes.sql:6-8`
`probes` defaults to 1, so each vector search scans 1 of 100 lists — recall can be poor, and combined with the `vectorMinScore` cutoff it silently drops relevant chunks from the vector leg. `lists=100` is also a fixed guess unrelated to corpus size. Won't surface in the mocked tests. **Recommendation:** set `SET LOCAL ivfflat.probes = N` on the vector-leg connection and document `lists` tuning, or steer recall-sensitive deployments to the migration-010 vchordrq index.

### 11. `parseMetadata` returns non-object JSON unchecked — `rrf.ts:7-13`
The try/catch correctly handles malformed JSON (the previously-known issue — fixed). But valid-but-non-object JSON (`"42"`, `"[1,2]"`, `"null"`) is returned typed as `Record<string, string>`. Library-written rows are always objects, but `applyRRF` is exported and its own comment says it "may receive arbitrary rows." **Recommendation:** after parse, verify the result is a non-null, non-array object before returning `{}` otherwise.

### 12. `RagIndexer.index` stamps one language on every chunk, ignoring per-chunk `metadata.language` — `RagIndexer.ts:37,54`
`index()` takes a single `language = "en"` and writes it to every row, but the Chunker sizes chunks from `metadata.language` (`Chunker.ts:90`). A caller can chunk in `hi` yet index every row as `en`, which then drives the FTS tsvector trigger to English stemming and breaks the `languages` filter — silently. **Recommendation:** prefer `chunk.metadata.language ?? language` per row, or document that the `language` argument must match the metadata used for chunking.

### 13. `buildFtsQuery` can emit an invalid tsquery group → FTS leg hard-errors — `synonymExpander.ts:136-143`
If a matched multi-word span sanitizes entirely to empty, `phrase` becomes `""` but isn't filtered before composing the OR group, yielding e.g. `( | cod)` — a `to_tsquery` syntax error at query time. The single-word path guards this (`:152`); the multi-word path doesn't. The trigger is narrow (a synonym *key* made of tsquery-special chars), but the failure is a hard query error, not graceful degradation. **Recommendation:** drop `phrase` when empty and skip the group if no terms remain.

---

### Nits

- **Synonym expansion globally de-dups query words** (`synonymExpander.ts:68-74`): `expandQueryWithSynonyms` keys a single `seen` set across the whole query, so a legitimately repeated query word is emitted once. Since `buildBm25Query` (`:182-185`) feeds through it but `buildFtsQuery` does not, the BM25 and tsvector legs see different term multiplicity (BM25 ranks on TF). Either preserve query-word multiplicity for BM25 or document the de-duplicated-bag behavior.
- **Reranker `topScore` reduce seeds `0`** (`RagPipeline.ts:208`): for all-negative reranker scores (raw logits) `topScore` is computed as `0`, not the true max. The `topScore > 0` guard means the *outcome* (skip the relative floor) is currently correct, but the value is misleading and the safety hinges entirely on that guard. Seed with `reranked[0]?.score ?? -Infinity`.
- **Overlap tail slices UTF-16 code units** (`Chunker.ts:80-85`): `text.slice(-overlap)` can begin mid-surrogate-pair (lone surrogate) or mid-combining-sequence for exactly the astral/Devanagari/Arabic/CJK text this library targets, and the corrupted tail is prepended to the *next* real chunk. Guard the surrogate boundary, or operate on `Array.from(text)`.
- **`prefixFn` label not counted toward the size limit** (`Chunker.ts:135-146`): the label is prepended after sizing, so a non-trivial prefix pushes every chunk over `effectiveSize`. Reserve `label.length` from the limit, or document it.
- **`detectLanguage` reads `charCodeAt(0)` per code point** (`language.ts:20-21`): `for…of` yields whole code points, so a supplementary-plane character (CJK Extension B, U+20000+) is a surrogate pair and `charCodeAt(0)` matches no range — rare Han can fall through to `"en"`. Use `codePointAt(0)`.
- **`SynonymRow` types misrepresent runtime** (`types.ts:101-102`): `synonyms: string[]` contradicts the loader's `typeof === "string"` branch (driver-dependent JSONB) — type it `string[] | string`. `direction: string` should be `"two_way" | "one_way"` so a typo can't silently disable reverse expansion.
- **Synonym 5-cap selection is non-deterministic** (`CachingSynonymLoader.ts:52-63`, query `:32-34`): the default query has no `ORDER BY`, so which 5 synonyms survive the cap for a heavily-aliased term varies run-to-run. Add a deterministic `ORDER BY` and name the magic `5`.
- **`EmbeddingApiError` is not exported** (`OpenAiCompatibleEmbedder.ts:24`, `index.ts`): the typed error carrying HTTP `status` can't be `instanceof`-checked by consumers (e.g. to distinguish 401 from 429). Export the class and re-export from the barrel if surfacing typed errors is intended API.
- **`loadMerged` TTL drifts from `load`** (`CachingStopWordsLoader.ts:71-96`): the merged set caches independently and is built from a possibly-already-cached `load`, so stop-word edits can take up to ~60s (not the documented 30s) to take effect on the default merged path. Derive the merged set from `load`'s entry, or document the effective TTL.

---

## What's done well (worth keeping)

- **Injection discipline holds** — every leg binds the query/filters as parameters; the only inlined value is the BM25 index name, proven to come solely from `BM25_LANGUAGE_GROUPS` constants and pinned by `bm25Migration.sync.test.ts`. `$N` placeholder numbering is correct across all legs (verified by counting).
- **Embedder resilience** — timeout via `AbortController`, bounded retry-with-backoff on 429/5xx/network/timeout, non-retryable 4xx fail-fast, timer cleared in `finally`, and output ordered by `data[].index` (fixes a prior correctness risk). Retry count is off-by-one-correct (`maxRetries+1` total attempts).
- **In-flight coalescing** in both caching loaders deletes the in-flight entry in `finally`, so failures aren't cached and concurrent callers share one DB load.
- **Graceful reranker degradation** falls back to RRF results on reranker failure; the dual relative/absolute floor design is model-aware.
- **Atomic migrations under a `TransactionProvider`** — each file's statements plus its `_rag_migrations` insert run in one `BEGIN`/`COMMIT` with best-effort `ROLLBACK`; the bare-`SqlClient` path documents why it can't.

---

## Verified non-issues (checked and explicitly NOT flagged)

- **RLS does NOT allow cross-tenant writes.** The policies are `USING`-only (`sql/007`), but Postgres applies the `USING` expression as the implicit `WITH CHECK` when the latter is omitted, so INSERT/UPDATE *are* tenant-constrained. The real (milder) gaps: no `FORCE ROW LEVEL SECURITY`, so a connection as the **table owner** bypasses RLS entirely; and `current_setting('app.current_tenant_id')` throws when the GUC is unset — use the two-arg `current_setting(…, true)` form. Worth documenting as ops prerequisites, not a write-isolation hole.
- **Migration 010 `vchordrq (embedding vector_cosine_ops)`** uses a valid VectorChord operator class and shares the `<=>` operator, so application SQL needs no change.
- **BM25 partial-index predicate** uses `, ` vs the SQL index's `,` — a textual-only difference; Postgres matches predicates semantically, so the planner still selects the partial index.
- **`embedDocuments([])`** short-circuits correctly (no wasted API call) without needing a guard.
- **RRF row-mapping** keys dedup on stable `id`, merges scores across legs correctly, and intentionally ignores per-leg score columns (rank-based fusion).

---

## Resolved since the previous review

Fixed in current code (prior-review item → evidence):
- Vector leg embeds the natural-language query (`RagPipeline.ts:136`, `naturalQuery`).
- Embedder honors `data[].index` ordering (`OpenAiCompatibleEmbedder.ts:148-151`).
- Embedder has timeout / retry / abort (`:114-139`, `:103-112`).
- `detectLanguage` detects CJK — Han/kana/Hangul (`language.ts:16-56`).
- RRF dedups on stable `id`, not `content` (`rrf.ts:35`).
- Metadata `JSON.parse` is guarded (`rrf.ts:8-12`).
- Reranker floor is relative + absolute, not a fixed `0.01` (`RagPipeline.ts:208-218`).
- Playground SQL parameterized; compose healthcheck uses `POSTGRES_USER`/`POSTGRES_DB`; local CRLF lint clean.
- Migration atomicity addressed for the `TransactionProvider` path (`migrate.ts:143-162`).

---

## Suggested priority

1. **#1** keyword-leg index usage — biggest perf win, isolated SQL change (verify with `EXPLAIN`).
2. **#2** embedder/chunk count assertion — cheap guard against silent vector misalignment.
3. **#4** synonym JSON parse hardening — prevents a single bad row from breaking a tenant's search.
4. **#3** chunker fixed-size fallback — correctness + doc accuracy.
5. **#5 / #6** drop the dead index; make leg failures non-fatal.
