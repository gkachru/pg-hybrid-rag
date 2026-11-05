import { describe, expect, test } from "bun:test";
import {
  assertValidFilter,
  FILTER_GENERATION_SCHEMA,
  FILTER_JSON_SCHEMA,
  FilterValidationError,
  type ResolvedCondition,
  validateFilter,
} from "../src/metadata/filterSchema.js";
import type { MetadataCatalog } from "../src/types.js";

function leaf(f: unknown): ResolvedCondition {
  const r = validateFilter(f);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.filter as ResolvedCondition;
}

describe("validateFilter", () => {
  test("spec 6.2 example validates and resolves", () => {
    const r = validateFilter({
      and: [
        { key: "region", op: "equals", value: ["EU", "UK"] },
        { ns: "knowmax", key: "effective_date", op: "gte", value: "2026-01-01" },
        { not: { ns: ["knowmax", "confluence"], key: "cabin", op: "equals", value: "business" } },
        {
          or: [
            { ns: "confluence", key: "team", op: "startsWith", value: "pay" },
            { key: "priority", op: "exists", value: true },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const and = (r.filter as { and: ResolvedCondition[] }).and;
    expect(and[0]?.values).toEqual(["eu", "uk"]);
    expect(and[0]?.ns).toBeNull();
    expect(and[1]?.type).toBe("date");
    expect(and[1]?.ns).toEqual(["knowmax"]);
  });

  test("decimal string needs explicit type number", () => {
    const r = validateFilter({ key: "price", op: "gte", value: "10.5" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("type");
    const ok = leaf({ key: "price", op: "gte", value: "10.5", type: "number" });
    expect(ok.type).toBe("number");
    expect(ok.values).toEqual(["10.5"]);
  });

  test("zoned datetime normalizes to UTC", () => {
    const l = leaf({ key: "t", op: "gte", value: "2026-03-15T10:00:00+05:30" });
    expect(l.type).toBe("datetime");
    expect(l.values).toEqual(["2026-03-15T04:30:00.000Z"]);
  });

  test("caseSensitive keeps values unfolded", () => {
    const l = leaf({ key: "region", op: "equals", value: "EU", caseSensitive: true });
    expect(l.values).toEqual(["EU"]);
    expect(l.caseSensitive).toBe(true);
  });

  test("exists carries a boolean value", () => {
    const l = leaf({ key: "k", op: "exists", value: false });
    expect(l.values).toEqual([false]);
  });

  const nest = (n: number): unknown => {
    let e: unknown = { key: "a", op: "equals", value: "x" };
    for (let i = 0; i < n; i++) e = { not: e };
    return e;
  };

  test.each([
    ["contains with number", { key: "a", op: "contains", value: 5 }],
    ["between reversed", { key: "a", op: "between", value: [5, 1] }],
    ["between wrong arity", { key: "a", op: "between", value: [1, 2, 3] }],
    ["empty and", { and: [] }],
    ["unknown property", { key: "a", op: "equals", value: "x", foo: 1 }],
    ["depth 6", nest(6)],
    [
      "33 conditions",
      { and: Array.from({ length: 33 }, () => ({ key: "a", op: "equals", value: "x" })) },
    ],
    [
      "51-element list",
      { key: "a", op: "equals", value: Array.from({ length: 51 }, (_, i) => `v${i}`) },
    ],
    ["naive datetime", { key: "a", op: "gte", value: "2026-03-15T10:00:00" }],
    ["gt on boolean", { key: "a", op: "gt", value: true }],
    ["exists non-boolean", { key: "a", op: "exists", value: "yes" }],
    ["long string", { key: "a", op: "equals", value: "x".repeat(257) }],
    ["non-object", 5],
  ])("rejects %s", (_n, f) => {
    expect(validateFilter(f).ok).toBe(false);
  });

  test("depth 5 is allowed", () => {
    expect(validateFilter(nest(5)).ok).toBe(true);
  });

  test("between with decimal-string bounds compares exactly", () => {
    const between = (lo: string, hi: string) =>
      validateFilter({ key: "price", op: "between", value: [lo, hi], type: "number" }).ok;
    // in order (including equal values written differently)
    expect(between("9.99", "10")).toBe(true);
    expect(between("10.5", "10.50")).toBe(true);
    expect(between("-2.5", "-1")).toBe(true);
    expect(between("-1", "0.5")).toBe(true);
    // reversed
    expect(between("10", "9.99")).toBe(false);
    expect(between("-1", "-2.5")).toBe(false);
    expect(between("0.5", "-1")).toBe(false);
    // beyond float precision: Number() would see these as equal
    expect(between("12345678901234567890.123", "12345678901234567890.124")).toBe(true);
    expect(between("12345678901234567890.124", "12345678901234567890.123")).toBe(false);
    // negative zero equals zero in either order
    expect(between("0", "-0")).toBe(true);
    expect(between("-0", "0")).toBe(true);
    expect(between("0", "-0.00")).toBe(true);
    expect(between("-0.0", "-0")).toBe(true);
    expect(between("0", "-0.01")).toBe(false);
  });

  test("limits are overridable", () => {
    expect(validateFilter(nest(2), { limits: { maxDepth: 1 } }).ok).toBe(false);
  });

  test("assertValidFilter throws FilterValidationError", () => {
    expect(() => assertValidFilter({ and: [] })).toThrow(FilterValidationError);
  });
});

describe("schemas", () => {
  test("generation schema is strict-compatible", () => {
    const problems: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        for (const [i, n] of node.entries()) walk(n, `${path}[${i}]`);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if ("oneOf" in o) problems.push(`${path}: oneOf`);
      if (o.type === "object" || "properties" in o) {
        const props = Object.keys((o.properties as object) ?? {});
        if (o.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
        const req = (o.required as string[] | undefined) ?? [];
        for (const p of props) if (!req.includes(p)) problems.push(`${path}: ${p} not required`);
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(FILTER_GENERATION_SCHEMA, "$");
    expect(problems).toEqual([]);
    expect((FILTER_GENERATION_SCHEMA as { required: string[] }).required).toEqual(["filter"]);
    expect("$schema" in FILTER_GENERATION_SCHEMA).toBe(false);
    expect("$schema" in FILTER_JSON_SCHEMA).toBe(true);
  });

  test("lenient schema does not require ns/type/caseSensitive", () => {
    const defs = (FILTER_JSON_SCHEMA as { $defs: Record<string, { required?: string[] }> }).$defs;
    expect(defs.condition?.required).toEqual(["key", "op", "value"]);
  });
});

describe("catalog-aware validation", () => {
  const catalog: MetadataCatalog = {
    tenantId: "t",
    generatedAt: "2026-01-01T00:00:00Z",
    keys: [
      {
        ns: "knowmax",
        key: "region",
        registered: true,
        declaredType: "string",
        allowedValues: ["EU", "UK"],
        observed: [{ type: "string", articleCount: 3 }],
      },
      {
        ns: "global",
        key: "priority",
        registered: false,
        observed: [{ type: "number", articleCount: 2 }],
      },
    ],
  };
  const region = (value: unknown, extra: object = {}) => ({
    key: "region",
    op: "equals",
    value,
    ...extra,
  });

  test("rejectUnknownKeys flags a key absent from the catalog", () => {
    const r = validateFilter(
      { key: "fare_class", op: "equals", value: "x" },
      { catalog, rejectUnknownKeys: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("fare_class");
  });

  test("rejectUnknownKeys respects the ns list", () => {
    const opts = { catalog, rejectUnknownKeys: true };
    expect(validateFilter(region("eu", { ns: "knowmax" }), opts).ok).toBe(true);
    expect(validateFilter(region("eu", { ns: ["global", "knowmax"] }), opts).ok).toBe(true);
    expect(validateFilter(region("eu", { ns: "global" }), opts).ok).toBe(false);
    expect(validateFilter(region("eu"), opts).ok).toBe(true);
  });

  test("enforceAllowedValues", () => {
    const opts = { catalog, enforceAllowedValues: true };
    expect(validateFilter(region("Europe"), opts).ok).toBe(false);
    expect(validateFilter(region("eu"), opts).ok).toBe(true);
    expect(validateFilter(region(["eu", "Europe"]), opts).ok).toBe(false);
    expect(validateFilter(region("eu", { caseSensitive: true }), opts).ok).toBe(false);
    expect(validateFilter(region("EU", { caseSensitive: true }), opts).ok).toBe(true);
  });

  test("neither flag set leaves the filters valid", () => {
    expect(validateFilter(region("Europe"), { catalog }).ok).toBe(true);
    expect(validateFilter({ key: "fare_class", op: "equals", value: "x" }, { catalog }).ok).toBe(
      true,
    );
  });
});
