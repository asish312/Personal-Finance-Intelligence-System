# PFIS v1.0.0 — Gemini Workbook Guide

Gemini can help the workbook owner inspect and improve the Google Sheets interface. It is an optional, user-authorised assistant, not part of the live transaction-ingestion runtime.

## Keep the three workflows separate

| Workflow | Tool | Responsibility |
|---|---|---|
| Live transaction capture | iOS Shortcut + Apps Script | Convert notifications into canonical financial records |
| Workbook maintenance | Gemini in Google Sheets | Inspect formulas, views, labels, charts and documentation |
| Optional Purpose suggestions | Gemini Task + Purpose Review Queue | Propose factual descriptions for human approval |

Gemini must not receive bank notifications from the Shortcut and must not call Apps Script as part of ordinary transaction capture.

## Prepare before asking Gemini to edit

1. Open the owner's actual Google Sheets workbook, not a stale export.
2. Make a backup or duplicate of the workbook before structural changes.
3. Connect Gemini to the Google account/workbook with only the permissions required.
4. Provide the relevant workbook and the [repair prompt](../prompts/GEMINI_SPREADSHEET_REPAIR_v1.0.0.md).
5. Ask Gemini to inspect all tabs, formulas, named ranges, data validation, conditional formatting, chart sources and dependencies before editing.
6. Review its proposed changes before accepting them.

An XLSX export is useful for comparison and auditing, but Google Sheets formulas may not export as executable Excel formulas. Verify the live formulas in Google Sheets; do not treat cached values in an exported file as calculation proof.

## Workbook responsibilities

- Transaction Log is the canonical financial fact ledger.
- Source Log preserves the original incoming evidence and processing status.
- Change Log records supported changes and human decisions.
- Rejected & Archive Log preserves final rejected/duplicate transaction history.
- Categories, Config and Rules provide controlled vocabulary and deterministic mappings.
- Dashboard, Reports and Insights & Data Quality are presentation/analysis surfaces.
- Helper sheets may be hidden from normal navigation but must not be deleted until dependencies are verified.

The engine's canonical Transaction Log A:AC schema is positional. Preserve it. Auxiliary fields and Budget Month/Income Month may exist after the core schema. Do not add a physical <code>isReviewNeeded</code> column; the request Boolean maps to existing review fields.

## Non-negotiable safeguards

- Do not change Transaction IDs, source facts, actual dates, signed amounts, bank facts, merchant facts or references without source evidence and an audit event.
- Do not delete, merge or silently reclassify historical transactions.
- Do not clear, rewrite or fabricate Source Log or Change Log history.
- Do not automatically archive a suspected duplicate.
- Do not count a missing Purpose as a required review.
- Do not present planned savings as verified savings.
- Do not hard-code calculated financial values or blanket-hide formula errors.
- Do not modify Apps Script source, Script Properties or iOS Shortcut actions during a workbook-only task.
- Keep all displayed release identifiers at <code>v1.0.0</code>.

## What a good Gemini completion report contains

Ask Gemini to report:

- Every sheet inspected and each sheet changed/hidden/removed.
- Exact formula cells/ranges changed, with old and new logic.
- Changes to named ranges, validations, conditional formats and chart sources.
- How current and future rows are included.
- Reconciliation between Dashboard/Reports/Summary and Transaction Log.
- Which issues remain unresolved or require a human decision.
- Confirmation that the actual Google Sheets formulas were recalculated and inspected.

Do not accept "completed" if Gemini only describes what it intends to do or relies on XLSX cached values.
