# PFIS v1.0.0 — Current Maintainer Notes

This file is the current implementation status and responsibility map. It supersedes earlier review handoffs.

## 1. Repository purpose

PFIS is a notification-driven personal-finance workflow with:
- an iOS Shortcut for source capture and mobile receipts,
- a Google Apps Script Web App for deterministic transaction processing,
- a Google Sheets workbook for canonical data, configuration, audit history and analytics,
- Gemini Tasks as an optional scheduled workbook assistant for evidence-based Purpose suggestions,
- Gemini in Google Sheets as a separate authoring assistant for workbook formulas/UI/documentation.

Production engine, schema and parser remain v1.0.0. Keep the production filenames unchanged.

## 2. Current files

| File | Purpose |
|---|---|
| PFIS_TransactionEngine_v1.0.0.gs | Production Apps Script engine |
| PFIS_Preflight_Tests_v1.0.0.gs | Bounded synthetic regression/integration suite |
| PFIS_Prompts_Final_v1.0.0_Prompts.txt | Current Shortcut extraction and category prompts |
| PFIS_Shortcut_Implementation_v1.0.0.txt | Shortcut/API integration contract |
| PFIS_Operating_Guide_v1.0.0.md | UI, architecture and end-to-end operation |
| PFIS_Gemini_Purpose_Enrichment_v1.0.0.md | Daily Gemini Task, queue and approval workflow |
| PFIS_Gemini_Spreadsheet_Implementation_v1.0.0.md | Workbook-side Gemini enhancements |
| README.md | Public project story and fictional analytics |
| docs/images/*.svg | Synthetic README illustrations |

## 3. User interface and service boundaries

### Google Sheets
The workbook is the primary financial UI: Dashboard, Recent Transactions, Monthly Summary, Transaction Log, Insights & Data Quality, Reports, configuration, review, evidence and audit tabs.

### iOS Shortcut
The Shortcut captures SMS/email content, runs the extraction prompt, sends JSON to Apps Script and displays a response based on nextAction.

### Apps Script
The Web App is a JSON API, not a custom HTML dashboard. The repository has no HTML/CSS/JS dashboard frontend. doGet has an optional pfisServeDashboardHtml hook if another project file defines it; this repository's engine does not define it.

### Gemini
Gemini is not a dependency of the transaction engine.
- Gemini Tasks can be configured separately to inspect the workbook daily and append Purpose suggestions to Purpose Review Queue.
- Gemini Sheets authoring can be used manually for formulas, UI, charts and documentation.
- Neither is invoked by the iOS Shortcut or Apps Script.
- Current Google Tasks capabilities and account requirements vary; see the operating guide and linked Google Help pages.
- Editing shared spreadsheets may require confirmation of Gemini's planned changes.

## 4. Core engine contract

Required core sheets:
- Transaction Log
- Source Log
- Change Log
- Rules
- Config
- Categories

The canonical Transaction Log schema A:AC is positional and must not be reordered. Optional/legacy auxiliary fields sit outside the core layout. Optional reporting periods use headers Budget Month (AN) and Income Month (AO).

Required Script Property:
- SPREADSHEET_ID

Optional Script Property:
- WEB_APP_SECRET

Time zone:
- Asia/Kolkata

Writes use HTTP POST JSON. Main actions include ingest, update, reprocesssource and resolveexception. Read actions include health, validate, gettransaction, getpendingreview, getneedsenrichment, searchtransactions, getfinancialoverview, getcategorybreakdown, getmerchantanalysis, getrecurringcommitments, getcashflow, getspendingbehavior, getanomalies and getdataquality.

## 5. Purpose logic — current, not historical behaviour

Purpose is OPTIONAL.
- pfisGetEnrichmentState returns requiresPurpose=false.
- needsEnrichment only reflects category classification.
- getneedsenrichment queues missing/invalid category cases only.
- Missing Purpose is counted separately under getdataquality response.data.missingPurpose.
- Normal Shortcut nextAction must not ask ASK_PURPOSE.
- A valid transaction with blank Purpose should return a receipt unless another independent integrity/review issue exists.

Instant engine rule:
- Auto Purpose=TRUE may populate a meaningful configured rule Notes Template.
- A supported Purpose Trigger may also populate a meaningful purpose, even when Auto Purpose=FALSE.
- Current supported trigger is LAST_WORKING_DAY_OF_MONTH.
- It evaluates the transaction's own date and optional Holiday Calendar override.
- Recurrence alone does not authorise purpose inference.

## 6. Daily Gemini Purpose workflow

Optional sheet:
**Purpose Review Queue**

Headers:
Suggestion ID | Transaction ID | Transaction Date | Merchant | Amount | Category | Type | Suggested Purpose | Evidence Summary | Evidence Source IDs | Confidence | Status | Gemini Run At | Reviewed By | Reviewed At | Applied At | Apply Result

Gemini Task:
- Runs daily (owner-configured schedule).
- Reads recent blank-Purpose canonical transactions and linked Source Log evidence.
- Proposes factual descriptions only when the source explicitly supports them.
- Writes Status=SUGGESTED only.
- Never writes directly to Transaction Log.
- Never marks Status=APPROVED.
- Must avoid repeated suggestions by Transaction ID.
- Must not copy complete raw SMS/email or sensitive account details into the queue.

Human reviewer:
- Checks the original Source Log evidence.
- Sets Status=APPROVED and enters Reviewed By/Reviewed At, or REJECTED/NEEDS_MORE_EVIDENCE.

Apps Script application:
- Global function PFIS_APPLY_APPROVED_PURPOSE_SUGGESTIONS().
- Reads only APPROVED rows.
- Checks reviewer fields and Source IDs linked to the same Transaction ID.
- Confirms the canonical Purpose is still blank.
- Blocks duplicate/source conflict/rejected transaction states.
- Calls pfisUpdateTransaction and therefore uses normal validation and Change Log audit.
- Marks APPLIED, STALE, BLOCKED or APPLY_ERROR.
- Can be run manually or by an Apps Script time-driven trigger. The trigger applies approved items only; it does not approve Gemini suggestions.

The helper does not call Gemini or create suggestions. Gemini Task is a separate integration.

## 7. Duplicate and review policy

- Exact source replay is idempotent.
- Strong cross-channel and eligible payment-event matches can link source evidence to an existing transaction.
- Uncertain candidates remain in the active ledger and review queue.
- SOURCE_CONFLICT remains reviewable.
- CONFIRM_DISTINCT explicitly retains a genuine transaction.
- CONFIRM_DUPLICATE requires a human reason and surviving duplicateOf ID; archive preserves auxiliary data, source relinks and Change Log entries.
- Historical records are not automatically merged or deleted.

## 8. Salary and budget month

Generic example only; no actual employer name is stored in repository docs:
- Month Offset H = 0
- Auto Purpose T = FALSE
- Purpose Trigger U = LAST_WORKING_DAY_OF_MONTH
- Calendar Scope V = EMPLOYER_DEMO
- Budget Month Offset W = 1

The transaction date determines earned-month Purpose and Income Month. Budget Month Offset determines the budget period. Monday-Friday are working by default, with Saturday/Sunday non-working; optional Holiday Calendar rows override dates. Use verified holiday data only.

## 9. Workbook roadmap and live status

| Feature | Ownership / status |
|---|---|
| Canonical transaction insertion | Apps Script engine |
| Source Log and Change Log writes | Apps Script engine |
| Duplicate detection and human resolution | Apps Script engine |
| Optional Purpose / category fallback | Apps Script engine |
| Last-working-day Purpose trigger | Apps Script engine when rule/calendar configured |
| Budget Month / Income Month optional fields | Apps Script writes if headers exist |
| Purpose Review Queue schema + approval applier | Engine helper; sheet is workbook-side and must be created |
| Daily Gemini Purpose suggestions | Owner-created Gemini Task; must be configured and verified |
| Recent Transactions dynamic formula | Workbook UI feature |
| Dynamic dashboards / formula repairs | Workbook implementation |
| Zero-based budget | Workbook planning model |
| Savings Sweep Log | Workbook planning and reconciliation; not bank-transfer execution |
| Automatic transfer to savings | Not supported by Apps Script |
| Gemini API/runtime integration | Not present |
| Custom Apps Script dashboard frontend | Not present in this repository |

Do not claim workbook features or Gemini schedules are live until they exist and have been verified in the actual account/workbook.

## 10. Preflight and release

Run:
PFIS_RUN_ALL_PREFLIGHT_TESTS()

The suite:
- checks configured workbook schema read-only when SPREADSHEET_ID exists,
- runs pure helper tests,
- creates a disposable synthetic workbook for integration tests,
- attempts to trash the temporary workbook in finally,
- outputs a JSON report.

The suite now includes a synthetic Purpose Review Queue test:
- SUGGESTED cannot write to Transaction Log.
- Human APPROVED with reviewer and timestamp applies through the update pipeline.
- Change Log records the Purpose update.
- A second run does not overwrite the applied Purpose.

A syntax check is not an Apps Script runtime pass. Before production deployment, run the suite inside Apps Script and verify:
- failed=0,
- syntheticIntegration.status=COMPLETED,
- cleanup.success=true,
- overallStatus is appropriate for the configured live schema check.

After source changes, deploy a new Web App version.

## 11. Privacy conventions

Use fictional values, fake transaction IDs and generic names only in repository docs/tests. Do not commit:
- real employer names,
- bank SMS/email contents,
- account/card numbers,
- personal names,
- balances or live transaction references,
- SPREADSHEET_ID or WEB_APP_SECRET.

The generic company calendar alias is EMPLOYER_DEMO.
