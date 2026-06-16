# Custom Postgres image: VectorChord (vchord) + pg_textsearch (BM25).
# Base: tensorchord/vchord-postgres (ships pgvector + vchord).
# Adds: timescale/pg_textsearch pre-built .deb from GitHub releases.
#
# Build (single-arch, host platform):
#   docker build -t pg-hybrid-rag-db examples/
#   podman build -t pg-hybrid-rag-db examples/
#
# Multi-platform:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t pg-hybrid-rag-db examples/

ARG VCHORD_TAG=pg17-v0.4.3
ARG PG_TEXTSEARCH_VERSION=1.3.0

# ── Stage 1: download the pre-built .deb for the target arch ────────────────
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

# ── Stage 2: install into vchord-postgres ───────────────────────────────────
FROM tensorchord/vchord-postgres:${VCHORD_TAG}
ARG PG_TEXTSEARCH_VERSION
LABEL org.opencontainers.image.description="pgvector + VectorChord (vchord) + pg_textsearch ${PG_TEXTSEARCH_VERSION}"
COPY --from=downloader /tmp/pg_textsearch/*.deb /tmp/pg_textsearch.deb
RUN apt-get update \
    && apt-get install -y /tmp/pg_textsearch.deb \
    && rm /tmp/pg_textsearch.deb \
    && rm -rf /var/lib/apt/lists/*
