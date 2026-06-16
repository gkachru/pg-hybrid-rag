# VectorChord + pg_textsearch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in BM25 FTS leg (pg_textsearch) via a pluggable `FtsStrategy`, plus an opt-in VectorChord (`vchordrq`) vector-index migration, without changing default behavior.

**Architecture:** The `RagDatabase` adapter is the swap point. VectorChord is migration-only (identical `<=>` SQL). pg_textsearch becomes a pluggable `FtsStrategy` injected into `PostgresRagDatabase` (`TsvectorFts` default, `Bm25Fts` opt-in); the strategy owns FTS query-string form + FTS-leg SQL. The pipeline passes `synonymLookup` instead of a pre-built `ftsQueryStr`. Both extensions are gated migrations following the existing `rls`/`cjk` pattern.

**Tech Stack:** TypeScript (strict, ES2022), Bun + `bun:test`, Biome, PostgreSQL (pgvector, pg_trgm, optional pg_bigm; adding vchord + pg_textsearch).

**Spec:** `docs/superpowers/specs/2026-06-16-vectorchord-pg-textsearch-design.md`

**Conventions reminder:** strict TS (no `any`), parameterized SQL only (the BM25 language predicate is the sole inlined literal — sourced from a trusted constant, never user input), 2-space indent, double quotes, run `bun run lint` + `bun run typecheck` before each commit. Tests import directly from `../src/...` (not the barrel).

---

## Task 1: `buildBm25Query` (flat BM25 term list)

**Files:**
- Modify: `src/synonymExpander.ts`
- Modify: `src/index.ts`
- Test: `tests/synonymExpander.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/synonymExpander.test.ts` (the `makeLookup` helper already exists at the top of this file):

```ts
import { buildBm25Query } from "../src/synonymExpander.js";

describe("buildBm25Query", () => {
  it("expands synonyms into a flat space-separated list", () => {
    const lookup = makeLookup([{ lang: "en", term: "phones", expansions: ["smartphones"] }]);
    expect(buildBm25Query("best phones market", lookup)).toBe("best phones smartphones market");
  });

  it("returns the query unchanged when no synonyms match", () => {
    const lookup = makeLookup([{ lang: "en", term: "tv", expansions: ["television"] }]);
    expect(buildBm25Query("best phones market", lookup)).toBe("best phones market");
  });

  it("returns the query unchanged when the lookup is empty", () => {
    expect(buildBm25Query("best phones", new Map())).toBe("best phones");
  });

  it("flattens multi-word synonyms into individual terms", () => {
    const lookup = makeLookup([{ lang: "en", term: "cash on delivery", expansions: ["cod"] }]);
    expect(buildBm25Query("want cash on delivery", lookup)).toBe("want cash on delivery cod");
  });

  it("strips characters special to the query parser", () => {
    expect(buildBm25Query("best & phones | market", new Map())).toBe("best phones market");
  });

  it("drops terms that sanitize to empty", () => {
    expect(buildBm25Query("| & !", new Map())).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/synonymExpander.test.ts`
Expected: FAIL — `buildBm25Query` is not exported / not a function.

- [ ] **Step 3: Implement `buildBm25Query`**

In `src/synonymExpander.ts`, add this function (it reuses the existing `expandQueryWithSynonyms` and the existing private `sanitizeTsqueryTerm` — both already in this file; the same special-character set is correct to strip for the BM25 `<@>` parser):

```ts
/**
 * Build a flat, space-separated term list for the BM25 (pg_textsearch) FTS leg.
 * Synonym-expands the query (longest-match-first), then strips characters special
 * to the query parser. BM25 is OR-ranked by definition, so a space-separated list
 * is functionally equivalent to a tsquery OR group — and ranks by term frequency.
 *
 * Input:  "best phones market", synonyms: phones -> [smartphones]
 * Output: "best phones smartphones market"
 */
export function buildBm25Query(query: string, lookup: SynonymLookup): string {
  const expanded = expandQueryWithSynonyms(query, lookup);
  return expanded
    .split(/\s+/)
    .map(sanitizeTsqueryTerm)
    .filter(Boolean)
    .join(" ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/synonymExpander.test.ts`
Expected: PASS (all `buildBm25Query` + existing tests).

- [ ] **Step 5: Export from the barrel**

In `src/index.ts`, change the synonymExpander export line:

```ts
export { buildBm25Query, buildFtsQuery, expandQueryWithSynonyms } from "./synonymExpander.js";
```

- [ ] **Step 6: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck && bun test tests/synonymExpander.test.ts
git add src/synonymExpander.ts src/index.ts tests/synonymExpander.test.ts
git commit -m "feat: add buildBm25Query for flat BM25 term lists"
```

---

## Task 2: BM25 language groups + predicate

**Files:**
- Create: `src/adapters/fts/bm25LanguageGroups.ts`
- Test: `tests/bm25LanguageGroups.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/bm25LanguageGroups.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  BM25_LANGUAGE_GROUPS,
  bm25LanguagePredicate,
  bm25SupportedLanguages,
} from "../src/adapters/fts/bm25LanguageGroups.js";

describe("bm25LanguagePredicate", () => {
  it("returns the English group IN-list for en", () => {
    expect(bm25LanguagePredicate("en")).toBe("language IN ('en', 'en-US', 'en-IN')");
  });

  it("matches a locale code within a group", () => {
    expect(bm25LanguagePredicate("es-MX")).toBe("language IN ('es', 'es-ES', 'es-MX')");
  });

  it("returns a NOT IN catch-all for unsupported languages", () => {
    const pred = bm25LanguagePredicate("hi");
    expect(pred.startsWith("language NOT IN (")).toBe(true);
    expect(pred).toContain("'en'");
    expect(pred).not.toContain("'hi'");
  });
});

