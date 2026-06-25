# Thai RAG Benchmarking Log

A consolidated record of the benchmark experiments run against `pg-hybrid-rag` on a bespoke Thai
FAQ corpus. The original headline axis was **word-segmentation quality** (does a Thai segmenter
help the keyword leg?); the answer turned out to be a clean negative, and the more useful findings
are about the **embedder** and the **keyword-leg threshold**. Experiments are reproducible from
`examples/benchmark-thai/run.ts` plus the env knobs / flags listed in each section.

> **Caveat on absolute numbers.** The corpus is bespoke (telecom + banking + insurance FAQ + 2
> PDFs), so only *relative* positioning is meaningful — these nDCG values are not comparable to
> public leaderboards (MIRACL etc.). Treat every recommendation as "validated on this corpus +
> embedder," not universal.

> **Branch note.** The benchmark code merged to `main` at `0f3c1eb` (segmentation arms, `--lexical-only`,
> bigram). Experiments 3–5 below use `--keyword-min-score` and `--queries` (+ the low-overlap query
> set), which currently live on the unmerged branches `feat/thai-benchmark-keyword-threshold` and
> `feat/thai-benchmark-lowoverlap-queries`. Marked inline where relevant.

---

## Setup

- **Corpus:** 179 FAQ docs (AIS telecom 46, SCB banking 105, AIA insurance 20, Muang Thai insurance
  8) + 2 AIS T&C PDFs → **329 chunks**, Thai. Two variants (mirror the Arabic harness):
  - `corpus.jsonl` — **answer-only** (indexed content = FAQ answer). The realistic-floor task; used
    for every experiment here.
  - `corpus-withq.jsonl` — **question + answer**. Built but the Thai q+a A/B was not run (see Open
    follow-ups).
  Both cached under `datasets/benchmark-cache-th/` (gitignored, local-only); `run.ts` auto-builds.
- **Queries:** 25 queries × 3 **registers** (written / spoken / codeswitch) = **75 search tasks**;
  each query is one curated FAQ with a single target doc + target snippet. A second 25-query
  **low-overlap** set (`queries-lowoverlap.json`, same targets, variants paraphrased to *avoid*
  the answer vocabulary) removes the authored-query confound — see Experiment 4 (branch-only).
- **Metrics:** R@1 / R@3 / R@5 / R@10, MRR@10, nDCG@10. Reported all-register ("custom"/"all") and
  per slice (register × domain × loanword-heavy).
- **Default models:** `BAAI/bge-m3` embedder (1024d) + `BAAI/bge-reranker-v2-m3`, fp16 on GPU via
  infinity on `:7997`. `VECTOR_MIN_SCORE=0` (the 0.8 default is e5-calibrated — see the Arabic log
  Experiment 1 and Experiment 6 below).
- **Harness:** `run.ts` creates an isolated DB per config, migrates, seeds Thai stop words, indexes
  the corpus, runs every (query × register) through `RagPipeline.search`, scores, drops the DB. The
  dense + (optional) rerank legs are a fixed control; the segmenter is injected into db + indexer +
  pipeline only (never the Chunker — chunk text is arm-independent).

### `run.ts` knobs (how each experiment was driven)

| Knob | Effect |
|---|---|
| `--seg-matrix` | Headline sweep: `{none, intl (ICU/Intl.Segmenter), attacut (HTTP sidecar)} × {baseline, +rerank}`. |
| `--segmenter none\|intl\|attacut\|bigram` | Pick a single keyword-leg arm (`bigram` = no-segmenter + pg_bigm). Default: `attacut`. |
| `--lexical-only` | Drop the dense leg (`vectorWeight=0`) — isolates the lexical (trgm/bigm + FTS) legs. |
| `--keyword-min-score <k>` | Set the keyword-leg relevance gate (pg_trgm `word_similarity_threshold` / pg_bigm coverage). **Branch:** `feat/thai-benchmark-keyword-threshold`. |
| `--queries <file>` | Swap the query set (e.g. the low-overlap set). **Branch:** `feat/thai-benchmark-lowoverlap-queries`. |
| `--rerank` | Attach the cross-encoder reranker. |
| `--cjk` / `--bm25` / `--vectorchord` | Optional extensions. |
| `EMBEDDING_MODEL` / `EMBEDDING_DIM` | Swap embedder for head-to-heads (bge-m3 / e5-large, both 1024d). |
| `VECTOR_MIN_SCORE` | Dense-leg cosine floor (0 disables). **Set to 0 for bge-m3.** |

