# Utilities

This page documents the exported functions, constants and small classes that are not covered on a class page: language helpers, query-text helpers, fusion functions, SQL helpers for custom adapters, and `IntlSegmenterAdapter`. `RagPipeline` and `RagIndexer` call most of these internally; you need them directly only when you build a custom pipeline, database adapter or FTS strategy.

```ts
import {
  applyRRF,
  detectLanguage,
  normalizeForLanguage,
  recommendForLanguage,
  stripTrailingPunctuation,
} from "pg-hybrid-rag";
```

Exports documented on other pages:

| Export | Page |
|--------|------|
| `ragMigrate` | [Migrations](/reference/migrations) |
| `normalizeAttributes`, `serializeAttributes`, `parseAttributes`, `GLOBAL_NS`, `DEFAULT_ATTRIBUTE_LIMITS` | [Filter grammar: Attributes](/reference/filter-grammar#attributes) |
| `validateFilter`, `assertValidFilter`, `DEFAULT_FILTER_LIMITS`, `FILTER_JSON_SCHEMA`, `FILTER_GENERATION_SCHEMA` | [Filter grammar: Validation](/reference/filter-grammar#validation) |
| Error classes | [Errors](/reference/errors) |

## Language

### detectLanguage

<!-- no-check -->
```ts
function detectLanguage(text: string): string;
```

Guesses a language code from the Unicode scripts in `text`. It counts characters per script and does no dictionary lookup, so it cannot tell apart languages that share a script: all Latin-script text returns `"en"`.

Possible return values: `"en"`, `"zh"`, `"ja"`, `"ko"`, `"th"`, `"ar"`, `"hi"`, `"hinglish"`.

Rules, applied in order:

| Condition | Result |
|-----------|--------|
| No characters from a counted script | `"en"` |
| Any Hiragana or Katakana (including halfwidth Katakana) | `"ja"` |
| Any Hangul syllable or Jamo | `"ko"` |
| Han ideographs are at least 50% of counted characters | `"zh"` |
| Thai is more than 50% | `"th"` |
| Arabic (including Arabic Supplement and presentation forms) is more than 50% | `"ar"` |
| Devanagari is more than 50% | `"hi"` |
| Both Devanagari and Latin present | `"hinglish"` |
| Otherwise | `"en"` |

Only ASCII letters `A-Z` and `a-z` count as Latin. Digits, punctuation and accented Latin letters are not counted. Japanese text written only in kanji is reported as `"zh"`.

```ts
import { detectLanguage } from "pg-hybrid-rag";

detectLanguage("配送状況を確認する"); // "ja"
detectLanguage("¿Dónde está mi pedido?"); // "en" (Latin script; not distinguished from Spanish)
```

`"hinglish"` has no Postgres stemming configuration and falls back to `simple`. See [Languages](/reference/languages) for what each code gets.

### normalizeForLanguage

<!-- no-check -->
```ts
function normalizeForLanguage(
  text: string,
  language: string,
  opts?: ArabicNormalizeOptions,
): string;
```

Orthographic normalization, selected by the base language code (the part before `-`, lowercased). It is idempotent.

| Base code | Steps |
|-----------|-------|
| `ar` | NFC; remove tashkeel (U+064B-U+065F) and superscript alef (U+0670); remove tatweel (U+0640), ZWNJ (U+200C) and ZWJ (U+200D); fold alef variants `آ أ إ ٱ` to `ا`; fold `ى` to `ي` (unless `foldAlefMaqsura: false`); fold `ة` to `ه` (unless `foldTaaMarbuta: false`); convert Arabic-Indic digits `٠-٩` and extended Arabic-Indic digits `۰-۹` to `0-9`; NFC. |
| `th` | NFC; convert Thai digits `๐-๙` to `0-9`. |
| Any other | NFC only. |

```ts
import { normalizeForLanguage } from "pg-hybrid-rag";

normalizeForLanguage("مكتبة", "ar"); // "مكتبه"
normalizeForLanguage("ราคา ๑๒๐ บาท", "th-TH"); // "ราคา 120 บาท"
```

### LanguageNormalizer

<!-- no-check -->
```ts
class LanguageNormalizer implements Normalizer {
  constructor(opts?: ArabicNormalizeOptions);
  normalize(text: string, language: string): string;
}
```

The shipped [`Normalizer`](/reference/interfaces#normalizer). `normalize` calls `normalizeForLanguage(text, language, opts)`. Pass the same instance (or the same options) to `RagIndexer` and `RagPipeline` through their `normalizer` config field.

```ts
import { LanguageNormalizer } from "pg-hybrid-rag";

const normalizer = new LanguageNormalizer({ foldTaaMarbuta: false });
```

### ArabicNormalizeOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `foldAlefMaqsura` | `boolean` | `true` | Fold alef maqsura `ى` to yeh `ي`. |
| `foldTaaMarbuta` | `boolean` | `true` | Fold taa marbuta `ة` to heh `ه`. |

The options affect Arabic only.

### recommendForLanguage

<!-- no-check -->
```ts
function recommendForLanguage(language: string): LanguageRecommendation;
```

Returns an advisory starting configuration for a language. It is a pure lookup and never throws; unknown or empty codes get the multilingual defaults with `stemming: "none"`. `stemming` and `isCjk` match the exact code, the same way `rag_fts_config()`, the BM25 language groups and `PostgresRagDatabase` route it; `needsNormalization` uses the base code, as `normalizeForLanguage` does (`"ar-MA"` is treated as `"ar"`). Validate the numeric values on your own corpus.

`LanguageRecommendation` fields:

| Field | Type | Value |
|-------|------|-------|
| `embedder` | `string` | `"BAAI/bge-m3"` for every language. |
| `dimensions` | `number` | `1024`. Use as `ragMigrate({ embeddingDimensions })`. |
| `maxTokens` | `number` | `8192`. The embedder's input ceiling; longer input is truncated. It is not a target chunk size: keep `Chunker` `tokenLimit` well below it. |
| `vectorMinScore` | `number` | `0.4`. A starting point for `RagSearchOptions.vectorMinScore` with this embedder. |
| `stemming` | `string` | Postgres text search configuration (`"english"`, `"spanish"`, `"french"`, `"german"`, `"italian"`, `"portuguese"`, `"romanian"`, `"arabic"`), or `"none"` (the `simple` configuration). Exact code match: an unlisted regional code such as `"pt-BR"`, `"en-GB"` or `"ar-MA"` reports `"none"`, because `rag_fts_config()` stems it with `simple`. |
| `needsNormalization` | `boolean` | `true` for base codes `ar` and `th`, where `normalizeForLanguage` does more than NFC. |
| `isCjk` | `boolean` | `true` for the codes `PostgresRagDatabase` routes to pg_bigm: `zh`, `zh-CN`, `ja`, `ja-JP`, `ko`, `ko-KR` (exact match). `"zh-TW"` reports `false`. |

Regional codes not listed in [Languages](/reference/languages) fall back to the `simple` configuration and the pg_trgm keyword path. Store and query with the exact codes listed there.

```ts
import { recommendForLanguage } from "pg-hybrid-rag";

const rec = recommendForLanguage("de-DE");
// { embedder: "BAAI/bge-m3", dimensions: 1024, maxTokens: 8192, vectorMinScore: 0.4,
//   stemming: "german", needsNormalization: false, isCjk: false }
```

## Query text

### stripTrailingPunctuation

<!-- no-check -->
```ts
function stripTrailingPunctuation(text: string): string;
```

Removes a trailing run of characters matched by `TRAILING_PUNCTUATION`. `RagPipeline` applies it to each query word after lowercasing.

### TRAILING_PUNCTUATION

```text
/[?.!,;:।॥؟،؛。！？、；：ๆฯ)\]}"'…’”]+$/
```

Covers Latin `? . ! , ; :`, Devanagari `। ॥`, Arabic `؟ ، ؛`, CJK full-width `。 ！ ？ 、 ； ：`, Thai `ๆ ฯ`, closing brackets `) ] }`, straight and curly closing quotes, and the ellipsis `…`.

```ts
import { stripTrailingPunctuation } from "pg-hybrid-rag";

stripTrailingPunctuation("refund?"); // "refund"
stripTrailingPunctuation("返品。"); // "返品"
```

### removeStopWords

<!-- no-check -->
```ts
function removeStopWords(query: string, stopWords: Set<string>): string;
```

Splits `query` on whitespace, drops each word whose lowercase form is in `stopWords`, and joins the rest with single spaces. Returns `""` if every word is a stop word. Entries in `stopWords` must be lowercase to match. `RagPipeline` falls back to the unfiltered query when the result is empty.

```ts
import { removeStopWords } from "pg-hybrid-rag";

removeStopWords("How do I reset my password", new Set(["how", "do", "i", "my"])); // "reset password"
```

### expandQueryWithSynonyms

<!-- no-check -->
```ts
function expandQueryWithSynonyms(query: string, lookup: SynonymLookup): string;
```

Appends synonym expansions to a query.

- All languages in `lookup` are merged into one map; each term keeps at most 5 expansions.
- Matching is longest-match-first over consecutive lowercased query words, so a multi-word key such as `"credit card"` wins over `"credit"`.
- Every original query word is emitted, including repeats. Expansions follow the matched word or phrase.
- An expansion word is skipped if it already appears in the query or was already appended.
- Returns `query` unchanged when `lookup` is empty.

```ts
import { expandQueryWithSynonyms, type SynonymLookup } from "pg-hybrid-rag";

const lookup: SynonymLookup = new Map([["en", new Map([["password", ["passcode"]]])]]);
expandQueryWithSynonyms("reset password", lookup); // "reset password passcode"
```

### buildFtsQuery

<!-- no-check -->
```ts
function buildFtsQuery(query: string, lookup: SynonymLookup): string;
```

Builds `to_tsquery` input for the tsvector full-text leg (`TsvectorFts`):

- Words are joined with `&`.
- A word or phrase with synonyms becomes an OR group: `(phones | smartphones | iphone)`.
- Multi-word keys and multi-word expansions become phrase matches: `credit <-> card`.
- The characters `& | ! ( ) : < > * \ ' "` are removed from every term. Terms that become empty are dropped.

Matching and expansion limits are the same as for `expandQueryWithSynonyms`. Stemming happens in Postgres through the language's text search configuration, not here.

```ts
import { buildFtsQuery, type SynonymLookup } from "pg-hybrid-rag";

const lookup: SynonymLookup = new Map([["en", new Map([["phones", ["smartphones", "iphone"]]])]]);
buildFtsQuery("best phones market", lookup); // "best & (phones | smartphones | iphone) & market"
```

### buildBm25Query

<!-- no-check -->
```ts
function buildBm25Query(query: string, lookup: SynonymLookup): string;
```

Builds the query for the BM25 leg (`Bm25Fts`): runs `expandQueryWithSynonyms`, splits on whitespace, removes the same special characters as `buildFtsQuery`, and joins the terms with spaces. BM25 ranks by term matches, so there is no AND/OR syntax.

```ts
import { buildBm25Query, type SynonymLookup } from "pg-hybrid-rag";

const lookup: SynonymLookup = new Map([["en", new Map([["phones", ["smartphones"]]])]]);
buildBm25Query("best phones market", lookup); // "best phones smartphones market"
```

## Fusion

Both functions take the legs in the order `RagPipeline` uses, `[vector, keyword, fts]`, deduplicate candidates by `RankedCandidate.id` (the first occurrence's content is kept), sort by fused score descending, keep `topK`, and convert to `RagResult` (metadata or attribute JSON that fails to parse becomes `{}` or `[]`). A missing entry in `weights` counts as `1`. A weight of `0` does not remove a leg in these functions: its candidates still enter the fused list, contributing `0` to their score, so they can fill remaining `topK` slots. (`RagPipeline` disables a weight-`0` leg before fusion, so this applies only when you call the functions directly.)

### applyRRF

<!-- no-check -->
```ts
function applyRRF(
  legs: Array<{ items: RankedCandidate[] }>,
  rrfK: number,
  topK: number,
  weights?: number[],
): RagResult[];
```

Reciprocal Rank Fusion. A candidate's score is the sum over the legs it appears in of `weight / (rrfK + rank)`, where `rank` is its 1-based position in that leg. Leg scores are ignored.

```ts
import { applyRRF, type RankedCandidate } from "pg-hybrid-rag";

declare const vectorRows: RankedCandidate[];
declare const keywordRows: RankedCandidate[];
declare const ftsRows: RankedCandidate[];

const fused = applyRRF(
  [{ items: vectorRows }, { items: keywordRows }, { items: ftsRows }],
  60,
  5,
  [1, 1, 1],
);
```

### applyLinearFusion

<!-- no-check -->
```ts
function applyLinearFusion(
  legs: Array<{ items: RankedCandidate[] }>,
  topK: number,
  weights?: number[],
  normalizer?: FusionNormalizer, // default "minmax"
): RagResult[];
```

Normalizes each leg's `score` values independently, then sums `weight * normalized` across legs. A missing or non-finite score counts as `0`.

| `normalizer` | Per-leg formula | Edge case |
|--------------|-----------------|-----------|
| `"minmax"` | `(s - min) / (max - min)` | All scores equal (including a single candidate): every candidate gets `1`. |
| `"l2"` | `s / sqrt(sum of s^2)` | All scores zero: every candidate gets `0`. |

## SQL helpers

These are the helpers the shipped legs use. Use them in a custom [`FtsStrategy`](/reference/interfaces#ftsstrategy) so filters and row mapping behave the same as in the built-in legs.

### buildFilters

<!-- no-check -->
```ts
function buildFilters(filters: SearchFilters, startIdx: number): BuiltFilters;
```

Builds the shared `WHERE` fragments for source-type, source-ID, language and attribute filters. Placeholders start at `$startIdx`, so pass your base parameter count plus one.

| `SearchFilters` field | Type | Clause added when set and non-empty |
|-----------------------|------|-------------------------------------|
| `sourceTypes` | `string[]` | `AND source_type = ANY(string_to_array($n::text, ','))` |
| `sourceIds` | `string[]` | `AND source_id::text = ANY(string_to_array($n::text, ','))` |
| `languages` | `string[]` | `AND language = ANY(string_to_array($n::text, ','))` |
| `attributeFilter` | `ValidatedFilter` | `AND (...)` over the `attributes` column. Keys, namespaces and values are bound as parameters. |

`BuiltFilters` is `{ clause: string; params: string[] }`: the clause text (empty string when no filter is active) and the parameter values in placeholder order. List values are bound as one comma-joined string, so `buildFilters` throws an `Error` if any `sourceTypes`, `sourceIds` or `languages` value contains a comma. `PostgresRagDatabase` calls it inside each leg's connection callback, so through `hybridSearch` (and `RagPipeline.search`) that error arrives wrapped in an `AggregateError` (see [Errors](/reference/errors#other-errors)). `FtsContext` and `HybridSearchParams` are both assignable to `SearchFilters`.

```ts
import { buildFilters, toRankedCandidate, type FtsContext, type SqlClient } from "pg-hybrid-rag";

async function searchTitles(client: SqlClient, ctx: FtsContext) {
  const base = [ctx.tenantId, `%${ctx.query}%`, ctx.candidateLimit];
  const f = buildFilters(ctx, base.length + 1);
  const rows = await client.query<Record<string, unknown>>(
    `SELECT id, content, source_type, source_id, metadata, attributes::text AS attributes, 1 AS score
       FROM rag_documents
      WHERE tenant_id = $1 AND content_normalized ILIKE $2 ${f.clause}
      LIMIT $3`,
    [...base, ...f.params],
  );
  return rows.map(toRankedCandidate);
}
```

### toRankedCandidate

<!-- no-check -->
```ts
function toRankedCandidate(row: Record<string, unknown>): RankedCandidate;
```

Maps a database row to a `RankedCandidate`: `id`, `content`, `source_type`, `source_id`, `metadata` (defaults to `"{}"`), `attributes` (defaults to `"[]"`; select it as `attributes::text`), and `score` converted with `Number()` when the row has a non-null `score` column.

## Segmentation

### IntlSegmenterAdapter

<!-- no-check -->
```ts
class IntlSegmenterAdapter implements Segmenter {
  constructor(config: IntlSegmenterAdapterConfig);
  segment(text: string, language: string): string;
  segmentsLanguage(language: string): boolean;
}
```

A [`Segmenter`](/reference/interfaces#segmenter) backed by the runtime's built-in `Intl.Segmenter` with word granularity. It has no dependencies and runs synchronously.

| `IntlSegmenterAdapterConfig` field | Type | Description |
|------------------------------------|------|-------------|
| `languages` | `string[]` | Base language codes to segment, for example `["th", "zh", "ja"]`. Matched on the base subtag, so `"th"` covers `"th-TH"`. Required. |

| Method | Behavior |
|--------|----------|
| `segmentsLanguage(language)` | `true` when the base code of `language` is in `languages`. |
| `segment(text, language)` | Returns `text` unchanged when it is blank or the language is not handled. Otherwise returns the non-whitespace word segments joined with single spaces. |

Segmentation quality depends on the ICU data of the runtime. Words missing from the ICU dictionary (for example many loanwords in Thai) can be split into fragments. For such content, implement `Segmenter` with a dedicated segmentation library or service.

```ts
import { IntlSegmenterAdapter } from "pg-hybrid-rag";

const segmenter = new IntlSegmenterAdapter({ languages: ["th", "zh", "ja"] });
segmenter.segmentsLanguage("th-TH"); // true
segmenter.segmentsLanguage("en"); // false
```

See [CJK and segmentation](/how-to/cjk-and-segmentation).

## Related

- [Interfaces](/reference/interfaces)
- [Languages](/reference/languages)
- [Fusion and reranking](/explanation/fusion-and-reranking)
