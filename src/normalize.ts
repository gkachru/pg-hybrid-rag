import type { Normalizer } from "./interfaces.js";

// Tashkeel/harakat (U+064B–U+065F) + superscript alef (U+0670).
// Explicit escapes, not a literal class: a contiguous range U+064B–U+0670 would
// over-match, swallowing Arabic-Indic digits (U+0660–0669) and punctuation /
// dotless letters (U+066A–066F). The class is harakat plus superscript alef only.
const TASHKEEL = /[\u064B-\u065F\u0670]/g; // harakat U+064B-065F + superscript alef U+0670 (escapes: auditable, avoids the RTL literal trap)
// Tatweel/kashida (U+0640), ZWNJ (U+200C), ZWJ (U+200D).
const TATWEEL_ZW = /[ـ‌‍]/g;
// Alef variants: madda (آ), hamza-above (أ), hamza-below (إ), wasla (ٱ) → bare alef (ا).
const ALEF = /[آأإٱ]/g;
const ALEF_BARE = "ا";
const ALEF_MAQSURA = /ى/g; // ى → ي
const YEH = "ي";
const TAA_MARBUTA = /ة/g; // ة → ه
const HEH = "ه";
const ARABIC_INDIC = /[٠-٩]/g; // ٠-٩
const EXT_ARABIC_INDIC = /[۰-۹]/g; // ۰-۹ (Persian/Urdu forms)

export interface ArabicNormalizeOptions {
  /** Fold alef-maqsura ى → yeh ي. Default: true. */
  foldAlefMaqsura?: boolean;
  /** Fold taa-marbuta ة → heh ه. Default: true. */
  foldTaaMarbuta?: boolean;
}

function normalizeArabic(text: string, opts: ArabicNormalizeOptions): string {
  let s = text.normalize("NFC");
  s = s.replace(TASHKEEL, "").replace(TATWEEL_ZW, "");
  s = s.replace(ALEF, ALEF_BARE);
  if (opts.foldAlefMaqsura !== false) s = s.replace(ALEF_MAQSURA, YEH);
  if (opts.foldTaaMarbuta !== false) s = s.replace(TAA_MARBUTA, HEH);
  s = s.replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(EXT_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
  return s.normalize("NFC");
}

/**
 * Per-language orthographic normalization. Language-gated and idempotent.
 * Arabic (`ar`) applies the ruleset above; every other language is NFC-only
 * (the seam is generic — other rulesets are documented future extension points).
 */
export function normalizeForLanguage(
  text: string,
  language: string,
  opts: ArabicNormalizeOptions = {},
): string {
  const base = (language ?? "").split("-")[0].toLowerCase();
  if (base === "ar") return normalizeArabic(text, opts);
  return text.normalize("NFC");
}

/** Default pure-TS `Normalizer`. Holds the Arabic folding flags. */
export class LanguageNormalizer implements Normalizer {
  private opts: ArabicNormalizeOptions;
  constructor(opts: ArabicNormalizeOptions = {}) {
    this.opts = opts;
  }
  normalize(text: string, language: string): string {
    return normalizeForLanguage(text, language, this.opts);
  }
}
