# Language-keyed Setup Recommender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure `recommendForLanguage(language)` function returning a `LanguageRecommendation` (embedder + dimensions + vectorMinScore + stemming + needsNormalization + isCjk) so consumers get one place to read how to wire the library up for a given language.

**Architecture:** A new pure, I/O-free module `src/recommend.ts` in the "exported functions" taxonomy (alongside `detectLanguage`, `normalizeForLanguage`). The embedder/dimensions/vectorMinScore are constants (bge-m3 / 1024 / 0.4 — measured best for ar/th, multilingual default elsewhere). The structural fields are derived from existing sources of truth: `stemming` from a constant mirroring `sql/014_arabic_fts.sql` (sync-guarded by a test), `isCjk` from the CJK set, `needsNormalization` from the languages `normalizeForLanguage` folds. Unknown codes return a lenient multilingual default (no throw).

**Tech Stack:** TypeScript (strict, ES2022), Bun + `bun:test`, Biome lint, tsup build. No runtime dependencies.

## Global Constraints

- Runtime is Bun; tests use `bun:test`; build is tsup targeting ES2022.
- Strict TypeScript, no `any`.
- Zero runtime npm dependencies — `src/recommend.ts` imports nothing at runtime.
- ESM import paths use the `.js` extension (e.g. `from "./recommend.js"`).
- `bun run lint` (Biome) must pass with no errors.
- All public API is re-exported from `src/index.ts`.
- `recommendForLanguage` never throws; unknown/empty codes return the multilingual default.
- Embedder recommendation is constant `BAAI/bge-m3` / `1024` dims / `0.4` vectorMinScore for every language.

## File Structure

- **Create `src/recommend.ts`** — the `LanguageRecommendation` interface, the recommendation constants, the `FTS_STEMMING_GROUPS` source-of-truth constant, and `recommendForLanguage`. One responsibility: map a language code to a recommended setup. No I/O, no imports.
- **Modify `src/index.ts`** — re-export `recommendForLanguage` (Utilities) and the `LanguageRecommendation` type (Types).
- **Create `tests/recommend.test.ts`** — unit + agreement tests (representative table, region subtag, unknown default, `isCjk` vs `detectLanguage`, `needsNormalization` vs `normalizeForLanguage`).
- **Create `tests/recommend.sync.test.ts`** — SQL drift guard: asserts `FTS_STEMMING_GROUPS` matches `sql/014_arabic_fts.sql` (mirrors `tests/bm25Migration.sync.test.ts`).
- **Modify `README.md`** — add a "Recommended setup per language" subsection.

---

### Task 1: Core `recommendForLanguage` + type + barrel export

**Files:**
- Create: `src/recommend.ts`
- Modify: `src/index.ts`
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Consumes: nothing (pure function). Tests consume `detectLanguage` from `src/language.ts` and `normalizeForLanguage` from `src/normalize.ts` (both already exist and are exported).
- Produces:
  - `interface LanguageRecommendation { embedder: string; dimensions: number; vectorMinScore: number; stemming: string; needsNormalization: boolean; isCjk: boolean; }`
  - `function recommendForLanguage(language: string): LanguageRecommendation`
  - `const RECOMMENDED_EMBEDDER: string` (`"BAAI/bge-m3"`), `const RECOMMENDED_DIMENSIONS: number` (`1024`), `const RECOMMENDED_VECTOR_MIN_SCORE: number` (`0.4`)
  - `interface FtsStemmingGroup { config: string; languages: string[]; }`
  - `const FTS_STEMMING_GROUPS: FtsStemmingGroup[]` (mirrors `sql/014`; used by Task 2)
  - `const CJK_LANGUAGES: string[]` (`["zh","ja","ko"]`), `const NORMALIZED_LANGUAGES: string[]` (`["ar","th"]`)

- [ ] **Step 1: Write the failing test**

