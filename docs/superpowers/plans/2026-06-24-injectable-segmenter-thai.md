# Injectable Segmenter + Thai Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a general, injectable `Segmenter` provider that rewrites whitespace-less scripts (Thai, CJK) into space-delimited word tokens for the lexical legs, and wire Thai support end-to-end (detection, normalization, chunking, keyword-leg routing).

**Architecture:** A new `Segmenter` interface mirrors the existing `Normalizer`: injected on `RagPipeline` (query), `RagIndexer` (content → `content_normalized`), and `PostgresRagDatabase` (keyword-leg routing via a self-describing `segmentsLanguage`). An optional zero-dep `IntlSegmenterAdapter` (stdlib `Intl.Segmenter`) is the reference impl. The `Chunker` gains an always-on grapheme-safe slicing fix plus a new `async chunkSegmented()` that cuts on word boundaries while emitting natural (unsegmented) text. No new SQL migration — the seam rides the existing `content_normalized` column and its indexes.

**Tech Stack:** TypeScript (strict), Bun runtime + `bun:test`, Biome lint, tsup build. Spec: `docs/superpowers/specs/2026-06-24-injectable-segmenter-design.md`.

## Global Constraints

- **Zero runtime dependencies** — no npm deps; only stdlib (`Intl`, `fetch`, regex).
- **Node + Bun compatible** — shipped code uses only stdlib APIs; no Bun-only globals.
- **Strict TypeScript, no `any`.**
- **No real DB / embedding API in tests** — mock `RagDatabase`, `EmbeddingProvider`, `Segmenter`, `SqlClient`/`TransactionProvider`. Tests run under `bun:test`.
- **`IntlSegmenterAdapter` tests assert STRUCTURAL properties only** (no exact Thai output — it's ICU-quality-dependent and must stay runtime-stable across Node/Bun).
- **Public API re-exported from `src/index.ts`** (the barrel).
- **No `chunk()` signature change** — word-aware segmentation is a separate `chunkSegmented()` method.
- **Verification gate per task:** `bun test <file>` green; `bun run typecheck` and `bun run lint` clean for touched files.

---

### Task 1: `Segmenter` interface + `IntlSegmenterAdapter` + exports

**Files:**
- Modify: `src/interfaces.ts` (append the `Segmenter` interface after `Normalizer`, ~line 161)
- Create: `src/adapters/IntlSegmenter.ts`
- Modify: `src/index.ts` (add exports)
- Test: `tests/intlSegmenter.test.ts`

**Interfaces:**
- Produces:
  - `interface Segmenter { segment(text: string, language: string): string | Promise<string>; segmentsLanguage(language: string): boolean; }`
  - `interface IntlSegmenterAdapterConfig { languages: string[] }`
  - `class IntlSegmenterAdapter implements Segmenter` — constructor `(config: IntlSegmenterAdapterConfig)`.

- [ ] **Step 1: Write the failing test**

Create `tests/intlSegmenter.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { IntlSegmenterAdapter } from "../src/adapters/IntlSegmenter.js";

describe("IntlSegmenterAdapter", () => {
  it("passes through a language it is not configured for (unchanged)", () => {
    const seg = new IntlSegmenterAdapter({ languages: ["th"] });
    expect(seg.segment("hello world", "en")).toBe("hello world");
  });

  it("reports handled languages via segmentsLanguage (base subtag match)", () => {
    const seg = new IntlSegmenterAdapter({ languages: ["th", "zh"] });
    expect(seg.segmentsLanguage("th")).toBe(true);
    expect(seg.segmentsLanguage("th-TH")).toBe(true);
    expect(seg.segmentsLanguage("zh")).toBe(true);
    expect(seg.segmentsLanguage("en")).toBe(false);
  });

  it("inserts spaces only — preserves the non-whitespace character sequence (space-insertion contract)", () => {
    const seg = new IntlSegmenterAdapter({ languages: ["th"] });
    const input = "ผมอยากเปลี่ยนแพ็กเกจอินเทอร์เน็ต";
    const out = seg.segment(input, "th");
    // Structural assertion (NOT exact segmentation — that is ICU-dependent):
    // removing all whitespace recovers the original exactly.
    expect(out.replace(/\s+/g, "")).toBe(input);
  });

  it("returns empty string for empty input", () => {
    const seg = new IntlSegmenterAdapter({ languages: ["th"] });
    expect(seg.segment("", "th")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/intlSegmenter.test.ts`
Expected: FAIL — cannot find module `../src/adapters/IntlSegmenter.js`.

- [ ] **Step 3: Add the `Segmenter` interface to `src/interfaces.ts`**

Append at the end of `src/interfaces.ts` (after the `Normalizer` interface):

```ts
/**
 * Word segmentation for scripts without whitespace word boundaries (Thai, CJK, …).
 * Applied symmetrically to indexed content and the lexical query; feeds the LEXICAL
 * legs only (never the dense embedding or the reranker). Language-gated: implementations
 * return the input unchanged for languages they don't handle. Async-capable so an
 * HTTP-backed segmenter is a drop-in, exactly like Normalizer.
 *
 * CONTRACT (space-insertion only): segment() may INSERT whitespace at word boundaries
 * but must otherwise preserve the original non-whitespace characters in order (no
 * reordering, substitution, or dropping). The Chunker relies on this to reconstruct
 * natural (unsegmented) chunk text from the segmented form (see Chunker.chunkSegmented).
 */
export interface Segmenter {
  /** Return `text` rewritten as space-joined word tokens, or unchanged for a language
   *  this segmenter does not handle. */
  segment(text: string, language: string): string | Promise<string>;
  /** Whether this segmenter rewrites `language`. Lets PostgresRagDatabase route a
   *  segmented language's keyword leg to trgm instead of pg_bigm. Routing only — this
   *  method must never segment. Must agree with `segment`. */
  segmentsLanguage(language: string): boolean;
}
```

- [ ] **Step 4: Create `src/adapters/IntlSegmenter.ts`**

```ts
import type { Segmenter } from "../interfaces.js";

export interface IntlSegmenterAdapterConfig {
  /**
   * Base language codes to word-segment (e.g. ["th", "zh", "ja"]). Any language NOT in
   * this list is returned unchanged by segment(). Matched on the base subtag (before "-"),
   * so "th" covers "th-TH".
   */
  languages: string[];
}

/** Base subtag, lowercased (e.g. "th-TH" → "th"). */
function base(language: string): string {
  return (language ?? "").split("-")[0].toLowerCase();
}

/**
 * Optional zero-dependency Segmenter backed by the runtime's stdlib Intl.Segmenter
 * (works on Node and Bun). Inserts a single space between word-granularity segments.
 *
 * LIMITATION: segmentation quality depends on the host ICU break dictionary. ICU's Thai
 * dictionary segments native vocabulary reasonably but SHREDS loanwords not in its
 * dictionary — verified identical on Node 24 (full ICU) and Bun 1.3. For loanword-heavy
 * domains this is a runnable reference, not production-grade; inject a dictionary-based
 * (PyThaiNLP-newmm) or ML (deepcut/attacut) or HTTP segmenter for those.
 */
export class IntlSegmenterAdapter implements Segmenter {
  private readonly langs: Set<string>;
  private readonly cache = new Map<string, Intl.Segmenter>();

  constructor(config: IntlSegmenterAdapterConfig) {
    this.langs = new Set(config.languages.map(base));
  }

  segmentsLanguage(language: string): boolean {
    return this.langs.has(base(language));
  }

  segment(text: string, language: string): string {
    if (!text || !this.segmentsLanguage(language)) return text;
    const seg = this.getSegmenter(base(language));
    const out: string[] = [];
    for (const { segment } of seg.segment(text)) {
      if (segment.trim()) out.push(segment);
    }
    return out.join(" ");
  }

  private getSegmenter(baseLang: string): Intl.Segmenter {
    let seg = this.cache.get(baseLang);
    if (!seg) {
      seg = new Intl.Segmenter(baseLang, { granularity: "word" });
      this.cache.set(baseLang, seg);
    }
    return seg;
  }
}
```

- [ ] **Step 5: Add exports to `src/index.ts`**

In the Adapters block, add (keep alphabetical with the other adapter exports):

```ts
export type { IntlSegmenterAdapterConfig } from "./adapters/IntlSegmenter.js";
export { IntlSegmenterAdapter } from "./adapters/IntlSegmenter.js";
```

In the Interfaces `export type { ... }` block, add `Segmenter` to the list (alphabetical, after `RerankerProvider`).

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/intlSegmenter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Verify types compile (Intl.Segmenter is in lib.es2022.intl, included by target ES2022 — no tsconfig change expected)**

Run: `bun run typecheck`
Expected: clean. If it reports `Property 'Segmenter' does not exist on type 'typeof Intl'`, add `"lib": ["ES2022", "ES2022.Intl"]` to `tsconfig.json` `compilerOptions` and re-run.

- [ ] **Step 8: Lint and commit**

```bash
bun run lint
git add src/interfaces.ts src/adapters/IntlSegmenter.ts src/index.ts tests/intlSegmenter.test.ts
git commit -m "feat(segmenter): add Segmenter interface + zero-dep IntlSegmenterAdapter"
```

---

### Task 2: Thai language detection

**Files:**
- Modify: `src/language.ts` (`detectLanguage`)
- Test: `tests/language.test.ts` (add cases)

**Interfaces:**
- Consumes: `detectLanguage(text: string): string` (existing).
- Produces: `detectLanguage` now returns `"th"` for Thai-dominant text.

- [ ] **Step 1: Write the failing test**

Add inside the `describe("detectLanguage", …)` block in `tests/language.test.ts`:

```ts
it("detects Thai from Thai script", () => {
  expect(detectLanguage("ผมอยากเปลี่ยนแพ็กเกจ")).toBe("th");
});

it("detects Thai when Thai dominates mixed Latin", () => {
  expect(detectLanguage("อินเทอร์เน็ต 5g")).toBe("th");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/language.test.ts`
Expected: FAIL — currently returns `"en"` for Thai.

- [ ] **Step 3: Implement Thai counting + return**

In `src/language.ts`:

Add the counter declaration alongside the others:

```ts
  let hangul = 0;
  let thai = 0;
```

Add a Thai branch in the `for…of` classification chain, right after the Devanagari `if`:

```ts
    if (code >= 0x0900 && code <= 0x097f) devanagari++;
    else if (code >= 0x0e00 && code <= 0x0e7f) thai++;
    else if (
```

Include `thai` in the total:

```ts
  const total = devanagari + arabic + latin + han + kana + hangul + thai;
```

Add the decisive return right after the Chinese check (before the Arabic check):

```ts
  if (han > 0 && han / total >= 0.5) return "zh";
  if (thai / total > 0.5) return "th";
  if (arabic / total > 0.5) return "ar";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/language.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Lint and commit**

```bash
bun run lint
git add src/language.ts tests/language.test.ts
git commit -m "feat(language): detect Thai script (U+0E00-0E7F)"
```

---

### Task 3: Thai orthographic normalization

**Files:**
- Modify: `src/normalize.ts` (add `normalizeThai` + branch in `normalizeForLanguage`)
- Test: `tests/normalize.test.ts` (add a Thai describe block)

**Interfaces:**
- Consumes: `normalizeForLanguage(text: string, language: string, opts?: ArabicNormalizeOptions): string` (existing).
- Produces: `normalizeForLanguage(x, "th")` folds Thai digits ๐–๙ → 0–9 and applies NFC.

- [ ] **Step 1: Write the failing test**

Add to `tests/normalize.test.ts`:

```ts
describe("normalizeForLanguage (Thai)", () => {
  it("folds Thai digits to ASCII", () => {
    expect(normalizeForLanguage("๓๕๐", "th")).toBe("350");
  });

  it("leaves Thai letters untouched", () => {
    expect(normalizeForLanguage("ราคา", "th")).toBe("ราคา");
  });

  it("is idempotent", () => {
    const once = normalizeForLanguage("ราคา ๑๒๓ บาท", "th");
    expect(normalizeForLanguage(once, "th")).toBe(once);
  });
});
```

(If `tests/normalize.test.ts` does not already import `normalizeForLanguage`, add `import { normalizeForLanguage } from "../src/normalize.js";` — match the file's existing import style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/normalize.test.ts`
Expected: FAIL — `"๓๕๐"` is returned unchanged (no Thai branch).

- [ ] **Step 3: Implement `normalizeThai` and branch**

In `src/normalize.ts`, add near the other code-point constants:

```ts
const THAI_DIGITS = /[๐-๙]/g; // ๐-๙ → 0-9
```

Add the function (next to `normalizeArabic`):

```ts
function normalizeThai(text: string): string {
  // Thai needs no diacritic stripping for IR; fold the Thai digits and NFC-normalize so
  // combining marks have a canonical order. Mark-reordering is deferred (YAGNI).
  return text.normalize("NFC").replace(THAI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0e50));
}
```

In `normalizeForLanguage`, add the Thai branch before the NFC fallback:

```ts
  const base = (language ?? "").split("-")[0].toLowerCase();
  if (base === "ar") return normalizeArabic(text, opts);
  if (base === "th") return normalizeThai(text);
  return text.normalize("NFC");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint
git add src/normalize.ts tests/normalize.test.ts
git commit -m "feat(normalize): Thai digit folding + NFC (normalizeThai)"
```

---

### Task 4: Thai trailing punctuation

**Files:**
- Modify: `src/punctuation.ts` (`TRAILING_PUNCTUATION`)
- Test: `tests/punctuation.test.ts` (add cases)

**Interfaces:**
- Consumes/Produces: `stripTrailingPunctuation(text: string): string`, `TRAILING_PUNCTUATION: RegExp` (existing) — now also strips ๆ (U+0E46) and ฯ (U+0E2F).

- [ ] **Step 1: Write the failing test**

Add to `tests/punctuation.test.ts`:

```ts
it("strips Thai trailing marks (mai yamok, paiyannoi)", () => {
  expect(stripTrailingPunctuation("เด็กๆ")).toBe("เด็ก");
  expect(stripTrailingPunctuation("กรุงเทพฯ")).toBe("กรุงเทพ");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/punctuation.test.ts`
Expected: FAIL — ๆ / ฯ not in the trailing set.

- [ ] **Step 3: Add the Thai marks to the regex**

In `src/punctuation.ts`, insert `ๆฯ` into the character class (before the closing-bracket group):

```ts
export const TRAILING_PUNCTUATION = /[?.!,;:।॥؟،؛。！？、；：ๆฯ)\]}"'…’”]+$/;
```

Update the leading doc comment to mention Thai:

```ts
/**
 * Trailing punctuation regex covering all supported scripts:
 * Latin (?.!,;:), Hindi (।॥), Arabic (؟،؛), CJK (。！？、；：), Thai (ๆ ฯ),
 * plus common closing marks: brackets )]} , straight/curly quotes "'’” , and the … ellipsis.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/punctuation.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint
git add src/punctuation.ts tests/punctuation.test.ts
git commit -m "feat(punctuation): strip Thai mai yamok (ๆ) and paiyannoi (ฯ)"
```

---

### Task 5: Chunker grapheme-safe slicing (always-on correctness fix)

**Files:**
- Modify: `src/Chunker.ts` (`splitFixedSize`, `getOverlapSuffix`, add `toGraphemes` helper)
- Test: `tests/chunker.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `Chunker` (no signature change).
- Produces: module-level `toGraphemes(text: string): string[]` (used again by Task 6). Slicing never orphans a combining mark.

- [ ] **Step 1: Write the failing test**

Add to `tests/chunker.test.ts`:

```ts
describe("grapheme-safe hard slicing", () => {
  it("never orphans a Thai combining mark when hard-slicing a delimiter-free run", () => {
    // "กิ" = ก (base) + ◌ิ (U+0E34, nonspacing mark). 6 clusters, 12 UTF-16 units, no spaces.
    const text = "กิ".repeat(6);
    const chunks = new Chunker(5, 0).chunk(text); // char mode, size 5, no overlap → hard slices
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(/^\p{M}/u.test(c.content)).toBe(false); // no chunk starts with a combining mark
    }
    // No data loss (overlap 0): concatenation reconstructs the original.
    expect(chunks.map((c) => c.content).join("")).toBe(text);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/chunker.test.ts`
Expected: FAIL — code-point slicing puts ◌ิ at the start of a chunk.

- [ ] **Step 3: Add `toGraphemes` and make slicing grapheme-safe**

In `src/Chunker.ts`, add a module-level helper (above the `Chunker` class):

```ts
/**
 * Split into grapheme clusters: a base code point plus any following combining marks, OR a
 * run of leading marks. Regex-based (no Intl dependency); the `u` flag keeps astral code
 * points whole. Ensures a fixed-size slice never orphans a Thai/Devanagari/Arabic mark.
 */
function toGraphemes(text: string): string[] {
  return text.match(/\P{M}\p{M}*|\p{M}+/gu) ?? [];
}
```

In `splitFixedSize`, replace the code-point iteration with grapheme clusters:

```ts
  private splitFixedSize(
    text: string,
    effectiveSize: number,
    emit: (content: string) => void,
  ): string {
    const units = toGraphemes(text);
    let slice = "";
    for (const cp of units) {
      if (slice.length + cp.length > effectiveSize) {
        emit(slice.trim());
        const overlap = this.getOverlapSuffix(slice);
        slice = overlap.length < effectiveSize ? overlap : "";
      }
      slice += cp;
    }
    return slice;
  }
```

In `getOverlapSuffix`, strip leading combining marks after the existing surrogate guard:

```ts
    let raw = text.slice(-this.overlap);
    // slice(-overlap) cuts on a UTF-16 code unit: drop an orphaned low surrogate, then any
    // leading combining marks, so overlap never begins with a mark severed from its base.
    const first = raw.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) raw = raw.slice(1);
    raw = raw.replace(/^\p{M}+/u, "");
    const spaceIdx = raw.indexOf(" ");
    return spaceIdx >= 0 ? raw.slice(spaceIdx + 1) : raw;
```

- [ ] **Step 4: Run test to verify it passes (and no regression)**

Run: `bun test tests/chunker.test.ts`
Expected: PASS — the new test and all existing chunker tests (including the `"😀".repeat(10)` astral test) stay green.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint
git add src/Chunker.ts tests/chunker.test.ts
git commit -m "fix(chunker): grapheme-safe hard slicing (no orphaned combining marks)"
```

---

### Task 6: Chunker `chunkSegmented()` (word-aware, natural-text output)

**Files:**
- Modify: `src/interfaces.ts` (`ChunkingProvider` — add optional `chunkSegmented`)
- Modify: `src/Chunker.ts` (`ChunkerConfig.segmenter`, constructor, `CHARS_PER_TOKEN["th"]`, `chunkSegmented`, helpers `wordUnits`/`overlapUnits`/`packUnits`)
- Test: `tests/chunker.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `Segmenter` (Task 1); `toGraphemes` (Task 5).
- Produces:
  - `ChunkerConfig.segmenter?: Segmenter`
  - `Chunker.chunkSegmented(text: string, metadata?: Record<string, string>): Promise<Chunk[]>`
  - `ChunkingProvider.chunkSegmented?(text, metadata?): Promise<Chunk[]>` (optional)

- [ ] **Step 1: Write the failing test**

Add to `tests/chunker.test.ts` (add `import type { Segmenter } from "../src/interfaces.js";` at the top):

```ts
describe("chunkSegmented (word-aware)", () => {
  // Deterministic mock (NOT ICU): inserts a space every 3 chars → fixed 3-char "words".
  const seg: Segmenter = {
    segmentsLanguage: (l) => l === "th",
    segment: (t, l) => (l === "th" ? (t.match(/.{1,3}/gsu) ?? []).join(" ") : t),
  };

  it("cuts on segmenter word boundaries and emits natural (space-free) text", async () => {
    const c = new Chunker({ tokenLimit: 7, overlap: 0, segmenter: seg }); // th ratio 1.5 → size 10
    const text = "กขคงจฉชญฎฏฐฑ"; // 12 single-unit chars, no spaces
    const chunks = await c.chunkSegmented(text, { language: "th" });
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) {
      expect(ch.content).not.toContain(" "); // natural text — inserted spaces dropped
      expect(ch.content.length % 3).toBe(0); // cut only on 3-char word boundaries
    }
    expect(chunks.map((ch) => ch.content).join("")).toBe(text); // no data loss
  });

  it("falls back to chunk() when the language is not handled", async () => {
    const c = new Chunker({ tokenLimit: 100, segmenter: seg });
    const out = await c.chunkSegmented("hello world", { language: "en" });
    expect(out).toEqual(c.chunk("hello world", { language: "en" }));
  });

  it("falls back to chunk() when no segmenter is configured", async () => {
    const c = new Chunker({ tokenLimit: 100 });
    const out = await c.chunkSegmented("กขคงจฉ", { language: "th" });
    expect(out).toEqual(c.chunk("กขคงจฉ", { language: "th" }));
  });

  it("awaits an async segmenter", async () => {
    const asyncSeg: Segmenter = {
      segmentsLanguage: (l) => l === "th",
      segment: async (t, l) => (l === "th" ? (t.match(/.{1,3}/gsu) ?? []).join(" ") : t),
    };
    const c = new Chunker({ tokenLimit: 7, overlap: 0, segmenter: asyncSeg });
    const chunks = await c.chunkSegmented("กขคงจฉชญ", { language: "th" });
    expect(chunks.map((ch) => ch.content).join("")).toBe("กขคงจฉชญ");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/chunker.test.ts`
Expected: FAIL — `chunkSegmented` is not a function / `segmenter` not accepted in config.

- [ ] **Step 3: Add the optional interface method**

In `src/interfaces.ts`, extend `ChunkingProvider`:

```ts
export interface ChunkingProvider {
  chunk(text: string, metadata?: Record<string, string>): Chunk[];
  /** Optional async variant using an injected Segmenter for word-aware boundaries on
   *  whitespace-less scripts (Thai/CJK). Emits natural (unsegmented) chunk content. */
  chunkSegmented?(text: string, metadata?: Record<string, string>): Promise<Chunk[]>;
}
```

- [ ] **Step 4: Wire the segmenter into `Chunker` config + add the `th` ratio**

In `src/Chunker.ts`:

Change the import to include `Segmenter`:

```ts
import type { ChunkingProvider, Segmenter } from "./interfaces.js";
```

Add the Thai entry to `CHARS_PER_TOKEN` (after the CJK entries):

```ts
  ["ko", 1.2],
  // Thai — heavily fragmented by multilingual subword tokenizers; closer to CJK than Latin.
  // Conservative (risks small chunks over silent truncation); validate against the embedder.
  ["th", 1.5],
```

Add `segmenter` to `ChunkerConfig`:

```ts
  prefixFn?: (metadata: Record<string, string>) => string | undefined;
  /** Optional word segmenter for chunkSegmented() — word-aware boundaries on Thai/CJK. */
  segmenter?: Segmenter;
```

Add the field and assign it in both constructor branches:

```ts
  private prefixFn: ((metadata: Record<string, string>) => string | undefined) | undefined;
  private segmenter: Segmenter | undefined;
```

In the config-object branch (after `this.prefixFn = configOrSize.prefixFn;`):

```ts
      this.segmenter = configOrSize.segmenter;
```

In the positional branch (after `this.prefixFn = undefined;`):

```ts
      this.segmenter = undefined;
```

- [ ] **Step 5: Implement `chunkSegmented` + module helpers**

Add module-level helpers in `src/Chunker.ts` (near `toGraphemes`):

```ts
/**
 * Recover ORIGINAL substrings per word from a segmented form, using non-space character
 * counts (invariant under the space-insertion-only Segmenter contract). concat(units) ===
 * original. Any unit longer than maxLen is grapheme-split (the truncation guard).
 */
function wordUnits(original: string, segmented: string, maxLen: number): string[] {
  const breaks = new Set<number>();
  let nonSpace = 0;
  for (const ch of segmented) {
    if (/\s/.test(ch)) breaks.add(nonSpace);
    else nonSpace++;
  }
  const words: string[] = [];
  let cur = "";
  let count = 0;
  for (const ch of original) {
    cur += ch;
    if (!/\s/.test(ch)) {
      count++;
      if (breaks.has(count)) {
        words.push(cur);
        cur = "";
      }
    }
  }
  if (cur) words.push(cur);
  return words.flatMap((w) => (w.length > maxLen ? toGraphemes(w) : [w]));
}

/** Trailing units whose combined length stays within `overlap` chars (word-boundary overlap). */
function overlapUnits(units: string[], overlap: number): string[] {
  if (overlap <= 0) return [];
  const out: string[] = [];
  let len = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    if (out.length > 0 && len + units[i].length > overlap) break;
    out.unshift(units[i]);
    len += units[i].length;
  }
  return out;
}
```

Add the methods to the `Chunker` class (after `chunk`):

```ts
  /**
   * Async, word-aware chunking for whitespace-less scripts (Thai/CJK). Uses the injected
   * Segmenter to find word boundaries but emits NATURAL (unsegmented) chunk content — the
   * segmenter is boundary-finding only. Safe to call always: with no segmenter or an
   * unhandled language it returns the same result as chunk().
   */
  async chunkSegmented(text: string, metadata: Record<string, string> = {}): Promise<Chunk[]> {
    if (!text.trim()) return [];
    const language = metadata.language;
    if (!this.segmenter || !language || !this.segmenter.segmentsLanguage(language)) {
      return this.chunk(text, metadata);
    }

    const effectiveSize = this.getCharLimit(language);
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
    const chunks: Chunk[] = [];
    let buffer = "";
    let chunkIndex = 0;

    for (const para of paragraphs) {
      if (buffer.length + para.length + 2 <= effectiveSize) {
        buffer = buffer ? `${buffer}\n\n${para}` : para;
        continue;
      }
      if (buffer) {
        chunks.push({ content: buffer.trim(), index: chunkIndex++, metadata });
        buffer = "";
      }
      if (para.length > effectiveSize) {
        const segmented = await this.segmenter.segment(para, language);
        const units = wordUnits(para, segmented, effectiveSize);
        chunkIndex = this.packWordUnits(units, effectiveSize, metadata, chunkIndex, chunks);
      } else {
        buffer = para;
      }
    }

    if (buffer.trim()) chunks.push({ content: buffer.trim(), index: chunkIndex, metadata });
    return this.prefixChunks(chunks);
  }

  /** Pack word units into <= effectiveSize chunks with word-boundary overlap; pushes onto
   *  `chunks` and returns the next chunk index. Emits join(units) = natural original text. */
  private packWordUnits(
    units: string[],
    effectiveSize: number,
    metadata: Record<string, string>,
    startIndex: number,
    chunks: Chunk[],
  ): number {
    let bufUnits: string[] = [];
    let bufLen = 0;
    let idx = startIndex;
    const flush = () => {
      const content = bufUnits.join("").trim();
      if (content) chunks.push({ content, index: idx++, metadata });
    };
    for (const u of units) {
      if (bufLen > 0 && bufLen + u.length > effectiveSize) {
        flush();
        bufUnits = overlapUnits(bufUnits, this.overlap);
        bufLen = bufUnits.reduce((n, s) => n + s.length, 0);
      }
      bufUnits.push(u);
      bufLen += u.length;
    }
    flush();
    return idx;
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/chunker.test.ts`
Expected: PASS (existing + new `chunkSegmented` block).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/interfaces.ts src/Chunker.ts tests/chunker.test.ts
git commit -m "feat(chunker): async chunkSegmented() — word-aware boundaries, natural-text output"
```

---

### Task 7: RagPipeline query-path wiring

**Files:**
- Modify: `src/RagPipeline.ts` (`RagPipelineConfig.segmenter`, field, apply after orthographic normalizer)
- Test: `tests/pipeline.test.ts` (add a case)

**Interfaces:**
- Consumes: `Segmenter` (Task 1).
- Produces: `RagPipelineConfig.segmenter?: Segmenter`. The lexical query passed to `hybridSearch` is segmented; the embedding/reranker query is not.

- [ ] **Step 1: Write the failing test**

Add to `tests/pipeline.test.ts` (add `import type { Segmenter } from "../src/interfaces.js";` at top):

```ts
it("segments the lexical query but leaves the embedding query natural", async () => {
  const seg: Segmenter = {
    segmentsLanguage: (l) => l === "th",
    segment: (t, l) => (l === "th" ? (t.match(/.{1,3}/gsu) ?? []).join(" ") : t),
  };
  const p = new RagPipeline({ tenantId: "tenant-1", db: mockDb, embedder: mockEmbedder, segmenter: seg });
  await p.search("กขคงจฉ", { language: "th" });
  // Lexical query handed to the DB legs is segmented (spaces inserted on 3-char boundaries).
  expect(lastSearchParams.query).toBe("กขค งจฉ");
  // The dense embedding sees the natural, unsegmented query.
  expect(mockEmbedQuery).toHaveBeenCalledWith("กขคงจฉ");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline.test.ts`
Expected: FAIL — `segmenter` not accepted / `query` is unsegmented `"กขคงจฉ"`.

- [ ] **Step 3: Wire the segmenter into the pipeline**

In `src/RagPipeline.ts`:

Add `Segmenter` to the type import from `./interfaces.js`.

Add to `RagPipelineConfig` (after `normalizer?`):

```ts
  /** Lexical word segmenter applied to the keyword/FTS query (not the embedding). */
  segmenter?: Segmenter;
```

Add the field and assign it in the constructor:

```ts
  private normalizer?: Normalizer;
  private segmenter?: Segmenter;
```
```ts
    this.normalizer = config.normalizer;
    this.segmenter = config.segmenter;
```

In `search`, right after the orthographic-normalization block (which ends with `span.setAttribute("orthographicNormalizerApplied", true);`) and before the stop-word block, insert:

```ts
        // Word segmentation for the LEXICAL legs only (Thai/CJK). Boundary-aware tokens let
        // stop-word removal, synonym n-grams, trigram word_similarity, and tsvector match.
        // naturalQuery (embedding + reranker) stays UNsegmented.
        if (this.segmenter) {
          const preSeg = lexicalQuery;
          lexicalQuery = await this.segmenter.segment(lexicalQuery, queryLanguage);
          if (!lexicalQuery.trim()) lexicalQuery = preSeg;
          span.setAttribute("segmenterApplied", true);
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/pipeline.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/RagPipeline.ts tests/pipeline.test.ts
git commit -m "feat(pipeline): segment the lexical query (Segmenter), embedding stays natural"
```

---

### Task 8: RagIndexer index-path wiring

**Files:**
- Modify: `src/RagIndexer.ts` (`RagIndexerConfig.segmenter`, field, apply fold→segment to `content_normalized`)
- Test: `tests/indexer.test.ts` (add cases)

**Interfaces:**
- Consumes: `Segmenter` (Task 1).
- Produces: `RagIndexerConfig.segmenter?: Segmenter`. `content_normalized` = `segment(normalize(content))`; raw `content` unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/indexer.test.ts`:

```ts
it("segments content_normalized via the injected segmenter (raw content preserved)", async () => {
  capturedInsertChunks = [];
  const seg = {
    segmentsLanguage: (l: string) => l === "th",
    segment: (t: string, l: string) => (l === "th" ? `${t}|SEG` : t),
  };
  const indexer = new RagIndexer({ tenantId: "t-1", db: mockDb, embedder: mockEmbedder, segmenter: seg });
  await indexer.index("faq", "f-1", [{ index: 0, content: "ราคา", metadata: { language: "th" } }], "th");
  const rows = capturedInsertChunks as Array<Record<string, unknown>>;
  expect(rows[0].content).toBe("ราคา"); // raw kept for embedding + display
  expect(rows[0].contentNormalized).toBe("ราคา|SEG"); // segmented for the lexical legs
});

it("applies normalizer THEN segmenter to content_normalized", async () => {
  capturedInsertChunks = [];
  const seg = { segmentsLanguage: () => true, segment: (t: string) => `${t}>S` };
  const indexer = new RagIndexer({
    tenantId: "t-1",
    db: mockDb,
    embedder: mockEmbedder,
    normalizer: { normalize: (t: string) => `N:${t}` },
    segmenter: seg,
  });
  await indexer.index("faq", "f-1", [{ index: 0, content: "x", metadata: {} }], "th");
  const rows = capturedInsertChunks as Array<Record<string, unknown>>;
  expect(rows[0].contentNormalized).toBe("N:x>S"); // fold first, then segment
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/indexer.test.ts`
Expected: FAIL — `segmenter` not accepted / `contentNormalized` not segmented.

- [ ] **Step 3: Wire the segmenter into the indexer**

In `src/RagIndexer.ts`:

Add `Segmenter` to the type import from `./interfaces.js`.

Add to `RagIndexerConfig` (after `normalizer?`):

```ts
  /** Optional word segmenter; applied AFTER the normalizer to content_normalized (Thai/CJK). */
  segmenter?: Segmenter;
```

Add the field and assign it:

```ts
  private normalizer?: Normalizer;
  private segmenter?: Segmenter;
```
```ts
    this.normalizer = config.normalizer;
    this.segmenter = config.segmenter;
```

In `index`, change the per-chunk `contentNormalized` computation to fold then segment:

```ts
        const lang = chunk.metadata.language ?? language;
        const content = chunk.content;
        let contentNormalized = this.normalizer
          ? await this.normalizer.normalize(content, lang)
          : content;
        if (this.segmenter) {
          contentNormalized = await this.segmenter.segment(contentNormalized, lang);
        }
        return {
          sourceType,
          sourceId,
          chunkIndex: String(chunk.index),
          content,
          contentNormalized,
          language: lang,
          embedding: embeddings[i],
          metadata: JSON.stringify(chunk.metadata),
        };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/indexer.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/RagIndexer.ts tests/indexer.test.ts
git commit -m "feat(indexer): segment content_normalized (fold then segment)"
```

---

### Task 9: PostgresRagDatabase keyword-leg routing

**Files:**
- Modify: `src/adapters/PostgresRagDatabase.ts` (`PostgresRagDatabaseOptions.segmenter`, field, `useBigm` predicate)
- Test: `tests/postgresRagDatabase.test.ts` (add cases)

**Interfaces:**
- Consumes: `Segmenter` (Task 1).
- Produces: `PostgresRagDatabaseOptions.segmenter?: Segmenter`. A CJK language the segmenter handles routes to the trgm leg instead of pg_bigm.

- [ ] **Step 1: Write the failing test**

Add to `tests/postgresRagDatabase.test.ts`:

```ts
it("routes a segmented CJK language to the trigram leg (not pg_bigm)", async () => {
  const { txProvider, calls } = recordingTx();
  const seg = { segmentsLanguage: (l: string) => l === "zh", segment: (t: string) => t };
  await new PostgresRagDatabase(txProvider, { cjk: true, segmenter: seg }).hybridSearch({
    ...params,
    language: "zh",
  });
  expect(calls.some((c) => c.sql.includes("show_bigm(content)"))).toBe(false);
  expect(calls.some((c) => c.sql.includes("word_similarity($2, content_normalized)"))).toBe(true);
});

it("still uses pg_bigm for a CJK language the segmenter does not handle", async () => {
  const { txProvider, calls } = recordingTx();
  const seg = { segmentsLanguage: (l: string) => l === "zh", segment: (t: string) => t };
  await new PostgresRagDatabase(txProvider, { cjk: true, segmenter: seg }).hybridSearch({
    ...params,
    language: "ja",
  });
  expect(calls.some((c) => c.sql.includes("show_bigm(content)"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/postgresRagDatabase.test.ts`
Expected: FAIL — `segmenter` not accepted; zh still routes to bigram.

- [ ] **Step 3: Add the option and update `useBigm`**

In `src/adapters/PostgresRagDatabase.ts`:

Add `Segmenter` to the type import from `../interfaces.js` (it currently imports `FtsStrategy, RagDatabase, SqlClient, TransactionProvider`).

Add to `PostgresRagDatabaseOptions`:

```ts
  /**
   * Optional Segmenter. Used FOR ROUTING ONLY (never segments here): a CJK language the
   * segmenter handles routes its keyword leg to trgm-on-content_normalized instead of pg_bigm
   * (which assumes raw, unsegmented content). Pass the SAME instance you inject on RagPipeline
   * and RagIndexer so indexing, querying, and routing stay consistent.
   */
  segmenter?: Segmenter;
```

Add the field and assign it:

```ts
  private manageTransaction: boolean;
  private segmenter?: Segmenter;
```
```ts
    this.manageTransaction = options?.manageTransaction ?? true;
    this.segmenter = options?.segmenter;
```

Update the `useBigm` computation in `hybridSearch`:

```ts
    const useBigm =
      this.cjk &&
      CJK_LANGUAGES.has(params.language) &&
      !this.segmenter?.segmentsLanguage(params.language);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/postgresRagDatabase.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/adapters/PostgresRagDatabase.ts tests/postgresRagDatabase.test.ts
git commit -m "feat(postgres): route segmented CJK languages to trgm via segmentsLanguage"
```

---

### Task 10: Documentation (README) + full verification gate

**Files:**
- Modify: `README.md`
- (Verification only: `src/index.ts` exports from Task 1, whole suite)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation; no code surface.

- [ ] **Step 1: Add Thai + the Segmenter seam to `README.md`**

Add Thai to the supported-languages section. Add a "Word segmentation (Thai/CJK)" subsection covering:
- The `Segmenter` interface and `segmentsLanguage` routing contract; inject the **same instance** on `RagPipeline`, `RagIndexer`, and `PostgresRagDatabase`.
- Index-time uses `chunker.chunkSegmented(text, { language })` (async) instead of `chunk()` for non-spacing languages.
- The `IntlSegmenterAdapter` is zero-dep but **ICU-dictionary-dependent and weak on Thai loanwords on both Node and Bun** — a reference, not production-grade; inject PyThaiNLP-newmm / an ML / an HTTP segmenter for production Thai.
- CJK opt-in benchmark recipe: inject a CJK segmenter on pipeline + indexer + db and re-index → keyword leg uses trgm; remove it → reverts to pg_bigm.
- Recommended Thai config: segmenter + a strong multilingual embedder (BGE-M3) + **lower `vectorMinScore`** (the 0.8 default is e5-calibrated and silently kills the dense leg) + enable reranking.

Use this snippet block in the new subsection:

```ts
import { IntlSegmenterAdapter, RagPipeline, RagIndexer, PostgresRagDatabase, Chunker } from "pg-hybrid-rag";

const segmenter = new IntlSegmenterAdapter({ languages: ["th"] }); // reference impl; see caveat
const db = new PostgresRagDatabase(tx, { segmenter });
const pipeline = new RagPipeline({ tenantId, db, embedder, segmenter });
const indexer = new RagIndexer({ tenantId, db, embedder, segmenter });

// Index Thai: use chunkSegmented (async) for word-aware boundaries.
const chunks = await new Chunker({ tokenLimit: 512, segmenter }).chunkSegmented(text, { language: "th" });
await indexer.index("faq", "f-1", chunks, "th");

// Query Thai: lower vectorMinScore for BGE-M3-class embedders; enable rerank.
await pipeline.search("ราคาแพ็กเกจอินเทอร์เน็ต", { language: "th", vectorMinScore: 0.4, rerank: true });
```

- [ ] **Step 2: Verify the barrel exports the new public API**

Run: `bun -e "import('./src/index.ts').then(m => console.log(typeof m.IntlSegmenterAdapter))"`
Expected: prints `function`.

- [ ] **Step 3: Full verification gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: typecheck clean, lint clean, all tests pass, build emits `dist/`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): Thai support + injectable Segmenter usage and caveats"
```

---

## Self-Review

**Spec coverage:**
- §1 Segmenter interface → Task 1. §2 IntlSegmenterAdapter → Task 1. §3 query path → Task 7. §4 index path → Task 8. §5a grapheme-safe → Task 5. §5b–c chunkSegmented → Task 6. §6 routing → Task 9. §7 Thai detection → Task 2, normalization → Task 3, punctuation → Task 4, `th` chars-per-token → Task 6. §"no new migration" → honored (no SQL task). §Docs-only (vectorMinScore/rerank/README) → Task 10. ✅ All covered.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertions. ✅

**Type consistency:** `Segmenter.segment` / `segmentsLanguage` signatures identical across Tasks 1, 6, 7, 8, 9. `chunkSegmented(text, metadata?): Promise<Chunk[]>` identical in interface (Task 6) and class (Task 6). `ChunkerConfig.segmenter` / `RagPipelineConfig.segmenter` / `RagIndexerConfig.segmenter` / `PostgresRagDatabaseOptions.segmenter` all `Segmenter`. `toGraphemes` defined in Task 5, reused in Task 6. ✅

**Notes for the implementer:**
- Tasks 2, 3, 4 are independent and can be done in any order. Task 1 must precede 6/7/8/9. Task 5 must precede Task 6.
- Tests use deterministic mock segmenters (fixed 3-char split) so they never depend on ICU quality. Only the `IntlSegmenterAdapter` test touches real `Intl.Segmenter`, and it asserts structural properties only.
