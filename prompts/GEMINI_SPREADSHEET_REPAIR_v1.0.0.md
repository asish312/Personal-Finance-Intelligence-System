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

11. Preserve the account baseline and live-balance contract:
    - Config!L:P is a reporting matrix, not part of the Apps Script Config A:I plus optional J schema.
    - AXIS_SAVINGS opening baseline is ₹11,204.00 anchored at 2026-10-20.
    - The requested target display is net activity ₹57,462.05 and live balance ₹68,666.05.
    - Inspect the actual Config!O2 formula. In the supplied export it is SUMIFS since 2026-10-20 minus ₹202.02; raw ledger activity is ₹57,664.07. Do not silently remove this adjustment or invent a replacement plug. Reconcile the difference to source transactions and audit evidence first. Once resolved, make net activity a pure date-bounded formula and live balance = baseline + activity.
    - Fill Config!P2:P5 with formulas =Nrow+Orow rather than hard-coded balances. Preserve each account's verified baseline and activity anchor.
12. Preserve the accounting formula: Net Cash Flow = Income (Dashboard_Calc!V6) - Net Consumption (V7) - Investments (V8). Card bill payments (Transaction Log!G="Credit card payments") are liability settlements reported separately in V9 and must not be subtracted again when purchase consumption is already represented.
13. Verify the liquidity cards in Dashboard!B12:O14:
    - B13 = Config!P2
    - E13 = Config!P3
    - I13 = Config!P4+Config!P5
    - M13 = -SUM('Card Reconciliation Log'!P2:P5)
    - Keep the cards between primary KPIs and Section A cash-flow charts. Do not include duplicate LIVE reconciliation rows 6:9 in the card-liability sum.
14. The current workbook snapshot shows V10 = +₹6,995.61. The cumulative displayed monthly operating surplus is ₹1,71,360.36 (whole-rupee presentation ₹1,71,360). Do not hard-code either amount. Verify live formulas and explain any export-only cached formula values; Monthly Summary and Dashboard_Calc contain Google Sheets-specific dynamic-array wrappers and the uploaded export has a blank Dashboard_Calc!D3 formula.

After editing, provide a concise change report with exact sheet/cell references, formulas changed, validations completed, reconciliation results and unresolved items. Verify calculations in the live Google Sheets workbook; do not claim success from XLSX cached values.
~~~


Before claiming completion, also compare your results against docs/ACCOUNT_BALANCES.md, docs/FINANCIAL_ACCOUNTING_CONTRACT.md, docs/CONFIG.md and docs/DASHBOARD_SPEC.md.