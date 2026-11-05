import { describe, expect, it } from "bun:test";
import {
  AttributeValidationError,
  DEFAULT_ATTRIBUTE_LIMITS,
  foldCase,
  normalizeAttributes,
  parseAttributes,
  serializeAttributes,
} from "../src/metadata/attributes.js";
import type { AttributeInput } from "../src/types.js";

describe("normalizeAttributes", () => {
  it("expands lists into m:true entries with folded copies", () => {
    expect(normalizeAttributes([{ key: "region", type: "string", value: ["EU", "UK"] }])).toEqual([
      { ns: "global", k: "region", t: "string", v: "EU", l: "eu", m: true },
      { ns: "global", k: "region", t: "string", v: "UK", l: "uk", m: true },
    ]);
  });

  it("keeps decimals exact", () => {
    const entries = normalizeAttributes([
      {
        ns: "kx",
        key: "price",
        type: "number",
        format: "decimal",
        value: "12345678901234567890.123",
      },
    ]);
    const json = serializeAttributes(entries);
    expect(json).toContain('"v":12345678901234567890.123');
    expect(json).toContain('"s":"12345678901234567890.123"');
    expect(parseAttributes(json)[0]?.value).toBe("12345678901234567890.123");
  });

  it("normalizes datetimes to UTC and rejects naive ones", () => {
    const [e] = normalizeAttributes([
      { key: "at", type: "datetime", value: "2026-03-15T10:00:00+05:30" },
    ]);
    expect(e?.v).toBe("2026-03-15T04:30:00.000Z");
    expect(() =>
      normalizeAttributes([{ key: "at", type: "datetime", value: "2026-03-15T10:00:00" }]),
    ).toThrow(AttributeValidationError);
  });

  it("rejects inherited Object.prototype names as types", () => {
    for (const type of ["toString", "__proto__", "constructor"]) {
      expect(() => normalizeAttributes([{ key: "x", type: type as never, value: "a" }])).toThrow(
        AttributeValidationError,
      );
    }
    try {
      normalizeAttributes([{ key: "x", type: "toString" as never, value: "a" }]);
    } catch (err) {
      expect((err as AttributeValidationError).issues.join()).toContain('unknown type "toString"');
    }
  });

  it("rejects impossible datetimes instead of rolling them over", () => {
    for (const value of ["2026-02-30T00:00:00Z", "2026-03-15T24:00:00Z", "2026-03-15T10:60:00Z"]) {
      expect(() => normalizeAttributes([{ key: "at", type: "datetime", value }])).toThrow(
        AttributeValidationError,
      );
    }
    const [e] = normalizeAttributes([
      { key: "at", type: "datetime", value: "2026-03-15T23:30:00-05:00" },
    ]);
    expect(e?.v).toBe("2026-03-16T04:30:00.000Z");
  });

  it("rejects duplicate (ns, key), treating omitted ns as global", () => {
    try {
      normalizeAttributes([
        { key: "a", type: "boolean", value: true },
        { ns: "global", key: "a", type: "boolean", value: false },
      ]);
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AttributeValidationError);
      expect((err as AttributeValidationError).issues.join()).toContain("global/a");
    }
  });

  it("treats explicit ns global like omitted ns", () => {
    const a = normalizeAttributes([{ ns: "global", key: "k", type: "boolean", value: true }]);
    const b = normalizeAttributes([{ key: "k", type: "boolean", value: true }]);
    expect(a).toEqual(b);
  });

  const bad: Array<[string, AttributeInput[]]> = [
    ["string+decimal", [{ key: "a", type: "string", format: "decimal", value: "1" }]],
    [
      "number string w/o decimal",
      [{ key: "a", type: "number", value: "10.5" as unknown as number }],
    ],
    ["phone", [{ key: "a", type: "string", format: "phone", value: "4155550123" }]],
    ["email", [{ key: "a", type: "string", format: "email", value: "region@" }]],
    ["multi non-array", [{ key: "a", type: "string", format: "enum", multi: true, value: "EU" }]],
    ["bad date", [{ key: "a", type: "date", value: "2026-02-30" }]],
    [
      "201 attributes",
      Array.from({ length: 201 }, (_, i) => ({
        key: `k${i}`,
        type: "boolean" as const,
        value: true,
      })),
    ],
    ["empty key", [{ key: "", type: "boolean", value: true }]],
  ];
  for (const [name, input] of bad) {
    it(`rejects ${name}`, () => {
      try {
        normalizeAttributes(input);
        throw new Error("did not throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AttributeValidationError);
        expect((err as AttributeValidationError).issues.length).toBeGreaterThanOrEqual(1);
      }
    });
  }

  it("reports all issues, not just the first", () => {
    try {
      normalizeAttributes([
        { key: "a", type: "date", value: "2026-02-30" },
        { key: "b", type: "string", format: "email", value: "x@" },
        { key: "c", type: "boolean", value: true },
      ]);
      throw new Error("did not throw");
    } catch (err) {
      expect((err as AttributeValidationError).issues.length).toBe(2);
    }
  });
});

