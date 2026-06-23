# Arabic RAG Benchmarking Log

A consolidated record of the benchmark experiments run against `pg-hybrid-rag` on a bespoke
Arabic-dialect FAQ corpus. This is the canonical write-up — it replaces the per-experiment
handoff plans and orchestration scripts. Every experiment here is reproducible from
`examples/benchmark/run.ts` plus the env knobs / flags listed in each section.

> **Caveat on absolute numbers.** The corpus is bespoke (banking + telecom FAQ + PDF
> distractors), so only *relative* positioning is meaningful — these nDCG values are not
> comparable to public leaderboards (MIRACL etc.). Treat every recommendation as "validated on
> this corpus + embedder," not universal.

---

## Setup

- **Corpus:** 1380 chunks (faq = 163, pdf = 1217 distractors), Arabic, banking + telecom domains.
  Two variants:
  - `corpus.jsonl` — **answer-only** (indexed content = FAQ answer). The realistic-floor task.
  - `corpus-withq.jsonl` — **question + answer** (content = `question\nanswer`). Built via
    `run.ts --include-question`. An easier, also-realistic FAQ-RAG setup (see Experiment 6).
  Both are cached under `datasets/benchmark-cache/` (gitignored); `run.ts` auto-builds if missing.
- **Queries:** 89 queries × 3 dialects (MSA / Saudi / Darija) = 267 search tasks. Each query is a
  dialectal paraphrase of one curated FAQ question, with a single target FAQ doc.
- **Metrics:** R@1 / R@3 / R@5 / R@10, MRR@10, nDCG@10. Reported all-dialect ("custom"/"all") and
  per-dialect. "MSA+Saudi" = mean of the msa and saudi nDCG rows (Darija excluded as the
  low-resource floor).
- **Default models:** `BAAI/bge-m3` embedder (1024d) + `BAAI/bge-reranker-v2-m3`, fp16 on GPU via
  infinity on `:7997` (see Environment).
- **Harness:** `run.ts` creates an isolated DB per config, migrates, seeds Arabic stop words,
  indexes the corpus (replace-by-source, so switching corpus variants between runs needs no manual
  reset), runs every (query × dialect) through `RagPipeline.search`, scores, drops the DB.

### `run.ts` knobs (how each experiment was driven)

| Knob | Effect |
|---|---|
| `--bm25` | Swap the FTS leg from tsvector to BM25 (`Bm25Fts`). The vector + trgm legs always run. |
| `--rerank` | Attach the cross-encoder reranker. |
| `--include-question` | Load the question+answer corpus instead of answer-only. |
| `--matrix` / `--lean` | Run the 5-config preset matrix / the 2-config (baseline + rerank) subset. |
| `RERANK_CANDIDATES` | Rerank a bounded union of this many fused candidates (default = topK). |
| `CANDIDATE_MULTIPLIER` | Per-leg candidate depth = topK × mult (must be ≥ RERANK_CANDIDATES/topK). |
| `FUSION` | `linear` (else rrf default). |
| `NORMALIZER` | `minmax` (default) or `l2`, for the linear path. |
| `VECTOR_MIN_SCORE` | Dense-leg cosine floor (0 disables). **Set to 0 for bge-m3** — see Experiment 1. |
| `SEARCH_CONCURRENCY` | Concurrent (query × dialect) searches. |
| `EMBEDDING_MODEL` / `EMBEDDING_DIM` | Swap embedder for head-to-heads (e.g. 1024 for bge-m3 / e5-large). |

---

## Environment & serving

- **GPU serving = infinity** (`michaelf34/infinity`, torch cu128) on `:7997`. One process serves
  multiple models, selected per request (`POST /embeddings`, `POST /rerank`). On this machine
  (RTX 5070 Ti Laptop, Blackwell sm_120, rootless podman + WSL2) infinity is the **only** working
  GPU server — TEI/candle has no stable sm_120 kernels and silently falls back to CPU. Recipe:
  `devices: [nvidia.com/gpu=all]` + `LD_LIBRARY_PATH=/usr/lib/wsl/lib`, `--device cuda`,
  `--no-bettertransformer`.
  - `docker-compose.infinity.yml` — 4-model set (bge-m3, e5-large, e5-small, reranker).
  - `docker-compose.infinity-min.yml` — 2-model set (bge-m3 + reranker), frees VRAM headroom.