Create `tests/recommend.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { detectLanguage } from "../src/language.js";
import { normalizeForLanguage } from "../src/normalize.js";
import {
  CJK_LANGUAGES,
  recommendForLanguage,
  RECOMMENDED_DIMENSIONS,
  RECOMMENDED_EMBEDDER,
  RECOMMENDED_VECTOR_MIN_SCORE,
} from "../src/recommend.js";

describe("recommendForLanguage", () => {
  it("recommends the multilingual embedder + calibrated floor for every language", () => {
    for (const lang of ["en", "de", "ar", "th", "zh", "ja", "ko", "xx"]) {
      const rec = recommendForLanguage(lang);
      expect(rec.embedder).toBe(RECOMMENDED_EMBEDDER);
      expect(rec.embedder).toBe("BAAI/bge-m3");
      expect(rec.dimensions).toBe(RECOMMENDED_DIMENSIONS);
      expect(rec.dimensions).toBe(1024);
      expect(rec.vectorMinScore).toBe(RECOMMENDED_VECTOR_MIN_SCORE);
      expect(rec.vectorMinScore).toBe(0.4);
    }
  });

  it("resolves the representative per-language structural table", () => {
    expect(recommendForLanguage("en")).toEqual({
      embedder: "BAAI/bge-m3",
      dimensions: 1024,
      vectorMinScore: 0.4,
      stemming: "english",
      needsNormalization: false,
      isCjk: false,
    });
    expect(recommendForLanguage("de")).toMatchObject({
      stemming: "german",
      needsNormalization: false,
      isCjk: false,
    });
    expect(recommendForLanguage("ar")).toMatchObject({
      stemming: "arabic",
      needsNormalization: true,
      isCjk: false,
    });
    expect(recommendForLanguage("th")).toMatchObject({
      stemming: "none",
      needsNormalization: true,
      isCjk: false,
    });
    expect(recommendForLanguage("zh")).toMatchObject({
      stemming: "none",
      needsNormalization: false,
      isCjk: true,
    });
    expect(recommendForLanguage("ja")).toMatchObject({ stemming: "none", isCjk: true });
    expect(recommendForLanguage("ko")).toMatchObject({ stemming: "none", isCjk: true });
  });

  it("ignores the region subtag (ar-SA → ar, en-US → en, en-GB → en)", () => {
    expect(recommendForLanguage("ar-SA").stemming).toBe("arabic");
    expect(recommendForLanguage("ar-SA").needsNormalization).toBe(true);
    expect(recommendForLanguage("en-US").stemming).toBe("english");
    // base-code fallback stems an unlisted region (en-GB) as english too
    expect(recommendForLanguage("en-GB").stemming).toBe("english");
  });

  it("returns the lenient multilingual default for unknown/empty codes (no throw)", () => {
    expect(recommendForLanguage("xx")).toEqual({
      embedder: "BAAI/bge-m3",
      dimensions: 1024,
      vectorMinScore: 0.4,
      stemming: "none",
      needsNormalization: false,
      isCjk: false,
    });
    expect(() => recommendForLanguage("")).not.toThrow();
    expect(recommendForLanguage("").stemming).toBe("none");
  });

  it("isCjk agrees with detectLanguage's CJK outputs", () => {
    expect(detectLanguage("日本語のテキストです")).toBe("ja");
    expect(detectLanguage("한국어 텍스트입니다")).toBe("ko");
    expect(detectLanguage("中文文本内容")).toBe("zh");
    for (const lang of CJK_LANGUAGES) {
      expect(recommendForLanguage(lang).isCjk).toBe(true);
    }
    expect(recommendForLanguage("en").isCjk).toBe(false);
  });

  it("needsNormalization agrees with normalizeForLanguage being non-identity", () => {
    // ar: hamza-above alef folds to bare alef → string changes
    expect(normalizeForLanguage("أحمد", "ar")).not.toBe("أحمد");
    expect(recommendForLanguage("ar").needsNormalization).toBe(true);
    // th: Thai digits fold to ASCII → string changes
    expect(normalizeForLanguage("๑๒๓", "th")).toBe("123");
    expect(recommendForLanguage("th").needsNormalization).toBe(true);
    // en: NFC-only, identity on plain ASCII
    expect(normalizeForLanguage("Hello", "en")).toBe("Hello");
    expect(recommendForLanguage("en").needsNormalization).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/recommend.test.ts`