describe("bm25SupportedLanguages", () => {
  it("flattens every group's language codes", () => {
    const all = bm25SupportedLanguages();
    expect(all).toContain("en");
    expect(all).toContain("ro-RO");
    expect(all.length).toBe(BM25_LANGUAGE_GROUPS.flatMap((g) => g.languages).length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/bm25LanguageGroups.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/adapters/fts/bm25LanguageGroups.ts`:

```ts
/** A BM25 partial-index language group: one Postgres text_config + the language codes it covers. */
export interface Bm25LanguageGroup {
  config: string;
  languages: string[];
}

/**
 * Language groups for the per-language partial BM25 indexes.
 *
 * SINGLE SOURCE OF TRUTH: the language-code literals here MUST stay in sync with
 * sql/011_pg_textsearch.sql (a test asserts this). Partial-index predicate matching
 * requires literal arrays, so the migration cannot call a function. Mirrors
 * rag_fts_config() (sql/008) but as literal arrays.
 */
export const BM25_LANGUAGE_GROUPS: Bm25LanguageGroup[] = [
  { config: "english", languages: ["en", "en-US", "en-IN"] },
  { config: "spanish", languages: ["es", "es-ES", "es-MX"] },
  { config: "french", languages: ["fr", "fr-FR"] },
  { config: "german", languages: ["de", "de-DE"] },
  { config: "italian", languages: ["it", "it-IT"] },
  { config: "portuguese", languages: ["pt", "pt-PT"] },
  { config: "romanian", languages: ["ro", "ro-RO"] },
];

/** Every language code with a dedicated (non-simple) BM25 partial index. */
export function bm25SupportedLanguages(): string[] {
  return BM25_LANGUAGE_GROUPS.flatMap((g) => g.languages);
}

/**
 * SQL predicate that selects the partial BM25 index matching `language`.
 * Returns `language IN (...)` for a supported group, or `language NOT IN (...all supported...)`
 * for the 'simple' catch-all index. Values come from BM25_LANGUAGE_GROUPS (trusted constant,
 * never user input) so inlining as SQL literals is safe.
 */
export function bm25LanguagePredicate(language: string): string {
  const quote = (s: string) => `'${s}'`;
  const group = BM25_LANGUAGE_GROUPS.find((g) => g.languages.includes(language));
  if (group) {
    return `language IN (${group.languages.map(quote).join(", ")})`;
  }
  return `language NOT IN (${bm25SupportedLanguages().map(quote).join(", ")})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bm25LanguageGroups.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck && bun test tests/bm25LanguageGroups.test.ts
git add src/adapters/fts/bm25LanguageGroups.ts tests/bm25LanguageGroups.test.ts
git commit -m "feat: add BM25 language groups + partial-index predicate"
```

---

## Task 3: Shared SQL helpers (filters + row mapping)

**Files:**
- Create: `src/adapters/sqlHelpers.ts`
- Test: `tests/sqlHelpers.test.ts`

Extracts the source/source-id/language WHERE-clause builder and row mapper currently inline in `PostgresRagDatabase`, so all three legs and both FTS strategies share one implementation. No behavior change.

- [ ] **Step 1: Write failing tests**

Create `tests/sqlHelpers.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { buildFilters, toRankedCandidate } from "../src/adapters/sqlHelpers.js";

describe("buildFilters", () => {
  it("returns empty clause + params when no filters are set", () => {
    const f = buildFilters({}, 5);
    expect(f.clause).toBe("");
    expect(f.params).toEqual([]);
  });

  it("builds a source_type clause at the start index", () => {
    const f = buildFilters({ sourceTypes: ["product", "faq"] }, 5);
    expect(f.clause).toContain("source_type = ANY(string_to_array($5::text, ','))");
    expect(f.params).toEqual(["product,faq"]);
  });

  it("assigns sequential placeholders for all three filters in order", () => {
    const f = buildFilters(
      { sourceTypes: ["product"], sourceIds: ["a"], languages: ["en", "hi"] },
      5,
    );
    expect(f.clause).toContain("source_type = ANY(string_to_array($5::text, ','))");
    expect(f.clause).toContain("source_id::text = ANY(string_to_array($6::text, ','))");
    expect(f.clause).toContain("language = ANY(string_to_array($7::text, ','))");
    expect(f.params).toEqual(["product", "a", "en,hi"]);
  });

  it("skips empty filter arrays", () => {
    const f = buildFilters({ sourceTypes: [], languages: ["en"] }, 5);
    expect(f.clause).not.toContain("source_type");
    expect(f.clause).toContain("language = ANY(string_to_array($5::text, ','))");
    expect(f.params).toEqual(["en"]);
  });
});

describe("toRankedCandidate", () => {
  it("maps a row, defaulting null metadata to '{}'", () => {
    expect(
      toRankedCandidate({ content: "c", source_type: "faq", source_id: null, metadata: null }),
    ).toEqual({ content: "c", sourceType: "faq", sourceId: null, metadata: "{}" });
  });

  it("preserves existing metadata", () => {
    expect(
      toRankedCandidate({ content: "c", source_type: "faq", source_id: "1", metadata: '{"a":"b"}' }),
    ).toEqual({ content: "c", sourceType: "faq", sourceId: "1", metadata: '{"a":"b"}' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/sqlHelpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/adapters/sqlHelpers.ts`:

```ts
import type { RankedCandidate } from "../types.js";

/** The optional result filters shared by all search legs. */
export interface SearchFilters {
  sourceTypes?: string[];
  sourceIds?: string[];
  languages?: string[];
}

export interface BuiltFilters {
  /** AND-prefixed clause text with $N placeholders (empty string when no filters are active). */
  clause: string;
  /** Param values to append to the leg's base params, in placeholder order. */
  params: string[];
}

/**
 * Build the shared source-type / source-id / language WHERE clauses.
 * Uses string_to_array(...) for driver-agnostic array binding (matches existing convention).
 *
 * @param filters which optional filters are active
 * @param startIdx the first $N placeholder index to use (i.e. baseParams.length + 1)
 */
export function buildFilters(filters: SearchFilters, startIdx: number): BuiltFilters {
  const clauses: string[] = [];
  const params: string[] = [];
  let idx = startIdx;

  if (filters.sourceTypes?.length) {
    clauses.push(`AND source_type = ANY(string_to_array($${idx}::text, ','))`);
    params.push(filters.sourceTypes.join(","));
    idx++;
  }
  if (filters.sourceIds?.length) {
    clauses.push(`AND source_id::text = ANY(string_to_array($${idx}::text, ','))`);
    params.push(filters.sourceIds.join(","));
    idx++;
  }
  if (filters.languages?.length) {
    clauses.push(`AND language = ANY(string_to_array($${idx}::text, ','))`);
    params.push(filters.languages.join(","));
    idx++;
  }

  return { clause: clauses.join("\n            "), params };
}

/** Map a raw DB row to a RankedCandidate (shared by every leg). */
export function toRankedCandidate(row: Record<string, unknown>): RankedCandidate {
  return {
    content: row.content as string,
    sourceType: row.source_type as string,
    sourceId: row.source_id as string | null,
    metadata: (row.metadata as string) || "{}",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/sqlHelpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck && bun test tests/sqlHelpers.test.ts
git add src/adapters/sqlHelpers.ts tests/sqlHelpers.test.ts
git commit -m "feat: extract shared SQL filter + row-mapping helpers"
```

---

## Task 4: `FtsStrategy` / `FtsContext` interfaces

**Files:**
- Modify: `src/interfaces.ts`

Type-only, additive — compiles with no consumers yet.

- [ ] **Step 1: Add the interfaces**

In `src/interfaces.ts`, the top import already pulls `RankedCandidate` and `SynonymLookup` from `./types.js`. Add at the end of the file:

```ts
/** Context passed to an FtsStrategy for one FTS-leg execution. */
export interface FtsContext {
  tenantId: string;
  /** Normalized, stop-words-removed query (the strategy builds its own FTS query form from this). */
  query: string;
  synonyms: SynonymLookup;
  /** Language code for stemming / config selection (e.g. 'en', 'fr-FR'). */
  language: string;
  candidateLimit: number;
  sourceTypes?: string[];
  sourceIds?: string[];
  languages?: string[];
}

/**
 * Pluggable full-text-search leg. Implementations own the FTS query-string form
 * AND the FTS-leg SQL. Injected into PostgresRagDatabase (default: TsvectorFts).
 */
export interface FtsStrategy {
  /** Run the FTS leg against one connection and return ranked candidates (best first). */
  search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]>;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/interfaces.ts
git commit -m "feat: add FtsStrategy + FtsContext interfaces"
```

---

## Task 5: `TsvectorFts` strategy (default — preserves current behavior)

**Files:**
- Create: `src/adapters/fts/TsvectorFts.ts`
- Modify: `src/index.ts`
- Test: `tests/tsvectorFts.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tsvectorFts.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { SqlClient } from "../src/interfaces.js";
import { TsvectorFts } from "../src/adapters/fts/TsvectorFts.js";
import type { SynonymLookup } from "../src/types.js";

function makeLookup(
  entries: Array<{ lang: string; term: string; expansions: string[] }>,
): SynonymLookup {
  const lookup: SynonymLookup = new Map();
  for (const { lang, term, expansions } of entries) {
    if (!lookup.has(lang)) lookup.set(lang, new Map());
    lookup.get(lang)?.set(term, expansions);
  }
  return lookup;
}

function capturingClient(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    query: async <T>(sql: string, params: unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      return rows as T[];
    },
  };
  return { client, calls };
}

const base = { tenantId: "t1", language: "en", candidateLimit: 10 };

describe("TsvectorFts", () => {
  it("uses to_tsquery for multi-term / synonym queries and passes the OR-group string", async () => {
    const { client, calls } = capturingClient();
    const synonyms = makeLookup([{ lang: "en", term: "phones", expansions: ["smartphones"] }]);
    await new TsvectorFts().search(client, { ...base, query: "best phones", synonyms });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("to_tsquery(rag_fts_config($4), $2)");
    expect(calls[0].params[1]).toBe("best & (phones | smartphones)");
    expect(calls[0].params[3]).toBe("en");
  });

  it("uses plainto_tsquery with the raw query for single-term no-synonym queries", async () => {
    const { client, calls } = capturingClient();
    await new TsvectorFts().search(client, { ...base, query: "phones", synonyms: new Map() });
    expect(calls[0].sql).toContain("plainto_tsquery(rag_fts_config($4), $2)");
    expect(calls[0].params[1]).toBe("phones");
  });

  it("appends source-type filter at $5", async () => {
    const { client, calls } = capturingClient();
    await new TsvectorFts().search(client, {
      ...base,
      query: "phones",
      synonyms: new Map(),
      sourceTypes: ["faq"],
    });
    expect(calls[0].sql).toContain("source_type = ANY(string_to_array($5::text, ','))");
    expect(calls[0].params[4]).toBe("faq");
  });

  it("maps rows to ranked candidates", async () => {
    const { client } = capturingClient([
      { content: "c", source_type: "faq", source_id: "1", metadata: "{}" },
    ]);
    const res = await new TsvectorFts().search(client, {
      ...base,
      query: "phones",
      synonyms: new Map(),
    });
    expect(res).toEqual([{ content: "c", sourceType: "faq", sourceId: "1", metadata: "{}" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/tsvectorFts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TsvectorFts`**

Create `src/adapters/fts/TsvectorFts.ts` (logic mirrors the current FTS leg in `PostgresRagDatabase`, including the `plainto` branch using the raw query):

```ts
import type { FtsContext, FtsStrategy, SqlClient } from "../../interfaces.js";
import { buildFtsQuery } from "../../synonymExpander.js";
import type { RankedCandidate } from "../../types.js";
import { buildFilters, toRankedCandidate } from "../sqlHelpers.js";

/**
 * Default FTS strategy: Postgres tsvector/tsquery with language-aware stemming
 * via rag_fts_config(). Preserves the original PostgresRagDatabase FTS-leg behavior.
 */
export class TsvectorFts implements FtsStrategy {
  async search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]> {
    const ftsQueryStr = buildFtsQuery(ctx.query, ctx.synonyms);
    const useTsquery = ftsQueryStr.includes("|") || ftsQueryStr.includes("&");

    // base params: $1 tenant, $2 query-string, $3 limit, $4 language -> filters start at $5
    const queryArg = useTsquery ? ftsQueryStr : ctx.query;
    const baseParams: unknown[] = [ctx.tenantId, queryArg, ctx.candidateLimit, ctx.language];
    const f = buildFilters(ctx, 5);
    const tsExpr = useTsquery
      ? "to_tsquery(rag_fts_config($4), $2)"
      : "plainto_tsquery(rag_fts_config($4), $2)";

    const sql = `
          SELECT content, source_type, source_id, metadata,
                 ts_rank_cd(content_tsvector, ${tsExpr}) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND content_tsvector @@ ${tsExpr}
            ${f.clause}
          ORDER BY ts_rank_cd(content_tsvector, ${tsExpr}) DESC
          LIMIT $3
        `;
    const rows = await client.query<Record<string, unknown>>(sql, [...baseParams, ...f.params]);
    return rows.map(toRankedCandidate);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/tsvectorFts.test.ts`
Expected: PASS.

- [ ] **Step 5: Export from the barrel**

In `src/index.ts`, add under the Adapters section:

```ts
export { TsvectorFts } from "./adapters/fts/TsvectorFts.js";
```

And add `FtsContext`, `FtsStrategy` to the existing interfaces type-export block:

```ts
export type {
  ChunkingProvider,
  EmbeddingProvider,
  FtsContext,
  FtsStrategy,
  RagDatabase,
  RagLogger,
  RagSpan,
  RagTracer,
  RerankerProvider,
  SqlClient,
  StopWordsProvider,
  SynonymProvider,
  TransactionProvider,
} from "./interfaces.js";
```

- [ ] **Step 6: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck && bun test tests/tsvectorFts.test.ts
git add src/adapters/fts/TsvectorFts.ts src/index.ts tests/tsvectorFts.test.ts
git commit -m "feat: add TsvectorFts strategy (default FTS leg)"
```

---

## Task 6: `Bm25Fts` strategy (pg_textsearch)

**Files:**
- Create: `src/adapters/fts/Bm25Fts.ts`
- Modify: `src/index.ts`
- Test: `tests/bm25Fts.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/bm25Fts.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { SqlClient } from "../src/interfaces.js";
import { Bm25Fts } from "../src/adapters/fts/Bm25Fts.js";

function capturingClient(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    query: async <T>(sql: string, params: unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      return rows as T[];
    },
  };
  return { client, calls };
}

const base = { tenantId: "t1", language: "en", candidateLimit: 10 };

describe("Bm25Fts", () => {
  it("emits the <@> BM25 SQL with negated score and ascending order", async () => {
    const { client, calls } = capturingClient();
    await new Bm25Fts().search(client, { ...base, query: "best phones", synonyms: new Map() });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("-(content <@> $2) as score");
    expect(calls[0].sql).toContain("ORDER BY content <@> $2");
    expect(calls[0].sql).toContain("language IN ('en', 'en-US', 'en-IN')");
    expect(calls[0].params[1]).toBe("best phones");
  });

  it("uses the NOT IN catch-all predicate for unsupported languages", async () => {
    const { client, calls } = capturingClient();
    await new Bm25Fts().search(client, { ...base, language: "hi", query: "x", synonyms: new Map() });
    expect(calls[0].sql).toContain("language NOT IN (");
  });

  it("places result filters starting at $4 (no $4 language param for BM25)", async () => {
    const { client, calls } = capturingClient();
    await new Bm25Fts().search(client, {
      ...base,
      query: "x",
      synonyms: new Map(),
      sourceTypes: ["faq"],
    });
    expect(calls[0].sql).toContain("source_type = ANY(string_to_array($4::text, ','))");
    expect(calls[0].params[3]).toBe("faq");
  });

  it("returns [] without querying when the query sanitizes to empty", async () => {
    const { client, calls } = capturingClient();
    const res = await new Bm25Fts().search(client, {
      ...base,
      query: "| & !",
      synonyms: new Map(),
    });
    expect(res).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/bm25Fts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `Bm25Fts`**

Create `src/adapters/fts/Bm25Fts.ts`:

```ts
import type { FtsContext, FtsStrategy, SqlClient } from "../../interfaces.js";
import { buildBm25Query } from "../../synonymExpander.js";
import type { RankedCandidate } from "../../types.js";
import { buildFilters, toRankedCandidate } from "../sqlHelpers.js";
import { bm25LanguagePredicate } from "./bm25LanguageGroups.js";

/**
 * BM25 FTS strategy backed by pg_textsearch. Uses a flat term list and the `<@>`
 * BM25 distance operator. `<@>` returns negative BM25 distance (lower = better),
 * so we ORDER BY ascending and negate for a positive score. A language-group
 * predicate steers the planner to the matching partial BM25 index (sql/011).
 *
 * Requires migration 011 + shared_preload_libraries includes 'pg_textsearch'.
 */
export class Bm25Fts implements FtsStrategy {
  async search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]> {
    const bm25Query = buildBm25Query(ctx.query, ctx.synonyms);
    if (!bm25Query) return [];

    // base params: $1 tenant, $2 query, $3 limit -> filters start at $4
    const baseParams: unknown[] = [ctx.tenantId, bm25Query, ctx.candidateLimit];
    const f = buildFilters(ctx, 4);
    const langPredicate = bm25LanguagePredicate(ctx.language);

    const sql = `
          SELECT content, source_type, source_id, metadata,
                 -(content <@> $2) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND ${langPredicate}
            ${f.clause}
          ORDER BY content <@> $2
          LIMIT $3
        `;
    const rows = await client.query<Record<string, unknown>>(sql, [...baseParams, ...f.params]);
    return rows.map(toRankedCandidate);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bm25Fts.test.ts`
Expected: PASS.

- [ ] **Step 5: Export from the barrel**

In `src/index.ts`, add under the Adapters section:

```ts
export { Bm25Fts } from "./adapters/fts/Bm25Fts.js";
```

- [ ] **Step 6: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck && bun test tests/bm25Fts.test.ts
git add src/adapters/fts/Bm25Fts.ts src/index.ts tests/bm25Fts.test.ts
git commit -m "feat: add Bm25Fts strategy (pg_textsearch BM25 leg)"
```

---

## Task 7: Integrate — `HybridSearchParams`, adapter, pipeline

**Files:**
- Modify: `src/types.ts`
- Modify: `src/adapters/PostgresRagDatabase.ts`
- Modify: `src/RagPipeline.ts`
- Test: `tests/postgresRagDatabase.test.ts` (new), `tests/pipeline.test.ts`

This is the integration task; the build is red between steps 1 and 4 and green at the end. Land it as one commit.

- [ ] **Step 1: Change `HybridSearchParams`**

In `src/types.ts`, update the `HybridSearchParams` interface — remove `ftsQueryStr`, add `synonymLookup` (`SynonymLookup` is already defined above in this file):

```ts
/** Parameters for hybrid search (passed to RagDatabase). */
export interface HybridSearchParams {
  tenantId: string;
  embeddingStr: string;
  query: string;
  synonymLookup: SynonymLookup;
  language: string;
  candidateLimit: number;
  vectorMinScore: number;
  keywordMinScore: number;
  sourceTypes?: string[];
  sourceIds?: string[];
  languages?: string[];
}
```

- [ ] **Step 2: Rewrite `PostgresRagDatabase`**

Replace the entire contents of `src/adapters/PostgresRagDatabase.ts` with:

```ts
import type { FtsStrategy, RagDatabase, TransactionProvider } from "../interfaces.js";
import type { HybridSearchParams, RankedCandidate } from "../types.js";
import { TsvectorFts } from "./fts/TsvectorFts.js";
import { buildFilters, toRankedCandidate } from "./sqlHelpers.js";

const CJK_LANGUAGES = new Set(["zh", "zh-CN", "ja", "ja-JP", "ko", "ko-KR"]);

export interface PostgresRagDatabaseOptions {
  /** Enable pg_bigm for CJK keyword search. Requires the pg_bigm extension. Default: false. */
  cjk?: boolean;
  /** FTS strategy for the FTS leg. Default: new TsvectorFts(). Use new Bm25Fts() with migration 011. */
  fts?: FtsStrategy;
}

/**
 * PostgreSQL implementation of RagDatabase.
 * Uses parameterized SQL for all queries — always includes WHERE tenant_id = ?.
 * Requires pgvector and pg_trgm. Optionally uses pg_bigm for CJK keyword search.
 *
 * The vector leg uses the `<=>` cosine operator (IVFFlat or, with migration 010,
 * VectorChord vchordrq — identical SQL). The FTS leg is delegated to a pluggable
 * FtsStrategy (TsvectorFts default; Bm25Fts for pg_textsearch BM25).
 */
export class PostgresRagDatabase implements RagDatabase {
  private txProvider: TransactionProvider;
  private cjk: boolean;
  private fts: FtsStrategy;

  constructor(txProvider: TransactionProvider, options?: PostgresRagDatabaseOptions) {
    this.txProvider = txProvider;
    this.cjk = options?.cjk ?? false;
    this.fts = options?.fts ?? new TsvectorFts();
  }

  async hybridSearch(params: HybridSearchParams): Promise<{
    vectorRows: RankedCandidate[];
    keywordRows: RankedCandidate[];
    ftsRows: RankedCandidate[];
  }> {
    const useBigm = this.cjk && CJK_LANGUAGES.has(params.language);

    // Run all 3 legs in parallel with separate connections for true concurrency
    const [vectorRows, keywordRows, ftsRows] = await Promise.all([
      // --- Vector leg (IVFFlat or vchordrq — identical SQL) ---
      this.txProvider.withConnection(async (client) => {
        const baseParams: unknown[] = [
          params.tenantId,
          params.embeddingStr,
          params.vectorMinScore,
          params.candidateLimit,
        ];
        const f = buildFilters(params, 5);
        const sql = `
          SELECT content, source_type, source_id, metadata,
                 1 - (embedding <=> $2::vector) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND 1 - (embedding <=> $2::vector) >= $3
            ${f.clause}
          ORDER BY embedding <=> $2::vector
          LIMIT $4
        `;
        const rows = await client.query<Record<string, unknown>>(sql, [...baseParams, ...f.params]);
        return rows.map(toRankedCandidate);
      }),

      // --- Keyword leg (pg_trgm or pg_bigm) ---
      this.txProvider.withConnection(async (client) => {
        const baseParams: unknown[] = [
          params.tenantId,
          params.query,
          params.keywordMinScore,
          params.candidateLimit,
        ];
        const f = buildFilters(params, 5);
        const similarityFn = useBigm ? "bigm_similarity" : "word_similarity";
        const sql = `
          SELECT content, source_type, source_id, metadata,
                 ${similarityFn}($2, content) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND ${similarityFn}($2, content) > $3
            ${f.clause}
          ORDER BY ${similarityFn}($2, content) DESC
          LIMIT $4
        `;
        const rows = await client.query<Record<string, unknown>>(sql, [...baseParams, ...f.params]);
        return rows.map(toRankedCandidate);
      }),

      // --- FTS leg (pluggable strategy) ---
      this.txProvider.withConnection((client) =>
        this.fts.search(client, {
          tenantId: params.tenantId,
          query: params.query,
          synonyms: params.synonymLookup,
          language: params.language,
          candidateLimit: params.candidateLimit,
          sourceTypes: params.sourceTypes,
          sourceIds: params.sourceIds,
          languages: params.languages,
        }),
      ),
    ]);

    return { vectorRows, keywordRows, ftsRows };
  }

  async insertChunks(
    tenantId: string,
    chunks: Array<{
      sourceType: string;
      sourceId: string;
      chunkIndex: string;
      content: string;
      language: string;
      embedding: number[];
      metadata: string;
    }>,
  ): Promise<void> {
    if (chunks.length === 0) return;

    return this.txProvider.withConnection(async (client) => {
      const params: unknown[] = [];
      const valueClauses: string[] = [];

      for (const chunk of chunks) {
        const offset = params.length;
        const embeddingStr = `[${chunk.embedding.join(",")}]`;
        params.push(
          tenantId,
          chunk.sourceType,
          chunk.sourceId,
          chunk.chunkIndex,
          chunk.content,
          chunk.language,
          embeddingStr,
          chunk.metadata,
        );
        valueClauses.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::vector, $${offset + 8})`,
        );
      }

      await client.query(
        `INSERT INTO rag_documents (tenant_id, source_type, source_id, chunk_index, content, language, embedding, metadata)
         VALUES ${valueClauses.join(", ")}`,
        params,
      );
    });
  }

  async deleteBySource(tenantId: string, sourceType: string, sourceId: string): Promise<void> {
    return this.txProvider.withConnection(async (client) => {
      await client.query(
        `DELETE FROM rag_documents WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
        [tenantId, sourceType, sourceId],
      );
    });
  }
}
```

- [ ] **Step 3: Update `RagPipeline`**

In `src/RagPipeline.ts`:
- Remove the import `import { buildFtsQuery } from "./synonymExpander.js";` (line 14).
- Remove the line `const ftsQueryStr = buildFtsQuery(searchQuery, synonymLookup);` (around line 140).
- In the `this.db.hybridSearch({ ... })` call, replace `ftsQueryStr,` with `synonymLookup,`.

The resulting call object should read:

```ts
            return await this.db.hybridSearch({
              tenantId: this.tenantId,
              embeddingStr,
              query: searchQuery,
              synonymLookup,
              language,
              candidateLimit,
              vectorMinScore: opts.vectorMinScore,
              keywordMinScore: opts.keywordMinScore,
              sourceTypes: opts.sourceTypes,
              sourceIds: opts.sourceIds,
              languages: opts.languages,
            });
```

(The `const language = opts.language ?? "en";` line stays.)

- [ ] **Step 4: Run the full suite to verify existing tests still pass**

Run: `bun test`
Expected: PASS (pipeline tests assert `query`/`language`/`sourceTypes`/`languages`, none assert `ftsQueryStr`).

- [ ] **Step 5: Add a pipeline test for `synonymLookup` pass-through**

In `tests/pipeline.test.ts`, add after the "omits languages when not specified" test:

```ts
  it("passes a synonymLookup to db.hybridSearch", async () => {
    await pipeline.search("test");
    expect(lastSearchParams.synonymLookup).toBeInstanceOf(Map);
  });

  it("loads synonyms into the lookup when a provider is set", async () => {
    const synonyms = {
      load: mock(async () => new Map([["en", new Map([["phones", ["smartphones"]]])]])),
      invalidate: mock(() => {}),
    };
    const pipelineWithSyn = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      synonyms,
    });
    await pipelineWithSyn.search("phones");
    const lookup = lastSearchParams.synonymLookup as Map<string, Map<string, string[]>>;
    expect(lookup.get("en")?.get("phones")).toEqual(["smartphones"]);
  });
```

- [ ] **Step 6: Add the adapter integration test**

Create `tests/postgresRagDatabase.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { PostgresRagDatabase } from "../src/adapters/PostgresRagDatabase.js";
import type { FtsContext, FtsStrategy, SqlClient, TransactionProvider } from "../src/interfaces.js";
import type { HybridSearchParams } from "../src/types.js";

function recordingTx() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    query: async <T>(sql: string, params: unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      return [] as T[];
    },
  };
  const txProvider: TransactionProvider = {
    withConnection: async <T>(fn: (c: SqlClient) => Promise<T>) => fn(client),
  };
  return { txProvider, calls };
}

const params: HybridSearchParams = {
  tenantId: "t1",
  embeddingStr: "[0.1,0.2]",
  query: "phones",
  synonymLookup: new Map(),
  language: "en",
  candidateLimit: 10,
  vectorMinScore: 0.8,
  keywordMinScore: 0.35,
};

describe("PostgresRagDatabase.hybridSearch", () => {
  it("runs the vector leg with the cosine operator", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    expect(calls.some((c) => c.sql.includes("embedding <=> $2::vector"))).toBe(true);
  });

  it("runs the keyword leg with word_similarity by default", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    expect(calls.some((c) => c.sql.includes("word_similarity($2, content)"))).toBe(true);
  });

  it("uses bigm_similarity for CJK when cjk: true", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({ ...params, language: "ja" });
    expect(calls.some((c) => c.sql.includes("bigm_similarity($2, content)"))).toBe(true);
  });

  it("delegates the FTS leg to the injected strategy with a mapped context", async () => {
    const { txProvider } = recordingTx();
    let seen: FtsContext | undefined;
    const spyFts: FtsStrategy = {
      search: async (_client, ctx) => {
        seen = ctx;
        return [];
      },
    };
    await new PostgresRagDatabase(txProvider, { fts: spyFts }).hybridSearch(params);
    expect(seen?.tenantId).toBe("t1");
    expect(seen?.query).toBe("phones");
    expect(seen?.synonyms).toBeInstanceOf(Map);
    expect(seen?.language).toBe("en");
    expect(seen?.candidateLimit).toBe(10);
  });

  it("defaults to TsvectorFts (emits tsquery SQL) when no fts option is given", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    expect(calls.some((c) => c.sql.includes("plainto_tsquery(rag_fts_config($4), $2)"))).toBe(true);
  });
});
```

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: PASS (all suites).

- [ ] **Step 8: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck && bun test
git add src/types.ts src/adapters/PostgresRagDatabase.ts src/RagPipeline.ts tests/pipeline.test.ts tests/postgresRagDatabase.test.ts
git commit -m "feat: inject FtsStrategy into PostgresRagDatabase; pass synonymLookup (BREAKING: HybridSearchParams)"
```