- **Postgres** = `examples-db-1` (pgvector / vchord / pg_textsearch / pg_bigm), via
  `examples/docker-compose.yml` service `db`.
- Bring-up:
  ```
  podman machine start
  podman compose -f examples/docker-compose.yml up -d db
  podman compose -f examples/benchmark/docker-compose.infinity-min.yml up -d --force-recreate
  curl http://localhost:7997/models       # confirm models present
  podman logs infinity-embed-infinity-1 | grep -i device   # confirm device=cuda
  ```

### Gotchas (hard-won)

- **🎥 GPU host crash = camera contention.** Using the laptop camera *while a benchmark runs on the
  GPU* crashes the NVIDIA/WSL driver and takes the whole host down (happened ~3×). It is **not** a
  fault in the benchmark or infinity config. **Do not use the camera during a run.** With the camera
  out of the picture, `SEARCH_CONCURRENCY=8` runs fine and crash-free (a no-rerank pass finished in
  ~40s). The earlier `SEARCH_CONCURRENCY=2` / 2-model mitigations helped VRAM but were not the fix.
- **CDI stale after a driver *reinstall*.** A driver reinstall changes the WSL driver hash, so
  `nvidia.com/gpu=all` fails with `crun: cannot stat .../libcuda.so.1.1`. Regenerate both CDI specs
  then `--force-recreate`:
  ```
  podman machine ssh "sudo nvidia-ctk cdi generate --mode=wsl --output=/etc/cdi/nvidia.yaml; nvidia-ctk cdi generate --mode=wsl --output=/home/user/.config/cdi/nvidia.yaml"
  ```
  A plain crash/reboot does *not* change the hash — CDI stays valid; infinity just needs a restart.
- **bettertransformer off** is the shipped serving config (it caused an over-length-input crash);
  measured quality-neutral (.766 off vs .762 on, within noise).
- **`.wslconfig` memory** was capped at 12GB — too tight for multi-model cold start. Bump it for
  the 4-model set.

### Production target

**OCI Ampere A1 = Neoverse N1 (CPU-only, no GPU).** All GPU numbers here are a *reference*.
**Quality** transfers to N1 (same weights / deterministic integer GEMM); **speed** does not — the
x86+GPU latency numbers must be re-benchmarked on real N1. N1 has DotProd (int8 SDOT/UDOT) and
native fp16 but lacks i8mm/SVE, so int8's throughput lead is real but moderate and fp16 is a genuine
alternative there. `michaelf34/infinity` has no arm64 image — on N1 serve via an aarch64 ONNX
Runtime server (OpenAI-compatible HTTP, drops into the pipeline). **This makes rerank cost the
dominant latency lever on the deployment** — the throughline behind several recommendations below.

---

## Experiments

### 1. `vectorMinScore` is e5-calibrated (the dense-leg killer)

**Finding.** `RagPipeline` defaults `vectorMinScore: 0.8`, calibrated for e5's *inflated* cosines
(related & unrelated Arabic both ~0.83–0.93). bge-m3 is better calibrated (related ≈0.6–0.75,
unrelated ≈0.43), so at 0.8 its dense leg returns ~0 candidates and the model scores **worst**
(baseline nDCG .442, vectorCandidates=0 in 240/267 searches). Dropping to `VECTOR_MIN_SCORE=0.4`
revived it (.664, best embedder). The floor sweep is otherwise flat in [0, 0.5] on bge-m3.

**Takeaway.** `vectorMinScore=0.8` is **not** model-agnostic. All subsequent runs use
`VECTOR_MIN_SCORE=0`. Lower it whenever you swap off e5.

### 2. SOTA embedder head-to-head

`run.ts --matrix`, swapping only the embedder (`EMBEDDING_MODEL`/`EMBEDDING_DIM`), vms fixed.

| Embedder | baseline nDCG@10 | +rerank nDCG@10 |
|---|---|---|
| multilingual-e5-small (384d, library default) | .575 | .731 |
| multilingual-e5-large (1024d) | .641 | .756 |
| **BAAI/bge-m3 (1024d)** | **.664/.665** | **.766** |

**Takeaway.** Upgrade the embedder to bge-m3 (or e5-large); biggest gains on **Darija** (the floor
for every model) and **telecom**. The reranker is the single biggest quality lever overall. bge-m3
adopted as the default for all later experiments.

### 3. int8 quantization (toward the CPU deployment)

