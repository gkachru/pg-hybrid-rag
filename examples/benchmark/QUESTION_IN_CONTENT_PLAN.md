# Handoff: question-in-content A/B (Arabic RAG benchmark)

Context for a fresh session. Goal: measure whether **indexing the FAQ question alongside the
answer** (instead of the answer alone) **lifts the BM25/lexical legs** — and whether it shifts
the fusion/rerank conclusions reached earlier this session.

## Why this experiment

The benchmark queries are **dialectal paraphrases of the FAQ question** (MSA/Saudi/Darija
variants, one target FAQ per query). Today the indexed `content` is the **answer only**, so the
lexical legs (BM25, pg_trgm) must match a *question-paraphrase* against an *answer* — low surface
overlap. That's why BM25 underperformed here (trgm averaged ~5.6 candidates; BM25 only earned its
keep on Darija). Putting the question into the content creates query↔content lexical overlap —
the same property that makes BM25 a strong baseline on MIRACL (whose queries are TyDi-style
elicited from passages, so they share vocabulary with the gold passage). Hypothesis: question-in-
content lifts BM25/trgm substantially, may also help the dense leg, and could change which
fusion/rerank config wins.

Note this is a **more realistic FAQ-RAG setup** (production FAQ systems usually index the curated
question + answer), but it is an *easier* task than answer-only retrieval — treat the two corpora
as separate labeled configurations, not a replacement.

## What's ALREADY DONE in code (committed on `main`, commit 7cdea31)

- **`examples/benchmark/buildCorpus.ts`** — writes two SEPARATE corpus files so neither
  overwrites the other: `corpus.jsonl` (answer-only, default) and `corpus-withq.jsonl`
  (`question\nanswer`). Selected by `--include-question`.
- **`examples/benchmark/run.ts`** — takes `--include-question` to load the q+a corpus
  (`loadOrBuildCorpus(args.includeQuestion)`); logs `Loaded corpus (answer-only|question+answer)`.
- **`corpus-withq.jsonl` is already built** (1380 chunks, faq=163, pdf=1217). `corpus.jsonl` is
  preserved untouched. Both are gitignored under `datasets/benchmark-cache/`. If `corpus-withq.jsonl`
  is missing on the target machine, `run.ts --include-question` auto-builds it from `datasets/faqs/`.
- **`examples/benchmark/question_content_experiment.ps1`** — the ready-to-run orchestration (6 runs).
- run.ts re-indexes the loaded corpus each run (replace-by-source), so switching corpus variants
  between runs needs **no manual DB reset**.

## Environment / bring-up

- **GPU serving = infinity** on `:7997`, **2 models only** (bge-m3 + bge-reranker-v2-m3), torch/cuda,
  `--no-bettertransformer`. Compose: `examples/benchmark/docker-compose.infinity-min.yml`
  (the 2-model variant — the 4-model `docker-compose.infinity.yml` crashed the host GPU driver
  twice this session; the min set frees VRAM headroom).
- **Postgres** = `examples-db-1` (pgvector/vchord/pg_textsearch/pg_bigm). Compose:
  `examples/docker-compose.yml` service `db`.
- Bring up:
  ```
  podman machine start
  podman compose -f examples/docker-compose.yml up -d db
  podman compose -f examples/benchmark/docker-compose.infinity-min.yml up -d --force-recreate
  # confirm: curl http://localhost:7997/models  (expect bge-m3 + bge-reranker-v2-m3; on GPU)
  # confirm it loaded on cuda: podman logs infinity-embed-infinity-1 | grep -i device
  ```
- **GOTCHA — CDI stale after reboot/driver update.** A driver reinstall changes the WSL driver
  hash, so `nvidia.com/gpu=all` fails with `crun: cannot stat .../libcuda.so.1.1`. Fix
  (regenerate both CDI specs, then `--force-recreate` infinity):
  ```
  podman machine ssh "sudo nvidia-ctk cdi generate --mode=wsl --output=/etc/cdi/nvidia.yaml; nvidia-ctk cdi generate --mode=wsl --output=/home/user/.config/cdi/nvidia.yaml"
  podman compose -f examples/benchmark/docker-compose.infinity-min.yml up -d --force-recreate
  ```
- **GPU CRASH CAUTION.** The video driver crashed the whole host twice this session under load.
  The script already runs `SEARCH_CONCURRENCY=2` with the 2-model set. If it crashes again, stop
  and rethink (CPU-only serving, fewer configs) rather than rebooting repeatedly.

## The experiment (run it)

