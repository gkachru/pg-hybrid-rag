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
class EmbeddingApiError extends Error {
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
 * (`{ data: Array<{ embedding: number[] }> }`). Non-retryable: the endpoint is
 * misconfigured or speaks a different protocol, so retrying cannot help.
 */
class EmbeddingResponseError extends Error {
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
    if (!entries.every((d) => Array.isArray(d.embedding))) {
      throw new EmbeddingResponseError("an entry is missing its `embedding` array");
    }
    const ordered = entries as Array<{ embedding: number[]; index?: number }>;
    // The OpenAI embeddings API tags each result with its input `index` and does NOT
    // guarantee `data` is returned in input order. Sort by `index` to keep embeddings
    // aligned with their inputs; fall back to response order if a server omits `index`.
    const sorted = ordered.every((d) => typeof d.index === "number")
      ? [...ordered].sort((a, b) => (a.index as number) - (b.index as number))
      : ordered;
    return sorted.map((d) => d.embedding);
  }
}
