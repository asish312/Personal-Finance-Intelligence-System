<div align="center">

# PFIS · Personal Finance Intelligence System

### One notification. One traceable record. One clearer financial picture.

**Capture → Reconcile → Classify → Review → Understand → Plan**

A personal-finance workflow built with Google Apps Script, Google Sheets, iOS Shortcuts and an optional Gemini-assisted enrichment layer.

**Production contract: v1.0.0** · Google Apps Script · Google Sheets

<sub>Every illustration, merchant, amount and transaction ID in this README is fictional. No live workbook figures or personal account details are reproduced.</sub>

</div>

---

## Start here

PFIS is designed to answer six questions:

1. **What happened?** Capture the original bank SMS/email and extract the transaction facts.
2. **Is it a new event?** Reconcile the alert against existing evidence so repeated notifications do not become repeated expenses.
3. **What does it mean?** Use Categories, Config and Rules to resolve account, category and transaction type.
4. **Does a person need to decide?** Route genuine uncertainty into a review process rather than silently guessing.
5. **What does it tell me?** Analyse cash flow, consumption, commitments, anomalies and data quality.
6. **What should happen next?** Allocate income to a budget month and distinguish planned savings from verified transfers.

### The complete journey

~~~mermaid
flowchart TD
  A["Bank SMS / Email"] --> B["iOS Shortcut"]
  B --> C["AI extraction prompt"]
  C --> D["Apps Script Web App"]
  D --> E["Validate + normalise"]
  E --> F["Categories + Config + Rules"]
  F --> G{"Evidence match"}
  G -->|"Exact replay / strong match"| H["Link source to existing transaction"]
  G -->|"New valid event"| I["Transaction Log"]
  G -->|"Ambiguous / incomplete"| J["Review case"]
  H --> K["Source Log"]
  I --> K
  J --> K
  I --> L["Change Log"]
  K --> M["Google Sheets UI + analytics"]
  L --> M
  I --> M
  N["Daily Gemini Task"] --> O["Purpose Review Queue"]
  K --> N
  O --> P["Human approval"]
  P --> Q["Audited Apps Script update"]
  Q --> I
~~~

The production engine is the deterministic transaction processor. Gemini is an optional, separately configured assistant; it is not called by the Apps Script runtime.

## What a new user actually sees

PFIS has three user-facing surfaces and one backend service.

| Surface | Role | What it is for |
|---|---|---|
| **Google Sheets workbook** | Main financial workspace | Dashboard, ledger, monthly summary, configuration, evidence, reviews and reports |
| **iOS Shortcut** | Mobile capture and receipt UI | Share/run a bank notification, submit it, and show a receipt, review warning or error |
| **Gemini** | Optional assistant | Daily factual Purpose suggestions and workbook authoring when connected by the owner |
| **Apps Script Web App** | Backend JSON API | Validation, ingestion, matching, ledger updates, audit and analytics data |

**Important UI boundary:** this repository does not contain a custom HTML/CSS dashboard frontend. The primary financial UI is the Google Sheets workbook. Apps Script is a JSON endpoint, not a browser dashboard.

### Workbook navigation

| Workbook sheet | What a person uses it for |
|---|---|
| Dashboard | High-level financial picture and trends |
| Recent Transactions | Latest canonical transaction rows; this should be a read-only dynamic view |
| Transaction Log | Canonical ledger; every accepted financial event has one Transaction ID |
| Monthly Summary | Actual receipt month and budget allocation month |
| Insights & Data Quality | Integrity exceptions, missing classifications and data-quality signals |
| Review Queue | **Target single inbox** for every unresolved transaction/source issue |
| Purpose Review Queue | Optional Gemini suggestions awaiting human approval; not a financial integrity queue |
| Savings Sweep Log | Planned versus verified savings transfers |
| Categories | Approved category vocabulary |
| Config | Bank, account, card and instrument mapping |
| Rules | Merchant/amount matching and classification rules |
| Holiday Calendar | Verified working-day overrides |
| Source Log | Original notifications, hashes, parse states and source links |
| Change Log | Who changed what, when and why |
| Rejected & Archive Log | Explicitly rejected/archived records, retaining history |
| Dashboard_Calc | Calculation helper ranges, not a normal editing surface |
| Reports | Detailed analysis |
| Data Dictionary | Column and KPI definitions |
| PFIS System Guide | Workbook usage guidance |

### The intended three-place data lifecycle

Keep three responsibilities separate:

| Stage | One responsibility | Contents |
|---|---|---|
| **01 · Transaction Log** | One canonical insertion area | Accepted transactions and provisional items with valid minimum financial facts |
| **02 · Review Queue** | One human decision inbox | Duplicates, conflicts, parse failures, missing category and unresolved mapping |
| **03 · Rejected & Archive Log** | One resolved archive | Confirmed duplicates and rejected/archived cases, never silently deleted |

