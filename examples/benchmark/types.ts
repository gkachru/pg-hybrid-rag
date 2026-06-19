export type Dialect = "msa" | "saudi" | "darija";
export type Domain = "banking" | "telecom";

/** One scraped FAQ pair. doc_id = "faq:<provider>:<ordinal>". */
export interface FaqRecord {
  doc_id: string;
  domain: Domain;
  provider: string;
  question: string;
  answer: string;
}

/** Raw pypdf extraction for one PDF. doc_id = "pdf:<provider>:<ordinal>". */
export interface ExtractedPdf {
  doc_id: string;
  provider: string;
  domain: Domain;
  title: string;
  pages: string[];
}

/** One indexable chunk. chunk_id = "<doc_id>#<index>". */
export interface CorpusChunk {
  chunk_id: string;
  doc_id: string;
  source: "faq" | "pdf";
  domain: Domain;
  provider: string;
  language: string;
  content: string;
}

/** A scored query with three dialect variants sharing one target document. */
export interface BenchmarkQuery {
  id: string;
  domain: Domain;
  provider: string;
  target_doc: string;
  target_snippet: string;
  variants: Record<Dialect, string>;
}

export interface QueriesFile {
  version: number;
  queries: BenchmarkQuery[];
}