bge-m3 stack, `--matrix --lean` (baseline + rerank), full 89q. int8 = dynamic-quant ONNX
(`model_quantized.onnx`, optimum engine). **infinity `latest` has no CUDA EP — ONNX runs on CPU
regardless of `--device cuda`** (need `latest-trt-onnx` for ONNX-on-GPU, untested).

| Config | baseline | +rerank | notes |
|---|---|---|---|
| fp16 (GPU) reference | .665 | .766 | |
| reranker int8 (CPU) | — | **.765** | ≈ lossless (Δ −.001) — cross-encoder reads text directly |
| embedder int8 (CPU) | .662 | .749 | −.017 after rerank |

Speed (x86 CPU): embed 18.9 vs 120 emb/s; rerank 424 vs 70 ms/call (~6× slower).

**Takeaway.** Best compromise = **fp16 embedder + int8 reranker** (.765 ≈ .766). For N1: int8
reranker is a clear win (lossless, dotprod-accelerated, small footprint); embedder int8-vs-fp16
needs an on-N1 latency benchmark.

### 4. Rerank the union, not just the top-K

The pipeline reranked only the RRF-cut top-K, dropping true positives a leg surfaced but RRF ranked
11–30 *before* the cross-encoder saw them. Added `RagSearchOptions.rerankCandidates` (rerank a
bounded union of `max(topK, rerankCandidates)` fused candidates, still return topK). bge-m3, fp16
GPU, full 89q, vms=0.

| Config | nDCG@10 | notes |
|---|---|---|
| ref10 (rerank top-10 = old behavior) | .762 | |
| union20 | .785 | |
| **union30** | **.789** | biggest mover: Saudi R@5 +5.6pts |
| union30 + vms 0.5 | .789 | floor is a **no-op** on bge-m3 (trims 30.0→29.7) |
| bm25_ref10 | .743 | reproduces the "bm25 hurts" regression |
| **bm25_u30** | **.796** | **bm25 rescued — best overall** |

**Takeaway.** Reranking the bounded union recovers recall and is bounded (rerankInput = cap
exactly). The prior "bm25 hurts" finding was a **rerank-top-K truncation artifact** — with the union,
bm25 flips to the best config. Cost: union30 ≈ 2.2× ref10 wall-clock (3× cross-encoder calls) — the
main quality⇄latency lever, especially on the CPU target.

### 5. Linear fusion vs RRF

Opt-in `fusion: "linear"` (shipped on `main`). bge-m3, fp16 GPU, full 89q, vms=0.

| Config | nDCG@10 | notes |
|---|---|---|
| rrf_base (no rerank) | .664 | |
| linear-minmax (no rerank) | .669 | +.005 = noise |
| linear-l2 (no rerank) | .629 | **worse** — l2 distorts when one leg dominates |
| rrf_u30 | .789 | |
| **linear-minmax union-20** | **.789** | matches rrf_u30 at **2/3 the rerank cost** |
| linear-minmax union-30 | .792 | best at equal depth (edges rrf) |
| **bm25 + linear-minmax union-20** | **.797 / .858 / .647→.674** | answer-only all-dialect best |

**Takeaways.** (H1) Score-aware linear-minmax orders the union better, so a *smaller* union (RC20)
reaches RRF's RC30 quality → ~⅓ less cross-encoder work (the real win, on the cost axis — quality
margins are ~noise). (H2) Linear does **not** replace reranking (no-rerank .669 vs reranked .789 —
the cross-encoder is worth ~+.12). Use `minmax`, never `l2`. bm25's full Darija lift is recoverable
under linear (.674), but bm25 costs MSA+Saudi −.003 — so **bm25 is required for the all-dialect best,
not for MSA+Saudi-only**.

### 6. Question-in-content A/B (index the FAQ question, not just the answer)

The queries are paraphrases of the FAQ *question*; answer-only content forces the lexical legs to
match a question against an answer (low overlap — why bm25/trgm underperformed). Putting the question
in content creates query↔content overlap. bge-m3, fp16 GPU, full 89q, topK=10, vms=0. RC30 = rrf +
candidateMultiplier 3; RC20 = linear-minmax + candidateMultiplier 2.

All-dialect nDCG@10 / MSA+Saudi / Darija:

