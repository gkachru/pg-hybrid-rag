# Design: Thai word-segmentation RAG benchmark

**Date:** 2026-06-24
**Status:** Approved — ready to turn into an implementation plan.
**Scope:** A new `examples/benchmark-thai/` benchmark that mirrors the Arabic dialectal
benchmark (`examples/benchmark/`) but whose headline axis is **Thai word-segmentation quality**.
It scrapes Thai telecom + banking + insurance help-center FAQs (scored targets) plus policy /
T&C documents (in-domain distractors), runs queries in three register variants through
`RagPipeline.search`, and scores Recall@k / MRR@10 / nDCG@10 — comparing the segmenter arms
`none` vs `IntlSegmenterAdapter` (ICU) vs `HttpThaiSegmenter` (attacut, the just-landed sidecar).

> Lineage: this benchmark exists to make the **attacut Thai segmenter sidecar** (merged to
> `main`; see `docs/superpowers/specs/2026-06-24-production-thai-segmenter-design.md`) *measurable*.
> The Arabic benchmark proved dialect robustness; this proves segmentation quality. It reuses the
> Arabic benchmark's lifecycle, metrics, infinity (BGE-M3 + bge-reranker-v2-m3) infra, and
> isolated-DB pattern verbatim where possible.

---

## 1. Why this exists (the headline axis)

The Arabic benchmark's headline was **dialect robustness** — the axis the dialect/normalizer work
made measurable. The natural Thai analog, and what makes the just-landed attacut sidecar earn its
keep, is **segmentation quality on out-of-vocabulary terms** (loanwords / transliterated English /
brand & product names). Thai writes no inter-word spaces, so the lexical legs (pg_trgm keyword +
tsvector FTS) depend entirely on a segmenter inserting word boundaries. The segmenter touches the
**lexical legs only** — the dense vector embedding and the cross-encoder reranker always see
natural (unsegmented) text — so this benchmark can isolate the segmentation axis cleanly.

The primary experiment is a **segmenter A/B/C**, holding the corpus, queries, embedder, and DB
fixed and swapping only the injected `Segmenter`:

| Arm | Segmenter injected | Effect on `content_normalized` + lexical query |
|---|---|---|
| `none` | (none) | unsegmented Thai → FTS `'simple'` sees ~one giant token (FTS leg ≈ dead); pg_trgm survives on character trigrams |
| `intl` | `IntlSegmenterAdapter` (stdlib `Intl.Segmenter`, ICU dictionary) | dictionary word tokens — **shreds** transliterated / OOV / brand terms |
| `attacut` | `HttpThaiSegmenter` (neural, PyTorch via PyThaiNLP) | neural word tokens — **learns** OOV / loanword boundaries |

**Thesis to demonstrate:** `attacut` ≥ `intl` > `none` on the lexical legs, and **the gap widens on
loanword-heavy queries**, while the segmenter-blind dense + rerank legs (the control) do *not*
move. Confirmed realizable by reading `src/`:
- `RagIndexer.index` applies `segmenter.segment()` to `content_normalized` after the normalizer
  (`src/RagIndexer.ts:79-81`).
- `RagPipeline.search` applies `segmenter.segment()` to the lexical query only; the natural query
  (embedding + reranker) stays unsegmented (`src/RagPipeline.ts:174-179`).

So the three arms are produced purely by constructing `RagIndexer` + `RagPipeline` (+ `Chunker`)
with a different `segmenter` (or none).

---

## 2. Architecture & components

A **new self-contained directory** `examples/benchmark-thai/`, mirroring `examples/benchmark/`.

**Why a new directory (not generalizing the Arabic one):** matches the repo's stated "intentional
duplication — no shared module" stance (`examples/benchmark/infra.ts:8`), keeps the Arabic
benchmark untouched, and the two diverge enough (register variants vs dialects, the segmenter
axis, Thai cleaning, no CJK) that sharing would couple them for little gain. Alternative considered
— parameterize `examples/benchmark/` by language — rejected.

