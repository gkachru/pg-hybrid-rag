# examples/benchmark/extract_pdfs.py
"""Raw per-page text extraction for the Arabic RAG benchmark.
Cleaning (boilerplate strip + Arabic-script filter) happens in TS (cleanArabic.ts);
this script only extracts text with pypdf. Usage: python examples/benchmark/extract_pdfs.py
"""
import json
import os
import sys
from pypdf import PdfReader

PDF_DIR = os.path.join("datasets", "PDFs")
OUT_DIR = os.path.join("datasets", "benchmark-cache")
OUT = os.path.join(OUT_DIR, "extracted.jsonl")

# provider slug + domain per known filename prefix; default provider = filename stem, domain banking.
DOMAIN_BY_KEYWORD = [("etisalat", "telecom"), ("eand", "telecom")]

def classify(filename: str):
    stem = os.path.splitext(filename)[0]
    provider = stem.split("_")[0]
    domain = "banking"
    for kw, dom in DOMAIN_BY_KEYWORD:
        if kw in stem.lower():
            domain = dom
            break
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
