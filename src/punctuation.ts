/**
 * Trailing punctuation regex covering all supported scripts:
 * Latin (?.!,;:), Hindi (।॥), Arabic (؟،؛), CJK (。！？、；：),
 * plus common closing marks: brackets )]} , straight/curly quotes "'’” , and the … ellipsis.
 */
export const TRAILING_PUNCTUATION = /[?.!,;:।॥؟،؛。！？、；：ๆฯ)\]}"'…’”]+$/;

/** Strip trailing punctuation from a string. */
export function stripTrailingPunctuation(text: string): string {
  return text.replace(TRAILING_PUNCTUATION, "");
}