---

## Environment & serving

Same machine and serving stack as the Arabic benchmark (see `examples/benchmark/BENCHMARKING_LOG.md`
for the full recipe and gotchas): infinity (`michaelf34/infinity`, torch cu128) on `:7997` serving
bge-m3 + e5-large + e5-small + reranker; Postgres `examples-db-1` via `examples/docker-compose.yml`.
Thai adds an **attacut segmenter sidecar** on `:8100` (FastAPI + PyThaiNLP, CPU) from
`examples/docker-compose.yml` service `thai-segmenter`, consumed via `HttpThaiSegmenter`.

```
podman compose -f examples/docker-compose.yml up -d db thai-segmenter
podman compose -f examples/benchmark/docker-compose.infinity.yml up -d
curl http://localhost:8100/health ; curl http://localhost:7997/models
```

> **🎥 GPU host crash = camera contention.** Using the laptop camera *while a benchmark runs on the
> GPU* crashes the NVIDIA/WSL driver and takes the host down. It is **not** a benchmark/infinity
> fault. Do not use the camera during a run.

---

## Experiments

### 1. Segmentation A/B — the headline (clean negative)

`run.ts --seg-matrix` — 3 segmenters × {baseline, +rerank}, n=75/arm, fused (dense + trgm + FTS).

| Arm | baseline nDCG@10 | +rerank nDCG@10 |
|---|---|---|
| **none (unsegmented)** | **.749** | **.805** |
| intl (ICU) | .728 | .802 |
| attacut (neural sidecar) | .728 | .802 |

No attacut win even on the loanword slice (baseline R@5: none 83.7 / intl 79.6 / attacut 81.6).

**Takeaway.** The segmentation thesis is **not** confirmed — `none` is marginally best. BGE-M3's
dense leg (segmenter-blind) dominates the RRF fusion and already handles Thai loanwords; the lexical
legs (where the segmenter acts) aren't the bottleneck, and the segmenter-blind reranker washes out
the small intl/attacut differences (their +rerank rows converge). The mechanism works (intl vs
attacut differ at *baseline* by register); it just doesn't move fused retrieval here.

### 2. bigram (pg_bigm) arm + lexical-only

Added a 4th keyword arm `bigram` (pg_bigm char-bigram coverage, `cjk:true`, no segmenter) and
`--lexical-only` (drops the dense leg).

- **bigram ≡ none, identical metrics** in both fused (.749) and lexical-only (.722). pg_bigm gives
  no lift over the default unsegmented pg_trgm char-trigram.
- **In lexical-only, segmenting HURTS:** none/bigram .722 vs intl .650 / attacut .647 nDCG (loanword
  slice 79.6% vs 75.5%). `word_similarity` on the whole unsegmented string finds the best substring
  match boundary-agnostically; segmentation forces query/doc boundary alignment that ICU/attacut
  disagree on.

**Takeaway.** For this library's Thai lexical legs, **no segmenter is best and pg_bigm adds nothing**.

### 3. keywordMinScore sweep + why the curve plateaus *(branch: keyword-threshold; lexical-only, segmenter=none)*

nDCG@10 vs `--keyword-min-score` (kMS):

| kMS | 0.10 | 0.20 | 0.35 | 0.50 | 0.60 | 0.70 | 0.80 | 0.90 |
|---|---|---|---|---|---|---|---|---|
| high-overlap | .53 | .59 | .722 | .792 | **.819** | .814 | .814 | .814 |
| low-overlap | .27 | .53 | .647 | .661 | **.666** | .666 | .666 | .666 |

