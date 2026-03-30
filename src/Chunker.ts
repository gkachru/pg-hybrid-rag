import type { Chunk } from "./types.js";

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP = 75;

/**
 * Semantic recursive chunker.
 * Splits on paragraph boundaries first, then sentences, then fixed size.
 * Overlap prepends the tail of the previous chunk to the next for context continuity.
 */
export class Chunker {
  private chunkSize: number;
  private overlap: number;

  constructor(chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP) {
    this.chunkSize = chunkSize;
    this.overlap = overlap;
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

    // Split by paragraphs first
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());

    const chunks: Chunk[] = [];
    let buffer = "";
    let chunkIndex = 0;

    for (const para of paragraphs) {
      if (buffer.length + para.length + 1 <= this.chunkSize) {
        buffer = buffer ? `${buffer}\n\n${para}` : para;
      } else {
        // Flush buffer if it has content
        if (buffer) {
          chunks.push({ content: buffer.trim(), index: chunkIndex++, metadata });
          const suffix = this.getOverlapSuffix(buffer.trim());
          buffer = suffix;
        }

        // If paragraph itself is too long, split by sentences
        if (para.length > this.chunkSize) {
          const sentenceChunks = this.splitBySentences(para, metadata, chunkIndex);
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
  ): Chunk[] {
    const sentences = text.split(/(?<=[.!?।。！？])\s+/);
    const chunks: Chunk[] = [];
    let buffer = "";
    let idx = startIndex;

    for (const sentence of sentences) {
      if (buffer.length + sentence.length + 1 <= this.chunkSize) {
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
