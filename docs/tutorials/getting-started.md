# Build your first hybrid search

In this tutorial you build a small help-center search with pg-hybrid-rag. You start PostgreSQL
and a local embedding server, create the schema, index six articles, and run searches against
them. Along the way you see how the library combines three search techniques into one ranked
list.

It takes about 20 minutes. You don't need an API key or any cloud account.

## What you need

- Docker or Podman, with Compose.
- [Bun](https://bun.sh) 1.0 or later, or Node.js 18 or later.
- About 1 GB of free disk space for the database and embedding model images.

## Step 1: Start PostgreSQL and an embedding server

Create a folder for the tutorial and save this file in it as `docker-compose.yml`:

```yaml
services:
  db:
    image: pgvector/pgvector:0.8.7-pg17
    environment:
      POSTGRES_USER: rag
      POSTGRES_PASSWORD: rag
      POSTGRES_DB: rag
    ports:
      - "5433:5432"

  embeddings:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-1.9
    command: ["--model-id", "intfloat/multilingual-e5-small"]
    ports:
      - "8080:80"
```

The `db` service is PostgreSQL 17 with the pgvector extension. The `embeddings` service runs
Hugging Face Text Embeddings Inference with the `multilingual-e5-small` model, which turns text
into 384-dimensional vectors. The database listens on port 5433 so it doesn't clash with a
PostgreSQL server you may already run on 5432.

Start both services:

```bash
docker compose up -d
```

The first start downloads the model, which takes a minute or two. When this command prints
`200`, the embedding server is ready:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/health
```

## Step 2: Create the project

In the same folder, create a TypeScript project and install the library together with
[postgres.js](https://github.com/porsager/postgres), the database driver used in this tutorial.

::: code-group

```bash [Bun]
bun init -y
bun add pg-hybrid-rag postgres
```

```bash [Node.js]
npm init -y
npm pkg set type=module
npm install pg-hybrid-rag postgres
npm install -D tsx
```

:::

You run each script in this tutorial with `bun run <file>` on Bun, or `npx tsx <file>` on
Node.js.

## Step 3: Connect to the database

pg-hybrid-rag doesn't open database connections itself. You give it a `TransactionProvider`:
an object with one method, `withConnection`, that lends the library a connection for the
duration of a callback. All the queries in one callback must run on the same connection, so the
provider below reserves one from the pool and releases it afterwards.

Create `db.ts`:

<!-- no-check -->

```ts
import postgres from "postgres";
import type { SqlClient, TransactionProvider } from "pg-hybrid-rag";

export const sql = postgres("postgres://rag:rag@localhost:5433/rag", {
  max: 5,
  onnotice: () => {}, // hide informational server notices
});

// pg-hybrid-rag sends its queries through a TransactionProvider. Each call reserves one
// connection, so every query in the callback runs in the same database session.
export const txProvider: TransactionProvider = {
  async withConnection(fn) {
    const conn = await sql.reserve();
    try {
      const client: SqlClient = {
        // postgres.js types its parameters more strictly than SqlClient; the casts bridge them.
        query: async (text, params) => (await conn.unsafe(text, params as never[])) as never,
      };
      return await fn(client);
    } finally {
      conn.release();
    }
  },
};
```

## Step 4: Create the schema

The library ships its schema as SQL migration files inside the package. `ragMigrate` applies the
ones that haven't run yet and records them in a `_rag_migrations` table, so it's safe to run it
again.

Create `migrate.ts`:

<!-- no-check -->

```ts
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { ragMigrate } from "pg-hybrid-rag";
import { sql, txProvider } from "./db";

// Locate the SQL files that ship inside the pg-hybrid-rag package.
const require = createRequire(import.meta.url);
const sqlDir = dirname(require.resolve("pg-hybrid-rag/sql/001_extensions.sql"));

await ragMigrate(txProvider, { sqlDir });
console.log("Migrations applied.");
await sql.end();
```

::: info Why pass `sqlDir`?
In version 0.6.0 and earlier, `ragMigrate` can't find its SQL files on its own when it's installed
as a package, so you pass the folder explicitly. Passing `sqlDir` works in every
version. The two lines above work in Bun, Node.js ESM and CommonJS.
:::

Run it:

::: code-group

```bash [Bun]
bun run migrate.ts
```

```bash [Node.js]
npx tsx migrate.ts
```

:::

```text
Migrations applied.
```

Your database now has a `rag_documents` table for indexed text, plus tables for stop words,
synonyms and metadata keys. The embedding column has 384 dimensions by default, which matches
`multilingual-e5-small`.

## Step 5: Configure the embedder and database adapter

Two more objects complete the setup: an embedder that calls the embedding server, and the
PostgreSQL adapter that runs the search queries.

Create `setup.ts`:

<!-- no-check -->

```ts
import { OpenAiCompatibleEmbedder, PostgresRagDatabase } from "pg-hybrid-rag";
import { txProvider } from "./db";

// Every tenant ID and source ID is a UUID.
export const tenantId = "00000000-0000-0000-0000-000000000001";

export const embedder = new OpenAiCompatibleEmbedder({
  baseUrl: "http://localhost:8080/v1",
  apiKey: "unused", // the local server does not check keys
  model: "intfloat/multilingual-e5-small",
});

export const db = new PostgresRagDatabase(txProvider);
```

`OpenAiCompatibleEmbedder` works with any server that implements the OpenAI embeddings API. All
data belongs to a tenant, so one database can hold content for many customers or workspaces
without mixing it.

## Step 6: Index some articles

Indexing has two parts. A `Chunker` splits each document into passages small enough to embed
well. A `RagIndexer` embeds those chunks and stores them.

Create `index-content.ts`:

<!-- no-check -->

```ts
import { Chunker, RagIndexer } from "pg-hybrid-rag";
import { sql } from "./db";
import { db, embedder, tenantId } from "./setup";

const articles = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    title: "Reset your password",
    body: "If you forgot your password, open the sign-in page and choose Forgot password. We email you a reset link that expires after 30 minutes. Passwords must be at least 12 characters long.",
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    title: "Set up two-factor authentication",
    body: "Two-factor authentication adds a second step when you sign in. Go to Settings, then Security, and scan the QR code with an authenticator app. Keep your recovery codes somewhere safe.",
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    title: "Error ERR-4012 during checkout",
    body: "ERR-4012 means the card issuer declined the payment. Check that the billing address matches the card, or try another payment method. Your order is not placed until payment succeeds.",
  },
  {
    id: "10000000-0000-0000-0000-000000000004",
    title: "Change your billing plan",
    body: "You can upgrade or downgrade your subscription at any time from the Billing page. Upgrades take effect immediately; downgrades apply at the start of the next billing cycle.",
  },
  {
    id: "10000000-0000-0000-0000-000000000005",
    title: "Export your data",
    body: "To download a copy of your data, go to Settings, then Privacy, and request an export. We prepare a ZIP archive with your projects and invoices and email you when it is ready.",
  },
  {
    id: "10000000-0000-0000-0000-000000000006",
    title: "Delete your account",
    body: "Deleting your account removes your projects, files and billing history permanently. Export anything you want to keep first. Account deletion cannot be undone.",
  },
];

