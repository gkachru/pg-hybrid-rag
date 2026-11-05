# Custom Postgres image: pgvector + VectorChord (vchord) + pg_textsearch (BM25) + pg_bigm (CJK).
# Base: pgvector/pgvector (official pgvector image on the Debian postgres image).
# Adds: VectorChord + timescale/pg_textsearch pre-built .debs, pg_bigm built from source.
#
# Why not tensorchord/vchord-postgres: its newest tag (pg17-v1.1.1) still bundles pgvector 0.8.2,
# and pgvector <= 0.8.6 has an IVFFlat index-build buffer overflow (pgvector issue #1036, fixed
# in 0.8.7). Building on the pgvector image and adding the vchord .deb is how tensorchord builds
# its own image, and lets us pin pgvector independently.
#
# Upgrading an EXISTING database across vchord versions: vchordrq's on-disk index format changes
# between releases (0.4.3 → 1.x), and an old-format index makes inserts and index scans error with
# "bad version number ... please use REINDEX". Rebuild vchordrq indexes after the upgrade (and run
# ALTER EXTENSION vector UPDATE; ALTER EXTENSION vchord UPDATE;). A fresh volume is unaffected.
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

# Pin the Debian release (-bookworm) so the base can't silently move to a newer Debian under the
# pre-built .debs below.
ARG PGVECTOR_TAG=0.8.7-pg17-bookworm
ARG VCHORD_VERSION=1.1.1
ARG PG_TEXTSEARCH_VERSION=1.5.1
ARG PG_BIGM_VERSION=1.2-20240606

# ── Stage 1: download the pre-built .debs for vchord and pg_textsearch ──────
FROM debian:bookworm-slim AS downloader
ARG VCHORD_VERSION
ARG PG_TEXTSEARCH_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
# dpkg --print-architecture returns amd64 or arm64, matching the release asset names.
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL \
        "https://github.com/tensorchord/VectorChord/releases/download/${VCHORD_VERSION}/postgresql-17-vchord_${VCHORD_VERSION}-1_${ARCH}.deb" \
        -o /tmp/vchord.deb
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL \
        "https://github.com/timescale/pg_textsearch/releases/download/v${PG_TEXTSEARCH_VERSION}/pg-textsearch-v${PG_TEXTSEARCH_VERSION}-pg17-${ARCH}.zip" \
        -o /tmp/pg_textsearch.zip \
    && unzip /tmp/pg_textsearch.zip -d /tmp/pg_textsearch \
    && rm /tmp/pg_textsearch.zip

# ── Stage 2: build pg_bigm from source ──────────────────────────────────────
# Uses the same base as the final image so pg_config resolves to the correct PG17.
FROM pgvector/pgvector:${PGVECTOR_TAG} AS pg_bigm_builder
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

# ── Stage 3: install everything into the pgvector image ─────────────────────
FROM pgvector/pgvector:${PGVECTOR_TAG}
ARG PGVECTOR_TAG
ARG VCHORD_VERSION
ARG PG_TEXTSEARCH_VERSION
ARG PG_BIGM_VERSION
LABEL org.opencontainers.image.description="pgvector ${PGVECTOR_TAG} + VectorChord ${VCHORD_VERSION} + pg_textsearch ${PG_TEXTSEARCH_VERSION} + pg_bigm ${PG_BIGM_VERSION}"
COPY --from=downloader /tmp/vchord.deb /tmp/vchord.deb
COPY --from=downloader /tmp/pg_textsearch/*.deb /tmp/pg_textsearch.deb
COPY --from=pg_bigm_builder /usr/lib/postgresql/17/lib/pg_bigm.so \
                             /usr/lib/postgresql/17/lib/
COPY --from=pg_bigm_builder /usr/share/postgresql/17/extension/pg_bigm* \
                             /usr/share/postgresql/17/extension/
RUN apt-get update \
    && apt-get install -y /tmp/vchord.deb /tmp/pg_textsearch.deb \
    && rm /tmp/vchord.deb /tmp/pg_textsearch.deb \
    && rm -rf /var/lib/apt/lists/*
