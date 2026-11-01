# PFIS v1.0.0 — iOS Shortcut Implementation

This document describes the mobile capture client. It is a build/maintenance guide, not an exported Apple Shortcut package.

## Responsibility boundary

- iOS Shortcut: capture, AI extraction, HTTP request and user receipt.
- Apps Script: validation, replay protection, reconciliation, Rules/Config resolution, ledger writes and audit.
- Google Sheets: canonical financial data and evidence.
- Gemini: optional separate workbook assistant; it is not called by this Shortcut or Apps Script.

## End-to-end flow

1. Receive or share a complete bank SMS/email.
2. Preserve the full original message as <code>originalText</code> and capture metadata separately.
3. Set <code>receivedAt</code> only when the trigger exposes the original SMS/email delivery time; set <code>capturedAt</code> to the Shortcut's current date/time.
4. Run the transaction extraction prompt with <code>SOURCE_TYPE</code>, <code>RECEIVED_AT</code>, <code>CAPTURED_AT</code> and the complete original message.
4. If the result is exactly <code>IGNORE</code>, stop because the message is not a completed financial event.
5. Otherwise validate that new results contain exactly twelve fields and eleven pipe delimiters. The backend temporarily accepts legacy ten-field results, but new Shortcuts must use twelve fields.
6. Read the device lock state. If the Shortcut defers interactive review because the device is locked, map that Boolean to <code>isReviewNeeded</code>. Do not send the old <code>deviceLocked</code> key.
7. POST the JSON request to the Apps Script Web App.
8. Read <code>success</code>, <code>status</code>, <code>nextAction</code>, <code>transaction</code>, <code>displayText</code> and <code>requestId</code>.
9. Route the response using <code>nextAction</code>.
10. If the backend requests category classification, run the category prompt, validate the exact answer against <code>allowedCategories</code>, and send one update only when valid.
11. If the backend returns <code>ASK_PURPOSE</code>, ask the user for a short factual purpose. Do not ask an AI model to invent it. Save the user's answer with one <code>action=update</code> request.
12. Show the final backend receipt or review/error message.

Purpose collection is backend-directed: ask for every expense whose User Notes/Purpose is still blank, including unmatched merchants, merchant-only fallback matches and recognised merchants with no trusted Purpose (the user may have made a different purchase). A direct rule match alone does not suppress the question; only an explicitly trusted rule-generated Purpose does. There is no amount threshold. Do not ask for income, investment, transfer or card-bill settlement entries. Category classification and serious source/duplicate/type conflicts take priority. A separate account-mapping review may remain open while the user supplies Purpose; saving Purpose must not clear that review.

## Twelve-field transaction contract

New Shortcut output uses exactly twelve fields in this order:

<code>datetime | signed_amount | bank | account_type | account_alias | instrument | type | merchant_name | counterparty | ref_no | balance_after | datetime_basis</code>

| Position | Field | Requirement |
|---:|---|---|
| 1 | datetime | Actual transaction date/time where supplied. For missing event time, use original receipt time or capture time only as a labelled fallback. |
| 2 | signed_amount | Debits/outflows negative; credits/inflows positive; two decimals. |
| 3 | bank | Institution associated with the event. |
| 4 | account_type | Savings/current/credit card/wallet/cash, where supported. |
| 5 | account_alias | Exact source-visible account/card product label such as SBI_CASHBACK_CC; otherwise NA. |
| 6 | instrument | UPI/card/NEFT/IMPS/net banking/etc.; otherwise NA. |
| 7 | type | expense/income/card_payment/investment/transfer/refund/NA. |
| 8 | merchant_name | Supported merchant, biller or readable event descriptor. |
| 9 | counterparty | Explicit sender/recipient/merchant where available. |
| 10 | ref_no | Explicit UTR/RRN/order/reference only when provided. |
| 11 | balance_after | Actual post-transaction balance only; otherwise NA. |
| 12 | datetime_basis | TRANSACTION_TIME, RECEIVED_TIME_FALLBACK, CAPTURED_TIME_FALLBACK or DATE_ONLY. |

