/**
 * Compare a benchmark result bundle against a reference (a committed baseline suite or another
 * result JSON), config by config, on the overall metrics.
 *
 * Works for both examples/benchmark (Arabic) and examples/benchmark-thai result JSONs — they share
 * the `configs[].overall` shape.
 *
 * Tolerance: a delta is flagged when |Δ| > max(tolerance, 1/n). The 1/n floor is "one query's
 * worth" — with n=75 (Thai: 25 queries × 3 registers) a single query changing rank moves recall by
 * 0.013, which is run-to-run noise, not a regression.
 *
 * CLI:
 *   bun run examples/benchmark/compare.ts <result.json> --against <baseline-key | other-result.json>
 *     [--tolerance 0.005]
 * Exits 1 if any config is missing/failed or any metric is flagged.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const METRICS = [
  "recallAt1",
  "recallAt3",
  "recallAt5",
  "recallAt10",
  "mrr10",
  "ndcg10",
] as const;
export type MetricName = (typeof METRICS)[number];
export type Metrics = { n: number } & Record<MetricName, number>;

/** A result bundle as written by run.ts (only the fields compared here). */
export interface ResultBundle {
  generatedAt?: string;
  settings?: Record<string, string | null>;
  server?: Record<string, string | null>;
  configs: Array<{ name: string; status: string; overall?: Metrics; error?: string }>;
}

/** One committed baseline suite (see baselines.json). */
export interface BaselineSuite {
  runner: string;
  args: string[];
  env: Record<string, string>;
  recordedAt: string;
  settings: Record<string, string | null>;
  server: Record<string, string | null>;
  configs: Record<string, Metrics>;
}

export interface BaselineFile {
  _about?: string;
  suites: Record<string, BaselineSuite>;
}

export interface MetricDelta {
  config: string;
  metric: MetricName;
  baseline: number;
  actual: number;
  delta: number;
  flagged: boolean;
}

export interface Comparison {
  deltas: MetricDelta[];
  /** Configs in the reference but absent from the new result. */
  missing: string[];
  /** Configs present in the new result with a non-ok status (name + error). */
  failed: Array<{ config: string; error: string }>;
  /** Configs only in the new result. */
  extra: string[];
  /** Configs whose query count differs (a different corpus/query set — deltas are meaningless). */
  nMismatch: Array<{ config: string; baseline: number; actual: number }>;
  ok: boolean;
}

export const DEFAULT_TOLERANCE = 0.005;

/** Per-metric tolerance: never tighter than one query's worth (1/n). */
export function effectiveTolerance(tolerance: number, n: number): number {
  return n > 0 ? Math.max(tolerance, 1 / n) : tolerance;
}

export function compareConfigs(
  reference: Record<string, Metrics>,
  result: ResultBundle,
  tolerance: number = DEFAULT_TOLERANCE,
): Comparison {
  const deltas: MetricDelta[] = [];
  const missing: string[] = [];
  const failed: Array<{ config: string; error: string }> = [];
  const nMismatch: Array<{ config: string; baseline: number; actual: number }> = [];
  const byName = new Map(result.configs.map((c) => [c.name, c]));

  for (const [name, ref] of Object.entries(reference)) {
    const got = byName.get(name);
    if (!got) {
      missing.push(name);
      continue;
    }
    if (got.status !== "ok" || !got.overall) {
      failed.push({ config: name, error: got.error ?? got.status });
      continue;
    }
    if (got.overall.n !== ref.n) {
      nMismatch.push({ config: name, baseline: ref.n, actual: got.overall.n });
      continue;
    }
    // 1e-9 slack so a delta of exactly one query (1/n) isn't flagged by float rounding.
    const tol = effectiveTolerance(tolerance, ref.n) + 1e-9;
    for (const metric of METRICS) {
      const delta = got.overall[metric] - ref[metric];
      deltas.push({
        config: name,
        metric,
        baseline: ref[metric],
        actual: got.overall[metric],
        delta,
        flagged: Math.abs(delta) > tol,
      });
    }
  }
  const extra = result.configs.map((c) => c.name).filter((n) => !(n in reference));
  const ok =
    missing.length === 0 &&
    failed.length === 0 &&
    nMismatch.length === 0 &&
    deltas.every((d) => !d.flagged);
  return { deltas, missing, failed, extra, nMismatch, ok };
}

/** Reduce a result bundle to the `configs` map shape a baseline stores (ok configs only). */
export function toReference(result: ResultBundle): Record<string, Metrics> {
  const out: Record<string, Metrics> = {};
  for (const c of result.configs) {
    if (c.status === "ok" && c.overall) out[c.name] = c.overall;
  }
  return out;
}

