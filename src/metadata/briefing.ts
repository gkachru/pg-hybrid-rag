import type { CatalogKey, MetadataCatalog } from "../types.js";

function typeLabel(k: CatalogKey): string {
  if (k.registered && k.declaredType) {
    const parts: string[] = [];
    if (k.declaredFormat) parts.push(k.declaredFormat);
    if (k.multi) parts.push("multi");
    return parts.length > 0 ? `${k.declaredType}(${parts.join(", ")})` : k.declaredType;
  }
  const types = [...new Set(k.observed.map((o) => o.type))];
  if (types.length === 0) return "unknown";
  const only = k.observed.length === 1 ? k.observed[0] : undefined;
  const base = types.join("|");
  return only?.format ? `${base}(${only.format})` : base;
}

/**
 * Render the tenant catalog as a compact text briefing for a filter-generating model.
 * One line per key, in catalog order.
 */
export function renderCatalogBriefing(
  catalog: MetadataCatalog,
  opts: { maxKeys?: number; maxValuesPerKey?: number } = {},
): string {
  const maxKeys = opts.maxKeys ?? 100;
  const maxValues = opts.maxValuesPerKey ?? 20;
  return catalog.keys
    .slice(0, maxKeys)
    .map((k) => {
      let line = `- ns=${k.ns} key=${k.key} type=${typeLabel(k)} — ${k.description || "(no description)"}`;
      const values =
        k.allowedValues && k.allowedValues.length > 0
          ? k.allowedValues
          : (k.topValues ?? []).map((t) => t.value);
      if (values.length > 0) line += `; values: ${values.slice(0, maxValues).join(", ")}`;
      return line;
    })
    .join("\n");
}
