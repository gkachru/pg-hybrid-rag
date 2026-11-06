/**
 * Trailing punctuation regex covering all supported scripts:
 * Latin (?.!,;:), Hindi (।॥), Arabic (؟،؛), CJK (。！？、；：),
 * plus common closing marks: brackets )]} , straight/curly quotes "'’” , and the … ellipsis.
 */
export const TRAILING_PUNCTUATION = /[?.!,;:।॥؟،؛。！？、；：ๆฯ)\]}"'…’”]+$/;

/** Thai "etc." It ends in ฯ, but it is a word: stripping that ฯ would leave the non-word "ฯล". */
const THAI_ETC = "ฯลฯ";

/** Strip trailing punctuation from a string. A trailing ฯลฯ ("etc.") is kept whole. */
export function stripTrailingPunctuation(text: string): string {
  const stripped = text.replace(TRAILING_PUNCTUATION, "");
  // `stripped` is a prefix of `text`; restore the ฯ only when it completes ฯลฯ.
  if (stripped.endsWith("ฯล") && text.startsWith(THAI_ETC, stripped.length - 2)) {
    return `${stripped}ฯ`;
  }
  return stripped;
}
