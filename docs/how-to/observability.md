# Monitor searches

This guide shows how to connect your logger and tracer to the library, which log messages and spans it emits, and how to read per-search diagnostics. The library has no logging or tracing dependency of its own; without a logger or tracer, both are no-ops.

## Connect a logger

`RagLogger` has `info(obj, msg)`, `warn(obj, msg)` and an optional `debug(obj, msg)`. Loggers with that call shape, such as pino, fit as they are. Pass the logger to the pipeline and the indexer.

```ts
import { RagIndexer, RagPipeline, type RagLogger } from "pg-hybrid-rag";

const logger: RagLogger = {
  debug: (obj, msg) => console.debug(msg, obj),
  info: (obj, msg) => console.info(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
};

const pipeline = new RagPipeline({ tenantId, db, embedder, logger });
const indexer = new RagIndexer({ tenantId, db, embedder, logger });
```

Messages the library logs:

| Level | Message | From | Fields |
| --- | --- | --- | --- |
| `warn` | Reranker failed, falling back to RRF results | `RagPipeline` | `tenantId`, `error` |
| `warn` | Generated metadata filter failed validation; dropped | `RagPipeline` | `tenantId`, `status`, `errors` |
| `warn` | Filter model failed; searching without a generated filter | `RagPipeline` | `tenantId`, `status`, `errors` |
| `debug` | Search returned 0 results | `RagPipeline` | `tenantId`, `query` |
| `debug` | Search completed | `RagPipeline` | `tenantId`, `resultCount`, `vectorCandidates`, `keywordCandidates`, `ftsCandidates`, `rerankerApplied`, `rerankInputCount`, `stopWordsApplied`, `synonymsApplied` |
| `info` | Documents indexed | `RagIndexer` | `tenantId`, `sourceType`, `sourceId`, `chunks` |

The `query` field on "Search returned 0 results" is the processed query text. If queries can contain personal data, redact it in your logger or leave `debug` unset.

Failures that stop a search or an index call are thrown, not logged: an invalid filter, a missing query language, an embedding error, a failed search leg. Catch and log them in your own code.

## Connect a tracer

`RagTracer` has one method, `startActiveSpan(name, fn)`, which must call `fn` with a span and return its result. A span has `setAttribute(key, value)` and `end()`. Only `RagPipeline` accepts a tracer.

The adapter below maps it to OpenTelemetry. It ends each span itself, after `fn` settles, so it can record an error before the span closes; the pipeline's own `end()` calls become no-ops.

<!-- no-check -->
```ts
import { SpanStatusCode, trace, type AttributeValue } from "@opentelemetry/api";
import type { RagTracer } from "pg-hybrid-rag";

const otel = trace.getTracer("pg-hybrid-rag");

export const tracer: RagTracer = {
  startActiveSpan(name, fn) {
    return otel.startActiveSpan(name, async (span) => {
      try {
        return await fn({
          setAttribute: (key, value) => span.setAttribute(key, value as AttributeValue),
          end: () => {}, // ended in finally below
        });
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  },
};

// new RagPipeline({ tenantId, db, embedder, tracer });
```

Spans the pipeline creates:

| Span | Runs inside | Attributes |
| --- | --- | --- |
| `rag-pipeline.search` | the caller's context | `tenantId`, `topK`, `searchMode`, `language`, `stopWordsApplied`, `synonymsApplied`, `generatedFilterStatus`, `retriedWithoutGeneratedFilter`, `fusion`, `rerankerApplied`, `vectorCandidates`, `keywordCandidates`, `ftsCandidates`, `resultCount`; plus `normalizerApplied`, `orthographicNormalizerApplied` and `segmenterApplied` when those steps run |
| `rag.embedQuery` | `rag-pipeline.search` | none |
| `rag.dbSearch` | `rag-pipeline.search` | none. Appears twice when an auto-filter search is retried without the generated filter. |
| `rag.rerank` | `rag-pipeline.search` | `inputCount`, `outputCount`, and `error: true` when the reranker throws |

Notes on the attributes:

- `searchMode` is `hybrid-rrf-3way` or `hybrid-linear-3way`.
- `stopWordsApplied` is `true` only when stop-word removal dropped at least one word from the lexical query. The "Search completed" log field has the same meaning.
- If a search throws early (for example, no query language), the attributes set after that point are missing.

### Time the other components

The indexer, embedder, database adapter and filter model take no tracer. To time them, wrap the provider you pass in. This wrapper reports embedding latency to any metrics function:

```ts
import type { EmbeddingProvider } from "pg-hybrid-rag";

function timedEmbedder(
  inner: EmbeddingProvider,
  record: (operation: string, ms: number) => void,
): EmbeddingProvider {
  return {
    async embedQuery(text) {
      const start = performance.now();
      try {
        return await inner.embedQuery(text);
      } finally {
        record("embedQuery", performance.now() - start);
      }
    },
    async embedDocuments(texts) {
      const start = performance.now();
      try {
        return await inner.embedDocuments(texts);
      } finally {
        record("embedDocuments", performance.now() - start);
      }
    },
  };
}

const embedderWithTiming = timedEmbedder(embedder, (op, ms) => console.log(op, ms.toFixed(1)));
```

The same pattern works for `RerankerProvider`, `FilterModelProvider` and `TransactionProvider`.

## Read search diagnostics

`searchWithDiagnostics()` returns the results together with a `diagnostics` object that reports how metadata filters were handled. It takes the same options as `search()`.

```ts
const { results, diagnostics } = await pipeline.searchWithDiagnostics(query, {
  language: "en",
  autoFilter: true,
});

logger.info(
  {
    resultCount: results.length,
    status: diagnostics.generatedFilterStatus,
    generated: diagnostics.generatedFilter,
    errors: diagnostics.generatedFilterErrors,
    retried: diagnostics.retriedWithoutGeneratedFilter,
  },
  "search diagnostics",
);
```

| Field | Content |
| --- | --- |
| `explicitFilter` | The `filter` option as passed, or `null` |
| `generatedFilter` | The raw filter model output, unvalidated, or `null` |
| `generatedFilterStatus` | `not_requested`, `none`, `applied`, `invalid` or `error` |
| `generatedFilterErrors` | Validation or error messages; present only for `invalid` and `error` |
| `retriedWithoutGeneratedFilter` | `true` when an applied generated filter emptied every leg and the search ran again without it |

The status values are explained in [Generate filters from the query](/how-to/auto-filter#search-with-autofilter).

## What to watch

- **Reranker fallbacks and filter-model errors.** Count the `warn` messages. A steady rate means a service is failing or timing out.
- **Leg candidate counts.** A leg disabled with a weight of `0` always reports `0`. Otherwise, if `vectorCandidates` is often `0`, `vectorMinScore` is probably too high for your embedding model; see [Tune relevance](/how-to/tune-relevance#calibrate-vectorminscore-for-your-embedder).
- **Zero-result rate**, from the "Search returned 0 results" debug message or `resultCount` on the root span.
- **Latency per span**, to see whether embedding, the database or reranking dominates.

## Related

- [Rerank results](/how-to/rerank)
- [Generate filters from the query](/how-to/auto-filter)
- [Production checklist](/how-to/production-checklist)
- [Interfaces reference](/reference/interfaces)
- [Types reference](/reference/types)
