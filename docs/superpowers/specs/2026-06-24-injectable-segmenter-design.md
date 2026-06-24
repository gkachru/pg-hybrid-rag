# Thai support via an injectable word `Segmenter` seam

- **Date:** 2026-06-24
- **Status:** Design approach approved; written spec pending user review
- **Area:** new `Segmenter` interface in `src/interfaces.ts` + optional `src/adapters/IntlSegmenter.ts`; wiring in `src/RagPipeline.ts`, `src/RagIndexer.ts`, `src/Chunker.ts`, `src/adapters/PostgresRagDatabase.ts`; Thai support in `src/language.ts`, `src/normalize.ts`, `src/punctuation.ts`; tests; README/docs. **No new SQL migration.**
- **Chosen approach:** A general, injectable **`Segmenter`** provider (sibling to the existing `Normalizer`) that rewrites whitespace-less scripts into space-delimited word tokens for the **lexical legs only**. Thai (`th`) is the proving consumer; CJK (`zh`/`ja`/`ko`) can opt in to segmentation as an alternative to the existing pg_bigm path. The library ships the interface + wiring + a **caveated** zero-dependency `IntlSegmenterAdapter`; production-grade segmenters are consumer-injected (same model as `EmbeddingProvider`).

## Problem

Thai has **no spaces between words** (spaces mark phrase/clause boundaries, not word boundaries), and Postgres ships **no Thai FTS config and no Thai stemmer**. Almost every lexical component in this library assumes whitespace tokenization, so Thai degrades silently rather than failing loudly:

- **FTS / tsvector** — `rag_fts_config('th')` falls to `'simple'` (`sql/008`/`sql/014`). `to_tsvector('simple', …)` over a space-less Thai run yields **one giant lexeme** → FTS matches only on exact whole-phrase equality → effectively dead for retrieval. Same failure that motivated pg_bigm for CJK.
- **Keyword (pg_trgm)** — `word_similarity($2, content_normalized)` (`buildTrigramKeywordSql`) is **word-boundary-aware**; with no spaces the whole Thai run is "one word," so it collapses to length-dependent full-string similarity — poor for short queries against long chunks.
- **Stop words / synonyms** — both `split(/\s+/)` (`stopWords.ts:8`, `synonymExpander.ts:59/132`). A Thai query is one token → stop-word removal is a no-op and multi-word synonym n-grams never match.
- **Chunker** — Thai content hits the worst path: no `\n\n`, no `[.!?।。！？]` terminators → one oversized "sentence" → `splitFixedSize` (`Chunker.ts:223`) slices on raw code points at the char limit, **cutting mid-word and orphaning combining vowel/tone marks** from their base consonant. Overlap (`getOverlapSuffix`, line 103) aligns to a space Thai lacks and guards only surrogate pairs, not Thai BMP combining marks. No `th` entry in `CHARS_PER_TOKEN`.
- **Language detection** — Thai (U+0E00–U+0E7F) is uncounted in `detectLanguage`, so Thai text returns `"en"`.

### Worked example

Query/chunk **`ผมอยากเปลี่ยนแพ็กเกจอินเทอร์เน็ต`** ("I want to change the internet package"):

| Leg (today) | Behavior | Result |
|---|---|---|
| tsvector `'simple'` | no spaces → 1 lexeme | ❌ matches only the identical full phrase |
| pg_trgm `word_similarity` | whole run = 1 "word" → full-string similarity | ❌ length-dependent, weak |
| stop words / synonyms | 1 token → no n-grams | ❌ no-op |
| Chunker fallback | code-point slice at the limit | ❌ orphans `◌ี`/`◌่` marks mid-word |

After a single segmentation pass — **`ผม อยาก เปลี่ยน แพ็กเกจ อินเทอร์เน็ต`** — every lexical leg works again: `to_tsvector('simple', …)` yields 5 lexemes, `word_similarity` has real word boundaries, stop-word removal can drop ผม, synonym n-grams can match อินเทอร์เน็ต, and the Chunker can pack/overlap on word boundaries.

### The root cause is general, not Thai-specific

The "no word boundaries / hard-to-tokenize" problem spans a class of languages, which is why an injectable seam (not a Thai special-case) is the right shape:

- **Scriptio continua (no inter-word spaces):** Thai, **zh/ja** (already supported, currently served by the degraded pg_bigm path), plus future Lao/Khmer/Burmese/Tibetan.
- **Spaces present but misaligned with words:** **Korean** (eojeol + particles → wants morpheme decomposition), **Vietnamese** (Latin script, spaces separate *syllables* not words → wants syllable-joining), **German** (compound nouns → wants decompounding).

