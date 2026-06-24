/**
 * Integration-test harness for verifying DB index utilization against a REAL Postgres.
 *
 * The unit suite mocks every DB call, so it structurally cannot detect a sequential scan.
 * Index utilization can only be proven by EXPLAIN against a live planner. This module provides:
 *   - isolated test-DB create/drop (mirrors examples/playground.ts)
 *   - a reserving TransactionProvider that ALSO captures every SQL statement the adapter issues
 *     (so the EXPLAIN test runs the EXACT SQL+params production runs — it can never drift)
 *   - an `explain()` runner that defeats the small-table planner trap (see below)
 *   - plan-tree helpers (which indexes were used, which relations were seq-scanned)
 *   - a deterministic seeder (real adapter insert path; no embedding API needed)
 *
 * Gated by PG_INTEGRATION=1 — `bun test` stays DB-free by default. Requires the custom Postgres
 * image (examples/Dockerfile: pgvector + vchord + pg_textsearch + pg_bigm) for the gated migrations.
 */

import { join } from "node:path";
import postgres from "postgres";
import { PostgresRagDatabase, type SqlClient, type TransactionProvider } from "../../src/index.js";

/** True when the operator has opted into the live-Postgres integration suite. */
export const RUN_INTEGRATION = process.env.PG_INTEGRATION === "1";

/**
 * Path to the migration SQL. ragMigrate's auto-detection (import.meta.dirname via new Function)
 * returns undefined under bun's test runner, so we pass sqlDir explicitly — same as migrate.test.ts.
 */
export const SQL_DIR = join(import.meta.dir, "..", "..", "sql");

/** Embedding dimension used by these tests (migration 002 default). */
export const DIM = 384;

/** Build the admin connection URL (default DB) from DATABASE_URL or POSTGRES_* env vars. */
function adminUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  if (!user || !password) {
    throw new Error(
      "Integration tests need DATABASE_URL or POSTGRES_USER/POSTGRES_PASSWORD. " +
        "Set PG_INTEGRATION=1 only with a reachable Postgres (see examples/docker-compose.yml).",
    );
  }
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const db = process.env.POSTGRES_DB ?? "postgres";
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}

/** Parse a connection URL and swap the database name. */
function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** One SQL statement the adapter issued, recorded by the capturing provider. */
export interface CapturedQuery {
  text: string;
  params: unknown[];
}

/** A live test database plus the capturing provider bound to it. */
export interface TestDb {
  sql: postgres.Sql;
  provider: TransactionProvider;
  /** Every statement the adapter has issued since the last reset(). */
  captured: CapturedQuery[];
  /** Clear the capture buffer (call before each driven operation). */
  reset(): void;
}

/**
 * Reserving + capturing TransactionProvider. Each withConnection reserves one pooled connection
 * for its whole callback (required: the search legs apply transaction-local planner GUCs). Every
 * statement is recorded into `captured` before being forwarded unchanged.
 */
function makeProvider(sql: postgres.Sql, captured: CapturedQuery[]): TransactionProvider {
  return {
    async withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
      const reserved = await sql.reserve();
      try {
        const client: SqlClient = {
          async query<R = Record<string, unknown>>(text: string, params: unknown[]): Promise<R[]> {
            captured.push({ text, params });
            const result = await reserved.unsafe(text, params as postgres.MaybeRow[]);
            return result as unknown as R[];
          },
        };
        return await fn(client);
      } finally {
        reserved.release();
      }
    },
  };
}

/** Create a fresh isolated database and return a capturing harness bound to it. */
export async function createTestDb(dbName: string): Promise<TestDb> {
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const sql = postgres(withDatabase(adminUrl(), dbName), { max: 8 });
  const captured: CapturedQuery[] = [];
  return {
    sql,
    provider: makeProvider(sql, captured),
    captured,
    reset() {
      captured.length = 0;
    },
  };
}

/** Tear down a test database (close pool, terminate stragglers, drop). */
export async function dropTestDb(testDb: TestDb, dbName: string): Promise<void> {
  await testDb.sql.end();
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally {
    await admin.end();
  }
}

/** A node in an EXPLAIN (FORMAT JSON) plan tree. */
export interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

/**
 * EXPLAIN a captured statement and return its plan tree, with the planner constrained so the leg's
 * SPECIALIZED index is the only viable access path.
 *
 * Three deliberate choices, inside a transaction that always ROLLBACKs:
 *  - Plain EXPLAIN (no ANALYZE): plans without executing, so EXPLAINing a DELETE is side-effect free.
 *  - `enable_seqscan = off`: penalizes sequential scans (the small-table planner trap — on a tiny
 *    table a Seq Scan is otherwise cheapest, masking whether an index is even usable).
 *  - `hideIndexes` DROP (rolled back): seqscan-off alone is not enough — the planner can still satisfy
 *    the `tenant_id` filter via the general btrees (idx_rag_tenant / idx_rag_source) plus a Sort,
 *    sidestepping the leg's vector/GIN/BM25 index. Dropping those btrees for the duration of the
 *    EXPLAIN removes that escape hatch, so the planner must use the specialized index — or, if the
 *    query shape can't (e.g. a reverted `<%` operator), fall back to a penalized Seq Scan that
 *    `seqScannedRelations` catches. The DROPs are transactional and the final ROLLBACK restores them.
 *    Index names come from the test (trusted constants), so inlining them is safe.
 */
