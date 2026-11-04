import type { AttributeType, FilterLimits, FilterOp, FilterScalar } from "../types.js";
import { foldCase, isDecimalString, isValidDate, normalizeDatetime } from "./attributes.js";

export const DEFAULT_FILTER_LIMITS: FilterLimits = {
  maxDepth: 5,
  maxConditions: 32,
  maxListSize: 50,
  maxStringLength: 256,
};

const OPS: readonly FilterOp[] = [
  "equals",
  "startsWith",
  "endsWith",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "exists",
];
const TYPES: readonly AttributeType[] = ["string", "number", "boolean", "date", "datetime"];
const STRING_OPS: readonly FilterOp[] = ["equals", "startsWith", "endsWith", "contains", "exists"];
const ORDERED_OPS: readonly FilterOp[] = ["equals", "gt", "gte", "lt", "lte", "between", "exists"];
const ALLOWED_OPS: Record<AttributeType, readonly FilterOp[]> = {
  string: STRING_OPS,
  number: ORDERED_OPS,
  date: ORDERED_OPS,
  datetime: ORDERED_OPS,
  boolean: ["equals", "exists"],
};
const RANGE_OPS: readonly FilterOp[] = ["gt", "gte", "lt", "lte", "between"];
const CONDITION_KEYS = ["ns", "key", "op", "value", "type", "caseSensitive"];

type Json = Record<string, unknown>;

function buildSchema(strict: boolean): Json {
  const scalar: Json = { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] };
  const value: Json = {
    anyOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "array", items: scalar },
    ],
  };
  const ns: Json = {
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }, { type: "null" }],
  };
  const properties: Record<string, Json> = {
    ns,
    key: { type: "string" },
    op: { type: "string", enum: [...OPS] },
    value,
    type: { anyOf: [{ type: "string", enum: [...TYPES] }, { type: "null" }] },
    caseSensitive: { anyOf: [{ type: "boolean" }, { type: "null" }] },
  };
  const condition: Json = {
    type: "object",
    properties,
    required: strict ? CONDITION_KEYS : ["key", "op", "value"],
    additionalProperties: false,
  };
  const list = (k: string): Json => ({
    type: "object",
    properties: { [k]: { type: "array", items: { $ref: "#/$defs/expr" } } },
    required: [k],
    additionalProperties: false,
  });
  const not: Json = {
    type: "object",
    properties: { not: { $ref: "#/$defs/expr" } },
    required: ["not"],
    additionalProperties: false,
  };
  const expr: Json = {
    anyOf: [
      { $ref: "#/$defs/condition" },
      { $ref: "#/$defs/and" },
      { $ref: "#/$defs/or" },
      { $ref: "#/$defs/not" },
    ],
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { filter: { anyOf: [{ $ref: "#/$defs/expr" }, { type: "null" }] } },
    required: ["filter"],
    additionalProperties: false,
    $defs: { expr, condition, and: list("and"), or: list("or"), not },
  };
}

/** Lenient draft 2020-12 schema: `ns`, `type` and `caseSensitive` are optional. */
export const FILTER_JSON_SCHEMA: Json = buildSchema(false);

/** Strict structured-output schema (every property required; optional ones nullable). */
export const FILTER_GENERATION_SCHEMA: Json = buildSchema(true);

export interface ResolvedCondition {
  /** null = any namespace. */
  ns: string[] | null;
  key: string;
  op: FilterOp;
  type: AttributeType;
  values: FilterScalar[];
  caseSensitive: boolean;
}

export type ValidatedFilter =
  | ResolvedCondition
  | { and: ValidatedFilter[] }
  | { or: ValidatedFilter[] }
  | { not: ValidatedFilter };

export interface FilterValidationOptions {
  limits?: Partial<FilterLimits>;
}

