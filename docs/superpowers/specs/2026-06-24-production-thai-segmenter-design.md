# Design: production Thai segmenter (attacut HTTP sidecar)

**Date:** 2026-06-24
**Status:** Approved — ready to turn into an implementation plan.
**Scope:** Add a production-grade Thai word segmenter to `examples/`, as a runnable HTTP
sidecar + a `Segmenter` adapter wired into the NestJS example. Playground is untouched.

> Engine history: this started as a deepcut design. Production research (below) showed deepcut
> is unmaintained + TensorFlow-fragile + cannot use this machine's GPU, so the engine was
> changed to **attacut**. The HTTP-sidecar architecture, the `HttpThaiSegmenter` adapter, and
> the wiring are unchanged; only the service internals and rationale differ.

---

## 1. Why this exists

The injectable `Segmenter` seam (merged to `main`) ships one reference adapter,
`IntlSegmenterAdapter` (stdlib `Intl.Segmenter`). It is zero-dependency but ICU-dictionary
based, so it **shreds Thai loanwords / transliterated English / brand & product names** — the
exact high-value query terms in Thai e-commerce. The examples point at "inject a production
segmenter" without showing one. This design fills that gap with a concrete, runnable
production path.

### Engine choice: attacut (and why not the alternatives)

Constraint from the user: **a curated domain dictionary is off the table**, so the segmenter
must handle out-of-vocabulary (OOV) terms by *learning* boundaries, not by dictionary lookup.
Production research into what Thai systems actually deploy (2026) surfaced a clear
accuracy↔maintenance frontier with no free lunch:

| Engine | Framework | WL-F1 (BEST2010, ~published) | Maintained? | Runs on this sm_120 GPU? |
|---|---|---|---|---|
| ICU / Elasticsearch-Thai / `Intl.Segmenter` | dict (Java/ICU) | low on Thai | yes | n/a |
| PyThaiNLP newmm / nlpo3 (Rust) | dict (Py/Rust) | ~0.71–0.83 | **yes** | n/a (CPU, fast) |
| **attacut — chosen** | **PyTorch** | **~0.91** | framework alive; pkg frozen 2019 | **yes** (torch cu128) |
| deepcut | TensorFlow | ~0.93–0.96 | **no** (2019/2020) | **no** (TF lacks sm_120) |
| SEFR-CUT (*wraps deepcut*) | TF | ~0.956 | **no** (EMNLP 2020) | **no** (inherits deepcut) |
| WangchanBERTa transformer token-classifier | PyTorch/HF | SOTA-ish | **yes** | yes (heavy) |

- **deepcut / SEFR-CUT** lead classic accuracy but are **unmaintained** (deepcut: last release
  2019-11, last commit 2020-10; SEFR-CUT depends on deepcut so inherits everything). Their
  TensorFlow stack also has **no sm_120 (Blackwell) kernels**, so a GPU build hits the same
  `CUDA_ERROR_NO_DEVICE` wall that broke TEI/candle here, and `tensorflow>=2.0.0`'s open bound
  forces tight pins (TF<2.16 to avoid the Keras-3 break, numpy<2, frozen old Python).
- **newmm / nlpo3** are maintained (PyThaiNLP v5.3.1) and fast — nlpo3 even has a Node binding —
  but they are **dictionary-class**, i.e. exactly the OOV weakness ruled out.
- **attacut** is the frontier point that fits all three needs: **neural** (learned OOV handling,
  no dictionary), on a **durable, maintained framework** (PyTorch; built by the PyThaiNLP team
  as the maintainable/faster successor to deepcut — "6× faster than deepcut, ~2% lower F1"),
  and **GPU-capable on this card** (PyTorch cu128 ships sm_120 kernels). Cost: ~0.05 F1 below
  deepcut — an acceptable trade for the maintenance + infra story.
- **WangchanBERTa-class transformers** are the modern SOTA-ish, GPU-justified upgrade path,
  recorded as a non-goal here (heavier sidecar) but noted for the future.

### Other decisions (carried over, still valid)

- **Backend shape: an HTTP sidecar.** The strong Thai tokenizers are Python; a Node app reaches
  them over HTTP — matching the existing embedder/reranker DI pattern and keeping the library +
  Node app zero-dependency.
- **Run attacut via PyThaiNLP** (`word_tokenize(engine="attacut")`) rather than the raw
  `attacut` package. PyThaiNLP is actively maintained and gives a tested dependency matrix +
  trivial engine-swapping; the cost is pulling `pythainlp` alongside `attacut` + `torch`. (Raw
  `attacut` is the lighter alternative if the PyThaiNLP layer causes friction — recorded as a
  plan fallback.)
- **Sidecar defaults to CPU; GPU is an opt-in.** attacut is light and fast on CPU, and a
  segmenter is called per short string serially on the query hot path where GPU batching barely
  helps (it would mainly speed bulk indexing). The GPU is better spent on the embedder/reranker
  (infinity). So the service pins a **CPU** torch wheel by default; a **documented GPU opt-in**
  (CDI `nvidia.com/gpu=all` + `LD_LIBRARY_PATH=/usr/lib/wsl/lib`, per `examples/benchmark`) is
  available for bulk-index throughput — and unlike deepcut, attacut genuinely runs on this GPU.
