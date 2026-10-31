# PFIS v1.0.0 — Ledger Cleanup Operations

This runbook covers two controlled administrative tasks: migrating legacy rows that were already explicitly marked as confirmed duplicates, and reclassifying existing transactions using linked source evidence plus current Rules/Config.

Do not use it to remove merely suspicious, incomplete or unresolved transactions.

## 1. The current data model

- Transaction Log: active canonical ledger. Potential duplicate candidates and unresolved genuine events remain here until a human decision.
- Source Log: original SMS/email evidence, source hashes, parse status and links.
- Change Log: audit history. Do not rewrite or clear it.
- Rejected & Archive Log: final confirmed duplicates and explicitly rejected canonical transactions.
- Rules: deterministic merchant/amount classification.
- Config: bank/account/card/instrument mapping and whether a transaction is an internal movement between owned accounts.

A source-only parse failure has no canonical transaction row and must never be archived as a transaction.

## 2. Legacy duplicate migration

The current duplicate-confirmation workflow already archives new human-confirmed duplicates. The migration functions are only for old rows that remain in Transaction Log after previously being labelled **DUPLICATE_REJECTED / Rejected - Duplicate**.

### Preview first

Run this Apps Script function:

**PFIS_PREVIEW_LEGACY_DUPLICATE_ARCHIVE_MIGRATION()**

It is read-only. For every flagged row it requires:
- an explicit final duplicate marker;
- a surviving Transaction ID stated in Review Reason;
- the surviving transaction to still exist in Transaction Log and not itself be a duplicate/rejected/conflicted row;
- no conflicting record with the same Transaction ID in Rejected & Archive Log.

Only **ELIGIBLE** rows may migrate. **BLOCKED_\*** rows need human investigation. The migration does not guess the survivor ID and does not use matching amount/date alone.

### Apply only after reviewing the preview

After inspecting every eligible row and confirming the survivor link, run:

**PFIS_APPLY_LEGACY_DUPLICATE_ARCHIVE_MIGRATION()**

For each eligible row the function:
1. copies the complete row (core A:AC and all existing auxiliary fields) to Rejected & Archive Log;
2. retains the original duplicate status and reason;
3. relinks associated Source Log evidence to the surviving canonical transaction and marks it DUPLICATE_SUPPRESSED;
4. records the archive move and survivor/evidence link in Change Log;
5. clears the old active Transaction Log row only after archive, source and audit writes succeed.

It is idempotent for the same archive decision and refuses conflicting archive IDs. Re-run the preview afterward; there should be no eligible rows left. Do not run the apply function if the preview contains an incorrect survivor.

## 3. Card-payment classification rules

A credit-card bill payment is a settlement, not another operating purchase. Classify it as:
- Category: **Credit card payments**
- Type: **card_payment**
- Is Internal Transfer: **TRUE** only when the paid card is confirmed to be owned by the same person as the source bank account.

The engine now matches distinctive configured merchant phrases against both the extracted merchant/counterparty and the linked original source evidence. This matters when an email extractor uses a generic label such as **Axis Credit Card Bill**, while the original notification says **CreditCard Payment**.

Configure both Rules and Config. Rules provide category/type; Config provides the source account/card context and the internal flag. Do not mark every credit-card payment internal by default.

Suggested rows for the current verified examples:

| Purpose | Rules: Merchant Contains | Rules: Category | Rules: Type Override | Config: Merchant Contains | Config: Account | Config: Is Internal |
|---|---|---|---|---|---|---|
| Axis card bill via generic label | CreditCard Payment | Credit card payments | card_payment | CreditCard Payment | AXIS_SAVINGS | TRUE |
| SBI card bill via merchant phrase | SBI Cards and Payme | Credit card payments | card_payment | SBI Cards and Payme | AXIS_SAVINGS | TRUE |

Use the exact bank/account naming already present in the workbook and ensure both phrases identify cards owned by the user. Give each Rule a unique Rule ID and each Config row an appropriate Priority. Do not overwrite existing rows.

### Reclassify existing transactions

After the Rules and Config rows have been saved and the updated engine deployed, call the API once for each existing active transaction:

~~~json
{
  "action": "reclassifyfromevidence",
  "transactionId": "202610-169",
  "reason": "Apply verified credit-card payment Rules and Config",
  "actor": "user"
}
~~~

~~~json
{
  "action": "reclassifyfromevidence",
  "transactionId": "202610-171",
  "reason": "Apply verified credit-card payment Rules and Config",
  "actor": "user"
}
~~~

This operation reads linked Source Log evidence, current Rules and Config, then updates only classification/mapping fields. It does not modify amount, date/time, bank, merchant, counterparty or reference number. It writes Change Log entries and clears only eligible classification review reasons. It fails closed if evidence, category, rule or account mapping is ambiguous.

Expected successful result:
- category = Credit card payments
- type = card_payment
- isInternalTransfer = true
- needsReview = false only if no independent review reason remains

If the Config row does not resolve unambiguously, stop and correct Config; do not manually force the internal flag.

## 4. Transactions that must remain under review

Do not treat a blank/Unspecified merchant, an empty transaction type, or an email summary with no counterparty/reference as a confirmed duplicate.

In the workbook export reviewed for this repair, **202610-166**, **202610-170**, **202610-174** and **202610-182** were NEEDS_REVIEW with unknown_transaction_type, not DUPLICATE_REJECTED. The visible Source Log evidence was generic Axis email summary text with no transaction counterparty/reference. They are not eligible for legacy duplicate migration on that evidence.

Leave these records in review or reprocess them only when a complete, reliable original bank notification or other independent evidence is available. Do not archive or infer the missing transaction details.

## 5. Verification after deployment

1. Run PFIS_VALIDATE().
2. Run PFIS_RUN_ALL_PREFLIGHT_TESTS() and inspect the new evidence-matching/reclassification and legacy duplicate parser cases.
3. Run duplicate migration preview; review blocked and eligible results.
4. Apply migration only after human confirmation.
5. Add/verify the Rules and Config rows in Google Sheets.
6. Call reclassifyfromevidence for the intended existing transactions.
7. Query those transactions and verify the four expected classification fields.
8. Confirm Change Log rows exist and Source Log evidence is still linked.
9. Confirm a new synthetic notification with the configured merchant phrases is classified consistently before relying on live capture.

All code, schema and documentation identifiers remain v1.0.0.
