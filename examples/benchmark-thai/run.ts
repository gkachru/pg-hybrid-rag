/**
 * Thai segmentation benchmark runner — runs LIVE against a real Postgres + embedding API.
 *
 * Headline axis: word segmentation. For each config (a `custom` config, the 5 `--matrix`
 * presets with attacut fixed, or the `--seg-matrix` sweep of {none,intl,attacut}×{baseline,
 * +rerank}), it creates an isolated database, migrates it (optional bm25/vectorchord; NEVER
 * pg_bigm), seeds Thai stop words, indexes the pre-built corpus with the arm's segmenter, runs
 * every resolved query × its three register variants through RagPipeline.search, scores, then
 * drops the DB. Prints per-config tables + a cross-config (cross-segmenter) comparison and a
 * results JSON.
 *
 * Usage:
 *   bun run examples/benchmark-thai/run.ts                          # single baseline (attacut)
 *   bun run examples/benchmark-thai/run.ts --segmenter none         # single arm
 *   bun run examples/benchmark-thai/run.ts --seg-matrix             # headline: 3 segmenters × {baseline,+rerank}
 *   bun run examples/benchmark-thai/run.ts --matrix                 # 5 extension configs (attacut fixed)
 *   bun run examples/benchmark-thai/run.ts --seg-matrix --limit-queries 6 --judge
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
  createSegmenter,
  dropDatabase,
  logger,
  type SegmenterKind,
  TENANT_ID,
  withDatabase,
} from "./infra.js";
import { judgeEnabledFromEnv, judgeResults } from "./judge.js";
import { isLoanwordHeavy } from "./loanword.js";
import { type MetricSummary, type QueryOutcome, sliceBy, summarize } from "./metrics.js";
import { loadQueries, resolveQueries, snippetPresent } from "./qrels.js";
import type { BenchmarkQuery, CorpusChunk, Register } from "./types.js";

// ── Config ──────────────────────────────────────────────────────────────────

interface BenchConfig {
  name: string;
  bm25: boolean;
  vectorchord: boolean;
  rerank: boolean;
  segmenter: SegmenterKind;
}

// Standard extension matrix — segmenter fixed to attacut (production default). Answers
// "do bm25 / vectorchord / rerank add value on Thai?" independent of the segmenter axis.
const MATRIX: BenchConfig[] = [
  { name: "baseline", bm25: false, vectorchord: false, rerank: false, segmenter: "attacut" },
  { name: "+bm25", bm25: true, vectorchord: false, rerank: false, segmenter: "attacut" },
  { name: "+vectorchord", bm25: false, vectorchord: true, rerank: false, segmenter: "attacut" },
  { name: "+rerank", bm25: false, vectorchord: false, rerank: true, segmenter: "attacut" },
  { name: "all", bm25: true, vectorchord: true, rerank: true, segmenter: "attacut" },
];

const REGISTERS: Register[] = ["written", "spoken", "codeswitch"];

// Headline segmenter sweep: {none,intl,attacut} × {baseline,+rerank}. Mirrors the lean-matrix
// philosophy — only the configs that distinguish the axis of interest. The
// +rerank rows show whether the segmenter-blind cross-encoder can paper over a worse segmenter.
const SEG_KINDS: SegmenterKind[] = ["none", "intl", "attacut"];
const SEG_MATRIX: BenchConfig[] = SEG_KINDS.flatMap((seg) => [
  { name: `baseline/${seg}`, bm25: false, vectorchord: false, rerank: false, segmenter: seg },
  { name: `+rerank/${seg}`, bm25: false, vectorchord: false, rerank: true, segmenter: seg },
]);

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
  segmenter: SegmenterKind;
  judge: boolean;
  matrix: boolean;
  segMatrix: boolean;
  topK: number;
  limitQueries?: number;
  includeQuestion: boolean;
}

function parseArgs(argv: string[]): Args {
  const has = (flag: string) => argv.includes(flag);
  const numAfter = (flag: string): number | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) return undefined;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) ? n : undefined;
  };
  const strAfter = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 || i + 1 >= argv.length ? undefined : argv[i + 1];
  };
  const seg = strAfter("--segmenter");
  if (seg !== undefined && seg !== "none" && seg !== "intl" && seg !== "attacut") {
    console.warn(`Unrecognized --segmenter "${seg}"; defaulting to "attacut".`);
  }
  const segmenter: SegmenterKind = seg === "none" || seg === "intl" ? seg : "attacut";
  return {
    bm25: has("--bm25"),
    vectorchord: has("--vectorchord"),
    rerank: has("--rerank"),
    segmenter,
    judge: has("--judge"),
    matrix: has("--matrix"),
    segMatrix: has("--seg-matrix"),
    topK: numAfter("--topk") ?? 10,
    limitQueries: numAfter("--limit-queries"),
    includeQuestion: has("--include-question"),
  };
}

// ── Per-config result bundle (for the results JSON + comparison table) ────────

interface ConfigResult {
  name: string;
  flags: { bm25: boolean; vectorchord: boolean; rerank: boolean; segmenter: SegmenterKind };
  status: "ok" | "failed";
  error?: string;
  overall?: MetricSummary;
  byRegister?: Record<string, MetricSummary>;
  byDomain?: Record<string, MetricSummary>;
  byLoanword?: Record<string, MetricSummary>;
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
    "  Note: the corpus is policy/T&C (PDF distractors) + FAQ content. Scored targets are FAQ\n" +
      "  answers; PDFs act as in-domain distractors. Queries are Thai in three registers (written,\n" +
      "  spoken, code-switched) sharing one target FAQ per query. Headline axis: word segmenter.",
  );
  console.log(`${"═".repeat(80)}`);
}

function printComparison(results: ConfigResult[]): void {
  console.log(`\n${"═".repeat(80)}`);
  console.log("CONFIG COMPARISON (overall, all registers) — segmenter is the headline axis");
  console.log(`${"─".repeat(80)}`);
  console.log(
    `  ${"config".padEnd(18)} ${"R@1".padStart(6)} ${"R@3".padStart(6)} ${"R@5".padStart(6)} ` +
      `${"R@10".padStart(6)} ${"MRR10".padStart(6)} ${"nDCG".padStart(6)}`,
  );
  for (const r of results) {
    if (r.status !== "ok" || !r.overall) {
      console.log(`  ${r.name.padEnd(18)} FAILED — ${r.error ?? "unknown error"}`);
      continue;
    }
    const m = r.overall;
    console.log(
      `  ${r.name.padEnd(18)} ${pct(m.recallAt1)} ${pct(m.recallAt3)} ${pct(m.recallAt5)} ` +
        `${pct(m.recallAt10)} ${f3(m.mrr10)} ${f3(m.ndcg10)}`,
    );
  }

  console.log(`\n  recall@5 by register`);
  console.log(`  ${"config".padEnd(18)} ${REGISTERS.map((d) => d.padStart(10)).join(" ")}`);
  for (const r of results) {
    if (r.status !== "ok" || !r.byRegister) continue;
    const cells = REGISTERS.map((d) => {
      const m = r.byRegister?.[d];
      return (m ? `${(m.recallAt5 * 100).toFixed(1)}%` : "—").padStart(10);
    });
    console.log(`  ${r.name.padEnd(18)} ${cells.join(" ")}`);
  }

  console.log(`\n  recall@5 by loanword slice (the OOV signal)`);
  console.log(`  ${"config".padEnd(18)} ${"loanword".padStart(10)} ${"native".padStart(10)}`);
  for (const r of results) {
    if (r.status !== "ok" || !r.byLoanword) continue;
    const cell = (key: string) => {
      const m = r.byLoanword?.[key];
      return (m ? `${(m.recallAt5 * 100).toFixed(1)}%` : "—").padStart(10);
    };
    console.log(`  ${r.name.padEnd(18)} ${cell("loanword")} ${cell("native")}`);
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
  const dbName = `thrag_bench_${config.name.replace(/[^a-z0-9]/g, "")}`;
  const result: ConfigResult = {
    name: config.name,
    flags: {
      bm25: config.bm25,
      vectorchord: config.vectorchord,
      rerank: config.rerank,
      segmenter: config.segmenter,
    },
    status: "ok",
  };

  console.log(`\n${"#".repeat(80)}`);
  console.log(
    `# CONFIG "${config.name}" — segmenter=${config.segmenter} bm25=${config.bm25} ` +
      `vectorchord=${config.vectorchord} rerank=${config.rerank}`,
  );
  console.log(`${"#".repeat(80)}`);

  console.log(`  Creating database "${dbName}"...`);
  await createDatabase(adminUrl, dbName);
  createdDbs.add(dbName);

  const dbUrl = withDatabase(adminUrl, dbName);
  const { txProvider, migrationProvider, sql } = createAdapter(
    postgres(dbUrl, { max: SEARCH_CONCURRENCY * 3 + 4 }),
  );

  const cleanup = async () => {
    await sql.end({ timeout: 5 }).catch(() => {});
    await dropDatabase(adminUrl, dbName).catch(() => {});
    createdDbs.delete(dbName);
  };

  try {
    console.log(`  Migrating (vectorchord=${config.vectorchord}, bm25=${config.bm25})...`);
    await ragMigrate(migrationProvider, {
      sqlDir: fileURLToPath(new URL("../../sql", import.meta.url)),
      vectorchord: config.vectorchord,
      bm25: config.bm25,
      embeddingDimensions: Number(process.env.EMBEDDING_DIM) || 384,
    });

    console.log("  Seeding Thai stop words...");
    await seedThaiStopWords(sql);

    const stopWords = new CachingStopWordsLoader({
      txProvider,
      normalizeWord: normalizeForLanguage,
    });

    // The headline axis: build this arm's segmenter and inject the SAME instance into the
    // db (keyword-leg routing), the indexer (content_normalized), and the pipeline (lexical
    // query). NOT into the Chunker — chunk text is arm-independent (corpus is pre-built).
    const segmenter = createSegmenter(config.segmenter);

    const db = new PostgresRagDatabase(txProvider, {
      ...(config.bm25 ? { fts: new Bm25Fts() } : {}),
      ...(segmenter ? { segmenter } : {}),
    });

    const indexer = new RagIndexer({
      tenantId: TENANT_ID,
      db,
      embedder,
      normalizer: new LanguageNormalizer(),
      ...(segmenter ? { segmenter } : {}),
      logger,
    });

    console.log(`  Indexing ${docOrder.length} docs (${corpus.length} chunks)...`);
    let indexed = 0;
    for (const doc of docOrder) {
      const chunks = doc.chunks.map((c, i) => ({
        content: c.content,
        index: i,
        metadata: { language: "th", domain: c.domain, provider: c.provider, source: c.source },
      }));
      indexed += await indexer.index(doc.source, docIdToUuid(doc.doc_id), chunks, "th");
    }
    console.log(`  Indexed ${indexed} chunks across ${docOrder.length} docs.`);

    const pipeline = new RagPipeline({
      tenantId: TENANT_ID,
      db,
      embedder,
      normalizer: new LanguageNormalizer(),
      stopWords,
      ...(segmenter ? { segmenter } : {}),
      logger,
      ...(config.rerank && reranker ? { reranker } : {}),
    });
    if (config.rerank && !reranker) {
      console.warn("  --rerank requested but no RERANKER_BASE_URL; running without reranker.");
    }

    const envVms = process.env.VECTOR_MIN_SCORE;
    const vectorMinScore =
      envVms !== undefined && envVms !== "" && Number.isFinite(Number(envVms))
        ? Number(envVms)
        : undefined;
    if (vectorMinScore !== undefined) {
      console.log(`  Using vectorMinScore=${vectorMinScore} (VECTOR_MIN_SCORE override).`);
    }

    console.log(
      `  Scoring ${queries.length} queries × ${REGISTERS.length} registers (concurrency=${SEARCH_CONCURRENCY})...`,
    );
    const searchTasks = queries.flatMap((query) =>
      REGISTERS.flatMap((register) => {
        const variant = query.variants[register];
        return variant ? [{ query, register, variant }] : [];
      }),
    );
    const outcomes: QueryOutcome[] = await mapWithConcurrency(
      searchTasks,
      SEARCH_CONCURRENCY,
      async ({ query, register, variant }): Promise<QueryOutcome> => {
        const results = await pipeline.search(variant, {
          topK,
          language: "th",
          rerank: config.rerank,
          ...(vectorMinScore !== undefined ? { vectorMinScore } : {}),
        });
        return {
          rankedDocIds: results.map((r) =>
            r.sourceId ? (docIdByUuid.get(r.sourceId) ?? r.sourceId) : "",
          ),
          targetDoc: query.target_doc,
          register,
          domain: query.domain,
          provider: query.provider,
          loanword: isLoanwordHeavy(variant),
          source: "faq",
        };
      },
    );

    const overall = summarize(outcomes);
    const byRegister = sliceBy(outcomes, (o) => o.register);
    const byDomain = sliceBy(outcomes, (o) => o.domain);
    const byLoanword = sliceBy(outcomes, (o) => (o.loanword ? "loanword" : "native"));

    result.overall = overall;
    result.byRegister = mapToRecord(byRegister);
    result.byDomain = mapToRecord(byDomain);
    result.byLoanword = mapToRecord(byLoanword);

    printSummaryTable(`[${config.name}] overall`, [["all", overall]]);
    printSummaryTable(`[${config.name}] by register`, [...byRegister.entries()]);
    printSummaryTable(`[${config.name}] by domain`, [...byDomain.entries()]);
    printSummaryTable(`[${config.name}] by loanword`, [...byLoanword.entries()]);

    if (keepForJudge) {
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

// ── Thai stop words (common function words; PyThaiNLP-style minimal set) ──────
async function seedThaiStopWords(sql: postgres.Sql): Promise<void> {
  const words = [
    "ที่",
    "และ",
    "การ",
    "ของ",
    "ใน",
    "เป็น",
    "มี",
    "ได้",
    "ว่า",
    "จะ",
    "ไม่",
    "ให้",
    "กับ",
    "ก็",
    "นี้",
    "หรือ",
    "แต่",
    "โดย",
    "ความ",
    "จาก",
    "ด้วย",
    "อยู่",
    "ต้อง",
    "แล้ว",
  ];
  const placeholders = words
    .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
    .join(", ");
  const params = words.flatMap((w) => [TENANT_ID, "th", w]);
  await sql.unsafe(
    `INSERT INTO rag_stop_words (tenant_id, language, word) VALUES ${placeholders}`,
    params,
  );
  console.log(`    Seeded ${words.length} Thai stop words.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== pg-hybrid-rag benchmark ===\n");

  const args = parseArgs(process.argv.slice(2));
  const adminUrl = buildDatabaseUrl();

  const configs: BenchConfig[] = args.matrix
    ? MATRIX
    : args.segMatrix
      ? SEG_MATRIX
      : [
          {
            name: "custom",
            bm25: args.bm25,
            vectorchord: args.vectorchord,
            rerank: args.rerank,
            segmenter: args.segmenter,
          },
        ];

  // Load corpus + queries.
  const corpus = loadOrBuildCorpus(args.includeQuestion);
  console.log(
    `Loaded corpus (${args.includeQuestion ? "question+answer" : "answer-only"}): ${corpus.length} chunks.`,
  );

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
      normalizeForLanguage(s, "th"),
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
        args.topK,
        adminUrl,
        corpus,
        docOrder,
        selectedQueries,
        docIdByUuid,
        embedder,
        reranker,
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
        console.log("\nRunning LLM judge over first ~15 resolved queries (written variant)...");
        const judgeQueries = selectedQueries.slice(0, 15);
        const precisions: number[] = [];
        for (const q of judgeQueries) {
          const variant = q.variants.written;
          if (!variant) continue;
          const searchResults = await judgeKeep.pipeline.search(variant, {
            topK: args.topK,
            language: "th",
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
