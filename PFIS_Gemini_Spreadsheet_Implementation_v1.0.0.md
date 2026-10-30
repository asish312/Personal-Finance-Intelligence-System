# PFIS v1.0.0 — Gemini Spreadsheet Implementation Guide

## 1. Gemini's role

Gemini is a user-authorised spreadsheet assistant. It can help inspect, explain, design and edit the Google Sheets workbook through connected Google Workspace Sheets capabilities and Gemini's Sheets side panel.

Gemini is not embedded in the PFIS transaction engine. It does not receive bank notifications from the Shortcut and does not call Apps Script. The owner starts workbook-authoring tasks or configures a separate daily Gemini Task.

The three workflows are distinct:

| Workflow | Tool | Responsibility |
|---|---|---|
| Live transaction capture | iOS Shortcut + Apps Script | Convert source alerts into canonical transactions |
| Daily Purpose suggestions | Gemini Task + Google Sheets | Suggest factual Purpose text in a review queue |
| Workbook improvement | Gemini in Google Sheets | Formulas, UI labels, charts, documentation and workbook planning |

## 2. How a first-time user navigates the workbook

Keep the workbook UI understandable without reading code:

- Dashboard: the current financial picture and main trends.
- Recent Transactions: the newest canonical ledger events.
- Transaction Log: the canonical transaction data.
- Monthly Summary: cash-flow date view and budget-period view.
- Insights & Data Quality: transaction integrity issues and missing information.
- Purpose Review Queue: daily Gemini suggestions that await a human decision.
- Savings Sweep Log: planned versus verified transfers to savings.
- Categories, Config and Rules: setup/configuration.
- Holiday Calendar: verified working-day overrides.
- Source Log and Change Log: source evidence and audit history.
- Data Dictionary and PFIS System Guide: definitions and operating explanations.
- Dashboard_Calc: calculation helpers, not the main user interface.

The engine's six required core sheets are Transaction Log, Source Log, Change Log, Rules, Config and Categories.

## 3. Non-negotiable workbook safeguards

- Do not change Transaction IDs, actual amounts, dates, banks, merchants or source text.
- Do not delete or merge historic records.
- Do not rewrite Source Log or Change Log.
- Do not alter physical order A:AC of the canonical Transaction Log.
- Optional budget reporting columns are AN: Budget Month and AO: Income Month. They are outside the core A:AC schema.
- Do not put Gemini suggestions in Transaction Log directly.
- Purpose is optional; it is not a transaction validity requirement.
- Do not treat planned savings as verified savings.
- Do not represent workbook features as live until formulas/charts are checked in the actual Google Sheet.

## 4. Dynamic UI and formulas

### Recent Transactions
Use a formula-driven latest-30 view from the canonical Transaction Log. Sort by actual DateTime descending. Keep it read-only if the output uses a spill formula. The Apps Script engine writes to Transaction Log; formula recalculation refreshes the view.

### Dashboard and Insights
Audit formulas in Insights & Data Quality, Dashboard_Calc, Monthly Summary, Dashboard and Reports. Avoid hard-coded row limits. Replace unsupported formulas at the root cause; do not hide broken functions using IFERROR or replace them with static values.

Needs Review should include needsReview=TRUE, Review Status=Pending and validation flags DUPLICATE_CANDIDATE, SOURCE_CONFLICT and NEEDS_REVIEW. Count transaction IDs once. Keep missing Purpose separate.

The getdataquality API returns metrics under response.data. Do not assume they exist at the response root.

### Month logic
Income Month is the actual calendar month income is received. Budget Month is the planning period assigned to the transaction. Rules H Month Offset controls the month label in a notes template; Rules W Budget Month Offset controls budget allocation. Do not use day>=28 as a proxy for a last-working-day trigger.

For legacy rows, inspect Rule Applied values and explicitly map legacy rule IDs before backfilling. Do not blindly match historical rule IDs to current Rules IDs.

## 5. Salary and holiday configuration

The generic documentation example uses:
- Month Offset (H)=0
- Auto Purpose (T)=FALSE
- Purpose Trigger (U)=LAST_WORKING_DAY_OF_MONTH
- Calendar Scope (V)=EMPLOYER_DEMO
- Budget Month Offset (W)=1

The engine evaluates the transaction's own date. It does not create a forecast salary. A configured Holiday Calendar can override default Monday-Friday working days for a named scope or ALL.

Use a neutral public alias in repository examples. Only maintain real employer holiday dates in the private workbook, and only when verified.

## 6. Daily Purpose Review Queue

The Gemini Task guide is in PFIS_Gemini_Purpose_Enrichment_v1.0.0.md. Use it to create a daily Task in Gemini Task mode with Google Workspace Sheets connected.