The default **kMS=0.35 undershoots** the Thai lexical leg; it rises to a peak/plateau at ~0.6.

**Mechanism (probe-verified — ad-hoc `word_similarity` dump, faithful to the leg; script was
throwaway).** The plateau is **not** a bimodal valley. The pg_trgm leg **goes empty at high kMS**,
and kMS only gates that leg: the global *max* word_similarity is **0.500** (low-overlap) / **0.630**
(high-overlap) — nothing reaches 0.6, the distribution is unimodal junk-heavy (98% of pairs < 0.2),
and gold-doc scores top out below the junk ceiling. Gate survival (instances with ≥1 doc clearing):
low-overlap kMS 0.35 → 15/75, 0.50 → 2/75, **0.60 → 0/75**. So for kMS ≥ ~0.55 the leg returns ∅ and
the fused result is the kMS-invariant tsvector FTS leg **alone** → flat plateau by construction.
"kMS ≈ 0.6 optimal" is therefore not a calibrated threshold — it's the point where the net-harmful
unsegmented-Thai char-trigram leg switches **off** (gold and junk are unseparable in the same 0.1–0.5
band). Contrast Latin, where real matches reach 0.5–1.0 above the junk floor so 0.35 keeps a useful
band. (Scope: lexical-only; in the default fused pipeline the dense leg dominates and kMS matters far
less — its fused-mode impact was not separately measured.)

### 4. Low-overlap query A/B *(branch: lowoverlap; removes the authored-query confound)*

A second 25-query set with the same targets but variants paraphrased to avoid answer vocabulary.

| | fused baseline none | lexical-only none | lexical-only attacut |
|---|---|---|---|
| original (high-overlap) | .749 | .722 | .647 |
| low-overlap | **.671** | **.647** | **.561** |

**Takeaway.** The authored-query confound was real but moderate (~−0.08 nDCG); conclusions are
**robust**: (1) bigram ≡ none still exactly; (2) segmentation still loses and the gap *widens* on
low-overlap (lexical-only none − attacut: .075 → .086); (3) BGE-M3's dense leg degrades gracefully on
paraphrases (didn't collapse → genuinely semantic).

### 5. Does trgm/bigm on *segmented* text help? (end-to-end, GPU-confirmed) *(branch: keyword-threshold + lowoverlap)*

`--segmenter attacut --lexical-only` swept across kMS, vs unsegmented `none`:

| kMS | low: attacut | low: none | high: attacut | high: none |
|---|---|---|---|---|
| 0.35 | .561 | .647 | .647 | .722 |
| 0.50 | .649 | .661 | .753 | .792 |
| 0.60 | .661 | .666 | .801 | **.819** |
| 0.70 | .661 | .666 | **.818** | .814 |
| 0.80 | .666 | .666 | .813 | .814 |

(kMS=0.35/0.50 reproduce the prior attacut numbers → runs valid.)

**Takeaway. Segmentation never wins.** Low-overlap: attacut is strictly ≤ none, converging to an
*exact tie* (.666) only at kMS=0.80. High-overlap: attacut peaks *later* (kMS=0.70 → .818) and ties
none's peak (.819) within noise. An ad-hoc word_similarity probe explains it: segmentation *does*
raise scores (Latin regime — gold max low .447 → .643, high .619 → .846, pushing a few real matches
≥ 0.6) **but inflates junk equally** (low-overlap's single highest-scoring doc, 0.711, is junk —
ICU/attacut turn common short function-words into 2–3-char tokens that match spuriously). So it
catches up at best, never pulls ahead — and at the default kMS it loses outright. Keep unsegmented
(equal-or-better, simpler, no sidecar). pg_bigm-on-segmented isn't even a natural combo (the
segmenter routes segmenter-handled languages to trgm-on-`content_normalized`, not pg_bigm).

### 6. Embedder head-to-head: bge-m3 vs multilingual-e5-large

Fused, segmenter=none, `VECTOR_MIN_SCORE=0`, both query sets, ± rerank; swap only `EMBEDDING_MODEL`
(both 1024d, one infinity instance serves both + the reranker).

