import type { BuiltFilters } from "../adapters/sqlHelpers.js";
import type { FilterScalar } from "../types.js";
import { isDecimalString } from "./attributes.js";
import type { ResolvedCondition, ValidatedFilter } from "./filterSchema.js";

/** Stand-in for a decimal literal while the containment object is JSON-stringified. */
const DECIMAL_SENTINEL = "__decimal_literal__";

class ParamList {
  readonly params: string[] = [];
  constructor(private readonly startIdx: number) {}
  /** Bind a value as text and return its `$n` placeholder. */
  add(value: string): string {
    this.params.push(value);
    return `$${this.startIdx + this.params.length - 1}`;
  }
}

/** JSON text of one containment probe: `[{"k":..,"t"?:..,"l"|"v"?:..,"ns"?:..}]`. */
function containmentJson(
  c: ResolvedCondition,
  ns: string | null,
  value: FilterScalar | undefined,
): string {
  const obj: Record<string, unknown> = { k: c.key };
  let rawDecimal: string | null = null;
  if (c.op !== "exists") {
    obj.t = c.type;
    if (c.type === "string" && !c.caseSensitive) {
      obj.l = value;
    } else if (c.type === "number" && typeof value === "string") {
      if (!isDecimalString(value)) throw new Error("number filter value is not a decimal literal");
      rawDecimal = value;
      obj.v = DECIMAL_SENTINEL;
    } else {
      obj.v = value;
    }
  }
  if (ns !== null) obj.ns = ns;
  let json = JSON.stringify(obj);
  if (rawDecimal !== null) {
    // The sentinel only ever occurs as the "v" value here (c.type is number), so the
    // replacement target is unambiguous; the decimal is already regex-validated.
    json = json.replace(`"v":"${DECIMAL_SENTINEL}"`, `"v":${rawDecimal}`);
  }
  return `[${json}]`;
}

function compileContainment(c: ResolvedCondition, p: ParamList): string {
  const values: Array<FilterScalar | undefined> = c.op === "exists" ? [undefined] : c.values;
  const nsList: Array<string | null> = c.ns ? c.ns : [null];
  const parts: string[] = [];
  for (const ns of nsList) {
    for (const v of values) {
      parts.push(`attributes @> ${p.add(containmentJson(c, ns, v))}::jsonb`);
    }
  }
  return parts.length === 1 ? (parts[0] as string) : `(${parts.join(" OR ")})`;
}

const RANGE_SQL: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

function compileScan(c: ResolvedCondition, p: ParamList): string {
  const preds = [`e->>'k' = ${p.add(c.key)}`, `e->>'t' = ${p.add(c.type)}`];
  if (c.ns) {
    preds.push(
      `e->>'ns' IN (SELECT jsonb_array_elements_text(${p.add(JSON.stringify(c.ns))}::jsonb))`,
    );
  }

  const num = c.type === "number";
  const col = num ? "(CASE WHEN e->>'t' = 'number' THEN (e->>'v')::numeric END)" : "e->>'v'";
  const bind = (v: FilterScalar | undefined) => `${p.add(String(v))}${num ? "::numeric" : ""}`;
  const strCol = c.caseSensitive ? "e->>'v'" : "e->>'l'";

  switch (c.op) {
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      preds.push(`${col} ${RANGE_SQL[c.op]} ${bind(c.values[0])}`);
      break;
    case "between":
      preds.push(`${col} >= ${bind(c.values[0])}`, `${col} <= ${bind(c.values[1])}`);
      break;
    case "startsWith":
      preds.push(`starts_with(${strCol}, ${p.add(String(c.values[0]))})`);
      break;
    case "endsWith": {
      const x = p.add(String(c.values[0]));
      preds.push(`right(${strCol}, length(${x})) = ${x}`);
      break;
    }
    case "contains":
      preds.push(`strpos(${strCol}, ${p.add(String(c.values[0]))}) > 0`);
      break;
    default:
      throw new Error(`unsupported scan op: ${c.op}`);
  }
  return `EXISTS (SELECT 1 FROM jsonb_array_elements(attributes) e WHERE ${preds.join(" AND ")})`;
}

function compileNode(f: ValidatedFilter, p: ParamList): string {
  if ("and" in f) return `(${f.and.map((n) => compileNode(n, p)).join(" AND ")})`;
  if ("or" in f) return `(${f.or.map((n) => compileNode(n, p)).join(" OR ")})`;
  if ("not" in f) return `NOT (${compileNode(f.not, p)})`;
  if (f.op === "equals") return compileContainment(f, p);
  if (f.op === "exists") {
    const has = compileContainment(f, p);
    return f.values[0] === false ? `NOT (${has})` : has;
  }
  return compileScan(f, p);
}

/**
 * Compile a validated filter to a parameterized `AND (...)` clause over `attributes`.
 * Keys, namespaces, values and patterns are all bound as text parameters and never
 * spliced into the SQL text. `startIdx` is the first `$n` placeholder index to use.
 */
export function compileAttributeFilter(filter: ValidatedFilter, startIdx: number): BuiltFilters {
  const p = new ParamList(startIdx);
  const clause = `AND (${compileNode(filter, p)})`;
  return { clause, params: p.params };
}