/** Keys whose value differs between two settings/server maps (null/absent treated alike). */
export function diffMaps(
  a: Record<string, string | null> | undefined,
  b: Record<string, string | null> | undefined,
): Array<{ key: string; a: string | null; b: string | null }> {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const out: Array<{ key: string; a: string | null; b: string | null }> = [];
  for (const key of [...keys].sort()) {
    const av = a?.[key] ?? null;
    const bv = b?.[key] ?? null;
    if (av !== bv) out.push({ key, a: av, b: bv });
  }
  return out;
}

const SHORT: Record<MetricName, string> = {
  recallAt1: "R@1",
  recallAt3: "R@3",
  recallAt5: "R@5",
  recallAt10: "R@10",
  mrr10: "MRR",
  ndcg10: "nDCG",
};

export function formatComparison(cmp: Comparison): string {
  const lines: string[] = [];
  const configs = [...new Set(cmp.deltas.map((d) => d.config))];
  lines.push(`  ${"config".padEnd(18)}${METRICS.map((m) => SHORT[m].padStart(20)).join("")}`);
  for (const config of configs) {
    const cells = cmp.deltas
      .filter((d) => d.config === config)
      .map((d) => {
        // Round before choosing the sign so float dust (baselines are stored at 6 dp) prints +0.000.
        const shown = Math.abs(d.delta) < 0.0005 ? 0 : d.delta;
        const sign = shown >= 0 ? "+" : "-";
        const cell = `${d.baseline.toFixed(3)}→${d.actual.toFixed(3)} ${sign}${Math.abs(shown).toFixed(3)}${d.flagged ? "*" : " "}`;
        return cell.padStart(20);
      });
    lines.push(`  ${config.padEnd(18)}${cells.join("")}`);
  }
  for (const m of cmp.missing) lines.push(`  ${m.padEnd(18)}MISSING from the new result`);
  for (const f of cmp.failed) lines.push(`  ${f.config.padEnd(18)}FAILED — ${f.error}`);
  for (const x of cmp.nMismatch) {
    lines.push(`  ${x.config.padEnd(18)}n MISMATCH baseline=${x.baseline} new=${x.actual}`);
  }
  for (const e of cmp.extra) lines.push(`  ${e.padEnd(18)}(only in new result — not compared)`);
  const maxAbs = cmp.deltas.reduce((m, d) => Math.max(m, Math.abs(d.delta)), 0);
  lines.push(
    `  max |Δ| = ${maxAbs.toFixed(3)}  →  ${cmp.ok ? "OK (within tolerance)" : "CHECK (* = beyond tolerance)"}`,
  );
  return lines.join("\n");
}

export const BASELINES_PATH = fileURLToPath(new URL("./baselines.json", import.meta.url));

export function loadBaselines(path: string = BASELINES_PATH): BaselineFile {
  return JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
}

function loadResult(path: string): ResultBundle {
  return JSON.parse(readFileSync(path, "utf8")) as ResultBundle;
}

function main(argv: string[]): number {
  const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const valueAfter = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const resultPath = positional[0];
  const against = valueAfter("--against");
  const tolerance = Number(valueAfter("--tolerance") ?? DEFAULT_TOLERANCE);
  if (!resultPath || !against || !Number.isFinite(tolerance)) {
    console.error(
      "usage: bun run examples/benchmark/compare.ts <result.json> --against <baseline-key | other.json> [--tolerance 0.005]",
    );
    return 2;
  }

  const result = loadResult(resultPath);
  let reference: Record<string, Metrics>;
  let refSettings: Record<string, string | null> | undefined;
  let refServer: Record<string, string | null> | undefined;
  if (against.endsWith(".json")) {
    const ref = loadResult(against);
    reference = toReference(ref);
    refSettings = ref.settings;
    refServer = ref.server;
  } else {
    const suite = loadBaselines().suites[against];
    if (!suite) {
      console.error(
        `Unknown baseline key "${against}". Known: ${Object.keys(loadBaselines().suites).join(", ")}`,
      );
      return 2;
    }
    reference = suite.configs;
    refSettings = suite.settings;
    refServer = suite.server;
  }

  if (result.settings) {
    for (const d of diffMaps(refSettings, result.settings)) {
      console.log(`  settings differ: ${d.key} reference=${d.a} new=${d.b}`);
    }
  }
  if (result.server) {
    for (const d of diffMaps(refServer, result.server)) {
      console.log(`  server differs:  ${d.key} reference=${d.a} new=${d.b}`);
    }
  }
  const cmp = compareConfigs(reference, result, tolerance);
  console.log(formatComparison(cmp));
  return cmp.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
