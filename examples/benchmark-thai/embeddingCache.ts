import type { EmbeddingProvider } from "../../src/index.js";

/**
 * Wrap an embedder with an in-memory cache keyed by exact text, so a chunk or query
 * embedded once (e.g. across a --matrix sweep that re-indexes the same corpus) is not
 * re-embedded. Returns vectors in input order.
 */
/**
 * Wrap an async function so calls run one at a time, in call order. Infinity merges concurrent
 * requests into one GPU batch, and a text's embedding (and likely a rerank score) shifts slightly
 * with what else is in its batch: for bge-m3, a query embedded alone vs in a batch differed by
 * max |delta| 0.0019 (cosine 0.99994), while embedding it alone twice was bit-identical. With
 * searches running concurrently that moved near-tied results by a rank between runs. Sending
 * requests one at a time keeps every run's vectors and scores identical.
 */
export function serialized<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const run = tail.then(() => fn(...args));
    tail = run.catch(() => undefined);
    return run;
  };
}

export function withEmbeddingCache(inner: EmbeddingProvider): EmbeddingProvider {
  const cache = new Map<string, number[]>();
  // One request at a time (see serialized), so batch composition is the same on every run.
  const embedBatch = serialized((texts: string[]) => inner.embedDocuments(texts));

  async function embedDocuments(texts: string[]): Promise<number[][]> {
    const missing: string[] = [];
    for (const t of texts) {
      if (!cache.has(t) && !missing.includes(t)) missing.push(t);
    }
    if (missing.length > 0) {
      const fresh = await embedBatch(missing);
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
