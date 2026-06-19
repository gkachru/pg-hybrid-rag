# Arabic dialectal RAG retrieval benchmark (banking + telecom)

- **Date:** 2026-06-19
- **Status:** Design approach approved; written spec pending user review
- **Area:** new `examples/benchmark/` (prep tooling + benchmark runner + pure-function units); reuses the library's public API (`RagIndexer`, `RagPipeline`, `Chunker`, `LanguageNormalizer`, `PostgresRagDatabase`, `Bm25Fts`, `ragMigrate`) and mirrors `examples/playground.ts` for DB lifecycle, embedder, and reranker wiring. No `src/` changes.
- **Chosen approach:** **FAQ-centric corpus + queries, precomputed (frozen) ground truth, optional LLM-judge slice.** Real Arabic help-center Q&A become the corpus (answers) and the authentic query seed; T&C PDFs join as distractor corpus. Ground truth is deterministic (target document id), so the benchmark run needs no LLM and is reproducible across flag combinations.

## Problem

The library has rich Arabic handling (orthographic normalization, `arabic` Snowball FTS, pg_trgm, BM25, optional VectorChord, optional cross-encoder rerank) and a multilingual playground, but **no way to measure Arabic retrieval quality** — and specifically no measurement of:

- **Dialect robustness.** Does a **Saudi** or **Moroccan Darija** phrasing of a question still retrieve the document that answers its **MSA** form? This is the headline concern for the Arabic work and is currently untested.
- **Flag trade-offs on Arabic.** Which of `bm25` vs default tsvector, `vectorchord`, and `rerank` actually help Arabic retrieval, and by how much? The playground demonstrates behavior anecdotally; it does not score it.

We want a reproducible benchmark, run like the playground (fresh DB → migrate → index → query → drop), that scores retrieval quality across the same flags and across dialects, on **real banking and telecom content**.

### Why FAQ help centers, not the T&C PDFs alone

The originally-gathered SAMA / UAE-bank / telecom PDFs are **terms-and-conditions / regulatory** documents: dense legal prose, a poor match for natural *customer* questions. Help-center **FAQ pages** are literally curated customer Q&A — they give us both (a) realistic, answerable **corpus** content and (b) **authentic customer questions** to use and to paraphrase into dialects. Feasibility was verified during design:

| Source | Domain | Extraction (via WebFetch) |
|---|---|---|
| Zain Kuwait `kw.zain.com/ar/faq` | telecom | **~130 clean Arabic Q&A pairs** |
| ABK `abk.eahli.com/.../faqs/online-banking` | banking | clean Q&A (limits, fees, password rules) |
| STC `stc.com.sa/.../faqs/...` | telecom | **JS-rendered — empty via WebFetch** (needs Playwright) |
| SAB / Boubyan / SAMA consumer-protection FAQ | banking | candidates to balance Saudi + banking |

The PDFs still earn a role as **distractor corpus** (realistic non-answer noise that makes precision meaningful), using the already-downloaded files in `datasets/PDFs/`.

## Goals

- Score Arabic **retrieval quality** (Recall@k, MRR@10, nDCG@10) on real banking + telecom content.
- Make **dialect robustness** the primary axis: every query exists in **MSA, Saudi, and Darija**, sharing one ground-truth target, so metrics slice by dialect.
- Run across the **same flags as the playground** (`--bm25`, `--vectorchord`, `--rerank`, `--cjk`) plus a `--matrix` sweep that compares a preset set of flag combinations in one invocation.
- Be **deterministic and reproducible**: the scored run consumes frozen artifacts and needs no LLM and no network (only DB + embedder, like the playground).
- Mirror the **playground lifecycle** (isolated DB created and dropped automatically) and reuse its adapter/embedder/reranker wiring.
- Keep authoring **honest**: MSA queries are real FAQ questions; only dialect variants are generated; the corpus's terms/policy nature is disclosed in the report.
- Offer an **opt-in LLM-judge** pass on a small slice as an open-ended realism sanity-check against the deterministic scores.

## Non-goals (for this spec)

