# PFIS v1.0.0 — Getting Started

This guide is the entry point for someone new to the Personal Finance Intelligence System (PFIS). Read it before copying code or connecting a personal workbook.

## What PFIS does

PFIS captures bank SMS/email alerts, converts them into structured transaction candidates, reconciles repeated notifications, stores one canonical transaction, preserves original evidence, and provides financial reporting through Google Sheets.

## Architecture

| Component | Responsibility |
|---|---|
| iOS Shortcut | Capture the original SMS/email, run extraction, submit the request and show the result |
| Shortcut prompt library | Defines the exact extraction and category-classification prompts |
| Google Apps Script | Validates, normalises, reconciles and writes transaction/evidence/audit records |
| Google Sheets workbook | Canonical ledger, configuration, source evidence, audit history and financial views |
| Gemini | Optional assistant for workbook authoring or a separate Purpose suggestion workflow |

Gemini is not called by the transaction engine or iOS Shortcut.

## Read and install in this order

1. **Understand the project:** read the repository root README.
2. **Understand the full setup:** follow this guide.
3. **Build the mobile capture:** read [iOS Shortcut Implementation](IOS_SHORTCUT_IMPLEMENTATION_v1.0.0.md).
4. **Configure the AI actions:** copy only the required prompts from [iOS Shortcut Prompt Library](../prompts/IOS_SHORTCUT_PROMPTS_v1.0.0.md).
5. **Prepare or repair the workbook:** read [Gemini Workbook Guide](GEMINI_WORKBOOK_GUIDE_v1.0.0.md) and use the [Gemini Spreadsheet Repair Prompt](../prompts/GEMINI_SPREADSHEET_REPAIR_v1.0.0.md).
6. **Install the backend:** deploy the engine and run the preflight suite as described below.
7. **Optional:** configure [Gemini Purpose Enrichment](GEMINI_PURPOSE_ENRICHMENT_v1.0.0.md) only when you want a separate, human-approved Purpose suggestion process.

## Repository file map

Before modifying an existing ledger, read [Ledger Cleanup Operations](LEDGER_CLEANUP_OPERATIONS_v1.0.0.md) and use the dedicated [Gemini Legacy Duplicate Mapping Prompt](../prompts/GEMINI_LEGACY_DUPLICATE_MAPPING_v1.0.0.md) only for the documented evidence-backed pairs. It documents the preview-first duplicate archive migration and evidence-based reclassification API.


| Path | What it contains |
|---|---|
| <code>README.md</code> | Project overview, architecture, workbook concepts, API, deployment and design boundaries |
| <code>PFIS_TransactionEngine_v1.0.0.gs</code> | Production Apps Script engine |
| <code>PFIS_Preflight_Tests_v1.0.0.gs</code> | Synthetic regression/preflight harness |
| <code>docs/GETTING_STARTED_v1.0.0.md</code> | This newcomer and setup guide |
| <code>docs/IOS_SHORTCUT_IMPLEMENTATION_v1.0.0.md</code> | Shortcut actions, request fields, response routing and retry behaviour |
| <code>docs/GEMINI_WORKBOOK_GUIDE_v1.0.0.md</code> | Safe workbook authoring and validation workflow |
| <code>docs/GEMINI_PURPOSE_ENRICHMENT_v1.0.0.md</code> | Optional daily Gemini suggestion workflow |
| <code>docs/LEDGER_CLEANUP_OPERATIONS_v1.0.0.md</code> | Legacy duplicate archive migration and evidence-based reclassification runbook |
| <code>prompts/IOS_SHORTCUT_PROMPTS_v1.0.0.md</code> | Copy/paste extraction and category prompts |
| <code>prompts/GEMINI_SPREADSHEET_REPAIR_v1.0.0.md</code> | Copy/paste workbook repair prompt |
| <code>prompts/GEMINI_CARD_PAYMENT_RULES_v1.0.0.md</code> | Copy/paste Rules/Config prompt for credit-card settlements |
| <code>prompts/README.md</code> | Prompt catalogue and usage notes |
| <code>docs/images/</code> | SVG architecture/configuration and illustrative diagrams |

## Google Sheets workbook requirements

The engine expects these six core tabs with their established schemas:

1. Transaction Log
2. Source Log
3. Change Log
4. Rules
5. Config
6. Categories

Other workbook tabs are presentation, reporting or optional workflow sheets. Keep the canonical Transaction Log A:AC columns in their existing physical order. Do not add an isReviewNeeded column: it is an API request Boolean mapped to existing review fields.

The workbook is intentionally **not committed to this public repository**. It contains private financial history and must remain in the owner's Google Drive. Use your own protected workbook. Never test against real financial rows when a synthetic preflight can be used.

## Install the Apps Script backend

1. Open the Google Apps Script project connected to the intended Google Sheet.
2. Replace the contents of the existing engine file with the current repository file <code>PFIS_TransactionEngine_v1.0.0.gs</code>.
3. Add or replace <code>PFIS_Preflight_Tests_v1.0.0.gs</code> in the same Apps Script project.
4. In Apps Script Project Settings, configure Script Properties:
   - <code>SPREADSHEET_ID</code>: the target Google Spreadsheet ID.
   - <code>WEB_APP_SECRET</code>: optional shared secret, only if the API is configured to require it.
5. Run <code>PFIS_VALIDATE()</code>. Resolve every schema error before proceeding.
6. Run <code>PFIS_RUN_ALL_PREFLIGHT_TESTS()</code>. The suite checks the configured workbook schema read-only and runs write tests against a disposable synthetic spreadsheet.
7. Confirm the report is successful and that temporary test cleanup completed.
8. Deploy the Apps Script project as a Web App and copy the deployed URL ending in <code>/exec</code>.
9. Use that URL in the iOS Shortcut's Get Contents of URL action.

Saving Apps Script source does not update an already-versioned Web App deployment. Deploy a new Web App version after code changes.

## Test the end-to-end flow

Use fictional test data first. Verify:

- A valid ten-field transaction creates one Transaction Log row and one Source Log row.
- The original source text remains intact in Source Log.
- An exact replay does not create a second transaction.
- A malformed financial notification remains a source-only PARSE_FAILED case.
- A missing/ambiguous category is visible for classification; automatic Miscellaneous fallback is distinguishable from a human-confirmed category.
- <code>isReviewNeeded</code> is a JSON Boolean, not the text <code>"true"</code>.
- Review, duplicate confirmation and rejection remain deliberate human actions.
- Change Log records supported changes.

## Privacy and files deliberately not included

This repository contains code, documentation, prompt text and fictional illustrations. It does not contain:

- the owner's live Google Sheets workbook or exported transaction history;
- bank SMS/email messages or account identifiers;
- Script Properties, deployment secrets or Web App secret values;
- an importable iCloud Shortcut export file.

The Shortcut is documented as an implementation guide and prompt library. The actual Shortcut must be built or maintained in Apple's Shortcuts app. Do not claim an importable .shortcut file is included.

## Version policy

The project owner requires all release identifiers and documentation filenames to remain at **v1.0.0**. Do not bump the displayed engine, schema, parser or documentation version without an explicit project decision. Google Apps Script Web App deployment revisions are separate from the PFIS release label.
