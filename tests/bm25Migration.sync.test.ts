import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BM25_LANGUAGE_GROUPS, bm25SupportedLanguages } from "../src/adapters/fts/bm25LanguageGroups.js";

describe("BM25 language groups stay in sync with sql/011_pg_textsearch.sql", () => {
  const sql = readFileSync(
    join(import.meta.dir, "..", "sql", "011_pg_textsearch.sql"),
    "utf-8",
  ).replace(/\s+/g, " ");

  for (const group of BM25_LANGUAGE_GROUPS) {
    it(`has a ${group.config} partial index with the exact language list`, () => {
      const langs = group.languages.map((l) => `'${l}'`).join(",");
      expect(sql).toContain(`text_config='${group.config}'`);
      expect(sql).toContain(`language IN (${langs})`);
    });
  }

  it("has a simple catch-all index excluding every supported language", () => {
    const all = bm25SupportedLanguages().map((l) => `'${l}'`).join(",");
    expect(sql).toContain("text_config='simple'");
    expect(sql).toContain(`language NOT IN (${all})`);
  });
});
