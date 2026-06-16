# pg_bigm Docker + Playground Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pg_bigm to the custom Docker image and wire a `--cjk` flag into the playground to demonstrate bigram CJK keyword search with Japanese and Chinese sample data.

**Architecture:** pg_bigm is built from source in a new `pg_bigm_builder` Docker stage (same vchord-postgres base so `pg_config` resolves correctly); artifacts are copied into the final stage. docker-compose gets `pg_bigm` appended to `shared_preload_libraries`. The playground gains a `--cjk` flag that passes `{ cjk: true }` to `ragMigrate` and `PostgresRagDatabase`, plus Japanese sample products, FAQs, stop words, synonyms, and queries.

**Tech Stack:** Docker multi-stage builds, Bun/TypeScript, postgres.js, pg_bigm 1.2-20240606, existing `ragMigrate`/`PostgresRagDatabase` library APIs (no library source changes).

---

## File Map

| File | Change |
|------|--------|
| `examples/Dockerfile` | Add `pg_bigm_builder` stage + COPY artifacts into final stage + update LABEL |
| `examples/docker-compose.yml` | Append `,pg_bigm` to `shared_preload_libraries` |
| `examples/playground.ts` | Add `--cjk` flag, Japanese data, stop words, synonyms, queries |
| `README.md` | Add `#### pg_bigm — CJK keyword search` subsection |
| `CLAUDE.md` | Add `--cjk` to playground setup example |

No changes to `src/`.

---

### Task 1: Dockerfile — add pg_bigm_builder stage and copy artifacts

**Files:**
- Modify: `examples/Dockerfile`

- [ ] **Step 1: Add `PG_BIGM_VERSION` ARG and the new builder stage**

Replace the entire file with:

```dockerfile
# Custom Postgres image: VectorChord (vchord) + pg_textsearch (BM25) + pg_bigm (CJK).
# Base: tensorchord/vchord-postgres (ships pgvector + vchord).
# Adds: timescale/pg_textsearch pre-built .deb + pg_bigm built from source.
#
# Build (single-arch, host platform):
#   docker build -t pg-hybrid-rag-db examples/
#   podman build -t pg-hybrid-rag-db examples/
#
# Multi-platform:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t pg-hybrid-rag-db examples/
#
# Playground flags (all work with this single compose file):
#   bun run examples/playground.ts --vectorchord   # vchordrq index
#   bun run examples/playground.ts --bm25          # BM25 full-text search
#   bun run examples/playground.ts --cjk           # pg_bigm CJK keyword search
#   bun run examples/playground.ts --vectorchord --bm25 --cjk

ARG VCHORD_TAG=pg17-v0.4.3
ARG PG_TEXTSEARCH_VERSION=1.3.0
ARG PG_BIGM_VERSION=1.2-20240606

# ── Stage 1: download the pre-built .deb for pg_textsearch ──────────────────
FROM debian:bookworm-slim AS downloader
ARG PG_TEXTSEARCH_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
# dpkg --print-architecture returns amd64 or arm64, matching the release asset names.
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL \
        "https://github.com/timescale/pg_textsearch/releases/download/v${PG_TEXTSEARCH_VERSION}/pg-textsearch-v${PG_TEXTSEARCH_VERSION}-pg17-${ARCH}.zip" \
        -o /tmp/pg_textsearch.zip \
    && unzip /tmp/pg_textsearch.zip -d /tmp/pg_textsearch \
    && rm /tmp/pg_textsearch.zip

# ── Stage 2: build pg_bigm from source ──────────────────────────────────────
# Uses the same base as the final image so pg_config resolves to the correct PG17.
FROM tensorchord/vchord-postgres:${VCHORD_TAG} AS pg_bigm_builder
ARG PG_BIGM_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential postgresql-server-dev-17 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL \
    "https://github.com/pgbigm/pg_bigm/archive/refs/tags/v${PG_BIGM_VERSION}.tar.gz" \
    -o /tmp/pg_bigm.tar.gz \
    && tar xzf /tmp/pg_bigm.tar.gz -C /tmp \
    && cd /tmp/pg_bigm-${PG_BIGM_VERSION} \
    && make USE_PGXS=1 PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config \
    && make USE_PGXS=1 PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config install \
    && rm -rf /tmp/pg_bigm*

# ── Stage 3: install into vchord-postgres ───────────────────────────────────
FROM tensorchord/vchord-postgres:${VCHORD_TAG}
ARG PG_TEXTSEARCH_VERSION
ARG PG_BIGM_VERSION
LABEL org.opencontainers.image.description="pgvector + VectorChord (vchord) + pg_textsearch ${PG_TEXTSEARCH_VERSION} + pg_bigm ${PG_BIGM_VERSION}"
COPY --from=downloader /tmp/pg_textsearch/*.deb /tmp/pg_textsearch.deb
COPY --from=pg_bigm_builder /usr/lib/postgresql/17/lib/pg_bigm.so \
                             /usr/lib/postgresql/17/lib/
COPY --from=pg_bigm_builder /usr/share/postgresql/17/extension/pg_bigm* \
                             /usr/share/postgresql/17/extension/
RUN apt-get update \
    && apt-get install -y /tmp/pg_textsearch.deb \
    && rm /tmp/pg_textsearch.deb \
    && rm -rf /var/lib/apt/lists/*
```

