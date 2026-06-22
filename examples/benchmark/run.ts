/**
 * Benchmark runner / orchestrator — runs LIVE against a real Postgres + embedding API.
 *
 * For each config (a single `custom` config from the flags, or the 5 `--matrix` presets),
 * it creates an isolated database, migrates it (with the config's optional extensions),
 * seeds Arabic stop words, indexes the benchmark corpus, runs every resolved query × its
 * three dialect variants through RagPipeline.search, scores the results, then drops the DB.
 * Finally it prints per-config metric tables + a cross-config comparison and writes a
 * results JSON.
 *
 * Lifecycle is modelled on examples/playground.ts (isolated DB created+dropped, bounded
 * sql.end cleanup on success AND error, top-level crash handler that best-effort drops any
 * created DB).
 *
 * Usage:
 *   bun run examples/benchmark/run.ts                       # single baseline config
 *   bun run examples/benchmark/run.ts --bm25 --rerank       # single custom config
 *   bun run examples/benchmark/run.ts --matrix              # 5 presets
 *   bun run examples/benchmark/run.ts --matrix --cjk        # cjk applies to all
 *   bun run examples/benchmark/run.ts --limit-queries 6 --topk 10 --judge
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  Bm25Fts,
  CachingStopWordsLoader,
  LanguageNormalizer,
  normalizeForLanguage,
  PostgresRagDatabase,
  RagIndexer,
  RagPipeline,
  ragMigrate,
} from "../../src/index.js";
import { loadOrBuildCorpus } from "./buildCorpus.js";
import { withEmbeddingCache } from "./embeddingCache.js";
import {
  buildDatabaseUrl,
  createAdapter,
  createDatabase,
  createEmbedder,
  createReranker,
  dropDatabase,
  logger,
  TENANT_ID,
  withDatabase,
} from "./infra.js";
import { judgeEnabledFromEnv, judgeResults } from "./judge.js";
import { type MetricSummary, type QueryOutcome, sliceBy, summarize } from "./metrics.js";
import { loadQueries, resolveQueries, snippetPresent } from "./qrels.js";
import type { BenchmarkQuery, CorpusChunk, Dialect } from "./types.js";

// ── Config ──────────────────────────────────────────────────────────────────

interface BenchConfig {
  name: string;
  bm25: boolean;
  vectorchord: boolean;
  rerank: boolean;
}

const MATRIX: BenchConfig[] = [
  { name: "baseline", bm25: false, vectorchord: false, rerank: false },
  { name: "+bm25", bm25: true, vectorchord: false, rerank: false },
  { name: "+vectorchord", bm25: false, vectorchord: true, rerank: false },
  { name: "+rerank", bm25: false, vectorchord: false, rerank: true },
  { name: "all", bm25: true, vectorchord: true, rerank: true },
];

const DIALECTS: Dialect[] = ["msa", "saudi", "darija"];

// Embedder head-to-head subset (--matrix --lean): only the two configs that distinguish
// embedders — baseline (vector+trgm) and +rerank. Skips bm25/vectorchord/all, which the
// prior matrix already settled (bm25 hurts, vectorchord neutral).
const LEAN_MATRIX: BenchConfig[] = [
  { name: "baseline", bm25: false, vectorchord: false, rerank: false },
  { name: "+rerank", bm25: false, vectorchord: false, rerank: true },
];

// Queries searched concurrently. Each search reserves up to one pooled connection per leg
// (vector/keyword/fts) with its own transaction-local planner GUCs, so concurrent searches
// stay isolated; the Postgres pool is sized to ~3×this (see createAdapter call below).
// Env-tunable: drop it for slow CPU/ONNX backends so query-embeds don't pile up and time out.
const SEARCH_CONCURRENCY = (() => {
  const n = Number(process.env.SEARCH_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? n : 8;
})();

// ── doc_id ↔ UUID mapping ─────────────────────────────────────────────────────
// rag_documents.source_id is a UUID column, but the benchmark's doc_ids are strings like
// "faq:abk:0". We index each doc under a deterministic UUIDv5 derived from its doc_id and
// keep a reverse map, so a search result's source_id translates back to the original doc_id
// (the ground-truth key) without touching src/.

const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // RFC 4122 DNS namespace

/** Deterministic name-based UUID (v5, SHA-1) for a string — stable across runs. */
function docIdToUuid(name: string): string {
  const ns = Buffer.from(UUID_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface Args {
  bm25: boolean;
  vectorchord: boolean;
  rerank: boolean;
  cjk: boolean;
  judge: boolean;
  matrix: boolean;
  lean: boolean;
  topK: number;
  limitQueries?: number;
}

function parseArgs(argv: string[]): Args {
  const has = (flag: string) => argv.includes(flag);
  const numAfter = (flag: string): number | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) return undefined;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    bm25: has("--bm25"),
    vectorchord: has("--vectorchord"),
    rerank: has("--rerank"),
    cjk: has("--cjk"),
    judge: has("--judge"),
    matrix: has("--matrix"),
    lean: has("--lean"),
    topK: numAfter("--topk") ?? 10,
    limitQueries: numAfter("--limit-queries"),
  };
}

