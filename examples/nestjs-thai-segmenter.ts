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
