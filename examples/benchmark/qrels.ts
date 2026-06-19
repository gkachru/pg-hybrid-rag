import { readFileSync } from "node:fs";
import type { BenchmarkQuery, QueriesFile } from "./types.js";

export function loadQueries(path: string): QueriesFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as QueriesFile;
  if (!parsed || typeof parsed.version !== "number" || !Array.isArray(parsed.queries)) {
    throw new Error(`Malformed queries file: ${path}`);
  }
  return parsed;
}

/** Partition queries by whether their target_doc exists in the built corpus. */
export function resolveQueries(
  queries: BenchmarkQuery[],
  corpusDocIds: Set<string>,
): { resolved: BenchmarkQuery[]; unresolved: BenchmarkQuery[] } {
  const resolved: BenchmarkQuery[] = [];
  const unresolved: BenchmarkQuery[] = [];
  for (const query of queries) {
    (corpusDocIds.has(query.target_doc) ? resolved : unresolved).push(query);
  }
  return { resolved, unresolved };
}

/** True if the (normalized) target snippet appears in the (normalized) doc text. */
export function snippetPresent(
  snippet: string,
  docText: string,
  normalize: (s: string) => string,
): boolean {
  return normalize(docText).includes(normalize(snippet));
}
