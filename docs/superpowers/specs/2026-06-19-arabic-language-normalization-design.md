# Arabic language support via a general per-language normalization framework

- **Date:** 2026-06-19
- **Status:** Design approach approved; written spec pending user review
- **Area:** new `src/normalize.ts`; `src/RagPipeline.ts`, `src/RagIndexer.ts`, `src/adapters/PostgresRagDatabase.ts`, `src/adapters/fts/TsvectorFts.ts`, `src/migrate.ts`; new `sql/013_*`, `sql/014_*`, edit `sql/002_rag_documents.sql`; playground + tests
- **Chosen approach:** **A — Postgres-native / zero new services** (see "Approaches considered"). The external-service and model-swap options are documented as the **future upgrade roadmap**, not built here.

## Problem

Arabic retrieval quality is limited because **no normalization happens anywhere in the index path**, and the FTS leg does not stem Arabic:

- **FTS leg** — Arabic is absent from `rag_fts_config()` (`sql/008_postgres_stemming.sql`), so it falls through to `'simple'`: tokenize + lowercase only, **no stemming**. Postgres ships a built-in `arabic` Snowball config that is not wired up.
- **Keyword leg** — pg_trgm matches on the **raw** `content` column (`buildTrigramKeywordSql` in `PostgresRagDatabase.ts`). Trigrams over un-normalized Arabic fragment on diacritics (tashkeel), alef variants (أ/إ/آ/ا), taa-marbuta (ة/ه), alef-maqsura (ى/ي), tatweel (ـ), and Arabic-Indic digits (٣٥٠ vs 350).
- **No symmetric normalization** — `RagSearchOptions.normalizer` is applied **query-side only** (`RagPipeline.search`); `RagIndexer.index` has none. Any folding applied to queries but not stored content would *desync* the lexical legs.
- **Embedding dimension is hard-pinned** to `vector(384)` (`sql/002_rag_documents.sql`), so any future model swap (e.g. bge-m3 at 1024) is a schema rewrite rather than a config change.

### Worked example

Query **`أسعار العطور`** ("prices of the perfumes") vs. a doc containing **`سعر العِطْر ٣٥٠ ريال`**:

| Leg (today) | Behavior | Match? |
|---|---|---|
| pg_trgm on raw `content` | `أسعار` vs `سعر` barely share trigrams; diacritics in `العِطْر` inject junk trigrams; ال + broken plural عطور≠عطر | ❌ weak |
| tsvector `'simple'` | tokenize+lowercase only → `أسعار`≠`سعر`, `العطور`≠`العطر` | ❌ miss |
| Arabic-Indic `٣٥٠` vs `350` | never unified | ❌ |

Layering the fixes:
- **Orthographic normalization** (this spec): `العِطْر`→`العطر`, `٣٥٠`→`350`, alef folding. Fixes diacritic/digit/letter-form variants. (`أسعار` vs `سعر` is *morphology*, not orthography — left to the FTS stemmer.)
- **`arabic` Snowball FTS** (this spec): light-stems off ال and plural affixes → both sides reduce to `سعر`/`عطر` → **the FTS leg now matches.** Highest-leverage cheap win.
- **Clitic segmentation / lemmatization** (future, external service): the remaining ceiling — see roadmap.

## Goals

- Symmetric **orthographic normalization** (identical on index and query) for Arabic, improving the **lexical** legs.
- Enable Postgres `arabic` Snowball stemming on the FTS leg.
- Implement normalization as a **general, per-language seam** — Arabic ruleset shipped; other languages documented as future extension points, none built.
- Make the **embedding dimension configurable** to unblock a future model swap without a rewrite.
- Stay **zero-runtime-dependency / Postgres-native** (no new services).
- **Document the full upgrade roadmap** (bge-m3, external CAMeL/Farasa pipeline, Arabizi, rerankers, eval harness) with its evidence base.

## Non-goals (for this spec)

- No external NLP service (CAMeL Tools / Farasa) — deferred to the roadmap.
- No clitic segmentation, lemmatization, or morphological analysis.
- No Arabizi transliteration and no dialect normalization.
- No embedding-model swap — only make the **dimension** configurable.
- **No change to the dense-vector leg's behavior** (stays raw↔raw by default; see Design §3).
- No normalization rulesets for non-Arabic languages (the seam is built; only `ar` rules ship).
- No RRF weight retuning (the research did not settle this; left to a future eval).

