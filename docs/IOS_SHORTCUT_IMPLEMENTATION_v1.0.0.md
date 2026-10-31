# PFIS v1.0.0 — iOS Shortcut Implementation

This document describes the mobile capture client. It is a build/maintenance guide, not an exported Apple Shortcut package.

## Responsibility boundary

- iOS Shortcut: capture, AI extraction, HTTP request and user receipt.
- Apps Script: validation, replay protection, reconciliation, Rules/Config resolution, ledger writes and audit.
- Google Sheets: canonical financial data and evidence.
- Gemini: optional separate workbook assistant; it is not called by this Shortcut or Apps Script.

## End-to-end flow

1. Receive or share a complete bank SMS/email.
2. Preserve the full original message as <code>originalText</code>.
3. Run the transaction extraction prompt.
4. If the result is exactly <code>IGNORE</code>, stop because the message is not a completed financial event.
5. Otherwise validate that the result contains exactly ten fields and nine pipe delimiters.
6. Read the device lock state. If the Shortcut defers interactive review because the device is locked, map that Boolean to <code>isReviewNeeded</code>. Do not send the old <code>deviceLocked</code> key.
7. POST the JSON request to the Apps Script Web App.
8. Read <code>success</code>, <code>status</code>, <code>nextAction</code>, <code>transaction</code>, <code>displayText</code> and <code>requestId</code>.
9. Route the response using <code>nextAction</code>.
10. If the backend explicitly requests category classification, run the category prompt, validate the exact answer against <code>allowedCategories</code>, and send one update only when valid.
11. Show the final backend receipt or review/error message.

Purpose/User Notes is optional. Do not create an ASK_PURPOSE step and do not block a receipt because Purpose is blank.

## Ten-field transaction contract

The exact order is:

<code>datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after</code>

| Position | Field | Requirement |
|---:|---|---|
| 1 | datetime | Actual event date/time. Use date-only form when no clock time exists. |
| 2 | signed_amount | Debits/outflows negative; credits/inflows positive; two decimals. |
| 3 | bank | Institution associated with the event. Do not invent it. |
| 4 | account_type | Savings/current/credit card/wallet/etc.; optional when unknown. |
| 5 | instrument | UPI/card/NEFT/IMPS/net banking/etc.; optional when unknown. |
| 6 | type | expense/income/card_payment/investment/transfer/refund, or unresolved. |
| 7 | merchant_name | Supported merchant, biller or readable event description. |
| 8 | counterparty | Explicit sender/recipient when available. |
| 9 | ref_no | Explicit UTR/RRN/order/reference only. |
| 10 | balance_after | Actual post-transaction balance only; otherwise absent. |

The parser preserves empty positions when delimiters are present. Unknown optional fields should normally be represented as <code>NA</code>. Never remove a delimiter to represent a missing middle value. Never put a literal pipe character inside a field. Do not guess which field was omitted or shift values to repair a malformed payload.

The backend requires a trustworthy date, non-zero amount and bank. An unresolved type/category can be handled as a review/classification case; an unsafe date, amount or bank should remain a Source Log parse failure rather than a fabricated ledger row.

## HTTP request

Use Apple's **Get Contents of URL** action:

- URL: deployed Apps Script Web App URL ending in <code>/exec</code>
- Method: POST
- Request Body: JSON
- Header: <code>Content-Type: application/json</code>

Illustrative request; every value below is fictional:

~~~json
{
  "action": "ingest",
  "sourceType": "SMS",
  "txnString": "14/10/2026 09:15:00|-845.50|Demo Bank|Savings Account|UPI|expense|Harbor Coffee|Harbor Coffee|DEMO-UTR-1001|NA",
  "originalText": "DEMO BANK: INR 845.50 debited at Harbor Coffee on 14/10/2026 at 09:15. Ref DEMO-UTR-1001.",
  "sender": "DEMO BANK",
  "requestId": "SHORTCUT-DEMO-001",
  "isReviewNeeded": false
}
~~~

For email, set <code>sourceType</code> to <code>EMAIL</code> and include sender/subject when available. Do not replace <code>originalText</code> with an AI summary.