---

## Task 8: Migrations + gating + sync test

**Files:**
- Create: `sql/010_vectorchord.sql`
- Create: `sql/011_pg_textsearch.sql`
- Modify: `src/migrate.ts`
- Test: `tests/migrate.test.ts`

- [ ] **Step 1: Create `sql/010_vectorchord.sql`**

```sql
-- VectorChord vchordrq vector index (optional — apply with ragMigrate(client, { vectorchord: true })).
-- PREREQUISITE (ops, not in this migration): shared_preload_libraries = 'vchord' + Postgres restart.
-- Swaps the IVFFlat index for vchordrq. Queries are unchanged (same <=> operator).
CREATE EXTENSION IF NOT EXISTS vchord CASCADE;
DROP INDEX IF EXISTS idx_rag_embedding_ivfflat;
CREATE INDEX IF NOT EXISTS idx_rag_embedding_vchordrq
  ON rag_documents USING vchordrq (embedding vector_cosine_ops);
```

- [ ] **Step 2: Create `sql/011_pg_textsearch.sql`**

The `language IN (...)` literals MUST match `BM25_LANGUAGE_GROUPS` in `src/adapters/fts/bm25LanguageGroups.ts` (the sync test in Step 6 enforces this). Note the no-space comma style `('en','en-US','en-IN')`:

```sql
-- pg_textsearch BM25 indexes (optional — apply with ragMigrate(client, { bm25: true })).
-- PREREQUISITE (ops): shared_preload_libraries includes 'pg_textsearch' + Postgres restart.
-- Coexists with the tsvector column/trigger; selectable per deployment via the fts strategy.
CREATE EXTENSION IF NOT EXISTS pg_textsearch;

-- One partial BM25 index per language group (literals mirror BM25_LANGUAGE_GROUPS).
CREATE INDEX IF NOT EXISTS idx_rag_bm25_en ON rag_documents USING bm25(content)
  WITH (text_config='english')    WHERE language IN ('en','en-US','en-IN');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_es ON rag_documents USING bm25(content)
  WITH (text_config='spanish')    WHERE language IN ('es','es-ES','es-MX');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_fr ON rag_documents USING bm25(content)
  WITH (text_config='french')     WHERE language IN ('fr','fr-FR');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_de ON rag_documents USING bm25(content)
  WITH (text_config='german')     WHERE language IN ('de','de-DE');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_it ON rag_documents USING bm25(content)
  WITH (text_config='italian')    WHERE language IN ('it','it-IT');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_pt ON rag_documents USING bm25(content)
  WITH (text_config='portuguese') WHERE language IN ('pt','pt-PT');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_ro ON rag_documents USING bm25(content)
  WITH (text_config='romanian')   WHERE language IN ('ro','ro-RO');

-- Catch-all for unsupported languages (no stemming).
CREATE INDEX IF NOT EXISTS idx_rag_bm25_simple ON rag_documents USING bm25(content)
  WITH (text_config='simple')
  WHERE language NOT IN ('en','en-US','en-IN','es','es-ES','es-MX','fr','fr-FR','de','de-DE','it','it-IT','pt','pt-PT','ro','ro-RO');

-- idx_rag_tenant (migration 002) already provides the B-tree pre-filter pg_textsearch uses.
```

