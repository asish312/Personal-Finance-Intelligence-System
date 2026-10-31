# PFIS v1.0.0 — Gemini Spreadsheet Repair Prompt

Attach or open the existing PFIS Google Sheets workbook and use this prompt. Prefer the live Google Sheet over an XLSX export.

~~~text
Review and repair the existing PFIS Google Sheets workbook. Do not redesign it from scratch.

1. Inspect every tab, formula, named range, data validation, conditional formatting, chart source and dependency before editing.
2. Protect the canonical Transaction Log. Do not change Transaction IDs, dates, amounts, bank facts, merchant facts, references or source evidence. If a value looks wrong, flag it; do not guess.
3. Repair broken formulas and fixed row limits. Use scalable ranges that include all current and future transactions. Do not hide formula errors with blanket IFERROR or replace formulas with hard-coded results.
4. Keep Transaction Log A:AC in its existing physical order. Do not add an isReviewNeeded column; it is an API Boolean mapped to existing review fields.
5. Keep Transaction Log as canonical facts, Source Log as original evidence, Change Log as append-only audit history, and Rejected & Archive Log as final rejected/duplicate transaction history.
6. Consolidate duplicate dashboard/audit/review presentation. Keep one detailed operational review centre. Distinguish transaction review, source parse failure/conflict and category classification. A PARSE_FAILED source has no canonical transaction until successfully reprocessed.
7. Keep automatic Miscellaneous fallback visibly distinguishable from a human-confirmed category. Do not treat fallback alone as a financial-integrity review. Do not bulk-reclassify historical records without evidence.
8. Correct card reconciliation so statement balances, live outstanding balances, payments and unbilled purchases are not compared as if they were the same measure. Do not show Fully Reconciled unless the underlying figures and period definitions genuinely reconcile.
9. Correct the financial dashboard: distinguish cash flow, consumption, card settlements, internal transfers, investments, commitments and verified savings. Do not double-count payments or include planned savings as actual savings. Exclude unresolved records from verified financial KPIs or label them provisional.
10. Keep all version labels at v1.0.0. Preserve all required support sheets and their dependencies; hide rather than delete uncertain support tabs.

Never modify Apps Script, the iOS Shortcut, Script Properties or API deployment. Never delete historical records or audit evidence. Do not invent categories, purposes, transaction facts or financial values.

After editing, provide a concise change report with exact sheet/cell references, formulas changed, validations completed, reconciliation results and unresolved items. Verify calculations in the live Google Sheets workbook; do not claim success from XLSX cached values.
~~~
