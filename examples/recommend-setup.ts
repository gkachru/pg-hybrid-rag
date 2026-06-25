/**
 * Example: per-language setup recommendations via recommendForLanguage.
 *
 * Demonstrates:
 * - Looking up the calibrated starting points for a language (embedder, dimensions,
 *   vectorMinScore) plus the structural flags (stemming, normalization, CJK)
 * - How each field maps onto migration- / construction- / query-time wiring
 *
 * Pure + dependency-free — no database or embedding API needed. Run it directly:
 *   bun run examples/recommend-setup.ts
 */

import { type LanguageRecommendation, recommendForLanguage } from "../src/index.js";

// A spread of scripts: native-stemmed Latin (en/de), Arabic (native stemmer + orthographic
// folds), Thai (no stemmer, digit normalization), CJK (pg_bigm), and an unknown code that
// falls back to the lenient multilingual default.
const LANGUAGES = ["en", "de", "ar", "th", "zh", "ja", "ko", "xx"];

function describe(lang: string, rec: LanguageRecommendation): string {
  const flags = [
    `stemming=${rec.stemming}`,
    rec.needsNormalization ? "normalize" : "no-normalize",
    rec.isCjk ? "cjk(pg_bigm)" : "non-cjk",
  ].join(", ");
  return `${lang.padEnd(4)} → ${rec.embedder} (${rec.dimensions}d), vectorMinScore=${rec.vectorMinScore} | ${flags}`;
}

for (const lang of LANGUAGES) {
  console.log(describe(lang, recommendForLanguage(lang)));
}

// --- How to apply a recommendation (wiring sketch) ---
//
// const rec = recommendForLanguage("ar");
//
// // install-time: size the embedding column to the model + enable the CJK migration leg
// await ragMigrate(db, { embeddingDimensions: rec.dimensions, cjk: rec.isCjk });
//
// // construction-time: only build a normalizer when the language needs one
// const normalizer = rec.needsNormalization ? new LanguageNormalizer() : undefined;
// const pipeline = new RagPipeline({ tenantId, db, embedder, normalizer });
//
// // query-time: use the model-calibrated floor (the 0.8 default is e5-tuned, too high for bge-m3)
// await pipeline.search(query, { language: "ar", vectorMinScore: rec.vectorMinScore });
//
// NOTE: `dimensions` is a per-DATABASE choice — every tenant in one database shares the single
// rag_documents.embedding vector(N) column, so mixing a 384-dim and a 1024-dim model requires
// separate databases. See README → "Recommended setup per language".
console.log("\nSee README → 'Recommended setup per language' for how each field maps to wiring.");
