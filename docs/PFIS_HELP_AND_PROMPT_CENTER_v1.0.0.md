# PFIS v1.0.0 — Help & Prompt Center

This is the beginner's guide to operating PFIS with natural-language prompts. A new user does not need to understand the Apps Script architecture or spreadsheet formulas. They do need to give Gemini the correct transaction evidence and requested action.

## Is a Help & Prompts tab worth keeping?

Yes. Keep one visible **PFIS Help & Prompts** tab in the workbook. It should be the first place a new user looks for:
- what PFIS can do;
- what information to provide;
- copy-ready prompts for common actions;
- examples of a valid transaction;
- what Gemini may update automatically and what needs human approval;
- what must never be deleted.

Keep the actual financial facts in Transaction Log, original evidence in Source Log and history in Change Log. The Help tab is instructions only. It should not become another transaction table.

The Help tab should be compact and mobile-friendly. Use columns:
1. Section
2. Task
3. When to use
4. Information to provide
5. Copy-ready prompt
6. Safety rule / expected result

Wrap text, freeze the header row, use filters, set useful column widths and keep one task per row. Put a short "Start Here" section at the top and group prompt rows by task.

## Start here — how to ask Gemini

A user can type ordinary requests such as:
- "Add this completed bank transaction to PFIS" and paste the complete SMS/email.
- "Find transaction 202610-171 and tell me what is wrong."
- "Change the category of 202610-171 to Credit card payments. Use the original source evidence and audit the update."
- "Review today's anomalies and list only actions I need to take."
- "These two records are the same payment. Compare their original evidence and prepare the duplicate resolution. Do not archive until I confirm."
- "This transaction is incorrect. Show me the evidence and archive it only after I explicitly confirm."

Gemini must inspect the live workbook schemas and evidence. A prompt is not permission to guess missing data.

## What information is needed?

### A. Add a new transaction

Best input: paste the complete original bank SMS/email, not a paraphrase.

If the original message is unavailable, supply:
- actual transaction date/time (or date only if no time exists);
- signed amount and currency;
- bank;
- source account type;
- instrument/payment rail, if known;
- transaction type, if known;
- merchant/biller;
- counterparty, if present;
- UTR/RRN/reference, if present;
- actual post-transaction balance, only if stated;
- source type (SMS or EMAIL).

Do not invent an account number, card suffix, reference, merchant, timestamp or balance.

PFIS's canonical extraction string has exactly ten fields and nine pipe delimiters:

**datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after**

Example only — all data below is fictional:

    14/10/2026 09:15:00|-845.50|Demo Bank|Savings Account|UPI|expense|Harbor Coffee|Harbor Coffee|DEMO-UTR-1001|NA

Rules:
- Debit/outflow: negative amount.
- Credit/inflow: positive amount.
- Amount: numeric, two decimals.
- Use NA for unknown optional fields, but preserve every delimiter.
- Never add a literal pipe inside a field.
- The backend creates the Transaction ID, Source ID, source hash and audit/replay metadata. Gemini must not invent these values.

### B. Update an existing transaction

Always provide:
- Transaction ID;
- exact field to change;
- requested new value;
- reason for the change;
- supporting original source evidence when a financial fact or classification is in question.

The standard update action supports Category, Purpose/User Notes, Type and Merchant. It validates Category against the active Categories sheet, rejects invalid Type values and audits the changes.

Do not ask Gemini to change Transaction ID, DateTime, Amount, Bank, Reference Number or Source Log evidence through a normal update. Corrections to source facts require evidence and a separately reviewed process.

### C. Investigate an anomaly

Provide the Transaction ID(s), or ask Gemini to inspect today's getpendingreview, getneedsenrichment, getanomalies and getdataquality results.

Ask Gemini to:
1. compare Transaction Log with linked Source Log evidence;
2. check Change Log history;
3. classify the issue (missing information, source conflict, possible duplicate, invalid category, account mapping or data-quality warning);
4. explain the evidence and recommend the safest next action;
5. make no change until the action is clear and authorised.

### D. Resolve a suspected duplicate

Required:
- duplicate Transaction ID;
- surviving canonical Transaction ID (duplicateOf);
- original source evidence for both;
- reason that explains why they are the same financial event.

Only use CONFIRM_DUPLICATE after a human explicitly confirms the survivor. The engine archives the duplicate, relinks its source evidence and records audit history. Similar amounts or dates alone are not enough.

### E. Reject an incorrect transaction

Required:
- Transaction ID;
- original source evidence;
- explicit reason why the canonical record is incorrect or unwanted.

Use REJECT_TRANSACTION only after human confirmation. It moves the complete record to Rejected & Archive Log, retains source evidence and writes Change Log history. It does not permanently delete the record.

## Copy-ready operator prompts

The workbook Help tab should include these prompts, with square-bracket placeholders that the user replaces.

### 1. Add a transaction

"Add this completed transaction to PFIS.

Source type: [SMS or EMAIL]
Original bank message:
[PASTE THE COMPLETE ORIGINAL MESSAGE]

Extract the exact ten PFIS fields. Preserve unknown optional fields as NA and keep all nine delimiters. Validate date, signed amount and bank. Check for an existing source hash or matching transaction before insertion.

If the authorised PFIS Apps Script ingest endpoint is available, submit one POST ingest request and verify the returned Transaction ID, Source Log row and replay status. If it is not available, return the validated payload and explain that it has not been inserted. Never directly append a row to Transaction Log or invent IDs/hashes."

### 2. Find and explain a transaction

"Find Transaction ID [TRANSACTION_ID]. Read the transaction and its linked Source Log evidence. Check Change Log, Category, Type, Account, verification status, review state, duplicate/conflict flags and archive status. Explain what is correct, what is missing and the next safe action. Do not modify anything."