```
examples/benchmark-thai/
  README.md            — prerequisites, prep, running, scoring, output (mirrors Arabic README)
  scrape-notes.md      — provenance of every FAQ/PDF scrape (sources, dates, method, counts)
  scrape/              — Playwright-assisted scraper notes/scripts → gitignored JSONL snapshots
  extract_pdfs.py      — pypdf raw text extraction for policy/T&C PDFs (Thai)
  cleanThai.ts         — boilerplate strip + Thai-script filter (keeps Latin/digit brand tokens)
  buildCorpus.ts       — chunk FAQ answers (targets) + cleaned PDF text (distractors)
  types.ts             — Register/Domain/CorpusChunk/BenchmarkQuery (Thai variant)
  qrels.ts             — load + resolve queries, snippet presence (≈ Arabic, verbatim)
  metrics.ts           — Recall@k / MRR@10 / nDCG@10 + sliceBy (≈ Arabic, verbatim)
  judge.ts             — optional LLM-judge pass (≈ Arabic, verbatim)
  infra.ts             — DB lifecycle, adapter, embedder, reranker, logger, segmenter factory
  run.ts               — orchestrator: segmenter sweep × config matrix
  queries.json         — authored query set (3 register variants per FAQ) [COMMITTED]
  results/             — timestamped result JSON [GITIGNORED]
```

`metrics.ts`, `qrels.ts`, `judge.ts` are near-verbatim copies of the Arabic files. The genuinely
new work is: the scrape, `cleanThai.ts`, the register-variant `types.ts` + `queries.json`, the
**segmenter factory** in `infra.ts`, and the **segmenter axis** in `run.ts`.

### Data flow (per config arm)

Create isolated DB → migrate (vectorchord/bm25 per config; **no cjk**) → seed Thai stop words →
build segmenter for the arm → index the pre-built corpus (`RagIndexer` with the arm's segmenter;
chunk text is arm-independent, see §3.3) → run every (query × register) through
`RagPipeline.search` (same segmenter) → score → drop DB. Identical lifecycle to `examples/benchmark/run.ts` (bounded `sql.end` cleanup on success
and error; top-level crash handler drops any created DB).

---

## 3. Data plane — scrape, distractors, corpus build

### 3.1 FAQ scrape (scored targets) — assisted, one-time, gitignored

Drive the **Playwright MCP** to render the JS-SPA / anti-bot Thai help centers and extract Q/A
pairs to `datasets/faqs-th/<provider>.jsonl`. Target scope (**broad: 3 providers × 3 domains**):

| Domain | Candidate providers |
|---|---|
| telecom | AIS, True, dtac |
| banking | SCB, Kasikorn (KBank), Bangkok Bank (or Krungsri) |
| insurance | AIA Thailand, Muang Thai Life, FWD (or Thai Life) |

Target ~250–350 FAQ pairs total. **Yield is uncertain** (the research found these are largely
JS-rendered SPAs, and some return 403 to automated fetch). Mitigation: providers that won't render
via Playwright are dropped and the drop is documented in `scrape-notes.md`; the scope is a target,
not a guarantee. Provenance discipline mirrors Arabic: **only `queries.json` + `scrape-notes.md`
are committed**; the raw FAQ snapshots are gitignored (no open redistribution license).

`FaqRecord`: `{ doc_id: "faq:<provider>:<ordinal>", domain, provider, question, answer }`.

### 3.2 Policy / T&C distractors

Download policy / terms-and-conditions / product PDFs from the same providers to
`datasets/PDFs-th/`. `extract_pdfs.py` (pypdf) extracts raw per-page text →
`datasets/benchmark-cache-th/extracted.jsonl`. `cleanThai.ts` strips boilerplate and filters to
Thai script **while keeping Latin-script and digit brand tokens** (5G, SIM, OTP, eSIM) at
corpus-build time. Indexed as noise; **no query targets a PDF** — their presence makes precision
meaningful (same role as the Arabic SAMA/UAE PDFs). ~10–15 PDFs.

