import type {
  EmbeddingProvider,
  RagDatabase,
  RagLogger,
  RagSpan,
  RagTracer,
  RerankerProvider,
  StopWordsProvider,
  SynonymProvider,
} from "./interfaces.js";
import { stripTrailingPunctuation } from "./punctuation.js";
import { applyRRF } from "./rrf.js";
import { removeStopWords } from "./stopWords.js";
import type { RagResult, RagSearchOptions } from "./types.js";

const DEFAULTS = {
  topK: 5,
  vectorMinScore: 0.8,
  keywordMinScore: 0.35,
  vectorWeight: 1,
  keywordWeight: 1,
  ftsWeight: 1,
  rrfK: 60,
  candidateMultiplier: 2,
  rerank: false,
  rerankerMinRelativeScore: 0.01,
  rerankerMinAbsoluteScore: 0,
} satisfies Omit<
  Required<RagSearchOptions>,
  "sourceTypes" | "sourceIds" | "languages" | "minRelevance" | "language" | "normalizer"
>;

const noopSpan: RagSpan = {
  setAttribute: () => {},
  end: () => {},
};

const noopTracer: RagTracer = {
  startActiveSpan: async <T>(_name: string, fn: (span: RagSpan) => Promise<T>) => fn(noopSpan),
};

const noopLogger: RagLogger = {
  info: () => {},
  warn: () => {},
};

export interface RagPipelineConfig {
  tenantId: string;
  db: RagDatabase;
  embedder: EmbeddingProvider;
  stopWords?: StopWordsProvider;
  synonyms?: SynonymProvider;
  reranker?: RerankerProvider;
  logger?: RagLogger;
  tracer?: RagTracer;
}

export class RagPipeline {
  private tenantId: string;
  private db: RagDatabase;
  private embedder: EmbeddingProvider;
  private stopWords?: StopWordsProvider;
  private synonyms?: SynonymProvider;
  private reranker?: RerankerProvider;
  private logger: RagLogger;
  private tracer: RagTracer;

  constructor(config: RagPipelineConfig) {
    this.tenantId = config.tenantId;
    this.db = config.db;
    this.embedder = config.embedder;
    this.stopWords = config.stopWords;
    this.synonyms = config.synonyms;
    this.reranker = config.reranker;
    this.logger = config.logger ?? noopLogger;
    this.tracer = config.tracer ?? noopTracer;
  }

