# PFIS Transaction Engine v1.0.0

## 1. Purpose

The Personal Finance Intelligence System (PFIS) Transaction Engine
ingests bank SMS and email alerts into a canonical transaction ledger in
Google Sheets. It validates incoming parser output, preserves source
evidence, resolves rules and account configuration, prevents replayed
source messages from creating repeated transactions, reconciles matching
SMS/email evidence, supports controlled transaction updates, and
maintains an audit history.

This README describes the project as its **first project version:
v1.0.0**. The schema version and project version are both treated as
`v1.0.0`. Keep this version label for incremental fixes; bump it only
when a major change is intentionally released.

## 2. Core design and required sheets

The engine requires these six sheets:

1.  `Transaction Log` --- canonical transaction ledger.
2.  `Source Log` --- retained SMS/email source evidence and processing
    outcomes.
3.  `Change Log` --- append-only audit history for system and user
    changes.
4.  `Rules` --- classification and enrichment rules.
5.  `Config` --- bank, account, card, instrument and
    internal-transaction configuration.
6.  `Categories` --- valid category list used for validation and
    enrichment.

The engine does not create or maintain the workbook's
analytics/dashboard sheets. Existing dashboards, formulas, reports, and
helper tabs remain separate and must be checked independently when
changing the workbook.

**Do not reorder the core columns or rename required headers without
updating and validating the engine.** The core Transaction Log schema
occupies columns A:AC. Legacy fields are optional and are updated only
when the expected headers are present in their documented positions.
`Flow Direction` and `Audit Trail` are optional legacy fields;
`Change Log` remains the authoritative detailed audit history.

## 3. Ingestion contract

Send write operations as HTTP POST requests with a JSON body. A typical
ingestion payload is:

``` json
{
  "action": "ingest",
  "sourceType": "SMS",
  "txnString": "datetime|signed_amount|bank|account_type|instrument|type|merchant_name|counterparty|ref_no|balance_after",
  "originalText": "complete raw SMS or email text"
}
```

For email, use `"sourceType": "EMAIL"` and pass `sender` and `subject`
when available. Do not URL-encode the raw body before sending JSON. Do
not omit `txnString`.

The `txnString` contains ten logical pipe-delimited fields. For backwards compatibility, the parser also accepts exactly one unambiguous formatting defect found in some Shortcuts output: an **extra leading empty field** (11 split parts where the first part is blank). It removes only that leading blank. It never guesses how to repair missing or shifted middle fields; those are rejected and logged as parse failures. Placeholder values such as `NA` / `N/A` in optional text/amount fields are normalized to blank.

The `txnString` contains exactly ten pipe-delimited fields:

1.  `datetime` --- transaction date/time. Date-only values may be
    accepted, but do not treat a date-only value as proof of a
    time-based match.
2.  `signed_amount` --- expenses/outflows are negative; income/inflows
    are positive.
3.  `bank`.
4.  `account_type` --- may be blank if unknown.
5.  `instrument` --- a source-provided instrument takes precedence over
    defaults.
6.  `type` --- semantic type such as `expense`, `income`,
    `card_payment`, `investment`, `transfer`, or `refund`.
    Invalid/unknown types should remain reviewable.
7.  `merchant_name`.
8.  `counterparty`.
9.  `ref_no` --- reference/UTR when available.
10. `balance_after` --- include only an actual post-transaction account
    balance. Never substitute available credit or wallet limit.

The engine should preserve the source message even when it cannot safely
create or reconcile a canonical transaction. Check the returned status
and identifiers rather than assuming every technically successful
request means a new transaction was inserted.

## 4. Duplicate, replay and reconciliation policy

The engine distinguishes exact source replay from a likely duplicate
transaction.

### Exact source replay

-   A repeated, already-processed source with the same channel and
    normalized source evidence is treated as an idempotent replay.
-   It must not create another canonical transaction.
-   Source evidence and processing status are retained for traceability
    according to the engine's replay path.

### Cross-channel reconciliation

SMS and email may describe the same underlying bank transaction.
Reconciliation uses transaction evidence rather than assuming that all
messages from the same bank are equivalent.

-   Matching evidence includes signed amount, normalized bank, merchant,
    date/time, and compatible account/card identity.
-   A strong reference/UTR match can support reconciliation beyond the
    normal five-minute timing window when the other transaction facts
    agree.
-   Contradictory meaningful account/card identifiers, conflicting
    amounts, or conflicting references must not be silently merged.
-   A date-only value cannot establish a precise time-window match.
-   When evidence is insufficient or multiple candidates are plausible,
    retain the case for review rather than guessing.

### Same-channel duplicate suppression

When a repeated SMS or email is received with a different source body,
the engine checks whether it is a high-confidence duplicate of an
existing canonical transaction. Automatic suppression requires a unique
match with compatible transaction facts, including exact transaction
timestamp, amount, bank, merchant and account identity, and no
conflicting reference evidence.