## Design

### 1. Normalization framework (general seam, Arabic ruleset)

New `src/normalize.ts` exposes a per-language, **idempotent**, **language-gated** transform that conforms to the existing hook shape (`RagSearchOptions.normalizer = { normalize(text, language): string }`):

```ts
// Dispatches by language code (base subtag). Default: Unicode NFC only.
// 'ar' applies the Arabic ruleset below. Other languages → NFC passthrough.
export function normalizeForLanguage(text: string, language: string): string;
```

**Arabic ruleset** (applied only when base language is `ar`):

| Rule | Code points | Action |
|---|---|---|
| Strip tashkeel/harakat | U+064B–U+065F, U+0670 | remove |
| Strip tatweel/kashida | U+0640 | remove |
| Strip ZWNJ/ZWJ | U+200C, U+200D | remove |
| Fold alef variants | آ U+0622, أ U+0623, إ U+0625, ٱ U+0671 → ا U+0627 | map |
| Fold alef-maqsura → yeh | ى U+0649 → ي U+064A | map *(flag, default on)* |
| Fold taa-marbuta → heh | ة U+0629 → ه U+0647 | map *(flag, default on)* |
| Fold Arabic-Indic digits | U+0660–U+0669 and Eastern U+06F0–U+06F9 → 0–9 | map |
| Unicode normalize | — | NFC (all languages) |

- **Debatable rules are flags.** Alef-maqsura and taa-marbuta folding can conflate distinct words; both default **on** (standard Arabic IR practice) but are individually disableable. Hamza-carrier folding (ؤ/ئ/ء) is intentionally **not** applied by default (higher risk of meaning loss); documented as an optional rule.
- **Idempotent**: `normalize(normalize(x)) === normalize(x)` — required because both index and query may be normalized more than once across the pipeline.

### 2. SQL parallel — `rag_normalize(content, language)`

A Postgres `IMMUTABLE` function mirroring the TS logic, **parallel to the existing `rag_fts_config(lang)`** dispatch pattern:

```sql
CREATE OR REPLACE FUNCTION rag_normalize(content TEXT, lang TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN split_part(lang, '-', 1) = 'ar' THEN
      normalize(
        translate(
          regexp_replace(content, '[ً-ٟـ‌‍]', '', 'g'),  -- tashkeel, tatweel, ZWNJ/ZWJ
          'آأإٱىة٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
          'اااايه01234567890123456789'
        ),
        NFC
      )
    ELSE normalize(content, NFC)
  END;
$$ LANGUAGE sql IMMUTABLE;
```

*(Exact escape syntax finalized in the implementation plan; intent shown.)*

**TS↔SQL parity is enforced by a sync test** (same pattern as the existing `BM25_LANGUAGE_GROUPS` ↔ `sql/011` sync test noted in CLAUDE.md): a fixture corpus is normalized by both `normalizeForLanguage` (TS) and `rag_normalize` (SQL); the test asserts identical output. This is the mechanism that prevents the index/query desync that doomed the removed `content_stemmed` column (`sql/012`).

### 3. Symmetric application — which leg sees what

The critical decision. We distinguish two kinds of normalization and keep them orthogonal:

- **Orthographic normalization** (this spec): folds letter forms. Feeds the **lexical legs only** — the stored `content_normalized` column and the lexical query string. It does **not** feed the dense embedding or the reranker by default.
- **Semantic normalization** (the existing `normalizer` hook, e.g. abbreviation expansion): unchanged; still feeds everything including the embedding.

| Consumer | Text it sees | Rationale |
|---|---|---|
| **Dense vector** (index + query) | **Raw** (unchanged) | "Embed normalized vs raw" is unsettled in the literature (see open questions). Confine risk: keep dense raw↔raw. |
| **pg_trgm keyword** (index + query) | **Normalized** | Folding unambiguously helps character n-gram overlap. |
| **FTS / tsvector** (index + query) | **Normalized → `arabic` Snowball** | Orthographic fold then stem, identically on both sides. |
| **Reranker** | **Raw** natural text | Cross-encoders carry their own tokenizer/normalization. |
| **Display** (`content` returned) | **Raw** | Diacritics preserved for the user. |

