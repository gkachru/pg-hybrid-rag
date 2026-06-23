# Question-in-content A/B — does indexing the FAQ question (not just the answer) lift BM25?
# bge-m3, full 89q, topK=10, local GPU (2-model infinity). See QUESTION_IN_CONTENT_PLAN.md.
# Run from repo root:
#   pwsh -NoProfile -File examples/benchmark/question_content_experiment.ps1
# Prereqs: infinity up (docker-compose.infinity-min.yml, GPU) + DB up (examples-db-1).
#
# Each config runs twice: A_* = answer-only corpus (corpus.jsonl), Q_* = question+answer
# corpus (corpus-withq.jsonl, selected by --include-question). run.ts re-indexes the loaded
# corpus each run (replace-by-source), so switching variants needs no manual DB reset.
$ErrorActionPreference = "Continue"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root
$out = "examples\benchmark\results\qcontent"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$sum = "$out\_summary.txt"
"QUESTION-IN-CONTENT A/B — bge-m3, full 89q, topK=10 — $(Get-Date -Format o)" | Out-File -Encoding utf8 $sum

# Common env (bge-m3 embedder + bge-reranker, both fp16 on GPU via infinity :7997)
$env:EMBEDDING_BASE_URL="http://localhost:7997"; $env:EMBEDDING_API_KEY="local-dev-key"
$env:EMBEDDING_MODEL="BAAI/bge-m3"; $env:EMBEDDING_DIM="1024"; $env:EMBEDDING_BATCH_SIZE="32"
$env:RERANKER_BASE_URL="http://localhost:7997"; $env:RERANKER_API_KEY="local-dev-key"; $env:RERANKER_MODEL="BAAI/bge-reranker-v2-m3"
$env:SEARCH_CONCURRENCY="2"   # GPU driver crashed under heavier load this session — keep minimal
$env:VECTOR_MIN_SCORE="0"     # do not floor the vector leg

# q = include FAQ question in indexed content (--include-question -> corpus-withq.jsonl).
# name | q | flags | FUSION | NORMALIZER | RERANK_CANDIDATES | CANDIDATE_MULTIPLIER
$runs = @(
  # --- answer-only (A): re-derive the baselines in this session for a clean A/B ---
  @{ n="A_bm25_u30";   q=$false; flags=@("--bm25","--rerank"); fu="rrf";    nm="";       rc="30"; cm="3" },
  @{ n="A_bm25_lin20"; q=$false; flags=@("--bm25","--rerank"); fu="linear"; nm="minmax"; rc="20"; cm="2" },
  @{ n="A_lin20";      q=$false; flags=@("--rerank");          fu="linear"; nm="minmax"; rc="20"; cm="2" },
  # --- question+answer (Q): the test — does query<->content lexical overlap lift BM25? ---
  @{ n="Q_bm25_u30";   q=$true;  flags=@("--bm25","--rerank"); fu="rrf";    nm="";       rc="30"; cm="3" },
  @{ n="Q_bm25_lin20"; q=$true;  flags=@("--bm25","--rerank"); fu="linear"; nm="minmax"; rc="20"; cm="2" },
  @{ n="Q_lin20";      q=$true;  flags=@("--rerank");          fu="linear"; nm="minmax"; rc="20"; cm="2" }
)

foreach ($r in $runs) {
  podman exec examples-db-1 psql -U user -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname LIKE 'arrag_bench%' AND pid <> pg_backend_pid();" 2>&1 | Out-Null
  $env:FUSION = $r.fu; $env:NORMALIZER = $r.nm; $env:CANDIDATE_MULTIPLIER = $r.cm
  if ($r.rc) { $env:RERANK_CANDIDATES = $r.rc } else { Remove-Item Env:RERANK_CANDIDATES -ErrorAction SilentlyContinue }
  $flags = $r.flags
  if ($r.q) { $flags = $flags + "--include-question" }
  $log = "$out\$($r.n).log"
  "=== $($r.n): q=$($r.q) flags=$($flags -join ' ') FUSION=$($r.fu) NORM=$($r.nm) RC=$($r.rc) CM=$($r.cm) ===" | Out-File -Append -Encoding utf8 $sum
  $t = Measure-Command { bun run examples/benchmark/run.ts @flags *>&1 | Out-File -Encoding utf8 $log }
  $corpusline = (Select-String -Path $log -Pattern 'Loaded corpus \(([^)]+)\)' | Select-Object -First 1).Matches.Groups[1].Value
  $counts = Select-String -Path $log -Pattern 'rerankInputCount: (\d+)' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value }
  $maxc = if ($counts) { ($counts | Measure-Object -Maximum).Maximum } else { "n/a" }
  $avgc = if ($counts) { [math]::Round(($counts | Measure-Object -Average).Average,1) } else { "n/a" }
  $cmp  = (Select-String -Path $log -Pattern '^\s+(custom|msa|saudi|darija)\s' | ForEach-Object { $_.Line }) -join "`n"
  ("  corpus={0} | elapsed {1}s | rerankInput avg={2} max={3}`n{4}" -f $corpusline, [math]::Round($t.TotalSeconds,1), $avgc, $maxc, $cmp) | Out-File -Append -Encoding utf8 $sum
}
"QUESTION-IN-CONTENT A/B DONE" | Out-File -Append -Encoding utf8 $sum
Write-Output "Done. Summary: $out\_summary.txt"
