import type { SqlClient, SynonymProvider, TransactionProvider } from "../interfaces.js";
import type { SynonymLookup, SynonymRow } from "../types.js";

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  data: SynonymLookup;
  loadedAt: number;
}

export interface CachingSynonymLoaderConfig {
  txProvider: TransactionProvider;
  /** Optional custom load function. Defaults to querying rag_synonyms. */
  loadFn?: (client: SqlClient, tenantId: string) => Promise<SynonymRow[]>;
}

/**
 * Per-tenant synonym loader with 30-second TTL cache.
 * Supports two-way synonym direction for bidirectional expansion.
 */
export class CachingSynonymLoader implements SynonymProvider {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<SynonymLookup>>();
  private txProvider: TransactionProvider;
  private loadFn: (client: SqlClient, tenantId: string) => Promise<SynonymRow[]>;

  constructor(config: CachingSynonymLoaderConfig) {
    this.txProvider = config.txProvider;
    this.loadFn =
      config.loadFn ??
      ((client, tenantId) =>
        client.query<SynonymRow>(
          `SELECT language, term, synonyms, direction FROM rag_synonyms WHERE tenant_id = $1`,
          [tenantId],
        ));
  }

  async load(tenantId: string): Promise<SynonymLookup> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
      return cached.data;
    }

    const existing = this.inflight.get(tenantId);
    if (existing) return existing;

    const promise = this.txProvider.withConnection(async (client) => {
      const rows = await this.loadFn(client, tenantId);

      const lookup: SynonymLookup = new Map();

      const addMapping = (lang: string, from: string, to: string[]) => {
        if (!lookup.has(lang)) lookup.set(lang, new Map());
        const langMap = lookup.get(lang) ?? new Map();
        lookup.set(lang, langMap);
        const existing = langMap.get(from) ?? [];
        for (const t of to) {
          if (t !== from && !existing.includes(t) && existing.length < 5) {
            existing.push(t);
          }
        }
        langMap.set(from, existing);
      };

      for (const row of rows) {
        const lang = row.language;
        const term = row.term.toLowerCase();
        const rawSyns =
          typeof row.synonyms === "string" ? (JSON.parse(row.synonyms) as string[]) : row.synonyms;
        const syns = rawSyns.map((s) => s.toLowerCase());

        // Forward: term -> synonyms
        addMapping(lang, term, syns);

        // Reverse for two-way: each synonym -> [term]
        if (row.direction === "two_way") {
          for (const syn of syns) {
            addMapping(lang, syn, [term]);
          }
        }
      }

      this.cache.set(tenantId, { data: lookup, loadedAt: Date.now() });
      return lookup;
    });

    this.inflight.set(tenantId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(tenantId);
    }
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
    this.inflight.delete(tenantId);
  }
}
