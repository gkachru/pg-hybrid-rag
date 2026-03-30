/**
 * Trailing punctuation regex covering all supported scripts:
 * Latin (?.!,;:), Hindi (।॥), Arabic (؟،؛), CJK (。！？、；：)
 */
export const TRAILING_PUNCTUATION = /[?.!,;:।॥؟،؛。！？、；：]+$/;

/** Strip trailing punctuation from a string. */
export function stripTrailingPunctuation(text: string): string {
  return text.replace(TRAILING_PUNCTUATION, "");
}