export class FilterValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invalid filter: ${errors.join("; ")}`);
    this.name = "FilterValidationError";
    this.errors = errors;
  }
}

function isObj(x: unknown): x is Json {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isScalar(x: unknown): x is FilterScalar {
  return (
    typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))
  );
}

function compareDecimal(a: string, b: string): number {
  const negA = a.startsWith("-");
  const negB = b.startsWith("-");
  if (negA !== negB) return negA ? -1 : 1;
  const sign = negA ? -1 : 1;
  const [ai = "", af = ""] = a.replace("-", "").split(".");
  const [bi = "", bf = ""] = b.replace("-", "").split(".");
  const w = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(w, "0"));
  const y = BigInt(bi + bf.padEnd(w, "0"));
  return x === y ? 0 : x < y ? -sign : sign;
}

function compareValues(type: AttributeType, a: FilterScalar, b: FilterScalar): number {
  if (type === "number") {
    if (typeof a === "string" && typeof b === "string") return compareDecimal(a, b);
    return Number(a) - Number(b);
  }
  if (type === "datetime") return new Date(String(a)).getTime() - new Date(String(b)).getTime();
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function isZonedDatetime(s: string): boolean {
  try {
    normalizeDatetime(s);
    return true;
  } catch {
    return false;
  }
}

function normalizeValue(
  type: AttributeType,
  v: FilterScalar,
  caseSensitive: boolean,
): FilterScalar | { error: string } {
  switch (type) {
    case "string":
      if (typeof v !== "string") return { error: "expected a string value" };
      return caseSensitive ? v : foldCase(v);
    case "number":
      if (typeof v === "number") return v;
      if (typeof v === "string" && isDecimalString(v)) return v;
      return { error: "expected a number or a plain decimal string" };
    case "boolean":
      return typeof v === "boolean" ? v : { error: "expected a boolean value" };
    case "date":
      return typeof v === "string" && isValidDate(v) ? v : { error: "expected a YYYY-MM-DD date" };
    case "datetime":
      if (typeof v !== "string") return { error: "expected a datetime string" };
      try {
        return normalizeDatetime(v);
      } catch (e) {
        return { error: e instanceof Error ? e.message : "invalid datetime" };
      }
  }
}

class Ctx {
  errors: string[] = [];
  conditions = 0;
  constructor(readonly limits: FilterLimits) {}
}

function validateNode(
  node: unknown,
  path: string,
  depth: number,
  ctx: Ctx,
): ValidatedFilter | null {
  if (!isObj(node)) {
    ctx.errors.push(`${path}: expected an object`);
    return null;
  }
  const boolKeys = ["and", "or", "not"].filter((k) => k in node);
  if (boolKeys.length === 0) return validateCondition(node, path, ctx);
  if (boolKeys.length > 1 || Object.keys(node).length > 1) {
    ctx.errors.push(`${path}: a boolean node takes exactly one of and/or/not and nothing else`);
    return null;
  }
  if (depth > ctx.limits.maxDepth) {
    ctx.errors.push(`${path}: nesting deeper than ${ctx.limits.maxDepth}`);
    return null;
  }
  const k = boolKeys[0] as "and" | "or" | "not";
  if (k === "not") {
    const inner = validateNode(node.not, `${path}.not`, depth + 1, ctx);
    return inner ? { not: inner } : null;
  }
  const arr = node[k];
  if (!Array.isArray(arr) || arr.length === 0) {
    ctx.errors.push(`${path}.${k}: expected a non-empty array`);
    return null;
  }
  const kids = arr.map((c, i) => validateNode(c, `${path}.${k}[${i}]`, depth + 1, ctx));
  if (kids.some((c) => c === null)) return null;
  const list = kids as ValidatedFilter[];
  return k === "and" ? { and: list } : { or: list };
}

function validateCondition(node: Json, path: string, ctx: Ctx): ResolvedCondition | null {
  const { limits } = ctx;
  const errs: string[] = [];
  const err = (m: string) => errs.push(`${path}: ${m}`);
  ctx.conditions++;
  if (ctx.conditions === limits.maxConditions + 1) {
    ctx.errors.push(`more than ${limits.maxConditions} conditions`);
  }
  for (const k of Object.keys(node)) {
    if (!CONDITION_KEYS.includes(k)) err(`unknown property "${k}"`);
  }
  const { key, op } = node;
  if (typeof key !== "string" || key === "") err("key must be a non-empty string");
  else if (key.length > limits.maxStringLength) err(`key longer than ${limits.maxStringLength}`);
  if (typeof op !== "string" || !OPS.includes(op as FilterOp)) {
    err(`op must be one of ${OPS.join(", ")}`);
  }

  let ns: string[] | null = null;
  if (node.ns !== undefined && node.ns !== null) {
    const rawNs = Array.isArray(node.ns) ? node.ns : [node.ns];
    if (
      rawNs.length === 0 ||
      rawNs.length > limits.maxListSize ||
      rawNs.some((n) => typeof n !== "string" || n === "" || n.length > limits.maxStringLength)
    ) {
      err(`ns must be a non-empty string or a list of at most ${limits.maxListSize} strings`);
    } else {
      ns = rawNs as string[];
    }
  }

  let explicit: AttributeType | null = null;
  if (node.type !== undefined && node.type !== null) {
    if (typeof node.type === "string" && TYPES.includes(node.type as AttributeType)) {
      explicit = node.type as AttributeType;
    } else {
      err(`type must be one of ${TYPES.join(", ")}`);
    }
  }
  if (
    node.caseSensitive !== undefined &&
    node.caseSensitive !== null &&
    typeof node.caseSensitive !== "boolean"
  ) {
    err("caseSensitive must be a boolean");
  }
  const caseSensitive = node.caseSensitive === true;

  if (errs.length > 0 || typeof op !== "string" || typeof key !== "string") {
    ctx.errors.push(...errs);
    return null;
  }
  const o = op as FilterOp;
  const fail = (m: string): null => {
    ctx.errors.push(`${path}: ${m}`);
    return null;
  };

  const raw = node.value;
  if (o === "exists") {
    if (typeof raw !== "boolean") return fail("exists takes a boolean value");
    return { ns, key, op: o, type: explicit ?? "string", values: [raw], caseSensitive };
  }
  const isList = Array.isArray(raw);
  const vals: unknown[] = isList ? raw : [raw];
  if (isList && o !== "equals" && o !== "between") return fail(`${o} takes a single value`);
  if (o === "between" && !(isList && vals.length === 2))
    return fail("between takes exactly 2 values");
  if (o === "equals" && isList && (vals.length === 0 || vals.length > limits.maxListSize)) {
    return fail(`equals list must have 1 to ${limits.maxListSize} values`);
  }
  if (!vals.every(isScalar)) return fail("values must be strings, finite numbers or booleans");
  const scalars = vals as FilterScalar[];
  if (scalars.some((v) => typeof v === "string" && v.length > limits.maxStringLength)) {
    return fail(`string value longer than ${limits.maxStringLength}`);
  }

  let type: AttributeType;
  if (explicit) {
    type = explicit;
  } else if (scalars.every((v) => typeof v === "number")) {
    type = "number";
  } else if (scalars.every((v) => typeof v === "boolean")) {
    type = "boolean";
  } else if (scalars.every((v) => typeof v === "string")) {
    const strs = scalars as string[];
    if (!RANGE_OPS.includes(o)) type = "string";
    else if (strs.every(isValidDate)) type = "date";
    else if (strs.every(isZonedDatetime)) type = "datetime";
    else return fail('cannot infer the type of these string values; set "type"');
  } else {
    return fail('values of mixed types; set "type" or use one type');
  }
  if (!ALLOWED_OPS[type].includes(o)) return fail(`op "${o}" is not allowed for type "${type}"`);

  const out: FilterScalar[] = [];
  for (const v of scalars) {
    const r = normalizeValue(type, v, caseSensitive);
    if (typeof r === "object") return fail(r.error);
    out.push(r);
  }
  if (o === "between" && compareValues(type, out[0] as FilterScalar, out[1] as FilterScalar) > 0) {
    return fail("between needs lo <= hi");
  }
  return { ns, key, op: o, type, values: out, caseSensitive };
}

/** Validate and normalize a filter expression. */
export function validateFilter(
  expr: unknown,
  options: FilterValidationOptions = {},
): { ok: true; filter: ValidatedFilter } | { ok: false; errors: string[] } {
  const ctx = new Ctx({ ...DEFAULT_FILTER_LIMITS, ...options.limits });
  const filter = validateNode(expr, "$", 1, ctx);
  if (ctx.errors.length > 0 || !filter) {
    return { ok: false, errors: ctx.errors.length > 0 ? ctx.errors : ["invalid filter"] };
  }
  return { ok: true, filter };
}

/** Like `validateFilter` but throws `FilterValidationError`. */
export function assertValidFilter(
  expr: unknown,
  options: FilterValidationOptions = {},
): ValidatedFilter {
  const r = validateFilter(expr, options);
  if (!r.ok) throw new FilterValidationError(r.errors);
  return r.filter;
}
