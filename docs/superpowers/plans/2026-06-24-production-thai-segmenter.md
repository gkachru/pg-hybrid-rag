# Production Thai Segmenter (attacut HTTP sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runnable, production-grade Thai word segmenter to `examples/` — a Python attacut HTTP sidecar plus an `HttpThaiSegmenter` adapter implementing the library's `Segmenter` interface, wired into the NestJS example.

**Architecture:** A FastAPI sidecar tokenizes Thai via PyThaiNLP `engine="attacut"` and returns space-joined tokens over a small batch-shaped HTTP contract. A TypeScript `HttpThaiSegmenter` (timeout + retry + fail-fast + space-insertion contract guard) calls it, exactly like the existing HTTP-backed embedder/reranker adapters. The dense embedding and reranker always see natural text; the segmenter feeds only the lexical legs.

**Tech Stack:** TypeScript (Bun, biome), Python 3.11 + FastAPI + uvicorn + PyThaiNLP + attacut (PyTorch CPU), podman/docker compose.

**Spec:** `docs/superpowers/specs/2026-06-24-production-thai-segmenter-design.md`

## Global Constraints

- **No changes to `src/` or `tests/`.** All new code lives under `examples/`. If a real library bug surfaces, report it — do not fix it here.
- **No new runtime dependency in the library.** The adapter + service are examples only; the library stays zero-dependency.
- **`examples/` is lint-gated by biome** (`biome.json` `includes: ["**", ...]`): 2-space indent, lineWidth 100, organized imports. Run `bun run lint:fix` then `bun run lint` — must be clean.
- **`examples/` is excluded from `tsc --noEmit`** (tsconfig `exclude`). `bun run typecheck` will NOT catch type errors in examples — rely on careful reading + lint + the runnable mocked test.
- **Adapter imports the `Segmenter` type only** via `import type { Segmenter } from "pg-hybrid-rag"` (erased at runtime, like `examples/nestjs-search.ts`), so `smoke.ts` and the unit test run via Bun without resolving the package.
- **Failure mode is fail-fast:** timeout + bounded retries with backoff, then **throw** (transient = 429/5xx/network/timeout; non-retryable 4xx and malformed responses throw immediately, no retry).
- **HTTP contract is batch-shaped:** `POST /segment` `{"texts": string[]}` → `{"segmented": string[]}`, order preserved, output length == input length.
- **Segmenter is space-insertion only:** may insert whitespace at word boundaries; must preserve every non-whitespace character in order. The adapter enforces this with a contract guard.
- **Commit trailers (repo convention) end every commit:**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014xGHpBpjaWSfptesCQxd8h
  ```

## File Structure

| File | Responsibility |
|---|---|
| `examples/nestjs-thai-segmenter.ts` | `HttpThaiSegmenter` adapter (`Segmenter` impl) + `HttpThaiSegmenterConfig` + NestJS wiring usage block |
| `examples/thai-segmenter/adapter.test.ts` | Mocked-`fetch` unit tests for the adapter logic (runnable anywhere, no infra) |
| `examples/thai-segmenter/app.py` | FastAPI service: PyThaiNLP `engine="attacut"`, `/health` (warmup-gated) + `/segment` |
| `examples/thai-segmenter/requirements.txt` | Pinned Python deps (torch installed separately from the CPU index in the Dockerfile) |
| `examples/thai-segmenter/Dockerfile` | CPU Python + torch-CPU build |
| `examples/thai-segmenter/smoke.ts` | Live integration smoke test through the adapter against the running container |
| `examples/docker-compose.yml` | Add the `thai-segmenter` service (+ commented GPU opt-in) |
| `examples/.env.example` | Add `THAI_SEGMENTER_URL` |
| `README.md` | Short pointer from the "Word segmentation (Thai/CJK)" section to this runnable example |

**Infra note for the executor:** Task 1 (adapter + mocked test) is fully verifiable in any environment (`bun test`, no network/containers). Tasks 2–3 require `podman` (or `docker`) + network access to build the image (downloads torch/pythainlp/attacut) and run it. If the image cannot be built in your environment, complete the code, lint it, read it carefully, and **state explicitly in your report what was built/run vs. what needs the user's infra** — do not claim an unrun build passed.

---

### Task 1: `HttpThaiSegmenter` adapter (TDD, mocked)

**Files:**
- Create: `examples/nestjs-thai-segmenter.ts`
- Test: `examples/thai-segmenter/adapter.test.ts`

**Interfaces:**
- Consumes: `Segmenter` type from `pg-hybrid-rag` — `{ segment(text: string, language: string): string | Promise<string>; segmentsLanguage(language: string): boolean }`.
- Produces:
  - `class HttpThaiSegmenter implements Segmenter` with `constructor(config: HttpThaiSegmenterConfig)`, `segmentsLanguage(language: string): boolean`, `async segment(text: string, language: string): Promise<string>`.
  - `interface HttpThaiSegmenterConfig { baseUrl: string; languages?: string[]; timeoutMs?: number; maxRetries?: number; retryBaseDelayMs?: number }`.
  - HTTP call shape: `POST {baseUrl}/segment` with body `{"texts": string[]}`, expects `{"segmented": string[]}`.

- [ ] **Step 1: Write the failing tests**

Create `examples/thai-segmenter/adapter.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { HttpThaiSegmenter } from "../nestjs-thai-segmenter";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(url), init ?? {}))) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HttpThaiSegmenter", () => {
  test("passthrough: non-Thai language returns unchanged, no HTTP call", async () => {
    let called = false;
    setFetch(() => {
      called = true;
      return json({ segmented: [""] });
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    expect(await seg.segment("hello world", "en")).toBe("hello world");
    expect(called).toBe(false);
  });

  test("passthrough: blank text returns unchanged", async () => {
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    expect(await seg.segment("   ", "th")).toBe("   ");
  });

  test("segments Thai via POST /segment and returns space-joined tokens", async () => {
    setFetch((url, init) => {
      expect(url).toBe("http://x/segment");
      const body = JSON.parse(init.body as string) as { texts: string[] };
      expect(body.texts).toEqual(["นโยบายการคืนสินค้า"]);
      return json({ segmented: ["นโยบาย การ คืน สินค้า"] });
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    expect(await seg.segment("นโยบายการคืนสินค้า", "th")).toBe("นโยบาย การ คืน สินค้า");
  });

  test("segmentsLanguage matches base subtag", () => {
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    expect(seg.segmentsLanguage("th")).toBe(true);
    expect(seg.segmentsLanguage("th-TH")).toBe(true);
    expect(seg.segmentsLanguage("en")).toBe(false);
  });

  test("contract guard: throws if non-whitespace content changes", async () => {
    setFetch(() => json({ segmented: ["นโยบาย ___ สินค้า"] }));
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    await expect(seg.segment("นโยบายสินค้า", "th")).rejects.toThrow(/contract/i);
  });

  test("retries on 5xx, then succeeds", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return calls === 1 ? json({ error: "boom" }, 503) : json({ segmented: ["ก ข"] });
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x", retryBaseDelayMs: 1 });
    expect(await seg.segment("กข", "th")).toBe("ก ข");
    expect(calls).toBe(2);
  });

  test("throws immediately on non-retryable 4xx (no retry)", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return json({ error: "bad" }, 400);
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x", maxRetries: 3 });
    await expect(seg.segment("กข", "th")).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  test("throws on malformed response shape (no retry)", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return json({ segmented: "not-an-array" });
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x", maxRetries: 3 });
    await expect(seg.segment("กข", "th")).rejects.toThrow(/malformed/i);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test examples/thai-segmenter/adapter.test.ts`
Expected: FAIL — `Cannot find module "../nestjs-thai-segmenter"` (the adapter does not exist yet).

- [ ] **Step 3: Implement the adapter**

Create `examples/nestjs-thai-segmenter.ts`:

```ts
/**
 * Example: production Thai word segmenter for pg-hybrid-rag.
 *
 * Thai has no inter-word spaces, so the lexical legs (pg_trgm keyword + FTS) need word
 * tokens. The zero-dep IntlSegmenterAdapter (stdlib Intl.Segmenter) shipped with the library
 * is ICU-dictionary based and shreds loanwords / transliterated English / brand names — the
 * high-value terms in Thai e-commerce. This adapter calls a small attacut sidecar (a neural
 * Thai tokenizer, run via the maintained PyThaiNLP, on PyTorch) over HTTP — the same
 * dependency-injection shape as the embedder/reranker. See examples/thai-segmenter/ for the
 * service, Dockerfile, and compose entry.
 *
 * The segmenter feeds the LEXICAL legs only — the dense embedding and reranker always see
 * natural (unsegmented) text.
 */
import type { Segmenter } from "pg-hybrid-rag";

export interface HttpThaiSegmenterConfig {
  /** Base URL of the attacut sidecar, e.g. http://localhost:8100. */
  baseUrl: string;
  /** Base language codes to segment (default ["th"]). Matched on the base subtag ("th-TH" → "th"). */
  languages?: string[];
  /** Per-request timeout in ms (default 5000; 0 disables). attacut is ~2–8ms but cold calls vary. */
  timeoutMs?: number;
  /** Retries for transient failures (429/5xx/network/timeout). Default 2. */
  maxRetries?: number;
  /** Exponential backoff base delay in ms (default 250). */
  retryBaseDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const baseSubtag = (language: string): string => (language ?? "").split("-")[0].toLowerCase();
const stripWhitespace = (s: string): string => s.replace(/\s+/g, "");

class ThaiSegmenterHttpError extends Error {
  constructor(readonly status: number) {
    super(`Thai segmenter HTTP ${status}`);
    this.name = "ThaiSegmenterHttpError";
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ThaiSegmenterHttpError) return err.status === 429 || err.status >= 500;
  // AbortError = our timeout; TypeError = fetch network failure. Both transient. A plain Error
  // (malformed response / contract violation) is a server bug, not transient → do not retry.
  if (err instanceof Error) return err.name === "AbortError" || err.name === "TypeError";
  return false;
}

/**
 * Segmenter backed by an HTTP attacut sidecar. Fail-fast: after bounded retries it throws,
 * so a segmenter outage fails Thai search/indexing loudly rather than silently degrading.
 */
export class HttpThaiSegmenter implements Segmenter {
  private readonly baseUrl: string;
  private readonly langs: Set<string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(config: HttpThaiSegmenterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.langs = new Set((config.languages ?? ["th"]).map(baseSubtag));
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 250;
  }

  segmentsLanguage(language: string): boolean {
    return this.langs.has(baseSubtag(language));
  }

  async segment(text: string, language: string): Promise<string> {
    // Passthrough for unhandled languages / blank input — this is the interface contract,
    // not a failure, so it never hits the network.
    if (text.trim() === "" || !this.segmentsLanguage(language)) return text;

    const [out] = await this.callWithRetry([text]);
    // Contract guard: space-insertion only. The segmenter may add whitespace but must preserve
    // every non-whitespace character in order. attacut is statistical (not structurally
    // grapheme-safe like ICU), so verify rather than trust.
    if (stripWhitespace(out) !== stripWhitespace(text)) {
      throw new Error(
        "HttpThaiSegmenter: segmenter altered non-whitespace content (space-insertion contract violation)",
      );
    }
    return out;
  }

  private async callWithRetry(texts: string[]): Promise<string[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.callOnce(texts);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.maxRetries) break;
        await sleep(this.retryBaseDelayMs * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  private async callOnce(texts: string[]): Promise<string[]> {
    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const res = await fetch(`${this.baseUrl}/segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
        signal: controller.signal,
      });
      if (!res.ok) throw new ThaiSegmenterHttpError(res.status);
      const body = (await res.json()) as { segmented?: unknown };
      if (
        !body ||
        !Array.isArray(body.segmented) ||
        body.segmented.length !== texts.length ||
        !body.segmented.every((s) => typeof s === "string")
      ) {
        throw new Error("HttpThaiSegmenter: malformed /segment response");
      }
      return body.segmented as string[];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test examples/thai-segmenter/adapter.test.ts`
Expected: PASS — 8 tests pass.

- [ ] **Step 5: Lint**

Run: `bun run lint:fix && bun run lint`
Expected: "No fixes applied" / clean exit. If imports reorder, that is fine.

- [ ] **Step 6: Confirm the full suite still passes**

Run: `bun test`
Expected: prior 360 pass + the 8 new adapter tests (368 pass), 0 fail. (The new test is mocked — no infra.)

- [ ] **Step 7: Commit**

```bash
git add examples/nestjs-thai-segmenter.ts examples/thai-segmenter/adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(examples): HttpThaiSegmenter adapter for the attacut sidecar

Segmenter implementation that POSTs to an attacut HTTP service: timeout +
bounded retry/backoff, fail-fast on 4xx/malformed, passthrough for non-Thai,
and a space-insertion contract guard. Mocked unit tests (no infra).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014xGHpBpjaWSfptesCQxd8h
EOF
)"
```

---

### Task 2: attacut Python sidecar (service + image)

**Files:**
- Create: `examples/thai-segmenter/app.py`
- Create: `examples/thai-segmenter/requirements.txt`
- Create: `examples/thai-segmenter/Dockerfile`

**Interfaces:**
- Consumes: nothing from earlier tasks (the HTTP contract is the boundary).
- Produces: an HTTP service on container port `8000`:
  - `GET /health` → `{"status": "ok"}` (served only after a startup warmup tokenize).
  - `POST /segment` `{"texts": string[]}` → `{"segmented": string[]}` (space-joined attacut tokens; order + length preserved). This is the contract `HttpThaiSegmenter` (Task 1) calls.

- [ ] **Step 1: Write the FastAPI app**

Create `examples/thai-segmenter/app.py`:

```python
"""Thai word-segmentation sidecar for pg-hybrid-rag.

Tokenizes Thai with attacut (a neural tokenizer) via the maintained PyThaiNLP, and returns
space-joined tokens. Space-insertion only: the original non-whitespace characters are preserved
in order (no normalization — that is the library's Normalizer's job, which runs first).
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel
from pythainlp.tokenize import word_tokenize


def segment_text(text: str) -> str:
    tokens = word_tokenize(text, engine="attacut")
    return " ".join(token for token in tokens if token.strip())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # attacut loads its model lazily on first call. Warm it up during startup so /health only
    # becomes reachable once the model is ready — this gates the compose healthcheck.
    segment_text("สวัสดีครับ")
    yield


app = FastAPI(lifespan=lifespan)


class SegmentRequest(BaseModel):
    texts: list[str]


class SegmentResponse(BaseModel):
    segmented: list[str]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/segment", response_model=SegmentResponse)
def segment(request: SegmentRequest) -> SegmentResponse:
    return SegmentResponse(segmented=[segment_text(t) for t in request.texts])
```

- [ ] **Step 2: Write requirements.txt**

Create `examples/thai-segmenter/requirements.txt` (torch is installed separately from the CPU index in the Dockerfile, so it is intentionally NOT listed here — listing it would pull the multi-GB CUDA wheel from the default index):

```
pythainlp==5.0.5
attacut==1.0.6
nptyping==1.4.4
numpy==1.26.4
fastapi==0.115.6
uvicorn[standard]==0.32.1
```

- [ ] **Step 3: Write the Dockerfile**

Create `examples/thai-segmenter/Dockerfile`:

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install a CPU-only torch FIRST, from the PyTorch CPU index, so the subsequent `attacut`
# install (which depends on torch) sees it already satisfied and does NOT pull the multi-GB
# CUDA wheel from the default index. Then install the rest of the pinned deps.
RUN pip install --no-cache-dir torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 4: Build the image, iterating the pin until it builds**

Run (from `examples/thai-segmenter/`):
```bash
podman build -t pg-hybrid-rag-thai-segmenter:latest .
```
Expected: build succeeds. **If it fails, walk this ladder** (the 2019-vintage attacut is the fragile piece; PyTorch itself is durable) and re-run the build after each change:
1. `attacut` import error mentioning `nptyping` / `NDArray` → it uses the old nptyping API; keep `nptyping==1.4.4`, and if still failing drop to `nptyping==1.0.1`.
2. numpy ABI / `_ARRAY_API not found` against torch → keep `numpy<2` (already `1.26.4`); if torch complains, match numpy to the torch build's supported range.
3. No CPU torch wheel for py3.11 at `2.2.2` → try `torch==2.3.1` then `torch==2.4.1` (same `--index-url .../whl/cpu`).
4. PyThaiNLP cannot resolve the attacut engine → install the extra instead: replace the `attacut==1.0.6` line with nothing and add `pythainlp[attacut]==5.0.5`.
5. Still fighting on 3.11 → change the base image to `python:3.10-slim` and retry from step 1.

Record the final working pin in `requirements.txt` / `Dockerfile`.

- [ ] **Step 5: Run the container and verify the contract**

Run:
```bash
podman run --rm -d --name thai-seg-test -p 8100:8000 pg-hybrid-rag-thai-segmenter:latest
# wait for warmup, then:
sleep 20
curl -s http://localhost:8100/health
curl -s -X POST http://localhost:8100/segment \
  -H 'Content-Type: application/json' \
  -d '{"texts":["นโยบายการคืนสินค้า","หูฟังไร้สายกันน้ำ"]}'
podman stop thai-seg-test
```
Expected:
- `/health` → `{"status":"ok"}`
- `/segment` → `{"segmented":["…spaced Thai tokens…","…spaced Thai tokens…"]}` where stripping spaces from each output equals the corresponding input (space-insertion only).

If you cannot build/run here (no podman/network), say so in your report and proceed — the code is still committed and lint/read-verified.

- [ ] **Step 6: Commit**

```bash
git add examples/thai-segmenter/app.py examples/thai-segmenter/requirements.txt examples/thai-segmenter/Dockerfile
git commit -m "$(cat <<'EOF'
feat(examples): attacut Thai segmentation sidecar (FastAPI + PyThaiNLP)

CPU-only Python service exposing /health (warmup-gated) and a batch-shaped
/segment that tokenizes Thai via PyThaiNLP engine="attacut". torch CPU wheel
installed from the PyTorch CPU index to avoid the CUDA build.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014xGHpBpjaWSfptesCQxd8h
EOF
)"
```

---

### Task 3: Wiring, compose, env, smoke test, and docs

**Files:**
- Modify: `examples/nestjs-thai-segmenter.ts` (append a usage/wiring comment block)
- Create: `examples/thai-segmenter/smoke.ts`
- Modify: `examples/docker-compose.yml` (add the `thai-segmenter` service)
- Modify: `examples/.env.example` (add `THAI_SEGMENTER_URL`)
- Modify: `README.md` (pointer from the Thai/CJK section)

**Interfaces:**
- Consumes: `HttpThaiSegmenter` / `HttpThaiSegmenterConfig` (Task 1); the running `thai-segmenter` service contract (Task 2).
- Produces: a runnable end-to-end example + a `smoke.ts` that asserts health, segmentation, the contract guard, and non-Thai passthrough against the live container.

- [ ] **Step 1: Append the wiring usage block to `examples/nestjs-thai-segmenter.ts`**

Append to the end of the file:

```ts

// --- Wiring (inject the SAME instance into db + pipeline + indexer) ---
//
// import {
//   PostgresRagDatabase,
//   RagPipeline,
//   RagIndexer,
//   Chunker,
// } from "pg-hybrid-rag";
// import { HttpThaiSegmenter } from "./nestjs-thai-segmenter";
//
// // Production Thai segmenter. Run the sidecar from examples/thai-segmenter (see
// // docker-compose.yml). For dev without the sidecar, fall back to the zero-dep
// // IntlSegmenterAdapter({ languages: ["th"] }) — same interface.
// const segmenter = new HttpThaiSegmenter({ baseUrl: process.env.THAI_SEGMENTER_URL! });
//
// const db = new PostgresRagDatabase(txProvider, { segmenter });
// const pipeline = new RagPipeline({ tenantId, db, embedder, stopWords, synonyms, logger, segmenter });
// const indexer = new RagIndexer({ tenantId, db, embedder, logger, segmenter });
//
// // Index Thai: chunkSegmented (async) gives word-aware boundaries; chunk text stays natural.
// const chunker = new Chunker({ tokenLimit: 512, overlap: 75, segmenter });
// const chunks = await chunker.chunkSegmented(thaiText, { language: "th" });
// await indexer.index("faq", faqId, chunks, "th");
//
// // Query Thai: lower vectorMinScore for a multilingual embedder (e.g. BGE-M3) + enable rerank.
// const results = await pipeline.search("หูฟังไร้สายกันน้ำ", { language: "th", vectorMinScore: 0.4, rerank: true });
```

- [ ] **Step 2: Write the live smoke test**

Create `examples/thai-segmenter/smoke.ts`:

```ts
/**
 * Live smoke test for the attacut Thai segmenter sidecar.
 *
 * Start the service first:
 *   cd examples && podman compose up -d thai-segmenter   # or: docker compose up -d thai-segmenter
 *
 * Run (from repo root):
 *   THAI_SEGMENTER_URL=http://localhost:8100 bun run examples/thai-segmenter/smoke.ts
 */
import { HttpThaiSegmenter } from "../nestjs-thai-segmenter";

const baseUrl = process.env.THAI_SEGMENTER_URL ?? "http://localhost:8100";

async function main(): Promise<void> {
  const seg = new HttpThaiSegmenter({ baseUrl });

  const health = await fetch(`${baseUrl}/health`);
  console.log(`/health → ${health.status} ${JSON.stringify(await health.json())}`);
  if (!health.ok) throw new Error("health check failed");

  // A loanword/brand-heavy product line + a native-vocabulary FAQ line.
  const samples = ["หูฟังไร้สายรุ่น Pro กันน้ำ", "นโยบายการคืนสินค้า"];
  for (const s of samples) {
    const out = await seg.segment(s, "th");
    console.log(`\n  in : ${s}\n  out: ${out}`);
    if (out.replace(/\s+/g, "") !== s.replace(/\s+/g, "")) {
      throw new Error("contract violation: non-whitespace content changed");
    }
  }

  const en = await seg.segment("wireless headphones", "en");
  if (en !== "wireless headphones") throw new Error("non-Thai passthrough failed");

  console.log("\n✓ smoke test passed");
}

main().catch((err) => {
  console.error("\n✗ smoke test failed:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the `thai-segmenter` service to `examples/docker-compose.yml`**

Under `services:` (e.g. after the `embedding` service), add:

```yaml
  thai-segmenter:
    build:
      context: ./thai-segmenter
      dockerfile: Dockerfile
    image: pg-hybrid-rag-thai-segmenter:latest
    ports:
      - "8100:8000"
    restart: unless-stopped
    healthcheck:
      # python:3.11-slim has no curl; use urllib so no extra package is needed.
      test:
        [
          "CMD",
          "python",
          "-c",
          "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status==200 else 1)",
        ]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 120s # attacut model warmup on first boot
    # GPU opt-in: this card is Blackwell/sm_120; attacut/PyTorch can use it via a cu128 torch
    # build + CDI passthrough (see examples/benchmark/docker-compose.infinity.yml). To enable,
    # change the Dockerfile's torch install to a cu128 wheel, then uncomment:
    # devices:
    #   - nvidia.com/gpu=all
    # environment:
    #   - LD_LIBRARY_PATH=/usr/lib/wsl/lib
```

- [ ] **Step 4: Add `THAI_SEGMENTER_URL` to `examples/.env.example`**

Append:
```
# Production Thai word segmenter sidecar (examples/thai-segmenter). Optional — only needed for
# Thai content. Host port from docker-compose.yml (8100 → container 8000).
THAI_SEGMENTER_URL=http://localhost:8100
```

- [ ] **Step 5: Add a README pointer**

In `README.md`, in the "Word segmentation (Thai/CJK)" section, just after the "Recommended Thai configuration" block, add:

```markdown

**Runnable production example.** `examples/thai-segmenter/` ships a self-contained attacut
sidecar (FastAPI + PyThaiNLP, CPU) plus `examples/nestjs-thai-segmenter.ts` (`HttpThaiSegmenter`,
an HTTP `Segmenter` with timeout/retry/fail-fast + a space-insertion contract guard). Bring it
up with `docker compose up -d thai-segmenter` and exercise it via
`bun run examples/thai-segmenter/smoke.ts`. attacut is a neural tokenizer (good on loanwords,
no dictionary curation), unlike the ICU-based `IntlSegmenterAdapter`.
```

- [ ] **Step 6: Lint everything**

Run: `bun run lint:fix && bun run lint`
Expected: clean.

- [ ] **Step 7: Run the live smoke test (requires the sidecar)**

Run:
```bash
cd examples && podman compose up -d thai-segmenter && cd ..
# wait for the healthcheck start_period / model warmup
bun run examples/thai-segmenter/smoke.ts
```
Expected: `/health → 200 {"status":"ok"}`, both Thai samples print spaced tokens with the contract holding, passthrough holds, and `✓ smoke test passed`.
If you cannot run the sidecar here, state that in your report; the code is committed + lint-verified.

- [ ] **Step 8: Confirm the full suite + build still pass**

Run: `bun test && bun run lint && bun run build`
Expected: tests pass (368 incl. the adapter tests), lint clean, build OK. (`bun run typecheck` is unaffected — it excludes `examples/`.)

- [ ] **Step 9: Commit**

```bash
git add examples/nestjs-thai-segmenter.ts examples/thai-segmenter/smoke.ts examples/docker-compose.yml examples/.env.example README.md
git commit -m "$(cat <<'EOF'
feat(examples): wire the Thai segmenter sidecar (compose, smoke test, docs)

Add the thai-segmenter compose service (CPU, python-urllib healthcheck, commented
GPU opt-in), THAI_SEGMENTER_URL in .env.example, a NestJS wiring usage block, a live
smoke.ts that drives the adapter against the running sidecar, and a README pointer.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014xGHpBpjaWSfptesCQxd8h
EOF
)"
```

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- §2 architecture (5 pieces): adapter (T1), service+Dockerfile+requirements (T2), compose service + wiring + smoke (T3). ✓
- §3 HTTP contract `/health` warmup-gated + batch `/segment` + no-normalization: T2 app.py. ✓
- §3 dependency-pinning risk + iteration ladder: T2 Step 4. ✓
- §4 adapter (config, base-subtag, passthrough, timeout/retry, fail-fast, contract guard): T1. ✓
- §5 wiring usage block + compose (+ commented GPU opt-in) + `.env`: T3 Steps 1,3,4. ✓
- §6 verification (lint + careful read + live smoke; honesty about infra): T1 Steps 5–6, T2 Step 5, T3 Steps 6–8 + infra notes. ✓
- §7 non-goals (no playground/src/tests changes; no transformer; no dictionary): respected — only `examples/` + `README.md` touched. ✓
- §8 file-change summary: all files have a task. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to". Every code step has full code; every run step has a command + expected output; the T2 iteration ladder lists concrete versions. ✓

**3. Type consistency:** `HttpThaiSegmenter` / `HttpThaiSegmenterConfig`, `segment`, `segmentsLanguage` are named identically in T1 (impl + test), the T3 usage block, and `smoke.ts`. The HTTP contract `{texts}`→`{segmented}` is identical in the adapter (T1), the test mock (T1), `app.py` (T2), and `smoke.ts` (T3). Ports: container 8000, host 8100 consistent across Dockerfile, compose, `.env.example`, smoke default. ✓