  async search(query: string, options: RagSearchOptions = {}): Promise<RagResult[]> {
    return this.tracer.startActiveSpan("rag-pipeline.search", async (span) => {
      try {
        const opts = { ...DEFAULTS, ...options };
        span.setAttribute("tenantId", this.tenantId);
        span.setAttribute("topK", opts.topK);
        span.setAttribute("searchMode", "hybrid-rrf-3way");

        // Auto-load merged stop words for the tenant (uses cached Set when available)
        let allStopWords: Set<string>;
        if (this.stopWords?.loadMerged) {
          allStopWords = await this.stopWords.loadMerged(this.tenantId);
        } else if (this.stopWords) {
          allStopWords = new Set<string>();
          const stopWordsMap = await this.stopWords.load(this.tenantId);
          for (const words of stopWordsMap.values()) {
            for (const w of words) allStopWords.add(w);
          }
        } else {
          allStopWords = new Set<string>();
        }

        // Strip trailing punctuation from each word before matching. filter(Boolean) drops
        // empty tokens from leading/trailing whitespace and words reduced to "" by stripping.
        let searchQuery = query
          .toLowerCase()
          .split(/\s+/)
          .map(stripTrailingPunctuation)
          .filter(Boolean)
          .join(" ");

        // The query's language for FTS stemming + normalization. Use the explicit option,
        // else infer it from a single-entry `languages` filter (so "search only Spanish docs"
        // also stems the query as Spanish), else leave undefined until the search boundary.
        const queryLanguage =
          opts.language ?? (opts.languages?.length === 1 ? opts.languages[0] : undefined);

        // Apply NLP normalization (abbreviation expansion) before stop-word removal
        if (opts.normalizer && queryLanguage) {
          const preNormalized = searchQuery;
          searchQuery = opts.normalizer.normalize(searchQuery, queryLanguage);
          // Fallback to the pre-normalization string (already lowercased + punctuation-stripped),
          // not the raw `query`, so an emptied normalization doesn't re-introduce casing/punctuation.
          if (!searchQuery.trim()) searchQuery = preNormalized;
          span.setAttribute("normalizerApplied", true);
        }

        // Natural-language query (normalized, but NOT stop-word-stripped). Used for the
        // dense vector embedding and the cross-encoder reranker: stop-word removal helps the
        // lexical legs (trigram/FTS) but degrades dense retrieval with sentence-trained
        // embedding models (e.g. e5), which expect natural language.
        const naturalQuery = searchQuery;

        if (allStopWords.size > 0) {
          searchQuery = removeStopWords(searchQuery, allStopWords);
          // Fallback to the pre-removal normalized query (naturalQuery), not the raw `query`,
          // so the lexical legs match normalized text rather than re-introduced casing/punctuation.
          if (!searchQuery.trim()) searchQuery = naturalQuery;
        }
        span.setAttribute("stopWordsApplied", searchQuery !== query);

        const candidateLimit = opts.topK * opts.candidateMultiplier;

        // Embed query + load synonyms in parallel (independent async operations)
        const [queryEmbedding, synonymLookup] = await Promise.all([
          this.tracer.startActiveSpan("rag.embedQuery", async (embedSpan) => {
            try {
              // Embed the natural query (stop words preserved) — see naturalQuery above.
              return await this.embedder.embedQuery(naturalQuery);
            } finally {
              embedSpan.end();
            }
          }),
          this.synonyms
            ? this.synonyms.load(this.tenantId)
            : Promise.resolve(new Map() as Map<string, Map<string, string[]>>),
        ]);

        span.setAttribute("synonymsApplied", synonymLookup.size > 0);
        const embeddingStr = `[${queryEmbedding.join(",")}]`;

        const language = queryLanguage ?? "en";

        // Run 3-way hybrid search
        const results = await this.tracer.startActiveSpan("rag.dbSearch", async (dbSpan) => {
          try {
            return await this.db.hybridSearch({
              tenantId: this.tenantId,
              embeddingStr,
              query: searchQuery,
              synonymLookup,
              language,
              candidateLimit,
              vectorMinScore: opts.vectorMinScore,
              keywordMinScore: opts.keywordMinScore,
              sourceTypes: opts.sourceTypes,
              sourceIds: opts.sourceIds,
              languages: opts.languages,
            });
          } finally {
            dbSpan.end();
          }
        });

        const fused = applyRRF(
          [
            { items: results.vectorRows },
            { items: results.keywordRows },
            { items: results.ftsRows },
          ],
          opts.rrfK,
          opts.topK,
          [opts.vectorWeight, opts.keywordWeight, opts.ftsWeight],
        );

        // Post-RRF relevance cutoff
        let filtered = fused;
        if (opts.minRelevance && fused.length > 0) {
          const threshold = fused[0].score * opts.minRelevance;
          filtered = fused.filter((r) => r.score >= threshold);
        }

        // Cross-encoder reranking: reorder by joint query-document relevance
        const shouldRerank = opts.rerank === true && this.reranker != null;

        span.setAttribute("rerankerApplied", shouldRerank);

        if (shouldRerank && filtered.length > 0) {
          filtered = await this.tracer.startActiveSpan("rag.rerank", async (rerankSpan) => {
            try {
              rerankSpan.setAttribute("inputCount", filtered.length);
              const reranked =
                (await this.reranker?.rerank(naturalQuery, filtered, opts.topK)) ?? filtered;

              // Two independent floors; a result must clear both active ones.
              //  - relative: a fraction of the top reranked score. Model-agnostic (reranker score
              //    scales differ wildly), so this is the everyday "drop unrelated" knob. Skipped
              //    when the top score is not positive (fraction-of-top is meaningless for raw logits).
              //  - absolute: a hard floor in the model's own score units. Off by default; opt in
              //    only when calibrated to your reranker.
              // Seed with the first score (not 0) so the max is correct even when every
              // reranker score is negative (raw logits); the topScore > 0 guard below then
              // decides whether the relative floor applies.
              const topScore = reranked.reduce(
                (max, r) => (r.score > max ? r.score : max),
                reranked[0]?.score ?? Number.NEGATIVE_INFINITY,
              );
              const relThreshold =
                opts.rerankerMinRelativeScore > 0 && topScore > 0
                  ? opts.rerankerMinRelativeScore * topScore
                  : Number.NEGATIVE_INFINITY;
              const absThreshold =
                opts.rerankerMinAbsoluteScore > 0
                  ? opts.rerankerMinAbsoluteScore
                  : Number.NEGATIVE_INFINITY;
              const result = reranked.filter(
                (r) => r.score >= relThreshold && r.score >= absThreshold,
              );
              rerankSpan.setAttribute("outputCount", result.length);
              return result;
            } catch (err) {
              // Graceful degradation: return RRF results if reranker fails
              rerankSpan.setAttribute("error", true);
              this.logger.warn(
                { tenantId: this.tenantId, error: String(err) },
                "Reranker failed, falling back to RRF results",
              );
              return filtered;
            } finally {
              rerankSpan.end();
            }
          });
        }

        span.setAttribute("vectorCandidates", results.vectorRows.length);
        span.setAttribute("keywordCandidates", results.keywordRows.length);
        span.setAttribute("ftsCandidates", results.ftsRows.length);
        span.setAttribute("resultCount", filtered.length);

        if (filtered.length === 0) {
          this.logger.debug?.(
            { tenantId: this.tenantId, query: searchQuery },
            "Search returned 0 results",
          );
        }

        this.logger.debug?.(
          {
            tenantId: this.tenantId,
            resultCount: filtered.length,
            vectorCandidates: results.vectorRows.length,
            keywordCandidates: results.keywordRows.length,
            ftsCandidates: results.ftsRows.length,
            rerankerApplied: shouldRerank,
            stopWordsApplied: allStopWords.size > 0,
            synonymsApplied: synonymLookup.size > 0,
          },
          "Search completed",
        );

        return filtered;
      } finally {
        span.end();
      }
    });
  }
}