---

### Task 2: docker-compose.yml — add pg_bigm to shared_preload_libraries

**Files:**
- Modify: `examples/docker-compose.yml`

- [ ] **Step 1: Append pg_bigm to the shared_preload_libraries command arg**

Find this block in `examples/docker-compose.yml`:
```yaml
    command:
      - postgres
      - -c
      - shared_preload_libraries=vchord,pg_textsearch
```

Replace with:
```yaml
    command:
      - postgres
      - -c
      - shared_preload_libraries=vchord,pg_textsearch,pg_bigm
```

- [ ] **Step 2: Commit Tasks 1–2**

```bash
git add examples/Dockerfile examples/docker-compose.yml
git commit -m "feat: add pg_bigm to custom Docker image (multi-stage source build)"
```

---

### Task 3: playground.ts — add --cjk flag and wire to migration + adapter

**Files:**
- Modify: `examples/playground.ts`

- [ ] **Step 1: Add the USE_CJK flag constant**

Find these two lines (around line 350):
```typescript
  const USE_VECTORCHORD = process.argv.includes("--vectorchord");
  const USE_BM25 = process.argv.includes("--bm25");
```

Replace with:
```typescript
  const USE_VECTORCHORD = process.argv.includes("--vectorchord");
  const USE_BM25 = process.argv.includes("--bm25");
  const USE_CJK = process.argv.includes("--cjk");
```

- [ ] **Step 2: Pass cjk to ragMigrate**

Find:
```typescript
    await ragMigrate(sqlClient, {
      sqlDir: fileURLToPath(new URL("../sql", import.meta.url)),
      vectorchord: USE_VECTORCHORD,
      bm25: USE_BM25,
    });
    console.log(
      `   Done. (vectorchord=${USE_VECTORCHORD}, bm25=${USE_BM25})\n`,
    );
```

Replace with:
```typescript
    await ragMigrate(sqlClient, {
      sqlDir: fileURLToPath(new URL("../sql", import.meta.url)),
      vectorchord: USE_VECTORCHORD,
      bm25: USE_BM25,
      cjk: USE_CJK,
    });
    console.log(
      `   Done. (vectorchord=${USE_VECTORCHORD}, bm25=${USE_BM25}, cjk=${USE_CJK})\n`,
    );
```

- [ ] **Step 3: Pass cjk to PostgresRagDatabase**

Find:
```typescript
    const db = new PostgresRagDatabase(txProvider, USE_BM25 ? { fts: new Bm25Fts() } : undefined);
```

Replace with:
```typescript
    const db = new PostgresRagDatabase(txProvider, {
      ...(USE_BM25 ? { fts: new Bm25Fts() } : {}),
      ...(USE_CJK  ? { cjk: true }          : {}),
    });
```

---

### Task 4: playground.ts — add PRODUCTS_JA and FAQ_JA constants

**Files:**
- Modify: `examples/playground.ts`

- [ ] **Step 1: Add Japanese product and FAQ data**

Find this comment and the constant that follows it (around line 288):
```typescript
// ── Chinese products & FAQs (CJK — falls back to pg_trgm without pg_bigm) ──
```

