/**
 * Type-check every TypeScript code sample in the docs against the library source.
 *
 * Each ```ts / ```typescript fence becomes its own module that imports "pg-hybrid-rag"
 * (mapped to src/index.ts). A fence is skipped when the line before it is `<!-- no-check -->`
 * (use that for pseudo-code, signatures, or samples that need packages we don't install).
 * Fragments may use the ambient variables declared in samples-prelude.d.ts (txProvider,
 * embedder, pipeline, ...) without declaring them.
 *
 * Run: bun run docs:check                      (all pages)
 *      bun run docs:check how-to/ reference/  (only pages under these paths, relative to docs/)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const docsDir = join(import.meta.dir, "..");
// Per-process directory so concurrent runs do not clobber each other.
const outDir = join(import.meta.dir, `.sample-check-${process.pid}`);
// Optional path prefixes (relative to docs/) to limit the check, e.g. `how-to/ reference/`.
const filters = process.argv.slice(2).map((a) => a.replaceAll("\\", "/").replace(/^docs\//, ""));
const repoRoot = join(docsDir, "..");

function mdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "superpowers" || name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...mdFiles(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

interface Sample {
  file: string;
  line: number;
  code: string;
}

const samples: Sample[] = [];
let skipped = 0;
for (const file of mdFiles(docsDir)) {
  const rel = relative(docsDir, file).replaceAll("\\", "/");
  if (filters.length > 0 && !filters.some((f) => rel.startsWith(f))) continue;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)```(\w+)/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1];
    const lang = m[2];
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith(`${indent}\`\`\``)) end++;
    if (lang === "ts" || lang === "typescript") {
      let prev = i - 1;
      while (prev >= 0 && lines[prev].trim() === "") prev--;
      if (prev >= 0 && lines[prev].trim() === "<!-- no-check -->") {
        skipped++;
      } else {
        const body = lines
          .slice(i + 1, end)
          .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l));
        samples.push({ file: rel, line: i + 2, code: body.join("\n") });
      }
    }
    i = end;
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const index = new Map<string, Sample>();
samples.forEach((s, n) => {
  const name = `sample_${String(n).padStart(3, "0")}.ts`;
  index.set(name, s);
  // Trailing `export {}` makes every sample a module, so top-level await works and local
  // declarations shadow the ambient prelude instead of clashing with it.
  writeFileSync(join(outDir, name), `${s.code}\nexport {};\n`);
});

writeFileSync(
  join(outDir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: ["bun"],
        baseUrl: ".",
        paths: { "pg-hybrid-rag": ["../../../src/index.ts"] },
      },
      include: ["*.ts", "../samples-prelude.d.ts"],
    },
    null,
    2,
  ),
);

const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const res = spawnSync(process.execPath, [tsc, "-p", join(outDir, "tsconfig.json")], {
  encoding: "utf8",
});
const output = `${res.stdout}${res.stderr}`;
const errors: string[] = [];
for (const line of output.split(/\r?\n/)) {
  const m = /(sample_\d+\.ts)\((\d+),(\d+)\): (error TS\d+: .*)/.exec(line);
  if (!m) {
    if (line.includes("error TS")) errors.push(line);
    continue;
  }
  const s = index.get(m[1]);
  if (!s) continue;
  errors.push(`${s.file}:${s.line + Number(m[2]) - 1}  ${m[4]}`);
}

rmSync(outDir, { recursive: true, force: true });
console.log(`Checked ${samples.length} TypeScript samples (${skipped} marked no-check).`);
if (errors.length > 0) {
  console.log(errors.join("\n"));
  console.log(`\n${errors.length} error(s).`);
  process.exit(1);
}
console.log("All samples type-check.");