### isReviewNeeded Boolean

<code>isReviewNeeded</code> is semantic intent: the capture client is explicitly saying that interactive review was deferred and a human review case must remain open.

- Send actual JSON Boolean <code>true</code> only when the Shortcut intentionally defers interactive review (for example, the device is locked and the user cannot review the transaction at capture time).
- Omit it or send actual Boolean <code>false</code> for normal capture.
- Never send it as the string <code>"true"</code> or <code>"false"</code>.
- Never send the deprecated <code>deviceLocked</code> field.
- Sending false does not clear a review already recorded by the backend.
- For a source parse failure, true is recorded as source-only review intent; it does not invent a Transaction Log row.

The screenshots/build should therefore map the output of **Get Device Is Locked** to a Boolean variable named <code>isReviewNeeded</code>, and map that variable to the JSON key of the same name.

If <code>WEB_APP_SECRET</code> is enabled in Script Properties, include the matching <code>token</code> value in the request body. Never place the secret in this repository, prompt text or a public example.

## Response routing

Use <code>nextAction</code> as the primary router.

| nextAction | Shortcut action |
|---|---|
| <code>SHOW_RECEIPT</code> | Display date/time, merchant, signed amount, category, account/card label, evidence status and Transaction ID. |
| <code>CLASSIFY_CATEGORY</code> | Run the category prompt using current context and exact <code>allowedCategories</code>. Validate exact membership before sending one update. |
| <code>REVIEW</code> | Show review reason and validation flag. Do not auto-approve, archive, delete or rewrite financial facts. |
| <code>SHOW_ERROR</code> | Show error/message and <code>requestId</code>. Never show a success receipt. |

A marked automatic Miscellaneous fallback can require category classification even though it is not itself a financial-integrity review. Keep these distinct: <code>needsReview</code> is not the same as <code>requiresCategoryClassification</code>.

## Controlled human resolutions

These are deliberate review actions, not automatic Shortcut steps.

Confirm a genuine distinct transaction:

~~~json
{
  "action": "resolveexception",
  "transactionId": "DEMO-TX-031",
  "resolution": "CONFIRM_DISTINCT",
  "reason": "Verified against the original bank notification",
  "actor": "user"
}
~~~

Confirm a duplicate only when a surviving canonical transaction is known:

~~~json
{
  "action": "resolveexception",
  "transactionId": "DEMO-TX-032",
  "resolution": "CONFIRM_DUPLICATE",
  "duplicateOf": "DEMO-TX-031",
  "reason": "Both source records describe the same payment",
  "actor": "user"
}
~~~

Reject an incorrect/unwanted canonical transaction without claiming it is a duplicate:

~~~json
{
  "action": "resolveexception",
  "transactionId": "DEMO-TX-033",
  "resolution": "REJECT_TRANSACTION",
  "reason": "Incorrect transaction extracted from the source alert",
  "actor": "user"
}
~~~

A human reason of at least eight characters is required. <code>CONFIRM_DUPLICATE</code> requires the surviving <code>duplicateOf</code> Transaction ID. Never merge or reject records on amount/date similarity alone.

## Retry and failure handling

If the HTTP action times out:

- Do not assume the request failed or succeeded.
- Retry the exact same original <code>txnString</code> and <code>originalText</code>; do not modify financial facts to force success.
- Keep the same correlation <code>requestId</code> when replaying the same request.
- If a Transaction ID is known, use <code>gettransaction</code> before deciding to retry.
- Source hashing/idempotency is intended to prevent exact retries from inserting another transaction.
- Preserve the returned error and requestId for investigation.

## Receipt and privacy

A normal receipt should show only the information needed to recognise the event: date/time, merchant, signed amount, category, friendly account/card label, verification status and Transaction ID.

Do not place full account/card numbers, raw bank messages, tokens or unnecessary source evidence in push notifications.

## Deployment note

After changing Apps Script, run <code>PFIS_VALIDATE()</code> and the preflight suite in a safe environment, then deploy a **new Web App version** and update the Shortcut's <code>/exec</code> URL. Saving source code does not update an existing versioned deployment.