Replace with:
```typescript
// ── Chinese products & FAQs (CJK — use --cjk for pg_bigm bigram keyword search) ──
```

Then find the closing of `FAQ_ZH` (the array ending around line 326) and add the following immediately after it:

```typescript

// ── Japanese products & FAQs (CJK — use --cjk for pg_bigm bigram keyword search) ─

const PRODUCTS_JA = [
  {
    id: "00000000-0000-0000-0000-000000000051",
    name: "象印 炎舞炊き NW-FB10",
    brand: "象印",
    text: `象印 炎舞炊き NW-FB10 IH炊飯ジャー。独自の「炎舞炊き」技術で、まるでかまどで炊いたようなふっくらもちもちのご飯が炊けます。5.5合炊き。

主な機能：豪炎かまどIH、スチームセンサー、豊潤保温（40時間）、タイマー炊飯（2回分）、少量高速炊飯コース。内なべ：「黒まる厚鉄鍋」6層遠赤塗装。

価格：¥44,800。カラー：黒漆・白漆。付属品：しゃもじ・計量カップ。保証期間：本体1年、内なべ3年。`,
  },
  {
    id: "00000000-0000-0000-0000-000000000052",
    name: "カシオ G-SHOCK GW-M5610",
    brand: "カシオ",
    text: `カシオ G-SHOCK GW-M5610 タフソーラー電波時計。世界6局の電波を受信して自動時刻修正。太陽光と室内光で発電するソーラーシステム搭載。電池交換不要。

スペック：耐衝撃構造、20気圧防水、ストップウォッチ（1/100秒）、タイマー、世界時計（31タイムゾーン）、LEDバックライト。サイズ：48.9×43.2×12.7mm、重量：51g。

価格：¥19,800。カラー：ブラック、シルバー、ブルー。保証期間：1年間。電波受信局：日本（60kHz/40kHz）、アメリカ、イギリス、ドイツ、中国。`,
  },
];

const FAQ_JA = [
  {
    id: "00000000-0000-0000-0000-f00000000051",
    text: `返品・交換ポリシーについて。商品到着後8日以内であれば未使用・未開封品に限り返品を承ります。お客様都合の返品は送料お客様負担となります。初期不良・破損の場合は送料当社負担で交換対応いたします。食品・消耗品・デジタルコンテンツは返品不可です。返金は確認後5〜7営業日以内に処理いたします。`,
  },
  {
    id: "00000000-0000-0000-0000-f00000000052",
    text: `ご利用いただける支払い方法。クレジットカード（Visa、Mastercard、JCB、アメックス）、デビットカード、コンビニ払い（セブンイレブン、ローソン、ファミリーマート）、銀行振込、代金引換、PayPay、楽天ペイ、d払いがご利用いただけます。3,000円以上のお買い物でクレジットカードの分割払い（3回・6回・12回）が可能です。`,
  },
];
```

---

### Task 5: playground.ts — add Japanese stop words and synonyms

**Files:**
- Modify: `examples/playground.ts`

- [ ] **Step 1: Add Japanese stop words**

In `seedStopWords`, find the closing of the `zh` entry:
```typescript
    zh: [
      "的",
      ...
      "怎么",
    ],
```

Add a `ja` entry immediately after:
```typescript
    ja: [
      "の",
      "は",
      "が",
      "を",
      "に",
      "で",
      "と",
      "から",
      "まで",
      "て",
      "た",
      "な",
      "だ",
      "です",
      "ます",
      "する",
      "した",
      "ある",
      "いる",
      "など",
      "も",
      "や",
      "か",
      "この",
      "その",
      "について",
      "できます",
    ],
```

Also update the console log line at the end of `seedStopWords`:
```typescript
  console.log(`   Seeded ${total} stop words (${Object.keys(stopWords).join(", ")})`);
```
(This already dynamically lists all keys, so no text change needed — the output will automatically include `ja`.)

- [ ] **Step 2: Add Japanese synonyms**

In `seedSynonyms`, find the closing Spanish synonym entry:
```typescript
    {
      lang: "es",
      term: "pago",
      synonyms: ["abono", "cancelación"],
      direction: "two_way",
    },
```

