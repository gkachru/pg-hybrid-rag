/** Fraction of letter characters that are in the Arabic block (0 if no letters). */
export function arabicRatio(text: string): number {
  let arabic = 0;
  let letters = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Arabic letters: 0x0621-0x064A (core letters, diacritics in higher ranges)
    const isArabic = code >= 0x0621 && code <= 0x064a;
    const isLatin = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (isArabic || isLatin) letters++;
    if (isArabic) arabic++;
  }
  return letters === 0 ? 0 : arabic / letters;
}

export function isArabicDominant(text: string, threshold = 0.5): boolean {
  return arabicRatio(text) >= threshold;
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
 * Clean a multi-page PDF extraction into Arabic-dominant text: strip recurring
 * boilerplate, keep Arabic-dominant lines, join with newlines.
 */
export function cleanArabicDoc(pages: string[], threshold = 0.5): string {
  const stripped = stripRecurringBoilerplate(pages);
  const kept: string[] = [];
  for (const page of stripped) {
    for (const raw of page.split("\n")) {
      const line = raw.trim();
      if (line && isArabicDominant(line, threshold)) kept.push(line);
    }
  }
  return kept.join("\n");
}
