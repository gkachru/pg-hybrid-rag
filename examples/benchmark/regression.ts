/**
 * Benchmark regression check — run every suite in baselines.json and compare each result against
 * its committed baseline. Use it after any change that could move retrieval quality: a DB image /
 * extension upgrade, a migration, an adapter/SQL change, a fusion/rerank change.
 *
 *   bun run examples/benchmark/regression.ts                       # all suites
 *   bun run examples/benchmark/regression.ts --only ar-matrix,th-matrix
 *   bun run examples/benchmark/regression.ts --list                # show suites, run nothing
 *   bun run examples/benchmark/regression.ts --update-baselines    # accept the new numbers
 *
 * Flags: --tolerance <x> (default 0.005; never tighter than one query, see compare.ts),
 * --allow-settings-drift (run even if EMBEDDING_MODEL/DIM/RERANKER_MODEL/VECTOR_MIN_SCORE differ
 * from the baseline's — results are then NOT comparable).
 *
 * Prereqs (see BASELINES.md): DB + infinity (GPU) + thai-segmenter up, corpus caches built, and
 * the same .env the benchmarks use. Logs land in examples/benchmark/results/regression-<ts>/
 * (gitignored). Exit code: 0 all OK, 1 any suite failed/flagged, 2 bad usage/preflight.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BASELINES_PATH,
  type BaselineFile,
  compareConfigs,
  DEFAULT_TOLERANCE,
  diffMaps,
  formatComparison,
  loadBaselines,
  METRICS,
  type Metrics,
  type ResultBundle,
  toReference,
} from "./compare.js";

/** Settings that change the numbers; a mismatch with the baseline makes a comparison meaningless. */
const QUALITY_SETTINGS = ["EMBEDDING_MODEL", "EMBEDDING_DIM", "RERANKER_MODEL", "VECTOR_MIN_SCORE"];
/** Per-suite knobs: cleared from the child env unless the suite sets them, so they can't leak. */
const SUITE_KNOBS = ["FUSION", "NORMALIZER", "RERANK_CANDIDATES", "CANDIDATE_MULTIPLIER"];

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface SuiteOutcome {
  key: string;
  status: "OK" | "CHECK" | "FAILED";
  detail: string;
  elapsedS: number;
  result?: ResultBundle;
}

function parseArgs(argv: string[]) {
  const valueAfter = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    only: valueAfter("--only")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    tolerance: Number(valueAfter("--tolerance") ?? DEFAULT_TOLERANCE),
    update: argv.includes("--update-baselines"),
    allowDrift: argv.includes("--allow-settings-drift"),
    list: argv.includes("--list"),
  };
}

async function reachable(url: string): Promise<{ ok: boolean; body?: unknown; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: true, body: text };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Fail fast on setup problems that would otherwise surface minutes into a run. */
async function preflight(
  baselines: BaselineFile,
  keys: string[],
  allowDrift: boolean,
): Promise<string[]> {
  const problems: string[] = [];

  // Settings drift vs each selected suite's baseline.
  for (const key of keys) {
    const suite = baselines.suites[key];
    for (const k of QUALITY_SETTINGS) {
      const want = suite.settings[k] ?? null;
      const have = process.env[k]?.trim() ?? null;
      if (want !== have) {
        const msg = `${key}: ${k} is ${have ?? "<unset>"} but the baseline used ${want ?? "<unset>"}`;
        if (allowDrift)
          console.warn(`  WARN ${msg} (--allow-settings-drift: results not comparable)`);
        else problems.push(msg);
      }
    }
  }

  // Embedder/reranker server.
  const base = process.env.EMBEDDING_BASE_URL;
  if (!base) {
    problems.push("EMBEDDING_BASE_URL is not set");
  } else {
    const r = await reachable(`${base.replace(/\/$/, "")}/models`);
    if (!r.ok) {
      problems.push(`embedding server ${base}/models unreachable (${r.error}) — is infinity up?`);
    } else if (r.body && typeof r.body === "object" && "data" in r.body) {
      const ids = ((r.body as { data: Array<{ id?: string }> }).data ?? []).map((m) => m.id);
      for (const model of [process.env.EMBEDDING_MODEL, process.env.RERANKER_MODEL]) {
        if (model && !ids.includes(model))
          problems.push(`embedding server does not serve ${model}`);
      }
    }
  }

  // Thai segmenter, only if a Thai suite is selected.
  if (keys.some((k) => baselines.suites[k].runner.includes("benchmark-thai"))) {
    const seg = (process.env.THAI_SEGMENTER_URL ?? "http://localhost:8100").replace(/\/$/, "");
    const r = await reachable(`${seg}/health`);
    if (!r.ok) problems.push(`thai-segmenter ${seg}/health unreachable (${r.error})`);
  }
  return problems;
}

