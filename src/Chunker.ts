import type { ChunkingProvider } from "./interfaces.js";
import type { Chunk } from "./types.js";

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP = 75;

/** Safe chars-per-token ratios (base ratio × 0.8 safety margin). */
const CHARS_PER_TOKEN: Map<string, number> = new Map([
  // Latin script (~4 chars/token × 0.8)
  ["en", 3.2],
  ["es", 3.2],
  ["fr", 3.2],
  ["de", 3.2],
  ["it", 3.2],
  ["pt", 3.2],
  ["ro", 3.2],
  ["ms", 3.2],
  // Devanagari (~3 chars/token × 0.8)
  ["hi", 2.4],
  // Arabic (~3 chars/token × 0.8)
  ["ar", 2.4],
  // Sinhala (~3 chars/token × 0.8)
  ["si", 2.4],
  // CJK (~1.5 chars/token × 0.8)
  ["zh", 1.2],
  ["ja", 1.2],
  ["ko", 1.2],
]);

export interface ChunkerConfig {
  /** Max tokens per chunk — char limit is computed per-language using heuristics. */
  tokenLimit: number;
  /** Overlap in characters between chunks (default: 75). */
  overlap?: number;
  /**
   * Return a prefix string to prepend to each chunk, or undefined/empty to skip.
   * Note: the label is prepended AFTER sizing and is NOT counted toward the chunk
   * size limit, so a non-trivial label pushes every chunk that much over the
   * effective char limit. Keep labels short, or leave headroom in `tokenLimit`.
   */
  prefixFn?: (metadata: Record<string, string>) => string | undefined;
}

/**
 * Semantic recursive chunker.
 * Splits on paragraph boundaries first, then sentences, then a hard fixed-size fallback
 * for any sentence with no usable delimiter (long URL, CSV row, terminator-free CJK run),
 * so no chunk is emitted uncapped and silently truncated server-side by the embedding API.
 * Overlap prepends the tail of the previous chunk to the next for context continuity.
 *
 * At the paragraph and sentence levels the size limit is a soft target: a near-limit
 * paragraph plus the prepended overlap (and any `prefixFn` label) can yield a chunk
 * slightly larger than the effective char limit, so still leave headroom when choosing
 * `tokenLimit` / chunk size.
 */
export class Chunker implements ChunkingProvider {
  private chunkSize: number | undefined;
  private tokenLimit: number | undefined;
  private overlap: number;
  private prefixFn: ((metadata: Record<string, string>) => string | undefined) | undefined;

  constructor(config: ChunkerConfig);
  constructor(chunkSize?: number, overlap?: number);
  constructor(configOrSize?: ChunkerConfig | number, overlap?: number) {
    if (typeof configOrSize === "object" && configOrSize !== null && "tokenLimit" in configOrSize) {
      // !(x > 0) rejects 0, negatives, and NaN — all of which yield effectiveSize 0 and emit
      // empty/one-code-point-per-chunk garbage downstream. Fail loudly at construction instead.
      if (!(configOrSize.tokenLimit > 0)) {
        throw new Error(
          `Chunker tokenLimit must be a positive number, got ${configOrSize.tokenLimit}`,
        );
      }
      this.tokenLimit = configOrSize.tokenLimit;
      this.chunkSize = undefined;
      this.overlap = configOrSize.overlap ?? DEFAULT_OVERLAP;
      this.prefixFn = configOrSize.prefixFn;
    } else {
      const size = (configOrSize as number | undefined) ?? DEFAULT_CHUNK_SIZE;
      if (!(size > 0)) {
        throw new Error(`Chunker chunkSize must be a positive number, got ${size}`);
      }
      this.chunkSize = size;
      this.tokenLimit = undefined;
      this.overlap = overlap ?? DEFAULT_OVERLAP;
      this.prefixFn = undefined;
    }
  }

  /** Compute effective char limit for a language. */
  private getCharLimit(language?: string): number {
    if (this.chunkSize != null) return this.chunkSize;
    const limit = this.tokenLimit ?? DEFAULT_CHUNK_SIZE;
    if (!language) return limit;
    const base = language.split("-")[0].toLowerCase();
    const ratio = CHARS_PER_TOKEN.get(base);
    return ratio ? Math.floor(limit * ratio) : limit;
  }

