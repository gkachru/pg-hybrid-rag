/**
 * Detect language from text using Unicode script ranges.
 * Lightweight — no DB lookups, just script analysis via charCode comparisons.
 * Can distinguish script families (Latin, Devanagari, Arabic, CJK) but cannot
 * distinguish languages within the same script (e.g. English vs French).
 */
export function detectLanguage(text: string): string {
  let devanagari = 0;
  let arabic = 0;
  let latin = 0;

  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x0900 && code <= 0x097f) devanagari++;
    else if (
      (code >= 0x0600 && code <= 0x06ff) ||
      (code >= 0x0750 && code <= 0x077f) ||
      (code >= 0xfb50 && code <= 0xfdff) ||
      (code >= 0xfe70 && code <= 0xfeff)
    )
      arabic++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
  }

  const total = devanagari + arabic + latin;
  if (total === 0) return "en";

  if (arabic / total > 0.5) return "ar";
  if (devanagari / total > 0.5) return "hi";
  // Mixed Devanagari + Latin → Hinglish
  if (devanagari > 0 && latin > 0) return "hinglish";
  return "en";
}
