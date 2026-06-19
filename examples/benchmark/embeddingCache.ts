import type { EmbeddingProvider } from "../../src/index.js";

/**
 * Wrap an embedder with an in-memory cache keyed by exact text, so a chunk or query
 * embedded once (e.g. across a --matrix sweep that re-indexes the same corpus) is not
 * re-embedded. Returns vectors in input order.
 */
export function withEmbeddingCache(inner: EmbeddingProvider): EmbeddingProvider {
  const cache = new Map<string, number[]>();

  async function embedDocuments(texts: string[]): Promise<number[][]> {
    const missing: string[] = [];
    for (const t of texts) {
      if (!cache.has(t) && !missing.includes(t)) missing.push(t);
    }
    if (missing.length > 0) {
      const fresh = await inner.embedDocuments(missing);
      for (let i = 0; i < missing.length; i++) {
        cache.set(missing[i], fresh[i]);
      }
    }
    return texts.map((t) => cache.get(t) as number[]);
  }

  async function embedQuery(text: string): Promise<number[]> {
    const hit = cache.get(text);
    if (hit) return hit;
    const [vec] = await embedDocuments([text]);
    return vec;
  }

  return { embedQuery, embedDocuments };
}
