import type { Segmenter } from "../interfaces.js";

export interface IntlSegmenterAdapterConfig {
  /**
   * Base language codes to word-segment (e.g. ["th", "zh", "ja"]). Any language NOT in
   * this list is returned unchanged by segment(). Matched on the base subtag (before "-"),
   * so "th" covers "th-TH".
   */
  languages: string[];
}

/** Base subtag, lowercased (e.g. "th-TH" → "th"). */
function base(language: string): string {
  return (language ?? "").split("-")[0].toLowerCase();
}

/**
 * Optional zero-dependency Segmenter backed by the runtime's stdlib Intl.Segmenter
 * (works on Node and Bun). Inserts a single space between word-granularity segments.
 *
 * LIMITATION: segmentation quality depends on the host ICU break dictionary. ICU's Thai
 * dictionary segments native vocabulary reasonably but SHREDS loanwords not in its
 * dictionary — verified identical on Node 24 (full ICU) and Bun 1.3. For loanword-heavy
 * domains this is a runnable reference, not production-grade; inject a dictionary-based
 * (PyThaiNLP-newmm) or ML (deepcut/attacut) or HTTP segmenter for those.
 */
export class IntlSegmenterAdapter implements Segmenter {
  private readonly langs: Set<string>;
  private readonly cache = new Map<string, Intl.Segmenter>();

  constructor(config: IntlSegmenterAdapterConfig) {
    this.langs = new Set(config.languages.map(base));
  }

  segmentsLanguage(language: string): boolean {
    return this.langs.has(base(language));
  }

  segment(text: string, language: string): string {
    if (text.trim() === "" || !this.segmentsLanguage(language)) return text;
    const seg = this.getSegmenter(base(language));
    const out: string[] = [];
    for (const { segment } of seg.segment(text)) {
      if (segment.trim()) out.push(segment);
    }
    return out.join(" ");
  }

  private getSegmenter(baseLang: string): Intl.Segmenter {
    let seg = this.cache.get(baseLang);
    if (!seg) {
      seg = new Intl.Segmenter(baseLang, { granularity: "word" });
      this.cache.set(baseLang, seg);
    }
    return seg;
  }
}
