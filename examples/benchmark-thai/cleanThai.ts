/** Fraction of letter characters that are Thai (0 if no letters). Latin counts as a non-Thai
 *  letter so brand tokens lower the ratio slightly but don't disqualify a Thai-dominant line.
 *  Digits/punctuation are not letters and don't affect the ratio. */
export function thaiRatio(text: string): number {
  let thai = 0;
  let letters = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Thai consonants + vowels + tone marks (excludes Thai digits 0x0E50-0x0E59 and symbols).
    const isThai = code >= 0x0e01 && code <= 0x0e4e;
    const isLatin = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (isThai || isLatin) letters++;
    if (isThai) thai++;
  }
  return letters === 0 ? 0 : thai / letters;
}

export function isThaiDominant(text: string, threshold = 0.5): boolean {
  return thaiRatio(text) >= threshold;
}

/**
 * Drop lines that recur on at least `minFraction` of pages (repeated headers/footers).
 * Comparison is on the trimmed line; blank lines are never treated as boilerplate.
 */
export function stripRecurringBoilerplate(pages: string[], minFraction = 0.5): string[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const raw of page.split("\n")) {
      const line = raw.trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * minFraction));
  const boilerplate = new Set(
    [...counts.entries()].filter(([, c]) => c >= threshold).map(([line]) => line),
  );
  return pages.map((page) =>
    page
      .split("\n")
      .filter((raw) => !boilerplate.has(raw.trim()))
      .join("\n"),
  );
}

/**
 * Clean a multi-page PDF extraction into Thai-dominant text: strip recurring boilerplate,
 * keep Thai-dominant lines (brand tokens preserved within them), join with newlines.
 */
export function cleanThaiDoc(pages: string[], threshold = 0.5): string {
  const stripped = stripRecurringBoilerplate(pages);
  const kept: string[] = [];
  for (const page of stripped) {
    for (const raw of page.split("\n")) {
      const line = raw.trim();
      if (line && isThaiDominant(line, threshold)) kept.push(line);
    }
  }
  return kept.join("\n");
}
