# Personal Finance Intelligence System (PFIS)

**Canonical project document and runbook — v1.0.0**  
**Repository:** https://github.com/asish312/Personal-Finance-Intelligence-System  
**Backend:** `PFIS_TransactionEngine_v1.0.0.gs`  
**Integration tests:** `PFIS_TransactionEngine_v1.0.0_Tests.gs`  
**Scheduled analytics prompts:** `PFIS_GEMINI_ANALYTICS_PROMPTS_v1.0.0.md`

This README is intended to be the **single source of truth** for the PFIS v1.0.0 implementation, architecture, data contract, and runbook. Do not maintain a second competing architecture document. The analytics prompt file is intentionally separate because it contains operational prompts, not system architecture or backend code.

> **Release state:** code and test files pass static JavaScript syntax checks in the development environment. The integration suite must still be run from Google Apps Script against its dedicated test workbook. No live production spreadsheet write or deployment has been performed by this release package.

---

## 1. Purpose and operating principles

PFIS captures financial alerts from SMS and email, preserves their evidence, produces one canonical transaction when alerts describe the same event, flags possible duplicates/conflicts for human review, and exposes clean data for personal-finance analytics.

Core principles:

1. **Record first, enrich second.** A valid financial transaction should be recorded even when the category or purpose is unknown. Missing information creates an enrichment task; it must not block the ledger insert.
2. **Evidence is not the event.** An SMS and an email can describe the same payment. The first valid source creates the canonical transaction; a matching opposite-channel source adds evidence to that same transaction.
3. **Do not silently lose distinct events.** An exact same-channel replay is idempotent. A different alert that merely resembles a previous payment gets its own transaction row and may be marked `DUPLICATE_CANDIDATE`.
4. **Do not guess transaction identity.** Reconciliation is deterministic. Conflicting or ambiguous evidence is retained and flagged rather than auto-merged.
5. **Keep enrichment separate from review and verification.** They answer different questions and are returned independently.
6. **AI suggests; the user confirms; the backend validates.** Apple Intelligence may suggest a purpose/category. Apps Script validates the category and applies permitted updates to the existing `transactionId`.
7. **Analytics are derived from the ledger.** Gemini reports patterns and creates charts, but does not silently change ledger values, audit logs, categories, rules, or configuration.
8. **Keep v1 small.** Do not add schema fields, helper tabs, redundant rule registries, or extra backend services without a demonstrated need.

## 2. Architecture and responsibility boundaries

```text
Incoming SMS ─┐
              ├─> Process SMS / Process Email Shortcut
Incoming Email┘              │
                             v
                   Sanitize sensitive text
                             │
                             v
             Apple Intelligence parses once
             into the strict 10-field pipe contract
                             │
                             v
              Apps Script POST JSON endpoint
               ├─ validates request/schema
               ├─ hashes source for same-channel replay protection
               ├─ matches opposite-channel evidence
               ├─ detects same-channel duplicate candidates
               ├─ evaluates Rules and Config safely
               ├─ appends/updates Transaction Log
               ├─ appends Source Log and Change Log
               └─ returns enrichment flags + nextAction + displayText
                             │
                ┌────────────┴────────────┐
                v                         v
        Receipt/review              Enrichment required
                                          │
                                  Purpose suggestion/model
                                          │
                                  User confirms/edits purpose
                                          │
                                  Apple Intelligence category
                                  using allowedCategories
                                          │
                                  POST update by transactionId
                                          │
                                  Check update success/state
                                          │
                                  Show final receipt

Existing Dashboard / Monthly Summary / Reports / Insights & Data Quality
  └─> formulas/charts read the canonical ledger; Gemini uses read-only analysis
      prompts in PFIS_GEMINI_ANALYTICS_PROMPTS_v1.0.0.md
```

### Layer responsibilities