- [ ] **Step 3: Add the gating options to `migrate.ts`**

In `src/migrate.ts`, extend `MigrateOptions`:

```ts
export interface MigrateOptions {
  /** Apply RLS policies (migration 007). Default: false. */
  rls?: boolean;
  /** Apply CJK support via pg_bigm (migration 009). Default: false. */
  cjk?: boolean;
  /** Apply VectorChord vchordrq index (migration 010). Requires shared_preload_libraries='vchord'. Default: false. */
  vectorchord?: boolean;
  /** Apply pg_textsearch BM25 indexes (migration 011). Requires shared_preload_libraries includes 'pg_textsearch'. Default: false. */
  bm25?: boolean;
  /** Custom path to SQL directory. Default: auto-detected from package. */
  sqlDir?: string;
}
```

Extend the filter chain (after the existing `cjk` filter):

```ts
  const filesToApply = files
    .filter((f: string) => options.rls || !f.includes("rls"))
    .filter((f: string) => options.cjk || !f.includes("cjk"))
    .filter((f: string) => options.vectorchord || !f.includes("vectorchord"))
    .filter((f: string) => options.bm25 || !f.includes("textsearch"));
```

- [ ] **Step 4: Write failing gating tests**

Append to `tests/migrate.test.ts` (inside the `describe("ragMigrate", ...)` block):