A `Segmenter` injected on the index + query paths serves all of them; v1 wires Thai end-to-end and lets CJK opt in.

## Goals

- A general, injectable **`Segmenter`** seam applied **symmetrically** to indexed content and the lexical query, mirroring the existing `Normalizer` provider.
- Make the segmenter **self-describing** (`segmentsLanguage`) so keyword-leg routing (trgm vs pg_bigm) follows from one source of truth — no parallel config to keep in sync.
- **Thai end-to-end:** detection, orthographic normalization, segmentation on both paths, grapheme-safe + word-aware chunking, punctuation, chars-per-token.
- **CJK opt-in:** a segmented CJK language routes its keyword leg to trgm-on-segmented-content instead of pg_bigm, so segmentation-vs-bigram is benchmarkable per language. Bigram stays the default; nothing is removed.
- Stay **zero-runtime-dependency** and **Node + Bun compatible** (shipped code uses only stdlib `Intl`/`fetch`).
- Ship an optional `IntlSegmenterAdapter` as a runnable reference, with its limitations documented honestly.

## Non-goals (for this spec)

- No bundled dictionary or ML Thai segmenter in core (consumer-injected — same as `EmbeddingProvider`).
- No Vietnamese / Korean-morphology / German-decompounding rulesets (the seam supports them; none built here).
- No removal of the pg_bigm CJK path; no change to CJK default behavior unless a CJK segmenter is injected.
- No Thai mark-reordering normalization in v1 (NFC + digit folding only; deferred).
- No embedder/reranker changes in core — `vectorMinScore`/reranker guidance is docs-only.
- No new SQL migration (the seam rides the existing `content_normalized` plumbing).

## Design

### 1. The `Segmenter` interface

New provider in `src/interfaces.ts`, sibling to `Normalizer`:

```ts
/** Word segmentation for scripts without whitespace word boundaries (Thai, CJK, …).
 *  Applied symmetrically to indexed content and the lexical query; feeds the LEXICAL
 *  legs only (never the dense embedding or the reranker). Language-gated: impls return
 *  the input unchanged for languages they don't handle. Async-capable so an HTTP-backed
 *  segmenter (e.g. a PyThaiNLP service) is a drop-in, exactly like Normalizer. */
export interface Segmenter {
  /** Return `text` rewritten as space-joined word tokens, or unchanged for a language
   *  this segmenter does not handle. */
  segment(text: string, language: string): string | Promise<string>;
  /** Whether this segmenter rewrites `language`. Lets PostgresRagDatabase route a
   *  segmented language's keyword leg to trgm instead of pg_bigm. Routing only — this
   *  method must never segment. Must agree with `segment` (a language it segments
   *  returns true here). */
  segmentsLanguage(language: string): boolean;
}
```

**Interface-shape decisions:**
- **Separate provider** (not folded into `Normalizer`): single responsibility; lets a consumer mix an Arabic normalizer with no segmenter, or a Thai segmenter with no normalizer, and benchmark "normalize only" vs "normalize + segment".
- **Returns a space-joined `string`** (not `string[]`): drops into every existing `split(/\s+/)` consumer (stop words, synonym n-grams) and the `to_tsvector`/`word_similarity` SQL with zero rewrites, and matches the `text` type of the `content_normalized` column.
- **`segmentsLanguage` exists on `Segmenter` but has no analog on `Normalizer`** by design: normalization folds text but the *same* SQL legs run either way, so it never affects routing. Segmentation changes *which keyword leg is correct* for CJK (trgm-on-segmented vs bigram-on-raw), so it must inform the adapter. Principled asymmetry, not bloat.

### 2. Optional `IntlSegmenterAdapter` (zero-dep reference)

`src/adapters/IntlSegmenter.ts` — a concrete, optional adapter (same status as `OpenAiCompatibleEmbedder`: shipped in `src/adapters/`, injected, zero npm deps, stdlib only):

```ts
new IntlSegmenterAdapter({ languages: ["th"] })           // segment Thai only
new IntlSegmenterAdapter({ languages: ["th", "zh", "ja"] })
```

- Uses `new Intl.Segmenter(base, { granularity: "word" })`, joins word-granularity segments with single spaces, drops whitespace-only segments. Caches one `Intl.Segmenter` per language.
- `segment` is a **no-op passthrough** for any language not in `languages` (so Latin text is never re-spaced).
- `segmentsLanguage(lang)` ⇔ base subtag ∈ `languages`.
- Works identically on Node and Bun (stdlib `Intl`).