**Pipeline flow change** (`RagPipeline.search`). The pipeline already passes the dense query (`embeddingStr`) and the lexical query (`query`) as separate params to `hybridSearch`, so the split is natural:

```
base      = lowercase + stripTrailingPunctuation(query)
base      = opts.normalizer?.normalize(base, lang) ?? base   // existing semantic hook (feeds all)
embedQ    = base                                             // dense leg + reranker (raw orthography)
lexicalQ  = normalizeForLanguage(base, lang)                 // NEW orthographic fold
lexicalQ  = removeStopWords(lexicalQ, stopWords)             // lexical legs only
```

- `embeddingStr = embed(embedQ)` — dense leg unchanged.
- `query = lexicalQ` — passed to the pg_trgm leg and the FTS strategy (which builds its tsquery from it).
- An optional `orthographicNormalizeDense` flag (default **off**) would route `embedQ` through `normalizeForLanguage` too, for the future eval to test — but it changes nothing by default.

### 4. `content_normalized` column + index/trigger changes

```sql
-- generated, auto-populates existing rows on ADD (table rewrite — note cost on large corpora)
ALTER TABLE rag_documents
  ADD COLUMN content_normalized TEXT
  GENERATED ALWAYS AS (rag_normalize(content, language)) STORED;
```

- **pg_trgm index** moves to the normalized column: drop `idx_rag_content_trgm` (on `content`), create the GIN `gin_trgm_ops` index on `content_normalized`.
- **Keyword leg SQL** (`buildTrigramKeywordSql`): `$2 <% content_normalized` and `word_similarity($2, content_normalized)` (query param is the already-normalized `lexicalQ`).
- **tsvector trigger** (`rag_documents_tsvector_trigger`): change to
  `to_tsvector(rag_fts_config(NEW.language), rag_normalize(NEW.content, NEW.language))`.
  A `BEFORE` trigger cannot read the generated `content_normalized`, so it calls `rag_normalize` directly — same `IMMUTABLE` function, so the result is identical. Backfill existing rows via `UPDATE`.
- **Non-Arabic is a no-op**: for languages without a ruleset, `rag_normalize` is `normalize(content, NFC)` ≈ identity, so `content_normalized ≈ content` and en/es/fr/… behavior is unchanged.
- **CJK bigram index** (`sql/009`) stays on `content` for this spec (CJK width-folding is a future ruleset; out of scope).

### 5. Enable `arabic` FTS config

New migration updates `rag_fts_config()` to add `WHEN lang IN ('ar','ar-SA','ar-EG',…) THEN 'arabic'`, plus the trigger change (§4) and a tsvector backfill for Arabic rows. Requires PostgreSQL ≥ 12 (ships the `arabic` Snowball config) and the `normalize()` builtin (≥ 13).

### 6. Configurable embedding dimension

