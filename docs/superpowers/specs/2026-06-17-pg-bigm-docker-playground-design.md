# pg_bigm Docker + Playground Integration

**Date:** 2026-06-17
**Status:** Approved

## Goal

Add pg_bigm to the custom Docker image so CJK (Chinese, Japanese, Korean) keyword search works out of the box in local dev, and wire a `--cjk` flag into the playground to demonstrate bigram keyword search alongside the existing `--vectorchord` and `--bm25` flags.

pg_bigm is already fully supported by the library (`{ cjk: true }` in `ragMigrate` and `PostgresRagDatabase`). This work is entirely infrastructure + demonstration — no changes to library source code.

## Scope

Five files change. Library source (`src/`) is untouched.

---

## File Changes

### 1. `examples/Dockerfile`

**New ARG:** `PG_BIGM_VERSION=1.2-20240606`

**New stage — `pg_bigm_builder`:**
- Base: `tensorchord/vchord-postgres:${VCHORD_TAG}` (same as final stage — ensures `pg_config` resolves to PG17)
- Installs: `build-essential`, `postgresql-server-dev-17`, `ca-certificates`, `curl`
- Downloads: source tarball from `https://github.com/pgbigm/pg_bigm/archive/refs/tags/v${PG_BIGM_VERSION}.tar.gz`
- Builds: `make USE_PGXS=1 && make USE_PGXS=1 install`
- Result: pg_bigm artifacts are installed inside the builder image at the standard PG17 paths

**Final stage additions:**
```dockerfile
COPY --from=pg_bigm_builder /usr/lib/postgresql/17/lib/pg_bigm.so \
                             /usr/lib/postgresql/17/lib/
COPY --from=pg_bigm_builder /usr/share/postgresql/17/extension/pg_bigm* \
                             /usr/share/postgresql/17/extension/
```

**LABEL update:** append `+ pg_bigm ${PG_BIGM_VERSION}` to the description.

Stage order: `downloader` (pg_textsearch .deb) → `pg_bigm_builder` → final. Both builder stages are independent and can be cached in parallel by Docker BuildKit.

---

### 2. `examples/docker-compose.yml`

Update the `shared_preload_libraries` command arg:
```
shared_preload_libraries=vchord,pg_textsearch,pg_bigm
```

No other changes. The compose file is for local dev and always loads all three extensions.

---

### 3. `examples/playground.ts`

#### Flag
```typescript
const USE_CJK = process.argv.includes("--cjk");
```

#### Migration
```typescript
await ragMigrate(sqlClient, {
  sqlDir: ...,
  vectorchord: USE_VECTORCHORD,
  bm25: USE_BM25,
  cjk: USE_CJK,           // ← new
});
```
Console log: `vectorchord=${USE_VECTORCHORD}, bm25=${USE_BM25}, cjk=${USE_CJK}`

#### Database adapter
```typescript
const db = new PostgresRagDatabase(txProvider, {
  ...(USE_BM25 ? { fts: new Bm25Fts() } : {}),
  ...(USE_CJK  ? { cjk: true }          : {}),
});
```

#### New sample data — `PRODUCTS_JA`
Two products in Japanese (`lang: "ja"`):
1. **象印 炎舞炊き NW-FB10 炊飯器** — IH rice cooker, features, pricing in JPY
2. **カシオ G-SHOCK GW-M5610** — solar atomic watch, features, pricing in JPY

#### New sample data — `FAQ_JA`
Two FAQs in Japanese:
1. 返品ポリシー (return policy)
2. 支払い方法 (payment methods — credit cards, convenience store payment, PayPay)

#### `seedStopWords` addition
Japanese stop words for `ja`: の、は、が、を、に、で、と、から、まで、て、た、な、だ、です、ます、する、した、ある、いる、など、も、や、か、この、その

#### `seedSynonyms` addition
Japanese synonyms:
- 炊飯器 ↔ ライスクッカー、炊飯機
- 時計 ↔ ウォッチ、腕時計
- 価格 ↔ 値段、料金

#### Indexing loop
Add `...PRODUCTS_JA.map((p) => ({ ...p, lang: "ja" }))` and `...FAQ_JA.map((f) => ({ ...f, lang: "ja" }))` to the existing loops.

#### Queries — 4 new Japanese entries
```
{ q: "炊飯器 IH圧力",        lang: "ja", desc: "JA product keyword" }
{ q: "防水 ソーラー時計",     lang: "ja", desc: "JA product semantic" }
{ q: "返品できますか",        lang: "ja", desc: "JA FAQ keyword" }
{ q: "クレジットカード使えますか", lang: "ja", desc: "JA FAQ semantic" }
```

#### Comment update
Chinese query block comment: `// Chinese (use --cjk for pg_bigm bigram keyword search)`
Japanese query block comment: `// Japanese (use --cjk for pg_bigm bigram keyword search)`

---

### 4. `README.md`

Add `#### pg_bigm — CJK keyword search` inside the `### Optional extensions` section, after the "Using both together" subsection.

Contents:
- What it does: replaces `word_similarity` (pg_trgm) with `bigm_similarity` in the keyword leg for `zh`, `zh-CN`, `ja`, `ja-JP`, `ko`, `ko-KR` — other languages continue using pg_trgm
- Why: CJK scripts have no whitespace between words; pg_trgm produces near-zero scores; bigrams over character pairs work regardless of word boundaries
- Step 1: Install — build from source; `examples/Dockerfile` automates this
- Step 2: `shared_preload_libraries = 'pg_bigm'`
- Step 3: `await ragMigrate(sqlClient, { cjk: true })`
- Step 4: `new PostgresRagDatabase(txProvider, { cjk: true })`
- Note: Does not affect the vector or FTS legs; does not help Hindi/Arabic (those have whitespace, pg_trgm is appropriate)

---

### 5. `CLAUDE.md`

In the `### Playground setup` section, add `--cjk` to the flags example line:
```bash
bun run examples/playground.ts --vectorchord --bm25 --cjk   # all optional extensions
```

---

## Out of Scope

- Korean sample data (Japanese covers the demonstration; Korean follows the same code path)
- Hindi/Arabic bigm (pg_trgm is correct for whitespace-delimited scripts)
- Library source changes (`src/` untouched — `cjk: true` support already exists)

---

## Testing

No automated tests needed for this change (Dockerfile and playground are dev tooling, not library code). Manual verification: `podman compose up -d` with the rebuilt image, then `bun run examples/playground.ts --cjk` should show Japanese and Chinese keyword results using bigram similarity instead of trigram.
