# PFIS v1.0.0 — Ledger Cleanup Operations

This runbook covers two controlled administrative tasks: migrating legacy rows that were already explicitly marked as confirmed duplicates, and reclassifying existing transactions using linked source evidence plus current Rules/Config.

Do not use it to remove merely suspicious, incomplete or unresolved transactions.

## 1. Current workbook verification

The latest supplied workbook includes:
- Rules PR-022 and PR-023 for CreditCard Payment and SBI Cards and Payme.
- Matching Config rows for those phrases, mapping to AXIS_SAVINGS with Is Internal=TRUE.
- Active Credit card payments category.
- Historical classification gaps on 202610-169 and 202610-171.
- Five active records already marked DUPLICATE_REJECTED: 202610-162, 202610-166, 202610-170, 202610-174, 202610-182.

Rules/Config are now present in the workbook. Historical card-payment rows have not yet been reclassified.

The four legacy duplicate mappings supported by the original source evidence are:

| Duplicate row | Survivor | Evidence |
|---|---|---|
| 202610-162 | 202610-160 | Same INR 4,288.17 ICICI payment on 29-Oct-2026; Amazon Pay source names ICICI card ending 7009 and ICICI acknowledges that exact card/amount |
| 202610-166 | 202610-165 | Same Axis savings debit, INR 4,537.00, exact 30-Oct-2026 06:45:43 timestamp; SMS has UPI reference and merchant |
| 202610-170 | 202610-171 | Same Axis savings debit, INR 41,091.74, exact 30-Oct-2026 06:48:53 timestamp; SMS has UPI reference and SBI Cards counterparty |
| 202610-174 | 202610-175 | Same Axis savings debit, INR 18,949.07, exact 30-Oct-2026 06:53:23 timestamp; SMS has UPI reference and merchant |

202610-182 is not safely mapped. It is a generic Axis email debit summary for INR 1,080.00. 202610-183 is an SBI Card payment confirmation for the same amount on the same day, but does not include a matching transaction time or reference. Keep 202610-182 blocked pending human confirmation. Do not infer a survivor from amount/date alone.

To prepare the four supported mappings, use the [Gemini Legacy Duplicate Mapping Prompt](../prompts/GEMINI_LEGACY_DUPLICATE_MAPPING_v1.0.0.md). It appends a machine-readable survivor marker to Review Reason while preserving the existing text. It does not archive rows.

## 2. Data model

- Transaction Log: active canonical ledger. Potential duplicate candidates and unresolved genuine events remain here until a human decision.
- Source Log: original SMS/email evidence, source hashes, parse status and links.
- Change Log: audit history. Do not rewrite or clear it.
- Rejected & Archive Log: final confirmed duplicates and explicitly rejected canonical transactions.
- Rules: deterministic merchant/amount classification.
- Config: bank/account/card/instrument mapping and whether a transaction is an internal movement between owned accounts.

A source-only parse failure has no canonical transaction row and must never be archived as a transaction.

## 3. Legacy duplicate migration

The current duplicate-confirmation workflow archives new human-confirmed duplicates. The migration functions are only for old rows that remain in Transaction Log after previously being labelled DUPLICATE_REJECTED / Rejected - Duplicate.

### Preview first

Run:

    PFIS_PREVIEW_LEGACY_DUPLICATE_ARCHIVE_MIGRATION()

It is read-only. For every flagged row it requires:
- an explicit final duplicate marker;
- a surviving Transaction ID stated in Review Reason;
- the surviving transaction to still exist in Transaction Log and not itself be a duplicate/rejected/conflicted row;
- no conflicting record with the same Transaction ID in Rejected & Archive Log.

Only ELIGIBLE rows may migrate. BLOCKED_* rows need human investigation. The migration does not guess the survivor ID and does not use matching amount/date alone.

### Apply only after reviewing the preview

After reviewing every eligible row and confirming the survivor link, run:

    PFIS_APPLY_LEGACY_DUPLICATE_ARCHIVE_MIGRATION()

For each eligible row the function:
1. copies the complete row (core A:AC and all existing auxiliary fields) to Rejected & Archive Log;
2. retains the original duplicate status and reason;
3. relinks associated Source Log evidence to the surviving canonical transaction and marks it DUPLICATE_SUPPRESSED;
4. records the archive move and survivor/evidence link in Change Log;
5. clears the old active Transaction Log row only after archive, source and audit writes succeed.

It is idempotent for the same archive decision and refuses conflicting archive IDs. Re-run the preview afterward; there should be no eligible rows left except those that remain blocked for human review. Do not apply the function if the preview contains an incorrect survivor.

## 4. Card-payment classification

The active Rules/Config rows now match:
- CreditCard Payment → Category Credit card payments, Type card_payment.
- SBI Cards and Payme → Category Credit card payments, Type card_payment.

Config maps both distinctive phrases to AXIS_SAVINGS and Is Internal=TRUE, because the source evidence identifies the Axis savings debit used to pay an owned card. The first mapping preserves the source-provided instrument; the second identifies UPI.

The current workbook still shows:
- 202610-169: type is already card_payment, but category is blank, Is Internal is FALSE and Review Reason still says enrichment_required.
- 202610-171: type is still expense, category is blank, Is Internal is FALSE and Review Reason still says enrichment_required.

After the updated engine is deployed, reclassify both through the API. Do not edit the historical facts directly.

~~~json
{
  "action": "reclassifyfromevidence",
  "transactionId": "202610-169",
  "reason": "Apply verified card payment Rules and Config",
  "actor": "user"
}
~~~

~~~json
{
  "action": "reclassifyfromevidence",
  "transactionId": "202610-171",
  "reason": "Apply verified card payment Rules and Config",
  "actor": "user"
}
~~~

The operation reads linked Source Log evidence, current Rules and Config, then updates only classification/mapping fields. It does not modify amount, date/time, bank, merchant, counterparty or reference number. It writes Change Log entries and clears only eligible classification review reasons. It fails closed if evidence, category, rule or account mapping is ambiguous.

Expected successful result:
- category = Credit card payments
- type = card_payment
- isInternalTransfer = true
- needsReview = false only if no independent review reason remains
- reviewReason = blank when the only prior reason was a classification/configuration reason now resolved

## 5. Verification after deployment

1. Run PFIS_VALIDATE().
2. Run PFIS_RUN_ALL_PREFLIGHT_TESTS() and inspect evidence-matching, historical reclassification, stale review-reason cleanup and legacy duplicate parser cases.
3. Run duplicate migration preview; review every eligible and blocked result.
4. Confirm the four survivor mappings and do not force a mapping for 202610-182.
5. Apply duplicate migration only after human confirmation.
6. Confirm 202610-169 and 202610-171 return the expected classification fields.
7. Confirm Change Log entries exist and Source Log evidence is still linked.
8. Confirm new synthetic notifications with the configured phrases classify consistently before relying on live capture.

## 6. XLSX export compatibility

The latest uploaded Excel export contains Google Sheets-specific formula wrappers (__xludf.DUMMYFUNCTION) and cached #NAME? values in Recent Transactions, Dashboard_Calc, Insights & Data Quality, Monthly Summary, Reports and Dashboard. This export alone does not prove that the live Google Sheet formulas are broken. Verify the live workbook in Google Sheets and rebuild any formula that actually fails there; do not accept the cached XLSX result as proof of a correct calculation.

All code, schema and documentation identifiers remain v1.0.0.
