import { describe, expect, it } from "bun:test";
import {
  AttributeValidationError,
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
