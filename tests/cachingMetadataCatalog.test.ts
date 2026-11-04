import { describe, expect, it } from "bun:test";
import { CachingMetadataCatalog } from "../src/adapters/CachingMetadataCatalog.js";
import type { SqlClient, TransactionProvider } from "../src/interfaces.js";

interface Call {
  sql: string;
  params: unknown[];
}

function setup(rows: { observed?: unknown[]; values?: unknown[]; registry?: unknown[] } = {}) {
  const calls: Call[] = [];
  const client: SqlClient = {
    query: (async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("row_number()")) return rows.values ?? [];
      if (sql.includes("FROM rag_metadata_registry")) return rows.registry ?? [];
      if (sql.includes("jsonb_array_elements")) return rows.observed ?? [];
      return [];
    }) as SqlClient["query"],
  };
  const txProvider: TransactionProvider = { withConnection: async (fn) => fn(client) };
  return { calls, txProvider };
}

const selects = (calls: Call[]) => calls.filter((c) => c.sql.trimStart().startsWith("SELECT"));

describe("CachingMetadataCatalog.describe", () => {
  it("merges observed + registry, registered keys first, then by ns and key", async () => {
    const { txProvider } = setup({
      observed: [
        { ns: "kx", k: "region", t: "string", f: "enum", article_count: "3" },
        { ns: "global", k: "zeta", t: "boolean", f: null, article_count: 1 },
        { ns: "global", k: "alpha", t: "number", f: "float", article_count: 2 },
        { ns: "kx", k: "region", t: "string", f: null, article_count: 5 },
      ],
      values: [
        { ns: "kx", k: "region", v: "EU", article_count: 2 },
        { ns: "kx", k: "region", v: "US", article_count: 1 },
      ],
      registry: [
        {
          ns: "kx",
          key: "region",
          description: "Sales region",
          type: "string",
          format: "enum",
          multi: true,
          allowed_values: '["EU","US","UK"]',
        },
        {
          ns: "kx",
          key: "unused",
          description: "Never indexed",
          type: null,
          format: null,
          multi: null,
          allowed_values: null,
        },
      ],
    });
    const catalog = await new CachingMetadataCatalog({ txProvider }).describe("t1");
    expect(catalog.tenantId).toBe("t1");
    expect(Number.isNaN(Date.parse(catalog.generatedAt))).toBe(false);
    expect(catalog.keys.map((k) => `${k.ns}.${k.key}`)).toEqual([
      "kx.region",
      "kx.unused",
      "global.alpha",
      "global.zeta",
    ]);
    expect(catalog.keys[0]).toEqual({
      ns: "kx",
      key: "region",
      registered: true,
      description: "Sales region",
      declaredType: "string",
      declaredFormat: "enum",
      multi: true,
      allowedValues: ["EU", "US", "UK"],
      observed: [
        { type: "string", articleCount: 5 },
        { type: "string", format: "enum", articleCount: 3 },
      ],
      topValues: [
        { value: "EU", articleCount: 2 },
        { value: "US", articleCount: 1 },
      ],
    });
    expect(catalog.keys[1]).toEqual({
      ns: "kx",
      key: "unused",
      registered: true,
      description: "Never indexed",
      observed: [],
    });
    expect(catalog.keys[2]).toEqual({
      ns: "global",
      key: "alpha",
      registered: false,
      observed: [{ type: "number", format: "float", articleCount: 2 }],
    });
  });

  it("scopes by tenant, counts distinct articles, and binds topValuesPerKey", async () => {
    const { calls, txProvider } = setup();
    await new CachingMetadataCatalog({ txProvider, topValuesPerKey: 7 }).describe("t1");
    const q = selects(calls);
    expect(q).toHaveLength(3);
    for (const c of q) expect(c.params[0]).toBe("t1");
    const observed = q.find((c) => c.sql.includes("GROUP BY e->>'ns', e->>'k', e->>'t', e->>'f'"));
    expect(observed?.sql).toContain("count(DISTINCT (d.source_type, d.source_id))");
    const top = q.find((c) => c.sql.includes("row_number()"));
    expect(top?.sql).toContain("e->>'t' = 'string'");
    expect(top?.sql).toContain("rn <= $2");
    expect(top?.params).toEqual(["t1", 7]);
  });

  it("serves a second describe within the TTL from cache; invalidate forces a reload", async () => {
    const { calls, txProvider } = setup();
    const catalog = new CachingMetadataCatalog({ txProvider });
    await catalog.describe("t1");
    await catalog.describe("t1");
    expect(selects(calls)).toHaveLength(3);
    catalog.invalidate("t1");
    await catalog.describe("t1");
    expect(selects(calls)).toHaveLength(6);
  });

  it("reloads after the TTL expires", async () => {
    const { calls, txProvider } = setup();
    const catalog = new CachingMetadataCatalog({ txProvider, ttlMs: 5 });
    await catalog.describe("t1");
    await new Promise((r) => setTimeout(r, 15));
    await catalog.describe("t1");
    expect(selects(calls)).toHaveLength(6);
  });

  it("dedups concurrent describes into one query round", async () => {
    const { calls, txProvider } = setup();
    const catalog = new CachingMetadataCatalog({ txProvider });
    await Promise.all([catalog.describe("t1"), catalog.describe("t1")]);
    expect(selects(calls)).toHaveLength(3);
  });

  it("caches per tenant", async () => {
    const { calls, txProvider } = setup();
    const catalog = new CachingMetadataCatalog({ txProvider });
    await catalog.describe("t1");
    await catalog.describe("t2");
    expect(selects(calls)).toHaveLength(6);
  });
});