**Documented limitation (verified, both runtimes):** `Intl.Segmenter` quality depends on the host ICU break dictionary. ICU's Thai dictionary segments **native** vocabulary well but **shreds loanwords** not in its dictionary — measured identically on Bun 1.3.14 and Node 24 (full ICU): `แพ็กเกจอินเทอร์เน็ต` → `แพ็ก·เก·จอิน·เท·อร์·เน็ต` (✗). For loanword-heavy domains (telecom/tech), `IntlSegmenterAdapter` is a runnable starting point, **not** production-grade. Production users inject a dictionary-based segmenter (PyThaiNLP-newmm with a custom dict) or an ML segmenter (deepcut/attacut) that handles OOV — exactly what the injectable seam enables.

### 3. Query path (`RagPipeline`)

Add `segmenter?: Segmenter` to `RagPipelineConfig` (constructor-injected, like `normalizer`). Apply it to `lexicalQuery` **after** the orthographic `Normalizer` and **before** stop-word removal (`RagPipeline.ts:156–171`):

```
naturalQuery = (lowercased, punctuation-stripped, semantic-normalized)   // → embedding + reranker, UNSEGMENTED
lexicalQuery = await this.normalizer?.normalize(naturalQuery, lang)      // existing orthographic fold
lexicalQuery = await this.segmenter?.segment(lexicalQuery, lang)         // NEW: fold → segment
lexicalQuery = removeStopWords(lexicalQuery, stopWords)                  // now works: Thai is space-delimited
```

- **Lexical legs only.** `naturalQuery` (the dense embedding + the reranker) stays un-segmented — embedders/cross-encoders carry their own tokenizers and inserted spaces would hurt them. Identical containment to the orthographic normalizer.
- Order is **normalize → segment** (fold first so the segmenter sees clean text), and **segment → stop-words/synonyms** (so those see word tokens). `buildFtsQuery`/`buildBm25Query`/the trgm leg all consume the segmented `lexicalQuery` and need no change.
- Guard: if `segment` returns empty/whitespace, fall back to the pre-segmentation string (same defensive pattern as the normalizer guards).

### 4. Index path (`RagIndexer`) — no new storage migration

Add `segmenter?: Segmenter` to `RagIndexerConfig`. `content_normalized` becomes **fold → segment**:

```
contentNormalized = this.normalizer ? await normalize(content, lang) : content
contentNormalized = this.segmenter ? await segment(contentNormalized, lang) : contentNormalized
```

- Raw `content` is untouched (display + dense embedding — both want natural, unsegmented text).
- Because the tsvector trigger (`sql/014`), the pg_trgm GIN index (`sql/013`), and the BM25 indexes (`sql/015`) **all already read `content_normalized`**, they automatically index segmented text — symmetric with the query side. `to_tsvector('simple', "ผม อยาก เปลี่ยน …")` now yields real lexemes.
- **Net result: zero new SQL migrations for storage/indexes.** `rag_fts_config('th')` correctly stays `'simple'` (no Thai stemmer exists; segmentation, not stemming, is the fix). Re-indexing existing rows through `RagIndexer` (with a segmenter injected) is the only data step — same shape as the Arabic re-index.

### 5. Chunker integration (`Chunker`)

Two changes plus one compatibility decision.

**5a. Grapheme-safe slicing — always on, synchronous, no API change.** `splitFixedSize` and `getOverlapSuffix` must never cut between a base character and its trailing combining marks. Implement a small helper that, given a candidate cut index, advances past any following `\p{M}` (combining mark) code points so a grapheme cluster is never split. This fixes orphaned Thai vowel/tone marks and also benefits Devanagari/Arabic. (The existing surrogate-pair guard is subsumed by grapheme awareness.)

**5b. Word-aware boundaries when a `Segmenter` is configured.** Add `segmenter?: Segmenter` to `ChunkerConfig`. For a language the segmenter handles, segment the text first so the existing space-based packing and overlap align on real word boundaries instead of code-point slices. Add `["th", 1.5]` to `CHARS_PER_TOKEN` (Thai is heavily fragmented by multilingual subword tokenizers — closer to the CJK ratio than to Latin; a conservative start that risks small chunks over silent truncation, **flagged to validate** against the chosen embedder like the other entries).

**5c. Compatibility — `chunk()` becomes async-capable.** `segment()` may be async, but `ChunkingProvider.chunk` is currently sync. Resolution: widen the interface to

```ts
chunk(text: string, metadata?: Record<string, string>): Chunk[] | Promise<Chunk[]>;
```