- `migrate.ts` gains `embeddingDimensions?: number` (default **384**). After `readFileSync`, the runner substitutes a placeholder token (e.g. `__EMBEDDING_DIM__`) before `splitStatements`.
- `sql/002_rag_documents.sql`: `embedding vector(__EMBEDDING_DIM__) NOT NULL`.
- **Scope honesty:** this only affects **fresh installs** (migration 002 won't re-run on existing DBs). Changing the dimension on an existing deployment is a manual `ALTER COLUMN … TYPE vector(N)` **plus a full re-embed of the corpus** — called out in docs, not automated.

### 7. Stop-word normalization

Arabic stop-word entries are normalized through the same function at load (`CachingStopWordsLoader`) so diacritic/letter-form variants match. The query side is already normalized before `removeStopWords` (§3), so only the stored set needs normalizing; the playground seed is updated to insert normalized Arabic stop words.

### 8. Reranker (no code change)

Already injectable. Documented as **recommended-on for Arabic**: **bge-reranker-v2-m3** (MIT) or **GATE-Reranker-V1** (Apache-2.0, Arabic-specialized). **Avoid jina-reranker-v3 (CC BY-NC — non-commercial).**

### Migrations summary

| File | Gating | Contents |
|---|---|---|
| `sql/002_*` (edit) | core | `vector(__EMBEDDING_DIM__)` placeholder |
| `sql/013_normalization.sql` | core (always) | `rag_normalize()`; `content_normalized` generated column; move GIN trgm index to it |
| `sql/014_arabic_fts.sql` | core (always) | add `arabic` to `rag_fts_config()`; update tsvector trigger to wrap `rag_normalize`; backfill |

### Tests

- **Unit** (`src/normalize.ts`): each Arabic rule; idempotency; language-gating (non-Arabic untouched); the taa-marbuta/alef-maqsura flags.
- **Sync test**: TS `normalizeForLanguage` vs SQL `rag_normalize` agree on a fixture set (DB-executed, like the BM25 group test).
- **SQL-shape tests**: the pg_trgm keyword leg references `content_normalized` (not `content`).
- **Pipeline test**: dense/embedding query is the raw (non-orthographically-normalized) form; lexical query is normalized.
- **Playground**: add a few Arabic samples + queries exercising diacritics, ال+plural, and Arabic-Indic digits; confirm `keywordCandidates`/FTS hits improve. (Respects the no-real-DB-in-unit-tests convention — SQL-function behavior is validated in the playground and the sync test.)

## Risks & trade-offs

- **Folding aggressiveness.** taa-marbuta/alef-maqsura folding can merge distinct words; mitigated by per-rule flags + documentation. Hamza folding left off by default.
- **The `content_stemmed` lesson.** That column was removed (`sql/012`) because app-side stemming drifted from the FTS config. Here, index and query both route through the **same** `rag_normalize`/`normalizeForLanguage` pair, guarded by the **sync test** — symmetry is the fix.
- **Dense leg deliberately unchanged.** Keeps risk contained; whether to embed normalized text is an explicit open question for a future eval, not a guess baked in now.
- **Approach-A ceiling.** No Arabizi, dialect, or clitic segmentation. Casual/dialectal/Arabizi/code-switched queries rely on the dense embedder until the Phase-2 external service lands.
- **Language-tagging dependence.** Normalization keys off the row/query `language`; mis-tagged Arabic (e.g. detected as `en`) is not folded. Also, `detectLanguage` lumps **Persian/Urdu** into `ar`, so they would receive Arabic folding (mostly benign, but Persian yeh/kaf differ) — documented; correct handling needs both a Persian ruleset and finer detection (future).
- **Migration cost.** Adding a `STORED` generated column rewrites `rag_documents`; the tsvector backfill `UPDATE`s every Arabic row. Plan a maintenance window for large corpora.

---

## Future upgrade roadmap (documented for later; not built here)

This section captures the deep-research findings (2024–2026) and the higher-quality stacks, so a future maintainer can pick up the next levers with the evidence in hand.

### Evidence base (adversarially verified; confidence noted)

**High confidence (verified):**
- **Normalize Arabic externally before *both* index and query.** CAMeL Tools (Python, **MIT**) provides exactly the orthographic primitives in §1 *plus* morphological segmentation/lemmatization; the AraBERT preprocessor is the other standard. ([CAMeL Tools](https://aclanthology.org/2020.lrec-1.868.pdf), [repo](https://github.com/CAMeL-Lab/camel_tools), [AraBERT](https://github.com/aub-mind/arabert))
- **bge-m3 is the recommended primary embedder** — MIT, XLM-RoBERTa base, **1024-dim, 8192 context**, emits dense + sparse + ColBERT multi-vector; strong on MIRACL Arabic. **Its sparse sub-output is its weakest part for Arabic** → keep the Postgres lexical legs in RRF rather than relying on bge-m3 sparse. ([bge-m3 paper](https://arxiv.org/html/2402.03216v3))
- **A reranker is a real lift** — adding **bge-reranker-v2-m3** moved a RAGAS Arabic score ~71→74; it beat jina on MIRACL Arabic. **GATE-Reranker-V1** (NAMAA-Space, **Apache-2.0**) is an Arabic-specialized budget option. **jina-reranker-v3 is CC BY-NC (non-commercial).** ([Arabic RAG eval](https://arxiv.org/pdf/2506.06339), [GATE-Reranker-V1](https://huggingface.co/NAMAA-Space/GATE-Reranker-V1), [Arabic RAG Leaderboard](https://huggingface.co/blog/Navid-AI/arabic-rag-leaderboard))
- **Arabizi → Arabic-script transliteration is practical on CPU** (auto-supervised cycle-consistent model, ~92% on Moroccan Darija). ([dialect/Arabizi](https://arxiv.org/abs/2501.13419), [CAMeL codafication](https://github.com/CAMeL-Lab/codafication))
- **Strong *general* multilingual embedders tend to beat *small* Arabic-specific ones for retrieval** — so spend "Arabic specialization" on preprocessing + an Arabic reranker (GATE), not a bespoke small embedder. ([ArabicMTEB / Swan](https://arxiv.org/abs/2411.01192))

**Evidence caveats:** most benchmark numbers are author-self-reported / RAGAS over MSA-leaning data; they say nothing about dialectal/Arabizi/code-switched traffic. Four specific stemming/lemmatization improvement claims **did not survive verification** (sources didn't support the quoted gains) — reinforcing that the morphological strategy must be settled empirically, not assumed.

### Phase 2 — external Arabic NLP service (Approach B/C)

Stand up a Python microservice (CAMeL Tools) called **symmetrically** on index + query, plugged in via the existing `normalizer` interface (now extended to the index path by this spec):
- Orthographic normalization (superset of §1) **+ D3 clitic segmentation + lemmatization** for the lexical legs (the `أسعار→سعر`, `العطور→عطر` ceiling from the worked example).
- **Arabizi detection + transliteration** to Arabic script.
- Dialect ID / CODA normalization for Gulf/Egyptian/Levantine.
- Architectural note: feed **orthographically-normalized** text to the dense embedder but **segmented/lemmatized** text to the lexical legs (don't over-segment what the embedder sees).

### Phase 2 — embedding model swap

Migrate to **bge-m3** (1024-dim): use this spec's configurable-dimension knob, `ALTER` the column, re-embed the corpus. Consider adding bge-m3's **sparse** output as a 4th RRF leg later (low priority — it's weak for Arabic). Longer chunks become viable (8192 context) — revisit the Chunker `ar` chars-per-token ratio.

### Always-on reranker

Default the reranker on for Arabic with bge-reranker-v2-m3 or GATE-Reranker-V1.

### Eval harness (settles the open questions)

Build a small Arabic eval set (MSA + dialectal + Arabizi + code-switched queries with known-relevant docs); metrics recall@k / nDCG@10 / MRR; tooling ArabicMTEB-style + RAGAS. Use it to decide the contested knobs below before committing to them.

### Other-language normalization rulesets (extension points)

The §1 seam is language-generic; future rulesets (none built now): **Latin** accent/diacritic folding (es/fr/de/pt — Postgres FTS does not unaccent by default), **Persian/Urdu** (yeh ی↔ي, keheh ک↔ك, ZWNJ; needs finer detection than today's script-only `ar` lumping), **Hindi/Devanagari** nukta + anusvara, **CJK** full/half-width + Traditional↔Simplified.

### Open questions (unresolved by research — settle by eval)

1. Embed **normalized vs. raw** Arabic into the dense model? (Not measured. Default here: raw.)
2. Best **morphological strategy** for the lexical legs — light-stem (Snowball) vs lemmatize vs full morphology? (All quantified claims refuted; unknown.)
3. **pg_trgm vs pg_bigm vs BM25 vs tsvector** on Arabic, and how much un-normalized text degrades n-grams? (Not quantified.)
4. **Chunk size / chars-per-token / sentence segmentation** with a long-context embedder? (Unaddressed.)
5. **RRF weight tuning** for Arabic; down-weight bge-m3 sparse vs the Postgres lexical legs? (Unknown.)

## Approaches considered

- **A — Postgres-native (chosen).** Orthographic normalization (TS + SQL) + `arabic` Snowball FTS + configurable dim. No new infra. Ceiling: no segmentation/Arabizi/dialect.
- **B — External CAMeL service + bge-m3 + always-rerank.** Best quality, full spectrum; cost: a service to operate, schema migration + full re-embed, more latency. Deferred to roadmap.
- **C — Layered + measured.** Build A's primitives as configurable presets, then let an eval harness justify B's pieces. This spec is effectively **Phase 1 of C**: the cheap, high-confidence wins, with B documented as Phase 2.