```
pwsh -NoProfile -File examples/benchmark/question_content_experiment.ps1
```
Outputs to `examples/benchmark/results/qcontent/` (per-config `.log` + `_summary.txt`). ~15–18 min
(6 configs, concurrency 2). Background it or run as parent; it's not interactive.

6 runs (bge-m3, full 89q, topK=10, vms=0). Each pairs an **A_** (answer-only) with a **Q_**
(question+answer, via `--include-question`):

| name | corpus | flags | fusion | norm | RC | CM |
|---|---|---|---|---|---|---|
| A_bm25_u30   | answer-only | --bm25 --rerank | rrf    | —      | 30 | 3 |
| A_bm25_lin20 | answer-only | --bm25 --rerank | linear | minmax | 20 | 2 |
| A_lin20      | answer-only | --rerank        | linear | minmax | 20 | 2 |
| Q_bm25_u30   | q+answer    | --bm25 --rerank --include-question | rrf | — | 30 | 3 |
| Q_bm25_lin20 | q+answer    | --bm25 --rerank --include-question | linear | minmax | 20 | 2 |
| Q_lin20      | q+answer    | --rerank --include-question | linear | minmax | 20 | 2 |

## What to measure / the questions

The metric columns in each log are `R@1 R@3 R@5 R@10 MRR10 nDCG`; the per-dialect rows are
`msa / saudi / darija`. For MSA+Saudi (Darija excluded), average the msa and saudi rows
(equal n=89). The `_summary.txt` collects the `custom` (all-dialect) line + the 3 dialect rows.

1. **BM25 lift:** does `Q_bm25_u30` beat `A_bm25_u30`? By how much, and on which dialects? (Expect
   the biggest gain on MSA — closest to the canonical question — then Saudi, then Darija.)
2. **Is the lift BM25-specific or general?** Compare `Q_lin20` vs `A_lin20` (no bm25): if question-
   in-content also lifts the no-bm25 config, the gain is from the dense+trgm legs too, not just BM25.
3. **Does it shift the winner?** Earlier (answer-only) the all-dialect best was `bm25_lin_u20_mm`
   (.797) and the MSA+Saudi best was `lin_u20_mm` (.861, no bm25). Does question-in-content change
   which fusion/bm25 combo wins?
4. **Does BM25 now earn its keep on MSA+Saudi?** Answer-only, bm25 added ~nothing on MSA+Saudi
   (it only helped Darija). With the question in content, does bm25 help MSA+Saudi too?

## Reference numbers (this session, answer-only, bge-m3, full 89q, GPU, fp16, vms=0)

All-dialect nDCG@10 / MSA+Saudi nDCG@10 / Darija nDCG@10:
- bm25_u30 (rrf + bm25, RC30):            .796 / .858 / .673
- bm25_lin_u20_mm (linear + bm25, RC20):  .797 / .858 / .674   ← prior all-dialect best
- lin_u20_mm (linear, no bm25, RC20):     .789 / .861 / .647   ← prior MSA+Saudi best
- (no-rerank baselines: rrf_base .664 all-dialect / .727 MSA+Saudi; linear-minmax .669 / .733)

The `A_*` runs in the script re-derive these in-session, so the A/B is self-contained; they
should land within ~.005 of the above.

## After the run

- Update memory `linear-fusion-vs-rrf-results.md` (and/or a new `question-in-content-results.md`)
  with the BM25 lift and any shift in the winning config. Cross-link
  [[rerank-union-recall-recovery]], [[linear-fusion-vs-rrf-results]].
- If question-in-content materially lifts BM25 / changes the recommendation, note it in the
  README "Recommended configurations" section (FAQ deployments should index the question).
- **Production target = OCI Ampere A1 / Neoverse N1 (CPU-only).** Quality transfers; speed does
  not. If question-in-content makes the lexical legs strong, the cheap no-rerank or smaller-union
  paths may become more viable on N1 — worth checking H2 (skip-rerank) again on the q+answer corpus.

## Decision rule

- If question-in-content lifts BM25 broadly (incl. MSA+Saudi) AND makes a bm25 config the clear
  winner → recommend indexing the FAQ question for FAQ deployments, and re-enabling bm25 by default
  for that setup.
- If the lift is real but Darija-only (like the answer-only bm25 story) → keep bm25 as the
  low-resource-dialect lever, question-in-content as a corpus-construction recommendation.
- If it barely moves (queries already align with answers, or the reranker already saturates) →
  keep answer-only as the realistic-floor benchmark and note question-in-content as optional.
