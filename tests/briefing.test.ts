import { describe, expect, test } from "bun:test";
import { renderCatalogBriefing } from "../src/metadata/briefing.js";
import type { MetadataCatalog } from "../src/types.js";

const catalog: MetadataCatalog = {
  tenantId: "t",
  generatedAt: "2026-01-01T00:00:00Z",
  keys: [
    {
      ns: "knowmax",
      key: "region",
      registered: true,
      description: "Customer home region",
      declaredType: "string",
      declaredFormat: "enum",
      multi: true,
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

describe("renderCatalogBriefing", () => {
  test("renders one line per key", () => {
    expect(renderCatalogBriefing(catalog)).toBe(
      "- ns=knowmax key=region type=string(enum, multi) — Customer home region; values: EU, UK\n- ns=global key=priority type=number — (no description)",
    );
  });

  test("maxKeys truncates", () => {
    expect(renderCatalogBriefing(catalog, { maxKeys: 1 })).toBe(
      "- ns=knowmax key=region type=string(enum, multi) — Customer home region; values: EU, UK",
    );
  });

  test("joins several observed types and truncates topValues", () => {
    const c: MetadataCatalog = {
      ...catalog,
      keys: [
        {
          ns: "a",
          key: "k",
          registered: false,
          observed: [
            { type: "string", articleCount: 2 },
            { type: "number", articleCount: 1 },
          ],
          topValues: [
            { value: "x", articleCount: 2 },
            { value: "y", articleCount: 1 },
          ],
        },
      ],
    };
    expect(renderCatalogBriefing(c, { maxValuesPerKey: 1 })).toBe(
      "- ns=a key=k type=string|number — (no description); values: x",
    );
  });

  test("single observed type shows its format", () => {
    const c: MetadataCatalog = {
      ...catalog,
      keys: [
        {
          ns: "a",
          key: "e",
          registered: false,
          observed: [{ type: "string", format: "email", articleCount: 1 }],
        },
      ],
    };
    expect(renderCatalogBriefing(c)).toBe("- ns=a key=e type=string(email) — (no description)");
  });
});