**Current implementation gap:** the engine currently returns transaction review cases and source conflicts from <code>getpendingreview</code>, but does not include <code>PARSE_FAILED</code> source rows. Category enrichment is still exposed separately by <code>getneedsenrichment</code>. The workbook must not imply these are already one fully unified inbox. The long-term design is one Review Queue view keyed by a unique Case ID, aggregating transaction-level and source-level cases without copying or double-counting the underlying records.

Do not put every blank optional field into this queue. Blank Purpose is valid. A review case must represent an unresolved decision or failed invariant.

---

## Follow one transaction

Imagine a fictional alert:

> DEMO BANK: INR 845.50 debited at Harbor Coffee. Reference DEMO-UTR-1001.

| Stage | PFIS action | Result |
|---|---|---|
| Capture | Shortcut retains the full original message | Original evidence is preserved |
| Parse | AI extraction returns ten structured fields | A consistent transaction payload |
| Validate | Apps Script checks date, non-zero amount, bank and field structure | Malformed payloads do not contaminate the canonical ledger |
| Configure | Rules and Config resolve type, category, merchant and account | Repeatable classification |
| Reconcile | Exact replay, cross-channel and payment-event matchers inspect existing evidence | One event can have several supporting notifications |
| Store | A new row is inserted or source evidence is linked to an existing row | One canonical event |
| Audit | Change Log records supported system/user changes | Explainable corrections |
| Report | Workbook formulas and charts consume the ledger | Financial analysis |

### The ten-field transaction contract

The Shortcut sends the following <code>txnString</code> fields in this exact order:

~~~text
datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after
~~~

| Field | Rule |
|---|---|
| datetime | Actual transaction date/time. Keep date-only precision when the source has no clock time. |
| signed_amount | Numeric, two decimals. Debits/outflows negative; credits/inflows positive. |
| bank | Financial institution identified by the alert |
| account_type | Savings, current, credit card, wallet, etc.; optional if unknown |
| instrument | UPI, card, NEFT, IMPS, net banking, auto debit, etc.; optional if unknown |
| type | expense, income, card_payment, investment, transfer, refund or unresolved |
| merchant_name | Merchant, biller or readable event descriptor |
| counterparty | Sender/recipient where the source identifies one |
| ref_no | UTR/RRN/order/reference number only when explicitly provided |
| balance_after | Actual post-transaction account balance only; otherwise blank/NA |

Do not use an available balance, credit limit, statement balance or minimum due as the transaction amount. Do not use the SMS/email arrival time as the transaction time. Do not shift fields to compensate for a missing middle value.

### What if the parser cannot produce all fields?

A malformed parse should not be silently discarded. The current engine already stores the original source text and a <code>PARSE_FAILED</code> Source Log row, with a source ID and error reason. It does not create a canonical Transaction Log row when required facts are absent.

That is the correct separation of evidence and ledger, but the review surface is incomplete: <code>getpendingreview</code> currently excludes <code>PARSE_FAILED</code>. A production-safe long-term flow is:

1. Preserve the raw source, hash, sender, received time, parser version and parser error in Source Log.
2. Add a source-level review case to the one Review Queue.
3. Attempt deterministic recovery only for supported bank templates.
4. Create a provisional ledger transaction only when date, non-zero amount and bank are independently safe. Keep uncertain type/category/merchant fields blank or use an explicitly configured fallback and flag the record for review.
5. If date, amount or bank cannot be trusted, keep it as a source-only case until corrected.
6. On human correction, reprocess the exact original source and retain the original parse-failure history as superseded/audited evidence.

This avoids two bad extremes: silently losing a real payment, or inserting invented financial facts just to satisfy a ten-field parser contract.

### Duplicate and multi-notification policy

These are distinct cases:

| Case | Correct behaviour |
|---|---|
| Exact same source replay | Return the existing result; no second transaction |
| SMS and email for one payment | Link both sources to one canonical event when evidence is strong |
| Issuer confirmation and bank debit for one card payment | One financial event with corroborating source evidence, where the payment-event match is unique |
| Same amount and same date but different reference/account | Do not auto-merge; create a review case |
| Similar merchant/amount inside a time window | Review candidate unless the full identity evidence is strong |
| Confirmed duplicate | Archive only after explicit human confirmation and a surviving Transaction ID is identified |

A duplicate candidate is not a duplicate decision. The engine supports <code>CONFIRM_DISTINCT</code> and <code>CONFIRM_DUPLICATE</code>. The latter requires a human reason and <code>duplicateOf</code> canonical Transaction ID. Archive handling preserves auxiliary columns, relinks source evidence and writes audit history.

### Example: UPI payment to a card issuer

A savings-account debit to a credit-card issuer is normally a **card bill settlement**, not an ordinary merchant purchase.

Use this classification when the alert clearly identifies a credit-card bill payment:

| Field | Example |
|---|---|
| Amount | −₹41,091.74 (fictional example) |
| Bank | Axis |
| Account Type | Savings Account |
| Instrument | UPI |
| Type | <code>card_payment</code> |
| Merchant / Counterparty | SBI Cards and Payment Services |
| Category | Credit card payments |
| Purpose | Credit card bill payment, if supported by a rule or later approved evidence |

