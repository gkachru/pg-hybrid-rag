/**
 * Remove stop words from a query string.
 * Words are matched case-insensitively against the provided set.
 * Returns the filtered query, or empty string if all words are stop words.
 */
export function removeStopWords(query: string, stopWords: Set<string>): string {
  return query
    .split(/\s+/)
    .filter((word) => !stopWords.has(word.toLowerCase()))
    .join(" ");
}