describe("url format", () => {
  const url = (value: string): AttributeInput[] => [
    { key: "link", type: "string", format: "url", value },
  ];

  it("accepts absolute URLs and keeps format f:url", () => {
    const [e] = normalizeAttributes(url("https://example.com/docs?id=1"));
    expect(e).toMatchObject({
      k: "link",
      t: "string",
      f: "url",
      v: "https://example.com/docs?id=1",
    });
  });

  it("rejects relative or non-URL strings", () => {
    for (const value of ["/docs/page", "example.com", "not a url", ""]) {
      expect(() => normalizeAttributes(url(value))).toThrow(AttributeValidationError);
    }
    try {
      normalizeAttributes(url("not a url"));
    } catch (err) {
      expect((err as AttributeValidationError).issues.join()).toContain("invalid url");
    }
  });
});

describe("default limits", () => {
  const issuesOf = (input: AttributeInput[]): string => {
    try {
      normalizeAttributes(input);
    } catch (err) {
      return (err as AttributeValidationError).issues.join("; ");
    }
    return "";
  };
  const attrs = (n: number): AttributeInput[] =>
    Array.from({ length: n }, (_, i) => ({ key: `k${i}`, type: "string", value: "x" }));
  const list = (n: number): AttributeInput[] => [
    { key: "tags", type: "string", value: Array.from({ length: n }, (_, i) => `t${i}`) },
  ];
  const str = (n: number): AttributeInput[] => [{ key: "s", type: "string", value: "a".repeat(n) }];

  it("are 50 attributes, 20 values per attribute, 256-char strings", () => {
    expect(DEFAULT_ATTRIBUTE_LIMITS).toEqual({
      maxAttributes: 50,
      maxValuesPerAttribute: 20,
      maxStringLength: 256,
    });
  });

  it("accepts 50 attributes and rejects 51", () => {
    expect(normalizeAttributes(attrs(50))).toHaveLength(50);
    expect(issuesOf(attrs(51))).toContain("too many attributes (51 > 50)");
  });

  it("accepts 20 list values and rejects 21", () => {
    expect(normalizeAttributes(list(20))).toHaveLength(20);
    expect(issuesOf(list(21))).toContain("too many values (21 > 20)");
  });

  it("accepts a 256-char string and rejects 257", () => {
    expect(normalizeAttributes(str(256))[0]?.v).toHaveLength(256);
    expect(issuesOf(str(257))).toContain("string longer than 256 chars");
  });

  it("can be raised per indexer through overrides", () => {
    expect(normalizeAttributes([...attrs(60)], { maxAttributes: 60 })).toHaveLength(60);
    expect(normalizeAttributes(list(30), { maxValuesPerAttribute: 30 })).toHaveLength(30);
    expect(normalizeAttributes(str(1024), { maxStringLength: 1024 })[0]?.v).toHaveLength(1024);
  });
});

describe("foldCase", () => {
  it("uses toLowerCase only", () => {
    expect(foldCase("İstanbul")).toBe("İstanbul".toLowerCase());
    expect(foldCase("مرحبا")).toBe("مرحبا");
  });
});

describe("round trip", () => {
  it("serialize/parse reproduces outputs", () => {
    const input: AttributeInput[] = [
      { key: "region", type: "string", value: ["EU", "UK"] },
      { ns: "kx", key: "tier", type: "string", format: "enum", value: "gold" },
      { key: "active", type: "boolean", value: false },
      { key: "day", type: "date", value: "2026-03-15" },
      { key: "tags", type: "string", format: "enum", multi: true, value: ["a", "b"] },
      { key: "score", type: "number", value: 3.5 },
    ];
    expect(parseAttributes(serializeAttributes(normalizeAttributes(input)))).toEqual([
      { ns: "global", key: "region", type: "string", value: ["EU", "UK"] },
      { ns: "kx", key: "tier", type: "string", format: "enum", value: "gold" },
      { ns: "global", key: "active", type: "boolean", value: false },
      { ns: "global", key: "day", type: "date", value: "2026-03-15" },
      { ns: "global", key: "tags", type: "string", format: "enum", value: ["a", "b"] },
      { ns: "global", key: "score", type: "number", value: 3.5 },
    ]);
  });
});