// ── Per-config result bundle (for the results JSON + comparison table) ────────

interface ConfigResult {
  name: string;
  flags: { bm25: boolean; vectorchord: boolean; rerank: boolean; cjk: boolean };
  status: "ok" | "failed";
  error?: string;
  overall?: MetricSummary;
  byDialect?: Record<string, MetricSummary>;
  byDomain?: Record<string, MetricSummary>;
}

// ── Reporting helpers ─────────────────────────────────────────────────────────

const pct = (x: number) => (x * 100).toFixed(1).padStart(6);
const f3 = (x: number) => x.toFixed(3).padStart(6);

function printSummaryTable(title: string, rows: Array<[string, MetricSummary]>): void {
  console.log(`\n  ${title}`);
  console.log(
    `    ${"group".padEnd(14)} ${"n".padStart(4)} ${"R@1".padStart(6)} ${"R@3".padStart(6)} ` +
      `${"R@5".padStart(6)} ${"R@10".padStart(6)} ${"MRR10".padStart(6)} ${"nDCG".padStart(6)}`,
  );
  for (const [label, m] of rows) {
    console.log(
      `    ${label.padEnd(14)} ${String(m.n).padStart(4)} ${pct(m.recallAt1)} ${pct(m.recallAt3)} ` +
        `${pct(m.recallAt5)} ${pct(m.recallAt10)} ${f3(m.mrr10)} ${f3(m.ndcg10)}`,
    );
  }
}

function mapToRecord(m: Map<string, MetricSummary>): Record<string, MetricSummary> {
  const out: Record<string, MetricSummary> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}

function printDisclosure(corpus: CorpusChunk[]): void {
  const count = (pred: (c: CorpusChunk) => boolean) => corpus.filter(pred).length;
  const docIds = (pred: (c: CorpusChunk) => boolean) =>
    new Set(corpus.filter(pred).map((c) => c.doc_id)).size;
  const domains = [...new Set(corpus.map((c) => c.domain))].sort();
  const providers = [...new Set(corpus.map((c) => c.provider))].sort();

  console.log(`\n${"═".repeat(80)}`);
  console.log("CORPUS DISCLOSURE");
  console.log(`${"─".repeat(80)}`);
  console.log(
    `  chunks: ${corpus.length} total — faq=${count((c) => c.source === "faq")} ` +
      `pdf=${count((c) => c.source === "pdf")}`,
  );
  console.log(
    `  docs:   faq=${docIds((c) => c.source === "faq")} ` +
      `pdf=${docIds((c) => c.source === "pdf")}`,
  );
  console.log(`  domains:   ${domains.join(", ")}`);
  console.log(`  providers: ${providers.join(", ")}`);
  for (const d of domains) {
    console.log(`    [${d}] chunks=${count((c) => c.domain === d)}`);
  }
  console.log(
    "  Note: the corpus is terms/policy (PDF distractors) + FAQ content. Scored targets are FAQ\n" +
      "  answers; PDFs act as in-domain distractors. Queries are Arabic in three dialects (MSA,\n" +
      "  Saudi, Darija) sharing one target FAQ per query.",
  );
  console.log(`${"═".repeat(80)}`);
}

