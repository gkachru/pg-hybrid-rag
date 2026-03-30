/**
 * Example: Running pg-hybrid-rag migrations in a NestJS app.
 *
 * Migrations are idempotent — safe to run on every startup.
 * The library tracks applied migrations in the `_rag_migrations` table.
 *
 * Migration files:
 *   001_extensions.sql      — pgvector + pg_trgm extensions
 *   002_rag_documents.sql   — main documents table
 *   003_hybrid_indexes.sql  — IVFFlat, trigram, and FTS indexes
 *   004_tsvector_trigger.sql — auto-populate tsvector on insert/update
 *   005_stop_words.sql      — per-tenant stop words table
 *   006_synonyms.sql        — per-tenant synonyms table
 *   007_rls_policies.sql    — (optional) row-level security policies
 *   008_postgres_stemming.sql — language-aware FTS config + trigger update
 *   009_cjk_bigm.sql        — (optional) pg_bigm extension for CJK
 */

import { ragMigrate, type SqlClient } from "pg-hybrid-rag";

// --- Prisma SqlClient adapter ---

function createSqlClient(prisma: {
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>;
}): SqlClient {
  return {
    query: async <R = Record<string, unknown>>(sql: string, params: unknown[]): Promise<R[]> => {
      const result = await prisma.$queryRawUnsafe(sql, ...params);
      return result as R[];
    },
  };
}

// --- Migration runner ---

/**
 * Run all pending RAG migrations.
 * Call this once at application startup (e.g. in NestJS onModuleInit).
 *
 * Options:
 *   rls: true  — apply row-level security policies (migration 007)
 *   cjk: true  — install pg_bigm for CJK keyword search (migration 009)
 */
async function runRagMigrations(
  prisma: { $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown> },
  options?: { rls?: boolean; cjk?: boolean },
) {
  const client = createSqlClient(prisma);

  console.log("Running RAG migrations...");
  await ragMigrate(client, options);
  console.log("RAG migrations complete.");
}

export { runRagMigrations, createSqlClient };

// --- Usage in NestJS ---
//
// @Module({})
// export class RagModule implements OnModuleInit {
//   constructor(private prisma: PrismaService) {}
//
//   async onModuleInit() {
//     // Basic setup (most common)
//     await runRagMigrations(this.prisma);
//
//     // With row-level security (multi-tenant with shared DB)
//     // await runRagMigrations(this.prisma, { rls: true });
//
//     // With CJK support (Chinese, Japanese, Korean)
//     // await runRagMigrations(this.prisma, { cjk: true });
//
//     // Both
//     // await runRagMigrations(this.prisma, { rls: true, cjk: true });
//   }
// }