- **No `src/` library changes.** This is an example/benchmark harness over the existing public API.
- **No automatic relevance for the PDFs.** PDF chunks are distractors only; no queries target them.
- **No LLM at scored-run time.** Query generation (dialect variants) is a one-time authoring step done during prep and frozen; the judge is opt-in and separate.
- **No committing of scraped/extracted corpus text** (copyright). Only the authored `queries.json` (questions + a short target snippet + ids) is committed.
- **No RRF-weight tuning or threshold search.** The benchmark measures configs; it does not optimize them.
- **No new dialects beyond MSA / Saudi / Darija**, and no Arabizi.
- **No refactor of `examples/playground.ts`.** Shared wiring is copied into a small benchmark lib; de-duplicating the playground is a documented follow-up, not part of this work.

## Design

### 1. Two phases: prep (once, authoring) vs. run (deterministic, scored)

The benchmark is split so that all non-determinism (scraping, PDF extraction, dialect-query generation) happens **once** during prep and is **frozen**, leaving a scored run that depends only on DB + embedder.

```
PREP (one-time, human/LLM-in-the-loop, by Claude during implementation)
  scrape FAQ pages ─┐
                    ├─► datasets/faqs/<provider>.jsonl   (gitignored snapshot: {doc_id, domain, provider, question, answer})
  author dialects ──┘
  extract PDFs ─────► extract_pdfs.py ─► datasets/PDFs/.cache/extracted.jsonl (gitignored)
  freeze queries ───► examples/benchmark/queries.json    (COMMITTED: variants + target_doc + target_snippet)

RUN (deterministic, scored — `bun run examples/benchmark/run.ts [flags]`)
  load queries.json + datasets/faqs/*.jsonl + extracted.jsonl
    └─ buildCorpus.ts ─► corpus.jsonl (Chunker; stable chunk ids)   [cached under datasets/, regenerated if absent]
  create isolated DB ─► ragMigrate(flags) ─► index corpus ─► per flag-combo: search every query ─► score ─► tables ─► drop DB
```

### 2. Corpus

- **Primary — FAQ answers (scored targets).** Each scraped FAQ pair becomes one corpus document whose **content is the answer text**. The question is kept in metadata only and is **not** indexed — so a query must match the answer's content (a real retrieval test), not echo the literal question. Curation favors pairs with **substantive answers** (terse "yes, visit a branch" answers are dropped, since they carry no retrievable signal).
  - *Documented alternative (not default):* index `question + answer` together (how some FAQ KBs work). Rejected as default because it makes the verbatim-MSA query trivially lexical and muddies the dialect comparison. A prep flag `--include-question-in-doc` can produce that variant if measured recall proves too low.
- **Secondary — PDF chunks (distractors).** The `datasets/PDFs/*.pdf` files are extracted, Arabic-filtered, chunked, and indexed as non-target noise so retrieval is not "pick the only plausible doc." No query targets them.
- **Tagging.** Every document carries metadata `{ source: "faq" | "pdf", domain: "banking" | "telecom", provider: <slug>, language: "ar" }` so metrics slice by source/domain/provider.
- **Indexing identity.** Each doc is indexed via `RagIndexer.index(source, doc_id, chunks, "ar")` where `source ∈ {"faq","pdf"}` and `doc_id` is stable (`faq:<provider>:<ordinal>` / `pdf:<provider>:<ordinal>`). `RagResult.sourceId` therefore returns the doc id — which is exactly the ground-truth key (§4).

### 3. PDF extraction & cleaning (`prep/extract_pdfs.py`, pypdf)

Verified feasible during design (text-based PDFs, no OCR). Steps per PDF:
1. Extract per-page text (`pypdf`).
2. **Strip recurring boilerplate** — headers/footers/licensing lines that repeat on most pages (e.g. Citibank's per-page licensing header, Etisalat's date/"Restricted" banner): detect lines recurring on ≥ ~50% of pages and drop them.
3. **Keep Arabic-dominant segments** — split into lines/paragraphs and keep those whose Arabic-script ratio exceeds a threshold (discards English from bilingual docs; keeps everything from Arabic-only docs like Citibank).
4. Emit `extracted.jsonl`: `{ doc_id, provider, domain, title, text }` (one record per PDF), to a **gitignored cache**.

Python is used only here (pypdf is installed; the library is otherwise Bun/TS). Output is plain JSONL consumed by TS.

### 4. Queries & ground truth (`queries.json`, committed)

For each selected FAQ pair, the query set has three dialect **variants** that share one target:

