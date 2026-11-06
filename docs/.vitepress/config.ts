import { defineConfig } from "vitepress";

// Divio documentation system: tutorials (learning), how-to guides (tasks),
// reference (information), explanation (understanding).
// https://docs.divio.com/documentation-system/

const tutorials = [
  { text: "Overview", link: "/tutorials/" },
  { text: "Build your first hybrid search", link: "/tutorials/getting-started" },
  { text: "Filter results with metadata", link: "/tutorials/metadata-filters" },
];

const howTo = [
  { text: "Overview", link: "/how-to/" },
  {
    text: "Set up",
    items: [
      { text: "Prepare PostgreSQL", link: "/how-to/prepare-postgres" },
      { text: "Run migrations", link: "/how-to/run-migrations" },
      { text: "Connect your database driver", link: "/how-to/connect-database-driver" },
      { text: "Configure embeddings", link: "/how-to/configure-embeddings" },
      { text: "Isolate tenants with RLS", link: "/how-to/multi-tenancy-rls" },
    ],
  },
  {
    text: "Index content",
    items: [
      { text: "Chunk and index documents", link: "/how-to/index-documents" },
      { text: "Manage stop words and synonyms", link: "/how-to/stop-words-and-synonyms" },
    ],
  },
  {
    text: "Search",
    items: [
      { text: "Search multilingual content", link: "/how-to/multilingual-search" },
      { text: "Search Chinese, Japanese, Korean and Thai", link: "/how-to/cjk-and-segmentation" },
      { text: "Filter by metadata", link: "/how-to/filter-by-metadata" },
      { text: "Generate filters from the query", link: "/how-to/auto-filter" },
      { text: "Rerank results", link: "/how-to/rerank" },
      { text: "Tune relevance", link: "/how-to/tune-relevance" },
    ],
  },
  {
    text: "Scale and operate",
    items: [
      { text: "Use BM25 full-text search", link: "/how-to/bm25" },
      { text: "Tune the vector index", link: "/how-to/tune-vector-index" },
      { text: "Add logging and tracing", link: "/how-to/observability" },
      { text: "Go to production", link: "/how-to/production-checklist" },
    ],
  },
];

const reference = [
  { text: "Overview", link: "/reference/" },
  {
    text: "Classes",
    items: [
      { text: "RagPipeline", link: "/reference/rag-pipeline" },
      { text: "RagIndexer", link: "/reference/rag-indexer" },
      { text: "Chunker", link: "/reference/chunker" },
      { text: "PostgresRagDatabase", link: "/reference/postgres-rag-database" },
      { text: "FTS strategies", link: "/reference/fts-strategies" },
      { text: "OpenAiCompatibleEmbedder", link: "/reference/embedder" },
      { text: "Stop word and synonym loaders", link: "/reference/loaders" },
      { text: "Metadata catalog and filter model", link: "/reference/metadata-catalog" },
    ],
  },
  {
    text: "Data and contracts",
    items: [
      { text: "Attributes and filter grammar", link: "/reference/filter-grammar" },
      { text: "Interfaces", link: "/reference/interfaces" },
      { text: "Types", link: "/reference/types" },
      { text: "Utility functions", link: "/reference/utilities" },
      { text: "Errors", link: "/reference/errors" },
    ],
  },
  {
    text: "Database",
    items: [
      { text: "ragMigrate and migrations", link: "/reference/migrations" },
      { text: "Schema", link: "/reference/schema" },
      { text: "Language support", link: "/reference/languages" },
    ],
  },
];

const explanation = [
  { text: "Overview", link: "/explanation/" },
  { text: "How hybrid search works", link: "/explanation/hybrid-search" },
  { text: "Fusion and reranking", link: "/explanation/fusion-and-reranking" },
  { text: "Language processing", link: "/explanation/language-processing" },
  { text: "The metadata model", link: "/explanation/metadata-model" },
  { text: "Tenancy, connections and security", link: "/explanation/tenancy-and-security" },
  { text: "Indexes and performance", link: "/explanation/indexes-and-performance" },
  { text: "Design principles", link: "/explanation/design-principles" },
];

export default defineConfig({
  title: "pg-hybrid-rag",
  description:
    "Hybrid retrieval for RAG inside PostgreSQL: vector, trigram and full-text search fused into one ranked list.",
  base: "/pg-hybrid-rag/",
  cleanUrls: true,
  lastUpdated: true,
  // Internal design specs and plans live under docs/superpowers and are not part of the site.
  srcExclude: ["superpowers/**", "**/README.md"],
  head: [
    ["meta", { name: "theme-color", content: "#336791" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/pg-hybrid-rag/logo.svg" }],
  ],
  markdown: {
    lineNumbers: false,
  },
  themeConfig: {
    logo: { src: "/logo.svg", alt: "" },
    nav: [
      { text: "Tutorials", link: "/tutorials/", activeMatch: "/tutorials/" },
      { text: "How-to guides", link: "/how-to/", activeMatch: "/how-to/" },
      { text: "Reference", link: "/reference/", activeMatch: "/reference/" },
      { text: "Explanation", link: "/explanation/", activeMatch: "/explanation/" },
      {
        text: "v0.6.0",
        items: [
          {
            text: "Changelog",
            link: "https://github.com/gkachru/pg-hybrid-rag/blob/main/CHANGELOG.md",
          },
          { text: "npm", link: "https://www.npmjs.com/package/pg-hybrid-rag" },
        ],
      },
    ],
    sidebar: {
      "/tutorials/": [{ text: "Tutorials", items: tutorials }],
      "/how-to/": [{ text: "How-to guides", items: howTo }],
      "/reference/": [{ text: "Reference", items: reference }],
      "/explanation/": [{ text: "Explanation", items: explanation }],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/gkachru/pg-hybrid-rag" }],
    editLink: {
      pattern: "https://github.com/gkachru/pg-hybrid-rag/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: {
      message: "Released under the Apache-2.0 License.",
    },
  },
});