- **`Process my SMS` / `Process my email`:** capture the incoming body and source metadata and pass a consistently named dictionary to the sanitizer/processor.
- **Sanitize Message:** mask sensitive text only. Preserve amount, signed transaction meaning, date/time, merchant/counterparty, reference, bank, instrument, and useful account suffix evidence. Sanitizing is not categorization or transaction parsing.
- **`Process transactions`:** parse once, call the backend with POST JSON, store the returned dictionary, follow `nextAction`, and keep the original `transactionId` for updates.
- **Apple Intelligence:** extracts transaction facts, suggests a purpose from the current alert plus bounded prior examples, and classifies a category only when requested. It must return a category exactly from `allowedCategories`.
- **Apps Script:** owns transaction/source identity, replay protection, matching, Rules/Config resolution, category validation, review states, Change Log, and response flags. It does not call Gemini or Apple Intelligence.
- **Google Sheets:** stores canonical financial facts, evidence, rules/configuration, categories, and audit history. Existing analytics tabs/formulas remain in place and should update dynamically.
- **Gemini scheduled analytics:** reads current data and produces periodic narrative and charts using the separate analytics prompts. It must not change transaction/system data without a separate explicit human-approved workflow.

## 3. Files in the initial check-in

| File | Responsibility |
|---|---|
| `PFIS_TransactionEngine_v1.0.0.gs` | Backend only: routes, ingestion, matching, rules/config, updates, read APIs, audit and display response. No Gemini analytics prompts and no test runner. |
| `PFIS_TransactionEngine_v1.0.0_Tests.gs` | Full Apps Script integration harness. Runs 46 scenarios in one invocation and inserts real rows into a dedicated test Google Sheet. |
| `PFIS_GEMINI_ANALYTICS_PROMPTS_v1.0.0.md` | Separate weekly and monthly Gemini report prompts, including chart requirements and data-safety rules. |
| `README.md` | This canonical architecture, contract and runbook. |

Do not keep the old `PFIS_TransactionEngine_v1.0.2.gs`, duplicate v3.5.1 parser, or old architecture notes as a second active implementation in the same Apps Script project. Duplicate global functions/constants in Apps Script can prevent compilation or make it unclear which code is active. Historical documents can be retained in Git history, but this README should be the current source of truth.

## 4. Core spreadsheet model

The engine uses these six required core tabs, with a fixed physical column order. Runtime sheet mapping is positional; do not reorder/insert columns inside these schemas without a planned migration and a changed script.

### 4.1 Transaction Log — canonical ledger

Core schema A:AC (29 columns), in this exact order:

1. Transaction ID
2. DateTime
3. Amount
4. Bank
5. Account Type
6. Merchant
7. Category
8. User Notes
9. Type
10. Instrument
11. Account
12. Card Name
13. Is Recurring
14. Is Internal Transfer
15. Needs Review
16. Counterparty
17. Ref No
18. Balance After
19. Schema Version
20. Review Status
21. Review Reason
22. Reviewed By
23. Reviewed At
24. Rule Applied
25. Rule Type
26. Category Confidence
27. Validation Flag
28. Created At
29. Last Updated At

Optional legacy columns in the current workbook:

- `AL` — `Flow Direction`: `INFLOW` for positive amount, `OUTFLOW` for negative amount, `NEUTRAL` for zero. This is a reporting convenience, not a matching field.
- `AM` — `Audit Trail`: concise row-level event summaries. The detailed append-only history is in Change Log. The script writes AL/AM only when expected headers match; a mismatch must not block the core ledger write.

`Amount` remains numeric and signed: outflow/debit is negative; inflow/credit is positive. `Balance After` is populated only from a true after-transaction balance, not from an available credit limit.

### 4.2 Source Log — evidence and idempotency

Expected columns A:V:

`Source ID`, `Received At`, `Source Type`, `Sender`, `Subject`, `Raw Body`, `Source Hash`, `Parser Version`, `Parse Status`, `Extracted Amount`, `Extracted Date`, `Extracted Date Precision`, `Extracted Account/Card Identifier`, `Extracted Merchant`, `Extracted Reference No`, `Linked Txn ID`, `Ingested At`, `Processing Error`, `Archived Flag`, `Notes`, `Request ID`, `Batch ID`.

This is the provenance/evidence log used for replay detection and source reconciliation. SMS Sender/Subject may be blank. `Archived Flag` is informational in v1.0.0; it does not by itself exclude a source from matching. `Ingested At` records original insertion time and must not be overwritten during finalization/recovery.

### 4.3 Change Log — audit history

Expected columns A:J:

`Change ID`, `Transaction ID`, `Changed At`, `Target Table`, `Actor`, `Field`, `Old Value`, `New Value`, `Reason`, `Request ID`.

Change Log is append-only operational history. Do not routinely clear it to make the workbook appear clean. If the owner deliberately resets it at the initial rollout, the historic audit trail is permanently lost and should not be described as retained.

