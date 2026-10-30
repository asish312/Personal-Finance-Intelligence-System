# PFIS v1.0.0 — End-to-End Operating Guide

This guide explains the complete path from a bank alert to the workbook UI, daily enrichment and financial reporting. It is written for a first-time user and a future maintainer.

## 1. What PFIS is

PFIS is a personal-finance capture and analysis workflow built around a canonical Google Sheets ledger.

Its operating path is:

**Bank notification → iOS Shortcut → Apps Script Web App → Transaction Log + Source Log → Google Sheets UI and analytics**

Optional daily enrichment path:

**Gemini scheduled Task → Purpose Review Queue → human approval → Apps Script audited update → Change Log**

The transaction engine is deterministic Apps Script. Gemini is a separate connected-app workflow, not an API called by the engine.

## 2. The user interface: where to go and why

| Workbook sheet | User-facing purpose | Typical action |
|---|---|---|
| Dashboard | High-level financial picture | Review current position and trends |
| Recent Transactions | Latest canonical transactions | Quick daily verification; read-only view when configured as formula output |
| Transaction Log | Canonical financial ledger | Inspect a transaction; avoid manual edits to backend-owned fields |
| Monthly Summary | Actual cash flow and budget-period analysis | Compare earned month, budget month and monthly allocation |
| Insights & Data Quality | Exceptions and data completeness | Review genuine conflicts, missing classifications and data-quality signals |
| Reports | Detailed analysis and extracts | Explore supporting financial metrics |
| Purpose Review Queue | Daily Gemini Purpose suggestions | Inspect evidence and approve/reject proposals |
| Savings Sweep Log | Planned versus verified savings transfers | Reconcile source debit and savings credit |
| Categories | Approved category vocabulary | Maintain active classifications |
| Rules | Reusable classification and purpose logic | Maintain merchant/amount rules and budget offsets |
| Config | Bank/account/card resolution | Maintain account identity and internal-transfer mapping |
| Holiday Calendar | Working-day overrides | Maintain verified company-specific dates |
| Source Log | Original bank evidence | Trace a transaction to its SMS/email source |
| Change Log | Audit history | Review who changed what and why |
| Rejected & Archive Log | Explicitly archived items | Inspect human-confirmed duplicate archive history |
| Dashboard_Calc | Calculation helper ranges | Normally not a user editing surface |
| Data Dictionary | Field definitions | Understand each column and metric |
| PFIS System Guide | Workbook operating instructions | Learn business definitions and usage |

The repository does not currently contain a custom HTML dashboard frontend. The principal financial UI is Google Sheets. The iOS Shortcut is the mobile capture/receipt UI. Apps Script is the backend JSON Web App.

## 3. The system in one transaction

A notification arrives from a bank by SMS or email.

1. The iOS Shortcut captures the full notification, not just a short summary.
2. The Shortcut's extraction action returns a structured ten-field transaction string.
3. The Shortcut sends a JSON POST request to the deployed Apps Script Web App.
4. Apps Script validates the fields and preserves the notification in Source Log.
5. It checks exact source replay, cross-channel matches, card-payment event links and same-channel duplicate candidates.
6. Rules and Config determine the semantic type, category, merchant label and account/card identity.
7. If the event is new, it is inserted in Transaction Log. If it is a strong match, source evidence is linked to the existing transaction. If uncertain, the transaction remains reviewable.
8. Change Log records supported transaction creation and updates.
9. The Shortcut displays the response as a receipt, review warning, category-classification action or error.
10. The workbook's formulas and charts present the financial view.

The engine does not independently log into the bank, download statements or move money.

## 4. Configuration layers

### Categories
The Categories sheet defines the allowed classification vocabulary. Category updates sent to Apps Script must exactly match an active category. Keep Miscellaneous active if blank/unmapped categories should safely fall back to it.

### Config
The core fields are Bank, Account Type, Account/Card Suffix, Merchant Contains, Account, Card Name, Instrument, Is Internal and Priority. Text Pattern is an optional J-column extension.

Use friendly labels, not full account or card numbers. Only mark Is Internal when both accounts are owned by the same user and the transaction is truly an internal transfer.

### Rules
Rules can match MERCHANT, AMOUNT or AMOUNT+MERCHANT. More-specific evidence wins. Equally ranked conflicting rules should remain unresolved rather than guessed.