Do not label it as an ordinary expense merely because money left the savings account. The source debit is the cash-flow settlement. The issuer's confirmation is evidence that the payment reached the card; it must not become a second cash outflow or consumption expense.

The matching rule must be strong enough to distinguish the intended card and settlement. A merchant alias alone is not enough if multiple cards, amounts or payment dates could match.

---

## Purpose: exactly when it appears and when it does not

Purpose is a description of the transaction's evidenced intent. It is not a mandatory field and must not become a gate to recording financial facts.

### Immediate rule-generated Purpose

Purpose is populated during Apps Script ingestion/reconciliation only when a trusted rule explicitly permits it:

- <code>Auto Purpose = TRUE</code> and the rule provides a meaningful Notes Template; **or**
- a supported <code>Purpose Trigger</code> is satisfied using the transaction's own date and configured calendar.

Recurrence alone is not permission to invent a purpose.

| Situation | Purpose result |
|---|---|
| Rule says Auto Purpose TRUE and template is meaningful | Write the configured Purpose |
| Auto Purpose FALSE and no trigger | Leave Purpose blank |
| Auto Purpose FALSE and LAST_WORKING_DAY_OF_MONTH is satisfied | Write the configured rule Purpose |
| Missing/blank/ambiguous category | Category review/fallback; Purpose remains optional |
| Parser cannot identify merchant or transaction purpose | Do not invent it |
| User has not supplied personal context | Do not ask during normal capture |
| Gemini finds explicit evidence later | Write a suggestion to Purpose Review Queue, not directly to Transaction Log |

### Salary example: earned month versus budget month

For a generic employer salary received on the last working day of October but intended to fund November:

| Rules field | Value |
|---|---|
| Match Type | MERCHANT |
| Merchant Contains | Example Employer |
| Category | Income |
| Merchant Override | Employer Payroll |
| Notes Template | Salary from Example Employer for {{monthLabel}} |
| Month Offset (H) | 0 |
| Is Recurring | TRUE |
| Type Override | income |
| Auto Purpose (T) | FALSE |
| Purpose Trigger (U) | LAST_WORKING_DAY_OF_MONTH |
| Calendar Scope (V) | EMPLOYER_DEMO |
| Budget Month Offset (W) | 1 |

The resulting periods are deliberately different:

| Concept | Example |
|---|---|
| Transaction Date | 30-Oct-2026 |
| Purpose | Salary from Example Employer for Oct-26 |
| Income Month | Oct-26 |
| Budget Month | Nov-26 |

**Month Offset (H)** controls the month label in the Notes Template. **Budget Month Offset (W)** controls the budget period. They must not be conflated.

### Daily Gemini Purpose enrichment

For transactions that remain blank after deterministic rules, Gemini can prepare a daily suggestion:

~~~mermaid
flowchart TD
  A["Recent transaction with blank Purpose"] --> C["Gemini Task reads linked Source Log"]
  B["Original bank alert"] --> C
  C --> D["Purpose Review Queue: SUGGESTED"]
  D --> E{"Human checks original evidence"}
  E -->|"Not supported"| F["REJECTED / NEEDS_MORE_EVIDENCE"]
  E -->|"Approved"| G["APPROVED + reviewer + timestamp"]
  G --> H["PFIS_APPLY_APPROVED_PURPOSE_SUGGESTIONS()"]
  H --> I["Transaction Log updated via normal API"]
  I --> J["Change Log audit"]
~~~

Gemini must:
- look only at recent transactions with blank Purpose;
- read the original linked Source Log evidence;
- propose a short, factual description supported by the alert;
- skip generic merchants and ambiguous notifications;
- never infer why a person spent money;
- never edit Transaction Log directly;
- write only <code>SUGGESTED</code> rows;
- never approve its own suggestions or overwrite an existing Purpose.

A human reviewer inspects the source and fills <code>APPROVED</code>, <code>Reviewed By</code> and <code>Reviewed At</code>. Apps Script then verifies the source-to-transaction link, source status, blank current Purpose and absence of unresolved duplicate/source conflict before applying the update through the normal audit pipeline.

The engine contains <code>PFIS_APPLY_APPROVED_PURPOSE_SUGGESTIONS()</code>. It does not call Gemini and does not create suggestions. It applies approved queue items only.

---

## Configuration: how PFIS learns your environment

The four configuration layers have separate responsibilities.

<p align="center">
  <a href="https://github.com/asish312/Personal-Finance-Intelligence-System/blob/main/docs/images/pfis-configuration-journey.svg"><img src="https://raw.githubusercontent.com/asish312/Personal-Finance-Intelligence-System/main/docs/images/pfis-configuration-journey.svg" alt="Configuration architecture: Categories, Config, Rules and Holiday Calendar" width="100%"/></a>
</p>

### Categories — allowed labels

Keep the list short, mutually understandable and active. Example groups include Income, Housing & Utilities, Food & Dining, Transport, Shopping, Investments, Debt Service and Miscellaneous.

If a category is blank or unmapped:
- use active <code>Miscellaneous</code> as a safe fallback when configured;
- otherwise keep the transaction flagged for category classification;
- do not reject an otherwise valid transaction solely because a category label is missing.

