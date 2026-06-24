/**
 * Detect language from text using Unicode script ranges.
 * Lightweight — no DB lookups, just script analysis via code-point comparisons.
 * Distinguishes script families (Latin, Devanagari, Arabic, and CJK) but cannot
 * distinguish languages sharing one script (e.g. English vs French, both Latin).
 *
 * CJK heuristic: kana is exclusive to Japanese and Hangul to Korean, so either
 * one is decisive even when Latin is mixed in. Han characters with no kana/Hangul
 * are treated as Chinese — Japanese kanji-only or Korean hanja-only text (rare in
 * practice) is therefore reported as `zh`.
 */
export function detectLanguage(text: string): string {
  let devanagari = 0;
  let arabic = 0;
  let latin = 0;
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let thai = 0;

  for (const char of text) {
    // for…of yields whole code points; codePointAt (not charCodeAt) reads the full
    // value so a supplementary-plane character isn't misread as a lone surrogate.
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x0900 && code <= 0x097f) devanagari++;
    else if (code >= 0x0e00 && code <= 0x0e7f) thai++;
    else if (
      (code >= 0x0600 && code <= 0x06ff) ||
      (code >= 0x0750 && code <= 0x077f) ||
      (code >= 0xfb50 && code <= 0xfdff) ||
      (code >= 0xfe70 && code <= 0xfeff)
    )
      arabic++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
    // Hiragana + Katakana (incl. halfwidth) → uniquely Japanese
    else if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x31f0 && code <= 0x31ff) ||
      (code >= 0xff65 && code <= 0xff9f)
    )
      kana++;
    // Hangul syllables + Jamo → uniquely Korean
    else if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    )
      hangul++;
    // CJK unified ideographs — BMP base + Extension A, plus the supplementary-plane
    // extensions (Ext B–F, Compatibility Ideographs Supplement) → Han, shared by zh/ja/ko
    else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2fa1f)
    )
      han++;
  }

  const total = devanagari + arabic + latin + han + kana + hangul + thai;
  if (total === 0) return "en";

  // CJK: kana ⇒ Japanese, Hangul ⇒ Korean (both decisive even alongside Latin);
  // Han with neither is treated as Chinese when it is at least half of the total
  // script count. Comparing against `total` (not just `latin`) keeps a stray Han
  // ideograph from hijacking clearly Arabic- or Devanagari-dominant text, where
  // `latin` is 0 and `han >= latin` would otherwise always win.
  if (kana > 0) return "ja";
  if (hangul > 0) return "ko";
  if (han > 0 && han / total >= 0.5) return "zh";
  if (thai / total > 0.5) return "th";

  if (arabic / total > 0.5) return "ar";
  if (devanagari / total > 0.5) return "hi";
  // Mixed Devanagari + Latin → Hinglish
  if (devanagari > 0 && latin > 0) return "hinglish";
  return "en";
}
