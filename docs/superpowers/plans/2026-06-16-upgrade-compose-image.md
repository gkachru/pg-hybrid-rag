# Upgrade Compose Image to VectorChord + pg_textsearch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `examples/docker-compose.yml` to use the `tensorchord/vchord-postgres` image so VectorChord and pg_textsearch are available out of the box, and remove the now-redundant `docker-compose.extensions.yml`.

**Architecture:** Replace the `pgvector/pgvector:pg17` image in the main compose file with `tensorchord/vchord-postgres:pg17-v0.4.3` (which ships pgvector + vchord + pg_textsearch), add the `command` block to enable `shared_preload_libraries=vchord,pg_textsearch`, and delete `docker-compose.extensions.yml`. Update README to reflect that `--vectorchord` and `--bm25` playground flags now work against the single default compose file.

**Tech Stack:** Docker/Podman Compose, `tensorchord/vchord-postgres:pg17-v0.4.3` OCI image, Markdown.

---

### Task 1: Update `examples/docker-compose.yml` to use the VectorChord image

**Files:**
- Modify: `examples/docker-compose.yml`

Current `db` service uses `pgvector/pgvector:pg17` with no `command` override.
New image bundles pgvector + vchord + pg_textsearch. The `command` block is required to set `shared_preload_libraries` before Postgres starts — without it `CREATE EXTENSION vchord` and `CREATE EXTENSION pg_textsearch` will fail.

- [ ] **Step 1: Apply the change**

Replace the `db` service block (lines 18–40) with:

```yaml
  db:
    # tensorchord/vchord-postgres bundles pgvector, VectorChord (vchord), and
    # pg_textsearch. The command block sets shared_preload_libraries so all three
    # extensions are available. pg_trgm ships with Postgres contrib and needs no
    # shared_preload entry. CJK support via pg_bigm is NOT in this image.
    image: tensorchord/vchord-postgres:pg17-v0.4.3
    command:
      - postgres
      - -c
      - shared_preload_libraries=vchord,pg_textsearch
    ports:
      - "5432:5432"
    environment:
      # Matches DATABASE_URL in .env.example:
      #   postgresql://user:password@localhost:5432/postgres
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=postgres
    volumes:
      - pg-data:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
```

Also update the top-of-file comment block (lines 1–17) to reflect the new image:

```yaml
# Local infra for the pg-hybrid-rag playground:
#   - db:        PostgreSQL with pgvector, VectorChord (vchord), and pg_textsearch
#   - embedding: self-hosted embedding API via HuggingFace TEI
#
# Usage (Docker or Podman):
#   EMBEDDING_API_KEY=your-key docker compose up
#   EMBEDDING_API_KEY=your-key podman compose up
#
# The db image (tensorchord/vchord-postgres) bundles pgvector, vchord, and
# pg_textsearch. shared_preload_libraries is set via the command override so all
# three extensions are available without a separate compose file.
#
# Playground flags:
#   bun run examples/playground.ts --vectorchord   # uses vchordrq index
#   bun run examples/playground.ts --bm25          # uses pg_textsearch BM25
#   bun run examples/playground.ts --vectorchord --bm25
#
# TEI downloads the model from HuggingFace on first start.
# The hf-cache volume persists it across restarts.
#
# Production note:
#   For production, use a GPU image (ghcr.io/huggingface/text-embeddings-inference:1.9)
#   or a quantized ONNX model (e.g. onnx/model_qint8_avx512_vnni.onnx from
#   https://huggingface.co/intfloat/multilingual-e5-small) on appropriate Intel
#   CPUs with AVX-512 VNNI support.
```

- [ ] **Step 2: Verify the file looks correct**

Run:
```bash
cat examples/docker-compose.yml
```
Expected: `image: tensorchord/vchord-postgres:pg17-v0.4.3` appears under the `db` service, `shared_preload_libraries=vchord,pg_textsearch` is in the `command` block, and no references to `pgvector/pgvector` remain.

- [ ] **Step 3: Commit**

```bash
git add examples/docker-compose.yml
git commit -m "chore: upgrade compose db image to tensorchord/vchord-postgres:pg17-v0.4.3"
```

---

### Task 2: Remove the now-redundant `docker-compose.extensions.yml`

**Files:**
- Delete: `examples/docker-compose.extensions.yml`

This file was created specifically to run the playground with `--vectorchord` / `--bm25` using an extensions-enabled image. With Task 1 done, the main `docker-compose.yml` now provides the same image and `shared_preload_libraries` config, so `docker-compose.extensions.yml` is a direct duplicate.

- [ ] **Step 1: Delete the file**

```bash
git rm examples/docker-compose.extensions.yml
```

- [ ] **Step 2: Verify it's gone**

```bash
ls examples/
```
Expected: only `docker-compose.yml`, `.env.example`, `playground.ts`, and the `nestjs-*.ts` example files.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove docker-compose.extensions.yml — superseded by upgraded docker-compose.yml"
```

---

### Task 3: Update README.md to document the unified compose setup

**Files:**
- Modify: `README.md`

The README's "VectorChord" and "pg_textsearch" section (around line 289) describes `shared_preload_libraries` as a manual ops step. It should now mention that `examples/docker-compose.yml` handles this automatically for local dev. The "Default Adapters" bullet (line 401) already links to `docker-compose.yml` — the link stays but the surrounding prose needs a note about extensions.

- [ ] **Step 1: Find the extensions section**

Run:
```bash
grep -n "VectorChord\|shared_preload\|docker-compose" README.md | head -30
```

- [ ] **Step 2: Update the VectorChord subsection**

Locate the paragraph around line 290:
> Both extensions require adding them to `shared_preload_libraries` in `postgresql.conf` and restarting Postgres.

Add a local-dev callout immediately after that sentence (before the code block showing `shared_preload_libraries = 'vchord'`):

```markdown
For local development, `examples/docker-compose.yml` uses the `tensorchord/vchord-postgres` image with `shared_preload_libraries` already configured — no manual config change needed. Just start the compose stack and run the playground with the flags below.
```

- [ ] **Step 3: Update or add the playground flags callout**

After the callout above, confirm there is (or add) a short usage block showing both flags together, e.g.:

```markdown
```bash
# Start the stack
EMBEDDING_API_KEY=... podman compose up    # or docker compose up

# Run the playground with optional extension flags
bun run examples/playground.ts --vectorchord --bm25
```
```

- [ ] **Step 4: Verify README renders cleanly (spot check)**

Run:
```bash
grep -n "docker-compose\|tensorchord\|vchord\|pg_textsearch" README.md
```
Expected: references to `docker-compose.yml` still point to the right file, and there's no remaining mention of `docker-compose.extensions.yml`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: update README for unified docker-compose with vchord + pg_textsearch"
```

---

## Self-review

**Spec coverage:**
- Upgrade `docker-compose.yml` image → Task 1 ✓
- Remove redundant `docker-compose.extensions.yml` → Task 2 ✓
- Update docs (README, compose header comment) → Tasks 1 + 3 ✓

**Placeholder scan:** No TBD/TODO items. All changes are fully specified.

**Type consistency:** No TypeScript changes — this is purely infra/docs.

**Potential issue:** The `tensorchord/vchord-postgres:pg17-v0.4.3` image tag is pinned. If a newer version is released, the tag should be updated manually. This is intentional (reproducibility > latest).
