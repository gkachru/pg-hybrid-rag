# examples/benchmark-thai/extract_pdfs.py
"""Raw per-page text extraction for the Thai RAG benchmark.
Cleaning (boilerplate strip + Thai-script filter) happens in TS (cleanThai.ts);
this script only extracts text with pypdf.
Filename convention: <provider>_<freeform>.pdf  (e.g. ais_roaming_terms.pdf).
Usage: python examples/benchmark-thai/extract_pdfs.py
"""
import json
import os
import sys
from pypdf import PdfReader

PDF_DIR = os.path.join("datasets", "PDFs-th")
OUT_DIR = os.path.join("datasets", "benchmark-cache-th")
OUT = os.path.join(OUT_DIR, "extracted.jsonl")

DOMAIN_BY_PROVIDER = {
    "ais": "telecom",
    "true": "telecom",
    "dtac": "telecom",
    "scb": "banking",
    "kbank": "banking",
    "bbl": "banking",
    "aia": "insurance",
    "muangthai": "insurance",
    "fwd": "insurance",
}

def classify(filename: str):
    stem = os.path.splitext(filename)[0]
    provider = stem.split("_")[0].lower()
    domain = DOMAIN_BY_PROVIDER.get(provider, "telecom")
    return provider, domain

def main():
    if not os.path.isdir(PDF_DIR):
        print(f"No {PDF_DIR}/ directory; nothing to extract.", file=sys.stderr)
        return
    os.makedirs(OUT_DIR, exist_ok=True)
    pdfs = sorted(f for f in os.listdir(PDF_DIR) if f.lower().endswith(".pdf"))
    with open(OUT, "w", encoding="utf-8") as out:
        for ordinal, fn in enumerate(pdfs):
            provider, domain = classify(fn)
            try:
                reader = PdfReader(os.path.join(PDF_DIR, fn))
                pages = [(p.extract_text() or "") for p in reader.pages]
            except Exception as e:  # noqa: BLE001 - prep tool, log and skip
                print(f"SKIP {fn}: {e}", file=sys.stderr)
                continue
            rec = {
                "doc_id": f"pdf:{provider}:{ordinal}",
                "provider": provider,
                "domain": domain,
                "title": fn,
                "pages": pages,
            }
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            print(f"  {fn} -> {len(pages)} pages (provider={provider}, domain={domain})")
    print(f"Wrote {OUT}")

if __name__ == "__main__":
    main()