### Config — resolve accounts and cards

Core fields A:I:

| Field | Meaning |
|---|---|
| Bank | Normalised provider |
| Account Type | Savings, credit card, wallet, etc. |
| Account/Card Suffix | Only source-visible identifying suffix |
| Merchant Contains | Optional merchant-specific qualifier |
| Account | Friendly account alias |
| Card Name | Friendly card label |
| Instrument | UPI, card, net banking etc. |
| Is Internal | Whether this is an owned account used for an internal transfer |
| Priority | Tie-break only after specificity |

Optional J: <code>Text Pattern</code>.

Do not store full account/card numbers. Do not let priority guess a card when the alert does not identify it. Mark <code>Is Internal</code> only for accounts genuinely owned by the same person; card bill payments are liability settlements, not automatically internal transfers.

### Rules — classify repeated patterns

Supported match types:
- <code>MERCHANT</code>
- <code>AMOUNT</code>
- <code>AMOUNT+MERCHANT</code>

The core Rules schema is A:M. Extensions include N:S and:
- T: Auto Purpose
- U: Purpose Trigger
- V: Calendar Scope
- W: Budget Month Offset

More-specific rules should win. Equally ranked rules that disagree should remain ambiguous, not be guessed. Do not treat model confidence as calibrated probability unless it is measured and validated.

### Holiday Calendar — working day logic

Exact headers:

<code>Date | Calendar Scope | Is Working Day | Description</code>

Monday–Friday are working days by default; Saturday/Sunday are non-working. A verified scoped override can change a date for <code>EMPLOYER_DEMO</code> or <code>ALL</code>. Do not guess employer holiday dates.

---

## Gemini: connect it, schedule it, keep it in its lane

Gemini has two separate jobs in PFIS:

1. **Daily Purpose Task:** read source evidence and append factual suggestions to Purpose Review Queue.
2. **Spreadsheet authoring:** inspect formulas, improve dashboard layout/charts, label fields and build the zero-based budget/savings-sweep workbook views.

Gemini is **not** called by the production Apps Script or the iOS Shortcut. There is no Gemini API key or Gemini request in the transaction engine.

### Connect Gemini to the workbook

