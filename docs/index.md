---
layout: home

hero:
  name: pg-hybrid-rag
  text: Hybrid retrieval for RAG, inside PostgreSQL
  tagline: Vector, keyword and full-text search over your content, fused into one ranked list. No search cluster to run, and no runtime dependencies.
  image:
    src: /logo.svg
    alt: pg-hybrid-rag logo
  actions:
    - theme: brand
      text: Build your first search
      link: /tutorials/getting-started
    - theme: alt
      text: How-to guides
      link: /how-to/
    - theme: alt
      text: View on GitHub
      link: https://github.com/gkachru/pg-hybrid-rag

features:
  - icon:
      src: /features/fusion.svg
      width: 120
      height: 72
    title: Three searches, one ranking
    details: Every query runs pgvector similarity, pg_trgm keyword matching and PostgreSQL full-text search in parallel, then merges them with Reciprocal Rank Fusion or score-based fusion.
  - icon:
      src: /features/languages.svg
      width: 120
      height: 72
    title: Many languages
    details: Per-language stemming in PostgreSQL, stop words, synonyms and text normalization. Optional pg_bigm keyword search for Chinese, Japanese and Korean.
  - icon:
      src: /features/filters.svg
      width: 120
      height: 72
    title: Typed metadata filters
    details: Attach typed, namespaced attributes to content and filter with and/or/not expressions that run inside every search, or let a language model derive the filter from the query.
  - icon:
      src: /features/tenants.svg
      width: 120
      height: 72
    title: Multi-tenant
    details: Every row belongs to a tenant. Optional row-level security policies enforce isolation in the database.
  - icon:
      src: /features/stack.svg
      width: 120
      height: 72
    title: Bring your own stack
    details: Works with postgres.js, node-postgres, Prisma or any driver; any embedding API; any reranker. You inject each one through a small interface.
  - icon:
      src: /features/extensions.svg
      width: 120
      height: 72
    title: Optional extensions
    details: Switch the full-text search to BM25 ranking with pg_textsearch (one constructor option), or the vector index to VectorChord (no code change).
---

## Install

```bash
npm install pg-hybrid-rag
```

You need PostgreSQL with the `pgvector` and `pg_trgm` extensions, and Node.js 18+ or Bun 1.0+.

## A first look

```ts
import { OpenAiCompatibleEmbedder, PostgresRagDatabase, RagPipeline } from "pg-hybrid-rag";

const db = new PostgresRagDatabase(txProvider); // your driver, wrapped in a small interface
const embedder = new OpenAiCompatibleEmbedder({
  baseUrl: "https://api.example.com/v1",
  apiKey: process.env.EMBEDDING_API_KEY ?? "",
  model: "intfloat/multilingual-e5-small",
});

const pipeline = new RagPipeline({ tenantId, db, embedder });
const results = await pipeline.search("how do I reset my password", { language: "en" });
```

## How these docs are organized

| Section | Use it when you want to |
|---|---|
| [Tutorials](/tutorials/) | Learn the library by building something that works, step by step. |
| [How-to guides](/how-to/) | Get a specific task done, such as connecting a driver or adding reranking. |
| [Reference](/reference/) | Look up a class, an option, a default or the database schema. |
| [Explanation](/explanation/) | Understand how hybrid search works and why the library is designed this way. |