function printComparison(results: ConfigResult[]): void {
  console.log(`\n${"═".repeat(80)}`);
  console.log("CONFIG COMPARISON (overall, all dialects)");
  console.log(`${"─".repeat(80)}`);
  console.log(
    `  ${"config".padEnd(14)} ${"R@1".padStart(6)} ${"R@3".padStart(6)} ${"R@5".padStart(6)} ` +
      `${"R@10".padStart(6)} ${"MRR10".padStart(6)} ${"nDCG".padStart(6)}`,
  );
  for (const r of results) {
    if (r.status !== "ok" || !r.overall) {
      console.log(`  ${r.name.padEnd(14)} FAILED — ${r.error ?? "unknown error"}`);
      continue;
    }
    const m = r.overall;
    console.log(
      `  ${r.name.padEnd(14)} ${pct(m.recallAt1)} ${pct(m.recallAt3)} ${pct(m.recallAt5)} ` +
        `${pct(m.recallAt10)} ${f3(m.mrr10)} ${f3(m.ndcg10)}`,
    );
  }

  console.log(`\n  recall@5 by dialect`);
  console.log(`  ${"config".padEnd(14)} ${DIALECTS.map((d) => d.padStart(8)).join(" ")}`);
  for (const r of results) {
    if (r.status !== "ok" || !r.byDialect) continue;
    const cells = DIALECTS.map((d) => {
      const m = r.byDialect?.[d];
      return (m ? `${(m.recallAt5 * 100).toFixed(1)}%` : "—").padStart(8);
    });
    console.log(`  ${r.name.padEnd(14)} ${cells.join(" ")}`);
  }
  console.log(`${"═".repeat(80)}`);
}

// ── Bounded-concurrency map ───────────────────────────────────────────────────
// Runs `fn` over items with at most `limit` in flight, preserving input order in the
// output. Each search is independent (its own reserved per-leg connections + transaction-
// local GUCs), so they parallelize safely as long as the pool is sized to ~3×limit.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Core: run one config end-to-end ───────────────────────────────────────────

interface RunOneResult {
  result: ConfigResult;
  /** Kept alive (not dropped) only for the final judge pass. */
  keep?: {
    pipeline: RagPipeline;
    sql: postgres.Sql;
    dbName: string;
    adminUrl: string;
    rerank: boolean;
  };
}

