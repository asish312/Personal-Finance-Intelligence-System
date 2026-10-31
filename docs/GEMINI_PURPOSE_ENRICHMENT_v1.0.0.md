# PFIS v1.0.0 — Optional Gemini Purpose Enrichment

This is an optional workflow. It is not required for transaction capture, and blank Purpose/User Notes is valid.

## Design

Gemini may read recent canonical transactions and their linked Source Log evidence, then append factual proposals to a separate <code>Purpose Review Queue</code>. A human must approve a suggestion. Apps Script applies only approved suggestions through the normal update/audit pipeline.

Gemini must never write directly to Transaction Log.

## Three distinct mechanisms

| Mechanism | What it does | When it runs |
|---|---|---|
| Rule-generated Purpose | Uses an expressly trusted Rule template/trigger | During Apps Script ingestion/reconciliation |
| Gemini suggestion | Proposes a short factual Purpose based on linked source evidence | Daily Gemini Task, if configured |
| Approved suggestion application | Validates and applies a human-approved queue row | Manually or via Apps Script time-driven trigger |

Do not mix these responsibilities. The Shortcut must not ask for Purpose.

## Optional queue schema

If this workflow is enabled, create a sheet named <code>Purpose Review Queue</code> with these exact headers:

<code>Suggestion ID | Transaction ID | Transaction Date | Merchant | Amount | Category | Type | Suggested Purpose | Evidence Summary | Evidence Source IDs | Confidence | Status | Gemini Run At | Reviewed By | Reviewed At | Applied At | Apply Result</code>

Statuses:

- <code>SUGGESTED</code>: Gemini proposal only; no ledger value has changed.
- <code>APPROVED</code>: a human reviewed the original evidence and authorised application.
- <code>REJECTED</code>: a human declined the suggestion.
- <code>NEEDS_MORE_EVIDENCE</code>: insufficient evidence; do not apply.
- <code>APPLIED</code>: Apps Script applied the Purpose through the update pipeline.
- <code>STALE</code>, <code>BLOCKED</code>, <code>BLOCKED_REVIEW</code>, <code>BLOCKED_INVALID_PURPOSE</code>, <code>APPLY_ERROR</code>: application could not safely proceed.

A confidence score is context only. It is not an approval signal.

## Candidate rules

Gemini should inspect only recent transactions, normally the previous seven calendar days, where:

- Purpose/User Notes is blank.
- Category and Type are present and valid.
- Needs Review is not TRUE and Review Status is not Pending.
- Validation Flag is not a duplicate, source conflict or rejected state.
- At least one non-superseded Source Log row is linked to the exact Transaction ID.
- The source message explicitly supports the suggested purpose.

Skip archived transactions and source statuses such as SUPERSEDED, PARSE_FAILED, CONFLICT and REJECTED. Do not infer intent from a merchant, amount, category or recipient alone.

## Purpose quality

Use a short, neutral, factual phrase (normally 3–8 words), such as "Monthly electricity bill" or "Credit card bill settlement", only when the original notification supports it.

Do not infer:
- why someone bought an item;
- whether a purchase was essential or discretionary;
- order contents from a generic marketplace or payment processor;
- a personal relationship or motive from a transfer recipient;
- salary purpose from a generic credit alert.

If evidence is weak or ambiguous, skip the transaction entirely.

The Evidence Summary should briefly identify the supporting source detail. Store linked Source IDs, not copied full messages. Do not copy account/card numbers, balances, OTPs, phone numbers or full references into the queue.

## Daily Gemini Task prompt

Create a Task in the owner's Gemini account only if the connected-app/Task feature is available. Run it manually once and confirm a real queue row appears before relying on a schedule.

~~~text
You are the PFIS daily Purpose suggestion assistant.

Use the connected PFIS Google Sheets workbook. Read Transaction Log and Source Log. Write proposals ONLY to Purpose Review Queue.

OBJECTIVE
Find transactions from the previous 7 calendar days where User Notes/Purpose is blank. Suggest a concise Purpose only when the linked original SMS/email evidence explicitly supports it.

ELIGIBILITY
- Purpose is blank.
- Category and Type are present and valid.
- Needs Review is not TRUE; Review Status is not Pending.
- Validation Flag is not DUPLICATE_CANDIDATE, DUPLICATE_REJECTED, SOURCE_CONFLICT or REJECTED.
- The transaction is active, not archived.
- At least one non-superseded Source Log row is linked to the exact Transaction ID.
- Ignore source records with status SUPERSEDED, PARSE_FAILED, CONFLICT or REJECTED.

EVIDENCE
Read only the relevant source text. Do not infer personal intent from merchant, amount, category or recipient alone. Do not invent details or ask the user questions. Skip weak or ambiguous evidence.

PURPOSE FORMAT
Use a short, neutral, factual phrase (normally 3–8 words). Do not repeat the merchant name as Purpose. Do not state a personal motive or judge whether spending was necessary.

SALARY
Do not generate or rewrite salary Purpose. Trusted salary Purpose is handled by Apps Script Rules using the transaction date and configured calendar scope.

WRITE RULES
- Do not edit Transaction Log, Source Log, Change Log, Rules, Config, Categories or archived records.
- Do not approve suggestions.
- Do not clear or overwrite existing values.
- Append to Purpose Review Queue only, using the exact 17-column schema.
- Suggestion ID should be deterministic, for example PURPOSE- plus Transaction ID.
- Add no more than one suggestion per Transaction ID.
- Scan the queue first; skip any Transaction ID already present in any status.
- Set Status=SUGGESTED and Gemini Run At to the current run timestamp.
- Leave Reviewed By, Reviewed At, Applied At and Apply Result blank.
- Store a concise Evidence Summary and linked Source ID(s), comma-separated.
- Confidence is a model estimate, not approval.

REPORT
Report eligible records inspected, suggestions added, skipped for insufficient evidence, skipped for review/conflict state, already present in the queue, and errors.

Never claim a suggestion was saved unless the row is visible in Purpose Review Queue. If Google requires confirmation to edit the workbook, request confirmation and do not claim the write is complete.
~~~

## Human approval and application

1. Open the linked original Source Log evidence.
2. Check that the proposed phrase is factual.
3. Set Status to <code>APPROVED</code>.
4. Fill <code>Reviewed By</code> and <code>Reviewed At</code>.
5. Run <code>PFIS_APPLY_APPROVED_PURPOSE_SUGGESTIONS()</code> manually or by a time-driven trigger.

The Apps Script function validates the queue headers, reviewer fields, source-to-transaction links, current transaction state and whether Purpose is still blank. It then routes the change through the normal update function and Change Log. A trigger must apply approved rows only; it must never approve them automatically.

If the optional sheet does not exist, the rest of PFIS still works. This workflow must remain optional.
