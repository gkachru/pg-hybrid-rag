import type { MetadataCatalogProvider, SqlClient, TransactionProvider } from "../interfaces.js";
import { checkKeyShape, GLOBAL_NS } from "../metadata/attributes.js";
import type {
  AttributeFormat,
  AttributeType,
  CatalogKey,
  MetadataCatalog,
  RegisteredKeyInput,
} from "../types.js";

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_TOP_VALUES = 20;

export interface CachingMetadataCatalogConfig {
  txProvider: TransactionProvider;
  /** Cache lifetime per tenant. Default 300_000 (5 min). */
  ttlMs?: number;
  /** Max most-common string values reported per key. Default 20. */
  topValuesPerKey?: number;
}

interface ObservedRow {
  ns: string;
  k: string;
  t: AttributeType;
  f: AttributeFormat | null;
  article_count: number | string;
}

interface ValueRow {
  ns: string;
  k: string;
  v: string;
  article_count: number | string;
}

interface RegistryRow {
  ns: string;
  key: string;
  description: string;
  type: AttributeType | null;
  format: AttributeFormat | null;
  multi: boolean | null;
  allowed_values: unknown;
}

// Articles are (source_type, source_id); an article has many chunk rows, so count distinct pairs.
const OBSERVED_SQL = `SELECT e->>'ns' AS ns, e->>'k' AS k, e->>'t' AS t, e->>'f' AS f,
       count(DISTINCT (d.source_type, d.source_id)) AS article_count
FROM rag_documents d, jsonb_array_elements(d.attributes) e
WHERE d.tenant_id = $1
GROUP BY e->>'ns', e->>'k', e->>'t', e->>'f'`;

const TOP_VALUES_SQL = `SELECT ns, k, v, article_count FROM (
  SELECT e->>'ns' AS ns, e->>'k' AS k, e->>'v' AS v,
         count(DISTINCT (d.source_type, d.source_id)) AS article_count,
         row_number() OVER (
           PARTITION BY e->>'ns', e->>'k'
           ORDER BY count(DISTINCT (d.source_type, d.source_id)) DESC, e->>'v'
         ) AS rn
  FROM rag_documents d, jsonb_array_elements(d.attributes) e
  WHERE d.tenant_id = $1 AND e->>'t' = 'string'
  GROUP BY e->>'ns', e->>'k', e->>'v'
) ranked
WHERE rn <= $2
ORDER BY ns, k, rn`;

const REGISTRY_SQL = `SELECT ns, key, description, type, format, multi, allowed_values
FROM rag_metadata_registry WHERE tenant_id = $1`;

// JSON is bound as text and cast via ::text::jsonb: some drivers JSON-stringify a string bound
// straight to a jsonb parameter, double-encoding it.
const REGISTER_SQL = `INSERT INTO rag_metadata_registry
  (tenant_id, ns, key, description, type, format, multi, allowed_values, updated_at)
SELECT $1::uuid, x.ns, x.key, x.description, x.type, x.format, x.multi, x.allowed_values, NOW()
FROM jsonb_to_recordset($2::text::jsonb) AS x(
  ns text, key text, description text, type text, format text, multi boolean, allowed_values jsonb
)
ON CONFLICT (tenant_id, ns, key) DO UPDATE SET
  description = EXCLUDED.description,
  type = EXCLUDED.type,
  format = EXCLUDED.format,
  multi = EXCLUDED.multi,
  allowed_values = EXCLUDED.allowed_values,
  updated_at = NOW()`;

const UNREGISTER_SQL = `DELETE FROM rag_metadata_registry
WHERE tenant_id = $1
  AND (ns, key) IN (
    SELECT x.ns, x.key FROM jsonb_to_recordset($2::text::jsonb) AS x(ns text, key text)
  )`;

const idOf = (ns: string, key: string) => JSON.stringify([ns, key]);