async function runConfig(
  config: BenchConfig,
  cjk: boolean,
  topK: number,
  adminUrl: string,
  corpus: CorpusChunk[],
  docOrder: Array<{ doc_id: string; source: string; chunks: CorpusChunk[] }>,
  queries: BenchmarkQuery[],
  docIdByUuid: Map<string, string>,
  embedder: ReturnType<typeof withEmbeddingCache>,
  reranker: ReturnType<typeof createReranker>,
  keepForJudge: boolean,
  createdDbs: Set<string>,
): Promise<RunOneResult> {
  const dbName = `arrag_bench_${config.name.replace(/[^a-z0-9]/g, "")}`;
  const result: ConfigResult = {
    name: config.name,
    flags: { bm25: config.bm25, vectorchord: config.vectorchord, rerank: config.rerank, cjk },
    status: "ok",
  };

  console.log(`\n${"#".repeat(80)}`);
  console.log(
    `# CONFIG "${config.name}" — bm25=${config.bm25} vectorchord=${config.vectorchord} ` +
      `rerank=${config.rerank} cjk=${cjk}`,
  );
  console.log(`${"#".repeat(80)}`);

  console.log(`  Creating database "${dbName}"...`);
  await createDatabase(adminUrl, dbName);
  createdDbs.add(dbName);

  const dbUrl = withDatabase(adminUrl, dbName);
  // Pool sized to ~3×SEARCH_CONCURRENCY: each concurrent search reserves one connection per
  // leg (vector/keyword/fts), plus margin for the admin/indexer paths.
  const { txProvider, migrationProvider, sql } = createAdapter(
    postgres(dbUrl, { max: SEARCH_CONCURRENCY * 3 + 4 }),
  );

  // Bounded cleanup: close the pool, then drop the DB. Mirrors the playground's pattern so
  // an errored search leg (fail-fast Promise.all) cannot hang cleanup forever.
  const cleanup = async () => {
    await sql.end({ timeout: 5 }).catch(() => {});
    await dropDatabase(adminUrl, dbName).catch(() => {});
    createdDbs.delete(dbName);
  };

  try {
    console.log(
      `  Migrating (vectorchord=${config.vectorchord}, bm25=${config.bm25}, cjk=${cjk})...`,
    );
    await ragMigrate(migrationProvider, {
      sqlDir: fileURLToPath(new URL("../../sql", import.meta.url)),
      vectorchord: config.vectorchord,
      bm25: config.bm25,
      cjk,
      // Embedding column dimension. Defaults to 384 (multilingual-e5-small); override via
      // EMBEDDING_DIM for SOTA head-to-heads (e.g. 1024 for e5-large / BGE-M3).
      embeddingDimensions: Number(process.env.EMBEDDING_DIM) || 384,
    });

    console.log("  Seeding Arabic stop words...");
    await seedArabicStopWords(sql);

    const stopWords = new CachingStopWordsLoader({
      txProvider,
      normalizeWord: normalizeForLanguage,
    });

    const db = new PostgresRagDatabase(txProvider, {
      ...(config.bm25 ? { fts: new Bm25Fts() } : {}),
      ...(cjk ? { cjk: true } : {}),
    });

    const indexer = new RagIndexer({
      tenantId: TENANT_ID,
      db,
      embedder,
      normalizer: new LanguageNormalizer(),
      logger,
    });

    console.log(`  Indexing ${docOrder.length} docs (${corpus.length} chunks)...`);
    let indexed = 0;
    for (const doc of docOrder) {
      const chunks = doc.chunks.map((c, i) => ({
        content: c.content,
        index: i,
        metadata: { language: "ar", domain: c.domain, provider: c.provider, source: c.source },
      }));
      // source_id is a UUID column; index under the doc's deterministic UUID.
      indexed += await indexer.index(doc.source, docIdToUuid(doc.doc_id), chunks, "ar");
    }
    console.log(`  Indexed ${indexed} chunks across ${docOrder.length} docs.`);

    const pipeline = new RagPipeline({
      tenantId: TENANT_ID,
      db,
      embedder,
      normalizer: new LanguageNormalizer(),
      stopWords,
      logger,
      ...(config.rerank && reranker ? { reranker } : {}),
    });
    if (config.rerank && !reranker) {
      console.warn("  --rerank requested but no RERANKER_BASE_URL; running without reranker.");
    }

    // Vector-leg similarity floor. The library default (0.8) is calibrated for e5-style
    // INFLATED cosine similarities; better-calibrated embedders (e.g. BGE-M3, related≈0.6-0.75)
    // have almost nothing clear 0.8, which silently zeroes the dense leg. Override via
    // VECTOR_MIN_SCORE for cross-model head-to-heads (0 disables the floor entirely).
    const envVms = process.env.VECTOR_MIN_SCORE;
    const vectorMinScore =
      envVms !== undefined && envVms !== "" && Number.isFinite(Number(envVms))
        ? Number(envVms)
        : undefined;
    if (vectorMinScore !== undefined) {
      console.log(`  Using vectorMinScore=${vectorMinScore} (VECTOR_MIN_SCORE override).`);
    }

    // Rerank-the-union depth + per-leg candidate depth (the experiment knobs). RERANK_CANDIDATES
    // is how many fused candidates the cross-encoder scores (default topK); set it higher to
    // rerank a bounded union. CANDIDATE_MULTIPLIER controls how many rows each leg returns
    // (candidateLimit = topK × multiplier), so it must be ≥ RERANK_CANDIDATES/topK for the union
    // to actually contain that many candidates.
    const posIntEnv = (name: string): number | undefined => {
      const n = Number(process.env[name]);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const rerankCandidates = posIntEnv("RERANK_CANDIDATES");
    const candidateMultiplier = posIntEnv("CANDIDATE_MULTIPLIER");
    if (rerankCandidates !== undefined || candidateMultiplier !== undefined) {
      console.log(
        `  Rerank depth: rerankCandidates=${rerankCandidates ?? `topK(${topK})`}, ` +
          `candidateMultiplier=${candidateMultiplier ?? "default(2)"}.`,
      );
    }

    // Fusion strategy knobs (the linear-fusion experiment). FUSION selects rrf (default) or
    // linear; NORMALIZER picks minmax (default) or l2 for the linear path. Undefined → pipeline
    // defaults (rrf / minmax), i.e. unchanged behavior.
    const fusion = process.env.FUSION === "linear" ? ("linear" as const) : undefined;
    const fusionNormalizer =
      process.env.NORMALIZER === "l2"
        ? ("l2" as const)
        : process.env.NORMALIZER === "minmax"
          ? ("minmax" as const)
          : undefined;
    if (fusion !== undefined || fusionNormalizer !== undefined) {
      console.log(
        `  Fusion: ${fusion ?? "rrf (default)"}, normalizer=${fusionNormalizer ?? "minmax (default)"}.`,
      );
    }

    console.log(
      `  Scoring ${queries.length} queries × ${DIALECTS.length} dialects (concurrency=${SEARCH_CONCURRENCY})...`,
    );
    // Flatten to one task per (query, dialect) variant, then run with bounded concurrency.
    const searchTasks = queries.flatMap((query) =>
      DIALECTS.flatMap((dialect) => {
        const variant = query.variants[dialect];
        return variant ? [{ query, dialect, variant }] : [];
      }),
    );
    const outcomes: QueryOutcome[] = await mapWithConcurrency(
      searchTasks,
      SEARCH_CONCURRENCY,
      async ({ query, dialect, variant }): Promise<QueryOutcome> => {
        const results = await pipeline.search(variant, {
          topK,
          language: "ar",
          rerank: config.rerank,
          ...(vectorMinScore !== undefined ? { vectorMinScore } : {}),
          ...(rerankCandidates !== undefined ? { rerankCandidates } : {}),
          ...(candidateMultiplier !== undefined ? { candidateMultiplier } : {}),
          ...(fusion !== undefined ? { fusion } : {}),
          ...(fusionNormalizer !== undefined ? { fusionNormalizer } : {}),
        });
        return {
          // Translate the returned UUID source_id back to the original doc_id ground-truth key.
          rankedDocIds: results.map((r) =>
            r.sourceId ? (docIdByUuid.get(r.sourceId) ?? r.sourceId) : "",
          ),
          targetDoc: query.target_doc,
          dialect,
          domain: query.domain,
          provider: query.provider,
          source: "faq",
        };
      },
    );

    const overall = summarize(outcomes);
    const byDialect = sliceBy(outcomes, (o) => o.dialect);
    const byDomain = sliceBy(outcomes, (o) => o.domain);

    result.overall = overall;
    result.byDialect = mapToRecord(byDialect);
    result.byDomain = mapToRecord(byDomain);

    printSummaryTable(`[${config.name}] overall`, [["all", overall]]);
    printSummaryTable(`[${config.name}] by dialect`, [...byDialect.entries()]);
    printSummaryTable(`[${config.name}] by domain`, [...byDomain.entries()]);

    if (keepForJudge) {
      // Defer cleanup so the judge pass can use this pipeline's live DB.
      return { result, keep: { pipeline, sql, dbName, adminUrl, rerank: config.rerank } };
    }

    await cleanup();
    return { result };
  } catch (err) {
    await cleanup();
    result.status = "failed";
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`  CONFIG "${config.name}" FAILED: ${result.error}`);
    return { result };
  }
}