Important fields:
- Month Offset (H): month label for a configured notes template.
- Auto Purpose (T): explicit permission to write a meaningful configured purpose.
- Purpose Trigger (U): supported trigger such as LAST_WORKING_DAY_OF_MONTH.
- Calendar Scope (V): holiday calendar to use for the trigger.
- Budget Month Offset (W): budget month assigned to the transaction.

Purpose is optional. Recurrence alone does not authorise a Purpose.

### Holiday Calendar
Exact headers:
Date | Calendar Scope | Is Working Day | Description

Weekdays are working by default and weekends are non-working by default. Verified overrides can change this for a named employer alias or ALL. Do not invent holidays.

### Salary period example
A neutral Example Employer rule may use:
- Month Offset = 0
- Auto Purpose = FALSE
- Purpose Trigger = LAST_WORKING_DAY_OF_MONTH
- Calendar Scope = EMPLOYER_DEMO
- Budget Month Offset = 1

For an eligible month-end salary received on 30 October:
- transaction date: 30-Oct
- Purpose: Salary from Example Employer for Oct-26
- Income Month: Oct-26
- Budget Month: Nov-26

The transaction date controls purpose/Income Month. Budget Month Offset controls the following month's allocation.

## 5. Purpose: instant rules plus daily Gemini enrichment

Purpose is optional. A blank value must never block ingestion, approval or a receipt.

### Instant rule purpose
Apps Script can write a configured Purpose when Auto Purpose is TRUE or a supported Purpose Trigger is satisfied. The last-working-day trigger uses the transaction date and configured calendar. This is the fast and deterministic path.

### Daily Gemini suggestion
Gemini Tasks can be scheduled once daily and connected to Google Sheets. The daily task reads recent blank-Purpose transactions and their linked Source Log evidence. It proposes a short factual Purpose only when the message supports it. It writes suggestions to Purpose Review Queue, not Transaction Log.

The queue has these fields:
Suggestion ID | Transaction ID | Transaction Date | Merchant | Amount | Category | Type | Suggested Purpose | Evidence Summary | Evidence Source IDs | Confidence | Status | Gemini Run At | Reviewed By | Reviewed At | Applied At | Apply Result

Gemini uses Status=SUGGESTED. It must never mark suggestions APPROVED. The reviewer checks Source Log and then fills Status=APPROVED, Reviewed By and Reviewed At.

### Audited application
The engine provides:

PFIS_APPLY_APPROVED_PURPOSE_SUGGESTIONS()

This function only applies approved rows whose Source IDs link to the same transaction, whose Purpose is still blank, and whose row is not a duplicate/source conflict. It calls the normal update pipeline and records Change Log. It never overwrites an existing Purpose.

The function can be run manually or attached to an Apps Script time-driven trigger. The trigger applies only manually approved rows; it does not approve Gemini suggestions.

See PFIS_Gemini_Purpose_Enrichment_v1.0.0.md for the daily schedule prompt and account prerequisites.

## 6. Gemini's role — connected, but not embedded

Gemini is not an Apps Script runtime dependency. There is no Gemini API key or model call in the production engine.

Gemini is used in two separate ways:
1. **Workbook authoring:** the owner asks Gemini to inspect/edit formulas, dashboard layouts, chart sources, labels and documentation in the Google Sheets UI.
2. **Daily Purpose Task:** an owner-created Gemini Task reads the connected workbook and writes evidence-backed suggestions into Purpose Review Queue.

Gemini must not alter Transaction Log financial facts, Source Log evidence, Rules, Config or audit history. Shared spreadsheet edits may require the user to review and confirm Gemini's planned changes. If a scheduled run asks for confirmation, it is not fully unattended.

Eligibility and available connected apps depend on the Google account, plan, region, settings and permissions. The current setup instructions and official links are in the Gemini Purpose guide.

## 7. Zero-based budgeting and savings sweep

A budget month starts with an opening budget allocation of zero. This does not reset actual bank balances.

Keep two separate date concepts:
- Income Month: when income actually arrived.
- Budget Month: the budget period to which a transaction is assigned.

Budget view:
- Income Allocated
- Essential Commitments
- Actual Operating Spend
- Debt and EMI Settlements
- Investment Allocation
- Pre-Sweep Surplus
- Planned Savings Sweep
- Actual Verified Savings Sweep
- Remaining Unallocated
- Sweep Variance
- Sweep Status

Pre-Sweep Surplus = Income Allocated − Essential Commitments − Actual Operating Spend − Debt/EMI Settlements − Investment Contributions.