```ts
  it("skips VectorChord migration by default", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(appliedMigrations).not.toContain("010_vectorchord.sql");
  });

  it("includes VectorChord migration when vectorchord: true", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir, vectorchord: true });
    expect(appliedMigrations).toContain("010_vectorchord.sql");
  });

  it("skips pg_textsearch migration by default", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(appliedMigrations).not.toContain("011_pg_textsearch.sql");
  });

  it("includes pg_textsearch migration when bm25: true", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir, bm25: true });
    expect(appliedMigrations).toContain("011_pg_textsearch.sql");
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/migrate.test.ts`
Expected: PASS (the existing "applies pending migrations" `>= 6` assertion still holds — default set is 001–006 + 008 = 7).

- [ ] **Step 6: Write the constant↔migration sync test**

Create `tests/bm25Migration.sync.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BM25_LANGUAGE_GROUPS, bm25SupportedLanguages } from "../src/adapters/fts/bm25LanguageGroups.js";

describe("BM25 language groups stay in sync with sql/011_pg_textsearch.sql", () => {
  const sql = readFileSync(
    join(import.meta.dir, "..", "sql", "011_pg_textsearch.sql"),
    "utf-8",
  ).replace(/\s+/g, " ");

  for (const group of BM25_LANGUAGE_GROUPS) {
    it(`has a ${group.config} partial index with the exact language list`, () => {
      const langs = group.languages.map((l) => `'${l}'`).join(",");
      expect(sql).toContain(`text_config='${group.config}'`);
      expect(sql).toContain(`language IN (${langs})`);
    });
  }

  it("has a simple catch-all index excluding every supported language", () => {
    const all = bm25SupportedLanguages().map((l) => `'${l}'`).join(",");
    expect(sql).toContain("text_config='simple'");
    expect(sql).toContain(`language NOT IN (${all})`);
  });
});
```

