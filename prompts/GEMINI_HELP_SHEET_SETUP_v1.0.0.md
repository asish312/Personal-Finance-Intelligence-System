# PFIS v1.0.0 — Gemini Help & Prompts Sheet Setup

Use this one-time prompt with Gemini while the live PFIS Google Spreadsheet is open.

~~~text
Create one new visible sheet tab named exactly "PFIS Help & Prompts" in my existing PFIS workbook.

Purpose: a beginner-friendly operator guide. A new user should be able to understand what information to provide and copy a prompt for adding, finding, updating, reviewing or archiving a transaction without learning the Apps Script architecture.

IMPORTANT SCOPE
- Add only this new Help tab.
- Do not alter Transaction Log, Source Log, Change Log, Rejected & Archive Log, Rules, Config, Categories, formulas, named ranges, charts, validations or existing formatting in other tabs.
- Do not move, rename, hide or delete any existing tab.
- Never put actual financial records, account/card numbers, source messages, Web App URLs or secrets in this Help tab.
- Do not add a second transaction ledger.
- Keep the sheet read-only in purpose: it stores instructions/prompts, not financial facts.

LAYOUT
Create these columns:
A Section
B Task
C When to Use
D Information to Provide
E Copy-Ready Prompt
F Safety Rule / Expected Result

Make it mobile-readable:
- Freeze row 1.
- Turn on a filter for the header row.
- Wrap all text.
- Use a readable, consistent style.
- Give columns practical widths: A 130px, B 180px, C 220px, D 260px, E 520px, F 300px.
- Use alternating row shading if available.
- Keep one task per row.
- Put a short "START HERE" instruction above or immediately below the header without breaking the filter table.

ADD THESE PROMPT ROWS

1. Section: GETTING STARTED
Task: How to use PFIS
Information: Ask Gemini in plain language; use Transaction ID or complete original bank message.
Prompt: "You are my PFIS operator. First inspect the live workbook schemas. Ask me only for missing essential information. Explain the safe action before changing anything. Use the authenticated PFIS Apps Script API for all canonical ledger writes. Never directly insert/delete ledger rows or edit Source Log/Change Log."
Safety: This Help tab is instructions only; no transaction data is stored here.

2. Section: INSERT
Task: Add new transaction
Information required: Complete original SMS/email, source type, actual date/time or date-only, signed amount, bank, account type, instrument, type if known, merchant, counterparty/reference/balance if present.
Prompt: "Add this completed transaction to PFIS. Source type: [SMS/EMAIL]. Original message: [PASTE COMPLETE MESSAGE]. Extract exactly ten fields in this order: datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after. Use NA for unknown optional fields and keep all nine delimiters. Debit negative, credit positive. Validate date, non-zero amount and bank. Check idempotency/duplicate evidence. If the authenticated PFIS ingest endpoint can be invoked, submit one POST ingest and verify the returned Transaction ID and Source Log evidence. Otherwise return the payload and tell me it was not inserted. Never append a ledger row directly."
Safety: Never invent details, IDs, source hashes or a transaction time. A prompt-only environment cannot claim an insertion.

3. Section: LOOKUP
Task: Find transaction
Information required: Transaction ID (preferred), or distinctive merchant/date/amount.
Prompt: "Find [TRANSACTION_ID]. Read Transaction Log and linked Source Log evidence. Check Change Log, Category, Type, Account, verification state, review state, duplicate/conflict flags and archive status. Summarise issues and safe next action. Read-only; do not modify."
Safety: Read-only inspection.

4. Section: UPDATE
Task: Update classification or purpose
Information required: Transaction ID, field, exact new value, reason and evidence.
Prompt: "Update [TRANSACTION_ID]. Field: [category/type/merchant/purpose]. New value: [VALUE]. Reason: [REASON]. Evidence: [SOURCE]. Validate the active Category or Type. Preserve all other user-entered values. Use the authenticated PFIS update API only. Verify Transaction Log and Change Log. If evidence is ambiguous, stop."
Safety: Do not use normal update to change financial facts or protected review/verification fields.