### 4.4 Rules — deterministic suggestions

Required columns A:M:

`Enabled`, `Match Type`, `Amount`, `Merchant Contains`, `Category`, `Merchant Override`, `Notes Template`, `Month Offset`, `Is Recurring`, `Type Override`, `Account Override`, `Card Name Override`, `Priority`.

Optional existing N:S extension, used only if all headers match the expected layout:

`Rule ID`, `Rule Engine`, `Instrument Override`, `Auto Review`, `Confidence`, `Notes`.

- `MERCHANT`: requires a merchant keyword/pattern.
- `AMOUNT+MERCHANT`: requires both a numeric amount and a real merchant keyword/pattern.
- `AMOUNT`: deliberately does **not** auto-apply in v1.0.0 because unrelated events often share an amount. The transaction is still inserted and flows to enrichment.
- More specific merchant-grounded matches win over less specific matches; priority breaks ties. Conflicting equally ranked rules must not be guessed.
- The Category must exactly match an active Categories entry.
- Is Recurring alone does not suppress purpose/category prompts.
- `Auto Review`, `Rule Engine` and free-form rule Notes are informational unless implemented with an explicit, tested business rule. They must not bypass missing enrichment or a data-integrity review.
- A rule can complete enrichment only if the category is active and the Notes Template/Notes value yields a meaningful purpose. A purpose equal to the merchant is considered missing.

### 4.5 Config — account/instrument resolution

Expected columns A:I:

`Bank`, `Account Type`, `Account/Card Suffix`, `Merchant Contains`, `Account`, `Card Name`, `Instrument`, `Is Internal`, `Priority`.

`Text Pattern` at column J is not consumed by this version. A suffix-specific mapping is used only when the source contains a meaningful matching suffix. A masked value such as only `XX` must not select a specific suffix row. Instrument precedence is source-provided value, then Rule override, then Config default. Internal transfer classification requires a clear configured merchant/counterparty pattern, `Is Internal` enabled, and semantic transaction type `transfer`; do not set every bank/config row to internal.

### 4.6 Categories — canonical taxonomy

Expected columns A:B:

`Category`, `Active`.

The active category list is read from this tab. Explicit inactive values are excluded; blank Active values are treated as active for backwards compatibility. Every backend category update must exactly match an active value. The Shortcut/model must use `allowedCategories` from the response rather than a separate hardcoded list.

### 4.7 Analytics and documentation tabs

Keep existing `Dashboard`, `Monthly Summary`, `Reports`, `Insights & Data Quality`, and any other useful existing analytics tabs. The backend does not call Gemini to populate them. Preserve existing formulas and data validations; make sure their ranges include appended transactions. `PFIS Optimization Plan` can remain as a workbook-facing architecture reference if you find it useful, but this README is the canonical Git documentation.

## 5. Input contract — 10 pipe-delimited fields

Apps Script receives `txnString` plus `originalText` separately. The parser must emit exactly one transaction per line with exactly ten pipe-delimited fields:

```text
datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after
```

| # | Field | Rule |
|---:|---|---|
| 1 | `datetime` | Reliable date/time. Prefer ISO 8601 with offset. Date-only is supported but cannot prove a five-minute reconciliation. |
| 2 | `signed_amount` | Required, numeric, non-zero. Debit/outflow negative; credit/inflow positive. |
| 3 | `bank` | Required. |
| 4 | `account_type` | Optional. If both sources supply it, values must agree after normalization; a missing value does not block matching. |
| 5 | `instrument` | Optional, e.g. UPI, NEFT, credit card. |
| 6 | `type` | Semantic type: `expense`, `income`, `card_payment`, `investment`, `transfer`, or `refund`. Unknown remains reviewable; never infer type from amount sign alone. |
| 7 | `merchant_name` | Merchant/payee evidence; generic or unusable values cannot be used for automatic matching. |
| 8 | `counterparty` | Optional recipient/payee when distinguishable from merchant. |
| 9 | `ref_no` | Optional real reference, such as UTR/RRN. Never invent one. |
| 10 | `balance_after` | Optional true after-transaction balance, not an available credit limit. |

Use blank or `NA` for unknown optional fields. Do not add device location to this positional contract in v1.0.0; it adds ambiguity and does not improve event identity. The original sanitized message body is sent through `originalText`. Keep the original as evidence after the privacy sanitization step; the backend does not parse transaction facts out of that raw body itself.