  /**
   * Extract last ~N chars aligned to a word boundary for overlap.
   * Returns empty string if overlap is 0 or text is shorter than overlap.
   */
  private getOverlapSuffix(text: string): string {
    if (this.overlap <= 0 || text.length <= this.overlap) return "";
    let raw = text.slice(-this.overlap);
    // slice(-overlap) cuts on a UTF-16 code unit, so it can begin on the low half
    // of a surrogate pair for the astral/CJK text this library targets. Drop the
    // orphaned low surrogate so a lone surrogate is never carried into the next chunk.
    const first = raw.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) raw = raw.slice(1);
    const spaceIdx = raw.indexOf(" ");
    return spaceIdx >= 0 ? raw.slice(spaceIdx + 1) : raw;
  }

  chunk(text: string, metadata: Record<string, string> = {}): Chunk[] {
    if (!text.trim()) return [];

    const effectiveSize = this.getCharLimit(metadata.language);

    // Split by paragraphs first
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());

    const chunks: Chunk[] = [];
    let buffer = "";
    let chunkIndex = 0;

    for (const para of paragraphs) {
      if (buffer.length + para.length + 1 <= effectiveSize) {
        buffer = buffer ? `${buffer}\n\n${para}` : para;
      } else {
        // Flush buffer if it has content
        if (buffer) {
          chunks.push({ content: buffer.trim(), index: chunkIndex++, metadata });
          const suffix = this.getOverlapSuffix(buffer.trim());
          buffer = suffix;
        }

        // If paragraph itself is too long, split by sentences
        if (para.length > effectiveSize) {
          const sentenceChunks = this.splitBySentences(para, metadata, chunkIndex, effectiveSize);
          chunks.push(...sentenceChunks);
          chunkIndex += sentenceChunks.length;
          // Carry overlap from last sentence chunk
          if (sentenceChunks.length > 0) {
            buffer = this.getOverlapSuffix(sentenceChunks[sentenceChunks.length - 1].content);
          } else {
            buffer = "";
          }
        } else {
          buffer = buffer ? `${buffer} ${para}` : para;
        }
      }
    }

    if (buffer.trim()) {
      chunks.push({ content: buffer.trim(), index: chunkIndex, metadata });
    }

    // Prefix subsequent chunks with product name so each chunk is self-identifying
    return this.prefixChunks(chunks);
  }

  private prefixChunks(chunks: Chunk[]): Chunk[] {
    if (!this.prefixFn || chunks.length === 0) return chunks;
    const label = this.prefixFn(chunks[0].metadata);
    if (!label) return chunks;
    return chunks.map((c) =>
      c.content.startsWith(label) ? c : { ...c, content: `${label} ${c.content}` },
    );
  }

  private splitBySentences(
    text: string,
    metadata: Record<string, string>,
    startIndex: number,
    effectiveSize: number,
  ): Chunk[] {
    const sentences = text.split(/(?<=[.!?।。！？])\s+/);
    const chunks: Chunk[] = [];
    let buffer = "";
    let idx = startIndex;

    for (const sentence of sentences) {
      if (buffer.length + sentence.length + 1 <= effectiveSize) {
        buffer = buffer ? `${buffer} ${sentence}` : sentence;
        continue;
      }

      // Flush the buffer first so the oversized sentence starts fresh.
      let pending = sentence;
      if (buffer) {
        chunks.push({ content: buffer.trim(), index: idx++, metadata });
        const suffix = this.getOverlapSuffix(buffer.trim());
        pending = suffix ? `${suffix} ${sentence}` : sentence;
      }

      // Hard fixed-size fallback: a single sentence with no usable delimiter
      // (long URL, CSV row, terminator-free CJK run) is sliced to the limit so it
      // is never emitted uncapped and silently truncated by the embedding API.
      if (pending.length > effectiveSize) {
        buffer = this.splitFixedSize(pending, effectiveSize, (content) => {
          chunks.push({ content, index: idx++, metadata });
        });
      } else {
        buffer = pending;
      }
    }

    if (buffer.trim()) {
      chunks.push({ content: buffer.trim(), index: idx, metadata });
    }

    return chunks;
  }

  /**
   * Hard fixed-size slice for text with no usable delimiter. Emits the content of every
   * complete `effectiveSize`-bounded slice via `emit` and returns the trailing remainder
   * for the caller to merge with following content. Slices are taken on whole code points
   * (so a surrogate pair is not split), and the configured overlap is carried from each
   * slice into the next.
   */
  private splitFixedSize(
    text: string,
    effectiveSize: number,
    emit: (content: string) => void,
  ): string {
    const codePoints = Array.from(text);
    let slice = "";
    for (const cp of codePoints) {
      if (slice.length + cp.length > effectiveSize) {
        emit(slice.trim());
        // Seed the next slice with overlap, capped so it cannot consume the whole
        // budget (which would stall forward progress).
        const overlap = this.getOverlapSuffix(slice);
        slice = overlap.length < effectiveSize ? overlap : "";
      }
      slice += cp;
    }
    return slice;
  }
}
