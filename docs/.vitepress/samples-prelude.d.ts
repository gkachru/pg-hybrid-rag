// Ambient variables that doc samples may use without declaring them. Keep this list short and
// obvious: a reader should be able to guess what each one is from its name alone.
import type {
  Chunk,
  Chunker,
  EmbeddingProvider,
  PostgresRagDatabase,
  RagIndexer,
  RagLogger,
  RagPipeline,
  RagResult,
  SqlClient,
  TransactionProvider,
} from "pg-hybrid-rag";

declare global {
  /** A SqlClient for one connection (see "Connect your database driver"). */
  var sqlClient: SqlClient;
  /** A TransactionProvider that pins one connection per call. */
  var txProvider: TransactionProvider;
  var embedder: EmbeddingProvider;
  var db: PostgresRagDatabase;
  var pipeline: RagPipeline;
  var indexer: RagIndexer;
  var chunker: Chunker;
  var chunks: Chunk[];
  var results: RagResult[];
  var logger: RagLogger;
  var tenantId: string;
  var text: string;
  var query: string;
}