- **`msa`** — the **real FAQ question, verbatim** (authentic; no generation).
- **`saudi`** — a Saudi-dialect rewrite (authored by Claude during prep; the ArBanking77 Saudi split is the style/lexicon reference).
- **`darija`** — a Moroccan Darija rewrite (authored; the DarijaBanking dataset is the reference).
- **`target_doc`** — the FAQ pair's doc id. **Ground truth is the target document id**, not a chunk index: a result is relevant iff `RagResult.sourceId === target_doc`. This is stable across chunk-boundary drift (the original concern behind snippet-binding) and needs no fuzzy matching, because each FAQ answer is its own document with a stable id.
- **`target_snippet`** — a short verbatim substring of the answer, stored for **human readability and a load-time validation check** (warn if no indexed chunk of `target_doc` contains it — catches a broken/empty extraction), not for scoring.

`queries.json` schema:

```jsonc
{
  "version": 1,
  "queries": [
    {
      "id": "q0001",
      "domain": "telecom",
      "provider": "zain_kw",
      "target_doc": "faq:zain_kw:0042",
      "target_snippet": "صلاحية الباقات هي 30 يوماً من تاريخ تفعيلها",
      "variants": {
        "msa":    "ما هي مدة صلاحية الباقات التي يتم تفعيلها؟",
        "saudi":  "كم تجلس الباقة شغّالة من يوم ما أفعّلها؟",
        "darija": "شحال كتبقا الباقة خدّامة من نهار نفعّلها؟"
      }
    }
  ]
}
```

