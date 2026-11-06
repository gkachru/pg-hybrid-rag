/**
 * Trailing punctuation regex covering all supported scripts:
 * Latin (?.!,;:), Hindi (।॥), Arabic (؟،؛), CJK (。！？、；：), Thai mai yamok (ๆ),
 * plus common closing marks: brackets )]} , straight/curly quotes "'’” , and the … ellipsis.
 * Thai paiyannoi (ฯ) is NOT stripped: it is part of the written word (กรุงเทพฯ, ฯลฯ) and documents
 * keep it, so a query keeps it too. Mai yamok is stripped here for the embedded query; the Thai
 * normalizer drops it from the lexical query and the indexed text alike.
 */
export const TRAILING_PUNCTUATION = /[?.!,;:।॥؟،؛。！？、；：ๆ)\]}"'…’”]+$/;

/** Strip trailing punctuation from a string. */
export function stripTrailingPunctuation(text: string): string {
  return text.replace(TRAILING_PUNCTUATION, "");
}
