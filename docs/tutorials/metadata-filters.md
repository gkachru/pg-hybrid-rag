# Filter results with metadata

In this tutorial you attach typed metadata to the help-center articles from the first tutorial,
then restrict searches with filters: by category, by date, by plan, and with combinations of
conditions. At the end you ask the library to describe which metadata keys exist for a tenant.

It takes about 15 minutes.

## Before you start

Complete [Build your first hybrid search](/tutorials/getting-started) first. You need its
project folder, with the database and embedding server still running.

## Step 1: Describe your metadata

Each article can carry **attributes**: typed values grouped under a namespace. You'll give
every article three attributes in a namespace called `help`:

| Key | Type | Example | Meaning |
|---|---|---|---|
| `category` | string, enum | `"billing"` | The help-center section |
| `plans` | string, enum, list | `["free", "pro"]` | Plans the article applies to |
| `updated` | date | `"2026-09-14"` | When the article last changed |

Types matter. A filter on a `date` attribute compares dates, and a filter on a `number`
attribute compares numbers, not text. The library validates every attribute when you index it.

## Step 2: Index the articles with attributes

Open `index-content.ts` from the first tutorial. Add a helper that builds the three attributes,
and a lookup that gives each article its values. Put both below the `articles` array:

<!-- no-check -->

```ts
import { type AttributeInput, Chunker, RagIndexer } from "pg-hybrid-rag";

// ...the articles array from the first tutorial stays as it is...

function help(category: string, plans: string[], updated: string): AttributeInput[] {
  return [
    { ns: "help", key: "category", type: "string", format: "enum", value: category },
    { ns: "help", key: "plans", type: "string", format: "enum", multi: true, value: plans },
    { ns: "help", key: "updated", type: "date", value: updated },
  ];
}

const attributesByTitle: Record<string, AttributeInput[]> = {
  "Reset your password": help("account", ["free", "pro", "enterprise"], "2026-09-14"),
  "Set up two-factor authentication": help("security", ["pro", "enterprise"], "2026-10-02"),
  "Error ERR-4012 during checkout": help("billing", ["free", "pro", "enterprise"], "2025-11-20"),
  "Change your billing plan": help("billing", ["free", "pro"], "2026-08-30"),
  "Export your data": help("account", ["pro", "enterprise"], "2026-03-05"),
  "Delete your account": help("account", ["free", "pro", "enterprise"], "2025-06-11"),
};
```

Update the first line of the file to import `AttributeInput` as shown. Then pass the attributes
to `index()` inside the loop:

<!-- no-check -->

```ts
for (const article of articles) {
  const chunks = chunker.chunk(`${article.title}\n\n${article.body}`, {
    title: article.title,
    language: "en",
  });
  const attributes = attributesByTitle[article.title] ?? [];
  const count = await indexer.index("article", article.id, chunks, "en", { attributes });
  console.log(`Indexed "${article.title}" (${count} chunk${count === 1 ? "" : "s"})`);
}
```

Run the script again with `bun run index-content.ts` (or `npx tsx index-content.ts`). Because
indexing a source replaces its old chunks, each article is re-indexed with its attributes:

```text
Indexed "Reset your password" (1 chunk)
Indexed "Set up two-factor authentication" (1 chunk)
Indexed "Error ERR-4012 during checkout" (1 chunk)
Indexed "Change your billing plan" (1 chunk)
Indexed "Export your data" (1 chunk)
Indexed "Delete your account" (1 chunk)
```

A few details about these attributes:

- `format: "enum"` marks a value as one of a fixed set. `multi: true` with a list value means
  the article has several values at once.
- Dates use the `YYYY-MM-DD` form. The library checks formats but doesn't convert them, so
  normalize dates before you index them.
- If an attribute is invalid, `index()` throws an `AttributeValidationError` before it calls the
  embedding server, so nothing is stored for that article.

## Step 3: Search with filters

Create `filtered-search.ts`. It runs the same query four times, once without a filter and three
times with one, and prints each result's category and date:

<!-- no-check -->

```ts
import { type FilterExpression, RagPipeline, type RagResult } from "pg-hybrid-rag";
import { sql } from "./db";
import { db, embedder, tenantId } from "./setup";

const pipeline = new RagPipeline({ tenantId, db, embedder });

function attr(result: RagResult, key: string) {
  return result.attributes.find((a) => a.ns === "help" && a.key === key)?.value;
}

async function show(label: string, filter?: FilterExpression) {
  const results = await pipeline.search("my account settings", { language: "en", topK: 6, filter });
  console.log(`${label}:`);
  for (const r of results) {
    console.log(`  ${String(r.metadata.title).padEnd(34)} ${attr(r, "category")}, updated ${attr(r, "updated")}`);
  }
  if (results.length === 0) console.log("  (no results)");
}

await show("No filter");

await show("Category is billing", {
  ns: "help", key: "category", op: "equals", value: "billing",
});

await show("Updated in 2026 and not billing", {
  and: [
    { ns: "help", key: "updated", op: "gte", value: "2026-01-01", type: "date" },
    { not: { ns: "help", key: "category", op: "equals", value: "billing" } },
  ],
});

await show("Available on the free plan", {
  ns: "help", key: "plans", op: "equals", value: "free",
});

await sql.end();
```