describe("CachingMetadataCatalog.register / unregister", () => {
  it("upserts with bound parameters, defaults ns to global, then invalidates", async () => {
    const { calls, txProvider } = setup();
    const catalog = new CachingMetadataCatalog({ txProvider });
    await catalog.describe("t1");
    await catalog.register("t1", [
      {
        key: "region",
        description: "Sales region",
        type: "string",
        format: "enum",
        multi: true,
        allowedValues: ["EU", "US"],
      },
    ]);
    const ins = calls.find((c) => c.sql.includes("INSERT INTO rag_metadata_registry"));
    expect(ins?.sql).toContain("ON CONFLICT (tenant_id, ns, key) DO UPDATE");
    expect(ins?.sql).toContain("$2::text::jsonb");
    expect(ins?.params[0]).toBe("t1");
    expect(JSON.parse(ins?.params[1] as string)).toEqual([
      {
        ns: "global",
        key: "region",
        description: "Sales region",
        type: "string",
        format: "enum",
        multi: true,
        allowed_values: ["EU", "US"],
      },
    ]);
    const before = selects(calls).length;
    await catalog.describe("t1");
    expect(selects(calls).length).toBe(before + 3);
  });

  it("never interpolates input into SQL", async () => {
    const { calls, txProvider } = setup();
    await new CachingMetadataCatalog({ txProvider }).register("t1", [
      { key: "x'; DROP TABLE y;--", description: "d" },
    ]);
    expect(calls[0]?.sql).not.toContain("DROP TABLE");
  });

  it("rejects invalid input without touching the database", async () => {
    const { calls, txProvider } = setup();
    const catalog = new CachingMetadataCatalog({ txProvider });
    const bad = [
      { key: "", description: "d" },
      { key: "k", description: "" },
      { key: "k", description: "d", type: "boolean" as const, format: "enum" as const },
      { key: "k", description: "d", format: "text" as const },
      { key: "k", description: "d", multi: true },
      { key: "k", description: "d", type: "number" as const, allowedValues: ["a"] },
      { key: "k", description: "d", allowedValues: [] },
      { key: "k", description: "d", allowedValues: ["a", "a"] },
      { ns: "", key: "k", description: "d" },
    ];
    for (const b of bad) await expect(catalog.register("t1", [b])).rejects.toThrow(/Invalid/);
    await expect(
      catalog.register("t1", [
        { key: "k", description: "d" },
        { ns: "global", key: "k", description: "d2" },
      ]),
    ).rejects.toThrow(/duplicate/);
    expect(calls).toHaveLength(0);
  });

  it("unregister deletes by (ns, key), defaults ns, and invalidates", async () => {
    const { calls, txProvider } = setup();
    const catalog = new CachingMetadataCatalog({ txProvider });
    await catalog.describe("t1");
    await catalog.unregister("t1", [{ key: "a" }, { ns: "kx", key: "b" }]);
    const del = calls.find((c) => c.sql.includes("DELETE FROM rag_metadata_registry"));
    expect(del?.params[0]).toBe("t1");
    expect(JSON.parse(del?.params[1] as string)).toEqual([
      { ns: "global", key: "a" },
      { ns: "kx", key: "b" },
    ]);
    const before = selects(calls).length;
    await catalog.describe("t1");
    expect(selects(calls).length).toBe(before + 3);
  });
});
