/**
 * Attribute-filter integration tests against a REAL Postgres: every assertion runs a real
 * `RagPipeline.search` (all three legs) through the adapter and checks the returned article ids.
 * Also EXPLAINs each leg with a filter applied to prove it still uses its own index.
 *
 * Gated by PG_INTEGRATION=1 (see indexUsage.test.ts for how to bring the DB up).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AttributeInput,
  Bm25Fts,
  CachingMetadataCatalog,
  type EmbeddingProvider,
  type FilterExpression,
  normalizeAttributes,
  PostgresRagDatabase,
  RagPipeline,
  ragMigrate,
  serializeAttributes,
} from "../../src/index.js";
import {
  createTestDb,
  dropTestDb,
  explain,
  pickCaptured,
  RUN_INTEGRATION,
  randomVector,
  SQL_DIR,
  seed,
  seqScannedRelations,
  type TestDb,
  usedIndexes,
  uuid,
} from "./pgHarness.js";

const TENANT = uuid(1);
const CONTENT = "wireless headphones battery charging";

const embedder: EmbeddingProvider = {
  embedQuery: async () => randomVector(7),
  embedDocuments: async (texts) => texts.map((_, i) => randomVector(100 + i)),
};

// Article ids (source ids). Names mirror the corpus description in the task brief.
const A = uuid(101); // EU+UK, 2024-03-15, huge decimal, "İstanbul ops", vip
const B = uuid(102); // US, 2025-01-01, -5.5, "Straße team", not vip
const C = uuid(103); // EU, 2023-12-31, 99.99, Arabic team, vip
const D = uuid(104); // Thai team, datetime with +05:30 offset, float 3.5
const E = uuid(105); // Confluence-namespace effective_date as a string
const F = uuid(106); // metacharacter values
const U1 = uuid(107); // untagged
const U2 = uuid(108); // untagged
const ALL = [A, B, C, D, E, F, U1, U2].sort();

const HUGE = "12345678901234567890.123";
const ARABIC_TEAM = "فريق الدعم";
const THAI_TEAM = "ทีมบริการ";
const META_VALUES = ["100%_done", "it's", 'say "hi"', "back\\slash", "$1", ")--"];

const kx = (a: Omit<AttributeInput, "ns">): AttributeInput => ({ ns: "kx", ...a });

const CORPUS: Array<{ id: string; attrs: AttributeInput[] }> = [
  {
    id: A,
    attrs: [
      kx({ key: "region", type: "string", format: "enum", multi: true, value: ["EU", "UK"] }),
      kx({ key: "effective_date", type: "date", value: "2024-03-15" }),
      kx({ key: "price", type: "number", format: "decimal", value: HUGE }),
      kx({ key: "team", type: "string", value: "İstanbul ops" }),
      kx({ key: "vip", type: "boolean", value: true }),
    ],
  },
  {
    id: B,
    attrs: [
      kx({ key: "region", type: "string", format: "enum", multi: true, value: ["US"] }),
      kx({ key: "effective_date", type: "date", value: "2025-01-01" }),
      kx({ key: "price", type: "number", format: "decimal", value: "-5.5" }),
      kx({ key: "team", type: "string", value: "Straße team" }),
      kx({ key: "vip", type: "boolean", value: false }),
    ],
  },
  {
    id: C,
    attrs: [
      kx({ key: "region", type: "string", format: "enum", multi: true, value: ["EU"] }),
      kx({ key: "effective_date", type: "date", value: "2023-12-31" }),
      kx({ key: "price", type: "number", format: "decimal", value: "99.99" }),
      kx({ key: "team", type: "string", value: ARABIC_TEAM }),
      kx({ key: "vip", type: "boolean", value: true }),
    ],
  },
  {
    id: D,
    attrs: [
      kx({ key: "team", type: "string", value: THAI_TEAM }),
      kx({ key: "published", type: "datetime", value: "2024-06-01T10:00:00+05:30" }),
      kx({ key: "price", type: "number", format: "float", value: 3.5 }),
    ],
  },
  {
    id: E,
    attrs: [
      {
        ns: "confluence",
        key: "effective_date",
        type: "string",
        value: "2024-03-15",
      },
    ],
  },
  {
    id: F,
    attrs: [{ ns: "kx", key: "note", type: "string", value: META_VALUES }],
  },
  { id: U1, attrs: [] },
  { id: U2, attrs: [] },
];

function toChunk(id: string, attrs: AttributeInput[], n: number, content = CONTENT) {
  return {
    sourceType: "doc",
    sourceId: id,
    chunkIndex: "0",
    content,
    contentNormalized: content,
    language: "en",
    embedding: randomVector(n),
    metadata: "{}",
    attributes: serializeAttributes(normalizeAttributes(attrs)),
  };
}

async function seedCorpus(db: PostgresRagDatabase) {
  let n = 1;
  for (const a of CORPUS) {
    await db.insertChunks(TENANT, [toChunk(a.id, a.attrs, n++)]);
  }
}

/** Ids of the articles a filtered search returns (sorted, de-duplicated). */
async function ids(pipeline: RagPipeline, filter?: FilterExpression): Promise<string[]> {
  const results = await pipeline.search("wireless headphones", {
    language: "en",
    topK: 50,
    vectorMinScore: -1,
    keywordMinScore: 0.05,
    filter,
  });
  return [...new Set(results.map((r) => r.sourceId as string))].sort();
}