## 6. API contract

### 6.1 Transport rules

- **POST with JSON body for all writes:** insertion, update and source reprocessing.
- Read-only GET calls may use query parameters for diagnostics/read actions.
- Include `action` in the JSON body. Do not put `action` only in the URL.
- Do not URL-encode values inside a JSON body. URL encoding is relevant only when putting data in URL query parameters.
- `doPost()` expects a valid JSON body. It does not promise to merge query-string parameters into the JSON body.
- If `WEB_APP_SECRET` is configured, supply `token` in the request body. Do not store the secret in source code or a public URL.
- The Script Property `SPREADSHEET_ID` must contain the target spreadsheet ID (the section between `/d/` and `/edit` in the Sheets URL).

### 6.2 Insertion request

```json
{
  "action": "ingest",
  "sourceType": "SMS",
  "txnString": "2026-10-10T16:14:08+05:30|-100.00|Axis Bank|NA|UPI|expense|GUDIVENUKALA VIJAYA|GUDIVENUKALA VIJAYA|435513308371|NA",
  "originalText": "INR 100.00 debited; A/c no. XXXXXX; 10-10-26, 16:14:08; UPI/P2A/435513308371/GUDIVENUKALA VIJAYA; Axis Bank",
  "sender": "optional source sender",
  "subject": "optional email subject"
}
```

`sourceType` is normalized to `SMS` or `EMAIL`. Sender/Subject can be blank for SMS. The example body is illustrative; in real use pass the complete sanitized source content and never construct unsupported financial facts.

### 6.3 Update request

```json
{
  "action": "update",
  "transactionId": "202610-001",
  "purpose": "Confirmed purpose provided or accepted by the user",
  "category": "Housing & utilities",
  "actor": "user",
  "reason": "shortcut_enrichment"
}
```

- Use `transactionId`, never `sheetRow`, as the stable update identity.
- Send non-empty supported fields only. An explicitly empty/invalid category or purpose is rejected before any patch writes.
- `purpose` and `userNotes` map to Transaction Log `User Notes`; `userNotes` is supported for compatibility.
- Backend-controlled fields—`Needs Review`, `Review Status`, `Validation Flag`, `Reviewed At`, `Is Recurring`, `Is Internal Transfer`, `verificationStatus`, and source counts—must not be edited by the Shortcut. The backend recomputes the review/enrichment state.
- `NO_CHANGE` means submitted values already match; it is not a claim that new fields changed.

### 6.4 Supported read actions

The backend routes include `health`/`ping`, `validate`, `gettransaction`, `gettransactiondetail`, `getpendingreview`, `getneedsenrichment`, `searchtransactions`, `getfinancialoverview`, `getcategorybreakdown`, `getmerchantanalysis`, `getrecurringcommitments`, `getcashflow`, `getspendingbehavior`, `getanomalies`, and `getdataquality`. Respect the returned bounded result limits. Do not request raw evidence for general analytics.

### 6.5 Important response fields

