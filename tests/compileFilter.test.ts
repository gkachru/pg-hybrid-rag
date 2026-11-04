import { describe, expect, test } from "bun:test";
import { compileAttributeFilter } from "../src/metadata/compileFilter.js";
import { assertValidFilter } from "../src/metadata/filterSchema.js";

const compile = (expr: unknown, idx = 5) => compileAttributeFilter(assertValidFilter(expr), idx);

describe("compileAttributeFilter", () => {
  test("case-insensitive string equality uses containment on l", () => {
    expect(compile({ key: "region", op: "equals", value: "EU" })).toEqual({
      clause: "AND (attributes @> $5::jsonb)",
      params: ['[{"k":"region","t":"string","l":"eu"}]'],
    });
  });

  test("case-sensitive equality uses v", () => {
    const r = compile({ key: "region", op: "equals", value: "EU", caseSensitive: true });
    expect(r.params).toEqual(['[{"k":"region","t":"string","v":"EU"}]']);
  });

  test("single ns is included in containment", () => {
    const r = compile({ ns: "kx", key: "region", op: "equals", value: "eu" });
    expect(r.params[0]).toContain('"ns":"kx"');
  });

  test("multiple ns produce OR of containments", () => {
    const r = compile({ ns: ["a", "b"], key: "region", op: "equals", value: "eu" });
    expect(r.params).toHaveLength(2);
    expect(r.clause).toBe("AND ((attributes @> $5::jsonb OR attributes @> $6::jsonb))");
  });

  test("multiple values produce OR of containments", () => {
    const r = compile({ key: "region", op: "equals", value: ["eu", "us"] });
    expect(r.params).toHaveLength(2);
    expect(r.clause).toContain(" OR ");
  });

  test("decimal equality writes the literal raw", () => {
    const r = compile({ key: "price", type: "number", op: "equals", value: "10.50" });
    expect(r.params[0]).toBe('[{"k":"price","t":"number","v":10.50}]');
  });

  test("number equality writes a JSON number; boolean writes a boolean", () => {
    expect(compile({ key: "n", op: "equals", value: 3 }).params[0]).toBe(
      '[{"k":"n","t":"number","v":3}]',
    );
    expect(compile({ key: "b", op: "equals", value: true }).params[0]).toBe(
      '[{"k":"b","t":"boolean","v":true}]',
    );
  });

  test("exists true omits t; exists false negates", () => {
    expect(compile({ key: "x", op: "exists", value: true }).params[0]).toBe('[{"k":"x"}]');
    const r = compile({ key: "x", op: "exists", value: false });
    expect(r.clause).toBe("AND (NOT (attributes @> $5::jsonb))");
  });

  test("numeric range uses the CASE guard and ::numeric", () => {
    const r = compile({ key: "price", type: "number", op: "gte", value: "10.50" });
    expect(r.clause).toContain("::numeric");
    expect(r.clause).toContain("CASE WHEN e->>'t' = 'number' THEN (e->>'v')::numeric END");
    expect(r.params).toContain("10.50");
    expect(r.params).toContain("price");
    expect(r.params).toContain("number");
  });

  test("between binds lo and hi; ns filter uses a jsonb array param", () => {
    const r = compile({
      ns: ["a", "b"],
      key: "d",
      op: "between",
      value: ["2024-01-01", "2024-12-31"],
    });
    expect(r.clause).toContain(">= $");
    expect(r.clause).toContain("<= $");
    expect(r.clause).toContain("jsonb_array_elements_text(");
    expect(r.params).toContain('["a","b"]');
    expect(r.params).toContain("2024-01-01");
    expect(r.params).toContain("2024-12-31");
  });

  test("string ops", () => {
    expect(compile({ key: "s", op: "startsWith", value: "ab" }).clause).toContain(
      "starts_with(e->>'l', $",
    );
    expect(
      compile({ key: "s", op: "startsWith", value: "ab", caseSensitive: true }).clause,
    ).toContain("starts_with(e->>'v', $");
    expect(compile({ key: "s", op: "endsWith", value: "ab" }).clause).toContain(
      "right(e->>'l', length($",
    );
    expect(compile({ key: "s", op: "contains", value: "ab" }).clause).toContain(
      "strpos(e->>'l', $",
    );
  });

  test("boolean nodes", () => {
    const a = { key: "a", op: "equals", value: "x" };
    const b = { key: "b", op: "equals", value: "y" };
    expect(compile({ and: [a, b] }).clause).toBe(
      "AND ((attributes @> $5::jsonb AND attributes @> $6::jsonb))",
    );
    expect(compile({ or: [a, b] }).clause).toContain(" OR ");
    expect(compile({ not: { key: "x", op: "exists", value: true } }).clause).toStartWith(
      "AND (NOT (",
    );
  });

  test("injection safety: values only ever appear in params", () => {
    const values = ["%", "_", "'", '"', "\\", "$1", ")--", "a' OR '1'='1"];
    const results = values.map((v) =>
      compile({ key: "k", op: "contains", value: v, caseSensitive: true }),
    );
    for (const [i, r] of results.entries()) {
      expect(r.clause).toBe(results[0]?.clause as string);
      expect(r.params).toContain(values[i] as string);
    }
    for (const v of ["a' OR '1'='1", ")--", '"', "\\", "%"]) {
      expect(results[0]?.clause.includes(v)).toBe(false);
    }
  });

  test("placeholders are numbered from startIdx, one per param", () => {
    const exprs = [
      { key: "s", op: "endsWith", value: "ab" },
      { ns: ["a", "b"], key: "d", op: "between", value: [1, 2] },
      {
        and: [
          { key: "s", op: "contains", value: "q" },
          { key: "r", op: "equals", value: ["a", "b"] },
        ],
      },
    ];
    for (const e of exprs) {
      for (const idx of [1, 5, 12]) {
        const r = compile(e, idx);
        const found = new Set([...r.clause.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
        const expected = new Set(r.params.map((_, i) => idx + i));
        expect(found).toEqual(expected);
      }
    }
  });
});
