# FAQ Scrape Provenance Notes

> **Note:** The JSONL snapshots (`datasets/faqs/*.jsonl`) are gitignored and not redistributed.
> They are local-only frozen corpora for benchmark development.

---

## zain_kw — Zain Kuwait

| Field | Value |
|---|---|
| Source URL | https://www.kw.zain.com/ar/faq |
| Scrape method | WebFetch (server-rendered, converted to Markdown) |
| Date | 2026-06-19 |
| Domain | telecom |
| Approx pair count | 94 |
| Output file | `datasets/faqs/zain_kw.jsonl` |

**Notes:** The Zain Kuwait FAQ page is fully server-rendered and returns rich Arabic content via WebFetch. Coverage spans postpaid/prepaid plans, roaming, international calls, number porting (MNP), billing, internet services, 5G, smart home devices, digital channels (zBot, MyZain app), and value-added services (VoLTE, VoWi-Fi, OSN Streaming, Zain Pay). Pairs with terse one-clause answers (e.g. "visit a branch") were either excluded or expanded where sufficient context was available.

---

## abk — Al-Ahli Bank of Kuwait (ABK)

| Field | Value |
|---|---|
| Source URLs | https://abk.eahli.com/ar/help-and-support/faqs/online-banking/ |
| | https://abk.eahli.com/ar/help-and-support/faqs/cards/ |
| Scrape method | WebFetch (server-rendered, converted to Markdown) |
| Date | 2026-06-19 |
| Domain | banking |
| Approx pair count | 57 |
| Output file | `datasets/faqs/abk.jsonl` |

**Notes:** Two FAQ sub-pages were scraped: online banking (registration, passwords, transfers, account statements, IBAN validation) and cards (credit/debit/prepaid card fees, ATM limits, Tap n Go NFC payments, multi-currency Mastercard, Emirates Skywards miles). The accounts and transfers sub-pages returned no FAQ text (JavaScript-rendered). Terse answers were dropped; substantive pairs with procedural detail were retained.

---

## sab — Saudi Awwal Bank (SAB / الأول)

| Field | Value |
|---|---|
| Source URL | https://www.sab.com/ar/personal/help-and-support/faqs/ |
| Scrape method | WebFetch (server-rendered, converted to Markdown) |
| Date | 2026-06-19 |
| Domain | banking |
| Approx pair count | 12 |
| Output file | `datasets/faqs/sab.jsonl` |

**Notes:** The SAB FAQ page returned a moderate set of Arabic Q&A pairs covering the Wafir savings account (Islamic finance principles, profit rates, minimum deposit, withdrawal rules) and credit card instalment plans and cashback. Only substantive pairs retained.

---

## Sources Attempted but Failed

| Provider | URL | Outcome |
|---|---|---|
| Boubyan Bank | https://www.bankboubyan.com/ar/faq | NO FAQ TEXT FOUND — FAQ answers are JavaScript-rendered (SPA); only question headings visible in static HTML |
| SAMA consumer FAQ | https://sama.gov.sa/ar-sa/ConsumerProtection/pages/faqsbanksconsumers.aspx | NO FAQ TEXT FOUND — page is JavaScript-rendered |
| SAMA credit cards FAQ | https://sama.gov.sa/ar-sa/ConsumerProtection/pages/faqscreditandchargecards.aspx | NO FAQ TEXT FOUND — page is JavaScript-rendered |
| ABK Accounts sub-page | https://abk.eahli.com/ar/help-and-support/faqs/accounts/ | NO FAQ TEXT FOUND — JavaScript-rendered |
| ABK Transfers sub-page | https://abk.eahli.com/ar/help-and-support/faqs/transfers/ | NO FAQ TEXT FOUND — JavaScript-rendered |

---

## Summary

| Provider | Domain | Pairs |
|---|---|---|
| zain_kw | telecom | 94 |
| abk | banking | 57 |
| sab | banking | 12 |
| **Total** | | **163** |

Both required domains (`banking`, `telecom`) are covered. All pairs verified with the acceptance-criteria script: `pairs 163 domains banking,telecom`.
