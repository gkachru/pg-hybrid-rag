# Prepare PostgreSQL

This guide gets a PostgreSQL server ready for pg-hybrid-rag: the two required extensions, the three optional ones, the `shared_preload_libraries` setting the optional ones need, and the example container image that bundles all of them.

## What you need

| Extension | Required | Used by | Preload required | Migration option |
| --- | --- | --- | --- | --- |
| pgvector (`vector`) | Yes | Vector leg (`<=>` cosine distance), IVFFlat index | No | Always applied (migration 001) |
| `pg_trgm` | Yes | Keyword leg (`word_similarity`, GIN trigram index) | No | Always applied (migration 001) |
| VectorChord (`vchord`) | No | `vchordrq` vector index in place of IVFFlat | Yes (`vchord`) | `vectorchord: true` |
| pg_textsearch | No | BM25 full-text leg (`Bm25Fts`) | Yes (`pg_textsearch`) | `bm25: true` |
| pg_bigm | No | Keyword leg for Chinese, Japanese and Korean | Not required by the library; the example image preloads it | `cjk: true` |

Other requirements:

- **PostgreSQL 13 or later.** Migration 002 uses `gen_random_uuid()`, which is built in from PostgreSQL 13. The example image uses PostgreSQL 17.
- **pgvector 0.8.7 or later is recommended.** pgvector 0.8.6 and earlier have an IVFFlat index-build buffer overflow ([pgvector#1036](https://github.com/pgvector/pgvector/issues/1036)). The `ivfflatIterativeScan` option also relies on pgvector 0.8 iterative index scans.
- `pg_trgm` ships in the standard PostgreSQL contrib modules, so most installations already have it.

Choose one of the two paths below.

## Option A: use the example image

The repository's [`examples/Dockerfile`](https://github.com/gkachru/pg-hybrid-rag/blob/main/examples/Dockerfile) builds PostgreSQL 17 with pgvector 0.8.7, VectorChord 1.1.1, pg_textsearch 1.5.1 and pg_bigm. It starts from `pgvector/pgvector:0.8.7-pg17-bookworm`, installs the VectorChord and pg_textsearch release packages, and compiles pg_bigm from source.

1. Download `examples/Dockerfile` from the repository and build it:

   ```bash
   docker build -t pg-hybrid-rag-db .
   # or: podman build -t pg-hybrid-rag-db .
   ```

2. Run it with all three optional libraries preloaded. A minimal Compose service:

   ```yaml
   services:
     db:
       image: pg-hybrid-rag-db:latest
       command: ["postgres", "-c", "shared_preload_libraries=vchord,pg_textsearch,pg_bigm"]
       ports:
         - "5432:5432"
       environment:
         - POSTGRES_USER=app
         - POSTGRES_PASSWORD=change-me
         - POSTGRES_DB=app
       volumes:
         - pg-data:/var/lib/postgresql/data
   volumes:
     pg-data:
   ```

   The repository's [`examples/docker-compose.yml`](https://github.com/gkachru/pg-hybrid-rag/blob/main/examples/docker-compose.yml) is a fuller version that also runs a local embedding server.

3. Continue with [Run migrations](/how-to/run-migrations).

::: tip
With all three libraries preloaded, you can enable VectorChord, BM25 or CJK support later with a migration flag and no restart.
:::

## Option B: prepare an existing server

1. **Install pgvector.** Use your platform's package (for example `postgresql-17-pgvector` from the PostgreSQL apt repository) or build it from source. Check the version after installing:

   ```sql
   SELECT name, default_version, installed_version
   FROM pg_available_extensions
   WHERE name IN ('vector', 'pg_trgm', 'vchord', 'pg_textsearch', 'pg_bigm');
   ```

2. **Install the optional extensions you plan to use.**
   - VectorChord: install the release package for your platform from the [VectorChord releases](https://github.com/tensorchord/VectorChord/releases) (the example image uses the `.deb`). Check the pgvector version of the prebuilt `tensorchord/vchord-postgres` image before using it: its `pg17-v1.1.1` tag bundles pgvector 0.8.2.
   - pg_textsearch: install the package from the [pg_textsearch releases](https://github.com/timescale/pg_textsearch/releases).
   - pg_bigm: build from source (needs a compiler and the PostgreSQL server headers, for example `build-essential` and `postgresql-server-dev-17`):

     ```bash
     curl -fsSL https://github.com/pgbigm/pg_bigm/archive/refs/tags/v1.2-20240606.tar.gz | tar xz
     cd pg_bigm-1.2-20240606
     make USE_PGXS=1 && sudo make USE_PGXS=1 install
     ```

3. **Add the optional libraries to `shared_preload_libraries` and restart.** Keep any libraries already in the list:

   ```sql
   SHOW shared_preload_libraries;
   ALTER SYSTEM SET shared_preload_libraries = 'vchord,pg_textsearch,pg_bigm';
   ```

   `ALTER SYSTEM` takes effect only after a server restart. VectorChord and pg_textsearch must be preloaded, so add every library you plan to use at the same time and restart once.

4. **Grant extension rights, or create the extensions in advance.** The migrations run `CREATE EXTENSION IF NOT EXISTS` for `vector` and `pg_trgm` (always), `pg_bigm` (`cjk`), `vchord` (`vectorchord`, with `CASCADE`) and `pg_textsearch` (`bm25`). If the role that runs migrations can't create extensions, have a superuser create them once; the migration statements then do nothing:

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   -- Only the ones you enable:
   CREATE EXTENSION IF NOT EXISTS vchord CASCADE;
   CREATE EXTENSION IF NOT EXISTS pg_textsearch;
   CREATE EXTENSION IF NOT EXISTS pg_bigm;
   ```

5. Continue with [Run migrations](/how-to/run-migrations).

### Managed PostgreSQL

On a managed service, check the provider's list of supported extensions and whether you can change `shared_preload_libraries`. The required pair (`vector`, `pg_trgm`) is enough for the default configuration. VectorChord and pg_textsearch need preloading, so you can use them only where the provider offers them.

## Upgrade extensions on an existing database

- **pgvector:** after installing new binaries, run `ALTER EXTENSION vector UPDATE;` in each database.
- **VectorChord:** the `vchordrq` on-disk format changes between releases (for example 0.4.x to 1.x). After you swap the binaries, every insert and every vector search fails with `bad version number ... please use REINDEX` until the index is rebuilt. Run:

  ```sql
  ALTER EXTENSION vchord UPDATE;
  REINDEX INDEX idx_rag_embedding_vchordrq;
  ```

  Alternatively, drop the index before the upgrade and recreate it afterwards. A fresh data volume is unaffected.

## Related

- [Run migrations](/how-to/run-migrations)
- [Use BM25 full-text search](/how-to/bm25)
- [Tune the vector index](/how-to/tune-vector-index)
- [Search Chinese, Japanese, Korean and Thai](/how-to/cjk-and-segmentation)
- [Migrations reference](/reference/migrations)
- [Indexes and performance](/explanation/indexes-and-performance)
