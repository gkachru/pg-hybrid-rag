# Benchmark baselines & regression check

`baselines.json` holds the committed reference metrics for every benchmark suite: Arabic
(`examples/benchmark`) and Thai (`examples/benchmark-thai`). `regression.ts` re-runs the suites and
compares against it. Use it after any change that could move retrieval quality:

- a DB image or extension upgrade
- a migration
- a change to an adapter, SQL, fusion or rerank code

`results/` is gitignored, so `baselines.json` is the only shared record of what "normal" looks like.

## 1. Bring up the stack

```bash
# DB. The host port follows POSTGRES_PORT (default 5432). If another Postgres holds 5432,
# use a free port and export the same value for the run in step 2.
export POSTGRES_PORT=55440
cd examples && podman compose up -d db thai-segmenter && cd ..

# Embedder + reranker on the GPU (bge-m3 + bge-reranker-v2-m3 on :7997)
podman machine ssh "nvidia-ctk cdi list"      # must list nvidia.com/gpu=all
podman compose -f examples/benchmark/docker-compose.infinity-min.yml up -d --force-recreate
curl -s http://localhost:7997/models          # both models listed
podman logs infinity-embed-infinity-1 2>&1 | grep -o 'device=`cuda`'
```

If `nvidia-ctk` or the CDI device is missing, see the Gotchas in
[BENCHMARKING_LOG.md](BENCHMARKING_LOG.md). **Don't use the laptop camera while a GPU run is in
progress**; that has crashed the host.

The other prerequisites are the same ones the benchmarks always need:

- a root `.env` with `EMBEDDING_MODEL=BAAI/bge-m3`, `EMBEDDING_DIM=1024`,
  `RERANKER_MODEL=BAAI/bge-reranker-v2-m3` and `VECTOR_MIN_SCORE=0`
- the local corpus caches under `datasets/benchmark-cache/` and `datasets/benchmark-cache-th/`, or
  their FAQ/PDF sources, so the runners can build them. These are gitignored and local-only; see
  each benchmark's README.

## 2. Run

```bash
bun run examples/benchmark/regression.ts                      # all 11 suites, ~20 min on GPU
bun run examples/benchmark/regression.ts --only ar-matrix,th-matrix
bun run examples/benchmark/regression.ts --list               # what each suite runs
```

A preflight step fails fast if any of these is true:

- the embedding server doesn't serve the expected models
- the Thai segmenter is down
- `EMBEDDING_MODEL`, `EMBEDDING_DIM`, `RERANKER_MODEL` or `VECTOR_MIN_SCORE` differ from the
  baseline's

Results under any of those conditions aren't comparable. Use `--allow-settings-drift` only when
that's intended.

Per-suite logs and a `summary.txt` are written to `examples/benchmark/results/regression-<ts>/`. The
exit code is `0` if every suite is OK and `1` if any suite failed or any metric is beyond tolerance.

To compare a single result JSON against a suite, or against another result:

```bash
bun run examples/benchmark/compare.ts examples/benchmark/results/<ts>.json --against ar-matrix
bun run examples/benchmark/compare.ts new.json --against old.json
```

## 3. Interpret

A metric is flagged (`*`) when |Δ| > max(0.005, 1/n), where 1/n is one query's worth:

| Benchmark | Tasks (n) | One query flip |
|---|---|---|
| Arabic | 89 queries × 3 dialects = 267 | .0037 |
| Thai | 25 queries × 3 registers = 75 | .013 |

GPU-to-GPU reruns of the same setup reproduce these baselines exactly, or move by one query. A
regression shows up as several queries moving, or as a whole config failing.

- **Settings or server changed.** `regression.ts` prints any difference in Postgres or extension
  versions versus the baseline. That's expected when testing an upgrade.
- **CPU-served embedder.** CPU results are **not comparable** to these GPU baselines: fp32-CPU vs
  fp16-GPU inference shifts scores slightly. The CPU path is also about 40× slower; see
  BENCHMARKING_LOG.

## 4. Refresh the baselines

After an intended quality change, or to re-anchor on new infrastructure, run with
`--update-baselines`. It rewrites each fully successful suite's metrics, settings, server
versions and `recordedAt` in `baselines.json`. Review the diff, then commit it together with the
change that caused it, and say in the commit message why the numbers moved.

## Current baselines (nDCG@10)

Recorded on 2026-11-04 on the GPU. Server: Postgres 17.11, pgvector 0.8.7, vchord 1.1.1,
pg_textsearch 1.3.0, pg_bigm 1.2, pg_trgm 1.6. Models: bge-m3 + bge-reranker-v2-m3 with
`VECTOR_MIN_SCORE=0`. Full metrics are in `baselines.json`.

The corpora are bespoke, so only relative positions are meaningful (see the caveat in
BENCHMARKING_LOG). `+vectorchord` equals `baseline` throughout because flat vchordrq is exact at
this corpus size.

**Arabic `--matrix`** (`ar-matrix`: answer-only corpus; `ar-matrix-withq`: question + answer corpus)

| Config | ar-matrix | ar-matrix-withq |
|---|---|---|
| baseline | .666 | .929 |
| +bm25 | .626 | .957 |
| +vectorchord | .666 | .929 |
| +rerank | .766 | .951 |
| all | .743 | .968 |

**Arabic question-in-content A/B** (`ar-qcontent-*`, single config each; see BENCHMARKING_LOG Experiment 6)

| Suite | Env | Answer-only (A_) | Question + answer (Q_) |
|---|---|---|---|
| bm25_u30 | `--bm25 --rerank`, FUSION=rrf, RERANK_CANDIDATES=30, CANDIDATE_MULTIPLIER=3 | .796 | .972 |
| bm25_lin20 | `--bm25 --rerank`, FUSION=linear, NORMALIZER=minmax, RERANK_CANDIDATES=20, CANDIDATE_MULTIPLIER=2 | .797 | .971 |
| lin20 | `--rerank`, FUSION=linear, NORMALIZER=minmax, RERANK_CANDIDATES=20, CANDIDATE_MULTIPLIER=2 | .789 | .956 |

**Thai `--seg-matrix`** (`th-segmatrix-queries` / `th-segmatrix-lowoverlap`)

| Segmenter | baseline | +rerank | baseline (low-overlap) | +rerank (low-overlap) |
|---|---|---|---|---|
| none | .749 | .805 | .671 | .726 |
| intl | .728 | .802 | .646 | .722 |
| attacut | .728 | .802 | .633 | .721 |
| bigram | .749 | .805 | .671 | .726 |

**Thai `--matrix`** (`th-matrix`, attacut): baseline .728 · +bm25 .680 · +vectorchord .728 ·
+rerank .802 · all .788