- **Scope: runnable service + adapter, wired into the NestJS example only.** The playground
  stays on the zero-dep `IntlSegmenterAdapter` quick-start (not modified).
- **Failure mode: fail-fast (throw).** Timeout + bounded retries with backoff, then throw — on
  both index and query paths. Matches the library's fail-fast parallel search design and never
  silently indexes unsegmented Thai. A sidecar outage means no Thai search until fixed; that is
  the accepted, predictable behavior.
- **Own file, not a mutation of `nestjs-rag-module.ts`** — keeps the zero-dep dev quick-start
  intact and presents the production path as a self-contained drop-in (mirrors how
  `nestjs-search.ts` exports `createReranker` + a service + a usage block).

HTTP overhead per call (local sidecar, plain HTTP, keep-alive): ~0.5–1.5 ms. attacut compute is
~2–8 ms CPU per short query, so per-query latency is ~3–10 ms — noise next to the embedder +
3 DB legs + optional rerank. Segmentation feeds the **lexical legs only**; the dense embedding
and reranker always see natural (unsegmented) text.

---

## 2. Architecture & components

A Python attacut sidecar the Node app calls over HTTP. Five pieces:

| Piece | Location | Role |
|---|---|---|
| **attacut service** | `examples/thai-segmenter/` (`app.py`, `Dockerfile`, `requirements.txt`) | FastAPI app; tokenizes Thai via PyThaiNLP `engine="attacut"`, returns space-joined tokens |
| **`HttpThaiSegmenter`** | `examples/nestjs-thai-segmenter.ts` | `Segmenter` adapter: POSTs text; timeout + retry + fail-fast; contract guard |
| **compose service** | `examples/docker-compose.yml` (add `thai-segmenter`) | builds + runs the sidecar with a healthcheck (CPU; GPU opt-in commented) |
| **wiring** | usage block in `nestjs-thai-segmenter.ts` | injecting the same instance into db + pipeline + indexer |
| **smoke test** | `examples/thai-segmenter/smoke.ts` (run via `bun`) | hits the live container through the adapter; proves the OOV win |

### Data flow

- **Index:** `RagIndexer` / `Chunker.chunkSegmented` → `segment(text, "th")` → `POST /segment`
  → attacut tokens → space-joined → stored in `content_normalized`; the pg_trgm keyword leg
  matches on segmented content. (Segmenter runs *after* the `Normalizer`.)
- **Query:** `RagPipeline` → `segment(query, "th")` → same path → keyword/FTS legs use the
  segmented query. The dense embedding uses the natural (unsegmented) query.

---

## 3. HTTP contract & Python service

- `GET /health` → `{"status": "ok"}` — returns ready **only after a warmup tokenize** at
  startup. PyThaiNLP loads the attacut model lazily on first call; warmup avoids a cold first
  request and gates the compose healthcheck so dependents wait for readiness.
- `POST /segment` → `{"texts": ["…", "…"]}` → `{"segmented": ["…", "…"]}`. **Always
  batch-shaped** (array in / array out). The adapter sends a 1-element array for the per-text
  calls the library makes; the endpoint is ready for a batch caller without a second route.
  Order preserved; output array length equals input array length.
- Tokenization: `pythainlp.tokenize.word_tokenize(text, engine="attacut")` → join tokens with a
  single space, dropping empty / whitespace-only tokens. **No normalization** — pure
  space-insertion (normalization is the `Normalizer`'s job, applied before the segmenter).
- `requirements.txt` pins **pythainlp + attacut + a CPU torch wheel + fastapi + uvicorn** (plus
  whatever attacut transitively needs, e.g. a compatible numpy). The `Dockerfile` locks a
  verified Python + torch-CPU version.

### Dependency-pinning risk (moderate, much lower than the TF path)

attacut's package is frozen at 2019 (`torch>=1.2.0`, open bound), so the plan must pin a
**verified-installable** combination (Python base + CPU torch version + pythainlp + attacut +
numpy). PyTorch's cross-version backward-compat is good, so this is far less brittle than the
TF/Keras-3 situation deepcut would have imposed — a clean CPU build is expected to be
achievable, and the plan will iterate the pin against a real `podman` build until attacut
imports and segments. Fallback if PyThaiNLP's layer fights the pin: call the raw `attacut`
package directly. GPU opt-in swaps the CPU torch wheel for a `cu128` build + CDI passthrough.

---

## 4. The `HttpThaiSegmenter` adapter

```ts
new HttpThaiSegmenter({
  baseUrl,                  // http://localhost:8100 (host) | http://thai-segmenter:8000 (compose net)
  languages: ["th"],        // base-subtag gated; passthrough for unlisted languages
  timeoutMs: 5000,          // generous — attacut is ~2–8ms but cold/queued calls vary
  maxRetries: 2,            // retry 429 / 5xx / network / timeout with exponential backoff
  retryBaseDelayMs: 250,
});
```

- `segmentsLanguage(l)` — base-subtag match (`"th-TH"` → `"th"`). Routing only; never segments.
- `segment(text, lang)` — empty text or unhandled language → return `text` unchanged
  (interface passthrough, *not* a failure). Otherwise `POST /segment` with an
  `AbortController` timeout + retry-with-backoff; **throw on final failure or non-retryable
  4xx** (fail-fast). Mirrors `OpenAiCompatibleEmbedder`'s resilience structure (transient =
  429/5xx/network/timeout; 4xx = fail fast; validate response shape and array length).