Run it:

::: code-group

```bash [Bun]
bun run filtered-search.ts
```

```bash [Node.js]
npx tsx filtered-search.ts
```

:::

```text
No filter:
  Delete your account                account, updated 2025-06-11
  Set up two-factor authentication   security, updated 2026-10-02
  Export your data                   account, updated 2026-03-05
  Reset your password                account, updated 2026-09-14
  Change your billing plan           billing, updated 2026-08-30
  Error ERR-4012 during checkout     billing, updated 2025-11-20
Category is billing:
  Change your billing plan           billing, updated 2026-08-30
  Error ERR-4012 during checkout     billing, updated 2025-11-20
Updated in 2026 and not billing:
  Set up two-factor authentication   security, updated 2026-10-02
  Export your data                   account, updated 2026-03-05
  Reset your password                account, updated 2026-09-14
Available on the free plan:
  Delete your account                account, updated 2025-06-11
  Reset your password                account, updated 2026-09-14
  Change your billing plan           billing, updated 2026-08-30
  Error ERR-4012 during checkout     billing, updated 2025-11-20
```

Look at what each filter did:

- **A single condition** has a `key`, an operator (`op`) and a `value`. `ns` limits it to one
  namespace; leave it out to match the key in any namespace.
- **`and`, `or` and `not`** combine conditions into a tree.
- **`gte` with `type: "date"`** compares dates. For range operators, the library can infer a date
  from a `YYYY-MM-DD` value, but setting `type` makes the intent explicit.
- **A list attribute** such as `plans` matches when any of its values matches, so "free" finds
  every article whose plans include `free`.

The filter runs inside all three searches, in the database. It isn't applied to the results
afterwards, so a filtered search still returns up to `topK` matching results.

## Step 4: See what happens with a mistake

Filters are validated before any search work starts. Add this to the end of
`filtered-search.ts`, just before `await sql.end()`:

<!-- no-check -->

```ts
try {
  await show("A broken filter", { ns: "help", key: "updated", op: "gte", value: true });
} catch (err) {
  console.log((err as Error).name, "-", (err as Error).message);
}
```

Run the script again. The last lines are:

```text
FilterValidationError - Invalid filter: $: op "gte" is not allowed for type "boolean"
```

A boolean can't be compared with `gte`, so the library rejects the filter with a
`FilterValidationError` instead of running a search that can't match anything.

## Step 5: Describe the tenant's metadata

When you build a filter UI, or let a language model write filters for you, you need to know which
keys exist. `CachingMetadataCatalog` reports the keys found in a tenant's indexed data, and
lets you register descriptions and allowed values for them.

Create `catalog.ts`:

<!-- no-check -->

```ts
import { CachingMetadataCatalog } from "pg-hybrid-rag";
import { sql, txProvider } from "./db";
import { tenantId } from "./setup";

const catalog = new CachingMetadataCatalog({ txProvider });

await catalog.register(tenantId, [
  {
    ns: "help",
    key: "category",
    description: "Help center section",
    type: "string",
    format: "enum",
    allowedValues: ["account", "billing", "security"],
  },
]);

const described = await catalog.describe(tenantId);
for (const key of described.keys) {
  const values = key.topValues?.map((v) => `${v.value} (${v.articleCount})`).join(", ");
  console.log(`${key.ns}.${key.key}  registered=${key.registered}  ${values ?? ""}`);
}

await sql.end();
```

Run it with `bun run catalog.ts` (or `npx tsx catalog.ts`):

```text
help.category  registered=true  account (3), billing (2), security (1)
help.plans  registered=false  pro (6), enterprise (5), free (4)
help.updated  registered=false
```

The catalog combines two sources:

- **Observed keys**, read from the attributes you indexed, with article counts and the most
  common string values.
- **Registered keys**, which you describe once. A description and `allowedValues` help a person
  or a model choose valid filters.

## What you learned

- Attributes are typed, namespaced values that you attach to an article when you index it.
- A filter is a tree of conditions combined with `and`, `or` and `not`, and it runs inside every
  search in the database.
- The library validates attributes and filters before doing any work, so mistakes surface as
  clear errors.
- The metadata catalog tells you which keys a tenant has.

## Clean up

Stop the services and delete their data:

```bash
docker compose down -v
```

## Next steps

- Common filter patterns: [Filter by metadata](/how-to/filter-by-metadata).
- Let a language model write the filter: [Generate filters from the query](/how-to/auto-filter).
- Every operator and type rule: [Attributes and filter grammar](/reference/filter-grammar).
- The reasoning behind the design: [The metadata model](/explanation/metadata-model).