### Savings Sweep Log
A sweep is not actual savings merely because it is planned or the source account is debited. Completed requires:
- source debit transaction ID,
- destination savings credit transaction ID,
- both IDs exist in Transaction Log,
- both accounts are owned by the user,
- the amounts agree,
- the evidence supports one internal transfer.

The Apps Script engine does not initiate bank transfers and does not currently create the Savings Sweep Log. This is a workbook planning/reconciliation feature.

### Accounting separation
- Card purchase is consumption at purchase time.
- Card bill settlement is a liability/cash-flow event, not a second consumption expense.
- Investment contributions are wealth allocation, not ordinary consumption.
- Internal transfers are not income or expenses.
- Planned sweep is not verified savings.

## 8. Apps Script deployment

The production source is PFIS_TransactionEngine_v1.0.0.gs. The preflight file is installed in the same Apps Script project when validation is needed.

Required Script Property:
- SPREADSHEET_ID

Optional Script Property:
- WEB_APP_SECRET

Never commit either value.

Setup:
1. Open the Apps Script project connected to or authorised for the intended workbook.
2. Add the production engine file.
3. Add the preflight suite for staging validation.
4. Set SPREADSHEET_ID and optional WEB_APP_SECRET in Project Settings > Script Properties.
5. Confirm the six core tabs and positional headers: Transaction Log, Source Log, Change Log, Rules, Config and Categories.
6. Run PFIS_VALIDATE() or POST action=validate.
7. Run PFIS_RUN_ALL_PREFLIGHT_TESTS() in a safe project. It checks the configured workbook schema read-only and writes integration tests to a disposable synthetic spreadsheet.
8. Confirm the JSON report shows zero failed tests, syntheticIntegration=COMPLETED and cleanup.success=true.
9. Deploy as a Web App and place its /exec URL in the iOS Shortcut.
10. After source changes, deploy a new Web App version; saving script source does not update an existing versioned deployment.

## 9. API overview

The Shortcut sends POST JSON. Ingestion requires sourceType (SMS or EMAIL), txnString and originalText. The ten txnString fields are:
datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after

Read actions:
health, validate, gettransaction, getpendingreview, getneedsenrichment, searchtransactions, getfinancialoverview, getcategorybreakdown, getmerchantanalysis, getrecurringcommitments, getcashflow, getspendingbehavior, getanomalies, getdataquality.

Write/control actions:
ingest, update, reprocesssource, resolveexception.

The API does not expose a custom dashboard page in this repository. The workbook is the analytics UI.

## 10. File map

| File | Why it exists |
|---|---|
| PFIS_TransactionEngine_v1.0.0.gs | Production transaction engine |
| PFIS_Preflight_Tests_v1.0.0.gs | Synthetic tests; same Apps Script project |
| PFIS_Prompts_Final_v1.0.0_Prompts.txt | Shortcut prompt definitions |
| PFIS_Shortcut_Implementation_v1.0.0.txt | Mobile integration guide |
| PFIS_Operating_Guide_v1.0.0.md | This end-to-end guide |
| PFIS_Gemini_Purpose_Enrichment_v1.0.0.md | Daily Gemini Task and approval workflow |
| PFIS_Gemini_Spreadsheet_Implementation_v1.0.0.md | Workbook modification instructions for Gemini |
| REVIEW_NOTES.md | Current maintainer status and boundaries |
| README.md | Public story, capabilities and synthetic analytics |

## 11. Troubleshooting

| Symptom | Inspect first |
|---|---|
| Empty or malformed request | Shortcut JSON body and exact ten-field txnString |
| Unauthorized | WEB_APP_SECRET in Script Properties and Shortcut token |
| Category unresolved | Active Categories and matched Rules |
| Purpose blank | Normal and valid; inspect Rules trigger or optional Gemini queue |
| Gemini made no suggestion | Source evidence, date scope, status flags, connected Sheets permission |
| Suggestion not applied | Status=APPROVED, reviewer/date fields, Evidence Source IDs, Apply Result |
| Duplicate candidate | Transaction Log validation flag and linked Source Log evidence |
| Dashboard stale | Workbook formulas and chart source ranges |
| Data quality mismatch | API response.data, period bounds and workbook formula range |

PFIS is a notification-driven personal finance system, not a bank API or accounting certification system. Its coverage depends on the bank alerts received and the quality of their content.
