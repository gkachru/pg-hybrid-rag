# Design: production Thai segmenter (deepcut HTTP sidecar)

**Date:** 2026-06-24
**Status:** Approved — ready to turn into an implementation plan.
**Scope:** Add a production-grade Thai word segmenter to `examples/`, as a runnable HTTP
sidecar + a `Segmenter` adapter wired into the NestJS example. Playground is untouched.

---

## 1. Why this exists

The injectable `Segmenter` seam (merged to `main`) ships one reference adapter,
`IntlSegmenterAdapter` (stdlib `Intl.Segmenter`). It is zero-dependency but ICU-dictionary
based, so it **shreds Thai loanwords / transliterated English / brand & product names** — the
exact high-value query terms in Thai e-commerce. The examples currently point at "inject a
production segmenter" without showing one. This design fills that gap with a concrete,
runnable production path.

### Decisions made during brainstorming (and why)

- **Backend: deepcut (deep-learning tokenizer) via an HTTP sidecar.** The best Thai
  tokenizers are Python; a Node app reaches them over HTTP — matching the existing
  embedder/reranker DI pattern and keeping the library + Node app zero-dependency. Among
  engines, the user **cannot curate a domain dictionary**, which rules out the cheap
  newmm + custom-lexicon play. deepcut's learned model has the strongest out-of-vocabulary
  (OOV) handling (~0.96 word-seg F1 on BEST2010 vs newmm's ~0.84–0.91), which is precisely
  the loanword/brand strength e-commerce needs. Accepted cost: ~10–40 ms/call on CPU and a
  heavier, TF-based container.
- **Scope: runnable service + adapter, wired into the NestJS example only.** The Python
  sidecar is real and runnable (Dockerfile + compose service); the playground stays on the
  zero-dep `IntlSegmenterAdapter` quick-start (not modified).
- **Failure mode: fail-fast (throw).** Timeout + bounded retries with backoff, then throw —
  on both the index and query paths. Matches the library's deliberately fail-fast parallel
  search design and never silently indexes unsegmented Thai. A sidecar outage means no Thai
  search until it is fixed; that is the accepted, predictable behavior.
- **Own file, not a mutation of `nestjs-rag-module.ts`.** Keeps the zero-dep dev quick-start
  intact and presents the production path as a self-contained drop-in, mirroring how
  `nestjs-search.ts` exports `createReranker` + a service + a usage block.
- **Call `deepcut.tokenize` directly** (not via `pythainlp word_tokenize(engine="deepcut")`)
  — fewer layers, simpler dependency story.

### Speed / quality context (estimates, directional — published ballparks, not measured here)

| Engine | Word-seg F1 | Per-query latency (short string) | OOV handling | Footprint |
|---|---|---|---|---|
| ICU / `Intl.Segmenter` (current reference) | low on Thai | sub-ms, in-process | very weak | zero-dep |
| newmm (dictionary) | ~0.84–0.91 | ~0.1–0.5 ms + HTTP | weak (needs curated dict) | tiny |
| attacut (ML) | ~0.91 | ~2–8 ms + HTTP | better | moderate |
| **deepcut (ML) — chosen** | **~0.96** | **~10–40 ms CPU + HTTP** | **strongest** | **heavy (TensorFlow)** |

HTTP overhead per call (local sidecar, plain HTTP, keep-alive): ~0.5–1.5 ms — a rounding error
next to deepcut's inference cost. Segmentation feeds the **lexical legs only**; the dense
embedding and reranker always see natural (unsegmented) text.

---

## 2. Architecture & components

A Python deepcut sidecar the Node app calls over HTTP. Four pieces:

| Piece | Location | Role |
|---|---|---|
| **deepcut service** | `examples/thai-segmenter/` (`app.py`, `Dockerfile`, `requirements.txt`) | FastAPI app; tokenizes Thai with deepcut, returns space-joined tokens |
| **`HttpThaiSegmenter`** | `examples/nestjs-thai-segmenter.ts` | `Segmenter` adapter: POSTs text; timeout + retry + fail-fast; contract guard |
| **compose service** | `examples/docker-compose.yml` (add `thai-segmenter`) | builds + runs the sidecar with a healthcheck |
| **wiring** | usage block in `nestjs-thai-segmenter.ts` | injecting the same instance into db + pipeline + indexer |
| **smoke test** | `examples/thai-segmenter/smoke.ts` | hits the live container through the adapter; proves the OOV win |

### Data flow

- **Index:** `RagIndexer` / `Chunker.chunkSegmented` → `segment(text, "th")` → `POST /segment`
  → deepcut tokens → space-joined → stored in `content_normalized`; the pg_trgm keyword leg
  matches on segmented content. (Segmenter runs *after* the `Normalizer`.)
- **Query:** `RagPipeline` → `segment(query, "th")` → same path → keyword/FTS legs use the
  segmented query. The dense embedding uses the natural (unsegmented) query.

---

## 3. HTTP contract & Python service

- `GET /health` → `{"status": "ok"}` — returns ready **only after a warmup tokenize** at
  startup. deepcut's TF model loads lazily on first call; warmup avoids a cold first request
  and gates the compose healthcheck so dependents wait for readiness.
- `POST /segment` → `{"texts": ["…", "…"]}` → `{"segmented": ["…", "…"]}`. **Always
  batch-shaped** (array in / array out). The adapter sends a 1-element array for the per-text
  calls the library makes; the endpoint is ready for a batch caller without a second route.
  Order preserved; output array length equals input array length.
- Tokenization: `deepcut.tokenize(text)` → join tokens with a single space, dropping empty /
  whitespace-only tokens. **No normalization** — pure space-insertion (normalization is the
  `Normalizer`'s job, applied before the segmenter).
- `requirements.txt` pins **deepcut + a known-compatible TensorFlow/Keras + fastapi +
  uvicorn**. The `Dockerfile` locks a verified Python + TF version.

### ⚠️ Primary implementation risk: TensorFlow / deepcut version pinning

deepcut rides an older TF/Keras stack and is sensitive to TF major versions and Python
version. The plan must pin a **verified-installable** combination (specific Python base image
+ TF version + deepcut version) and the Dockerfile must lock it. If a clean modern pin proves
infeasible, fallbacks to record in the plan: (a) pin an older Python base (e.g. 3.9) with a
compatible TF; (b) install deepcut via `pythainlp[deepcut]` if that resolves the stack more
reliably. This risk is isolated to the service container; the TS adapter is unaffected.

---

## 4. The `HttpThaiSegmenter` adapter

```ts
new HttpThaiSegmenter({
  baseUrl,                  // http://localhost:8100 (host) | http://thai-segmenter:8000 (compose net)
  languages: ["th"],        // base-subtag gated; passthrough for unlisted languages
  timeoutMs: 5000,          // generous — deepcut is ~10–40ms but cold/queued calls vary
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
  (`stripWhitespace(input) === stripWhitespace(output)`); throw if deepcut altered or dropped
  a character. Enforces the space-insertion contract the `Chunker` relies on — important
  because deepcut is statistical, not structurally grapheme-safe like ICU/newmm.

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
  healthcheck, `restart: unless-stopped`.
- `examples/.env.example` gains `THAI_SEGMENTER_URL=http://localhost:8100`.

---

## 6. Verification

`examples/` is excluded from `tsc --noEmit` and from the mocked test suite, so the gate is:

- **Adapter:** `bun run lint` clean + careful read (repo convention for examples).
- **Service + adapter together:** build the image, run the container, and run a **smoke test**
  (`examples/thai-segmenter/smoke.ts`, run via `bun`) that hits `/health` then `/segment`
  through `HttpThaiSegmenter` against the live container, printing the segmentation of a
  loanword-heavy sample (e.g. a transliterated brand) to demonstrate the OOV win over the ICU
  reference. Using the real adapter (not raw curl) also exercises the timeout/retry path and
  the contract guard.
- **Honesty about environment limits:** building the TensorFlow image may not be feasible in
  the implementation environment. The plan will state explicitly what was verified here
  (Python syntax, Dockerfile correctness, adapter lint + read) vs. what requires the user's
  Docker/podman infra to run, rather than claiming an unrun build passed.

---

## 7. Out of scope / non-goals

- No change to `playground.ts` or the zero-dep `IntlSegmenterAdapter` path.
- No new runtime dependency in the library (`src/`) — the adapter and service live in
  `examples/` only.
- No changes to `src/` or `tests/`. If a real library bug surfaces while writing the example,
  report it rather than fixing it here.
- Not building a curated domain dictionary (explicitly ruled out by the user) — deepcut's
  learned model is the OOV strategy.
- Not wiring deepcut into the playground or the BullMQ reindex example (NestJS module wiring
  only); a future change could exercise it end-to-end through the playground.

---

## 8. File-change summary

| File | Change |
|---|---|
| `examples/nestjs-thai-segmenter.ts` | **new** — `HttpThaiSegmenter` adapter + usage/wiring block |
| `examples/thai-segmenter/app.py` | **new** — FastAPI deepcut service (`/health`, `/segment`) |
| `examples/thai-segmenter/requirements.txt` | **new** — pinned deepcut + TF + fastapi + uvicorn |
| `examples/thai-segmenter/Dockerfile` | **new** — locked Python + TF build |
| `examples/thai-segmenter/smoke.ts` | **new** — live smoke test through the adapter (run via `bun`) |
| `examples/docker-compose.yml` | add `thai-segmenter` service |
| `examples/.env.example` | add `THAI_SEGMENTER_URL` |
| `README.md` (optional) | a short pointer from the "Word segmentation (Thai/CJK)" section to the runnable production example |