| set / arm | **BAAI/bge-m3** | intfloat/multilingual-e5-large |
|---|---|---|
| high / baseline | **.749** | .412 |
| high / +rerank | **.805** | .532 |
| low / baseline | **.671** | .240 |
| low / +rerank | **.726** | .350 |

(The bge-m3 rows reproduce Experiments 1/4 exactly → runs valid.)

**Takeaway. BGE-M3 dominates Thai retrieval — e5-large is not a viable substitute.** This is real
model quality, **not** a misconfiguration: a cosine gold-rank sanity check (query vs gold chunk + 30
random distractors) ranks the gold #1 in **7/8** queries for *both* models. The difference is cosine
**geometry**: e5-large compresses all Thai texts into a narrow high band (~0.79–0.92) with
razor-thin gold−distractor margins (~0.01), while bge-m3 spreads them (gold cos 0.59–0.78, ~0.23
margins). So e5-large beats *random* distractors but collapses against *hard* same-domain distractors
in full-corpus (329-chunk) retrieval → low recall. Reranking can't rescue it (it only reorders the
retrieved pool; e5-large +rerank R@10 ≈ its baseline R@10). The narrow high e5 band is exactly why
the library's `vectorMinScore=0.8` default is e5-calibrated — lethal to bge-m3's lower band; both ran
at floor=0 here, so the comparison is fair. (Both got the e5 `query:`/`passage:` prefix — correct for
e5; bge-m3 doesn't natively want it, so its true ceiling may be marginally higher — but it won
decisively even handicapped.) The default `multilingual-e5-small` is weaker still.

---

## Consolidated recommendations

All numbers are Thai-only on this bespoke FAQ corpus; treat as validated starting points, not
universal defaults. (The README "Recommended Thai configuration" section is being updated to match —
that edit currently lives on `feat/thai-benchmark-lowoverlap-queries` pending merge.)

1. **Embedder (the biggest lever):** `BAAI/bge-m3` (1024d) with `vectorMinScore` ≤ 0.4 (or 0). bge-m3
   beat e5-large by ~+0.34 nDCG baseline; e5-family Thai embeddings lack discriminative contrast and
   are not a viable substitute. *(Driver: embedder quality + calibration.)*
2. **Segmenter: none.** Unsegmented pg_trgm + FTS matched or beat ICU and attacut in **every** config
   (segmentation never led beyond noise, lost at the default threshold). Skip the sidecar. *(Driver:
   a strong dense + FTS pair dominates fusion — revalidate if your dense leg is weak/absent.)*
3. **pg_bigm: skip on Thai** — `bigram ≡ none` in every measurement; no lift over the default
   unsegmented pg_trgm char-trigram.
4. **Reranking:** enable with `rerankCandidates` ≈ 2–3× topK (baseline → reranked ≈ .75 → .81).
   Reranking cannot recover a doc retrieval missed, so embedder quality (1) dominates.

## Open follow-ups

- **kMS in *fused* mode** (dense-dominated) — only lexical-only was swept; the fused-mode impact of
  the default 0.35 vs ~0.6 is unmeasured.
- **Question-in-content A/B for Thai** (`corpus-withq.jsonl` exists; mirror Arabic Experiment 6) —
  unrun. Arabic saw a large, general lift from indexing question + answer.
- **BM25 for Thai** (low-resource lexical leg) — untested here.
- **Merge decision** for the two unmerged benchmark branches (`feat/thai-benchmark-keyword-threshold`,
  `feat/thai-benchmark-lowoverlap-queries`); Experiments 3–5 and the README rec update depend on them.

## Where the data lives

Corpus + caches are gitignored / local-only (`datasets/faqs-th/`, `datasets/PDFs-th/`,
`datasets/benchmark-cache-th/`); re-scrape via `examples/benchmark-thai/scrape/README.md` if wiped.
Committed: `queries.json` (+ `queries-lowoverlap.json` on the lowoverlap branch), `scrape-notes.md`,
and the runner. Per-run handoffs/results live under `examples/benchmark-thai/results/` (on the
feature branches). This log is the durable record.