const sorted = (...x: string[]) => [...x].sort();

function suite(
  title: string,
  dbName: string,
  migrate: { cjk?: boolean; bm25?: boolean; vectorchord?: boolean },
  makeDb: (t: TestDb) => PostgresRagDatabase,
) {
  describe.skipIf(!RUN_INTEGRATION)(title, () => {
    let testDb: TestDb;
    let pipeline: RagPipeline;

    beforeAll(async () => {
      testDb = await createTestDb(dbName);
      await ragMigrate(testDb.provider, { sqlDir: SQL_DIR, ...migrate });
      const db = makeDb(testDb);
      await seedCorpus(db);
      await testDb.sql.unsafe("ANALYZE rag_documents");
      pipeline = new RagPipeline({ tenantId: TENANT, db, embedder });
    });
    afterAll(async () => {
      await dropTestDb(testDb, dbName);
    });

    test("catalog: counts articles (not chunks) and merges registry", async () => {
      // A second chunk for article A must not change the article count.
      const extra = new PostgresRagDatabase(testDb.provider);
      await extra.insertChunks(TENANT, [
        { ...toChunk(A, CORPUS[0]?.attrs ?? [], 900), chunkIndex: "1" },
      ]);
      const catalog = new CachingMetadataCatalog({ txProvider: testDb.provider });
      const before = await catalog.describe(TENANT);
      const region = before.keys.find((k) => k.ns === "kx" && k.key === "region");
      expect(region?.registered).toBe(false);
      expect(region?.observed[0]?.articleCount).toBe(3); // A, B, C
      expect(region?.topValues?.map((v) => v.value)).toContain("EU");
      expect(region?.topValues?.find((v) => v.value === "EU")?.articleCount).toBe(2);

      await catalog.register(TENANT, [
        {
          ns: "kx",
          key: "region",
          description: "Sales region",
          type: "string",
          format: "enum",
          multi: true,
          allowedValues: ["EU", "UK", "US"],
        },
        { ns: "kx", key: "never_indexed", description: "Registered only" },
      ]);
      const after = await catalog.describe(TENANT);
      expect(after.keys[0]?.registered).toBe(true);
      const merged = after.keys.find((k) => k.ns === "kx" && k.key === "region");
      expect(merged?.description).toBe("Sales region");
      expect(merged?.allowedValues).toEqual(["EU", "UK", "US"]);
      expect(merged?.observed[0]?.articleCount).toBe(3);
      expect(after.keys.find((k) => k.key === "never_indexed")?.observed).toEqual([]);

      await catalog.unregister(TENANT, [{ ns: "kx", key: "never_indexed" }]);
      expect((await catalog.describe(TENANT)).keys.some((k) => k.key === "never_indexed")).toBe(
        false,
      );
      await testDb.sql.unsafe("DELETE FROM rag_metadata_registry");
      await testDb.sql.unsafe(
        "DELETE FROM rag_documents WHERE source_id = $1 AND chunk_index = '1'",
        [A],
      );
    });

    test("catalog: per-article collapse keeps exact counts (multi-chunk, multi-valued, differing chunks)", async () => {
      const T2 = uuid(2);
      const db2 = new PostgresRagDatabase(testDb.provider);
      const region = (value: string[]) =>
        kx({ key: "region", type: "string", format: "enum", multi: true, value });
      const tier = (value: string) => kx({ key: "tier", type: "string", value });
      const size = kx({ key: "size", type: "number", format: "float", value: 5 });
      const P = uuid(201); // 3 identical chunks, multi-valued region
      const Q = uuid(202); // 2 identical chunks
      const R = uuid(203); // chunks differ
      const S = uuid(204); // untagged
      const chunk = (id: string, i: number, attrs: AttributeInput[], n: number) => ({
        ...toChunk(id, attrs, n),
        chunkIndex: String(i),
      });
      await db2.insertChunks(T2, [
        chunk(P, 0, [region(["EU", "UK"]), tier("gold"), size], 1),
        chunk(P, 1, [region(["EU", "UK"]), tier("gold"), size], 2),
        chunk(P, 2, [region(["EU", "UK"]), tier("gold"), size], 3),
        chunk(Q, 0, [region(["EU"]), tier("gold")], 4),
        chunk(Q, 1, [region(["EU"]), tier("gold")], 5),
        chunk(R, 0, [region(["US"])], 6),
        chunk(R, 1, [region(["EU"]), tier("silver")], 7),
        chunk(S, 0, [], 8),
      ]);
      try {
        const cat = await new CachingMetadataCatalog({ txProvider: testDb.provider }).describe(T2);
        const get = (key: string) => cat.keys.find((k) => k.ns === "kx" && k.key === key);
        expect(cat.keys.map((k) => k.key)).toEqual(["region", "size", "tier"]);
        // Distinct articles per key: region P,Q,R = 3; tier P,Q,R = 3; size P = 1.
        expect(get("region")?.observed).toEqual([
          { type: "string", format: "enum", articleCount: 3 },
        ]);
        expect(get("tier")?.observed).toEqual([{ type: "string", articleCount: 3 }]);
        expect(get("size")?.observed).toEqual([
          { type: "number", format: "float", articleCount: 1 },
        ]);
        // Ordered by count DESC then value: EU (P,Q,R)=3, UK (P)=1, US (R)=1.
        expect(get("region")?.topValues).toEqual([
          { value: "EU", articleCount: 3 },
          { value: "UK", articleCount: 1 },
          { value: "US", articleCount: 1 },
        ]);
        expect(get("tier")?.topValues).toEqual([
          { value: "gold", articleCount: 2 },
          { value: "silver", articleCount: 1 },
        ]);
        expect(get("size")?.topValues).toBeUndefined(); // non-string keys have no top values
      } finally {
        await testDb.sql.unsafe("DELETE FROM rag_documents WHERE tenant_id = $1", [T2]);
      }
    });

    test("baseline: no filter returns every article, including untagged", async () => {
      expect(await ids(pipeline)).toEqual(ALL);
    });

    describe("operators x types", () => {
      test("string equals is case-insensitive by default", async () => {
        expect(await ids(pipeline, { key: "team", op: "equals", value: "ISTANBUL OPS" })).toEqual(
          [],
        ); // "İ" lowercases to "i̇" (i + U+0307), so plain ASCII does not match
        expect(await ids(pipeline, { key: "team", op: "equals", value: "STRASSE TEAM" })).toEqual(
          [],
        ); // toLowerCase never maps ß to ss
        expect(await ids(pipeline, { key: "team", op: "equals", value: "STRAßE TEAM" })).toEqual([
          B,
        ]);
      });

      test("non-ASCII values match themselves case-insensitively", async () => {
        expect(await ids(pipeline, { key: "team", op: "equals", value: "İstanbul ops" })).toEqual([
          A,
        ]);
        expect(await ids(pipeline, { key: "team", op: "equals", value: "İSTANBUL OPS" })).toEqual([
          A,
        ]);
        expect(await ids(pipeline, { key: "team", op: "equals", value: "straße team" })).toEqual([
          B,
        ]);
        expect(await ids(pipeline, { key: "team", op: "equals", value: ARABIC_TEAM })).toEqual([C]);
        expect(await ids(pipeline, { key: "team", op: "equals", value: THAI_TEAM })).toEqual([D]);
      });

      test("equals list form is an OR over the values", async () => {
        expect(
          await ids(pipeline, { key: "team", op: "equals", value: ["istanbul", ARABIC_TEAM] }),
        ).toEqual([C]);
        expect(
          await ids(pipeline, {
            key: "team",
            op: "equals",
            value: ["İstanbul ops", ARABIC_TEAM, "nobody"],
          }),
        ).toEqual(sorted(A, C));
      });

      test("multi enum equals matches any member", async () => {
        expect(await ids(pipeline, { key: "region", op: "equals", value: "EU" })).toEqual(
          sorted(A, C),
        );
        expect(await ids(pipeline, { key: "region", op: "equals", value: "UK" })).toEqual([A]);
        expect(await ids(pipeline, { key: "region", op: "equals", value: ["US", "UK"] })).toEqual(
          sorted(A, B),
        );
      });

      test("startsWith / endsWith / contains", async () => {
        expect(await ids(pipeline, { key: "team", op: "startsWith", value: "straße" })).toEqual([
          B,
        ]);
        expect(await ids(pipeline, { key: "team", op: "endsWith", value: "OPS" })).toEqual([A]);
        expect(await ids(pipeline, { key: "team", op: "endsWith", value: " team" })).toEqual([B]);
        expect(await ids(pipeline, { key: "team", op: "contains", value: "tanb" })).toEqual([A]);
        expect(await ids(pipeline, { key: "team", op: "contains", value: "الدعم" })).toEqual([C]);
        expect(await ids(pipeline, { key: "team", op: "startsWith", value: "ทีม" })).toEqual([D]);
        expect(await ids(pipeline, { key: "team", op: "contains", value: "zzz" })).toEqual([]);
      });

      test("caseSensitive", async () => {
        expect(
          await ids(pipeline, {
            key: "team",
            op: "equals",
            value: "İstanbul ops",
            caseSensitive: true,
          }),
        ).toEqual([A]);
        expect(
          await ids(pipeline, {
            key: "team",
            op: "equals",
            value: "İSTANBUL OPS",
            caseSensitive: true,
          }),
        ).toEqual([]);
        expect(
          await ids(pipeline, {
            key: "team",
            op: "startsWith",
            value: "Stra",
            caseSensitive: true,
          }),
        ).toEqual([B]);
        expect(
          await ids(pipeline, {
            key: "team",
            op: "startsWith",
            value: "stra",
            caseSensitive: true,
          }),
        ).toEqual([]);
        expect(
          await ids(pipeline, { key: "team", op: "endsWith", value: "ops", caseSensitive: true }),
        ).toEqual([A]);
        expect(
          await ids(pipeline, { key: "team", op: "contains", value: "OPS", caseSensitive: true }),
        ).toEqual([]);
      });

      test("number ranges with decimals, negatives and beyond-float precision", async () => {
        expect(await ids(pipeline, { key: "price", op: "gt", value: 0 })).toEqual(sorted(A, C, D));
        expect(await ids(pipeline, { key: "price", op: "lt", value: 0 })).toEqual([B]);
        expect(
          await ids(pipeline, { key: "price", op: "gte", value: "-5.5", type: "number" }),
        ).toEqual(sorted(A, B, C, D));
        expect(
          await ids(pipeline, { key: "price", op: "gt", value: "-5.5", type: "number" }),
        ).toEqual(sorted(A, C, D));
        expect(await ids(pipeline, { key: "price", op: "between", value: [3, 100] })).toEqual(
          sorted(C, D),
        );
        // Precision a float cannot hold: ...122 < ...123 < ...124.
        expect(
          await ids(pipeline, {
            key: "price",
            op: "gt",
            value: "12345678901234567890.122",
            type: "number",
          }),
        ).toEqual([A]);
        expect(
          await ids(pipeline, { key: "price", op: "gt", value: HUGE, type: "number" }),
        ).toEqual([]);
        expect(
          await ids(pipeline, { key: "price", op: "gte", value: HUGE, type: "number" }),
        ).toEqual([A]);
        expect(
          await ids(pipeline, {
            key: "price",
            op: "lt",
            value: "12345678901234567890.124",
            type: "number",
          }),
        ).toEqual(sorted(B, C, D, A));
        expect(
          await ids(pipeline, {
            key: "price",
            op: "lte",
            value: "12345678901234567890.122",
            type: "number",
          }),
        ).toEqual(sorted(B, C, D));
        expect(
          await ids(pipeline, { key: "price", op: "equals", value: HUGE, type: "number" }),
        ).toEqual([A]);
        expect(
          await ids(pipeline, { key: "price", op: "equals", value: "99.990", type: "number" }),
        ).toEqual([C]);
        expect(await ids(pipeline, { key: "price", op: "equals", value: 3.5 })).toEqual([D]);
        expect(await ids(pipeline, { key: "price", op: "equals", value: -5.5 })).toEqual([B]);
      });

      test("date between / ranges / equals", async () => {
        expect(
          await ids(pipeline, {
            ns: "kx",
            key: "effective_date",
            op: "between",
            value: ["2024-01-01", "2024-12-31"],
          }),
        ).toEqual([A]);
        expect(
          await ids(pipeline, { ns: "kx", key: "effective_date", op: "gte", value: "2024-03-15" }),
        ).toEqual(sorted(A, B));
        expect(
          await ids(pipeline, { ns: "kx", key: "effective_date", op: "lt", value: "2024-03-15" }),
        ).toEqual([C]);
        expect(
          await ids(pipeline, {
            ns: "kx",
            key: "effective_date",
            op: "equals",
            value: "2023-12-31",
            type: "date",
          }),
        ).toEqual([C]);
      });

      test("datetime between with a non-UTC offset compares in UTC", async () => {
        // 2024-06-01T10:00:00+05:30 == 04:30:00Z
        expect(
          await ids(pipeline, {
            key: "published",
            op: "between",
            value: ["2024-06-01T04:00:00Z", "2024-06-01T05:00:00Z"],
          }),
        ).toEqual([D]);
        // Same instant expressed in another offset window.
        expect(
          await ids(pipeline, {
            key: "published",
            op: "between",
            value: ["2024-06-01T09:00:00+05:00", "2024-06-01T10:00:00+05:00"],
          }),
        ).toEqual([D]);
        // Read as UTC wall-clock (10:00Z) the value would be inside this window; it must not be.
        expect(
          await ids(pipeline, {
            key: "published",
            op: "between",
            value: ["2024-06-01T09:00:00Z", "2024-06-01T11:00:00Z"],
          }),
        ).toEqual([]);
        expect(
          await ids(pipeline, {
            key: "published",
            op: "gt",
            value: "2024-06-01T04:30:00.000Z",
          }),
        ).toEqual([]);
        expect(
          await ids(pipeline, { key: "published", op: "gte", value: "2024-06-01T10:00:00+05:30" }),
        ).toEqual([D]);
        expect(
          await ids(pipeline, {
            key: "published",
            op: "equals",
            value: "2024-06-01T04:30:00Z",
            type: "datetime",
          }),
        ).toEqual([D]);
      });

      test("boolean equals", async () => {
        expect(await ids(pipeline, { key: "vip", op: "equals", value: true })).toEqual(
          sorted(A, C),
        );
        expect(await ids(pipeline, { key: "vip", op: "equals", value: false })).toEqual([B]);
      });

      test("exists true and false", async () => {
        expect(await ids(pipeline, { key: "vip", op: "exists", value: true })).toEqual(
          sorted(A, B, C),
        );
        expect(await ids(pipeline, { key: "vip", op: "exists", value: false })).toEqual(
          sorted(D, E, F, U1, U2),
        );
      });
    });

    describe("namespaces", () => {
      test("no ns spans both Knowmax and Confluence effective_date", async () => {
        // untyped string equals infers type "string": only Confluence stores it as a string
        expect(
          await ids(pipeline, { key: "effective_date", op: "equals", value: "2024-03-15" }),
        ).toEqual([E]);
        // existence ignores type and namespace
        expect(await ids(pipeline, { key: "effective_date", op: "exists", value: true })).toEqual(
          sorted(A, B, C, E),
        );
      });

      test("ns:'kx' matches only Knowmax; ns:'confluence' only Confluence", async () => {
        expect(
          await ids(pipeline, { ns: "kx", key: "effective_date", op: "exists", value: true }),
        ).toEqual(sorted(A, B, C));
        expect(
          await ids(pipeline, {
            ns: "confluence",
            key: "effective_date",
            op: "exists",
            value: true,
          }),
        ).toEqual([E]);
        expect(
          await ids(pipeline, {
            ns: ["kx", "confluence"],
            key: "effective_date",
            op: "exists",
            value: true,
          }),
        ).toEqual(sorted(A, B, C, E));
      });

      test("a date range never matches the string-typed Confluence value", async () => {
        const f: FilterExpression = {
          key: "effective_date",
          op: "between",
          value: ["2024-01-01", "2024-12-31"],
        };
        expect(await ids(pipeline, f)).toEqual([A]);
        expect(await ids(pipeline, { ...f, ns: "confluence" } as FilterExpression)).toEqual([]);
      });

      test("string equals on the Confluence value needs the string type and finds only E", async () => {
        expect(
          await ids(pipeline, {
            key: "effective_date",
            op: "equals",
            value: "2024-03-15",
            type: "string",
          }),
        ).toEqual([E]);
      });
    });

    describe("untagged and legacy rows", () => {
      test("not {region equals EU} and exists:false include untagged rows", async () => {
        expect(await ids(pipeline, { not: { key: "region", op: "equals", value: "EU" } })).toEqual(
          sorted(B, D, E, F, U1, U2),
        );
        const notExists = await ids(pipeline, { key: "region", op: "exists", value: false });
        expect(notExists).toEqual(sorted(D, E, F, U1, U2));
        expect(notExists).toContain(U1);
        expect(notExists).toContain(U2);
      });

      test("a positive condition never matches an untagged row", async () => {
        const probes: FilterExpression[] = [
          { key: "region", op: "equals", value: "EU" },
          { key: "region", op: "exists", value: true },
          { key: "price", op: "gt", value: -1e9 },
          { key: "team", op: "contains", value: "a" },
          { key: "vip", op: "equals", value: false },
        ];
        for (const f of probes) {
          const r = await ids(pipeline, f);
          expect(r).not.toContain(U1);
          expect(r).not.toContain(U2);
        }
      });

      test("legacy rows (attributes = '[]' written by the column default) behave the same", async () => {
        // Insert without touching attributes, so the migration default applies.
        await testDb.sql.unsafe(
          `INSERT INTO rag_documents
             (tenant_id, source_type, source_id, chunk_index, content, content_normalized, language, embedding)
           VALUES ($1, 'doc', $2, '0', $3, $3, 'en', $4::vector)`,
          [TENANT, uuid(900), CONTENT, `[${randomVector(900).join(",")}]`],
        );
        try {
          const legacy = uuid(900);
          expect(await ids(pipeline, { key: "region", op: "exists", value: false })).toContain(
            legacy,
          );
          expect(
            await ids(pipeline, { not: { key: "region", op: "equals", value: "EU" } }),
          ).toContain(legacy);
          expect(await ids(pipeline, { key: "region", op: "equals", value: "EU" })).not.toContain(
            legacy,
          );
        } finally {
          await testDb.sql.unsafe("DELETE FROM rag_documents WHERE source_id = $1", [uuid(900)]);
        }
      });
    });

    describe("metacharacters", () => {
      test.each(META_VALUES)("value %p is stored and matched literally", async (v) => {
        expect(await ids(pipeline, { key: "note", op: "equals", value: v })).toEqual([F]);
        expect(await ids(pipeline, { key: "note", op: "contains", value: v })).toEqual([F]);
        expect(await ids(pipeline, { key: "note", op: "startsWith", value: v })).toEqual([F]);
        expect(await ids(pipeline, { key: "note", op: "endsWith", value: v })).toEqual([F]);
      });

      test("LIKE wildcards are not wildcards", async () => {
        expect(await ids(pipeline, { key: "note", op: "equals", value: "%" })).toEqual([]);
        expect(await ids(pipeline, { key: "note", op: "contains", value: "%" })).toEqual([F]);
        expect(await ids(pipeline, { key: "note", op: "equals", value: "100%_done" })).toEqual([F]);
        expect(await ids(pipeline, { key: "note", op: "equals", value: "100xxdone" })).toEqual([]);
        expect(await ids(pipeline, { key: "note", op: "startsWith", value: "_" })).toEqual([]);
        expect(await ids(pipeline, { key: "note", op: "contains", value: "1_0" })).toEqual([]);
        expect(await ids(pipeline, { key: "note", op: "contains", value: "\\" })).toEqual([F]);
      });

      test("hostile key and namespace names are bound, not spliced", async () => {
        const evil = `x' OR '1'='1`;
        expect(await ids(pipeline, { key: evil, op: "equals", value: "a" })).toEqual([]);
        expect(await ids(pipeline, { ns: evil, key: "note", op: "exists", value: true })).toEqual(
          [],
        );
        expect(
          await ids(pipeline, { key: "note", op: "contains", value: "') OR TRUE --" }),
        ).toEqual([]);
      });
    });

    describe("composition", () => {
      test("and / or / not", async () => {
        expect(
          await ids(pipeline, {
            and: [
              { key: "region", op: "equals", value: "EU" },
              { key: "vip", op: "equals", value: true },
              { not: { key: "team", op: "equals", value: ARABIC_TEAM } },
            ],
          }),
        ).toEqual([A]);
        expect(
          await ids(pipeline, {
            or: [
              { key: "region", op: "equals", value: "US" },
              { key: "price", op: "lt", value: 4, type: "number" },
            ],
          }),
        ).toEqual(sorted(B, D));
      });
    });

    describe("re-index", () => {
      test("re-indexing an article without region removes the old attributes completely", async () => {
        const db = makeDb(testDb);
        expect(await ids(pipeline, { key: "region", op: "equals", value: "EU" })).toEqual(
          sorted(A, C),
        );
        // A re-indexed with a different team and no region at all.
        await db.replaceSource(TENANT, "doc", A, [
          toChunk(A, [kx({ key: "team", type: "string", value: "new team" })], 1),
        ]);
        try {
          expect(await ids(pipeline, { key: "region", op: "equals", value: "EU" })).toEqual([C]);
          expect(await ids(pipeline, { key: "region", op: "equals", value: "UK" })).toEqual([]);
          expect(await ids(pipeline, { key: "vip", op: "exists", value: true })).toEqual(
            sorted(B, C),
          );
          expect(
            await ids(pipeline, { key: "price", op: "gte", value: HUGE, type: "number" }),
          ).toEqual([]);
          expect(await ids(pipeline, { key: "team", op: "equals", value: "istanbul ops" })).toEqual(
            [],
          );
          expect(await ids(pipeline, { key: "team", op: "equals", value: "new team" })).toEqual([
            A,
          ]);
          expect(await ids(pipeline, { key: "region", op: "exists", value: false })).toContain(A);
        } finally {
          // Restore the original corpus entry for later tests.
          const orig = CORPUS.find((c) => c.id === A);
          await db.replaceSource(TENANT, "doc", A, [toChunk(A, orig?.attrs ?? [], 1)]);
        }
      });
    });
  });
}