5. Section: CLASSIFY
Task: Reclassify using existing evidence
Information required: Transaction ID; linked Source Log evidence; current Rules and Config.
Prompt: "Reclassify [TRANSACTION_ID] using linked original Source Log evidence and current enabled Rules/Config. Use reclassifyfromevidence only if Category/Type is missing, invalid or explicitly provisional. Do not overwrite an already valid human classification. Verify every field change and Change Log event."
Safety: Fails closed if the evidence/rule/config mapping is ambiguous.

6. Section: ANOMALY
Task: Review data quality
Information required: Today, date range or all open items.
Prompt: "Review PFIS pending review, needs enrichment, anomalies and data quality for [DATE RANGE]. Compare transaction with linked Source Log evidence and Change Log history. Identify duplicate candidates, source conflicts, missing/invalid category/type, unusable merchant, account mismatch, broken links and parse failures. Group related issues. Explain the evidence and recommended next action. Do not change anything."
Safety: Inspection only; no automatic approval or archive.

7. Section: DUPLICATE
Task: Confirm and archive duplicate
Information required: Duplicate Transaction ID, surviving Transaction ID, original evidence for both, human reason.
Prompt: "Compare [DUPLICATE_ID] with [SURVIVING_ID]. Verify exact event identity using reference, account/card, amount, transaction time, bank and merchant/source evidence. If the evidence proves the same event, show the CONFIRM_DUPLICATE request with duplicateOf and reason. Do not submit until I explicitly confirm."
Safety: Requires human decision. Archive retains full transaction, linked source evidence and audit history. Never hard-delete.

8. Section: REJECT
Task: Archive incorrect transaction
Information required: Transaction ID, source evidence, explicit rejection reason.
Prompt: "Review [TRANSACTION_ID] and its source. Determine whether it is a wrong/unwanted canonical event or a duplicate. Explain evidence and show a proposed REJECT_TRANSACTION request. Wait for my explicit confirmation before submission."
Safety: Rejected & Archive Log preserves the record. No permanent delete.

9. Section: REPROCESS
Task: Reprocess failed source
Information required: Source ID and corrected ten-field string.
Prompt: "Inspect Source ID [SOURCE_ID]. If Parse Status is PARSE_FAILED, CONFLICT or DUPLICATE_CANDIDATE, validate this corrected ten-field string: [PASTE STRING]. Use the PFIS reprocesssource API only. Preserve original source history and verify new links. Do not create rows manually."
Safety: Only eligible statuses; no reprocess of terminal archived records.

10. Section: DAILY
Task: Run daily verification
Information required: Today's IST date and access to live Gmail/workbook.
Prompt: "Run the PFIS Daily Transaction Verifier using live Gmail and the connected workbook. Follow prompts/GEMINI_DAILY_TRANSACTION_VERIFIER_v1.0.0.md. Separate backfills, refunds, card settlements and internal transfers. Report only actionable exceptions; make only authorised, audited classification corrections."
Safety: Never treat SMS_ONLY as fraud or email corroboration as a linked VERIFIED source.

11. Section: ARCHIVE
Task: Remove garbage safely
Information required: Transaction ID, source evidence, reason, and surviving ID if duplicate.
Prompt: "Inspect [TRANSACTION_ID]. If it is a confirmed duplicate, propose CONFIRM_DUPLICATE with its surviving Transaction ID. If it is an incorrect/unwanted transaction, propose REJECT_TRANSACTION. If it is incomplete or ambiguous, leave it for review. Do not delete a row or erase source/audit history."
Safety: PFIS has no permanent delete operation for canonical transaction history.

12. Section: LIMITATIONS
Task: What Gemini can execute
Information required: Check whether authorised Apps Script API action is available.
Prompt: "Before any write, confirm you can invoke the authenticated PFIS Apps Script Web App. If not, prepare the request only and report NOT EXECUTED. Do not bypass the engine with direct cell edits."
Safety: Google Sheets edit permission alone is not proof of API execution capability.

FINAL VALIDATION
- Confirm the new Help tab contains all 12 task rows and exact headers.
- Confirm all examples are fictional and no secrets/private data were inserted.
- Confirm only the new Help tab was added.
- Do not claim an API transaction action was tested merely by creating this guide.
- Report the exact tab created and any permission limitation.
~~~

The canonical full instructions and extended examples are maintained in the repository file docs/PFIS_HELP_AND_PROMPT_CENTER_v1.0.0.md.