- [ ] **Step 7: Run the sync test**

Run: `bun test tests/bm25Migration.sync.test.ts`
Expected: PASS. (If it fails, the migration literals and `BM25_LANGUAGE_GROUPS` have drifted — fix one to match the other.)

- [ ] **Step 8: Lint, typecheck, full suite, commit**

```bash
bun run lint && bun run typecheck && bun test
git add sql/010_vectorchord.sql sql/011_pg_textsearch.sql src/migrate.ts tests/migrate.test.ts tests/bm25Migration.sync.test.ts
git commit -m "feat: add gated VectorChord (010) + pg_textsearch (011) migrations"
```

---

## Task 9: Version bump to 0.3.0

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "0.2.5"` to `"version": "0.3.0"` (minor bump signals the `HybridSearchParams` breaking change on a 0.x line).

- [ ] **Step 2: Verify + commit**

```bash
bun run typecheck && bun test
git add package.json
git commit -m "chore: bump to 0.3.0"
```

---

## Task 10: Playground + example compose (live validation)

**Files:**
- Modify: `examples/playground.ts`
- Create: `examples/docker-compose.extensions.yml`

> **Verification for this task is manual** (requires live infra with the extensions). Run via `podman compose` (per project convention). The automated proof of the adapter/strategy/migration logic is Tasks 1–8; this task is the end-to-end smoke test.

- [ ] **Step 1: Add CLI flags + wire the adapter in `examples/playground.ts`**

Add near the top of `main()` (after the existing imports — also add `Bm25Fts` to the import from `../src/index.js`):

```ts
const USE_VECTORCHORD = process.argv.includes("--vectorchord");
const USE_BM25 = process.argv.includes("--bm25");
```

Update the `ragMigrate` call (around line 360) to pass the flags:

```ts
    await ragMigrate(sqlClient, {
      sqlDir: fileURLToPath(new URL("../sql", import.meta.url)),
      vectorchord: USE_VECTORCHORD,
      bm25: USE_BM25,
    });
    console.log(
      `   Done. (vectorchord=${USE_VECTORCHORD}, bm25=${USE_BM25})\n`,
    );
```

Update the adapter construction (around line 373):

```ts
    const db = new PostgresRagDatabase(txProvider, USE_BM25 ? { fts: new Bm25Fts() } : undefined);
```

- [ ] **Step 2: Create `examples/docker-compose.extensions.yml`**

A VectorChord-based image (bundles pgvector + vchord) with `shared_preload_libraries` set. pg_textsearch must be present in the image; confirm the install method against the pinned pg_textsearch release at run time (it is a PG17 extension — either a prebuilt image layer or `CREATE EXTENSION` against an image that ships it). Start from:

```yaml
# Live-extension infra for the playground's --vectorchord / --bm25 flags.
#   podman compose -f examples/docker-compose.extensions.yml up
#
# The db image must provide BOTH vchord and pg_textsearch, with
# shared_preload_libraries set (requires a restart, already baked into image start).
# Verify the exact image tag / pg_textsearch install method against current releases
# before relying on this — see docs/superpowers/specs/2026-06-16-vectorchord-pg-textsearch-design.md.
services:
  db:
    image: tensorchord/vchord-postgres:pg17-v0.4.3
    command:
      - postgres
      - -c
      - shared_preload_libraries=vchord,pg_textsearch
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=postgres
    volumes:
      - pg-data-ext:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 10

  embedding:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-1.9
    ports:
      - "3333:3333"
    volumes:
      - hf-cache:/data
    restart: unless-stopped
    environment:
      - API_KEY=${EMBEDDING_API_KEY}
    command:
      [
        "--model-id", "intfloat/multilingual-e5-small",
        "--max-batch-tokens", "4096",
        "--max-client-batch-size", "8",
        "--port", "3333",
      ]