- **Contract guard:** after segmenting, assert non-whitespace characters are preserved
  (`stripWhitespace(input) === stripWhitespace(output)`); throw if the model altered or dropped
  a character. Enforces the space-insertion contract the `Chunker` relies on — important because
  any neural segmenter (attacut included) is statistical, not structurally grapheme-safe like
  ICU/newmm.

### Config interface (illustrative)

```ts
interface HttpThaiSegmenterConfig {
  baseUrl: string;
  languages?: string[];       // default ["th"]
  timeoutMs?: number;         // default 5000; 0 disables
  maxRetries?: number;        // default 2
  retryBaseDelayMs?: number;  // default 250
}
```

---

## 5. Wiring, compose, and env

- Usage block in `nestjs-thai-segmenter.ts` shows constructing one `HttpThaiSegmenter` and
  injecting the **same instance** into `db` + `pipeline` + `indexer`, with a note that
  `IntlSegmenterAdapter` is the zero-dep dev fallback. Cross-references `chunkSegmented` for
  index-time word-aware boundaries.
- `examples/docker-compose.yml` gains a `thai-segmenter` service: build from
  `./thai-segmenter`, host port `8100:8000`, `curl -f http://localhost:8000/health`
  healthcheck, `restart: unless-stopped`. A **commented GPU opt-in** block shows the CDI
  passthrough (`devices: [nvidia.com/gpu=all]` + `LD_LIBRARY_PATH=/usr/lib/wsl/lib` + a `cu128`
  torch build), cross-referencing `examples/benchmark`.
- `examples/.env.example` gains `THAI_SEGMENTER_URL=http://localhost:8100`.

---

## 6. Verification

`examples/` is excluded from `tsc --noEmit` and from the mocked test suite, so the gate is:

- **Adapter:** `bun run lint` clean + careful read (repo convention for examples).
- **Service + adapter together:** build the image (`podman compose`), run the container, and run
  a **smoke test** (`examples/thai-segmenter/smoke.ts`, run via `bun`) that hits `/health` then
  `/segment` through `HttpThaiSegmenter` against the live container, printing the segmentation of
  a loanword-heavy sample (e.g. a transliterated brand) to demonstrate the OOV win over the ICU
  reference. Using the real adapter (not raw curl) also exercises the timeout/retry path and the
  contract guard.
- **Honesty about environment limits:** the CPU torch image is buildable under `podman` in this
  Windows/WSL env, so the plan will *attempt* a real build + smoke run and iterate the version
  pin. If the build proves infeasible here, the plan will state explicitly what was verified
  (Python syntax, Dockerfile correctness, adapter lint + read) vs. what needs the user's infra,
  rather than claiming an unrun build passed.

---

## 7. Out of scope / non-goals

- No change to `playground.ts` or the zero-dep `IntlSegmenterAdapter` path.
- No new runtime dependency in the library (`src/`) — the adapter and service live in
  `examples/` only.
- No changes to `src/` or `tests/`. If a real library bug surfaces while writing the example,
  report it rather than fixing it here.
- Not building a curated domain dictionary (explicitly ruled out by the user) — attacut's
  learned model is the OOV strategy.
- Not a transformer (WangchanBERTa-class) tokenizer — recorded as the future SOTA/GPU upgrade,
  out of scope for this example.
- Not wiring the segmenter into the playground or the BullMQ reindex example (NestJS module
  wiring only); a future change could exercise it end-to-end through the playground.

---

## 8. File-change summary

| File | Change |
|---|---|
| `examples/nestjs-thai-segmenter.ts` | **new** — `HttpThaiSegmenter` adapter + usage/wiring block |
| `examples/thai-segmenter/app.py` | **new** — FastAPI service: PyThaiNLP `engine="attacut"` (`/health`, `/segment`) |
| `examples/thai-segmenter/requirements.txt` | **new** — pinned pythainlp + attacut + CPU torch + fastapi + uvicorn |
| `examples/thai-segmenter/Dockerfile` | **new** — locked CPU Python + torch build (GPU opt-in documented) |
| `examples/thai-segmenter/smoke.ts` | **new** — live smoke test through the adapter (run via `bun`) |
| `examples/docker-compose.yml` | add `thai-segmenter` service (+ commented GPU opt-in) |
| `examples/.env.example` | add `THAI_SEGMENTER_URL` |
| `README.md` (optional) | a short pointer from the "Word segmentation (Thai/CJK)" section to the runnable production example |