suite(
  "attribute filters — default legs (vector + trgm + tsvector)",
  "rag_attr_default",
  {},
  (t) => new PostgresRagDatabase(t.provider),
);

suite(
  "attribute filters — gated legs (vchordrq + BM25)",
  "rag_attr_gated",
  { cjk: true, bm25: true, vectorchord: true },
  (t) => new PostgresRagDatabase(t.provider, { cjk: true, fts: new Bm25Fts() }),
);

// ── EXPLAIN: each leg keeps using its own index when a filter is applied ──────
describe.skipIf(!RUN_INTEGRATION)("attribute filters — index use with a filter", () => {
  const DB = "rag_attr_explain";
  // The tenant btrees AND the attributes GIN are hidden: here every seeded row matches the filter,
  // so the planner would otherwise legitimately prefer idx_rag_attributes + Sort and sidestep the
  // leg's own index. Hiding it asks the real question: does the filtered leg STILL reach its
  // vector/GIN/BM25 index when the planner has to?
  const TENANT_BTREES = ["idx_rag_tenant", "idx_rag_source", "idx_rag_attributes"];
  const FILTER: FilterExpression = { key: "region", op: "equals", value: "EU", ns: "kx" };
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb(DB);
    await ragMigrate(testDb.provider, {
      sqlDir: SQL_DIR,
      cjk: true,
      bm25: true,
      vectorchord: true,
    });
    await seed(testDb, {
      tenant: TENANT,
      languages: ["en", "zh"],
      rowsPerLanguage: 150,
      sourcesPerLanguage: 15,
      attributes: [
        kx({ key: "region", type: "string", format: "enum", multi: true, value: ["EU", "UK"] }),
      ],
    });
  });
  afterAll(async () => {
    await dropTestDb(testDb, DB);
  });

  async function leg(
    db: PostgresRagDatabase,
    language: string,
    query: string,
    marker: (t: string) => boolean,
    index: string,
  ) {
    testDb.reset();
    const pipeline = new RagPipeline({ tenantId: TENANT, db, embedder });
    await pipeline.search(query, {
      language,
      vectorMinScore: -1,
      keywordMinScore: 0.05,
      filter: FILTER,
    });
    const q = pickCaptured(testDb.captured, marker);
    // The filter clause must really be in the SQL being EXPLAINed.
    expect(q.text).toContain("attributes @>");
    const plan = await explain(testDb.sql, q.text, q.params, TENANT_BTREES);
    expect(usedIndexes(plan)).toContain(index);
    expect(seqScannedRelations(plan)).not.toContain("rag_documents");
  }

  const isVector = (t: string) => t.includes("embedding <=>");
  const isTrgm = (t: string) => t.includes("<% content_normalized");
  const isBigm = (t: string) => t.includes("=% $2");
  const isPlainto = (t: string) => t.includes("plainto_tsquery");
  const isBm25 = (t: string) => t.includes("to_bm25query");

  test("vector leg → idx_rag_embedding_vchordrq", async () => {
    await leg(
      new PostgresRagDatabase(testDb.provider),
      "en",
      "wireless",
      isVector,
      "idx_rag_embedding_vchordrq",
    );
  });

  test("keyword leg → idx_rag_content_normalized_trgm", async () => {
    await leg(
      new PostgresRagDatabase(testDb.provider),
      "en",
      "wireless",
      isTrgm,
      "idx_rag_content_normalized_trgm",
    );
  });

  test("CJK keyword leg → idx_rag_content_bigm", async () => {
    await leg(
      new PostgresRagDatabase(testDb.provider, { cjk: true }),
      "zh",
      "耳机",
      isBigm,
      "idx_rag_content_bigm",
    );
  });

  test("FTS leg (tsvector) → idx_rag_content_fts", async () => {
    await leg(
      new PostgresRagDatabase(testDb.provider),
      "en",
      "wireless",
      isPlainto,
      "idx_rag_content_fts",
    );
  });

  test("FTS leg (BM25) → idx_rag_bm25_en", async () => {
    await leg(
      new PostgresRagDatabase(testDb.provider, { fts: new Bm25Fts() }),
      "en",
      "wireless",
      isBm25,
      "idx_rag_bm25_en",
    );
  });
});
