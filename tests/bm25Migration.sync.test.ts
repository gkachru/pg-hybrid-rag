import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BM25_LANGUAGE_GROUPS,
  bm25SupportedLanguages,
} from "../src/adapters/fts/bm25LanguageGroups.js";

const read = (file: string) =>
  readFileSync(join(import.meta.dir, "..", "sql", file), "utf-8").replace(/\s+/g, " ");

// Both migrations define the same partial-index predicates: 011 creates the indexes on raw
// `content`, 015 rebuilds them on content_normalized. The planner uses whichever indexes currently
// exist (015's), so both files must stay in sync with BM25_LANGUAGE_GROUPS.
const MIGRATIONS = ["011_pg_textsearch.sql", "015_bm25_normalized_textsearch.sql"];

describe("BM25 language groups stay in sync with the pg_textsearch migrations", () => {
  for (const file of MIGRATIONS) {
    const sql = read(file);
    describe(file, () => {
      for (const group of BM25_LANGUAGE_GROUPS) {
        it(`has a ${group.config} partial index with the exact language list`, () => {
          const langs = group.languages.map((l) => `'${l}'`).join(",");
          expect(sql).toContain(`text_config='${group.config}'`);
          expect(sql).toContain(`language IN (${langs})`);
        });
      }

      it("has a simple catch-all index excluding every supported language", () => {
        const all = bm25SupportedLanguages()
          .map((l) => `'${l}'`)
          .join(",");
        expect(sql).toContain("text_config='simple'");
        expect(sql).toContain(`language NOT IN (${all})`);
      });
    });
  }

  it("011 created the indexes on raw content; 015 rebuilds them on content_normalized", () => {
    const m011 = read("011_pg_textsearch.sql");
    const m015 = read("015_bm25_normalized_textsearch.sql");
    expect(m011).toContain("USING bm25(content)");
    expect(m015).toContain("USING bm25(content_normalized)");
    // 015 must not leave any raw-content index behind (it DROPs + recreates on the normalized column).
    expect(m015).not.toContain("USING bm25(content)");
  });
});
