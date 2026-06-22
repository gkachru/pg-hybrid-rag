# Linear-fusion experiment — bge-m3, full 89q, topK=10, local GPU (2-model infinity).
# Tests two hypotheses against RRF:
#   H1: can score-aware fusion rerank a union of 20 and match RRF's union-of-30 (.789)?
#   H2: does linear fusion lift the NO-rerank path above RRF baseline (.665)?
# See docs/superpowers/specs/2026-06-22-linear-fusion-design.md. Run from repo root:
#   pwsh -NoProfile -File examples/benchmark/linear_fusion_experiment.ps1
# Prereqs: infinity up (docker-compose.infinity-min.yml, GPU) + DB up (examples-db-1).
$ErrorActionPreference = "Continue"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root
$out = "examples\benchmark\results\linear"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$sum = "$out\_summary.txt"
"LINEAR-FUSION EXPERIMENT — bge-m3, full 89q, topK=10 — $(Get-Date -Format o)" | Out-File -Encoding utf8 $sum

# Common env (bge-m3 embedder + bge-reranker, both fp16 on GPU via infinity :7997)
$env:EMBEDDING_BASE_URL="http://localhost:7997"; $env:EMBEDDING_API_KEY="local-dev-key"
$env:EMBEDDING_MODEL="BAAI/bge-m3"; $env:EMBEDDING_DIM="1024"; $env:EMBEDDING_BATCH_SIZE="32"
$env:RERANKER_BASE_URL="http://localhost:7997"; $env:RERANKER_API_KEY="local-dev-key"; $env:RERANKER_MODEL="BAAI/bge-reranker-v2-m3"
$env:SEARCH_CONCURRENCY="2"   # GPU driver crashed under heavier load; keep pressure minimal
$env:VECTOR_MIN_SCORE="0"     # do not floor the vector leg before normalization

# name | flags | FUSION | NORMALIZER | RERANK_CANDIDATES | CANDIDATE_MULTIPLIER
$runs = @(
  @{ n="rrf_base";    flags=@();          fu="rrf";    nm="";       rc="";   cm="2" },  # control, no rerank (~.665)
  @{ n="lin_base_mm"; flags=@();          fu="linear"; nm="minmax"; rc="";   cm="2" },  # H2: linear, no rerank
  @{ n="lin_base_l2"; flags=@();          fu="linear"; nm="l2";     rc="";   cm="2" },  # H2: l2 variant
  @{ n="rrf_u30";     flags=@("--rerank"); fu="rrf";    nm="";       rc="30"; cm="3" }, # control (~.789)
  @{ n="lin_u20_mm";  flags=@("--rerank"); fu="linear"; nm="minmax"; rc="20"; cm="2" }, # H1: linear@20 vs rrf@30
  @{ n="lin_u30_mm";  flags=@("--rerank"); fu="linear"; nm="minmax"; rc="30"; cm="3" }  # linear at full union depth
)

foreach ($r in $runs) {
  podman exec examples-db-1 psql -U user -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname LIKE 'arrag_bench%' AND pid <> pg_backend_pid();" 2>&1 | Out-Null
  $env:FUSION = $r.fu; $env:NORMALIZER = $r.nm
  if ($r.rc) { $env:RERANK_CANDIDATES = $r.rc } else { Remove-Item Env:RERANK_CANDIDATES -ErrorAction SilentlyContinue }
  $env:CANDIDATE_MULTIPLIER = $r.cm
  $log = "$out\$($r.n).log"
  "=== $($r.n): flags=$($r.flags -join ' ') FUSION=$($r.fu) NORM=$($r.nm) RC=$($r.rc) CM=$($r.cm) ===" | Out-File -Append -Encoding utf8 $sum
  $t = Measure-Command { bun run examples/benchmark/run.ts @($r.flags) *>&1 | Out-File -Encoding utf8 $log }
  $counts = Select-String -Path $log -Pattern 'rerankInputCount: (\d+)' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value }
  $maxc = if ($counts) { ($counts | Measure-Object -Maximum).Maximum } else { "n/a" }
  $avgc = if ($counts) { [math]::Round(($counts | Measure-Object -Average).Average,1) } else { "n/a" }
  $cmp  = (Select-String -Path $log -Pattern '^\s+(baseline|\+rerank|custom)\s' | ForEach-Object { $_.Line }) -join "`n"
  ("  elapsed {0}s | rerankInput avg={1} max={2}`n{3}" -f [math]::Round($t.TotalSeconds,1), $avgc, $maxc, $cmp) | Out-File -Append -Encoding utf8 $sum
}
"LINEAR EXPERIMENT DONE" | Out-File -Append -Encoding utf8 $sum
Write-Output "Done. Summary: $out\_summary.txt"