function parseAllowed(raw: unknown): string[] | undefined {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/** Throws on invalid registry input, reusing the attribute ns/key/type/format rules. */
function validateRegistration(keys: RegisteredKeyInput[]): Array<Record<string, unknown>> {
  const issues: string[] = [];
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  keys.forEach((k, i) => {
    const label = `registry[${i}]`;
    const ns = k.ns ?? GLOBAL_NS;
    const before = issues.length;
    issues.push(...checkKeyShape(label, ns, k.key, k.type, k.format, k.multi));
    if (typeof k.description !== "string" || k.description.trim().length === 0) {
      issues.push(`${label}: description must be a non-empty string`);
    }
    if (k.allowedValues !== undefined) {
      if (k.type !== undefined && k.type !== "string") {
        issues.push(`${label}: allowedValues is only valid for string keys`);
      } else if (
        !Array.isArray(k.allowedValues) ||
        k.allowedValues.length === 0 ||
        k.allowedValues.some((v) => typeof v !== "string") ||
        new Set(k.allowedValues).size !== k.allowedValues.length
      ) {
        issues.push(`${label}: allowedValues must be a non-empty list of unique strings`);
      }
    }
    if (issues.length > before) return;
    const id = idOf(ns, k.key);
    if (seen.has(id)) {
      issues.push(`${label}: duplicate key ${ns}/${k.key}`);
      return;
    }
    seen.add(id);
    rows.push({
      ns,
      key: k.key,
      description: k.description,
      type: k.type ?? null,
      format: k.format ?? null,
      multi: k.multi ?? null,
      allowed_values: k.allowedValues ?? null,
    });
  });
  if (issues.length > 0) {
    throw new Error(`Invalid registry keys: ${issues.join("; ")}`);
  }
  return rows;
}

/**
 * Per-tenant metadata catalog: keys observed in indexed attributes merged with the
 * integrator's registry (descriptions, allowed values). TTL-cached with in-flight dedup.
 */
export class CachingMetadataCatalog implements MetadataCatalogProvider {
  private cache = new Map<string, { data: MetadataCatalog; loadedAt: number }>();
  private inflight = new Map<string, Promise<MetadataCatalog>>();
  /** Bumped on invalidate so a load already in flight cannot repopulate the cache with stale data. */
  private generation = new Map<string, number>();
  private txProvider: TransactionProvider;
  private ttlMs: number;
  private topValuesPerKey: number;

  constructor(config: CachingMetadataCatalogConfig) {
    this.txProvider = config.txProvider;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.topValuesPerKey = config.topValuesPerKey ?? DEFAULT_TOP_VALUES;
  }

  async describe(tenantId: string): Promise<MetadataCatalog> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < this.ttlMs) return cached.data;

    const existing = this.inflight.get(tenantId);
    if (existing) return existing;

    const gen = this.generation.get(tenantId) ?? 0;
    const promise = this.txProvider.withConnection(async (client) => {
      const data = await this.load(client, tenantId);
      if ((this.generation.get(tenantId) ?? 0) === gen) {
        this.cache.set(tenantId, { data, loadedAt: Date.now() });
      }
      return data;
    });

    this.inflight.set(tenantId, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(tenantId) === promise) this.inflight.delete(tenantId);
    }
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
    this.inflight.delete(tenantId);
    this.generation.set(tenantId, (this.generation.get(tenantId) ?? 0) + 1);
  }

  /** Upsert registry entries for a tenant, then drop the cached catalog. */
  async register(tenantId: string, keys: RegisteredKeyInput[]): Promise<void> {
    if (keys.length === 0) return;
    const rows = validateRegistration(keys);
    await this.txProvider.withConnection((client) =>
      client.query(REGISTER_SQL, [tenantId, JSON.stringify(rows)]),
    );
    this.invalidate(tenantId);
  }

  /** Remove registry entries (observed keys stay visible, as unregistered). */
  async unregister(tenantId: string, keys: Array<{ ns?: string; key: string }>): Promise<void> {
    if (keys.length === 0) return;
    const rows = keys.map((k) => ({ ns: k.ns ?? GLOBAL_NS, key: k.key }));
    await this.txProvider.withConnection((client) =>
      client.query(UNREGISTER_SQL, [tenantId, JSON.stringify(rows)]),
    );
    this.invalidate(tenantId);
  }

  private async load(client: SqlClient, tenantId: string): Promise<MetadataCatalog> {
    const observedRows = await client.query<ObservedRow>(OBSERVED_SQL, [tenantId]);
    const valueRows = await client.query<ValueRow>(TOP_VALUES_SQL, [
      tenantId,
      this.topValuesPerKey,
    ]);
    const registryRows = await client.query<RegistryRow>(REGISTRY_SQL, [tenantId]);

    const byId = new Map<string, CatalogKey>();
    const get = (ns: string, key: string): CatalogKey => {
      const id = idOf(ns, key);
      let ck = byId.get(id);
      if (!ck) {
        ck = { ns, key, registered: false, observed: [] };
        byId.set(id, ck);
      }
      return ck;
    };

    for (const r of registryRows) {
      const ck = get(r.ns, r.key);
      ck.registered = true;
      ck.description = r.description;
      if (r.type) ck.declaredType = r.type;
      if (r.format) ck.declaredFormat = r.format;
      if (r.multi !== null && r.multi !== undefined) ck.multi = r.multi;
      const allowed = parseAllowed(r.allowed_values);
      if (allowed) ck.allowedValues = allowed;
    }
    for (const r of observedRows) {
      const entry: CatalogKey["observed"][number] = {
        type: r.t,
        articleCount: Number(r.article_count),
      };
      if (r.f) entry.format = r.f;
      get(r.ns, r.k).observed.push(entry);
    }
    for (const r of valueRows) {
      const ck = get(r.ns, r.k);
      if (!ck.topValues) ck.topValues = [];
      ck.topValues.push({ value: r.v, articleCount: Number(r.article_count) });
    }

    const keys = [...byId.values()];
    for (const k of keys) {
      k.observed.sort(
        (a, b) =>
          b.articleCount - a.articleCount ||
          a.type.localeCompare(b.type) ||
          (a.format ?? "").localeCompare(b.format ?? ""),
      );
    }
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    keys.sort(
      (a, b) => Number(b.registered) - Number(a.registered) || cmp(a.ns, b.ns) || cmp(a.key, b.key),
    );

    return { tenantId, generatedAt: new Date().toISOString(), keys };
  }
}
