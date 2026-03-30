import type { SqlClient, StopWordsProvider, TransactionProvider } from "../interfaces.js";
import type { StopWordRow } from "../types.js";

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  data: Map<string, Set<string>>;
  loadedAt: number;
}

export interface CachingStopWordsLoaderConfig {
  txProvider: TransactionProvider;
  /** Optional custom load function. Defaults to querying rag_stop_words. */
  loadFn?: (client: SqlClient, tenantId: string) => Promise<StopWordRow[]>;
}

/**
 * Per-tenant stop words loader with 30-second TTL cache.
 * Uses a configurable load function or defaults to querying rag_stop_words.
 */
export class CachingStopWordsLoader implements StopWordsProvider {
  private cache = new Map<string, CacheEntry>();
  private mergedCache = new Map<string, { data: Set<string>; loadedAt: number }>();
  private inflight = new Map<string, Promise<Map<string, Set<string>>>>();
  private inflightMerged = new Map<string, Promise<Set<string>>>();
  private txProvider: TransactionProvider;
  private loadFn: (client: SqlClient, tenantId: string) => Promise<StopWordRow[]>;

  constructor(config: CachingStopWordsLoaderConfig) {
    this.txProvider = config.txProvider;
    this.loadFn =
      config.loadFn ??
      ((client, tenantId) =>
        client.query<StopWordRow>(
          `SELECT language, word FROM rag_stop_words WHERE tenant_id = $1`,
          [tenantId],
        ));
  }

  async load(tenantId: string): Promise<Map<string, Set<string>>> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
      return cached.data;
    }

    const existing = this.inflight.get(tenantId);
    if (existing) return existing;

    const promise = this.txProvider.withConnection(async (client) => {
      const rows = await this.loadFn(client, tenantId);

      const map = new Map<string, Set<string>>();
      for (const row of rows) {
        if (!map.has(row.language)) map.set(row.language, new Set());
        map.get(row.language)?.add(row.word.toLowerCase());
      }

      this.cache.set(tenantId, { data: map, loadedAt: Date.now() });
      return map;
    });

    this.inflight.set(tenantId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(tenantId);
    }
  }

  /** Load all stop words merged across languages into a single Set (cached). */
  async loadMerged(tenantId: string): Promise<Set<string>> {
    const cached = this.mergedCache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
      return cached.data;
    }

    const existing = this.inflightMerged.get(tenantId);
    if (existing) return existing;

    const promise = (async () => {
      const map = await this.load(tenantId);
      const merged = new Set<string>();
      for (const words of map.values()) {
        for (const w of words) merged.add(w);
      }
      this.mergedCache.set(tenantId, { data: merged, loadedAt: Date.now() });
      return merged;
    })();

    this.inflightMerged.set(tenantId, promise);
    try {
      return await promise;
    } finally {
      this.inflightMerged.delete(tenantId);
    }
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
    this.mergedCache.delete(tenantId);
    this.inflight.delete(tenantId);
    this.inflightMerged.delete(tenantId);
  }
}