| Field | Exact meaning | Shortcut behaviour |
|---|---|---|
| `success` | Whether the request was handled successfully. It does not mean the row is fully enriched/approved. | Check before treating the action as successful. |
| `status` | Result of this request, such as `ACCEPTED`, `RECONCILED`, `UPDATED`, `NO_CHANGE`, `IDEMPOTENT_REPLAY`, `DUPLICATE_CANDIDATE`, `CONFLICT`, or an error status. | Handle the event outcome before asking any questions. |
| `transactionId` | Stable canonical ledger ID. | Use for all updates. |
| `transaction` | Useful transaction fields. | Keep the response dictionary for all subsequent field reads. |
| `verificationStatus` | Evidence state: `SMS_ONLY`, `EMAIL_ONLY`, `VERIFIED`, `CONFLICT`, or `UNKNOWN`. | Show as information; do not equate with approval. |
| `sourceTypes` / `sourceCount` | Linked non-superseded evidence channels/count. | Receipt/debug info. |
| `needsEnrichment` | Boolean equivalent of `requiresPurpose OR requiresCategoryClassification`. | Convenience summary only; it does not tell which prompt to show. |
| `requiresPurpose` | Purpose/User Notes is blank, generic, or merely repeats the merchant. | Ask for purpose only when `nextAction` calls for enrichment. Use history suggestions as editable defaults. |
| `requiresCategoryClassification` | Category is blank or not in active Categories. | Ask the chosen model to classify only from `allowedCategories`. |
| `allowedCategories` | Active category names from Categories sheet; included when category classification is required. | Pass to classifier and validate the result against it. |
| `purposeSuggestion` | The best prior meaningful purpose from a small exact-merchant/type history. | Hint only; user/model must confirm it. Never auto-save it. |
| `purposeExamples` | Up to three distinct, approved prior `purpose/category/type` examples for exact normalized merchant and transaction type. | Provide as bounded context to the purpose model. No raw source messages are included. |
| `needsReview` | Whether a transaction has an unresolved problem requiring attention. | Preserve review flags; do not clear merely because enrichment completes. |
| `reviewStatus` / `reviewReason` | Workflow state/reason stored in Transaction Log. | Route unresolved cases to manual review. |
| `nextAction` | Backend routing recommendation: `ASK_PURPOSE`, `CLASSIFY_CATEGORY`, `SHOW_RECEIPT`, `REVIEW`, or `SHOW_ERROR`. | Use this before `needsEnrichment`; particularly important on replay/reconciliation. |
| `changedFields` | Present only when a valid update actually changed fields. | Show update details only if non-empty. |
| `displayText` | Concise grouped plain-text receipt for iOS. | Show with Show Result; do not replace the response Dictionary with this string. |
| `sourceId` | Evidence-row identity. | Diagnostic/reprocess use, not normal transaction update identity. |
| `requestId` | Correlation ID for logs/audits. | Useful for debugging an error. |

## 7. Event lifecycle, status, and review rules

### 7.1 Request status vs transaction state

`status` describes what happened in this request. `verificationStatus`, `needsEnrichment`, and `needsReview` describe current states of the transaction/evidence. They must not be collapsed into one flag.

Common ingestion statuses:

- `ACCEPTED`: source inserted and linked to a new canonical transaction.
- `RECONCILED`: this opposite-channel source was linked to an existing transaction.
- `DUPLICATE_CANDIDATE`: distinct same-channel alert retained as its own transaction and flagged for review.
- `CONFLICT` / `SOURCE_CONFLICT`: evidence conflicts or matching candidates are ambiguous; evidence is retained and review is required.
- `IDEMPOTENT_REPLAY`: exact source replay; existing transaction returned without a second Source Log or Transaction Log row.
- `PARSE_FAILED`: raw source evidence retained but the pipe contract could not produce a valid transaction. A subsequent valid retry is recoverable.
- `UPDATED`: a valid update changed fields on the same transaction.
- `NO_CHANGE`: supplied field values equal existing values.
- `UPDATE_REJECTED`, `NOT_FOUND`, `BUSY`, `BAD_JSON`, `MISSING_ACTION`, or `SCHEMA_INVALID`: no successful update/insert should be inferred from the status.

### 7.2 `nextAction` must gate Shortcut prompting

The primary first-source `ACCEPTED` request may return `ASK_PURPOSE` or `CLASSIFY_CATEGORY` depending on missing fields. Once a purpose is supplied, the follow-up update response can return `CLASSIFY_CATEGORY` if the category remains missing.

`RECONCILED` and `IDEMPOTENT_REPLAY` return `SHOW_RECEIPT`, even if `needsEnrichment` remains true. This is intentional: a second source arriving 5–10 seconds later should validate/link evidence without opening competing enrichment prompts. If the original first-source Shortcut run is cancelled before enrichment completes, recover the remaining work later using the pending-enrichment read action or a manual resume Shortcut. Do not make every replay re-open the prompt.

`DUPLICATE_CANDIDATE`, `CONFLICT`, and integrity issues route to `REVIEW`. Do not attempt to resolve a transaction-identity conflict by asking AI to invent a purpose/category.

### 7.3 Verification states

- `SMS_ONLY`: SMS evidence exists; no matching email linked.
- `EMAIL_ONLY`: email evidence exists; no matching SMS linked.
- `VERIFIED`: both SMS and email evidence link to the same transaction.
- `CONFLICT`: conflicting evidence prevents trusted verification.
- `UNKNOWN`: no counted valid evidence is linked.

A single source is normal. Lack of an opposite-channel alert does not by itself mean the transaction is invalid.