The built-in `Chunker` returns a synchronous `Chunk[]` when **no** segmenter is configured (existing callers unchanged) and a `Promise<Chunk[]>` when a segmenter **is** configured (opt-in callers `await`). This is runtime-backward-compatible; the only type impact lands on code that opts into a segmenter. The `Chunker` is consumer-invoked (callers build `Chunk[]` and pass them to `RagIndexer.index`), so `RagIndexer` is unaffected. This is the single non-additive change in the design and is called out for sign-off.

### 6. Keyword-leg routing (`PostgresRagDatabase`)

Replace the originally-considered `segmentedLanguages: string[]` option (a second source of truth that can drift from the injected `Segmenter`) with the self-describing segmenter. `PostgresRagDatabaseOptions` gains `segmenter?: Segmenter`, used **for routing only** (the adapter never segments):

```ts
const useBigm =
  this.cjk && CJK_LANGUAGES.has(params.language) && !this.segmenter?.segmentsLanguage(params.language);
```

- A CJK language the segmenter handles falls through to the **trgm leg**, which matches the now-segmented `content_normalized`. A CJK language it doesn't handle keeps **pg_bigm** on raw `content` (unchanged default).
- **Single source of truth:** the consumer configures the `Segmenter` and its languages once and passes that same instance to `RagPipeline`, `RagIndexer`, and `PostgresRagDatabase`. Routing then follows automatically; there is no list to keep in sync. (Three injection sites, one object — consistent with `normalizer` already being passed to both pipeline and indexer.)
- **Benchmark recipe (zh):** inject a zh `Segmenter` on pipeline + indexer + db and re-index → keyword leg uses trgm-on-segmented; remove the segmenter (or have it not handle zh) → reverts to pg_bigm.

### 7. Thai supporting changes (mirror the Arabic precedent)

- **`src/language.ts`:** count Thai (U+0E00–U+0E7F); `if (thai / total > 0.5) return "th"`. Thai-dominant text mixed with Latin still resolves to `th`.
- **`src/normalize.ts`:** add a `normalizeThai` branch in `normalizeForLanguage` for base `th`: NFC + Thai-digit fold (๐–๙, U+0E50–U+0E59 → 0–9). Idempotent. Mark-reordering deferred (YAGNI). Because Thai routes through trgm-on-`content_normalized` (not bigram-on-`content`), normalized query and indexed content stay aligned — no mismatch bug.
- **`src/punctuation.ts`:** add ๆ (U+0E46 MAI YAMOK) and ฯ (U+0E2F PAIYANNOI) to `TRAILING_PUNCTUATION`.

### Migrations summary

**None.** The seam reuses the existing `content_normalized` column and its tsvector trigger / trgm / BM25 indexes. The only data operation is re-indexing Thai (and any opted-in CJK) sources through `RagIndexer` with a segmenter injected — an app-side job, same shape as the Arabic re-index. No `rag_fts_config` change (Thai → `'simple'` is correct).

### Tests (all mocked — no real DB, per project convention)

- **`language.ts`:** Thai detection (pure Thai; Thai+Latin mixed; Thai-dominant threshold).
- **`normalize.ts`:** `normalizeThai` digit folding; NFC idempotency; non-Thai untouched.
- **`punctuation.ts`:** Thai trailing marks stripped; interior marks preserved.
- **`IntlSegmenterAdapter`:** **structural assertions only** — Latin/unconfigured languages pass through unchanged; a configured language gains inter-token spaces; `segmentsLanguage` matches the configured set. **Never assert exact Thai output** (ICU-quality-dependent; would make the suite runtime-fragile across Node/Bun).
- **`RagPipeline`:** a mock `Segmenter` is applied to `lexicalQuery` but **not** to the embedding/reranker query; stop-word removal runs on segmented tokens; empty-segmentation fallback.
- **`RagIndexer`:** `content_normalized` is fold-then-segmented and threaded into `insertChunks`/`replaceSource`; raw `content` preserved.
- **`Chunker`:** with a mock **sync** segmenter, Thai chunks break on injected boundaries; grapheme-safety — a combining mark is never orphaned by `splitFixedSize`/overlap; the `th` chars-per-token ratio is applied.
- **`PostgresRagDatabase`:** `segmentsLanguage` routes a segmented CJK language to the trgm leg (not bigram); an unhandled CJK language still uses bigram; non-CJK unaffected.

## Performance considerations