`ExtractedPdf`: `{ doc_id: "pdf:<provider>:<ordinal>", provider, domain, title, pages }`.

### 3.3 Corpus build (`buildCorpus.ts`)

Uses the library `Chunker` with `{ tokenLimit: 512, overlap: 75 }`:
- **FAQ answers** (scored targets) and **cleaned PDF text** (distractors) → `CorpusChunk`s.
- Chunking uses **plain `Chunker.chunk()`** (no segmenter), so the chunk text is **identical
  across all three segmenter arms**. This is a deliberate methodological choice, not just a cost
  saving: the only thing that may vary per arm is `content_normalized` (the segmented lexical
  representation, applied at index time by `RagIndexer`). Chunk text — and therefore the dense
  embeddings and the reranker input — stay **byte-identical across arms**, so the dense + rerank
  legs are a true control that cannot move. (Production indexing uses `chunkSegmented` for
  word-aware boundaries; the benchmark intentionally fixes boundaries to isolate the lexical-leg
  effect of the segmenter. A per-arm `chunkSegmented` build would change chunk boundaries → change
  embeddings → confound the control, and would also defeat the shared embedding cache.)
- Cached once to `datasets/benchmark-cache-th/corpus.jsonl`; delete to rebuild. One cache serves
  all arms.

`CorpusChunk`: `{ chunk_id: "<doc_id>#<index>", doc_id, source: "faq"|"pdf", domain, provider,
language: "th", content }`.

---

## 4. Query model & metrics

### 4.1 `queries.json` — 3 register variants per FAQ

```jsonc
{
  "version": 1,
  "queries": [
    {
      "id": "q0007",
      "domain": "telecom",
      "provider": "ais",
      "target_doc": "faq:ais:12",
      "target_snippet": "<Thai answer snippet, validated present in the target doc>",
      "variants": {
        "written":    "จะเปิดใช้บริการโรมมิ่งระหว่างประเทศได้อย่างไร",
        "spoken":     "เปิดโรมมิ่งต่างประเทศยังไง",
        "codeswitch": "เปิด international roaming ยังไง"
      }
    }
  ]
}
```

