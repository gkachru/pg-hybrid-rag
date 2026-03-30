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
}

/**
 * Semantic recursive chunker.
 * Splits on paragraph boundaries first, then sentences, then fixed size.
 * Overlap prepends the tail of the previous chunk to the next for context continuity.
 */
export class Chunker {
  private chunkSize: number | undefined;
  private tokenLimit: number | undefined;
  private overlap: number;

  constructor(config: ChunkerConfig);
  constructor(chunkSize?: number, overlap?: number);
  constructor(configOrSize?: ChunkerConfig | number, overlap?: number) {
    if (typeof configOrSize === "object" && configOrSize !== null && "tokenLimit" in configOrSize) {
      this.tokenLimit = configOrSize.tokenLimit;
      this.chunkSize = undefined;
      this.overlap = configOrSize.overlap ?? DEFAULT_OVERLAP;
    } else {
      this.chunkSize = (configOrSize as number | undefined) ?? DEFAULT_CHUNK_SIZE;
      this.tokenLimit = undefined;
      this.overlap = overlap ?? DEFAULT_OVERLAP;
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
    const raw = text.slice(-this.overlap);
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

  /**
   * Prepend `[Name | Brand]` to chunks that don't already start with `Product: <name>`.
   * Only applies when metadata contains a `name` field (i.e. product chunks).
   */
  private prefixChunks(chunks: Chunk[]): Chunk[] {
    const name = chunks[0]?.metadata.name;
    if (!name) return chunks;
    const brand = chunks[0]?.metadata.brand;
    const label = brand ? `[${name} | ${brand}]` : `[${name}]`;

    return chunks.map((c) => {
      if (c.content.startsWith(name)) return c;
      return { ...c, content: `${label} ${c.content}` };
    });
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
      } else {
        if (buffer) {
          chunks.push({ content: buffer.trim(), index: idx++, metadata });
          const suffix = this.getOverlapSuffix(buffer.trim());
          buffer = suffix ? `${suffix} ${sentence}` : sentence;
        } else {
          buffer = sentence;
        }
      }
    }

    if (buffer.trim()) {
      chunks.push({ content: buffer.trim(), index: idx, metadata });
    }

    return chunks;
  }
}