### 7.4 Review/enrichment state

- `requiresPurpose`: missing/meaningless purpose.
- `requiresCategoryClassification`: no active valid category.
- `needsEnrichment`: either of those is true.
- `needsReview`: any unresolved review condition remains, including enrichment, duplicate candidate, source conflict, unknown type, unusable merchant or time precision issue.
- `reviewStatus`: generally `Pending` when `needsReview=true`, `Approved` when resolved. Verification is independent.

Completing purpose/category may clear only enrichment-specific review reasons. It must not clear duplicate/source-conflict flags, ambiguous timing, or other unrelated manual review requirements.

### 7.5 Meaningful purpose and purpose history

The backend treats a blank purpose, obvious generic placeholders, and a value that merely duplicates the normalized merchant as missing. For example, merchant `SRI VENKATA` with User Notes `SRI VENKATA` still requires purpose input. A useful history suggestion requires the same normalized merchant and semantic transaction type and comes only from prior rows that are approved, valid, not under review, and have both a meaningful purpose and active category. At most three distinct examples are returned, without raw bodies. These examples reduce typing; they are not a proof of what a current purchase was for.

## 8. Duplicate and reconciliation policy

### Exact source replay

A repeat of the same normalized source evidence within the same channel returns `IDEMPOTENT_REPLAY`. This protects Shortcuts/network retries. It does not create another Transaction Log or Source Log row. If the original source was parse-failed, a retry with corrected pipe data is recoverable rather than permanently blocked.

### Opposite-channel reconciliation

Auto-link only when a single existing candidate satisfies:

1. Signed amount agrees to the cent.
2. Bank matches after normalization.
3. Merchant matches exactly after normalization (not substring match).
4. Both timestamps have datetime precision and are within the inclusive five-minute window.
5. Account/card identifiers do not conflict when both expose meaningful values. Missing or generic masked IDs do not block.
6. Account Type agrees when both sources provide it; missing on one side does not block, conflicting values do.

If an evidence pair has no safe unique match, do not guess. A date-only time cannot prove a five-minute match. Conflicts are retained for review.

### Distinct same-channel candidate

A distinct SMS resembling a prior SMS, or a distinct email resembling a prior email, is **inserted as a separate row** and flagged as `DUPLICATE_CANDIDATE` when duplicate criteria match. Do not suppress that second message solely because amount/merchant/time resembles another. The only no-second-row case is an exact same-channel replay.

### Concurrency

Apps Script uses a write lock to serialize ledger/source writes. It does not control UI pauses in two separate Shortcut runs. The `nextAction` contract prevents a matching second-channel request from starting another enrichment flow; the Shortcut must obey it. If the lock times out, treat `BUSY` as a retryable error and do not claim a transaction was written.

## 9. Rules and Config safety

- Prefer merchant-grounded rules.
- Do not auto-apply `AMOUNT`-only rules in v1.0.0. This specifically protects rules for recurring values such as SIP and housing payments from misclassifying unrelated transactions for the same amount.
- `AMOUNT+MERCHANT` requires both a numeric amount and populated merchant keyword. A malformed rule never silently falls back to a broader matcher.
- Category must be an active `Categories` value. If not, the row is ignored for auto-classification and the transaction remains for enrichment.
- Conflicting equal-specificity/equal-priority rules are ambiguous; the backend does not choose by row order when outputs conflict.
- A meaningful purpose must be created from a Notes Template or approved rule Notes only for a merchant-grounded rule; the rule must also provide an active category to complete enrichment.
- `Is Recurring` is descriptive. It does not, by itself, hide the enrichment prompt.
- Config picks account/card/instrument from specific matching evidence. A masked account ID cannot select a suffix-specific account. Source-provided instrument wins over Rule/Config defaults.
- `Is Internal` is set only for a configured merchant/counterparty-specific mapping when semantic transaction type is `transfer`. Keep `N` until trusted self-transfer patterns exist.

## 10. Analytics and agent questions PFIS should answer

The existing formula-driven analytics tabs should remain dynamic as new transactions are appended or corrected. Gemini should use the active workbook rather than stored snapshots and the separate scheduled prompts in `PFIS_GEMINI_ANALYTICS_PROMPTS_v1.0.0.md`.

Examples of useful questions:

- What was income, consumption spending, investment flow, and operating cash flow for the selected period?
- Which categories/merchants explain the biggest change compared with the prior equivalent period?
- Which recurring commitments are confirmed by rules versus only suspected from history?
- Which transactions are missing meaningful purpose/category, have unusable merchant/type, or have a duplicate/conflict review flag?
- Which sources are SMS-only, email-only, verified, or conflict, and is any reconciliation stuck?
- How did spending change by day, category, merchant, or month?
- What spending pattern is new versus normal based on sufficient historical data?
- What action would most reduce a demonstrated overspend, and what calculation supports the estimated effect?
- Which transaction rows need manual attention first and why?

Rules for analytics: exclude `isInternalTransfer=true` from income/consumption; separate credit-card settlement and investment flows from consumption to avoid double-counting. Show the calculation definitions. Use actual data only. Analytics are not permission to modify transaction records.

### Weekly and monthly analytics prompts

Use `PFIS_GEMINI_ANALYTICS_PROMPTS_v1.0.0.md`. The weekly prompt analyzes the previous seven complete days and includes week-on-week comparison and review-queue status. The monthly prompt analyzes the last completed calendar month, prior month, and up to six complete months of trends. Both request labelled charts and prohibit workbook mutation.

## 11. Operational API/runbook

### One-time setup

1. Open the Google Apps Script project bound to, or configured for, the PFIS workbook.
2. Remove old/duplicate engine files from the active project. Keep exactly one backend source plus the separate test file; duplicate global declarations are unsafe.
3. Add `PFIS_TransactionEngine_v1.0.0.gs` as the backend and `PFIS_TransactionEngine_v1.0.0_Tests.gs` as a separate file.
4. Open **Project Settings → Script Properties** and set `SPREADSHEET_ID` to the intended workbook ID.
5. If endpoint authentication is needed, set `WEB_APP_SECRET` and pass the matching `token` in every request body. Do not hardcode it in source code or expose it in URLs.
6. Set the Apps Script project timezone to `Asia/Kolkata`.
7. Run `PFIS_VALIDATE()` against the target spreadsheet and inspect the full execution log. It is a diagnostic/schema check; it does not automatically rearrange or migrate the workbook.

### Run the complete integration suite

1. Add `PFIS_TransactionEngine_v1.0.0_Tests.gs` alongside the engine in the same Apps Script project.
2. Run `PFIS_TEST_RUN_ALL()` once. If no test workbook exists, the runner creates a dedicated Google Sheet named `PFIS TEST - ...` and stores its ID in `PFIS_TEST_SPREADSHEET_ID`. For a manual pre-check, `PFIS_TEST_SETUP()` can create/validate the test workbook separately.
3. Inspect the logged test spreadsheet URL and confirm its name starts with `PFIS TEST - `. The runner refuses to target `SPREADSHEET_ID`.
4. The one-call suite runs **46 scenarios** and logs a JSON report with each scenario, elapsed time, result, and test spreadsheet URL.
5. Inspect the test workbook's Transaction Log, Source Log and Change Log. The suite performs real Google Sheets writes, including SMS-first, email-first, two separate same-channel alerts, an enrichment update, and a JSON POST insertion scenario.
6. Re-running the suite clears test Transaction Log, Source Log and Change Log rows in that dedicated test workbook, then inserts test scenarios again. Rules/Config/Categories are kept in the test workbook. Never point `PFIS_TEST_SPREADSHEET_ID` at production.
7. `PFIS_TEST_CLEANUP()` clears only the three test data tabs in the dedicated test workbook. It does not delete the workbook.

The test harness contains 46 scenario executions: pure decision logic, schema/health validation, both arrival orders, exact replay, distinct duplicates, five-minute boundaries, merchant exactness, date precision, account-type and suffix conflicts, category/purpose update, parse failure/recovery, active category validation, internal/config behavior, duplicate/conflict review preservation, purpose examples, amount-only rule safety, `nextAction`, display text, and public POST validation. These are real Apps Script/Google Sheets integration scenarios when run in Apps Script. Static syntax checks in a local environment are not a substitute for running them.

### Deployment