- `Register = "written" | "spoken" | "codeswitch"` replaces the Arabic `Dialect`.
- All three variants share one `target_doc`; the runner flattens each query into one task per
  present variant (exactly like Arabic's query × dialect flatten in `run.ts`).
- The written/spoken Thai variants naturally carry **Thai-script transliterations** (โรมมิ่ง,
  แพ็กเกจ, อินเทอร์เน็ต, ดาต้า, ซิม) — the glued OOV tokens an ICU dictionary shreds but attacut
  learns. `codeswitch` adds the mixed-script (already space-delimited) case.

### 4.2 Metrics & slices

Metrics unchanged from the Arabic `metrics.ts`: **Recall@1/3/5/10, MRR@10, nDCG@10**. Ground truth:
a result is relevant iff its source doc matches the query's `target_doc`. Slices:
- **overall**
- **by register** (written / spoken / codeswitch)
- **by domain** (telecom / banking / insurance)
- **by segmenter** (none / intl / attacut) — the headline cross-config comparison
- **loanword cross-cut** (derived): auto-tag each variant by Thai-script-transliteration density
  (a small heuristic — presence of known transliterated tokens and/or Latin runs), then report the
  segmenter delta on the loanword-heavy slice vs the rest. This is what surfaces "attacut's lift is
  concentrated on OOV-heavy queries."

Snippet validation (warn if a `target_snippet` is absent from its target doc's chunks) carries over
from the Arabic runner.

---

## 5. The runner — segmenter sweep × config matrix

`run.ts` adds a **segmenter axis** orthogonal to the Arabic config matrix.

- **`--seg-matrix` (the headline preset):** `{none, intl, attacut} × {baseline, +rerank}` = 6 runs.
  Mirrors the Arabic `LEAN_MATRIX` philosophy of running only the configs that distinguish the axis
  of interest. The `+rerank` rows show whether the segmenter-blind cross-encoder can partially
  compensate for a worse segmenter.
- **`--matrix` (orthogonal extension question):** the Arabic 5-config matrix — baseline / +bm25 /
  +vectorchord / +rerank / all — with the **segmenter fixed to attacut** (production default).
  Answers "do bm25 / vectorchord / rerank add value on Thai?" independent of the segmenter axis.
- **Single custom config:** flags `--bm25 --vectorchord --rerank` + `--segmenter none|intl|attacut`
  (default `attacut`) for ad-hoc runs.
- **`--cjk` is dropped** — Thai is not CJK; the segmenter + pg_trgm is the intended Thai keyword
  path (pg_bigm is for Chinese/Japanese/Korean). The benchmark never enables it.

Other flags carried over verbatim: `--topk N`, `--limit-queries N` (smoke), `--judge`.

`infra.ts` gains a **segmenter factory**: `none` → undefined; `intl` → `IntlSegmenterAdapter({
languages: ["th"] })`; `attacut` → `HttpThaiSegmenter({ baseUrl: THAI_SEGMENTER_URL })` (the
adapter already exists in `examples/nestjs-thai-segmenter.ts` — prefer importing it via
`../nestjs-thai-segmenter.ts` over copying). Each arm injects the **same segmenter instance** into
`RagIndexer` + `db` + `RagPipeline`. The `Chunker` is **not** given a segmenter — the corpus is
pre-built once with plain `chunk()` (see §3.3), so chunk text is arm-independent.

Thai stop-word seeding (`seedThaiStopWords`) mirrors `seedArabicStopWords` with a small Thai list
(e.g. ที่ และ การ ของ ใน เป็น มี ได้ ว่า จะ ไม่ ให้ …).

---

## 6. Infra reuse (no new model infra)

- **Embedder:** **BGE-M3** (1024-dim; strong multilingual incl. Thai) via the existing
  `examples/benchmark/docker-compose.infinity.yml` (already serves it). `EMBEDDING_DIM=1024`;
  **`VECTOR_MIN_SCORE≈0.4`** — the library default 0.8 is e5-calibrated and would silently zero the
  dense leg for BGE-M3 (per the project's vectorMinScore / BGE-M3 findings).
- **Reranker:** **bge-reranker-v2-m3**, already on :7997; the same Infinity `/rerank` adapter
  pattern as the Arabic `infra.ts`.
- **Segmenter sidecar:** the just-landed `examples/thai-segmenter/` attacut service (CPU default;
  documented GPU opt-in). The benchmark's compose / run instructions bring up `db` + `infinity` +
  `thai-segmenter`.
- **FTS:** Thai → `rag_fts_config()` returns `'simple'` (correct — Postgres ships no Thai stemmer).
  **No SQL migration change.** The segmenter is precisely what makes `'simple'` FTS work for Thai
  (word tokens via inserted spaces) — itself part of the story the benchmark tells.

---

## 7. Verification

`examples/` is excluded from `tsc --noEmit` and the mocked test suite, so the gate is:
- **Lint + read:** `bun run lint` clean + careful read (repo convention for examples).
- **End-to-end smoke:** with `db` + `infinity` (BGE-M3 + reranker) + `thai-segmenter` up, run
  `--seg-matrix --limit-queries N` against a small built corpus and confirm the **expected segmenter
  ordering** (`attacut` ≥ `intl` > `none` on the lexical-leg-sensitive configs) and that the dense
  control doesn't move.
- **Honesty about environment limits:** the results + notes state explicitly which providers were
  successfully scraped vs dropped, what was actually run vs. what needs the user's infra, rather
  than claiming an unrun result. Scrape yield is reported, not assumed.

---

## 8. Risks (called out)

1. **Scrape yield** — SPA/403 sites may resist Playwright; mitigation: drop non-yielding providers,
   document in `scrape-notes.md`, lean on whoever renders. The benchmark must run on whatever subset
   yields (degrade scope gracefully).
2. **Loanword signal strength** — if scraped answers are thin, the loanword slice may be small; the
   auto-tag cross-cut + register variants mitigate by construction, but the headline delta size
   depends on real OOV density in the yielded corpus.
3. **Indexing cost** — broad scope (~250–350 pairs + PDFs) × multiple config arms on one GPU; the
   **shared embedding cache** (across configs, like the Arabic `withEmbeddingCache`) keeps each
   unique chunk/query embedding once total. The segmenter arms share natural chunk text, so they
   share embeddings too — only the lexical (DB-side) representation differs.
4. **`none`-arm FTS** — with no segmenter, Thai `content_normalized` is one big token under
   `'simple'`; this is the *intended* degraded baseline, not a bug.

---

## 9. Out of scope / non-goals

- No change to `examples/benchmark/` (Arabic), `examples/playground.ts`, or the `examples/
  thai-segmenter/` sidecar internals.
- No change to `src/` or `tests/`. If a real library bug surfaces while building the benchmark,
  report it rather than fixing it here.
- No new SQL migration (Thai uses the existing `'simple'` FTS fallback).
- Not a transformer (WangchanBERTa-class) segmenter arm — attacut is the production segmenter under
  test; a heavier transformer arm is a possible future extension.
- Not redistributing scraped FAQ/PDF content — snapshots are gitignored, only `queries.json` +
  `scrape-notes.md` are committed.
- No regional Thai dialect axis (Isan/Northern/Southern) — the variant axis is register, not
  geography; dialect data is scarce and out of scope.

---

## 10. File-change summary

| File | Change |
|---|---|
| `examples/benchmark-thai/run.ts` | **new** — orchestrator with segmenter sweep × config matrix |
| `examples/benchmark-thai/infra.ts` | **new** — DB/adapter/embedder/reranker/logger + **segmenter factory** |
| `examples/benchmark-thai/types.ts` | **new** — `Register`/`Domain`/`CorpusChunk`/`BenchmarkQuery` |
| `examples/benchmark-thai/buildCorpus.ts` | **new** — chunk FAQ answers + cleaned PDF text |
| `examples/benchmark-thai/cleanThai.ts` | **new** — boilerplate strip + Thai-script filter (keeps brand tokens) |
| `examples/benchmark-thai/extract_pdfs.py` | **new** — pypdf raw extraction for Thai PDFs |
| `examples/benchmark-thai/qrels.ts` | **new** — ≈ Arabic verbatim |
| `examples/benchmark-thai/metrics.ts` | **new** — ≈ Arabic verbatim + loanword cross-cut helper |
| `examples/benchmark-thai/judge.ts` | **new** — optional LLM judge, ≈ Arabic verbatim |
| `examples/benchmark-thai/queries.json` | **new [COMMITTED]** — authored 3-register query set |
| `examples/benchmark-thai/scrape-notes.md` | **new [COMMITTED]** — scrape provenance |
| `examples/benchmark-thai/scrape/` | **new** — Playwright-assisted scraper notes/scripts |
| `examples/benchmark-thai/README.md` | **new** — prereqs / prep / running / scoring / output |
| `examples/benchmark-thai/results/` | **new [GITIGNORED]** — timestamped result JSON |
| `.gitignore` | add `datasets/faqs-th/`, `datasets/PDFs-th/`, `datasets/benchmark-cache-th/`, `examples/benchmark-thai/results/` |
| `datasets/faqs-th/*.jsonl` | **new [GITIGNORED]** — scraped FAQ snapshots (local only) |
| `datasets/PDFs-th/*.pdf` | **new [GITIGNORED]** — policy/T&C distractors (local only) |