export async function explain(
  sql: postgres.Sql,
  text: string,
  params: unknown[],
  hideIndexes: string[] = [],
): Promise<PlanNode> {
  const reserved = await sql.reserve();
  try {
    await reserved.unsafe("BEGIN");
    await reserved.unsafe("SET LOCAL enable_seqscan = off");
    for (const idx of hideIndexes) {
      await reserved.unsafe(`DROP INDEX IF EXISTS ${idx}`);
    }
    const rows = await reserved.unsafe(
      `EXPLAIN (FORMAT JSON) ${text}`,
      params as postgres.MaybeRow[],
    );
    const raw = (rows[0] as Record<string, unknown>)["QUERY PLAN"];
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
    return parsed[0].Plan;
  } finally {
    // ROLLBACK (not COMMIT) restores any indexes dropped above; EXPLAIN itself has no side effects.
    await reserved.unsafe("ROLLBACK");
    reserved.release();
  }
}

/** Flatten a plan tree into a depth-first node list. */
export function collectNodes(plan: PlanNode): PlanNode[] {
  const out: PlanNode[] = [plan];
  for (const child of plan.Plans ?? []) {
    out.push(...collectNodes(child));
  }
  return out;
}

/** Names of every index referenced anywhere in the plan. */
export function usedIndexes(plan: PlanNode): string[] {
  return collectNodes(plan)
    .map((n) => n["Index Name"])
    .filter((x): x is string => typeof x === "string");
}

/** Relations that were sequentially scanned anywhere in the plan. */
export function seqScannedRelations(plan: PlanNode): string[] {
  return collectNodes(plan)
    .filter((n) => n["Node Type"] === "Seq Scan")
    .map((n) => n["Relation Name"])
    .filter((x): x is string => typeof x === "string");
}

/**
 * Find the single captured statement matching `match`. Throws when zero or many match, so a test
 * fails loudly if the expected leg never ran (rather than silently EXPLAINing the wrong query).
 */
export function pickCaptured(
  captured: CapturedQuery[],
  match: (text: string) => boolean,
): CapturedQuery {
  const hits = captured.filter((q) => match(q.text));
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly 1 captured statement to match, got ${hits.length}. ` +
        `Captured: ${captured.map((q) => q.text.trim().slice(0, 40)).join(" | ")}`,
    );
  }
  return hits[0];
}

/** Build a UUID string from an integer (last 12 hex digits). */
export function uuid(n: number): string {
  return `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Deterministic pseudo-random unit-ish vector. The actual values never affect index CHOICE (only
 * recall), so a seeded LCG keeps plans reproducible without an embedding API.
 */
export function randomVector(seed: number): number[] {
  const v: number[] = [];
  let s = seed >>> 0 || 1;
  for (let i = 0; i < DIM; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v.push((s / 0x7fffffff) * 2 - 1);
  }
  return v;
}

/** Per-language sample word banks — enough lexical variety for realistic planner statistics. */
const WORD_BANK: Record<string, string[]> = {
  en: [
    "wireless",
    "headphones",
    "battery",
    "charging",
    "noise",
    "cancelling",
    "bluetooth",
    "audio",
  ],
  fr: ["casque", "sans", "fil", "batterie", "charge", "bruit", "réduction", "audio"],
  ar: ["سماعات", "لاسلكية", "بطارية", "شحن", "ضوضاء", "إلغاء", "بلوتوث", "صوت"],
  zh: ["无线", "耳机", "电池", "充电", "降噪", "蓝牙", "音频", "手机"],
};

function contentFor(language: string, seed: number): string {
  const bank = WORD_BANK[language] ?? WORD_BANK.en;
  const words: string[] = [];
  let s = seed >>> 0 || 1;
  for (let i = 0; i < 12; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    words.push(bank[s % bank.length]);
  }
  return words.join(language === "zh" ? "" : " ");
}

export interface SeedSpec {
  tenant: string;
  languages: string[];
  rowsPerLanguage: number;
  /** Distinct source ids per language (so the delete predicate is selective). */
  sourcesPerLanguage: number;
}

/**
 * Seed the table via the REAL adapter insert path (exercises the tsvector trigger too), then
 * ANALYZE so the planner has statistics. content_normalized is set to content (identity is fine —
 * index CHOICE does not depend on the normalized text, only relevance does).
 */
export async function seed(testDb: TestDb, spec: SeedSpec): Promise<void> {
  const db = new PostgresRagDatabase(testDb.provider);
  let n = 1;
  for (const language of spec.languages) {
    const chunks = [];
    for (let i = 0; i < spec.rowsPerLanguage; i++) {
      const content = contentFor(language, n);
      chunks.push({
        sourceType: "doc",
        sourceId: uuid(1000 + (i % spec.sourcesPerLanguage)),
        chunkIndex: String(i),
        content,
        contentNormalized: content,
        language,
        embedding: randomVector(n),
        metadata: "{}",
      });
      n++;
    }
    await db.insertChunks(spec.tenant, chunks);
  }
  await testDb.sql.unsafe("ANALYZE rag_documents");
  testDb.reset();
}
