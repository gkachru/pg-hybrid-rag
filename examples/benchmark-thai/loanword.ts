/**
 * Heuristic loanword/OOV detector for the loanword cross-cut slice. A Thai query is
 * "loanword-heavy" if it contains a Latin-script run (code-switched / brand token, incl.
 * letter+digit forms like "5G") OR any known Thai-script transliteration of a foreign term.
 * Deterministic and intentionally coarse — it labels the slice on which a neural segmenter
 * (attacut) is expected to beat a dictionary segmenter, not a linguistic ground truth.
 */
const TRANSLITERATIONS = [
  "โรมมิ่ง",
  "แพ็กเกจ",
  "แพคเกจ",
  "อินเทอร์เน็ต",
  "เน็ต",
  "ดาต้า",
  "ซิม",
  "ออนไลน์",
  "แอป",
  "แอพ",
  "เครดิต",
  "เดบิต",
  "บาลานซ์",
  "ไฟเบอร์",
  "วายฟาย",
  "บลูทูธ",
  "พรีเมียม",
  "โบนัส",
  "แคชแบ็ก",
  "พอยต์",
];

/** A run of >=2 Latin letters, or a Latin letter adjacent to a digit (e.g. "5G", "4K"). */
const LATIN_OR_BRAND = /[A-Za-z]{2,}|\d[A-Za-z]|[A-Za-z]\d/;

export function isLoanwordHeavy(text: string): boolean {
  if (LATIN_OR_BRAND.test(text)) return true;
  return TRANSLITERATIONS.some((t) => text.includes(t));
}