1. Sign in at [Gemini](https://gemini.google.com) using the Google account that can access the PFIS workbook.
2. Open Gemini settings and connect Google Workspace/Sheets under Connected Apps.
3. Confirm Gemini can find and read the intended PFIS workbook.
4. Create a Task (not just a one-off chat) for daily Purpose review.
5. Set the recurring time, for example 8:30 AM Asia/Kolkata.
6. Run it manually once and verify an actual row appears in Purpose Review Queue before relying on the schedule.

Gemini Tasks availability depends on account, plan, age/region, Keep Activity and connected-app permissions. Google documents that edits to shared spreadsheets may require the user to review/confirm proposed changes. A daily schedule is therefore not guaranteed to perform unattended writes in every account/workbook arrangement.

Official references:
- [Gemini Tasks and schedules](https://support.google.com/gemini/answer/17094710)
- [Gemini Workspace actions, including Sheets](https://support.google.com/gemini/answer/17094507)
- [Connect Google Workspace to Gemini](https://support.google.com/gemini/answer/15229592)

### Purpose Review Queue schema

Create the optional sheet with these exact headers:

| Column | Header | Who writes it |
|---|---|---|
| A | Suggestion ID | Gemini |
| B | Transaction ID | Gemini |
| C | Transaction Date | Gemini |
| D | Merchant | Gemini |
| E | Amount | Gemini |
| F | Category | Gemini |
| G | Type | Gemini |
| H | Suggested Purpose | Gemini |
| I | Evidence Summary | Gemini |
| J | Evidence Source IDs | Gemini |
| K | Confidence | Gemini |
| L | Status | Gemini / reviewer / Apps Script |
| M | Gemini Run At | Gemini |
| N | Reviewed By | Human reviewer |
| O | Reviewed At | Human reviewer |
| P | Applied At | Apps Script |
| Q | Apply Result | Apps Script |

Allowed statuses:
- <code>SUGGESTED</code> — proposal only; no ledger change.
- <code>APPROVED</code> — human reviewed original source and authorised application.
- <code>REJECTED</code> — human declined.
- <code>NEEDS_MORE_EVIDENCE</code> — source is insufficient.
- <code>APPLIED</code> — audited update completed.
- <code>STALE</code>, <code>BLOCKED</code>, <code>APPLY_ERROR</code> — the backend refused or could not apply the proposal.

Do not use a confidence number as a substitute for human approval.

### Daily Gemini Task prompt

Copy the following instruction into a Gemini Task and schedule it daily:

~~~text
You are the PFIS daily Purpose enrichment assistant.

Use the connected Google Sheets workbook. Read Transaction Log and Source Log. Write suggestions ONLY to Purpose Review Queue.

OBJECTIVE
Find recent canonical transactions from the previous 7 calendar days where Purpose/User Notes is blank. Propose a short factual Purpose only when the linked original SMS/email evidence explicitly supports it.

CANDIDATE FILTER
- Purpose is blank.
- Category and Type are present.
- Needs Review is not TRUE.
- Review Status is not Pending.
- Validation Flag is not DUPLICATE_CANDIDATE, SOURCE_CONFLICT or DUPLICATE_REJECTED.
- At least one active Source Log row is linked to the exact Transaction ID.
- Ignore SUPERSEDED, PARSE_FAILED and CONFLICT source records.
- Do not process archived transactions.

EVIDENCE STANDARD
Read the relevant source text. Purpose must be directly supported by the alert. Do not infer intent from merchant, amount, category or recipient alone. Do not invent details or ask the user questions. Skip weak or ambiguous evidence.

PURPOSE FORMAT
Use a short, neutral, factual phrase (normally 3–8 words), for example "Monthly electricity bill", "Home grocery purchase" or "Credit card bill settlement" only when the message supports it. Do not repeat the merchant as Purpose. Do not infer a personal motive.

SALARY
Do not generate or rewrite salary Purpose. Trusted salary Purpose is handled by the Apps Script Rules trigger using the transaction date and configured Calendar Scope.

WRITE RULES
- Do not edit Transaction Log, Source Log, Change Log, Rules, Config, Categories or archived rows.
- Do not approve suggestions.
- Do not clear or overwrite an existing value.
- Append to Purpose Review Queue only.
- Use the exact 17-column queue schema.
- Suggestion ID should be deterministic, e.g. PURPOSE- plus Transaction ID.
- One suggestion per Transaction ID.
- Before appending, scan the queue and skip any Transaction ID already present in any status.
- Set Status=SUGGESTED and Gemini Run At to the run timestamp.
- Leave Reviewed By, Reviewed At, Applied At and Apply Result blank.
- Store a concise Evidence Summary and the linked Source ID(s), comma-separated.
- Confidence is context for a reviewer, not an approval signal.

DAILY REPORT
Report eligible records inspected, suggestions added, skipped for insufficient evidence, skipped for review/conflict state, already-present records and errors.

Never claim a suggestion was saved unless it is visible in Purpose Review Queue. If Gemini requires confirmation for a shared workbook edit, request that confirmation and do not claim the write is complete.
~~~

### Approve and apply

1. Open the cited Source Log evidence.
2. Check that the suggested phrase is factual and not inferred.
3. Set Status to <code>APPROVED</code>.
4. Fill <code>Reviewed By</code> and <code>Reviewed At</code>.
5. Run <code>PFIS_APPLY_APPROVED_PURPOSE_SUGGESTIONS()</code>, manually or using an Apps Script time-driven trigger.

The trigger must apply approved rows only. It must never promote SUGGESTED to APPROVED.

---

## iOS Shortcut: mobile capture and routing

The Shortcut is the front door for transaction capture. It should retain the full message, run the extraction prompt, send JSON to the Apps Script endpoint and follow the returned <code>nextAction</code>.

### Capture flow

~~~mermaid
flowchart TD
  A["Share SMS / Email"] --> B["Keep full originalText"]
  B --> C["Run extraction prompt"]
  C --> D{"Parser output"}
  D -->|"IGNORE"| E["Stop: not a completed transaction"]
  D -->|"10 fields"| F["POST JSON to /exec"]
  F --> G{"nextAction"}
  G -->|"SHOW_RECEIPT"| H["Display receipt"]
  G -->|"CLASSIFY_CATEGORY"| I["Run category fallback + validate allowed value"]
  G -->|"REVIEW"| J["Display review reason"]
  G -->|"SHOW_ERROR"| K["Display error + requestId"]
  I --> L["POST one update"]
  L --> H
~~~

The current engine has <code>requiresPurpose=false</code>. The Shortcut must **not** ask <code>ASK_PURPOSE</code> because User Notes is blank. Category fallback is a separate action and only runs when the backend returns <code>CLASSIFY_CATEGORY</code>.

### POST request example

~~~json
{
  "action": "ingest",
  "sourceType": "SMS",
  "txnString": "14/10/2026 09:15:00|-845.50|Demo Bank|Savings Account|UPI|expense|Harbor Coffee|Harbor Coffee|DEMO-UTR-1001|NA",
  "originalText": "DEMO BANK: INR 845.50 debited at Harbor Coffee on 14/10/2026 at 09:15. Ref DEMO-UTR-1001.",
  "sender": "DEMO BANK",
  "requestId": "SHORTCUT-DEMO-001"
}
~~~

For email, use <code>sourceType=EMAIL</code> and include sender/subject when available. Use the deployed Apps Script Web App URL ending in <code>/exec</code>, POST, JSON request body and <code>Content-Type: application/json</code>.

### Shortcut response routing

| nextAction | Shortcut behaviour |
|---|---|
| SHOW_RECEIPT | Display date/time, merchant, amount, category, account label, verification and Transaction ID |
| CLASSIFY_CATEGORY | Ask AI for one exact active category; validate it against allowedCategories; send one update |
| REVIEW | Show review reason and validation flag; no automatic approval/archive |
| SHOW_ERROR | Show error/message and requestId; never show a success receipt |

For network timeouts, retry the **exact same** txnString and originalText. Do not modify the amount/date/fields and submit a new payload to force a success. Source-hash idempotency handles exact replays.

### Extraction prompt — core rules

The Shortcut extraction action must:
- return exactly <code>IGNORE</code> or ten pipe-separated fields;
- use the transaction time, not the notification delivery time;
- preserve date-only precision; do not invent midnight as an event time;
- make debits negative and credits positive;
- distinguish credit-card purchase (expense) from credit-card bill payment (card_payment);
- set unknown optional fields to NA rather than shifting columns;
- never mistake a credit limit, available balance, minimum due or statement balance for transaction amount;
- never invent merchant, reference, type or purpose.

### Category fallback prompt

Only use it for <code>CLASSIFY_CATEGORY</code>. Return one exact value from the active Categories list. If none is reliable and Miscellaneous is unavailable, return <code>NO_RELIABLE_CATEGORY</code> and do not update. Never return <code>ASK_PURPOSE</code>.

---

## Financial planning: zero-based budget and savings sweep

A new budget month begins with **zero opening budget allocation**. This does not reset actual bank balances or rewrite the bank account's opening/closing balance.

Keep separate:
- **Income Month:** calendar month when income actually arrived.
- **Budget Month:** budget period the income/transaction is assigned to.
- **Planned Savings Sweep:** amount intended to be moved.
- **Actual Verified Savings:** transfer supported by both ledger legs.

### Suggested budget view

| Measure | Meaning |
|---|---|
| Opening Budget Allocation | Starts at zero for each new budget period |
| Income Allocated | Funds assigned to this Budget Month |
| Essential Commitments | Housing, utilities and known obligations |
| Actual Operating Spend | Ordinary consumption expenses |
| Debt / EMI Settlements | Debt-related cash outflows, not ordinary purchases |
| Investment Allocation | Wealth contributions, separate from consumption |
| Pre-Sweep Surplus | Income allocated less commitments, operating spend, debt and investment contributions |
| Planned Savings Sweep | Intended amount to move to savings |
| Actual Verified Savings | Amount confirmed by both debit and credit transactions |
| Remaining Unallocated | Income not yet assigned to a purpose |
| Sweep Variance | Planned amount less verified amount |
| Sweep Status | Planned, pending, verified, partial or exception |

### Savings Sweep Log

Recommended columns:

<code>Sweep ID | Budget Month | Source Account | Destination Account | Planned Amount | Source Debit Transaction ID | Savings Credit Transaction ID | Actual Debit | Actual Credit | Verified Amount | Sweep Date | Sweep Status | Variance | Notes</code>

A sweep is completed only when:
- both source debit and destination savings credit point to existing canonical Transaction IDs;
- both accounts are genuinely owned by the user;
- amounts match;
- evidence supports that both legs describe the same transfer.

A planned sweep is not actual savings. The Apps Script does not initiate bank transfers and does not create the workbook planning sheet automatically.

### Accounting rules that prevent double-counting

- Card purchase = consumption when the purchase occurs.
- Card bill settlement = cash/liability settlement, not a second consumption expense.
- Investment contribution = wealth allocation, not ordinary consumption.
- Internal transfer = neither income nor expense.
- Planned savings sweep = not yet actual savings.
- Verified savings sweep = both transfer legs reconciled.

---

## Analytics: use the graph to answer a question

The visuals below are illustrative mockups, not live workbook charts or a claim that every chart has been implemented in the user's workbook.

### Cash flow and budget performance

<p align="center">
  <a href="https://github.com/asish312/Personal-Finance-Intelligence-System/blob/main/docs/images/pfis-demo-financial-performance.svg"><img src="https://raw.githubusercontent.com/asish312/Personal-Finance-Intelligence-System/main/docs/images/pfis-demo-financial-performance.svg" alt="Illustrative PFIS cash flow, allocation and savings rate charts" width="100%"/></a>
</p>

### Spending patterns and merchant concentration

<p align="center">
  <a href="https://github.com/asish312/Personal-Finance-Intelligence-System/blob/main/docs/images/pfis-demo-spending-patterns.svg"><img src="https://raw.githubusercontent.com/asish312/Personal-Finance-Intelligence-System/main/docs/images/pfis-demo-spending-patterns.svg" alt="Illustrative PFIS category, merchant, weekday and recurring analytics" width="100%"/></a>
</p>

### Evidence and data quality

<p align="center">
  <a href="https://github.com/asish312/Personal-Finance-Intelligence-System/blob/main/docs/images/pfis-demo-data-quality.svg"><img src="https://raw.githubusercontent.com/asish312/Personal-Finance-Intelligence-System/main/docs/images/pfis-demo-data-quality.svg" alt="Illustrative PFIS evidence and review dashboard" width="100%"/></a>
</p>

### Budget and savings sweep

<p align="center">
  <a href="https://github.com/asish312/Personal-Finance-Intelligence-System/blob/main/docs/images/pfis-demo-budget-sweep.svg"><img src="https://raw.githubusercontent.com/asish312/Personal-Finance-Intelligence-System/main/docs/images/pfis-demo-budget-sweep.svg" alt="Illustrative PFIS planned and verified savings sweep dashboard" width="100%"/></a>
</p>

The useful analytics are:
- income versus outflow by actual month;
- net cash movement;
- allocation by Budget Month;
- category mix and merchant concentration;
- recurring commitments;
- weekday spending;
- SMS/email/verified evidence coverage;
- open review cases by reason;
- planned versus verified savings and remaining variance.

Every chart must reference a documented calculation range. If there is insufficient data, show a no-data state rather than a made-up series.

---

## Apps Script: install, configure and operate

### Required workbook tabs

The engine requires these six core sheets:
1. Transaction Log
2. Source Log
3. Change Log
4. Rules
5. Config
6. Categories

The canonical Transaction Log schema is positional A:AC. Do not reorder its core columns. Legacy auxiliary values may exist after AC. Optional report-period fields are located by header:
- Budget Month (AN)
- Income Month (AO)

### Script Properties

Required:
- <code>SPREADSHEET_ID</code> — target Google Spreadsheet ID.

Optional:
- <code>WEB_APP_SECRET</code> — when set, requests must include the matching token as required by the endpoint.

Do not commit either property value to this repository.

### Deploy

1. Open the Apps Script project authorised to the intended workbook.
2. Add <code>PFIS_TransactionEngine_v1.0.0.gs</code>.
3. Add <code>PFIS_Preflight_Tests_v1.0.0.gs</code> to the same project when validating.
4. Configure Script Properties.
5. Run <code>PFIS_VALIDATE()</code> or POST <code>{"action":"validate"}</code>.
6. Run <code>PFIS_RUN_ALL_PREFLIGHT_TESTS()</code> in a safe project/staging environment.
7. Confirm the test report and temporary spreadsheet cleanup.
8. Deploy as a Web App and place its <code>/exec</code> URL in the iOS Shortcut.
9. Restrict who can access the endpoint as far as the Shortcut's sign-in model allows. If using WEB_APP_SECRET, protect the Shortcut containing it.
10. After source changes, deploy a new Web App version; saving code in the editor does not update an existing versioned deployment.

The preflight suite checks configured production workbook schema read-only when SPREADSHEET_ID exists and runs integration writes against a disposable synthetic spreadsheet. A JavaScript syntax check is not a Google Apps Script runtime pass.

### API surface

All Shortcut writes use POST JSON.

**Ingestion**
- <code>action=ingest</code>
- <code>sourceType=SMS|EMAIL</code>
- <code>txnString</code>
- <code>originalText</code>
- optional sender, subject, requestId, batchId, token

**Write/control**
- <code>update</code>
- <code>reprocesssource</code>
- <code>resolveexception</code>

**Read/diagnostic**
- <code>health</code> / <code>ping</code>
- <code>validate</code> / <code>validateschema</code>
- <code>gettransaction</code> / <code>gettransactiondetail</code>
- <code>getpendingreview</code>
- <code>getneedsenrichment</code>
- <code>searchtransactions</code>
- <code>getfinancialoverview</code>
- <code>getcategorybreakdown</code>
- <code>getmerchantanalysis</code>
- <code>getrecurringcommitments</code>
- <code>getcashflow</code>
- <code>getspendingbehavior</code>
- <code>getanomalies</code>
- <code>getdataquality</code>

<code>getdataquality</code> metrics are nested under <code>response.data</code>. Missing Purpose is reported separately and does not make a transaction Needs Review.

---

## Gemini spreadsheet authoring

Use Gemini in Google Sheets (or another explicitly authorised Workspace session) for workbook-only changes: formulas, Recent Transactions, dashboard charts, labels, Data Dictionary, zero-based budget and Savings Sweep Log.

Gemini must not change Apps Script source, Shortcut configuration, Script Properties, transaction IDs, amounts, dates, merchant facts, Source Log or Change Log history.

### Copy/paste workbook implementation instruction

~~~text
You are working on the existing PFIS Google Sheets workbook. Inspect actual sheet names, headers, formulas, named ranges, chart sources and dependencies before editing. Do not redesign from scratch.

Implement workbook-only improvements:
1. Make Recent Transactions a formula-driven latest-30 view from the full canonical Transaction Log, sorted by actual DateTime descending. Make it read-only.
2. Replace fixed row limits in Insights & Data Quality, Dashboard_Calc, Monthly Summary, Dashboard and Reports with scalable ranges.
3. Repair unsupported formulas at the root cause; do not hide broken formulas with IFERROR or hard-code results.
4. Preserve Transaction Log A:AC. Use optional Budget Month (AN) and Income Month (AO) headers only outside the core schema.
5. Configure a generic EMPLOYER_DEMO last-working-day salary rule: Month Offset 0, Auto Purpose FALSE, Purpose Trigger LAST_WORKING_DAY_OF_MONTH, Budget Month Offset 1. Only enter verified holiday dates.
6. Design a zero-based monthly budget. Opening budget allocation starts at zero; actual bank balances must never be reset.
7. Create one unified Review Queue view covering transaction flags, source parse failures, source conflicts, and category gaps. Give every case a unique Case ID, deduplicate by Transaction ID or Source ID, and keep missing Purpose out of mandatory review.
8. Create a Purpose Review Queue separately for optional Gemini suggestions. Gemini writes SUGGESTED rows only; human approval is mandatory before Apps Script applies them.
9. Build a Savings Sweep Log that separates planned from verified savings and requires both source debit and destination credit Transaction IDs with matching amounts.
10. Update Data Dictionary, labels, help text and charts. Each chart must use an actual calculation range and show its period and unit.

Non-negotiable:
- Do not edit Apps Script or iOS Shortcut files.
- Do not alter Transaction IDs, amounts, dates, bank facts, merchant facts or source/audit evidence.
- Do not auto-merge/delete duplicate candidates.
- Purpose is optional and must not increase Needs Review.
- Do not create fabricated data or use example/demo numbers in live calculations.
- After editing, report exact sheet/cell ranges, old and new formulas, validations, unresolved items and whether each feature is implemented or still planned.
- Do not claim a chart/formula is working until checked in the actual Google Sheet.
~~~

---

## Known design gaps and recommended long-term direction

These are implementation boundaries, not features to pretend are complete:

| Area | Current behaviour / risk | Long-term target |
|---|---|---|
| Unified review | <code>getpendingreview</code> returns transaction review flags and source CONFLICTs; <code>PARSE_FAILED</code> is not currently included | One Review Queue that aggregates transaction and source cases once |
| Category enrichment | <code>getneedsenrichment</code> is a separate API route | Show category gaps in the same Review Queue, with a distinct action type |
| Purpose | Optional; rule-generated or Gemini-suggested with approval | Keep it optional and preserve rule evidence/audit |
| Parser failure | Original source is retained as PARSE_FAILED, but not surfaced in pending review | Source-level review case; create provisional ledger item only when minimum facts are safe |
| Recent Transactions | Workbook formula/view responsibility, not an Apps Script refresh command | Dynamic latest-30 formula over the full canonical ledger |
| Workbook formula portability | Google Sheets-only QUERY/UNIQUE/FILTER formulas may export to XLSX as unsupported functions or cached values | Validate formulas in Google Sheets; document Excel-export limitations |
| Dashboard ranges | Fixed row references become stale as ledger grows | Dynamic/open-ended ranges or bounded helper tables |
| Savings sweep | Workbook planning/reconciliation, not a bank transfer service | Match both debit and credit legs before calling savings verified |
| Gemini | Separate connected-app workflow, not runtime engine integration | Daily suggestions to a queue; never direct Gemini ledger writes |

### The one-review-inbox rule

A unified Review Queue should have a single row per unresolved **case**, not one row per sheet entry. Suggested fields:

<code>Case ID | Case Type | Transaction ID | Source ID | Date | Amount | Bank | Account | Merchant | Issue Code | Evidence Summary | Status | Reviewer | Reviewed At | Resolution | Resolved At</code>

Recommended Case Types:
- TRANSACTION_REVIEW
- PARSE_REVIEW
- SOURCE_CONFLICT
- CATEGORY_CLASSIFICATION

Purpose suggestions remain optional and live in Purpose Review Queue because they are enrichment proposals, not financial integrity exceptions. A resolved duplicate moves to Rejected & Archive Log; a confirmed distinct transaction returns to the normal active ledger state.

---

## Engineering and privacy boundaries

- Use POST JSON for ingestion and writes; do not use GET for writes.
- Preserve the full original message in Source Log.
- Use source hash/idempotency for exact retries; retry the exact original payload after timeouts.
- Use write locking around transaction ID allocation, duplicate checks and row writes.
- Do not merge on amount/date alone.
- Do not silently delete a candidate.
- Do not mark every missing optional field as Needs Review.
- Do not expose full account/card numbers, secrets, raw bank message contents or personal identifiers in public examples.
- Use synthetic merchants, values, IDs and names in repository docs/tests.
- Keep employer-specific examples generic; this README uses <code>Example Employer</code> and <code>EMPLOYER_DEMO</code>.

### Production file map

| File | Responsibility |
|---|---|
| <code>PFIS_TransactionEngine_v1.0.0.gs</code> | Production Apps Script engine |
| <code>PFIS_Preflight_Tests_v1.0.0.gs</code> | Synthetic preflight/regression harness |
| <code>README.md</code> | Complete project story, UI, configuration, Shortcut, Gemini, operations and maintainer notes |
| <code>docs/images/</code> | Fictional SVG illustrations embedded above |

Production engine, schema and parser identifiers remain **v1.0.0**. Keep one branch: <code>main</code>.

---

<div align="center">

### Capture the event. Preserve the evidence. Understand the pattern.

**PFIS · Personal Finance Intelligence System · v1.0.0**

<sub>Google Apps Script · Google Sheets · iOS Shortcuts · Optional Gemini-assisted enrichment</sub>

</div>