const chunker = new Chunker({ tokenLimit: 256 });
const indexer = new RagIndexer({ tenantId, db, embedder });

for (const article of articles) {
  const chunks = chunker.chunk(`${article.title}\n\n${article.body}`, {
    title: article.title,
    language: "en",
  });
  const count = await indexer.index("article", article.id, chunks, "en");
  console.log(`Indexed "${article.title}" (${count} chunk${count === 1 ? "" : "s"})`);
}

await sql.end();
```

Run it with `bun run index-content.ts` (or `npx tsx index-content.ts`):

```text
Indexed "Reset your password" (1 chunk)
Indexed "Set up two-factor authentication" (1 chunk)
Indexed "Error ERR-4012 during checkout" (1 chunk)
Indexed "Change your billing plan" (1 chunk)
Indexed "Export your data" (1 chunk)
Indexed "Delete your account" (1 chunk)
```

A few things happened for each article:

- The chunker kept each short article as a single chunk. Longer documents are split at
  paragraph and sentence boundaries.
- `title` and `language` went into the chunk's metadata. You get the metadata back with every
  search result.
- `index("article", id, chunks, "en")` stored the chunks under a source type (`"article"`) and a
  source ID. Indexing the same source again replaces its old chunks, so you can re-run this
  script safely.
- PostgreSQL also built a stemmed full-text representation of each chunk, using the English
  rules because the language is `"en"`.

## Step 7: Search

Create `search.ts`:

<!-- no-check -->

```ts
import { RagPipeline } from "pg-hybrid-rag";
import { sql } from "./db";
import { db, embedder, tenantId } from "./setup";

