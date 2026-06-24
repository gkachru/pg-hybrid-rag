# Thai FAQ / Policy-PDF Scrape Provenance

> **Note:** The scraped snapshots (`datasets/faqs-th/*.jsonl`) and policy PDFs
> (`datasets/PDFs-th/*.pdf`) are **gitignored and not redistributed** — they have no open
> license. They are local-only frozen corpora for benchmark development. Only this provenance
> file, `queries.json`, and the code are committed.

This benchmark was built as a **bounded proof** (3 providers × 3 domains, one provider per
domain) to validate the end-to-end pipeline. The harness scales to the full broad scope
(9 providers) documented in the design — re-run the procedure in `scrape/README.md` to extend it.

---

## FAQ snapshots (`datasets/faqs-th/`)

| Provider | Domain | Source page | Method | Date | Pairs | Output |
|---|---|---|---|---|---|---|
| AIS | telecom | https://www.ais.th/consumers/help-and-support/fibre | Playwright render → `[aria-expanded]` accordion (question = button text, answer = `aria-controls` panel) | 2026-06-24 | 46 | `datasets/faqs-th/ais.jsonl` |
| SCB | banking | https://www.scb.co.th/th/personal-banking/faq/card-faq.html | Playwright render → `.collapse-header` (question) + next `.collapse-inner` (answer) | 2026-06-24 | 19 | `datasets/faqs-th/scb.jsonl` |
| AIA | insurance | https://www.aia.co.th/th/help-support/faq | Playwright render → `[aria-expanded]` accordion; stripped leading "N." numbering | 2026-06-24 | 20 | `datasets/faqs-th/aia.jsonl` |
| **Total** | | | | | **85** | |

**Notes:**
- All three pages are JavaScript-rendered SPAs; a headless browser (Playwright MCP) was required
  to render them — static `fetch` returns only the app shell.
- Answers were captured from the in-DOM accordion panels (present even when visually collapsed),
  whitespace-collapsed, terse answers (< 40 chars) dropped, and capped at 1200 chars.
- **SCB:** the `.collapse-header` selector also matched 6 top-navigation menu collapses
  (e.g. "ลูกค้าบุคคล EN", "เกี่ยวกับเรา"); these non-FAQ leaks were dropped and the remaining
  19 credit-card FAQ items renumbered `faq:scb:0..18`.
- **AIS:** the fibre help center yielded the richest loanword density (Fibre, แพ็กเกจ/package,
  อินเทอร์เน็ต/internet, Public IP, Port forwarding, Wireless, AIS PLAYBOX) — ideal for the
  segmenter axis.
- Content is in-domain noise + scored FAQ answers; doc_id format `faq:<provider>:<ordinal>`.

## Policy / T&C PDF distractors (`datasets/PDFs-th/`)

| File | Provider | Domain | Source | Date | Pages |
|---|---|---|---|---|---|
| `ais_postpaid_tc.pdf` | ais | telecom | https://www.ais.th/content/dam/ais/consumer/pdf/AWN_Post-Paid-th.pdf | 2026-06-24 | 14 |
| `ais_prepaid_tc.pdf` | ais | telecom | https://www.ais.th/content/dam/ais/consumer/pdf/AWN_Pre-Paid-th.pdf | 2026-06-24 | 13 |

Downloaded via `curl`. Both are text PDFs (Thai script confirmed extractable via pypdf). Indexed
as **distractors only** — no query targets a `pdf:*` doc. Filename convention `<provider>_<freeform>.pdf`
lets `extract_pdfs.py` classify the domain.

---

## Built corpus

`bun run examples/benchmark-thai/buildCorpus.ts` →
`datasets/benchmark-cache-th/corpus.jsonl`: **225 chunks** (faq=107 across 85 docs, pdf=118 across
2 docs). By-domain chunk counts: telecom 176, insurance 26, banking 23.

## Sources attempted but not used (bounded scope)

True / dtac (telecom), Kasikorn / Bangkok Bank (banking), and Muang Thai / FWD (insurance) were
**not scraped** — one provider per domain was sufficient for the bounded proof. The AIA main FAQ
mixed site-nav `[aria-expanded]` elements with real FAQ accordions; filtering to question-like
text with non-empty answer panels isolated the 20 real items.
