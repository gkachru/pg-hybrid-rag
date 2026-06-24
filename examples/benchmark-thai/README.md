# Thai Word-Segmentation RAG Benchmark

Measures **Thai retrieval quality** over real telecom / banking / insurance help-center FAQ
content, with **word-segmentation quality as the headline axis**. Thai writes no inter-word
spaces, so the lexical legs (pg_trgm keyword + tsvector FTS) depend on a segmenter inserting word
boundaries. This benchmark holds the corpus, queries, embedder, and DB fixed and swaps only the
injected `Segmenter` — `none` vs `IntlSegmenterAdapter` (stdlib ICU dictionary) vs
`HttpThaiSegmenter` (attacut, the neural sidecar in `examples/thai-segmenter/`) — to show that a
neural segmenter beats a dictionary one on loanword / transliterated / brand terms, while the
segmenter-blind dense + rerank legs stay a fixed control.

It mirrors `examples/benchmark/` (the Arabic dialect benchmark): a fresh isolated Postgres database
per config, migrate, seed stop words, index the corpus, run every query × register variant, score,
then drop the database.

> **Scope:** the committed `queries.json` + corpus pipeline are a **bounded proof** (3 providers ×
> 3 domains: AIS / SCB / AIA). The harness scales to the broad scope in the design doc — re-run the
> scrape (`scrape/README.md`) to extend it.

---

## What it measures

- **Headline — segmenter arms** (`--seg-matrix`): `{none, intl, attacut} × {baseline, +rerank}`.
  Expected ordering on the lexical-leg-sensitive configs: **attacut ≥ intl > none**, with the gap
  **widest on the loanword query slice**.
- **Metrics:** Recall@1/3/5/10, MRR@10, nDCG@10. Ground truth: a result is relevant iff its source
  doc matches the query's `target_doc` (the FAQ answer the query was written to retrieve).
- **Slices:** overall, by **register** (written / spoken / codeswitch), by **domain** (telecom /
  banking / insurance), and by **loanword** (a query is loanword-heavy if it contains a Latin-script
  run or a known Thai-script transliteration — see `loanword.ts`).
- **Distractors:** policy/T&C PDF chunks are indexed as in-domain noise; no query targets them, so
  precision is meaningful.

---

## Prerequisites

- **PostgreSQL** with `pgvector` + `pg_trgm`. Start via `cd examples && podman compose up -d db`
  (or `docker compose up -d db`).
- **Embedding + reranker API** — the existing Infinity compose serves both on `:7997`:
  ```bash
  podman compose -f examples/benchmark/docker-compose.infinity.yml up -d
  ```
  (BGE-M3 embedder + bge-reranker-v2-m3, on the GPU.)
- **attacut Thai segmenter sidecar** on host `:8100`:
  ```bash
  cd examples && podman compose up -d thai-segmenter
  curl -f http://localhost:8100/health     # wait for {"status":"ok"}
  ```
- **Python 3 + pypdf** for the one-time PDF extraction (`python -m pip install pypdf`).
- **`.env` at repo root:**

```
# Database (choose one form)
DATABASE_URL=postgresql://user:pass@localhost:5432/postgres
# -- or POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB (+ optional HOST/PORT)

# Embedder — BGE-M3 (1024-dim, strong on Thai)
EMBEDDING_BASE_URL=http://localhost:7997
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_API_KEY=dummy
EMBEDDING_DIM=1024
EMBEDDING_BATCH_SIZE=8
# Lower the vector floor: the 0.8 default is e5-calibrated and zeroes the dense leg for BGE-M3.
VECTOR_MIN_SCORE=0.4

# Reranker (optional — enables --rerank)
RERANKER_BASE_URL=http://localhost:7997
RERANKER_MODEL=BAAI/bge-reranker-v2-m3

# Thai segmenter sidecar (attacut)
THAI_SEGMENTER_URL=http://localhost:8100

# LLM judge (optional — enables --judge)
JUDGE_BASE_URL=...
JUDGE_MODEL=...
JUDGE_API_KEY=...
```

---

## Corpus and queries

### Committed
- `queries.json` — 18 authored queries, each with `written` / `spoken` / `codeswitch` variants
  sharing one `target_doc`, across telecom/banking/insurance.
- `scrape-notes.md` — scrape provenance; `scrape/README.md` — the reproducible scrape procedure.

### Gitignored (not redistributed — no open license)
- `datasets/faqs-th/*.jsonl` — scraped FAQ snapshots (AIS / SCB / AIA).
- `datasets/PDFs-th/*.pdf` — policy/T&C distractor PDFs.
- `datasets/benchmark-cache-th/` — extracted PDF text + built corpus.
- `examples/benchmark-thai/results/` — timestamped result JSON.

### Prep (one-time)
```bash
# 1. Scrape FAQs → datasets/faqs-th/*.jsonl   (assisted; see scrape/README.md)
# 2. Download policy PDFs → datasets/PDFs-th/<provider>_<freeform>.pdf, then:
python examples/benchmark-thai/extract_pdfs.py
# 3. Build the corpus cache:
bun run examples/benchmark-thai/buildCorpus.ts
```

---

## Running

```bash
# Headline segmenter sweep: {none,intl,attacut} × {baseline,+rerank}
bun run examples/benchmark-thai/run.ts --seg-matrix

# Smoke test (first 6 queries)
bun run examples/benchmark-thai/run.ts --seg-matrix --limit-queries 6

# Single arm
bun run examples/benchmark-thai/run.ts --segmenter none      # | intl | attacut (default)

# Extension matrix (bm25/vectorchord/rerank, attacut fixed)
bun run examples/benchmark-thai/run.ts --matrix
```

| Flag | Default | Description |
|---|---|---|
| `--seg-matrix` | off | Headline: 3 segmenters × {baseline, +rerank} |
| `--matrix` | off | 5 extension configs (baseline/+bm25/+vectorchord/+rerank/all), attacut fixed |
| `--segmenter none\|intl\|attacut` | `attacut` | Segmenter for a single custom config |
| `--bm25` / `--vectorchord` / `--rerank` | off | Optional legs for a single custom config |
| `--topk N` | 10 | Retrieval depth |
| `--limit-queries N` | all | Run only the first N queries (smoke) |
| `--judge` | off | Opt-in LLM-judge pass over the first ~15 queries (written variant) |

---

## Output

- **Console:** corpus disclosure, per-config tables (overall + by register + by domain + by
  loanword), and a cross-config comparison (segmenter arms side by side, recall@5 by register and
  by loanword slice).
- **`examples/benchmark-thai/results/<timestamp>.json`** — full result bundle (gitignored).

## Notes / honesty

- Thai resolves to the Postgres `'simple'` FTS config (no Thai stemmer exists); the segmenter is
  what makes `'simple'` work for Thai — itself part of what this benchmark demonstrates. No SQL
  migration is added.
- The corpus is chunked with plain `chunk()` (no segmenter), so chunk text — and therefore the
  dense embeddings — are identical across all three segmenter arms; the dense + rerank legs are a
  true control. The segmenter only changes `content_normalized` (the lexical representation) at
  index time and the lexical query at search time.
- `--cjk` is never used (Thai is not CJK; segmenter + pg_trgm is the keyword path).