Scale target: **~60–100 FAQ pairs**, balanced across banking/telecom, × 3 dialects = **~180–300 scored queries**. A query whose `target_doc` is absent from the built corpus (e.g. its source FAQ wasn't snapshotted) is reported as **unresolved** and excluded from metrics — never silently scored as a miss.

### 5. Corpus build (`buildCorpus.ts`)

Reads `datasets/faqs/*.jsonl` (FAQ answers) + `extracted.jsonl` (PDF text), runs each document through the library's **`Chunker`** (the real one, so the benchmark exercises it), and writes `corpus.jsonl`:

```jsonc
{"chunk_id":"faq:zain_kw:0042#0","doc_id":"faq:zain_kw:0042","source":"faq","domain":"telecom","provider":"zain_kw","language":"ar","content":"…answer chunk…"}
{"chunk_id":"pdf:adib:0007#2","doc_id":"pdf:adib:0007","source":"pdf","domain":"banking","provider":"adib","language":"ar","content":"…pdf chunk…"}
```

`corpus.jsonl` is **cached under `datasets/` (gitignored)** and regenerated if absent. Chunking is deterministic, so ids are stable run-to-run.

### 6. Runner (`run.ts`) — playground-style lifecycle

Mirrors `examples/playground.ts`:
1. Parse flags. Create isolated DB (`CREATE DATABASE`), drop on exit/crash (same bounded-timeout `sql.end` cleanup).
2. `ragMigrate(..., { vectorchord, bm25, cjk })` per the active flags.
3. Build/load `corpus.jsonl`; index every chunk via `RagIndexer` (`Bm25Fts` injected when `--bm25`, `cjk:true` when `--cjk`), tagging metadata from §2.
4. For each flag-combo in scope: run **every query variant** through `RagPipeline.search(q, { topK, language: "ar", rerank })`, record the ranked `sourceId`s.
5. Compute metrics (§7), print tables (§8), write `results.json`.
6. Drop the DB.

Reuses the playground's postgres→`SqlClient`/`TransactionProvider` reserving adapter, `OpenAiCompatibleEmbedder`, `LanguageNormalizer`, and the TEI `/rerank` reranker factory. These are copied into `examples/benchmark/lib/infra.ts` (playground left untouched; dedup is a follow-up).

### 7. Metrics (`metrics.ts`, pure functions)

Per query variant, given the ranked list of result `sourceId`s and the `target_doc`:

- **Recall@k** (k = 1, 3, 5, 10): 1 if `target_doc` appears in the top-k result doc ids, else 0 (binary; one relevant doc per query).
- **MRR@10**: reciprocal rank of the first result whose doc id is `target_doc` (0 if none in top-10).
- **nDCG@10**: binary-relevance nDCG (single relevant doc → IDCG = 1).

Aggregations (mean over queries) are sliced by **dialect**, **domain**, **provider**, and **source**, for **each flag-combo**. All metric functions are pure (ranked-ids + target → number), unit-tested without a DB.

### 8. Flags, matrix & output

- **Single-config run:** `bun run examples/benchmark/run.ts --bm25 --vectorchord --rerank --cjk` — runs one configuration; flags match the playground exactly.
- **`--matrix`:** sweeps a preset set, each on its **own freshly-migrated DB** (VectorChord/BM25 are migration-gated, so configs can't share a schema):
  1. `baseline` — default tsvector FTS
  2. `+bm25`
  3. `+vectorchord`
  4. `+rerank`
  5. `all` — bm25 + vectorchord + rerank
- **Embedding cache.** The matrix re-indexes the same corpus N times; an embedding cache keyed by chunk-text hash embeds each unique chunk **once** across the whole sweep (kept in-process; optional on-disk cache under the gitignored cache dir). The embedder is wrapped so each config's indexing pulls cache hits.
- **Other params:** `--topk` (default 10), `--limit-queries N` (smoke runs), `--judge` (§9).
- **Output:** for each flag-combo, a metrics table; then a **comparison table** (flag-combo × metric) and a **per-dialect / per-domain breakdown**; printed to console and written to `examples/benchmark/results/<timestamp>.json` (gitignored). `Date.now()` is fine here (this is a normal script, not a workflow). A header line discloses corpus composition (counts by source/domain/provider) and the terms/policy nature of the content.

### 9. Optional LLM-judge slice (`judge.ts`, opt-in)

`--judge` runs an LLM-as-judge pass over a small slice (~10–20 queries) using an OpenAI-compatible **chat** endpoint configured by env (`JUDGE_BASE_URL`, `JUDGE_API_KEY`, `JUDGE_MODEL`). For each sampled query it asks the model to rate each top-k result's relevance (0/1/2) and reports **precision@k** alongside the deterministic scores as a realism sanity-check. If the env is missing, it warns and skips (does not fail the run). The judge never affects the deterministic metrics.

### 10. Files

```
examples/benchmark/
  README.md               # prereqs (DB, embedder, optional reranker/judge), how to prep + run
  prep/
    extract_pdfs.py        # pypdf: extract + boilerplate strip + Arabic-script filter -> extracted.jsonl
    scrape-notes.md        # which FAQ URLs were used + how (WebFetch/Playwright); provenance
  buildCorpus.ts           # faqs/*.jsonl + extracted.jsonl --(Chunker)--> corpus.jsonl (stable ids)
  queries.json             # COMMITTED: dialect variants + target_doc + target_snippet
  qrels.ts                 # load queries; resolve target_doc -> relevant set; validate snippet; flag unresolved
  metrics.ts               # pure: Recall@k, MRR@10, nDCG@10 + slicing/aggregation
  judge.ts                 # optional LLM-as-judge (chat endpoint), opt-in
  lib/infra.ts             # postgres adapter, embedder, reranker, embedding cache (copied from playground)
  run.ts                   # orchestrator: DB lifecycle, indexing, query loop, reporting, matrix
tests/
  benchmark-metrics.test.ts # Recall/MRR/nDCG on synthetic rankings
  benchmark-qrels.test.ts    # target_doc resolution + unresolved handling + snippet validation
  benchmark-extract.test.ts  # (TS-side) boilerplate-strip + Arabic-script-filter helpers on fixtures
```

### 11. Reproducibility & data handling

- **Committed:** `queries.json` (authored), the prep/runner code, the unit tests, the README, and `scrape-notes.md` (provenance: source URLs + scrape method).
- **Gitignored (local, regenerable):** `datasets/faqs/*.jsonl` (scraped FAQ snapshots), `datasets/PDFs/` (already gitignored), `datasets/PDFs/.cache/extracted.jsonl`, `corpus.jsonl`, and `examples/benchmark/results/`. `datasets/` is already in `.gitignore`; the spec adds `examples/benchmark/results/` (and `*.cache`) as needed.
- A second machine reproduces the **scored run** by re-running prep (re-scrape + re-extract from the user's local PDFs) to rebuild the gitignored corpus, then `run.ts`. The committed `queries.json` pins the queries and ground-truth doc ids regardless.

## Testing

Per the repo convention (mock-only, no real DB in `bun test`):

- **`metrics.ts`** — Recall@k / MRR@10 / nDCG@10 over hand-built ranked-id lists with known answers (target at rank 1 / mid / absent; k boundaries).
- **`qrels.ts`** — `target_doc` resolves to the right relevant set; an absent target is reported **unresolved** (not a miss); snippet-validation warns but doesn't fail.
- **Extraction helpers** — the TS-side Arabic-script-ratio filter and recurring-boilerplate detector on small fixtures (the Python `extract_pdfs.py` is exercised manually during prep; its TS-side cleaning helpers are unit-tested).
- **`run.ts`** is integration-only (needs DB + embedder), like the playground — not in `bun test`.

## Performance considerations

- **Indexing dominates.** Embedding the corpus is the main cost (a few hundred chunks). The `--matrix` sweep would otherwise re-embed N×; the chunk-text-hash **embedding cache** collapses that to one embed per unique chunk. DB re-index per config is unavoidable (schema differs by flag) but cheap relative to embedding.
- **Search is the playground's 3-leg parallel path**, unchanged; per-query latency is the library's normal cost. Reranking (when on) is the dominant per-query cost and is gated by `topK`/`candidateMultiplier`.
- **Prep is one-time** and off the scored path; scraping/extraction/generation cost is paid once and frozen.

## Risks & trade-offs

- **Scraping fragility & coverage.** Some help centers are JS-rendered (STC) or refuse connections; WebFetch handles server-rendered pages, Playwright is the fallback for JS ones. Mitigation: snapshot whatever scrapes cleanly to `datasets/faqs/` and pin it; the committed `queries.json` only references what was snapshotted. `scrape-notes.md` records provenance.
- **Generated-dialect authenticity.** Saudi/Darija variants are authored by Claude (seeded by the real datasets), so they carry an authenticity ceiling vs. genuine dialectal queries. MSA is verbatim-real, bounding the risk to the two dialect slices; the datasets ground the phrasing.
- **Single relevant doc per query (conservative recall).** If another corpus doc also answers a query, retrieving it scores as a miss. The bias is constant across flag-combos, so comparisons remain valid; reported as a known floor.
- **Terse-answer retrievability.** Answer-only documents can be too thin to retrieve. Mitigation: curation drops terse pairs; the `--include-question-in-doc` variant exists if recall is implausibly low.
- **Domain mismatch (UAE/KW content vs. SA dialects).** The FAQ providers and the dialect datasets don't perfectly geo-align. Acceptable: the benchmark tests *phrasing* robustness over banking/telecom *content*, not regional product accuracy; the report discloses provenance.
- **Copyright.** Extracted/scraped text is not committed; only authored queries + short snippets are. Content stays in the gitignored `datasets/`.
- **PDF extraction noise.** Bilingual two-column merges and residual boilerplate can pollute distractor chunks. As distractors this is tolerable (it only makes retrieval marginally harder); the Arabic-script filter + boilerplate strip bound it.

## Approaches considered

These were settled during brainstorming (recorded here for provenance):

- **Scoreable task.** *PDF document RAG with dialectal queries* (chosen, then refined to FAQ-centric) over a pure intent-classification benchmark — the library is a retriever, so we score retrieval quality, not intent accuracy.
- **Ground truth.** *Precomputed (frozen) + optional LLM-judge slice* (chosen) over LLM-judge-only. Precomputed is deterministic, fast, and CI-friendly — essential for trustworthy flag-vs-flag deltas; the judge adds an opt-in realism check. (Binding refined from *snippet-match* to *target-doc-id* once the corpus became discrete FAQ documents — strictly simpler and equally drift-proof; the snippet is retained as a validation aid.)
- **Corpus.** *FAQ answers (primary) + PDF distractors (secondary)* (chosen) over PDF-only — FAQ Q&A are genuine customer questions and answerable content; T&C PDFs are policy prose ill-suited to customer queries but valuable as distractors.
- **Dialects.** *MSA + Saudi + Darija* (chosen) over all six ArBanking77/Darija dialects — a focused, buildable, authentic trio (formal baseline + Gulf + maximally-divergent).
- **PDF access.** SAMA Arabic-only PDFs dropped (bot-protected host; user couldn't download); benchmark uses the reachable UAE bank/telecom T&C PDFs already in `datasets/PDFs/` plus the SAMA AML PDF.