Add Japanese synonyms immediately after:
```typescript
    // Japanese
    {
      lang: "ja",
      term: "炊飯器",
      synonyms: ["ライスクッカー", "炊飯機", "ご飯炊き"],
      direction: "two_way",
    },
    {
      lang: "ja",
      term: "時計",
      synonyms: ["ウォッチ", "腕時計", "クロック"],
      direction: "two_way",
    },
    {
      lang: "ja",
      term: "価格",
      synonyms: ["値段", "料金", "費用"],
      direction: "two_way",
    },
```

Also update the console.log in `seedSynonyms`:
```typescript
  console.log(`   Seeded ${synonyms.length} synonym mappings (en, hi, ar, es, ja)`);
```

---

### Task 6: playground.ts — add Japanese to indexing loops and query list

**Files:**
- Modify: `examples/playground.ts`

- [ ] **Step 1: Add Japanese products to the indexing loop**

Find:
```typescript
    const allProducts: Array<{
      id: string;
      name: string;
      brand: string;
      text: string;
      lang: string;
    }> = [
      ...PRODUCTS.map((p) => ({ ...p, lang: "en" })),
      ...PRODUCTS_HI.map((p) => ({ ...p, lang: "hi" })),
      ...PRODUCTS_AR.map((p) => ({ ...p, lang: "ar" })),
      ...PRODUCTS_ES.map((p) => ({ ...p, lang: "es" })),
      ...PRODUCTS_ZH.map((p) => ({ ...p, lang: "zh" })),
    ];
```

Replace with:
```typescript
    const allProducts: Array<{
      id: string;
      name: string;
      brand: string;
      text: string;
      lang: string;
    }> = [
      ...PRODUCTS.map((p) => ({ ...p, lang: "en" })),
      ...PRODUCTS_HI.map((p) => ({ ...p, lang: "hi" })),
      ...PRODUCTS_AR.map((p) => ({ ...p, lang: "ar" })),
      ...PRODUCTS_ES.map((p) => ({ ...p, lang: "es" })),
      ...PRODUCTS_ZH.map((p) => ({ ...p, lang: "zh" })),
      ...PRODUCTS_JA.map((p) => ({ ...p, lang: "ja" })),
    ];
```

- [ ] **Step 2: Add Japanese FAQs to the FAQ indexing loop**

Find:
```typescript
    const allFaqs: Array<{ id: string; text: string; lang: string }> = [
      ...FAQ_ENTRIES.map((f) => ({ ...f, lang: "en" })),
      ...FAQ_HI.map((f) => ({ ...f, lang: "hi" })),
      ...FAQ_AR.map((f) => ({ ...f, lang: "ar" })),
      ...FAQ_ES.map((f) => ({ ...f, lang: "es" })),
      ...FAQ_ZH.map((f) => ({ ...f, lang: "zh" })),
    ];
```

Replace with:
```typescript
    const allFaqs: Array<{ id: string; text: string; lang: string }> = [
      ...FAQ_ENTRIES.map((f) => ({ ...f, lang: "en" })),
      ...FAQ_HI.map((f) => ({ ...f, lang: "hi" })),
      ...FAQ_AR.map((f) => ({ ...f, lang: "ar" })),
      ...FAQ_ES.map((f) => ({ ...f, lang: "es" })),
      ...FAQ_ZH.map((f) => ({ ...f, lang: "zh" })),
      ...FAQ_JA.map((f) => ({ ...f, lang: "ja" })),
    ];
```

- [ ] **Step 3: Add Japanese queries**

Find the Chinese query block:
```typescript
      // Chinese (CJK — pg_trgm fallback without pg_bigm)
      { q: "小米手机拍照", lang: "zh", desc: "ZH product search" },
      { q: "无人机续航时间", lang: "zh", desc: "ZH keyword" },
      { q: "退货政策", lang: "zh", desc: "ZH FAQ" },
      { q: "支持微信支付吗", lang: "zh", desc: "ZH FAQ semantic" },
```

