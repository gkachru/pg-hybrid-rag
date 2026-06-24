# Thai FAQ / Policy-PDF Scrape Provenance

> **Note:** The scraped snapshots (`datasets/faqs-th/*.jsonl`) and policy PDFs
> (`datasets/PDFs-th/*.pdf`) are **gitignored and not redistributed** — they have no open
> license. They are local-only frozen corpora for benchmark development. Only this provenance
> file, `queries.json`, and the code are committed.

This benchmark started as a **bounded proof** (one provider per domain) and was then **expanded**
with additional providers and category pages. It now covers **4 providers across 3 domains**
(179 FAQ pairs). The harness scales further to the full broad scope (9 providers) in the design —
re-run the procedure in `scrape/README.md` to extend it.

---

## FAQ snapshots (`datasets/faqs-th/`)

| Provider | Domain | Source page(s) | Method | Date | Pairs | Output |
|---|---|---|---|---|---|---|
| AIS | telecom | `/consumers/help-and-support/fibre` (+ `/network-technologies`, `/package-handset`) | Playwright render → `[aria-expanded]` accordion (question = button text, answer = `aria-controls` panel) | 2026-06-24 | 46 | `datasets/faqs-th/ais.jsonl` |
| SCB | banking | `/th/personal-banking/faq/{card,loan,deposit}-faq.html` | Playwright render → `.collapse-header` (question) + next `.collapse-inner` (answer); nav-menu collapses filtered | 2026-06-24 | 105 | `datasets/faqs-th/scb.jsonl` |
| AIA | insurance | `/th/help-support/faq` | Playwright render → `[aria-expanded]` accordion; stripped leading "N." numbering | 2026-06-24 | 20 | `datasets/faqs-th/aia.jsonl` |
| Muang Thai (MTL) | insurance | `/th/faq` | Playwright render → `<button>` (question) + hidden sibling panel (answer); dropped chat/flow buttons + "คำถามที่พบบ่อย" label prefix | 2026-06-25 | 8 | `datasets/faqs-th/mtl.jsonl` |
| **Total** | | | | | **179** | |

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
  segmenter axis. The `/network-technologies` and `/package-handset` help pages were also scraped
  but their items fully **duplicated** the fibre page's accordion (0 new after dedup) — the fibre
  help page already aggregates network/device topics.
- **SCB:** expanded from cards to `loan-faq` + `deposit-faq` (Speedy Loan, New/Used Car, My Home
  My Cash, Refinance, Slip/Statement, Dormant/Active, อัตราดอกเบี้ยเงินฝาก). The `.collapse-header`
  selector also matches top-nav menu collapses (e.g. "ลูกค้าบุคคล EN", "เกี่ยวกับเรา"); these are
  filtered by a denylist + the "… EN" suffix.
- **MTL:** a second insurer for provider diversity; its FAQ uses `<button>` + hidden-panel
  accordions. Non-FAQ buttons (an English "Step 1" product flow, a "💬 chat" widget) were dropped.
- Existing query `target_doc` ordinals were preserved across the expansion (new docs **appended**
  after existing ones, deduped by question), so `queries.json` stays valid.
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
`datasets/benchmark-cache-th/corpus.jsonl`: **329 chunks** (faq=211 across 179 docs, pdf=118 across
2 docs). By-domain chunk counts: telecom 176, banking 115, insurance 38.

`queries.json`: **25 queries** × {written, spoken, codeswitch} — by domain telecom 8 / banking 10 /
insurance 7; by provider ais 8 / scb 10 / aia 5 / mtl 2. All resolved against the corpus with
target snippets verified present.

## Sources attempted but not used

- **dtac** (telecom): homepage is a heavy SPA exposing no static FAQ links; not scraped.
- **True / Kasikorn / Bangkok Bank / FWD**: not scraped — current coverage (AIS, SCB, AIA, MTL) was
  sufficient; the design's full 9-provider scope remains the documented extension path.
- The AIA main FAQ mixed site-nav `[aria-expanded]` elements with real FAQ accordions; filtering to
  question-like text with non-empty answer panels isolated the 20 real items.
