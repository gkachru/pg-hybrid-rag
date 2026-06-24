# Thai FAQ scrape procedure (reproducible)

The Thai telecom/banking/insurance help centers are JavaScript-rendered SPAs, so the FAQ scrape
is **assisted** (driven through a headless browser), not a committed scraper script. This is the
repeatable procedure used to build the gitignored snapshots in `datasets/faqs-th/`. See
`../scrape-notes.md` for what was actually captured.

## Output schema (`datasets/faqs-th/<provider>.jsonl`)

One `FaqRecord` per line (see `../types.ts`), ordinals contiguous from 0 within each provider:

```json
{"doc_id":"faq:ais:0","domain":"telecom","provider":"ais","question":"…","answer":"…"}
```

`domain ∈ {telecom, banking, insurance}`. Drop terse answers (< 40 chars); whitespace-collapse;
cap answers at ~1200 chars.

## Procedure

1. **Open a headless browser** (Playwright). Navigate to the provider homepage and extract
   help/FAQ links (filter anchors by `faq|help|คำถาม|ช่วยเหลือ`).
2. **Open each FAQ page and identify the accordion mechanism.** Observed patterns:
   - **AIS** (`/consumers/help-and-support/fibre`): `[aria-expanded]` buttons; question = button
     text, answer = the element referenced by the button's `aria-controls`.
   - **SCB** (`/th/personal-banking/faq/card-faq.html`): `.collapse-header` (question) followed by
     a sibling `.collapse-inner` (answer). Drop non-FAQ nav collapses (short labels, "… EN",
     "เกี่ยวกับเรา"); renumber the survivors.
   - **AIA** (`/th/help-support/faq`): `[aria-expanded]` buttons mixed with site-nav; keep only
     question-like text (ends with ไหม/อย่างไร/หรือไม่/อะไร/`?` …) whose `aria-controls` panel has
     ≥ 40 chars; strip a leading "N." index.
3. **Extract Q/A pairs** (the answer panel text is in the DOM even when visually collapsed —
   no per-item clicking needed), assign `doc_id`/`domain`/`provider`, and write the JSONL.
4. **Validate** the snapshot:

```bash
bun -e '
import { readdirSync, readFileSync, existsSync } from "node:fs";
const dir = "datasets/faqs-th";
if (!existsSync(dir)) { console.error("no datasets/faqs-th"); process.exit(1); }
let total = 0; const byDomain = {};
for (const f of readdirSync(dir).filter(f=>f.endsWith(".jsonl"))) {
  const lines = readFileSync(`${dir}/${f}`,"utf8").trim().split("\n").filter(Boolean);
  lines.forEach((l,i)=>{
    const r = JSON.parse(l);
    if (!r.doc_id || !r.question || !r.answer || !r.domain || !r.provider) throw new Error(`${f} line ${i}: missing field`);
    if (r.doc_id !== `faq:${r.provider}:${i}`) throw new Error(`${f} line ${i}: doc_id/ordinal mismatch ${r.doc_id}`);
    byDomain[r.domain] = (byDomain[r.domain]||0)+1;
  });
  total += lines.length; console.log(`${f}: ${lines.length} pairs`);
}
console.log(`TOTAL ${total} pairs`, byDomain);
'
```

## Policy-PDF distractors (`datasets/PDFs-th/`)

Download provider T&C / policy PDFs named `<provider>_<freeform>.pdf` (e.g. `ais_postpaid_tc.pdf`),
then `python examples/benchmark-thai/extract_pdfs.py` → `datasets/benchmark-cache-th/extracted.jsonl`.

## Build the corpus

```bash
bun run examples/benchmark-thai/buildCorpus.ts
```

> Snapshots and PDFs are gitignored (covered by the repo-wide `datasets/` ignore) — they are not
> redistributed.
