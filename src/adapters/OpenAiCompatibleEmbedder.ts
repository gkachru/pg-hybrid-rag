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

  constructor(config: OpenAiCompatibleEmbedderConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.queryPrefix = config.queryPrefix ?? "query";
    this.documentPrefix = config.documentPrefix ?? "passage";
    this.batchSize = config.batchSize ?? 32;
    this.concurrency = config.concurrency ?? 1;
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

  private async callApi(input: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input, model: this.model }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Embedding API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return json.data.map((d) => d.embedding);
  }
}