-   If the match is sufficiently strong, do not insert a second
    `Transaction Log` row. Retain/link the incoming source evidence and
    record the suppression in the audit trail.
-   If the match is not unique or transaction facts conflict, do not
    automatically suppress it. Keep the case reviewable.
-   Timestamp equality **alone** is not sufficient to prove a duplicate.
-   An already-existing duplicate row is not automatically deleted by
    this prevention logic; review and correct historical rows
    separately.

This policy favors avoiding silent financial-ledger corruption over
aggressively merging transactions based only on similarity.

## 5. Enrichment and response contract

The engine returns processing information intended to support iOS
Shortcuts and downstream enrichment. Depending on the operation, useful
response fields include:

-   `success` --- whether the request was processed technically.
-   `status` --- outcome such as accepted, reconciled, duplicate
    candidate, conflict, or idempotent replay.
-   `transactionId` --- stable transaction identity; use this for
    updates.
-   `sourceId` --- source evidence identity.
-   `requestId` --- correlation ID for logs and diagnostics.
-   `needsEnrichment` --- whether additional user/category enrichment is
    needed.
-   `requiresPurpose` --- whether purpose/user notes are missing.
-   `requiresCategoryClassification` --- whether category is missing or
    invalid.
-   `allowedCategories` --- active category choices when classification
    is required.
-   `purposeSuggestion` --- optional historical hint; it is not
    automatically saved.

Shortcuts should evaluate purpose and category requirements
independently. If purpose is missing, ask the user. If category is
missing, classify using the purpose, merchant, amount, type and allowed
category list, then validate the result against that list before
updating the transaction.

A transaction may still require review while enrichment is pending.
Adding a category or purpose must not clear duplicate, source-conflict,
invalid-type, missing-precision, or other integrity-review states.

## 6. Transaction update contract

Use HTTP POST with JSON, for example:

``` json
{
  "action": "update",
  "transactionId": "202610-001",
  "category": "Housing & utilities",
  "purpose": "The actual user-provided purpose",
  "actor": "user",
  "reason": "shortcut_enrichment"
}
```

Use the stable `transactionId`, not a sheet row number. Empty
category/purpose values and requests without supported update fields
should be rejected. An unchanged valid update should report no change
rather than claiming that a field was modified. Actual changes must be
represented in the audit history.

## 7. Rules behavior

The Rules sheet's core fields are A:M:

`Enabled`, `Match Type`, `Amount`, `Merchant Contains`, `Category`,
`Merchant Override`, `Notes Template`, `Month Offset`, `Is Recurring`,
`Type Override`, `Account Override`, `Card Name Override`, `Priority`.

Optional fields may exist after column M, but they are not part of the
minimum required schema unless explicitly supported by the deployed
engine.

Supported match types include:

-   `MERCHANT`
-   `AMOUNT`
-   `AMOUNT+MERCHANT`

Rules should be normalized for common sheet values such as `Y`/`TRUE`,
currency-formatted amounts, and match-type punctuation.
`AMOUNT+MERCHANT` requires both an amount and merchant pattern;
malformed rules must not silently become broader rules.

More-specific rules should win; lower numeric priority wins among
equally specific rules. Equally ranked rules that disagree should remain
ambiguous rather than being guessed. Amount-only rules are inherently
risky: amount equality alone does not prove merchant identity. Use
merchant evidence from the rule or incoming message and review broad
rules carefully.

Recurring status alone must not bypass missing purpose/category
enrichment. Rule behavior must not override source facts without an
explicit supported rule/config contract.

## 8. Config and account/card resolution

The required Config fields A:I are:

`Bank`, `Account Type`, `Account/Card Suffix`, `Merchant Contains`,
`Account`, `Card Name`, `Instrument`, `Is Internal`, `Priority`.

If the workbook includes a `Text Pattern` field, confirm that the
deployed engine supports and uses it before relying on it for account
resolution.

-   Higher specificity should win; lower numeric priority can break a
    tie only when the source evidence identifies a safe candidate.
-   A suffix-specific row must not match when the source provides only a
    masked or missing identifier.
-   Source instrument takes precedence over rule override, which takes
    precedence over Config default.
-   Do not use priority alone to guess between two different cards when
    the alert does not identify which card was used. Keep the result
    reviewable.
-   Internal-transfer/card-payment treatment must be explicitly
    configured and tested against downstream cash-flow reports. Do not
    mark an ordinary purchase as internal.

## 9. Dates, timezones and reporting

Transaction timestamps and reporting period boundaries must be
interpreted in `Asia/Kolkata` (India Standard Time), regardless of the
Apps Script runtime's default timezone.

Use the engine's custom date parser for date strings, including Indian
formats such as `DD/MM/YYYY` and `DD-MM-YYYY`; do not rely on JavaScript
`new Date(string)` for non-ISO dates. Date-only source values should
retain their lower precision and must not be treated as exact
timestamps.

