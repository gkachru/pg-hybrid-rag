import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FTS_STEMMING_GROUPS } from "../src/recommend.js";

// Collapse all whitespace runs to a single space so the migration's column-alignment spacing
// does not affect substring matching (same approach as tests/bm25Migration.sync.test.ts).
const sql = readFileSync(join(import.meta.dir, "..", "sql", "014_arabic_fts.sql"), "utf-8").replace(
  /\s+/g,
  " ",
);

describe("FTS_STEMMING_GROUPS stays in sync with rag_fts_config (sql/014_arabic_fts.sql)", () => {
  for (const group of FTS_STEMMING_GROUPS) {
    it(`maps ${group.languages.join(", ")} → '${group.config}'`, () => {
      const langs = group.languages.map((l) => `'${l}'`).join(", ");
      expect(sql).toContain(`lang IN (${langs}) THEN '${group.config}'`);
    });
  }

  it("everything else falls back to the 'simple' config", () => {
    expect(sql).toContain("ELSE 'simple'");
  });
});