Expected: FAIL — `Cannot find module '../src/recommend.js'` (the module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/recommend.ts`:

```ts
/** Recommended embedding model for all languages: measured best for ar/th and a strong multilingual default. */
export const RECOMMENDED_EMBEDDER = "BAAI/bge-m3";
/** Embedding dimension of RECOMMENDED_EMBEDDER. Feed into ragMigrate({ embeddingDimensions }). */
export const RECOMMENDED_DIMENSIONS = 1024;
/** Starting-point vectorMinScore for RECOMMENDED_EMBEDDER's cosine calibration (validate per corpus). */
export const RECOMMENDED_VECTOR_MIN_SCORE = 0.4;

/** A Postgres FTS stemming group: one regconfig + the language codes it covers. */
export interface FtsStemmingGroup {
  config: string;
  languages: string[];
}

/**
 * Language → Postgres FTS regconfig groups. SINGLE SOURCE OF TRUTH mirroring the
 * rag_fts_config() CASE map in sql/014_arabic_fts.sql (tests/recommend.sync.test.ts asserts this).
 * Superset of BM25_LANGUAGE_GROUPS, which omits Arabic. Codes not covered here stem as the
 * Postgres 'simple' config, reported by recommendForLanguage as "none".
 */
export const FTS_STEMMING_GROUPS: FtsStemmingGroup[] = [
  { config: "english", languages: ["en", "en-US", "en-IN"] },
  { config: "spanish", languages: ["es", "es-ES", "es-MX"] },
  { config: "french", languages: ["fr", "fr-FR"] },
  { config: "german", languages: ["de", "de-DE"] },
  { config: "italian", languages: ["it", "it-IT"] },
  { config: "portuguese", languages: ["pt", "pt-PT"] },
  { config: "romanian", languages: ["ro", "ro-RO"] },
  { config: "arabic", languages: ["ar", "ar-SA", "ar-EG"] },
];

/** CJK languages routed to the pg_bigm keyword path. Matches detectLanguage's CJK outputs. */
export const CJK_LANGUAGES: string[] = ["zh", "ja", "ko"];

/** Languages for which normalizeForLanguage applies more than NFC (orthographic folds / digit folding). */
export const NORMALIZED_LANGUAGES: string[] = ["ar", "th"];

/** A recommended setup for working in a given language. Advisory — the consumer maps each field. */
export interface LanguageRecommendation {
  /** Canonical HuggingFace repo id of the recommended embedding model. */
  embedder: string;
  /** Embedding dimension of `embedder`. Feed into ragMigrate({ embeddingDimensions }). */
  dimensions: number;
  /** Suggested vectorMinScore for `embedder`'s cosine calibration (a starting point). */
  vectorMinScore: number;
  /** Postgres FTS regconfig for this language ('english', 'arabic', …), or 'none' (simple). */
  stemming: string;
  /** normalizeForLanguage applies more than NFC for this language (Arabic folding, Thai digits). */
  needsNormalization: boolean;
  /** CJK language → enable the pg_bigm keyword path (cjk: true on adapter + migration). */
  isCjk: boolean;
}

/** Base language code: region subtag stripped and lowercased ("ar-SA" → "ar"). Mirrors normalizeForLanguage. */
function baseCode(language: string): string {
  return (language ?? "").split("-")[0].toLowerCase();
}

/** Postgres FTS regconfig for `language`, or "none". Matches by exact code or base code. */
function stemmingForLanguage(language: string): string {
  const base = baseCode(language);
  for (const group of FTS_STEMMING_GROUPS) {
    if (group.languages.includes(language) || group.languages.includes(base)) {
      return group.config;
    }
  }
  return "none";
}

/**
 * Recommend a full setup for working in `language`. Pure/advisory — the consumer maps each field
 * to the right place (search options, ragMigrate options, provider construction). Accepts
 * BCP-47-style codes; the region subtag is ignored ("ar-SA" → "ar"). Unknown/empty codes return
 * the multilingual default with whitespace/simple structural assumptions. Never throws.
 */
export function recommendForLanguage(language: string): LanguageRecommendation {
  const base = baseCode(language);
  return {
    embedder: RECOMMENDED_EMBEDDER,
    dimensions: RECOMMENDED_DIMENSIONS,
    vectorMinScore: RECOMMENDED_VECTOR_MIN_SCORE,
    stemming: stemmingForLanguage(language),
    needsNormalization: NORMALIZED_LANGUAGES.includes(base),
    isCjk: CJK_LANGUAGES.includes(base),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/recommend.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Export from the barrel**

Two edits in `src/index.ts`. Both new symbols live in `recommend.ts` (NOT `types.ts`), so each is its own new `from "./recommend.js"` line.

Edit A — the function. Find this existing line in the Utilities region:

```ts
export { LanguageNormalizer, normalizeForLanguage } from "./normalize.js";
```

and add the recommend export immediately after it:

```ts
export { LanguageNormalizer, normalizeForLanguage } from "./normalize.js";
export { recommendForLanguage } from "./recommend.js";
```

Edit B — the type. Find the closing line of the `// Types` block:

```ts
  SynonymRow,
} from "./types.js";
```

and add a new line immediately after it:

```ts
  SynonymRow,
} from "./types.js";
export type { LanguageRecommendation } from "./recommend.js";
```

- [ ] **Step 6: Verify the barrel export typechecks and lints**

Run: `bun run typecheck && bun run lint`
Expected: PASS — no type errors, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/recommend.ts src/index.ts tests/recommend.test.ts
git commit -m "feat(recommend): add recommendForLanguage setup recommender

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SQL drift guard for the stemming map

**Files:**
- Test: `tests/recommend.sync.test.ts`

**Interfaces:**
- Consumes: `FTS_STEMMING_GROUPS` from `src/recommend.ts` (Task 1); the file `sql/014_arabic_fts.sql`.
- Produces: nothing (test-only).

**Why a separate task:** This guards `FTS_STEMMING_GROUPS` against drift from the SQL migration — a distinct concern from the function's behavior, reviewable on its own (mirrors the existing split between `tests/bm25LanguageGroups.test.ts` and `tests/bm25Migration.sync.test.ts`).

- [ ] **Step 1: Write the failing test**

Create `tests/recommend.sync.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FTS_STEMMING_GROUPS } from "../src/recommend.js";

// Collapse all whitespace runs to a single space so the migration's column-alignment spacing
// does not affect substring matching (same approach as tests/bm25Migration.sync.test.ts).
const sql = readFileSync(
  join(import.meta.dir, "..", "sql", "014_arabic_fts.sql"),
  "utf-8",
).replace(/\s+/g, " ");

describe("FTS_STEMMING_GROUPS stays in sync with rag_fts_config (sql/014_arabic_fts.sql)", () => {
  for (const group of FTS_STEMMING_GROUPS) {
    it(`maps ${group.languages.join(", ")} → '${group.config}'`, () => {
      const langs = group.languages.map((l) => `'${l}'`).join(", ");
      expect(sql).toContain(`lang IN (${langs}) THEN '${group.config}'`);
    });
  }

  it("everything else falls back to the 'simple' config", () => {
    expect(sql).toContain("ELSE 'simple'");
  });
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `bun test tests/recommend.sync.test.ts`
Expected: PASS — `FTS_STEMMING_GROUPS` already mirrors `sql/014` exactly (8 group assertions + the `ELSE 'simple'` assertion).

This test has no separate red phase: it asserts an already-true invariant (the constant was written to match the SQL in Task 1). To confirm it can actually fail, temporarily change one language literal in `FTS_STEMMING_GROUPS` (e.g. `"en"` → `"xx"`), re-run, observe FAIL, then revert. (Optional sanity check — do not commit the temporary edit.)

- [ ] **Step 3: Commit**

```bash
git add tests/recommend.sync.test.ts
git commit -m "test(recommend): guard FTS stemming map against sql/014 drift

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: README documentation + full verification

**Files:**
- Modify: `README.md` (add a subsection after the "Recommended configurations" section, before `### Index`)

**Interfaces:**
- Consumes: `recommendForLanguage`, `LanguageRecommendation` (Task 1).
- Produces: nothing (docs).

- [ ] **Step 1: Add the README subsection**

In `README.md`, locate the end of the "Recommended configurations" section — the BM25 bullet that ends with "Requires migrations 011 + 015 and `shared_preload_libraries` (see Optional extensions)." — and the following `### Index` heading. Insert this new subsection between them:

````markdown
#### Recommended setup per language

`recommendForLanguage(language)` returns the calibrated starting points for a language in one
object, so you don't have to re-derive them from the code and benchmark logs. It is **advisory
and pure** — it returns values; you decide where to apply them.

```typescript
import { recommendForLanguage, ragMigrate, RagPipeline, LanguageNormalizer } from "pg-hybrid-rag";

const rec = recommendForLanguage("ar");
// rec = {
//   embedder: "BAAI/bge-m3",   // measured best for ar/th; strong multilingual default elsewhere
//   dimensions: 1024,          // size the embedding column to match
//   vectorMinScore: 0.4,       // starting point for bge-m3's cosine calibration
//   stemming: "arabic",        // Postgres FTS regconfig ("english" | … | "none")
//   needsNormalization: true,  // construct a LanguageNormalizer for this language
//   isCjk: false,              // true for zh/ja/ko → pg_bigm keyword path
// }

// install-time: size the embedding column + enable the CJK migration leg if needed
await ragMigrate(db, { embeddingDimensions: rec.dimensions, cjk: rec.isCjk });

// construction-time: pick providers from the structural flags
const normalizer = rec.needsNormalization ? new LanguageNormalizer() : undefined;
const pipeline = new RagPipeline({ tenantId, db, embedder, normalizer });

// query-time: use the calibrated floor
await pipeline.search(query, { language: "ar", vectorMinScore: rec.vectorMinScore });
```

| Field | Meaning |
|-------|---------|
| `embedder` / `dimensions` / `vectorMinScore` | Constant `BAAI/bge-m3` / `1024` / `0.4` — **measured** best for Arabic and Thai, applied as a multilingual default for every language. Thresholds are starting points; validate on your corpus. |
| `stemming` | Postgres FTS regconfig for the language (`"english"`, `"arabic"`, …) or `"none"` (the `simple` config). Mirrors `rag_fts_config`. |
| `needsNormalization` | `true` where `normalizeForLanguage` does more than NFC (Arabic orthographic folds, Thai digit folding) — i.e. construct a `LanguageNormalizer`. |
| `isCjk` | `true` for `zh`/`ja`/`ko` → enable the pg_bigm keyword path (`cjk: true` in the migration and adapter). |

> **The embedding dimension is per-database, not per-tenant.** `rec.dimensions` feeds the one-time
> `ragMigrate({ embeddingDimensions })`; the `rag_documents.embedding` column is a single fixed
> dimension shared by all tenants in that database. You can use a different embedder per tenant only
> if it has the **same** dimension — genuinely different dimensions (e.g. multilingual-e5-small at
> 384 vs bge-m3 at 1024) require separate databases. Because the recommendation is bge-m3/1024 for
> every language, one 1024-dim database hosts all languages cleanly.

> **No segmenter is recommended.** A Thai segmentation A/B (attacut / ICU / pg_bigm vs unsegmented)
> was a clean negative — unsegmented `pg_trgm` matched or beat every segmented arm and lost at the
> default `keywordMinScore`. The `Segmenter` interface remains available for consumers who measure a
> win on their own corpus.
````

- [ ] **Step 2: Run the full verification suite**

Run: `bun test && bun run typecheck && bun run lint && bun run build`
Expected: PASS — all tests green (including `tests/recommend.test.ts` and `tests/recommend.sync.test.ts`), no type errors, no lint errors, build emits `dist/`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document recommendForLanguage per-language setup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**
- Pure function in the exported-functions taxonomy → Task 1 (`src/recommend.ts`, no imports). ✓
- `LanguageRecommendation` shape (embedder/dimensions/vectorMinScore/stemming/needsNormalization/isCjk) → Task 1. ✓
- Structural fields from sources of truth: `stemming` ← `sql/014` (Task 1 constant + Task 2 sync guard); `isCjk` ← CJK set + `detectLanguage` agreement test; `needsNormalization` ← `normalizeForLanguage` agreement test (both Task 1). ✓
- Measured embedder/threshold constant (bge-m3/1024/0.4) → Task 1. ✓
- Region subtag handling ("ar-SA" → "ar") + lenient unknown/empty default, no throw → Task 1 tests. ✓
- `needsSegmenter` dropped, recorded as a measured non-goal → not in the type; README + spec note. ✓
- CJK = pg_bigm only (no segmenter) → `isCjk` only; README note. ✓
- Per-database dimension constraint → README callout (Task 3). ✓
- Barrel export → Task 1 Step 5. ✓
- Sync-guard test (BM25 precedent) → Task 2. ✓
- README "Recommended setup per language" → Task 3. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command shows expected output. ✓

**3. Type consistency:** `recommendForLanguage`, `LanguageRecommendation`, `FTS_STEMMING_GROUPS`, `RECOMMENDED_EMBEDDER`, `RECOMMENDED_DIMENSIONS`, `RECOMMENDED_VECTOR_MIN_SCORE`, `CJK_LANGUAGES`, `NORMALIZED_LANGUAGES` are named identically in the Interfaces blocks, the implementation (Task 1 Step 3), the unit test (Task 1 Step 1), and the sync test (Task 2 Step 1). The unit test imports `RECOMMENDED_*` constants and `CJK_LANGUAGES`; all are exported by `src/recommend.ts`. ✓