- **Query-time:** one segmentation pass over a short query string. With the pure-TS `IntlSegmenterAdapter` it is effectively synchronous (microseconds); an HTTP-backed segmenter adds one network call (cache it; co-locate; set a timeout with fallback to the unsegmented string so a slow service can't stall search). The 3 legs still run in parallel — no new leg, no added latency; segmented Thai simply makes the existing legs match.
- **Index-time:** one segmentation pass per chunk, dwarfed by the embedding API call that already dominates indexing. Awaiting the pure-TS default adds nothing.
- **Storage:** `content_normalized` already exists; segmentation inserts spaces, so the column grows by roughly the word count — negligible next to the embedding vectors.
- **Chunker:** grapheme-safe slicing is an O(n) scan; word-aware chunking adds one segmentation pass per oversized segment (index-time only).

## Risks & trade-offs

- **`IntlSegmenterAdapter` is weak on loanwords (both runtimes).** Documented as a reference, not production-grade; the injectable seam is precisely the mitigation (swap in a dictionary/ML/HTTP segmenter).
- **`chunk()` sync→async-when-segmented widening** is the one non-additive change. Contained: only callers that opt into a segmenter must `await`; no-segmenter callers and `RagIndexer` are unaffected.
- **Three injection sites for one `Segmenter`** (pipeline, indexer, db). Accepted to get a single source of truth for routing; consistent with `normalizer` already being on two of them. Mis-wiring (segmenting content but not passing the segmenter to the db) is the failure mode `segmentsLanguage` is designed to prevent, but it still requires the consumer to pass the same instance to all three — documented.
- **Segmenter consistency.** `segment` and `segmentsLanguage` must agree; an impl that segments a language but reports `false` (or vice-versa) desyncs indexing from routing. Documented as an interface contract; the `IntlSegmenterAdapter` derives both from one `languages` set so it cannot drift.
- **Language-tagging dependence.** Segmentation keys off the row/query `language`; mis-tagged Thai (detected as `en`) is not segmented. Same dependence as normalization.
- **Dense leg deliberately unchanged.** Thai retrieval leans on the dense embedder + reranker; the lexical legs are the bonus that segmentation unlocks. `vectorMinScore`/embedder/reranker tuning is docs-only (below).

## Docs-only (out of core scope)

- **`vectorMinScore`:** the default `0.8` is e5-calibrated and silently kills the dense leg for better-calibrated multilingual models. Thai realistically needs a strong multilingual embedder (e.g. BGE-M3); document lowering `vectorMinScore` for Thai.
- **Reranking:** recommend enabling the cross-encoder for Thai (carries recall, mirroring the Arabic finding); bge-reranker-v2-m3 handles Thai.
- **README:** add Thai to supported languages; document the `Segmenter` seam and `segmentsLanguage` contract; the `IntlSegmenterAdapter` Node+Bun loanword caveat; the CJK opt-in benchmark recipe; and the recommended Thai config (segmenter + BGE-M3 + lowered `vectorMinScore` + rerank).

## Future extension points (documented; not built here)

The seam is language-generic. Future segmenter consumers, none built now:
- **Scriptio-continua siblings:** Lao (`lo`), Khmer (`km`), Burmese (`my`), Tibetan (`bo`) — add a detection range + inject a segmenter.
- **Vietnamese (`vi`):** Latin script, spaces separate syllables not words — the segmenter *joins* syllables into words.
- **Korean morphology:** decompose eojeol → morphemes (an alternative to the pg_bigm path, same opt-in routing as zh/ja).
- **German/Germanic/Finnic decompounding:** split compounds so sub-word queries match — same injectable seam, "re-segment" flavor.
- **CJK segmentation as the default** (replacing pg_bigm) once benchmarked to win per language.

## Approaches considered

- **A — Injectable `Segmenter` seam (chosen).** General provider mirroring `Normalizer`; Thai end-to-end + CJK opt-in; ships interface + wiring + caveated `IntlSegmenterAdapter`. Zero new deps, no SQL migration. Ceiling: out-of-the-box Thai quality is only as good as the injected segmenter (the Intl default is weak on loanwords).
- **B — Treat Thai like CJK (pg_bigm only), no segmenter.** Smaller: route Thai through the existing bigram coverage leg, lean on dense + bigram + rerank. Rejected as the *primary* design because it leaves tsvector/trgm/stop-words/synonyms dead for Thai and doesn't generalize — though it remains a valid lighter fallback for consumers who don't inject a segmenter (Thai still gets dense + rerank; the bigram index already covers all content).
- **C — Bundle a dictionary Thai segmenter in core.** Best out-of-box Thai quality, but adds a ~MB data asset and breaks the zero-runtime-dependency ethos. Rejected; offered to consumers as an injectable instead.
