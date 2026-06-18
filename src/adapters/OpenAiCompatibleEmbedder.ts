import type { EmbeddingProvider } from "../interfaces.js";

export interface OpenAiCompatibleEmbedderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Prefix for queries (default: "query") */
  queryPrefix?: string;
  /** Prefix for documents (default: "passage") */
  documentPrefix?: string;
  /** Max texts per embedding API call (default: 32) */
  batchSize?: number;
  /** Max parallel embedding API calls (default: 1) */
  concurrency?: number;
  /** Per-request timeout in ms before the request is aborted (default: 30000). Set 0 to disable. */
  timeoutMs?: number;
  /** Max retry attempts after the first try, on 429/5xx/network/timeout errors (default: 2). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff between retries (default: 250). */
  retryBaseDelayMs?: number;
}

/** Error carrying the HTTP status of a non-OK embedding API response. */
export class EmbeddingApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Embedding API error ${status}: ${body}`);
    this.name = "EmbeddingApiError";
  }
}

/**
 * Error for a 200 response whose body does not match the expected embeddings shape
 * (`{ data: Array<{ embedding: number[] }> }`) or whose `index` fields cannot safely
 * align embeddings to inputs (not a clean 0..n-1 permutation). Non-retryable: the
 * endpoint is misconfigured or speaks a different protocol, so retrying cannot help.
 */
export class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(`Embedding API response error: ${message}`);
    this.name = "EmbeddingResponseError";
  }
}

/** Retry transient failures: rate limits (429), server errors (5xx), network errors, and timeouts. */
function isRetryableError(err: unknown): boolean {
  if (err instanceof EmbeddingApiError) {
    return err.status === 429 || err.status >= 500;
  }
  // A malformed 200 payload is a configuration problem, not a transient one.
  if (err instanceof EmbeddingResponseError) return false;
  // Network failures surface as TypeError; aborted (timed-out) requests as AbortError.
  const name = (err as { name?: string } | null | undefined)?.name;
  return name === "AbortError" || name === "TypeError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch-based embedding provider compatible with OpenAI-style embedding APIs.
 * Works in both Node and Bun runtimes.
 * Applies e5-style prefixes: "query: " for queries, "passage: " for documents.
 */
export class OpenAiCompatibleEmbedder implements EmbeddingProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private queryPrefix: string;
  private documentPrefix: string;
  private batchSize: number;
  private concurrency: number;
  private timeoutMs: number;
  private maxRetries: number;
  private retryBaseDelayMs: number;

  constructor(config: OpenAiCompatibleEmbedderConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.queryPrefix = config.queryPrefix ?? "query";
    this.documentPrefix = config.documentPrefix ?? "passage";
    this.batchSize = config.batchSize ?? 32;
    this.concurrency = config.concurrency ?? 1;
    // !(x > 0) rejects 0, negatives, and NaN — each makes a batching loop's `i += x` spin forever.
    if (!(this.batchSize > 0)) {
      throw new Error(
        `OpenAiCompatibleEmbedder batchSize must be a positive number, got ${this.batchSize}`,
      );
    }
    if (!(this.concurrency > 0)) {
      throw new Error(
        `OpenAiCompatibleEmbedder concurrency must be a positive number, got ${this.concurrency}`,
      );
    }
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 250;
  }

  async embedQuery(text: string): Promise<number[]> {
    const prefixed = `${this.queryPrefix}: ${text}`;
    const [embedding] = await this.callApi([prefixed]);
    return embedding;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const prefixed = texts.map((t) => `${this.documentPrefix}: ${t}`);

    const batches: string[][] = [];
    for (let i = 0; i < prefixed.length; i += this.batchSize) {
      batches.push(prefixed.slice(i, i + this.batchSize));
    }

    const results: number[][][] = [];
    for (let i = 0; i < batches.length; i += this.concurrency) {
      const slice = batches.slice(i, i + this.concurrency);
      const batchResults = await Promise.all(slice.map((b) => this.callApi(b)));
      results.push(...batchResults);
    }

    return results.flat();
  }

  /** Run one request, retrying transient failures with exponential backoff. */
  private async callApi(input: string[]): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetchEmbeddings(input);
      } catch (err) {
        if (attempt >= this.maxRetries || !isRetryableError(err)) throw err;
        await delay(this.retryBaseDelayMs * 2 ** attempt);
      }
    }
  }

  /** A single embedding request, aborted if it exceeds `timeoutMs`. */
  private async fetchEmbeddings(input: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input, model: this.model }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new EmbeddingApiError(res.status, body);
      }

      return this.parseEmbeddings(await res.json(), input.length);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private parseEmbeddings(payload: unknown, expectedCount: number): number[][] {
    // Validate the shape before touching it: a misconfigured endpoint can return 200
    // with an unrelated body (`{ error }`, missing `data`, etc.). Without these guards
    // the `.every`/`.map` calls below throw an opaque TypeError that isRetryableError
    // would treat as transient and retry needlessly.
    const data = (payload as { data?: unknown } | null | undefined)?.data;
    if (!Array.isArray(data)) {
      throw new EmbeddingResponseError("response is missing a `data` array");
    }
    if (data.length !== expectedCount) {
      throw new EmbeddingResponseError(
        `expected ${expectedCount} embedding(s) but received ${data.length}`,
      );
    }
    const entries = data as Array<{ embedding?: unknown; index?: unknown }>;
    const isFiniteNumberArray = (v: unknown): v is number[] =>
      Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n));
    if (!entries.every((d) => isFiniteNumberArray(d.embedding))) {
      // Array.isArray alone lets a string[] (e.g. ["a","b"]) through; it then fails
      // opaquely far downstream when joined into a `[...]::vector` literal at insert time.
      throw new EmbeddingResponseError("an entry's `embedding` is not an array of finite numbers");
    }
    const ordered = entries as Array<{ embedding: number[]; index?: number }>;
    // The OpenAI embeddings API tags each result with its input `index` and does NOT
    // guarantee `data` is returned in input order. We only trust `index` when EVERY
    // entry carries one AND together they form a clean 0..n-1 permutation; then sorting
    // by index re-aligns embeddings with their inputs.
    const indices = ordered.map((d) => d.index);
    const allHaveIndex = indices.every((i) => typeof i === "number");
    const noneHaveIndex = indices.every((i) => i === undefined);
    if (allHaveIndex) {
      // A permutation of 0..n-1 has each integer in range exactly once. Reject
      // duplicate, sparse, or out-of-range indices rather than silently mis-mapping.
      const seen = new Array<boolean>(ordered.length).fill(false);
      for (const i of indices as number[]) {
        if (!Number.isInteger(i) || i < 0 || i >= ordered.length || seen[i]) {
          throw new EmbeddingResponseError("response `index` values are not a 0..n-1 permutation");
        }
        seen[i] = true;
      }
      const sorted = [...ordered].sort((a, b) => (a.index as number) - (b.index as number));
      return sorted.map((d) => d.embedding);
    }
    // A response that tags only SOME entries with `index` is ambiguous (we cannot know
    // where the untagged ones belong), so refuse it; only a fully-untagged response is
    // treated as already in input order.
    if (!noneHaveIndex) {
      throw new EmbeddingResponseError("response mixes indexed and non-indexed entries");
    }
    return ordered.map((d) => d.embedding);
  }
}