volumes:
  hf-cache:
  pg-data-ext:
```

- [ ] **Step 3: Manual verification**

```bash
# Terminal 1: bring up the extension-enabled infra
EMBEDDING_API_KEY=... podman compose -f examples/docker-compose.extensions.yml up

# Terminal 2: run the playground against both new legs
bun run examples/playground.ts --vectorchord --bm25
```

Expected: migrations apply (010 + 011), indexing succeeds, searches return ranked results, no errors. If `pg_textsearch` is missing from the image, the migration fails at `CREATE EXTENSION pg_textsearch` — fix the image (Step 2) and rerun.

- [ ] **Step 4: Commit**

```bash
bun run lint && bun run typecheck
git add examples/playground.ts examples/docker-compose.extensions.yml
git commit -m "feat: playground --vectorchord/--bm25 flags + extension compose"
```

---

## Task 11: Documentation

**Files:**
- Modify: `FUTURE_UPGRADES.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update `FUTURE_UPGRADES.md`**

Change the "Planned for the next version" callout (lines 8–12) to a "Shipped in 0.3.0" note, and update the adoption-strategy table rows for VectorChord and pg_textsearch from "Chosen for next version" to "Shipped in 0.3.0". Keep pgvectorscale documented as the fallback. Concretely, replace the blockquote at the top with:

```markdown
> **Shipped in 0.3.0:** **VectorChord** (`vchordrq`) for the vector leg and
> **pg_textsearch** (BM25) for the FTS leg, both opt-in. VectorChord is a
> migration-only swap (`ragMigrate(client, { vectorchord: true })`). BM25 is the
> `Bm25Fts` strategy plus `ragMigrate(client, { bm25: true })`. Both require a
> one-time `shared_preload_libraries` change + rolling restart. pgvectorscale
> remains the documented fallback for the vector leg.
```

- [ ] **Step 2: Update `CLAUDE.md`**

Add to the "Design patterns" list:

```markdown
- **Pluggable FTS strategy** — the FTS leg is an injectable `FtsStrategy` on `PostgresRagDatabase` (`fts` option). `TsvectorFts` (default) uses tsvector/tsquery + `rag_fts_config()`; `Bm25Fts` uses pg_textsearch BM25 (`content <@> query`). The pipeline passes `synonymLookup` (not a pre-built tsquery); the strategy builds its own query form (`buildFtsQuery` vs `buildBm25Query`).
- **BM25 per-language partial indexes** — `Bm25Fts` scopes the FTS leg to `params.language`'s group via `bm25LanguagePredicate()` so the planner uses the matching partial `bm25` index. `BM25_LANGUAGE_GROUPS` (TS) and `sql/011_pg_textsearch.sql` literals are kept in sync by a test.
- **Gated optional extensions** — `ragMigrate` flags `vectorchord` (migration 010, `vchordrq` index swap) and `bm25` (migration 011, pg_textsearch). Both require `shared_preload_libraries` + restart (ops prerequisite, not in the migration).
```

Add the new files to the "Key files" table:

```markdown
| `src/adapters/fts/TsvectorFts.ts` | Default FTS strategy (tsvector/tsquery) |
| `src/adapters/fts/Bm25Fts.ts` | BM25 FTS strategy (pg_textsearch) |
| `src/adapters/fts/bm25LanguageGroups.ts` | BM25 language groups + partial-index predicate |
| `src/adapters/sqlHelpers.ts` | Shared filter-clause + row-mapping helpers |
| `sql/010_vectorchord.sql` | Optional vchordrq index (gated by `vectorchord`) |
| `sql/011_pg_textsearch.sql` | Optional BM25 indexes (gated by `bm25`) |
```

Update the `sql/001-009_*.sql` row to `sql/001-011_*.sql`.

- [ ] **Step 3: Update `README.md`**

Add a short "Optional extensions (0.3.0)" section documenting:
- VectorChord: set `shared_preload_libraries = 'vchord'`, restart, `ragMigrate(client, { vectorchord: true })` — no code change.
- pg_textsearch BM25: set `shared_preload_libraries` to include `pg_textsearch`, restart, `ragMigrate(client, { bm25: true })`, and construct `new PostgresRagDatabase(tx, { fts: new Bm25Fts() })`.
- Both share one rolling restart.

(Match the README's existing heading style and code-block conventions; place after the existing setup/migration section.)

- [ ] **Step 4: Commit**

```bash
git add FUTURE_UPGRADES.md CLAUDE.md README.md
git commit -m "docs: VectorChord + pg_textsearch (0.3.0) usage and patterns"
```

---

## Final verification

- [ ] **Run the full gate:** `bun run lint && bun run typecheck && bun test && bun run build`
  Expected: lint clean, types clean, all tests pass, dual ESM/CJS build succeeds.
- [ ] **Confirm barrel exports:** `buildBm25Query`, `TsvectorFts`, `Bm25Fts`, `FtsStrategy`, `FtsContext`, `PostgresRagDatabaseOptions` are all re-exported from `src/index.ts`.
- [ ] **(If infra available)** Run Task 10's manual playground smoke test.

---

## Task summary

| # | Task | Risk | Automated test |
|---|------|------|----------------|
| 1 | `buildBm25Query` | Low | Yes |
| 2 | BM25 language groups + predicate | Low | Yes |
| 3 | Shared SQL helpers | Low | Yes |
| 4 | `FtsStrategy`/`FtsContext` interfaces | Low | (typecheck) |
| 5 | `TsvectorFts` strategy | Low | Yes |
| 6 | `Bm25Fts` strategy | Low | Yes |
| 7 | Integrate (params/adapter/pipeline) | Med | Yes |
| 8 | Migrations + gating + sync test | Low | Yes |
| 9 | Version bump | Low | — |
| 10 | Playground + compose | Med (infra) | Manual |
| 11 | Docs | Low | — |