The Google Sheet's display timezone and the Apps Script project timezone
should be checked during staging. Consistent timezone handling in the
engine does not automatically repair existing spreadsheet formulas or
dashboard logic.

## 10. Row allocation, concurrency and performance

-   Write destinations must be found using the logical key column and a
    full-row safety check, not merely `getLastRow() + 1`.
-   A row with a blank ID but other data or formulas is not a safe
    reusable row.
-   Rows containing only default unchecked checkbox values may be
    treated as logically blank only when the allocator's safety rules
    confirm there is no other transaction/audit data.
-   Use `LockService` to serialize conflicting ingestion/write
    operations and protect transaction IDs, duplicate checks and row
    allocation.
-   Cache Rules, Config and Categories during a request/batch rather
    than repeatedly reading the same tabs in loops.
-   Batch multi-entry audit writes and auxiliary-column writes where
    possible, while preserving existing formulas.
-   Do not run cleanup against production data without a backup and a
    reviewed dry run. Never clear `Source Log` or `Change Log` as
    routine cleanup.

## 11. Runtime configuration and deployment

Required Script Property:

-   `SPREADSHEET_ID` --- the Google Spreadsheet ID, taken from the URL
    between `/d/` and `/edit`.

Optional Script Property:

-   `WEB_APP_SECRET` --- if configured, requests must include the
    matching token as required by the deployed endpoint.

Use POST JSON consistently for write operations. Deploying updated code
to an existing Apps Script Web App requires deploying a new version when
applicable; saving the editor alone does not necessarily update the
deployed endpoint.

Keep production and staging spreadsheets separate. The test harness must
use a dedicated test spreadsheet and must not be pointed at the
production ledger for destructive tests.

## 12. Error logging and retry behavior

Unexpected runtime exceptions caught by the request router are logged on a best-effort basis:

- `Change Log` receives an idempotent `SERVER_ERROR` audit entry containing the request ID, action/table, error code, and diagnostic text.
- For an ingestion request with source type and raw evidence, `Source Log` receives a `SERVER_ERROR` diagnostic row if no source row has already been created. If processing was already underway, the existing `PROCESSING_*` source row keeps its recovery state and receives the error in `Processing Error`.
- Diagnostic logging checks the relevant sheet schema first and must not mask the original error. If the workbook is unavailable or the target log schema is unsafe, the API response reports that the error could not be sheet-logged and execution logs remain the fallback.
- `SERVER_ERROR` diagnostic source rows are excluded from source replay matching so they do not block a retry. Processing-state records are not changed to `SERVER_ERROR`, preserving interrupted-write recovery.

Expected validation outcomes such as `PARSE_FAILED`, duplicate suppression, reconciliation, or a source conflict are normal pipeline outcomes rather than unexpected exceptions. They use their own Source Log statuses.

## 13. Testing and release checklist

Before live ingestion:

1.  Run the engine's schema/config validation against the intended
    staging spreadsheet.
2.  Run the preflight/test harness from the Apps Script editor.
3.  Confirm the test harness reports each case and cleanup status.
4.  Test one representative SMS ingestion.
5.  Test the corresponding email, including a delayed email with a
    matching reference.
6.  Replay the same source and confirm no second canonical transaction
    is created.
7.  Test a same-channel duplicate with the same transaction timestamp
    and compatible transaction facts.
8.  Test a conflicting amount/reference and confirm the engine preserves
    a reviewable conflict instead of merging it.
9.  Test a missing or ambiguous card identifier and confirm it is not
    guessed.
10. Test category/purpose updates and verify Change Log entries.
11. Check the Transaction Log, Source Log and Change Log for correct
    IDs, links and row placement.
12. Check the live dashboard/monthly formulas independently; XLSX
    exports may not preserve all Google Sheets formulas.
13. Only after staging passes, deploy the Web App version and perform a
    controlled production smoke test.

Local mocked tests are useful for deterministic logic but are not
equivalent to executing against Google Sheets and Apps Script services.
Do not describe the system as production-certified until the actual
staging test has passed.

## 14. Data management and known boundaries

-   Preserve `Source Log` as evidence/provenance history.
-   Preserve `Change Log` as the detailed audit trail.
-   Sender and subject may be blank for SMS sources.
-   A successful HTTP response does not necessarily mean a new
    transaction was inserted; inspect `status`.
-   Historical duplicates are not automatically deleted by new
    duplicate-prevention logic.
-   Dashboard/report formulas and other workbook scripts are outside the
    engine's core responsibilities and require their own validation.
-   Never replace unknown merchant/account data with a confident guess
    merely to avoid a review state.

## 15. Project version

**Project:** PFIS Transaction Engine\
**Version:** v1.0.0\
**Purpose:** First documented project release\
**Core runtime:** Google Apps Script + Google Sheets, with iOS Shortcuts
as the source collection/enrichment client

Keep this README aligned with the exact engine and test harness deployed
in the project. Update it whenever the ingestion contract, schema,
duplicate policy, configuration requirements or deployment procedure
changes.
