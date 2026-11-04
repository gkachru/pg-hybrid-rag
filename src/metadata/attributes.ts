import type {
  AttributeFormat,
  AttributeInput,
  AttributeLimits,
  AttributeOutput,
  AttributeType,
  StoredAttributeEntry,
} from "../types.js";

export const GLOBAL_NS = "global";

export const DEFAULT_ATTRIBUTE_LIMITS: AttributeLimits = {
  maxAttributes: 200,
  maxValuesPerAttribute: 100,
  maxStringLength: 1024,
};

const MAX_NAME_LENGTH = 128;
const DECIMAL_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))$/i;

const FORMATS_BY_TYPE: Record<AttributeType, readonly AttributeFormat[]> = {
  string: ["text", "email", "url", "phone", "enum"],
  number: ["float", "decimal"],
  boolean: [],
  date: [],
  datetime: [],
};

/** Thrown when attribute input fails validation; `issues` lists every problem found. */
export class AttributeValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid attributes: ${issues.join("; ")}`);
    this.name = "AttributeValidationError";
    this.issues = issues;
  }
}

/** Case folding for string attributes: JS `toLowerCase()` only. */
export function foldCase(s: string): string {
  return s.toLowerCase();
}

/** True when `s` is a plain decimal literal (no exponent, no leading zeros). */
export function isDecimalString(s: string): boolean {
  return DECIMAL_RE.test(s);
}

/** True when `s` is `YYYY-MM-DD` and a real calendar date. */
export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Normalize a zoned datetime to UTC ISO. Throws on naive (no `Z`/offset) or invalid input. */
export function normalizeDatetime(s: string): string {
  const m = DATETIME_RE.exec(s);
  if (!m) throw new Error(`datetime "${s}" needs a timezone (Z or offset) and valid format`);
  const [, date, hh, mm, ss, oh, om] = m;
  const inRange = (v: string | undefined, max: number) => v === undefined || Number(v) <= max;
  if (
    !isValidDate(date as string) ||
    !inRange(hh, 23) ||
    !inRange(mm, 59) ||
    !inRange(ss, 59) ||
    !inRange(oh, 23) ||
    !inRange(om, 59)
  ) {
    throw new Error(`datetime "${s}" is not valid`);
  }
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) throw new Error(`datetime "${s}" is not valid`);
  return new Date(t).toISOString();
}

function isUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

type Scalar = string | number | boolean;

/** Validate one scalar; returns the stored entry or an issue message. */
function buildEntry(
  ns: string,
  a: AttributeInput,
  v: unknown,
  limits: AttributeLimits,
  multi: boolean,
): StoredAttributeEntry | string {
  const base: StoredAttributeEntry = { ns, k: a.key, t: a.type, v: "" };
  if (a.format !== undefined) base.f = a.format;
  const fail = (msg: string) => `${ns}.${a.key}: ${msg}`;
  switch (a.type) {
    case "string": {
      if (typeof v !== "string") return fail("expected a string value");
      if (v.length > limits.maxStringLength) {
        return fail(`string longer than ${limits.maxStringLength} chars`);
      }
      if (a.format === "email" && !EMAIL_RE.test(v)) return fail("invalid email");
      if (a.format === "url" && !isUrl(v)) return fail("invalid url");
      if (a.format === "phone" && !PHONE_RE.test(v)) return fail("phone must be E.164");
      base.v = v;
      base.l = foldCase(v);
      break;
    }
    case "number": {
      if (a.format === "decimal") {
        if (typeof v !== "string" || !isDecimalString(v)) {
          return fail("decimal value must be a decimal string");
        }
        base.v = v;
        base.s = v;
      } else {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          return fail("float value must be a finite number");
        }
        base.v = v;
      }
      break;
    }
    case "boolean":
      if (typeof v !== "boolean") return fail("expected a boolean value");
      base.v = v;
      break;
    case "date":
      if (typeof v !== "string" || !isValidDate(v)) return fail("invalid date (YYYY-MM-DD)");
      base.v = v;
      break;
    case "datetime":
      if (typeof v !== "string") return fail("expected a datetime string");
      try {
        base.v = normalizeDatetime(v);
      } catch (err) {
        return fail((err as Error).message);
      }
      break;
  }
  if (multi) base.m = true;
  return base;
}

/**
 * Validate and normalize attributes into storage entries. Collects every issue,
 * then throws `AttributeValidationError` if any were found.
 */
export function normalizeAttributes(
  input: AttributeInput[],
  limits: Partial<AttributeLimits> = {},
): StoredAttributeEntry[] {
  const lim: AttributeLimits = { ...DEFAULT_ATTRIBUTE_LIMITS, ...limits };
  const issues: string[] = [];
  const out: StoredAttributeEntry[] = [];
  const seen = new Set<string>();

  if (input.length > lim.maxAttributes) {
    issues.push(`too many attributes (${input.length} > ${lim.maxAttributes})`);
  }

  input.forEach((a, i) => {
    const ns = a.ns ?? GLOBAL_NS;
    const label = `attribute[${i}]`;
    const before = issues.length;
    if (typeof a.key !== "string" || a.key.length === 0 || a.key.length > MAX_NAME_LENGTH) {
      issues.push(`${label}: key must be 1-${MAX_NAME_LENGTH} chars`);
    }
    if (typeof ns !== "string" || ns.length === 0 || ns.length > MAX_NAME_LENGTH) {
      issues.push(`${label}: ns must be 1-${MAX_NAME_LENGTH} chars`);
    }
    const allowed = FORMATS_BY_TYPE[a.type];
    if (!allowed) {
      issues.push(`${label}: unknown type "${String(a.type)}"`);
      return;
    }
    if (a.format !== undefined && !allowed.includes(a.format)) {
      issues.push(`${label}: format "${a.format}" is not valid for type "${a.type}"`);
    }
    if (a.multi && a.format !== "enum") issues.push(`${label}: multi is only valid with enum`);
    if (issues.length > before) return;

    const dupKey = JSON.stringify([ns, a.key]);
    if (seen.has(dupKey)) {
      issues.push(`duplicate attribute ${ns}/${a.key}; give multiple values as a list`);
      return;
    }
    seen.add(dupKey);

    const id = `${ns}.${a.key}`;
    const isList = Array.isArray(a.value);
    if (a.format === "enum") {
      if (a.multi && !isList) issues.push(`${id}: multi enum needs a string[] value`);
      else if (!a.multi && isList) issues.push(`${id}: single enum needs a scalar value`);
      if (issues.length > before) return;
    } else if (
      isList &&
      !(a.type === "string" && (a.format === undefined || a.format === "text"))
    ) {
      issues.push(`${id}: list values are only allowed for plain strings and multi enums`);
      return;
    }

    const values: Scalar[] = isList ? (a.value as string[]) : [a.value as Scalar];
    if (isList && values.length === 0) {
      issues.push(`${id}: list must not be empty`);
      return;
    }
    if (values.length > lim.maxValuesPerAttribute) {
      issues.push(`${id}: too many values (${values.length} > ${lim.maxValuesPerAttribute})`);
      return;
    }
    for (const v of values) {
      const r = buildEntry(ns, a, v, lim, isList);
      if (typeof r === "string") issues.push(r);
      else out.push(r);
    }
  });

  if (issues.length > 0) throw new AttributeValidationError(issues);
  return out;
}

/** Serialize entries to JSON; decimal `v` is written as the raw literal to keep precision. */
export function serializeAttributes(entries: StoredAttributeEntry[]): string {
  const parts = entries.map((e) => {
    if (e.t === "number" && e.f === "decimal") {
      if (typeof e.v !== "string" || !isDecimalString(e.v)) {
        throw new Error(`decimal entry ${e.ns}.${e.k} has a non-decimal value`);
      }
      const { v, ...rest } = e;
      return `{"v":${v},${JSON.stringify(rest).slice(1)}`;
    }
    return JSON.stringify(e);
  });
  return `[${parts.join(",")}]`;
}

/** Parse stored JSON back into outputs, regrouping entries by ns + key + type (first-appearance order). */
export function parseAttributes(json: string): AttributeOutput[] {
  const entries = JSON.parse(json) as StoredAttributeEntry[];
  const groups = new Map<string, { out: AttributeOutput; list: boolean; values: Scalar[] }>();
  for (const e of entries) {
    const id = JSON.stringify([e.ns, e.k, e.t]);
    const value: Scalar = e.t === "number" && e.f === "decimal" && e.s !== undefined ? e.s : e.v;
    let g = groups.get(id);
    if (!g) {
      const out: AttributeOutput = { ns: e.ns, key: e.k, type: e.t, value };
      if (e.f !== undefined) out.format = e.f;
      g = { out, list: false, values: [] };
      groups.set(id, g);
    }
    if (e.m) g.list = true;
    g.values.push(value);
  }
  return [...groups.values()].map((g) => {
    g.out.value = g.list ? (g.values as string[]) : (g.values[0] as Scalar);
    return g.out;
  });
}