Purpose Review Queue must contain these exact headers:
Suggestion ID | Transaction ID | Transaction Date | Merchant | Amount | Category | Type | Suggested Purpose | Evidence Summary | Evidence Source IDs | Confidence | Status | Gemini Run At | Reviewed By | Reviewed At | Applied At | Apply Result

Gemini:
- reads the recent blank-Purpose transactions and linked Source Log evidence,
- skips review conflicts, invalid categories/types and weak source evidence,
- adds concise suggestions with Status=SUGGESTED,
- never changes Transaction Log,
- never marks Status=APPROVED,
- does not create duplicate suggestions for the same transaction.

A reviewer opens the cited source evidence and either rejects the idea or changes Status to APPROVED with Reviewed By and Reviewed At filled.

The daily task uses the previous 7 calendar days as a retry window; it must scan the queue to avoid repeating already-present Transaction IDs. Keep the queue protected from accidental edits to source IDs/transaction IDs; the reviewer should only need to change approval fields.

Google notes that Gemini Tasks support scheduled execution and Google Sheets actions, but editing shared spreadsheets can require review/confirmation of planned changes. If confirmation is required, the task is not fully unattended.

## 7. Apply approved Purpose suggestions

The Apps Script engine includes PFIS_APPLY_APPROVED_PURPOSE_SUGGESTIONS().

It checks:
- Status is APPROVED,
- Reviewed By and Reviewed At are present,
- every Evidence Source ID is linked to the same Transaction ID,
- transaction still exists,
- Purpose is still blank,
- transaction is not a duplicate/source conflict/rejected record,
- suggestion is meaningful and does not merely repeat the merchant.

It then calls the existing update pipeline. This is important: the Change Log receives the edit. The queue row becomes APPLIED, STALE, BLOCKED or APPLY_ERROR.

Run manually or configure an Apps Script time-driven trigger for this function. A trigger may process APPROVED rows only; it must never approve them.

## 8. Zero-based budget and savings planning

A budget month starts with opening budget allocation zero. Actual bank balances are not reset.

The workbook should present:
- Income Allocated
- Essential Commitments
- Actual Operating Spend
- Debt and EMI Settlements
- Investment Allocation
- Pre-Sweep Surplus
- Planned Savings Sweep
- Actual Verified Savings Sweep
- Remaining Unallocated
- Sweep Variance and Status

A Savings Sweep Log should reference source debit and destination savings credit Transaction IDs. It is complete only if both transactions exist, both accounts are genuinely owned by the user, amounts match and evidence supports the same internal transfer.

The Apps Script engine does not initiate a transfer or currently create this workbook planning sheet. This is a separate workbook enhancement.

## 9. Meaningful chart design

Prefer visuals that answer different questions:
- income versus outflow by actual month,
- net cash-flow trend,
- budget allocation by Budget Month,
- spending categories,
- merchant concentration,
- recurring commitments,
- source coverage (SMS/email/verified),
- review queue composition,
- planned versus verified savings.

Each chart must use a documented calculation range, show its period and unit, and display an empty-data state when there is insufficient evidence. Do not insert illustrative/demo numbers into production calculations.

## 10. Copy/paste workbook implementation prompt

You are working on the existing PFIS Google Sheets workbook. Inspect its actual sheets, formulas, named ranges, chart sources and dependencies before editing.

Implement workbook-only enhancements:
1. Make Recent Transactions a live latest-30 view of Transaction Log.
2. Replace fixed row limits and repair unsupported formulas in Insights & Data Quality, Dashboard_Calc, Monthly Summary, Dashboard and Reports.
3. Maintain the canonical A:AC transaction schema and optional AN Budget Month / AO Income Month reporting fields.
4. Configure the generic EMPLOYER_DEMO month-end salary rule with Month Offset 0, Auto Purpose FALSE, Purpose Trigger LAST_WORKING_DAY_OF_MONTH and Budget Month Offset 1.
5. Maintain only verified Holiday Calendar dates.
6. Design the zero-based monthly allocation view without resetting actual bank balances.
7. Create Purpose Review Queue using the exact 17-header schema. The daily Gemini Task writes SUGGESTED rows only. Do not write Purpose directly to Transaction Log.
8. Add clear human approval controls and protect system-managed fields.
9. Add Savings Sweep Log for two-leg transfer reconciliation. Do not label a plan as verified savings.
10. Update Data Dictionary, visible labels and meaningful chart sources.

Never modify Apps Script or Shortcuts. Never change transaction IDs, amounts, dates, source evidence or audit records. Do not delete/merge historical rows. Purpose is optional and must not increase Needs Review.

At completion, report exact cells/ranges changed, before/after behaviour, source columns, validation results and remaining manual configuration. Do not claim a formula/chart is operational until inspected in the live Google Sheet.
