# PFIS v1.0.0 — Gemini Legacy Duplicate Survivor Mapping

Use this prompt with the latest live PFIS Google Sheets workbook. It updates only the duplicate-survivor reference in Review Reason. It does not archive or delete any transaction.

~~~text
Inspect the current PFIS Transaction Log, Source Log, Rejected & Archive Log and Change Log.

Prepare already human-marked DUPLICATE_REJECTED rows for the Apps Script's preview-first archive migration. The migration requires an explicit surviving Transaction ID in Review Reason.

For each pair below, inspect the original Source Log messages before editing. Preserve the existing Review Reason text and append exactly:
| confirmed_duplicate_of:<SURVIVING_TRANSACTION_ID>

Mappings supported by the source evidence:

- 202610-162 -> 202610-160
  Both describe the INR 4,288.17 ICICI payment on 29-Oct-2026. The Amazon Pay source identifies payment to the ICICI card ending 7009; the ICICI acknowledgement confirms receipt of the same amount to card ending 7009.

- 202610-166 -> 202610-165
  Same Axis Savings account, exact INR 4,537.00 amount and exact 30-Oct-2026 06:45:43 timestamp. The SMS survivor contains the UPI reference and merchant; the email is a generic summary of the same debit.

- 202610-170 -> 202610-171
  Same Axis Savings account, exact INR 41,091.74 amount and exact 30-Oct-2026 06:48:53 timestamp. The SMS survivor contains the UPI reference and SBI Cards counterparty; the email is a generic summary.

- 202610-174 -> 202610-175
  Same Axis Savings account, exact INR 18,949.07 amount and exact 30-Oct-2026 06:53:23 timestamp. The SMS survivor contains the UPI reference and merchant; the email is a generic summary.

For each mapping, verify:
1. The source evidence supports the same event.
2. The survivor exists in Transaction Log and is not itself duplicate/rejected/conflicted.
3. The rejected row's Validation Flag is DUPLICATE_REJECTED and Review Status is Rejected - Duplicate.
4. No conflicting archive row exists for the duplicate ID.

Do NOT assign a survivor for 202610-182. Its Axis email is only a generic INR 1,080 debit summary at 31-Oct-2026 01:06:50. 202610-183 is an SBI Card payment confirmation for INR 1,080, but it has no exact payment time or common reference conclusively tying it to that Axis debit. Leave 202610-182 unchanged and report it for human confirmation.

Do not change Transaction ID, date/time, amount, bank, account, merchant, category, type, instrument, internal-transfer flag, Source Log, archive rows or formulas. Do not change Review Status or Validation Flag. Do not move/delete any rows.

Append exactly one audit row to Change Log for each Review Reason update. Preserve all existing Change Log rows. Use the workbook's exact ten-column header order:
Change ID | Transaction ID | Changed At | Target Table | Actor | Field | Old Value | New Value | Reason | Request ID

For each row:
- Change ID: a unique value such as CHG-GEMINI-DUPMAP-<Transaction ID>; check for collisions and make it unique.
- Transaction ID: the duplicate transaction ID.
- Changed At: current timestamp as a date/time value.
- Target Table: Transaction Log.
- Actor: Gemini-assisted human review.
- Field: Review Reason.
- Old Value / New Value: exact before/after text.
- Reason: human-confirmed survivor mapping based on the source evidence described above.
- Request ID: GEMINI-LEGACY-DUPLICATE-MAP-20261031.

After making only the four Review Reason updates and their four append-only Change Log audit rows, report exact cells and before/after text. Do not run Apps Script archive migration; the owner will review the preview and run it separately.
~~~