### 3. Update a category, type, merchant or Purpose

"Update Transaction ID [TRANSACTION_ID].

Requested field: [category / type / merchant / purpose]
New value: [NEW VALUE]
Reason: [WHY THIS IS CORRECT]
Evidence: [ORIGINAL SOURCE MESSAGE OR EXPLANATION]

Check the active schema and allowed values. Preserve all other user-entered fields. Use the PFIS update API only. Verify the Transaction Log values and matching Change Log events after the update. If the evidence or requested value is ambiguous, do not write."

### 4. Review and clean anomalies

"Review PFIS data quality for [TODAY / DATE RANGE / ALL OPEN ITEMS].

Inspect pending review, category enrichment, anomalies, duplicate candidates, source conflicts, parse failures, broken source links, missing account mappings and active rows already marked as rejected/duplicate.

For each exception show Transaction ID, date, amount, merchant, current state, source evidence, exact problem and recommended next action. Group related issues and avoid double-counting the same issue. Do not delete, archive, approve, reject or change any record. Give me a short list of decisions required."

### 5. Prepare a duplicate decision

"Compare Transaction [DUPLICATE_ID] with proposed survivor [SURVIVOR_ID].

Read both original Source Log messages and Change Log history. Compare reference number, account/card, exact amount and currency, transaction time, merchant/counterparty, bank and source identifiers.

Tell me whether the evidence proves they are the same financial event. If not conclusive, say NOT CONFIRMED. Do not archive or relink anything. If confirmed, show the exact CONFIRM_DUPLICATE request for my review, including duplicateOf and a human-readable reason. Wait for my explicit instruction before submitting."

### 6. Archive an incorrect transaction

"Review Transaction [TRANSACTION_ID] and its original source evidence.

Reason it may be wrong/unwanted: [EXPLANATION]

Determine whether this is:
- a genuine duplicate (requires a surviving Transaction ID and CONFIRM_DUPLICATE); or
- an incorrect/unwanted canonical transaction (requires REJECT_TRANSACTION).

Do not choose for me. Explain the evidence and show the exact proposed resolution request. Do not submit until I explicitly confirm. Never permanently delete the row or erase its Source Log/Change Log history."

### 7. Reprocess a failed source

"Review Source ID [SOURCE_ID] and its original Source Log message. Explain why it is PARSE_FAILED, CONFLICT or DUPLICATE_CANDIDATE. If I provide a corrected ten-field transaction string, validate every field and use the PFIS reprocesssource API only when that source status is eligible. Preserve the original message and previous source history. Do not create a second transaction manually."

### 8. Run the daily check

"Run the PFIS Daily Transaction Verifier using live Gmail and the connected PFIS workbook. Follow the repository prompt GEMINI_DAILY_TRANSACTION_VERIFIER_v1.0.0.md. Keep backfilled transactions separate, do not double-count, preserve SMS_ONLY as informational, and report only actionable exceptions. Do not directly edit protected ledger or audit cells."

## What Gemini can and cannot change

| User request | Supported route | Human confirmation |
|---|---|---|
| Insert a completed transaction | ingest POST with full source evidence and ten-field string | No, for a clean validated transaction if the authorised endpoint can actually be invoked |
| Update Category / Type / Merchant / Purpose | update POST | User supplies the new value and reason |
| Reclassify from already-linked evidence using current Rules/Config | reclassifyfromevidence POST | Only for an incomplete/provisional classification; never overwrite a valid human classification silently |
| Reprocess eligible failed/conflicting source | reprocesssource POST | Corrected transaction string must be supplied and validated |
| Inspect review/enrichment/anomalies/data quality | getpendingreview, getneedsenrichment, getanomalies, getdataquality | No |
| Confirm duplicate | resolveexception + CONFIRM_DUPLICATE | Always |
| Confirm distinct transaction | resolveexception + CONFIRM_DISTINCT | Always |
| Reject/archive incorrect transaction | resolveexception + REJECT_TRANSACTION | Always |
| Attach an email to an existing transaction only | No dedicated attach-only action in current v1.0.0 | Report as not linked; do not use ingest as a shortcut |
| Permanently delete transactions or audit history | Not supported | Never |

## Critical safety boundaries

- **No hard delete.** Garbage transaction records are resolved by a deliberate rejection or duplicate archive. Original evidence and history must remain.
- Never delete rows from Transaction Log, Source Log, Change Log, Rejected & Archive Log, Rules or Config by hand.
- Never directly add a Transaction Log row. Use the Apps Script ingest pipeline.
- Never invent Transaction IDs, Source IDs, source hashes, verification states or Change IDs.
- Never set VERIFIED based only on a Gmail match. PFIS verification is derived from linked Source Log evidence.
- Never auto-approve or auto-reject ambiguous records.
- Blank Purpose is allowed. Do not block ingestion because Purpose is missing.
- DEFAULT_CATEGORY:MISCELLANEOUS is a traceable fallback, not proof of financial-integrity failure.
- SMS_ONLY is an evidence status, not a rejection reason.
- Do not modify formulas, dashboard outputs or hidden support tabs when handling a transaction.
- Do not put the Web App secret, full account/card numbers or private raw messages in a public prompt or repository.

## One limitation new users must understand

A prompt does not itself guarantee that Gemini can call the authenticated PFIS Apps Script Web App. The user's Gemini environment must have an approved way to invoke the endpoint and supply its secret securely. If it only has Google Sheets read/edit access, Gemini may analyse the workbook and prepare the request, but it must not bypass the Apps Script engine by writing directly into canonical rows.

This is intentional: direct spreadsheet edits can skip source hashing, idempotency, rule/config evaluation, duplicate detection, locks and consistent Change Log auditing.

## Version

All PFIS release, schema, parser and guide identifiers remain v1.0.0.