// ── Stop words (copied from examples/playground.ts seedStopWords `ar` list) ───

async function seedArabicStopWords(sql: postgres.Sql): Promise<void> {
  const words = [
    "في",
    "من",
    "على",
    "إلى",
    "هل",
    "ما",
    "هذا",
    "هذه",
    "أن",
    "و",
    "أو",
    "لا",
    "هو",
    "هي",
    "نحن",
    "هم",
    "كل",
    "بعد",
    "قبل",
    "عن",
    "مع",
    "ذلك",
    "التي",
    "الذي",
  ];
  // Parameterized batch insert ($1..$N) — never interpolate values into SQL.
  const placeholders = words
    .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
    .join(", ");
  const params = words.flatMap((w) => [TENANT_ID, "ar", w]);
  await sql.unsafe(
    `INSERT INTO rag_stop_words (tenant_id, language, word) VALUES ${placeholders}`,
    params,
  );
  console.log(`    Seeded ${words.length} Arabic stop words.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== pg-hybrid-rag benchmark ===\n");

  const args = parseArgs(process.argv.slice(2));
  const adminUrl = buildDatabaseUrl();

  const configs: BenchConfig[] = args.matrix
    ? args.lean
      ? LEAN_MATRIX
      : MATRIX
    : [
        {
          name: "custom",
          bm25: args.bm25,
          vectorchord: args.vectorchord,
          rerank: args.rerank,
        },
      ];

  // Load corpus + queries.
  const corpus = loadOrBuildCorpus();
  console.log(`Loaded corpus: ${corpus.length} chunks.`);

  const corpusDocIds = new Set(corpus.map((c) => c.doc_id));
  const { queries } = loadQueries(fileURLToPath(new URL("./queries.json", import.meta.url)));
  const { resolved, unresolved } = resolveQueries(queries, corpusDocIds);
  console.log(
    `Queries: ${queries.length} total — resolved=${resolved.length}, ` +
      `unresolved (excluded, target_doc absent from corpus)=${unresolved.length}.`,
  );

  const selectedQueries =
    args.limitQueries != null ? resolved.slice(0, args.limitQueries) : resolved;
  if (args.limitQueries != null) {
    console.log(`Limited to first ${selectedQueries.length} resolved queries (--limit-queries).`);
  }

  // Group corpus chunks by doc_id, preserving first-seen order.
  const docMap = new Map<string, { doc_id: string; source: string; chunks: CorpusChunk[] }>();
  for (const c of corpus) {
    const existing = docMap.get(c.doc_id);
    if (existing) {
      existing.chunks.push(c);
    } else {
      docMap.set(c.doc_id, { doc_id: c.doc_id, source: c.source, chunks: [c] });
    }
  }
  const docOrder = [...docMap.values()];

  // Reverse map: deterministic doc UUID → original doc_id (to translate search results back).
  const docIdByUuid = new Map<string, string>();
  for (const doc of docOrder) docIdByUuid.set(docIdToUuid(doc.doc_id), doc.doc_id);

  // Corpus-level snippet validation — warn if a query's target_snippet is missing from its
  // target doc's indexed chunk text (catches extraction drift / empty docs).
  const docTextMap = new Map<string, string>();
  for (const doc of docOrder) {
    docTextMap.set(doc.doc_id, doc.chunks.map((c) => c.content).join(" "));
  }
  const missingSnippetIds: string[] = [];
  for (const q of selectedQueries) {
    const present = snippetPresent(q.target_snippet, docTextMap.get(q.target_doc) ?? "", (s) =>
      normalizeForLanguage(s, "ar"),
    );
    if (!present) missingSnippetIds.push(q.id);
  }
  if (missingSnippetIds.length === 0) {
    console.log(
      `Snippet validation: all ${selectedQueries.length} target snippets found in their target docs.`,
    );
  } else {
    console.warn(
      `Snippet validation: ${missingSnippetIds.length}/${selectedQueries.length} target snippets NOT found in their target doc's chunks (possible extraction drift): ${missingSnippetIds.join(", ")}`,
    );
  }

  // Shared embedder (cache shared across configs so each unique chunk/query embeds once total).
  const embedder = withEmbeddingCache(createEmbedder());
  const reranker = createReranker();
  if (configs.some((c) => c.rerank) && !reranker) {
    console.warn(
      "A config requests --rerank but RERANKER_BASE_URL is missing; it will run without.",
    );
  }

  printDisclosure(corpus);

  const createdDbs = new Set<string>();
  const results: ConfigResult[] = [];
  let judgeKeep: RunOneResult["keep"];

  try {
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      const isLast = i === configs.length - 1;
      const keepForJudge = args.judge && isLast;
      const run = await runConfig(
        config,
        args.cjk,
        args.topK,
        adminUrl,
        corpus,
        docOrder,
        selectedQueries,
        docIdByUuid,
        embedder,
        reranker,
        // Only keep the DB alive if the judge is enabled AND this config actually succeeded.
        keepForJudge,
        createdDbs,
      );
      results.push(run.result);
      if (run.keep) {
        judgeKeep = run.keep;
      }
    }

    // Judge pass (optional) on the LAST config's pipeline before dropping its DB.
    let judgeReport: { k: number; meanPrecision: number; n: number } | undefined;
    if (args.judge) {
      const cfg = judgeEnabledFromEnv();
      if (!cfg) {
        console.warn("\n--judge set but JUDGE_BASE_URL/JUDGE_MODEL missing; skipping judge pass.");
      } else if (!judgeKeep) {
        console.warn("\n--judge set but the last config failed; skipping judge pass.");
      } else {
        console.log("\nRunning LLM judge over first ~15 resolved queries (MSA variant)...");
        const judgeQueries = selectedQueries.slice(0, 15);
        const precisions: number[] = [];
        for (const q of judgeQueries) {
          const variant = q.variants.msa;
          if (!variant) continue;
          const searchResults = await judgeKeep.pipeline.search(variant, {
            topK: args.topK,
            language: "ar",
            rerank: judgeKeep.rerank,
          });
          if (searchResults.length === 0) continue;
          const scores = await judgeResults(variant, searchResults, cfg);
          const relevant = scores.filter((s) => s >= 1).length;
          precisions.push(relevant / scores.length);
        }
        const meanPrecision =
          precisions.length > 0 ? precisions.reduce((a, b) => a + b, 0) / precisions.length : 0;
        judgeReport = { k: args.topK, meanPrecision, n: precisions.length };
        console.log(
          `  Judge: mean precision@${args.topK} (results scoring ≥1) = ` +
            `${(meanPrecision * 100).toFixed(1)}% over ${precisions.length} queries.`,
        );
      }
    }

    // Drop the deferred judge DB now that the judge pass is done.
    if (judgeKeep) {
      await judgeKeep.sql.end({ timeout: 5 }).catch(() => {});
      await dropDatabase(judgeKeep.adminUrl, judgeKeep.dbName).catch(() => {});
      createdDbs.delete(judgeKeep.dbName);
    }

    // Report.
    printComparison(results);

    // Write results JSON.
    const resultsDir = fileURLToPath(new URL("./results", import.meta.url));
    mkdirSync(resultsDir, { recursive: true });
    const outPath = `${resultsDir}/${Date.now()}.json`;
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          args,
          corpus: {
            chunks: corpus.length,
            faqChunks: corpus.filter((c) => c.source === "faq").length,
            pdfChunks: corpus.filter((c) => c.source === "pdf").length,
            docs: docOrder.length,
            domains: [...new Set(corpus.map((c) => c.domain))].sort(),
            providers: [...new Set(corpus.map((c) => c.provider))].sort(),
            note: "terms/policy (PDF distractors) + FAQ content",
          },
          queries: {
            total: queries.length,
            resolved: resolved.length,
            unresolved: unresolved.length,
            scored: selectedQueries.length,
          },
          configs: results,
          judge: judgeReport,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`\nWrote results: ${outPath}`);
  } finally {
    // Best-effort: drop any DB still tracked as created (e.g. mid-loop crash).
    for (const dbName of createdDbs) {
      await dropDatabase(adminUrl, dbName).catch(() => {});
    }
  }

  const okCount = results.filter((r) => r.status === "ok").length;
  console.log(`\n=== Done: ${okCount}/${results.length} configs succeeded ===\n`);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