1. Do not deploy until `PFIS_VALIDATE()` is valid for the intended workbook and the full isolated test suite passes.
2. Deploy a **new Web App version** after changing the code; saving the editor alone does not update an existing deployment.
3. Use the deployed `/exec` endpoint in Shortcuts/Postman.
4. Use POST JSON for insertion/update/reprocess; GET is only for read/health/validation actions.
5. Run a controlled live insertion using a unique test-like merchant/reference if you intend to add a production row. Inspect Transaction Log and Source Log immediately. Then test a purpose/category update by `transactionId`, and then opposite-channel reconciliation. Do not reuse real bank evidence repeatedly to generate test transactions.
6. After successful testing, align Shortcuts with `nextAction`: `ASK_PURPOSE` → purpose suggestion/default plus user confirmation; `CLASSIFY_CATEGORY` → Apple Intelligence using `allowedCategories`; `SHOW_RECEIPT` → display receipt without another prompt; `REVIEW` → show review instruction; `SHOW_ERROR` → display error and stop. Keep the response dictionary intact; `displayText` is only for presentation.

### Performance diagnostics

- `PFIS_PERF_LOG=TRUE` enables per-request phase timings in Apps Script execution logs. Turn it off after diagnosis.
- Inspect total request time and phases such as lock wait, source lookup, reconciliation, rule/config resolution, sheet append/read, and audit append.
- A lock timeout returns `BUSY`; do not pretend the write succeeded. Do not shorten/lengthen locks before measuring concurrent request timing.
- Do not log complete SMS/email text or tokens to execution logs. Source Log retains the sanitized evidence supplied by the Shortcut.

## 12. Release acceptance checklist

- [ ] Exactly one active backend file with constants at `v1.0.0`.
- [ ] `SPREADSHEET_ID` targets the intended spreadsheet; `WEB_APP_SECRET` is configured consistently if used.
- [ ] Core schema validation passes with fixed column order.
- [ ] All 46 Apps Script integration scenarios pass in the dedicated test workbook.
- [ ] SMS-first inserts once; later email reconciles to the same ID and produces `VERIFIED`.
- [ ] Email-first works symmetrically; later SMS reconciles to the same ID.
- [ ] Exact same-channel replay inserts no duplicate row.
- [ ] A distinct same-channel duplicate candidate is inserted as a second row and flagged for review.
- [ ] `requiresPurpose`, `requiresCategoryClassification`, `needsEnrichment`, `needsReview`, `verificationStatus`, `status`, and `nextAction` are interpreted separately in the Shortcut.
- [ ] Purpose suggestion is only a hint; user confirms before update.
- [ ] Category is validated against active `allowedCategories`.
- [ ] Update errors/NO_CHANGE are handled correctly; the Shortcut does not show success before parsing response.
- [ ] All backend write calls use POST JSON and the `action` is inside the body.
- [ ] Live deployment has been tested end to end with one deliberate transaction, one update and one cross-channel reconciliation.
- [ ] Existing formulas/analytics are intact and dynamically include newly appended rows.
- [ ] Gemini weekly/monthly prompts run read-only and produce labelled charts/limitations.

## 13. Data retention and reset policy

Do not automatically clear Source Log or Change Log as routine cleanup. Source Log hashes protect same-channel idempotency; clearing it makes old alerts more likely to be treated as new evidence if replayed. Change Log is the historical trail of corrections and system actions. If the owner deliberately chooses a first-version reset, understand that the replay/audit history is lost; keep the Transaction Log and source/transaction identities consistent, and do not call it a migration with retained history.

The test harness has a safe, separate reset limited to the dedicated `PFIS TEST - ...` workbook. It does not modify production `SPREADSHEET_ID` and must keep this guard permanently.

## 14. Scope for the first month

Run the system for one month before adding features. Log bugs with: timestamp, Shortcut path (SMS/email), request ID, transaction ID if returned, request status, `nextAction`, expected behavior, actual behavior, and a sanitized example. Avoid including secret tokens or raw personal messages in Git issues.

Do not add location to the pipe format, another helper tab, backend Gemini API calls, autonomous review approval, or a second rules engine without evidence these are needed. The monthly/weekly Gemini analysis is a separate read-only schedule; it is not part of transaction ingestion.

---

## Source-of-truth policy

This README supersedes prior project overview/runbook documents for the current PFIS implementation. Keep the separate `PFIS_GEMINI_ANALYTICS_PROMPTS_v1.0.0.md` only for scheduled prompt text. When a future code/schema change is approved, update this README, tests, and prompt contracts together; do not maintain contradictory architecture descriptions elsewhere in the repository.