Replace with:
```typescript
      // Chinese (CJK — use --cjk for pg_bigm bigram keyword search)
      { q: "小米手机拍照", lang: "zh", desc: "ZH product search" },
      { q: "无人机续航时间", lang: "zh", desc: "ZH keyword" },
      { q: "退货政策", lang: "zh", desc: "ZH FAQ" },
      { q: "支持微信支付吗", lang: "zh", desc: "ZH FAQ semantic" },
      // Japanese (CJK — use --cjk for pg_bigm bigram keyword search)
      { q: "IH圧力炊飯器", lang: "ja", desc: "JA product keyword" },
      { q: "防水 ソーラー電波時計", lang: "ja", desc: "JA product semantic" },
      { q: "返品できますか", lang: "ja", desc: "JA FAQ keyword" },
      { q: "クレジットカードで支払えますか", lang: "ja", desc: "JA FAQ semantic" },
```

- [ ] **Step 4: Commit Tasks 3–6**

```bash
git add examples/playground.ts
git commit -m "feat: add --cjk flag to playground with Japanese sample data and queries"
```

---

### Task 7: README.md — add pg_bigm section under Optional extensions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the pg_bigm subsection after "Using both together"**

Find the end of the "Using both together" subsection (the line after the closing code block):
```
This gives you VectorChord's faster ANN search on the vector leg combined with BM25's better-calibrated scoring on the FTS leg.
```

Add the following immediately after it:

```markdown

---

#### pg_bigm — CJK keyword search

pg_bigm adds bigram-based keyword matching for Chinese, Japanese, and Korean. Without it, the keyword leg falls back to pg_trgm `word_similarity`, which produces near-zero scores for CJK text because there are no whitespace word boundaries. pg_bigm operates on character pairs and works regardless of word boundaries.

**Does not help Hindi or Arabic** — those scripts have whitespace, so pg_trgm is appropriate and pg_bigm provides no advantage.

**Step 1 — install the extension.**
Build from source against your Postgres installation. `examples/Dockerfile` automates this as a dedicated `pg_bigm_builder` stage — the built `.so` and `.control` files are copied into the final image.

**Step 2 — add to `shared_preload_libraries` and restart.**

```
# postgresql.conf
shared_preload_libraries = 'pg_bigm'
```

**Step 3 — apply the migration.**

```typescript
import { ragMigrate } from "pg-hybrid-rag";

await ragMigrate(sqlClient, { cjk: true });
// Creates idx_rag_content_bigm — GIN index using gin_bigm_ops on rag_documents.content
```

**Step 4 — enable on the database adapter.**

```typescript
const db = new PostgresRagDatabase(txProvider, { cjk: true });
```

When `cjk: true`, the keyword leg uses `bigm_similarity($2, content)` instead of `word_similarity($2, content)` for queries where `language` is `zh`, `zh-CN`, `ja`, `ja-JP`, `ko`, or `ko-KR`. All other languages continue using pg_trgm regardless of this flag.

**Using all three optional extensions together:**

```typescript
await ragMigrate(sqlClient, { vectorchord: true, bm25: true, cjk: true });

const db = new PostgresRagDatabase(txProvider, {
  fts: new Bm25Fts(),
  cjk: true,
});
```
```

---

### Task 8: CLAUDE.md — update playground setup

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add --cjk to the flags example**

Find:
```bash
bun run examples/playground.ts --vectorchord --bm25   # with optional extensions
```

Replace with:
```bash
bun run examples/playground.ts --vectorchord --bm25 --cjk   # all optional extensions
```

- [ ] **Step 2: Commit Tasks 7–8**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document pg_bigm optional extension and --cjk playground flag"
```

---

## Self-Review

**Spec coverage:**
- ✅ Dockerfile: `pg_bigm_builder` stage, COPY artifacts, update LABEL — Task 1
- ✅ docker-compose.yml: `pg_bigm` added to `shared_preload_libraries` — Task 2
- ✅ `--cjk` flag → `ragMigrate` + `PostgresRagDatabase` — Task 3
- ✅ `PRODUCTS_JA` + `FAQ_JA` data — Task 4
- ✅ Japanese stop words + synonyms — Task 5
- ✅ Japanese indexing loops + queries + comment updates — Task 6
- ✅ README pg_bigm section — Task 7
- ✅ CLAUDE.md `--cjk` flag — Task 8

**Placeholder scan:** No TBDs, all code complete.

**Type consistency:** `USE_CJK` introduced in Task 3 Step 1, used in Steps 2 and 3 of the same task. `PRODUCTS_JA`/`FAQ_JA` introduced in Task 4, consumed in Task 6 — consistent naming throughout.
