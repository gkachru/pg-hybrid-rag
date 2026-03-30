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
import { buildFtsQuery } from "./synonymExpander.js";
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
  rerankerMinScore: 0.01,
} satisfies Omit<
  Required<RagSearchOptions>,
  "sourceTypes" | "sourceIds" | "minRelevance" | "language" | "normalizer"
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

        // Strip trailing punctuation from each word before matching
        let searchQuery = query.toLowerCase().split(/\s+/).map(stripTrailingPunctuation).join(" ");

        // Apply NLP normalization (abbreviation expansion) before stop-word removal
        if (opts.normalizer && opts.language) {
          searchQuery = opts.normalizer.normalize(searchQuery, opts.language);
          if (!searchQuery.trim()) searchQuery = query; // fallback if normalization empties query
          span.setAttribute("normalizerApplied", true);
        }

        // Preserve full query for cross-encoder reranker (before stop-word stripping)
        const rerankerQuery = searchQuery;

        if (allStopWords.size > 0) {
          searchQuery = removeStopWords(searchQuery, allStopWords);
          if (!searchQuery.trim()) searchQuery = query; // fallback if all words removed
        }
        span.setAttribute("stopWordsApplied", searchQuery !== query);

        const candidateLimit = opts.topK * opts.candidateMultiplier;

        // Embed query + load synonyms in parallel (independent async operations)
        const [queryEmbedding, synonymLookup] = await Promise.all([
          this.tracer.startActiveSpan("rag.embedQuery", async (embedSpan) => {
            try {
              return await this.embedder.embedQuery(searchQuery);
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

        // Build FTS query string (Postgres handles stemming via language-specific config)
        const ftsQueryStr = buildFtsQuery(searchQuery, synonymLookup);
        const language = opts.language ?? "en";

        // Run 3-way hybrid search
        const results = await this.tracer.startActiveSpan("rag.dbSearch", async (dbSpan) => {
          try {
            return await this.db.hybridSearch({
              tenantId: this.tenantId,
              embeddingStr,
              query: searchQuery,
              ftsQueryStr,
              language,
              candidateLimit,
              vectorMinScore: opts.vectorMinScore,
              keywordMinScore: opts.keywordMinScore,
              sourceTypes: opts.sourceTypes,
              sourceIds: opts.sourceIds,
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
        const shouldRerank = opts.rerank !== false && this.reranker != null;

        span.setAttribute("rerankerApplied", shouldRerank);

        if (shouldRerank && filtered.length > 0) {
          filtered = await this.tracer.startActiveSpan("rag.rerank", async (rerankSpan) => {
            try {
              rerankSpan.setAttribute("inputCount", filtered.length);
              const reranked =
                (await this.reranker?.rerank(rerankerQuery, filtered, opts.topK)) ?? filtered;
              const minScore = opts.rerankerMinScore;
              const result = minScore ? reranked.filter((r) => r.score >= minScore) : reranked;
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