| Config | corpus | all | MSA+Saudi | Darija |
|---|---|---|---|---|
| A_bm25_u30 (rrf+bm25, RC30) | answer-only | .796 | .858 | .673 |
| A_bm25_lin20 (lin-mm+bm25, RC20) | answer-only | .797 | .858 | .674 |
| A_lin20 (lin-mm, no bm25, RC20) | answer-only | .789 | .861 | .647 |
| **Q_bm25_u30 (rrf+bm25, RC30)** | q+answer | **.972** | .994 | .929 |
| Q_bm25_lin20 (lin-mm+bm25, RC20) | q+answer | .971 | .994 | .924 |
| Q_lin20 (lin-mm, no bm25, RC20) | q+answer | .956 | .994 | .880 |

(All three answer-only baselines reproduced Experiment 5's numbers to 3 decimals — the A/B is clean.)

**Takeaways.**
1. **Huge, broad lift:** +.176 all-dialect (.796→.972). MSA nDCG **1.000** (R@1 = 100%), MSA+Saudi
   **.994**, Darija .673→.929 (+.256, biggest absolute mover — it had the most headroom).
2. **General, not bm25-specific:** Q_lin20 (no bm25) = .956/.994/.880 captures nearly the whole lift
   through the **dense + trgm** legs alone.
3. **Winner shift via Darija only:** all-dialect best = Q_bm25_u30 (.972) / Q_bm25_lin20 (.971, tied
   & cheaper — linear RC20 ≈ rrf RC30 holds on q+a). On MSA+Saudi all three Q configs tie at .994.
4. **bm25 still doesn't earn its keep on MSA+Saudi** (identical .994 — dense+trgm saturate); its
   entire marginal value is Darija (+.044–.049). Same Darija-only story as answer-only.

**Caveat.** q+a is an *easier* task (queries are paraphrases of the question now in content). It's a
realistic FAQ-RAG setup but a **separate labeled config, not a replacement** for the answer-only floor.

### 7. Skip-rerank on the q+a corpus (H2 for the CPU target)

Does question-in-content make the expensive cross-encoder skippable? No-rerank vector + trgm + bm25
(rrf, no tsvector), `run.ts --bm25 [--include-question]`, vms=0.

All-dialect nDCG@10 / MSA+Saudi / Darija, vs the reranked bm25_u30:

| corpus | no-rerank | +rerank (bm25 u30) | rerank worth |
|---|---|---|---|
| answer-only | .626 / .664 / .549 | .796 / .858 / .673 | **+.170** (essential) |
| question+answer | .956 / .990 / .887 | .972 / .994 / .929 | **+.016** (marginal) |

**Takeaway.** On answer-only, the cross-encoder is essential (+.170). On q+answer it's worth only
+.016 all-dialect / +.004 MSA+Saudi — query↔content alignment ranks the target at/near the top
*before* reranking (MSA R@1 = 100% with no reranker). **So an FAQ deployment that indexes the
question can skip reranking on the CPU-bound N1 target with little loss** — only Darija (low-resource)
still clearly wants it (+.042).

---

## Consolidated recommendations

These are reflected in the README "Recommended configurations" section.

1. **Embedder:** bge-m3 (1024d) with `vectorMinScore` ≤ 0.4 (or 0). The 0.8 default is e5-only.
2. **Rerank a bounded union:** `rerankCandidates` ≈ 2–3× topK — the main quality lever; recovers
   recall RRF-top-K discards.
3. **Linear-minmax fusion** to cut rerank depth (RC20 ≈ RC30) when the embedder's scores are
   calibrated. Never l2. It does not replace reranking.
4. **For FAQ corpora, index `question` + `answer`** — large, general lift across all legs/dialects,
   and it makes reranking nearly skippable on CPU (Darija excepted).
5. **BM25 for low-resource languages/dialects** — its value stayed Darija-specific even with the
   question in content; keep it a targeted lever, not a default. Needs migrations 011 + 015 +
   `shared_preload_libraries`.
6. **For the N1 CPU deployment:** fp16 (or int8) embedder + int8 reranker; or, for an FAQ corpus,
   index the question and skip reranking entirely. Re-benchmark *latency* on real N1.

## Open follow-ups

- On-N1 latency benchmark (deferred until an A1 instance exists) — quality transfers, speed doesn't.
- Dialect-aware embedder (e.g. Swan) for the Darija gap.
- ONNX-on-GPU via infinity `latest-trt-onnx` (int8 footprint at GPU speed) — untested.

## Where the data lives

Per-run logs/summaries are written under `examples/benchmark/results/` (gitignored, local-only):
`results/union/`, `results/qcontent/`, `results/qcontent-norerank/`. This log is the durable record.
