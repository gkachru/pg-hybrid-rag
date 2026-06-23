import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chunker } from "../../src/index.js";
import { cleanArabicDoc } from "./cleanArabic.js";
import type { CorpusChunk, ExtractedPdf, FaqRecord } from "./types.js";

const FAQ_DIR = join("datasets", "faqs");
const CACHE_DIR = join("datasets", "benchmark-cache");
const EXTRACTED = join(CACHE_DIR, "extracted.jsonl");
// Two corpus variants, kept as SEPARATE files so building one never overwrites the other:
//   corpus.jsonl        — FAQ answer only (default)
//   corpus-withq.jsonl  — FAQ question + answer (raises lexical overlap with the query)
const CORPUS_ANSWER_ONLY = join(CACHE_DIR, "corpus.jsonl");
const CORPUS_WITH_QUESTION = join(CACHE_DIR, "corpus-withq.jsonl");
const corpusPath = (includeQuestion: boolean): string =>
  includeQuestion ? CORPUS_WITH_QUESTION : CORPUS_ANSWER_ONLY;

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const results: T[] = [];
  for (const l of readFileSync(path, "utf8").trim().split("\n")) {
    if (l.length === 0) continue;
    try {
      results.push(JSON.parse(l) as T);
    } catch {
      console.warn(`skipping malformed line in ${path}`);
    }
  }
  return results;
}

export function buildCorpus(includeQuestion = false): CorpusChunk[] {
  const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
  const out: CorpusChunk[] = [];

  // FAQ answers (scored targets)
  const faqFiles = existsSync(FAQ_DIR)
    ? readdirSync(FAQ_DIR).filter((f) => f.endsWith(".jsonl"))
    : [];
  for (const file of faqFiles) {
    for (const rec of readJsonl<FaqRecord>(join(FAQ_DIR, file))) {
      const content = includeQuestion ? `${rec.question}\n${rec.answer}` : rec.answer;
      for (const chunk of chunker.chunk(content, { language: "ar" })) {
        out.push({
          chunk_id: `${rec.doc_id}#${chunk.index}`,
          doc_id: rec.doc_id,
          source: "faq",
          domain: rec.domain,
          provider: rec.provider,
          language: "ar",
          content: chunk.content,
        });
      }
    }
  }

  // PDF distractors
  for (const pdf of readJsonl<ExtractedPdf>(EXTRACTED)) {
    const text = cleanArabicDoc(pdf.pages);
    if (!text.trim()) continue;
    for (const chunk of chunker.chunk(text, { language: "ar" })) {
      out.push({
        chunk_id: `${pdf.doc_id}#${chunk.index}`,
        doc_id: pdf.doc_id,
        source: "pdf",
        domain: pdf.domain,
        provider: pdf.provider,
        language: "ar",
        content: chunk.content,
      });
    }
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const path = corpusPath(includeQuestion);
  writeFileSync(path, `${out.map((c) => JSON.stringify(c)).join("\n")}\n`, "utf8");
  const bySource = (s: string) => out.filter((c) => c.source === s).length;
  console.log(
    `corpus (${includeQuestion ? "question+answer" : "answer-only"}) -> ${path}: ` +
      `${out.length} chunks (faq=${bySource("faq")}, pdf=${bySource("pdf")})`,
  );
  return out;
}

export function loadOrBuildCorpus(includeQuestion = false): CorpusChunk[] {
  const path = corpusPath(includeQuestion);
  if (existsSync(path)) return readJsonl<CorpusChunk>(path);
  return buildCorpus(includeQuestion);
}

if (import.meta.main) {
  buildCorpus(process.argv.includes("--include-question"));
}