### Timestamp metadata and fallback rules

Send these metadata properties in the HTTP request and include them in the AI input envelope:

- <code>receivedAt</code>: original SMS/email delivery timestamp, only when the automation/email trigger genuinely exposes it. Use ISO 8601 with an explicit timezone offset, preferably <code>+05:30</code>. Never substitute the Shortcut's current time.
- <code>capturedAt</code>: time the Shortcut processed or shared the message. Populate from **Current Date** every time, formatted as ISO 8601 with timezone offset.
- <code>originalText</code>: the complete unmodified message body. Keep email subject/sender in their own request fields when available.

Priority:
1. Explicit transaction time in original message → <code>TRANSACTION_TIME</code>.
2. Transaction date but no clock time + original message <code>receivedAt</code> → combine the transaction date with the receipt clock and mark <code>RECEIVED_TIME_FALLBACK</code>.
3. No <code>receivedAt</code> + <code>capturedAt</code> → combine transaction date with capture clock and mark <code>CAPTURED_TIME_FALLBACK</code>.
4. No clock metadata → keep date-only and mark <code>DATE_ONLY</code>.

When transaction date is absent, use the full receipt timestamp, or capture timestamp only when receipt time is unavailable. Never use the receipt/capture date to replace an explicitly stated, different transaction date.

Important distinctions:
- An SMS automation trigger's **Date** may be used as <code>receivedAt</code> only after confirming it is the notification delivery timestamp, not merely processing time.
- A manually shared SMS usually does not expose its original delivery time through the shared message text. Do not claim it does; use <code>capturedAt</code> as the last-resort fallback.
- The same limitation can apply to shared emails. Use the message's actual received date only when the share/automation action exposes it.
- A fallback timestamp is useful for sorting and timeline display, but it is not an exact transaction time. The backend records it as imprecise and excludes it from exact-time duplicate matching.

Standardized AI input envelope:

~~~text
SOURCE_TYPE: SMS
RECEIVED_AT: 2026-10-18T10:16:36+05:30
CAPTURED_AT: 2026-10-18T10:17:02+05:30
ORIGINAL MESSAGE:
[complete original SMS/email]
~~~

The parser also accepts legacy ten-field payloads during rollout. Legacy fields are mapped using the previous order and account_alias is left blank. Do not produce new ten-field results.

Unknown optional fields use <code>NA</code>; preserve every delimiter. Never put a literal pipe inside a field or guess which field was omitted. The backend still requires a trustworthy date, non-zero amount and bank. A real transaction with an unknown date remains a source-only parse failure until corrected; it must not be fabricated or ignored.

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
  "txnString": "2026-10-18 10:16:36|-150.00|Axis|Savings Account|NA|UPI|transfer|DEMO PERSON|DEMO PERSON|DEMO-UTR-0001|NA|TRANSACTION_TIME",
  "originalText": "Axis Bank: INR 150.00 debited by UPI on 18/10/26 at 10:16:36. DEMO PERSON. Ref DEMO-UTR-0001.",
  "receivedAt": "2026-10-18T10:16:36+05:30",
  "capturedAt": "2026-10-18T10:17:02+05:30",
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
| <code>ASK_PURPOSE</code> | Ask the user what the unmatched/different expense was for. Save only the user's answer through <code>action=update</code> with <code>purpose</code>, <code>transactionId</code>, <code>actor</code> and <code>reason</code>. |
| <code>REVIEW</code> | Show review reason and validation flag. Do not auto-approve, archive, delete or rewrite financial facts. |
| <code>SHOW_ERROR</code> | Show error/message and <code>requestId</code>. Never show a success receipt. |

A marked automatic Miscellaneous fallback can require category classification even though it is not itself a financial-integrity review. Keep these distinct: <code>needsReview</code>, <code>requiresCategoryClassification</code> and <code>requiresPurpose</code> are separate states. If category classification is required, do it before purpose collection. An <code>ASK_PURPOSE</code> response is not a review flag.

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
