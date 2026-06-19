/**
 * Benchmark infra wiring — DB lifecycle, adapter, embedder, reranker, logger.
 *
 * Exports standalone functions/values the benchmark runner imports to set up
 * and tear down its isolated database and all provider adapters.
 *
 * Wiring is copied from examples/playground.ts (intentional duplication — no
 * shared module so playground.ts is unaffected by benchmark changes).
 */

import postgres from "postgres";
import {
  type EmbeddingProvider,
  OpenAiCompatibleEmbedder,
  type RagResult,
  type RerankerProvider,
  type SqlClient,
  type TransactionProvider,
} from "../../src/index.js";

// ── Config helpers ──────────────────────────────────────────────────────────

export function buildDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const db = process.env.POSTGRES_DB;
  if (!user || !password || !db) {
    console.error("Missing required env vars: POSTGRES_USER/PASSWORD/DB (or DATABASE_URL)");
    process.exit(1);
  }
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}

/** Parse a PostgreSQL URL and replace the database name. */
export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

// ── DB bootstrap ────────────────────────────────────────────────────────────

// dbName must be a safe SQL identifier — the caller sanitizes it (admin DDL can't be parameterized).
/** Connect to adminUrl, drop (if exists) and re-create dbName. */
export async function createDatabase(adminUrl: string, dbName: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1 });
  // Drop if leftover from a previous failed run
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
}

// dbName must be a safe SQL identifier — the caller sanitizes it (admin DDL can't be parameterized).
/** Connect to adminUrl, terminate lingering connections, then drop dbName. */
export async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1 });
  // Terminate any lingering connections
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
  );
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
}

// ── Postgres adapter (postgres.js → SqlClient/TransactionProvider) ──────────

export function createAdapter(sql: postgres.Sql): {
  txProvider: TransactionProvider;
  migrationProvider: TransactionProvider;
  sql: postgres.Sql;
} {
  // Every withConnection reserves one pooled connection for the duration of the
  // callback, so all of its queries share a single session. Both consumers require it:
  //   - search legs apply transaction-local planner GUCs via BEGIN/set_config/COMMIT
  //   - migrations run each file's statements + its tracking-row insert atomically
  // postgres.js rejects a raw BEGIN on a pooled (max>1) connection that isn't reserved,
  // so a non-reserving provider would fail the first search leg with UNSAFE_TRANSACTION.
  const reservingProvider: TransactionProvider = {
    async withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
      const reserved = await sql.reserve();
      try {
        const client: SqlClient = {
          async query<R = Record<string, unknown>>(text: string, params: unknown[]): Promise<R[]> {
            const result = await reserved.unsafe(text, params as postgres.MaybeRow[]);
            return result as R[];
          },
        };
        return await fn(client);
      } finally {
        reserved.release();
      }
    },
  };

  return { txProvider: reservingProvider, migrationProvider: reservingProvider, sql };
}

// ── Embedder ────────────────────────────────────────────────────────────────

/** Create an embedder from env vars. Throws if any required var is missing. */
export function createEmbedder(): EmbeddingProvider {
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  const apiKey = process.env.EMBEDDING_API_KEY ?? process.env.LLM_API_KEY;
  const model = process.env.EMBEDDING_MODEL;

  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "Missing required env vars: EMBEDDING_BASE_URL, EMBEDDING_API_KEY (or LLM_API_KEY), EMBEDDING_MODEL",
    );
  }

  // Many TEI-style embedding servers cap the request batch (often 8); the default 32 triggers
  // HTTP 422 on a real corpus. Default to 8 (override via EMBEDDING_BATCH_SIZE), with modest
  // concurrency so indexing 1000+ chunks isn't fully serial.
  const envBatch = Number(process.env.EMBEDDING_BATCH_SIZE);
  const batchSize = Number.isFinite(envBatch) && envBatch > 0 ? envBatch : 8;
  return new OpenAiCompatibleEmbedder({ baseUrl, apiKey, model, batchSize, concurrency: 4 });
}

// ── Reranker (optional) ─────────────────────────────────────────────────────
// HuggingFace TEI cross-encoder /rerank endpoint. Enabled when RERANKER_BASE_URL
// is set. The cross-encoder reads candidate text directly — it does not use
// embeddings, so it is independent of the embedding model above.

// TEI caps texts per /rerank call (its `max_client_batch_size`, often 8). Sending more
// returns HTTP 422, which surfaces as a reranker failure → silent fallback to RRF order.
// So split candidates into batches, score each, and merge by original index.
const RERANK_BATCH_SIZE = 8;

/**
 * Create a TEI /rerank batched reranker from env vars.
 * Returns undefined if RERANKER_BASE_URL is not set.
 */
export function createReranker(): RerankerProvider | undefined {
  const baseUrl = process.env.RERANKER_BASE_URL;
  const apiKey = process.env.RERANKER_API_KEY;

  if (!baseUrl) return undefined;

  // Returns scores aligned to the input `texts` order.
  async function scoreBatch(query: string, texts: string[]): Promise<number[]> {
    const res = await fetch(`${baseUrl}/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ query, texts, truncate: true }),
    });
    if (!res.ok) throw new Error(`Reranker error ${res.status}`);
    const ranked = (await res.json()) as Array<{ index: number; score: number }>;
    const scores = new Array<number>(texts.length).fill(0);
    for (const { index, score } of ranked) scores[index] = score;
    return scores;
  }

  return {
    async rerank(query, results, topN) {
      const batches: RagResult[][] = [];
      for (let i = 0; i < results.length; i += RERANK_BATCH_SIZE) {
        batches.push(results.slice(i, i + RERANK_BATCH_SIZE));
      }
      const batchScores = await Promise.all(
        batches.map((batch) =>
          scoreBatch(
            query,
            batch.map((r) => r.content),
          ),
        ),
      );
      return batches
        .flatMap((batch, bi) => batch.map((r, j) => ({ ...r, score: batchScores[bi][j] })))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);
    },
  };
}

// ── Logger (simple console) ─────────────────────────────────────────────────

export const logger = {
  debug: (obj: Record<string, unknown>, msg: string) => console.log("  [debug]", msg, obj),
  info: (obj: Record<string, unknown>, msg: string) => console.log("  [info]", msg, obj),
  warn: (obj: Record<string, unknown>, msg: string) => console.warn("  [warn]", msg, obj),
};

// ── Constants ───────────────────────────────────────────────────────────────

export const TENANT_ID = "00000000-0000-0000-0000-000000000099";