async function runSuite(
  key: string,
  baselines: BaselineFile,
  logDir: string,
  tolerance: number,
): Promise<SuiteOutcome> {
  const suite = baselines.suites[key];
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of SUITE_KNOBS) delete env[k];
  Object.assign(env, suite.env);

  const cmd = ["bun", "run", suite.runner, ...suite.args];
  const envDesc = Object.entries(suite.env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`\n▶ ${key}: ${envDesc ? `${envDesc} ` : ""}${cmd.join(" ")}`);
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const elapsedS = Math.round((performance.now() - t0) / 1000);
  const logPath = `${logDir}/${key}.log`;
  writeFileSync(logPath, `${out}\n--- stderr ---\n${err}`, "utf8");

  const written = [...out.matchAll(/Wrote results: (.+\.json)/g)].pop()?.[1]?.trim();
  if (code !== 0 || !written) {
    return {
      key,
      status: "FAILED",
      detail: `exit ${code}${written ? "" : ", no results JSON"} — see ${logPath}`,
      elapsedS,
    };
  }
  const result = (await Bun.file(written).json()) as ResultBundle;

  for (const d of diffMaps(suite.server, result.server)) {
    console.log(`  server: ${d.key} ${d.a ?? "<none>"} → ${d.b ?? "<none>"}`);
  }
  const cmp = compareConfigs(suite.configs, result, tolerance);
  console.log(formatComparison(cmp));
  const maxAbs = cmp.deltas.reduce((m, d) => Math.max(m, Math.abs(d.delta)), 0);
  return {
    key,
    status: cmp.ok ? "OK" : "CHECK",
    detail: `max |Δ| ${maxAbs.toFixed(3)}${cmp.failed.length ? `, ${cmp.failed.length} config(s) failed` : ""} — ${written}`,
    elapsedS,
    result,
  };
}

function round6(m: Metrics): Metrics {
  const out = { n: m.n } as Metrics;
  for (const k of METRICS) out[k] = Math.round(m[k] * 1e6) / 1e6;
  return out;
}

function updateBaselines(baselines: BaselineFile, outcomes: SuiteOutcome[]): string[] {
  const updated: string[] = [];
  for (const o of outcomes) {
    if (!o.result || o.result.configs.some((c) => c.status !== "ok")) continue;
    const suite = baselines.suites[o.key];
    const ref = toReference(o.result);
    suite.configs = Object.fromEntries(Object.entries(ref).map(([n, m]) => [n, round6(m)]));
    suite.recordedAt = o.result.generatedAt ?? new Date().toISOString();
    if (o.result.settings) suite.settings = o.result.settings;
    if (o.result.server) suite.server = o.result.server;
    updated.push(o.key);
  }
  writeFileSync(BASELINES_PATH, `${JSON.stringify(baselines, null, 2)}\n`, "utf8");
  return updated;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const baselines = loadBaselines();
  const all = Object.keys(baselines.suites);

  if (args.list) {
    for (const k of all) {
      const s = baselines.suites[k];
      const env = Object.entries(s.env)
        .map(([a, b]) => `${a}=${b}`)
        .join(" ");
      console.log(`${k.padEnd(28)} ${env ? `${env} ` : ""}${s.runner} ${s.args.join(" ")}`);
    }
    return 0;
  }
  if (!Number.isFinite(args.tolerance)) {
    console.error("--tolerance must be a number");
    return 2;
  }
  const keys = args.only ?? all;
  const unknown = keys.filter((k) => !(k in baselines.suites));
  if (unknown.length) {
    console.error(`Unknown suite(s): ${unknown.join(", ")}. Known: ${all.join(", ")}`);
    return 2;
  }

  const problems = await preflight(baselines, keys, args.allowDrift);
  if (problems.length) {
    console.error("Preflight failed:");
    for (const p of problems) console.error(`  - ${p}`);
    return 2;
  }

  const logDir = fileURLToPath(new URL(`./results/regression-${Date.now()}`, import.meta.url));
  mkdirSync(logDir, { recursive: true });
  console.log(`Running ${keys.length} suite(s); logs → ${logDir}`);

  const outcomes: SuiteOutcome[] = [];
  for (const key of keys) outcomes.push(await runSuite(key, baselines, logDir, args.tolerance));

  const summary = [
    "",
    "REGRESSION SUMMARY",
    ...outcomes.map(
      (o) =>
        `  ${o.status.padEnd(7)}${o.key.padEnd(28)}${`${o.elapsedS}s`.padStart(6)}  ${o.detail}`,
    ),
  ].join("\n");
  console.log(summary);
  writeFileSync(`${logDir}/summary.txt`, `${summary}\n`, "utf8");

  if (args.update) {
    const updated = updateBaselines(baselines, outcomes);
    console.log(
      `\nUpdated baselines for: ${updated.join(", ") || "(none — no fully-successful suites)"}`,
    );
  }
  return outcomes.every((o) => o.status === "OK") ? 0 : 1;
}

process.exit(await main());