const pipeline = new RagPipeline({ tenantId, db, embedder });

const query = process.argv[2] ?? "how do I change my password";
const results = await pipeline.search(query, { language: "en", topK: 3 });

console.log(`Results for "${query}":`);
for (const r of results) {
  console.log(`  ${r.score.toFixed(4)}  ${r.metadata.title}`);
}

await sql.end();
```

Run it:

::: code-group

```bash [Bun]
bun run search.ts
```

```bash [Node.js]
npx tsx search.ts
```

:::

```text
Results for "how do I change my password":
  0.0328  Reset your password
  0.0161  Set up two-factor authentication
  0.0159  Delete your account
```

The `language` option is required. It tells the full-text search which language rules to apply
to the query, and `search()` never assumes English: it throws if no query language is given.

## Step 8: Try different kinds of queries

Pass a query as an argument to try others. Each of these is hard for at least one search
technique on its own:

```bash
bun run search.ts "ERR-4012"
bun run search.ts "pasword reset"
bun run search.ts "close my profile"
bun run search.ts "remove everything about me"
```

```text
Results for "ERR-4012":
  0.0492  Error ERR-4012 during checkout
Results for "pasword reset":
  0.0328  Reset your password
  0.0161  Set up two-factor authentication
  0.0159  Error ERR-4012 during checkout
Results for "close my profile":
  0.0164  Delete your account
  0.0161  Reset your password
  0.0159  Set up two-factor authentication
Results for "remove everything about me":
  0.0164  Delete your account
```

- **An exact code** (`ERR-4012`) has little meaning for an embedding model, but matches the text
  character for character.
- **A typo** (`pasword`) breaks exact word matching, but most of its character trigrams still
  overlap with "password", and its meaning stays close.
- **A paraphrase** (`close my profile`, `remove everything about me`) shares no words with the
  "Delete your account" article, so only matching by meaning can find it. Here only one of the
  three searches found the article, which is why its score is lower; the next step explains the
  numbers.

pg-hybrid-rag runs three searches for every query and merges them:

| Search | Finds matches by | Good at |
|---|---|---|
| Vector | Similar meaning (embeddings, pgvector) | Paraphrases, questions |
| Keyword | Shared character trigrams (pg_trgm) | Codes, names, typos |
| Full-text | Shared word stems (PostgreSQL full-text search) | Different forms of the same word |

## Step 9: Read the scores

The scores come from Reciprocal Rank Fusion (RRF). Each search ranks its own matches, and a
result earns `1 / (60 + rank)` from every search that found it. The final score is the sum.

| Score | How it was earned |
|---|---|
| 0.0492 | Ranked first by all three searches: 3 × 1/61 |
| 0.0328 | Ranked first by two searches: 2 × 1/61 |
| 0.0164 | Ranked first by one search: 1/61 |
| 0.0161 | Ranked second by one search: 1/62 |
| 0.0159 | Ranked third by one search: 1/63 |

Because RRF uses ranks, not raw similarity values, the three searches can be combined even
though their scores are on different scales. A result that several searches agree on rises to
the top. The scores only compare results within one query; they are not a confidence
percentage.

## What you built

You now have a working hybrid search:

- PostgreSQL holds your chunks, their embeddings, and a full-text index, all scoped to a tenant.
- `RagIndexer` turns documents into searchable chunks.
- `RagPipeline` runs vector, keyword and full-text search in parallel and fuses the results.

## Clean up

The next tutorial continues with this project, so keep it running if you plan to do it. When
you're finished, stop the services and delete their data:

```bash
docker compose down -v
```

## Next steps

- Continue with [Filter results with metadata](/tutorials/metadata-filters), which builds on
  this project.
- Connect your own driver: [Connect your database driver](/how-to/connect-database-driver).
- Use a different embedding model: [Configure embeddings](/how-to/configure-embeddings).
- Learn what happens inside a search: [How hybrid search works](/explanation/hybrid-search).
