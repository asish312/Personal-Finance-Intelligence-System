# Personal Finance Intelligence System

> A low-friction, evidence-first personal finance ledger and intelligence layer built around iPhone Shortcuts, Gemini, Google Apps Script, and Google Sheets.

**Document status:** Final target architecture / implementation specification

**Revision:** v3.0 — review incorporated and implementation-aligned

**Implementation note:** Source facts, user context, deterministic system state, derived analytics, and AI interpretation are deliberately separated. The parser is never asked to invent user context that a bank alert cannot reliably establish.

**Primary goal:** Capture financial transactions automatically, minimize manual intervention, reconcile multiple notification sources, preserve the underlying evidence, and turn the resulting ledger into reliable weekly and monthly financial intelligence with meaningful charts and decisions.

---

## 1. Vision

The system is not meant to be another expense tracker where the user manually fills forms.

The intended experience is:

```text
Bank / UPI / Wallet / Credit-card alert
                ↓
        iPhone Shortcut
                ↓
        Gemini extraction
                ↓
       Structured pipe line
                ↓
        Google Apps Script
                ↓
        Transaction Log
                ↓
      automatic enrichment
                ↓
   optional user clarification
                ↓
    SMS ↔ Email verification
                ↓
       clean financial ledger
                ↓
   Daily / Weekly / Monthly analytics
                ↓
      useful decisions/actions
```

The guiding principle is:

> **Capture automatically. Preserve evidence. Ask only when the system genuinely cannot know. Verify when a second source exists. Derive intelligence from history.**

The system should optimize for **low manual effort and high analytical value** rather than maximum number of fields.

---

# 2. Design Principles

## 2.1 Facts, context, intelligence are different

The system should never pretend that a bank alert contains information it does not contain.

### Facts

Can normally be extracted automatically from the transaction alert:

- date/time
- amount
- debit/credit direction
- bank
- account type
- instrument
- merchant or counterparty
- transaction type
- transaction reference
- available balance after transaction, when present
- masked account/card identifier, when present

### Context

May require user clarification:

- what a person transfer was for
- why an ambiguous merchant was used
- purpose of an unusual payment
- user-specific classification not recoverable from the alert

This should be captured through the existing low-friction purpose question, not manual transaction entry.

### Intelligence

Should be derived automatically from transaction history:

- recurring behavior
- category trends
- merchant concentration
- spending velocity
- day-of-week patterns
- transaction frequency
- anomaly detection
- month-over-month changes
- savings / cash-surplus trends
- data quality and verification coverage

Do not store derived judgments such as `Essential`, `Discretionary`, `Planned`, or `Reimbursable` as mandatory transaction fields merely because they would be useful analytically. A bank message usually cannot establish them reliably.

---

# 3. Current System Baseline

The current parser produces this 9-field format:

```text
datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no
```

The parser explicitly supports one completed transaction per message, returns `IGNORE` for non-transactional alerts, uses signed amounts, and distinguishes `expense`, `income`, `card_payment`, `investment`, `transfer`, and `refund`. The current prompt also instructs the model to ignore OTPs, promotions, statements, pending/failed notifications, payment requests, and balance-only messages. 

The current Apps Script stores an 18-column `Transaction Log` with the following fields:

```text
Transaction ID
DateTime
Amount
Bank
Account Type
Merchant
Category
User Notes
Original Text
Type
Instrument
Account
Card Name
Is Recurring
Needs Review
Counterparty
Ref No
Balance After
```

The script already contains routing for raw transactions, manual transactions, retrieval, pending review, transaction updates, last transactions, and a monthly overview. It also has configuration/suggestion hooks for categories, merchants, recurring transactions, account/card overrides, and notes.

### Important current implementation issues to fix

The following are architectural issues visible in the current implementation and should be fixed as part of the migration:

1. The parser supports 9 fields while the target ledger needs a small amount of additional source information that can improve reconciliation.
2. `Original Text` is stored directly in the main Transaction Log. This makes the analytical sheet unnecessarily heavy and mixes evidence with normalized ledger data.
3. The current parser leaves `balanceAfter` blank even though the Transaction Log contains a `Balance After` column.
4. Duplicate detection is based on exact DateTime + Amount + Bank + Merchant within a recent subset of rows. That is not sufficient for reliable SMS/email reconciliation.
5. The current review logic treats missing notes as a review condition. This forces unnecessary user interaction even when a transaction is obvious.
6. Some retrieval functions read only the original 9-column portion even though the current Transaction Log has 18 fields. Retrieval should use the canonical schema consistently.
7. Type in some retrieval responses is inferred from the sign of the amount rather than reading the stored semantic `Type`. That can misrepresent card payments, investments, transfers, and refunds.
8. Refund classification must take precedence over generic positive-credit/income detection. A positive transaction explicitly described as a refund must remain `refund`, not `income`.
9. Monthly overview logic must use the real summary headers. It should not assume a `Savings` field if the actual summary uses fields such as `Net Cash`, `Investment & savings`, `Savings Rate`, etc.
10. Historical/monthly overview calculations must not derive `daysLeft` from today's calendar month when the row being displayed belongs to another month.
11. Source matching must be independent of the order in which SMS and email arrive.
12. A transaction being sourced from SMS only should not automatically become a review item. Lack of a second source is not an error.

### 3.1 Review-derived correctness blockers

The attached review identifies the following implementation defects as correctness issues. They must be treated as release blockers for rich analytics because they can silently change financial totals.

#### P0 — Type correctness

1. **Investment keyword false positive:** substring checks can interpret `card` as `rd`. Investment matching must use word boundaries and explicit tokens.
2. **Unknown inflows:** an unexplained positive transaction must not default to `income`. Return an unresolved type and create a review condition instead.
3. **Card purchase vs card payment:** a broad card-payment matcher must not classify a purchase alert as `card_payment`. Require explicit settlement language and a non-card funding source; a purchase/`spent` guard wins.
4. **Precedence:** user correction > CONFIG/rule > model > heuristic. A heuristic may fill only a blank field; it may not overwrite a valid model or rule result.
5. **Duplicate rejection:** probable duplicates must be flagged, never silently rejected.
6. **Type repair:** `updateTransaction(transactionId, patch, reason)` must allow an audited Type correction.

#### P1/P2 — Rule/data integrity

7. Merchant matching must use longest/specific-first and word-boundary matching. Short tokens such as `VI`, `CCD`, `UPI`, or `MORE` must not hijack unrelated merchants.
8. Category rules must distinguish merchant-name matching from message-text matching. Message words such as `credited` or `payment received` must not be merchant keys.
9. `AMOUNT+MERCHANT` rules must normalize the match type before comparison; unknown match types must be logged rather than silently skipped.
10. Internal-account configuration must be functional and must promote an internal-transfer candidate to `transfer` when no stronger evidence says otherwise.
11. CONFIG enrichment must be additive. All compatible rules should be evaluated in deterministic specificity/priority order; applied rule IDs are recorded.
12. `Created At` / `Last Updated At` must replace row-position assumptions.
13. Script timezone and spreadsheet timezone must match or ingestion must fail fast.
14. Number parsing must handle parenthesized negatives and trailing-minus values before stripping separators.
15. Parser result date formatting must use the configured timezone rather than UTC JSON serialization.
16. API error codes must come from one stable enum and include machine-readable field/remediation information.
17. Production tests must never write to the production spreadsheet.


---

# 4. Target Architecture

## 4.1 Core components

### A. iPhone Shortcut

Responsible for:
- reading eligible SMS/notification text
- collecting email text when a secondary source is expected or the SMS path is unavailable
- sending one source at a time to Gemini
- receiving the strict parser output
- calling Apps Script
- displaying a clarification question only when Apps Script requests one
- sending the user's response back against the same `Txn ID`

Keep the Shortcut thin. Accounting and matching rules belong centrally in Apps Script.

### B. Gemini transaction parser

Responsible only for extracting facts from one alert. It does not generate IDs, own ledger-wide deduplication, invent purpose/context, make financial recommendations during ingestion, or override deterministic server-side rules.

### C. Google Apps Script

Responsible for validation, normalization, policy/rule evaluation, stable ID generation, idempotent ingestion, Source Log persistence, reconciliation, clarification orchestration, derived analytics, and bounded AI tools.

### D. Google Sheets

Google Sheets is the durable source of truth at the current scale. It stores the canonical ledger, source evidence, policy/configuration, derived analytics, review queue, and data-quality outputs.

### E. Gemini finance analyst

Consumes deterministic summaries and targeted retrieval, then produces weekly/monthly intelligence, meaningful charts, anomaly explanations, trends, and decisions.

---

## 4.2 Apps Script file architecture

Split the current monolithic script into logical files. Apps Script shares global scope across `.gs` files, so the dependency direction is enforced by convention.

```text
Router.gs       HTTP entry points and tool-registry dispatch only
Tools.gs        typed tool definitions and JSON schemas
Policy.gs       auth/rate-limit/idempotency/propose-commit boundary
Service.gs      ingestion/update/review/reconciliation orchestration
Classify.gs     pure classification; no SpreadsheetApp
Analytics.gs    metric definitions and derived-table builders
Repository.gs   only file allowed to call SpreadsheetApp
Cache.gs        cache wrappers, config versioning, indexes
Schema.gs       headers, column maps, enums, schemaVersion, assertions
Serialize.gs    response envelopes, error shapes, provenance, date formatting
Tests.gs        redacted fixture corpus and test runner
```

### Layer rules
1. `Repository.gs` is the only file allowed to call `SpreadsheetApp`.
2. `Classify.gs` is pure and sheet-independent.
3. `Router.gs` dispatches through `Tools.gs`; do not create a long `if (action === ...)` chain.
4. Persistence and classification are separate from presentation formatting.
5. Cross-layer boundaries use plain objects with declared shapes.
6. Agentic writes cannot bypass `Service.gs`/`Policy.gs`.

The split is what lets the project add analytics, AI retrieval, tests, and eventually a database backend without rewriting the entire application.

---

## 4.3 Security boundary — deferred initially

Security is not the first implementation milestone, but the design must reserve the correct seam. Before external exposure or autonomous writes, implement:

- authentication/authorization in `Policy.gs`
- POST for source ingestion/writes; GET for safe reads
- no raw SMS/email bodies in URLs
- secrets in Apps Script Properties, not source code
- input validation and length limits
- stable public error codes instead of raw stack traces
- request IDs, idempotency, replay protection, and rate limits
- proposal/commit tokens for agentic writes
- deliberate evidence access through `getEvidence(transactionId)`

The current endpoint's trusted personal workflow may remain the first deployment environment, but these controls are mandatory before widening access.

# 5. Source Ingestion Model

The system supports at least these source types:

```text
SMS
EMAIL
MANUAL
```

`SMS` and `EMAIL` are evidence sources for the same underlying transaction.

`MANUAL` is a controlled exception for transactions that never generate machine-readable alerts.

A source is not a transaction.

One transaction may have:

```text
1 SMS source
1 EMAIL source
0 or 1 MANUAL enrichment event
```

The same transaction must never become two financial events simply because two sources describe it.

---

# 6. Final Pipe Format

Keep the pipe output intentionally small and reliable.

### Recommended final format

```text
datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after
```

### Exactly 10 fields

1. `datetime`
2. `signed_amount`
3. `bank`
4. `account_type`
5. `instrument`
6. `type`
7. `merchant_name`
8. `counterparty`
9. `ref_no`
10. `balance_after`

### Why only one extra field

`Balance After` is genuinely useful when explicitly present in a bank alert and can later support reconciliation/data-quality analytics.

Other useful values such as normalized merchant, recurring status, category, verification status, confidence, review state, and account/card mapping should be derived or stored by Apps Script rather than bloating the parser output.

Do not add fields to the pipe just because they would be useful if they cannot be extracted reliably from the message.

---

# 7. Final Parser Rules

## 7.1 Output contract

The parser must output exactly one line.

For a completed transaction:

```text
datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after
```

For a non-transactional message:

```text
IGNORE
```

No markdown, explanation, labels, quotes, commas, currency symbols, or additional lines.

Unknown values:

```text
NA
```

---

## 7.2 Ignore conditions

Return `IGNORE` when the message represents:

- OTP
- promotional offer
- advertisement
- rewards offer
- greeting
- statement
- balance-only alert
- available balance update
- credit-limit update
- bill-due reminder
- EMI-due reminder
- payment request
- declined transaction
- failed transaction
- pending transaction
- authorization-only event
- reversed-pending event that is not itself a completed refund/reversal
- non-transactional account alert
- message containing multiple completed transactions that cannot be represented as one event

A completed refund/reversal is valid and should be parsed as `refund`.

---

## 7.3 Transaction date/time

- Use the actual transaction date/time.
- Do not use the email received timestamp as the transaction timestamp.
- Interpret Indian banking dates as day-first.
- Output `yyyy-MM-dd HH:mm:ss`.
- Preserve the actual transaction time when present.
- If the transaction date is absent, use the supplied current date.
- If the time is absent, use `00:00:00`.

The source received time belongs in `Source Log`, not in `Transaction Log.DateTime`.

---

## 7.4 Amount

- Always output two decimals.
- Negative means money left the user's account/card/wallet.
- Positive means money came to the user.
- Debit / spent / paid / withdrawn / transferred to → negative.
- Credit / received / salary / interest / dividend / cashback → positive.
- Refund / reversal / chargeback received → positive.
- Never use balance, available balance, credit limit, minimum due, total due, reward points, or unrelated monetary values.
- If multiple amounts appear, select only the completed transaction amount.

---

## 7.5 Bank

Use the configured canonical names:

```text
Axis
SBI
SBI Card
HDFC
ICICI
Kotak
Paytm
Amazon Pay
Other
```

The configuration can later expand without changing the overall architecture.

---

## 7.6 Account type

Use:

```text
Savings Account
Current Account
Credit Card
Wallet
Cash
```

Rules:

- account/A/c/savings-account reference → Savings Account unless clearly a credit-card account
- credit-card account/card transaction → Credit Card
- wallet → Wallet
- physical cash / ATM cash → Cash
- current account → Current Account

---

## 7.7 Instrument

Use:

```text
UPI
Credit Card
Debit Card
Net Banking
NEFT
IMPS
RTGS
Wallet
Auto Debit
Cash
```

Infer only when the message supports it.

Examples:

- UPI / VPA / UPI ID / `@` → UPI
- IMPS → IMPS
- NEFT → NEFT
- RTGS → RTGS
- ECS / NACH / SI / standing instruction / mandate / autopay → Auto Debit
- credit card transaction → Credit Card
- debit card transaction → Debit Card
- ATM withdrawal/deposit → Cash
- clearly a bank account transfer without a more specific rail → Net Banking

---

# 8. Semantic Transaction Type

Use exactly:

```text
expense
income
card_payment
investment
transfer
refund
```

## Classification precedence

### 1. Refund

Use `refund` when the message explicitly represents:

- refund
- reversal completed
- chargeback received
- money returned for an earlier purchase

This must take precedence over generic "credited" or "income" wording.

### 2. Card payment

Use `card_payment` when the user pays a credit-card bill or outstanding.

Examples:

- credit-card bill payment
- payment towards credit card
- card outstanding paid
- payment received towards card bill

A credit-card purchase is **not** a `card_payment`.

### 3. Investment

Use `investment` for clearly identified:

- SIP
- mutual fund purchase
- MF
- stock/share purchase
- FD
- RD
- NPS
- PPF
- explicit investment-account funding

Do not classify an ordinary person-to-person bank transfer as an investment without explicit evidence.

### 4. Transfer

Use `transfer` for:

- person-to-person transfer
- transfer to another bank/account
- transfer between the user's own accounts
- generic UPI transfer with no identifiable merchant/service purchase

A transfer is not a normal expense unless the message clearly represents payment for goods/services.

### 5. Income

Use `income` for:

- salary
- interest
- dividend
- cashback
- other clearly received earnings/credits

A refund remains `refund`.

### 6. Expense

Use `expense` for:

- merchant purchases
- shopping
- food
- groceries
- utilities
- bills
- subscriptions
- services
- travel
- fuel
- healthcare
- other normal consumption

---

# 9. Merchant and Counterparty Extraction

## Merchant

Use the clearest human-readable merchant or purpose present in the alert.

Examples:

```text
SWIGGY
AMAZON
AIRTEL
BHARTI AIRTEL
NETFLIX
```

For a person transfer, use the person's readable name.

For card bill payment:

```text
Axis Credit Card Bill
SBI Card Bill
```

Do not use bank names as merchant names unless the bank itself is the recipient/purpose.

## Counterparty

Use the other party when explicitly identifiable.

For a merchant purchase, this can be the merchant if present.

For a person transfer, use the person's name/UPI ID.

For a card payment, use the relevant card/bank identifier when present.

Otherwise:

```text
NA
```

---

# 10. Reference Number

Prefer the transaction-specific identifier:

- UTR
- RRN
- UPI reference
- transaction ID
- authorization code when it is clearly the transaction reference

Never use:

- phone number
- helpline number
- account number
- full card number
- balance
- credit limit

If multiple references appear, choose the one directly associated with the completed transaction.

---

# 11. Balance After

Capture only when the message explicitly provides the post-transaction available/current/account balance.

Rules:

- store numeric value only
- do not confuse it with the transaction amount
- if absent, use `NA`
- never derive it from arithmetic in the parser

Apps Script may optionally use it for reconciliation/data-quality checks later.

---

# 12. Parser Prompt — Final Version

```text
Read ONE Indian bank/UPI/wallet/credit-card alert (SMS or email) and output exactly ONE pipe-delimited line.

Ignore ads, offers, greetings, promotional content, footers, links, helpline numbers, "Not you?/BLOCK" instructions, balance-only messages, and unrelated text. For email, prefer the body for transaction details, but use the subject when it contains the only reliable transaction identifier.

NOW: {{CURRENT_DATE_TIME_HERE}}

OUTPUT FORMAT
 datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after

Exactly 10 fields.
Separator: " | "
Unknown: NA
No commas, quotes, currency symbols, extra text, explanations, or markdown.

If the message does NOT represent one completed transaction, output ONLY:
IGNORE

IGNORE:
- OTP
- offers/promotions
- bill due/reminder
- statement
- balance/available balance/credit limit
- EMI due/reminder
- payment request
- failed/declined transaction
- pending transaction
- authorization-only notification
- non-transactional account alerts
- a message containing multiple completed transactions that cannot be represented as one event

IMPORTANT:
A completed refund/reversal is a valid transaction and must be classified as refund.
A pending/failed/reversed-pending notification is not a completed refund and must be ignored.

TRANSACTION DATE/TIME
- Use the actual transaction date/time, not the email received time.
- Indian dates are day-first.
- Output yyyy-MM-dd HH:mm:ss.
- If date is missing, use NOW's date.
- If time is missing, use 00:00:00.

AMOUNT
- Always output exactly 2 decimals.
- Negative = money left the user's account/card/wallet.
- Positive = money came to the user.
- Debit/spent/paid/withdrawn/transferred to = negative.
- Credit/received/salary/interest/dividend/cashback = positive.
- Refund/reversal/chargeback received = positive.
- Never use balance, available balance, credit limit, total due, minimum due, reward points, or unrelated amounts.
- If multiple amounts appear, select only the completed transaction amount.

BANK
Use:
Axis | SBI | SBI Card | HDFC | ICICI | Kotak | Paytm | Amazon Pay | Other

ACCOUNT TYPE
Use:
Savings Account | Current Account | Credit Card | Wallet | Cash

INSTRUMENT
Use:
UPI | Credit Card | Debit Card | Net Banking | NEFT | IMPS | RTGS | Wallet | Auto Debit | Cash

TYPE
Use exactly:
expense | income | card_payment | investment | transfer | refund

CLASSIFICATION PRECEDENCE
1. refund
2. card_payment
3. investment
4. transfer
5. income
6. expense

REFUND
Use refund for completed refund, reversal, or chargeback received for a previous transaction.

CARD_PAYMENT
Use card_payment when money is paid toward a credit-card bill/outstanding.
A credit-card purchase is expense, never card_payment.

INVESTMENT
Use investment only when the message clearly identifies SIP, mutual fund, stock/share purchase, FD, RD, NPS, PPF, investment funding, or another explicit investment transaction.

TRANSFER
Use transfer for person-to-person transfers, transfers between own accounts, transfers to another account, or generic UPI/bank transfers without a merchant purchase purpose.

INCOME
Use income for salary, interest, dividend, cashback, or other clearly received earnings.
A refund is not income.

EXPENSE
Use expense for normal purchases/payments for goods or services.

MERCHANT_NAME
- Use the clearest readable merchant/purpose.
- For person-to-person transfer, use the person's name.
- For credit-card bill payment, use [Bank/Card] Credit Card Bill.
- If no meaningful merchant/purpose exists, use Unspecified.
- Do not use bank names as merchant names unless the bank itself is the recipient/purpose.

COUNTERPARTY
- Use the other party's readable name or UPI ID when explicit.
- For merchant transactions, use merchant name when explicitly available.
- For card bill payments, use the card/bank identifier when available.
- Otherwise NA.

REF_NO
Use the actual transaction reference: UTR / RRN / UPI reference / transaction ID / authorization code.
Never use phone number, customer-care number, account number, card number, balance, or credit limit.

BALANCE_AFTER
- Extract the post-transaction account/card/wallet balance only when explicitly shown.
- Otherwise NA.

IMPORTANT
- Output only one transaction.
- Do not invent missing values.
- Do not infer a merchant from a phone number.
- Do not treat a credit-card purchase as card_payment.
- Do not treat a card bill payment as expense.
- Do not treat a transfer or investment as an expense unless the message explicitly represents a purchase/service expense.
- Do not treat a refund as income.

NOW OUTPUT ONLY THE LINE FOR:
{{SMS_OR_EMAIL_TEXT_HERE}}
```

Parser version is carried as request metadata (`formatVersion=10`) outside the 10-field pipe payload. Do not add a version as an extra pipe field.

---

# 13. Canonical Transaction Identity

A transaction needs a stable identity that survives the arrival of multiple sources.

Do not rely on email timestamp or exact parsed DateTime for identity.

## 13.1 Transaction ID

Keep the user-friendly server-generated ID style already used by the system:

```text
YYYYMM-XXX
```

The Transaction ID is assigned to the canonical financial event, not to a source.

## 13.2 Match Key

Add a deterministic internal `Match Key`.

Preferred construction:

```text
ref_no
```

when a reliable bank/UPI/reference number exists.

Fallback fingerprint:

```text
bank
+ account/card identifier when available
+ signed amount
+ normalized merchant/counterparty
+ transaction date
+ transaction type
```

The fallback should use a reasonable date/time tolerance instead of exact timestamp equality.

The Match Key is for system reconciliation and should not be shown as a human-facing transaction reference.

If the parser outputs `00:00:00` because the source contained no time, treat that timestamp as day-level precision during reconciliation rather than pretending the time is known exactly. A future optional internal field such as `DateTime Precision = day|second` may be used if it does not burden the external pipe contract.

---

# 14. Source Log

Create a separate protected `Source Log`. A source is evidence, not a transaction. Multiple source records may link to one canonical transaction.

Recommended columns:

```text
Source ID
Linked Txn ID
Source Type
Received At
Sender
Subject
Raw Body
Parser Version
Parse Status
Parse Result
Source Hash
Ref No
Candidate Txn IDs
Match Status
Match Confidence
Request ID
Idempotency Key
Created At
```

`Source Hash` belongs to the source record because one transaction can have both SMS and email evidence.

Keep `Original Text` in Transaction Log only during migration; Source Log becomes the canonical evidence store.

### Raw evidence policy

Raw evidence supports audit, re-parsing, debugging, and reconciliation. Do not feed the complete Source Log to Gemini. Retrieve evidence deliberately for a specific transaction.

# 15. Transaction Log — Final Schema

The main ledger contains normalized transaction facts and deterministic/system state, not long raw messages. **Append new columns during migration; do not reorder existing production columns until all clients are migrated.**

| Field | Purpose | Source / Derivation |
|---|---|---|
| Txn ID | Stable canonical financial-event ID | Apps Script |
| DateTime | Actual transaction time | Parser |
| Amount | Signed amount | Parser |
| Bank | Canonical bank | Parser/config |
| Account Type | Savings/CC/wallet/etc. | Parser/config |
| Merchant | Source-readable merchant | Parser |
| Category | High-level category | Rules/model/user |
| User Notes | User-provided purpose/context | User |
| Original Text | Temporary legacy evidence | Migration only |
| Type | expense/income/card_payment/investment/transfer/refund | Rules/model/user |
| Instrument | UPI/card/IMPS/etc. | Parser |
| Account | Internal mapped account | CONFIG |
| Card Name | Internal mapped card | CONFIG |
| Is Recurring | Recurring state | Rules/history |
| Needs Review | Human action required | Rules |
| Counterparty | Other party | Parser |
| Ref No | Transaction reference | Parser |
| Balance After | Explicit post-transaction balance | Parser |
| Match Key | Candidate-match fingerprint | Apps Script |
| Merchant Normalized | Canonical merchant for analytics | Rules/history |
| Subcategory | Second-level analytics category | Rules/user |
| Parser Confidence | 0–1 confidence | Apps Script |
| Verification Status | Pending/Verified/SMS Only/Email Only/Conflict | Apps Script |
| Verification Source | SMS/Email/SMS+Email | Apps Script |
| Verified At | Last successful reconciliation | Apps Script |
| Source Count | Linked source count | Apps Script |
| Created At | Stable creation timestamp | Apps Script |
| Last Updated At | Last mutation/reconciliation | Apps Script |
| Review Reason | Stable reason for human review | Apps Script |
| Type Source | model/rule/user/heuristic | Apps Script |
| Type Confidence | 0–1 | Apps Script |
| Category Source | model/rule/user/heuristic | Apps Script |
| Rules Applied | Rule IDs used for enrichment | Apps Script |
| Schema Version | Migration marker | Apps Script |

Do not require `Essentiality`, `Planned`, or `Reimbursable` as parser fields. They are not reliably recoverable from transaction alerts and should only exist if user context or an explicit rule establishes them.

# 16. Why these fields are enough

## Automatically retrievable and worth keeping

- transaction timing
- amount
- source bank
- account type
- instrument
- semantic transaction type
- merchant
- normalized merchant
- counterparty
- reference
- explicit balance
- account/card mapping
- recurring status
- verification state
- parser/review quality

## Do NOT require these as automatic transaction fields

Do not require the parser to infer:

- Essential / Discretionary
- Planned / Unplanned
- Reimbursable
- personal / business unless explicitly indicated
- emotional/contextual spending reasons

Those values are often unknowable from a bank alert.

If the user provides such context in the purpose response, it may be stored inside `User Notes`, and a future controlled enrichment layer can extract structured fields only when the user explicitly supplies enough information.

---

# 17. Automatic Enrichment

After the transaction reaches Apps Script, apply enrichment in this order:

```text
Parser result
    ↓
Normalize merchant
    ↓
Apply known merchant/category rule
    ↓
Apply account/card CONFIG
    ↓
Apply recurring rule/history
    ↓
Estimate parser/data confidence
    ↓
Determine whether clarification is actually needed
```

## 17.1 Merchant normalization

Keep two concepts:

```text
Merchant = raw readable merchant from source
Merchant Normalized = canonical merchant for analytics
```

Examples:

```text
AMAZON SHOPPING → Amazon
AMAZON PAY → Amazon
SWIGGY → Swiggy
BHARTI AIRTEL → Airtel
```

This is critical for clean longitudinal charts.

---

# 18. Category and Subcategory

Keep a manageable high-level category set.

Recommended current categories:

```text
Bills & subscription
Cash
Credit card payments
Food & dining
Healthcare
Housing & utilities
Income
Investment & savings
Miscellaneous
Shopping
Transportation
```

Add `Subcategory` as the second analytical level.

Examples:

```text
Food & dining
  Groceries
  Restaurant
  Food delivery
  Snacks

Transportation
  Metro
  Fuel
  Cab
  Flight
  Parking

Housing & utilities
  Rent
  Electricity
  Internet
  Maintenance

Bills & subscription
  Mobile
  Streaming
  Software
  Insurance
```

The exact subcategory list should remain configurable.

### Rule

Category/subcategory should be automatic when confidence is high.

User clarification should only happen when the transaction is genuinely ambiguous.

---

# 19. Recurring Detection

`Is Recurring` should be system-derived, not manually set whenever possible.

Use a combination of:

- normalized merchant
- similar amount
- repeated appearance
- regular interval
- category
- explicit rule

Examples:

```text
Netflix
Airtel
Rent
Home loan EMI
Internet
Insurance
```

should become obvious candidates over time.

Store the boolean in the transaction row, but maintain a separate recurring summary for longitudinal analysis.

---

# 20. User Clarification Flow

The clarification mechanism is one of the most valuable parts of the design because it keeps manual intervention low.

## 20.1 High-confidence transaction

Example:

```text
₹649 Netflix
Category: Bills & subscription
Subcategory: Streaming
Recurring: TRUE
```

Do not ask the user anything.

## 20.2 Ambiguous merchant

Example:

```text
₹5,000 → Babu
```

Ask:

> What's this payment for?

User answers:

> Mona house hold money

Apps Script updates the same `Txn ID`.

It may then derive:

```text
Category = Housing & utilities
Subcategory = Household
User Notes = Mona house hold money
Needs Review = FALSE
```

## 20.3 Unknown merchant/category

Ask only when the system cannot make a sufficiently reliable classification.

## 20.4 Important rule

The user should never have to recreate the transaction manually.

The clarification updates the existing transaction.

---

# 21. Needs Review vs Verification Status

These answer different questions and must remain separate.

## Verification Status

```text
Pending
Verified
SMS Only
Email Only
Conflict
```

`Pending` = waiting for delayed secondary-source lookup.

`Verified` = two or more independent sources agree on important transaction facts.

`SMS Only` = SMS exists, but no matching email was found in the configured window.

`Email Only` = email exists, but no matching SMS was found.

`Conflict` = multiple sources exist but materially disagree.

Single-source status is not an error and does not automatically require review.

## Needs Review

`Needs Review` means human input can materially improve or correct the transaction. It is always paired with `Review Reason`.

---

# 22. Needs Review Logic

Set `Needs Review = TRUE` only when: 

```text
missing category
ambiguous subcategory
unknown merchant
ambiguous transaction type
low parser/data confidence
SMS/email conflict
probable duplicate
missing purpose when purpose is required
balance mismatch
```

Recommended stable review reasons:

```text
missing_category
unknown_merchant
ambiguous_type
missing_purpose
low_confidence
source_conflict
duplicate_candidate
unresolved_mapping
balance_mismatch
```

# 23. SMS → Email Verification Workflow

## Match priority is reference first

1. Exact transaction reference.
2. Strong bank/account/card + amount + date + merchant/counterparty match.
3. Fallback candidate match using date/time tolerance and normalized merchant/counterparty.

Email/SMS delivery order must not affect the final Transaction ID.

## 23.1 SMS arrives first

```text
SMS received
   ↓
Gemini parses
   ↓
Apps Script creates transaction
   ↓
Verification Status = Pending
   ↓
wait ~60 seconds
   ↓
search recent email
```

## 23.2 Email match found

Match priority:

1. exact transaction reference
2. strong account/card identifier + amount + merchant + transaction date
3. strong fallback fingerprint with reasonable date/time tolerance

Do not require exact identical timestamp because SMS and email are separate delivery channels.

Then compare:

- amount
- sign/direction
- transaction date
- bank
- account/card
- transaction type
- merchant/counterparty
- reference

If consistent:

```text
Verification Status = Verified
Verification Source = SMS+Email
Source Count = 2
```

## 23.3 Conflict

If an important field disagrees:

```text
Verification Status = Conflict
Needs Review = TRUE
Review Reason = SMS/Email Conflict
```

Do not automatically overwrite the first record with the second source.

Store both source records and preserve the evidence.

## 23.4 No email

If no matching email is found after the initial wait:

```text
Verification Status = SMS Only
```

Do not create a second transaction.

A later reconciliation pass may still discover the email and update the same transaction.

---

# 24. Email Processing Window

For email-based transaction verification and the daily personal briefing, avoid scanning old mail indiscriminately.

### For transaction verification

Search recent mail only, with a practical lookback window around the source arrival/transaction date. A two-day window is appropriate for the current workflow.

### For daily personal email briefing

Only consider the last **48 hours**.

Do not surface an older email simply because it remains unread.

An older thread may be included only when there is a genuinely new reply/update within the last 48 hours.

This prevents the morning briefing from repeatedly resurfacing stale messages.

---

# 25. Source Reconciliation Examples

## Example A — same transaction

SMS:

```text
₹549 Amazon, 02/10/2026
```

Email one minute later:

```text
Your card was used for INR 549 at Amazon...
```

Result:

```text
One transaction
Two source records
Verification = Verified
```

## Example B — email has a better merchant name

SMS:

```text
₹941.64 Bharti Airt
```

Email:

```text
₹941.64 spent for broadband account...
```

Keep the transaction ID and use the email only to enrich missing evidence/context when the sources agree.

## Example C — SMS and email conflict

SMS:

```text
₹1,299 Amazon
```

Email:

```text
₹12,299 Amazon
```

Result:

```text
One transaction
Verification = Conflict
Needs Review = TRUE
Review Reason = SMS/Email Conflict
```

Never silently choose one.

---

# 26. Duplicate Detection

Duplicate detection must be idempotent and must never silently discard a legitimate transaction.

## Tier 1 — source idempotency

Calculate `Source Hash = SHA-256(normalized raw source body)`. Receiving the same source again must return the existing result with `success=true`, `duplicate=true`, and the existing `Txn ID`.

If a reliable bank/reference combination exists, enforce uniqueness for that source identity.

## Tier 2 — probable transaction duplicate

When no reliable reference exists, search candidates using bank/account/card, signed amount, normalized merchant/counterparty, type, and transaction date/time tolerance. Widen the time window if time is unknown.

Probable duplicates are flagged, not rejected:

```text
Needs Review = TRUE
Review Reason = duplicate_candidate
```

Never use the last N rows by sheet position. Sorting and backfill make positional dedupe unsafe.

# 27. Transaction Data Quality

The system should continuously monitor the ledger for:

- duplicate candidates
- missing categories
- unknown merchants
- missing references
- impossible zero amounts
- invalid dates
- unexpected transaction types
- SMS/email conflicts
- unverified source records
- stale mappings
- unexplained balance anomalies when balance data exists

Expose these as a compact review queue.

Example:

```text
12 transactions need attention

5 Unknown Merchant
3 SMS/Email Conflict
2 Missing Purpose
1 Possible Duplicate
1 Low Confidence
```

This is much more useful than manually scanning the entire ledger.

## Nightly invariant checks

Write results into `Data Quality` and notify only on breach:

- no duplicate Transaction ID
- no duplicate Source Hash
- Type belongs to the allowed enum
- Category exists in `Categories`
- amount sign is consistent with Type
- Monthly Summary reconciles to Transaction Log for the same period
- Card Cycle Summary reconciles purchases to bill payments within tolerance
- `Needs Review=TRUE` always has a nonblank `Review Reason`
- schema version and headers match
- script and spreadsheet timezones agree
- no unexpected parse failures

These checks are part of the financial system, not optional monitoring.

---

# 28. Recommended Sheets

Target workbook:

```text
Transaction Log
Source Log
Daily Summary
Weekly Summary
Monthly Summary
Category Summary
Merchant Summary
Recurring Summary
Card Cycle Summary
Account Flow
Anomalies
Data Quality
Review Queue
Merchant Rules
Category Rules
Categories
Suggestion Rules
CONFIG
Change Log
```

Separate `Accounts` and `Cards` sheets may remain if they simplify configuration.

A sheet should exist because it improves automation, makes a derived metric reusable, or creates a bounded AI retrieval surface—not merely because a metric exists.

# 29. Daily Summary

# 29. Daily Summary

Daily summary is useful because Gemini can create better weekly charts without repeatedly aggregating hundreds of raw rows.

Recommended fields:

```text
Date
Income
Net Consumption Expense
Investments
Card Payments
Net Cash Surplus
Transaction Count
Average Transaction
Largest Transaction
Top Category
Top Merchant
Recurring Spend
```

The Daily Summary is derived automatically.

No manual entry.

---

# 30. Weekly Summary

Recommended fields:

```text
Week Start
Week End
Income
Net Consumption Expense
Investments
Card Payments
Cash Surplus
Transaction Count
Average Daily Spend
Average Transaction
Largest Transaction
Top Category
Top Merchant
Recurring Spend
Non-Recurring Spend
Previous Week Change
```

Again, these are derived values.

---

# 31. Monthly Summary

The current Monthly Summary contains useful core metrics:

```text
Month
Income
Expenses
Net Cash
Credit card payments
Housing & Utilities
Food & Dining
Shopping
Bills & subscription
Transportation
Healthcare
Investment & savings
Cash
Miscellaneous
Savings Rate
Expense Ratio
MoM Expense Change
Financial Health
```

Keep the existing high-level structure, but extend it carefully.

## Recommended additional metrics

```text
Essential Expense        [do not auto-infer unless user provides a reliable rule]
Discretionary Expense    [do not auto-infer unless user provides a reliable rule]
Recurring Expense
Investment Rate
Cash Surplus
Cash Surplus Rate
Wealth Retention Rate
Transaction Count
Average Daily Spend
Average Transaction
Largest Transaction
Top Merchant
Top Category %
Income MoM Change
Savings/Wealth MoM Change
3M Expense Trend
Verification Coverage
Review Queue Count
```

Because Essential/Discretionary cannot reliably be extracted from a bank alert, keep them optional and rule-driven rather than pretending they are source facts.

The system should prioritize automatically obtainable metrics.

---

# 32. Financial Metric Definitions

Use transparent definitions.

## Net Consumption Expense

```text
Sum of expense transactions
minus qualifying refunds
```

Card bill payments, internal transfers, and investments are not consumption expenses.

## Investment Rate

```text
Investment / Income
```

## Expense Ratio

```text
Net Consumption Expense / Income
```

## Cash Surplus

```text
Income
- Net Consumption Expense
- Investments
```

## Cash Surplus Rate

```text
Cash Surplus / Income
```

## Wealth Retention Rate

```text
Investment Rate + Cash Surplus Rate
```

Equivalent to:

```text
1 - Expense Ratio
```

assuming all relevant income and investment/consumption flows are fully captured.

## MoM Expense Change

```text
(Current Month Net Consumption Expense
 - Previous Month Net Consumption Expense)
 / Previous Month Net Consumption Expense
```

## Verification Coverage

```text
Verified Transactions / Transactions in the reporting period
```

This is a data-quality metric, not a financial metric.

---

# 33. Google Sheets Formula Strategy

Use formulas for deterministic calculations and Apps Script for enrichment/state changes.

Do not ask Gemini to recalculate deterministic totals if the sheet already contains authoritative formulas.

Examples assume the **current target schema**:

- `Transaction Log!B:B` = DateTime
- `Transaction Log!C:C` = Amount
- `Transaction Log!G:G` = Category
- `Transaction Log!J:J` = Type

Prefer header-driven formulas, named ranges, or helper tables where possible. Do not silently depend on column positions if the workbook is migrated.

## Total income

```gs
=SUMIFS('Transaction Log'!$C:$C,'Transaction Log'!$J:$J,"income")
```

## Net consumption expense

```gs
=-SUMIFS('Transaction Log'!$C:$C,'Transaction Log'!$J:$J,"expense")
-SUMIFS('Transaction Log'!$C:$C,'Transaction Log'!$J:$J,"refund")
```

The refund term reduces net consumption because refunds are positive inflows.

## Investment amount

```gs
=-SUMIFS('Transaction Log'!$C:$C,'Transaction Log'!$J:$J,"investment")
```

## Credit-card payments

```gs
=-SUMIFS('Transaction Log'!$C:$C,'Transaction Log'!$J:$J,"card_payment")
```

## Expense ratio

```gs
=IFERROR(NetConsumptionExpense/Income,0)
```

## Investment rate

```gs
=IFERROR(Investment/Income,0)
```

## Cash surplus

```gs
=Income-NetConsumptionExpense-Investment
```

The final workbook should use named ranges or helper tables where possible instead of long repeated formulas.

---

# 34. Merchant Summary

Create a derived `Merchant Summary` table.

Recommended columns:

```text
Month
Merchant Normalized
Category
Transaction Count
Total Spend
Average Transaction
Largest Transaction
Recurring
Previous Month Spend
Change %
```

This enables much stronger analytics than the raw category summary.

Gemini can answer questions such as:

- Which merchants consume the most money?
- Which merchants are growing fastest?
- Which merchants repeatedly appear in small transactions?
- Which recurring merchants have increased cost?
- What percentage of consumption is concentrated in the top 5 merchants?

---

# 35. Recurring Summary

Create a derived `Recurring Summary` table.

Recommended columns:

```text
Merchant
Normalized Merchant
Category
Typical Amount
Frequency
Last Paid
Next Expected
Annualized Cost
Confidence
Status
```

This turns recurring detection into actual financial intelligence.

Examples:

```text
Rent
Home Loan
Airtel
Internet
Streaming subscriptions
Insurance
Software
```

A recurring summary can answer:

> How much of my income is already structurally committed each month?

---

# 35A. Scalability and performance

The workbook is intended to remain useful as transaction volume grows.

## Repository boundary

Only `Repository.gs` calls `SpreadsheetApp`. This makes future storage replacement possible without rewriting services or AI tools.

## Read/index strategy

- Maintain a `Txn ID → row` cache/index.
- Maintain a compact `Review Queue` so pending-review reads do not scan the whole ledger.
- Query by date/ID filters, not row position.

## Configuration cache

Do not read full `Merchant Rules`, `Category Rules`, `Suggestion Rules`, and CONFIG on every transaction. Cache them using `CacheService` with a configuration-version key. Invalidate on config edit.

## Writes

Prefer batch `setValues` for ingestion/derived-table rebuilds rather than one `appendRow` per record when multiple records are available.

## Derived analytics rebuild

Nightly jobs rebuild the current and dirty periods only. Historical `rebuildAll(from,to)` runs month-by-month with a continuation token to stay inside Apps Script execution limits.

## Growth path

At larger volumes, partition the ledger by year behind Repository. Beyond a practical Sheets scale (for example ~50k transaction rows), the same Repository interface can later move storage to BigQuery/Firestore without changing the classification or AI layers.


## Derived-table metadata

Every materialized analytics table should carry `Generated At`, `Definition Version`, and `Row Count` so Gemini can distinguish current, stale, and partial data.

# 36. Rich Analytics — Weekly

The weekly report must not be a simple list of totals.

It should explain:

> **What changed? Why did it change? What should I do?**

## Recommended visualizations

### 1. Daily Spending Trend

Line/column chart for spending by day.

Purpose:

- identify spending spikes
- identify high-spend days
- compare weekday/weekend patterns

### 2. Category Mix

Bar/donut chart of net consumption by category.

### 3. Current Week vs Previous Week

Comparison chart of major categories or total consumption.

### 4. Recurring vs Non-Recurring

Compare structural recurring spending with other spending.

### 5. Payment Instrument Mix

UPI vs credit card vs debit card vs wallet vs bank transfer where meaningful.

### 6. Top Merchants

Top merchants by spend for the week.

### 7. Weekday Pattern

Spending grouped by day of week when enough history exists.

### 8. Small Purchase Accumulation

Highlight high-frequency, low-ticket purchases that materially add up.

Do not generate every chart every week. Choose charts with sufficient data and analytical value.

---

# 37. Rich Analytics — Monthly

The month-end report should be a personal financial analyst's review, not a spreadsheet transcription.

## Recommended visualizations

### 1. Income vs Consumption vs Investments

Monthly trend chart.

### 2. Cash Surplus Trend

Line chart showing monthly remaining cash after consumption and investment.

### 3. Expense by Category Over Time

Stacked columns or equivalent.

### 4. Savings / Wealth Retention Trend

Show investment rate, cash surplus rate, or equivalent defined metric.

### 5. Merchant Concentration

Show top merchants and top-merchant share.

### 6. Recurring Commitment Trend

Show recurring spending over time.

### 7. Transaction Frequency

Count transactions per month and average transaction value.

### 8. Day-of-Week Spending Pattern

Use transaction DateTime to show where spending tends to occur.

### 9. Payment Instrument Trend

Show UPI/card/wallet/bank payment mix over time.

### 10. Verification / Data Quality

Show percentage verified vs single-source vs conflicts.

Again, use the charts that expose a meaningful pattern rather than forcing a fixed chart count.

---

# 38. High-Value Analytics That Require No Extra Manual Data

The existing DateTime, Amount, Merchant, Category, Type, Instrument, Counterparty, Ref No, Recurring, and User Notes fields already enable these analyses:

## Spending velocity

How fast current-month consumption is accumulating compared with typical pace.

## Daily spending distribution

Which days generate most expenditure.

## Weekend vs weekday behavior

Useful for detecting lifestyle spending patterns without asking the user to label transactions.

## Transaction frequency

How often spending occurs, not just how much.

## Average ticket size

Whether the user is making fewer large purchases or many small purchases.

## Small-purchase accumulation

Frequent low-value spending that becomes material in aggregate.

## Merchant concentration

What percentage of total spending is concentrated among a small number of merchants.

## Category momentum

Categories increasing faster than the overall expense base.

## Recurring burden

Monthly recurring financial commitments and annualized cost.

## Refund behavior

Refund volume and categories where refunds occur.

## Payment-method mix

UPI vs card vs wallet vs bank transfer.

## Verification quality

How much of the ledger is corroborated by multiple sources.

## Review burden

How many records still require human clarification.

These are more valuable than adding speculative transaction attributes that cannot be reliably extracted.

---

# 39. Optional Anomaly Detection

An anomaly is not simply a large transaction.

A transaction should be considered noteworthy when it is unusual relative to the user's own history or materially important.

Useful anomaly signals:

- amount materially above merchant baseline
- category spike
- unusual merchant
- unusual frequency
- sudden increase in recurring cost
- unusual payment method
- transaction outside usual time/day pattern
- duplicate suspicion
- source conflict

Do not use a generic fixed threshold for every merchant/category.

A ₹10,000 rent payment may be normal.

A ₹10,000 restaurant charge may be anomalous.

Analytics should compare against the user's own history whenever enough history exists.

---

# 40. Weekly Finance Prompt — Final Version

```text
Review my Google Drive personal finance spreadsheet using the Transaction Log, Daily Summary, Weekly Summary, Monthly Summary, Merchant Summary, and Recurring Summary sheets when available.

This is a WEEKLY FINANCIAL INTELLIGENCE REVIEW, not a basic spending summary.

Analyze the most recent completed 7 days and compare it with the previous 7 days and recent history when enough data exists.

Do not merely repeat totals already present in the spreadsheet. Use the Transaction Log to discover patterns that summary tables cannot show directly.

ACCOUNTING RULES
- Treat credit-card purchases as expenses.
- Treat payment of a credit-card bill as card_payment, not a second expense.
- Treat internal transfers as transfers, not income or expense.
- Treat investments separately from consumption.
- Apply refunds against consumption when appropriate.
- Do not double-count transactions across sources.

REPORT:

💰 WEEK AT A GLANCE
Show total income, net consumption expense, investments, cash surplus, transaction count, and average daily spending.

📊 VISUAL ANALYSIS
Create meaningful charts when sufficient data exists.
Prefer:
1. Daily spending trend
2. Category spending mix
3. Current week vs previous week
4. Recurring vs non-recurring spending
5. Top merchants
6. Payment instrument mix
7. Weekday spending pattern

Do not create a chart merely because a chart is possible. Every chart must answer a useful financial question.

🔎 WHAT CHANGED?
Identify the 3 most meaningful changes from the previous week or recent baseline.
Explain what changed and why it matters.

🚨 ANOMALIES
Look for genuinely unusual transactions or patterns relative to my own history.
Do not flag a transaction only because it is large.

🧠 BEHAVIOR INSIGHT
Identify one important spending behavior visible in the data.

🎯 ONE DECISION
Give me exactly ONE practical action for next week based on the data.

📌 DATA QUALITY
Report any important data problems such as SMS/email conflicts, duplicate candidates, missing categories, or unusually incomplete data.

If nothing meaningful changed, say so instead of manufacturing a problem.

Keep commentary concise but make the visual analysis rich.
```

---

# 41. Month-End Finance Prompt — Final Version

```text
Review my Google Drive personal finance spreadsheet using the Transaction Log, Daily Summary, Monthly Summary, Merchant Summary, and Recurring Summary sheets when available.

This is a MONTH-END FINANCIAL ANALYSIS, not a basic monthly summary.

Analyze the most recently completed month and compare it with previous months wherever enough history exists.

Use the existing Monthly Summary calculations as the source of truth for deterministic metrics.
Use the Transaction Log to discover deeper patterns that the summary cannot show directly.

ACCOUNTING RULES
- Credit-card purchases = expense.
- Credit-card bill payments = card_payment and must not be counted again as consumption expense.
- Internal transfers are not income or consumption expense.
- Investments are separate from consumption.
- Refunds reduce net consumption where appropriate.
- Do not double-count multi-source transactions.

📊 EXECUTIVE SCORECARD
Show:
- Income
- Net consumption expense
- Investments
- Cash surplus
- Savings/wealth retention rate as defined by the workbook
- Expense ratio
- Month-over-month expense change
- Verification coverage
- Review queue count

📈 CREATE A RICH VISUAL DASHBOARD
Use charts only when useful and data is sufficient.
Prefer:
1. Income vs consumption vs investments over time
2. Cash surplus trend
3. Category expense trend
4. Savings/wealth retention trend
5. Merchant concentration
6. Recurring spending trend
7. Transaction frequency and average ticket size
8. Day-of-week spending pattern
9. Payment instrument trend
10. Verification/data-quality coverage

🔬 DEEP ANALYSIS
Answer:
1. Where did my money actually go?
2. Which categories changed the most?
3. Which merchants changed the most?
4. What recurring commitments are growing?
5. Are many small transactions accumulating into a meaningful amount?
6. Did transaction frequency or average transaction size change?
7. Is spending becoming concentrated in fewer merchants/categories?
8. Is cash surplus improving or deteriorating?
9. Is investment allocation improving or deteriorating?
10. What is the most important financial risk or opportunity visible in the data?

🚨 ANOMALIES & RISKS
Flag only meaningful anomalies relative to my own history.

🧠 FINANCIAL BEHAVIOR
Describe one meaningful behavior pattern.
Be direct. Do not praise ordinary behavior or manufacture a problem.

🎯 NEXT MONTH
KEEP: One behavior worth continuing.
CHANGE: One behavior worth changing.
ONE MONEY MOVE: One specific action with the highest practical impact.

📌 DATA QUALITY
Mention meaningful gaps, conflicts, duplicate candidates, or incomplete data.

Do not simply restate the Monthly Summary.
Interpret relationships, trends, and behavior.
```

---

# 42. Month-End Review Queue

At month end, the system should produce a compact exception list.

Example:

```text
MONTH-END DATA QUALITY

842 transactions processed
816 verified or single-source accepted
14 conflicts
7 unknown merchants
3 possible duplicates
2 missing purposes

REVIEW REQUIRED: 26
```

The human review should focus only on these records.

This preserves the low-intervention goal.

---

# 43. Account and Card Mapping

The parser should not try to understand the user's internal naming conventions beyond what the alert clearly shows.

Apps Script/CONFIG should map masked identifiers to friendly internal names.

Example:

```text
XX8899 → Axis Savings
XX5178 → Axis Airtel Credit Card
```

Avoid storing full account/card numbers.

Use masked identifiers / last four digits only where necessary for reconciliation.

---

# 44. Suggestion Rules

Keep a configurable `Suggestion Rules` table.

Recommended conceptual fields:

```text
Enabled
Match Type
Amount
Merchant Contains
Normalized Merchant
Category
Subcategory
Merchant Override
Notes Template
Month Offset
Type Override
Recurring Override
Account Override
Card Name Override
```

The system should use these rules before asking the user.

Example:

```text
Merchant = Netflix
→ Category = Bills & subscription
→ Subcategory = Streaming
→ Recurring = TRUE
```

Another:

```text
Merchant = SBI Home Loan
→ Category = Housing & utilities
→ Subcategory = Home Loan
→ Recurring = TRUE
```

---

# 44A. Data-driven policy engine and learning loop

Move routine classification policy out of `.gs` and into configuration data. This is the highest-leverage maintenance improvement.

## Merchant Rules

Recommended fields:

```text
Rule ID
Enabled
Match Mode
Pattern
Canonical Merchant
Category
Subcategory
Type Override
Account Override
Card Override
Recurring Override
Priority
Specificity
Hit Count
Last Hit
```

## Category Rules

```text
Rule ID
Enabled
Scope (merchant|text)
Pattern
Category
Subcategory
Priority
```

## Categories

```text
Category
Subcategory
Enabled
Is Consumption
Is Investment
Sort Order
```

These flags should drive analytics instead of hardcoding category meaning in many formulas/functions.

## Evaluation order

```text
rules
→ priority desc
→ specificity desc
→ first applicable rule per output field
→ record Rules Applied
```

Rules should be cached for a short TTL (for example 6 hours) and invalidated when the CONFIG/rules version changes.

## Learning loop

Weekly:

1. Read `Change Log` rows where `Actor=user` and the changed field is `merchant`, `category`, `subcategory`, or `type`.
2. Group repeated corrections by normalized merchant/pattern.
3. When the same correction occurs at least N times with no contradiction, create a `PROPOSED` rule.
4. Notify once with the number of proposed rules.
5. The user activates a proposed rule by changing `Enabled` from `PROPOSED` to `Y`.
6. Rules with zero hits for 180 days can be proposed for deactivation.

This turns manual correction into a self-improving rule system without allowing the model to silently rewrite production policy.

# 45. Manual Entry

Manual transaction entry remains supported for edge cases.

Manual entry should use the same canonical Transaction Log schema.

Mark:

```text
Source Type = MANUAL
```

and store the original manual payload in `Source Log` where practical.

Manual entry should never create a separate analytical data model.

---

# 45A. Change Log and auditability

Every mutation should write one Change Log record per changed field.

```text
Change ID
Transaction ID
Changed At
Actor (user|rule|system|agent)
Field
Old Value
New Value
Reason
Request ID
```

`Txn ID` is the durable identity; sheet row number is never the long-term identity.

---

## updateTransaction safety

Updates must use:

```text
transactionId + patch + reason + requestId
```

The server validates a patch against an allowlist of mutable fields, acquires a lock, reads the canonical row, applies the patch, updates `Last Updated At`, and writes one Change Log record per changed field.

Never use a sheet row number as the durable identifier.

# 46. API / Apps Script Contract

The transport may remain an Apps Script web app, but the internal interface should be a typed tool layer.

## Tool definition

```text
name
description
inputSchema
outputSchema
sideEffects
authScope
handler
```

## Core tools

`ingestSource` — ingest one SMS/email source with source metadata and idempotency key.

`getTransaction` — retrieve one canonical transaction by `Txn ID`.

`getTransactions` — bounded filtered retrieval with date range, field projection, limit, and cursor.

`getPeriodOverview` — deterministic period metrics.

`getCategoryTrend` — category history.

`getMerchantTrend` — merchant history.

`getRecurringCommitments` — recurring candidates/confirmed commitments.

`getAnomalies` — deterministic anomaly records with baseline/evidence.

`getReviewQueue` — unresolved human-review items.

`getEvidence` — raw source evidence for a specific transaction.

`updateTransaction` — audited allowlisted patch by `Txn ID`.

`verifyTransaction` — run/re-run source reconciliation.

`proposeChange` / `commitChange` — future safe agentic writes.

## Bounded retrieval

Every read enforces a maximum date range, maximum row count, explicit field projection, and cursor pagination for detail reads.

Never send the full ledger to Gemini by default.

Every request carries a `requestId`; every write carries an `idempotencyKey`.

## Standard error envelope

Errors must be machine-readable:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_CATEGORY",
    "field": "category",
    "allowedValues": ["Food & dining"],
    "remediation": "retry with an allowed value"
  },
  "requestId": "REQ-..."
}
```

Do not expose raw stack traces or implementation details to the caller.

# 47. AI-ready API Responses

When a Shortcut or AI client requests an overview, Apps Script should return precomputed facts, not a giant raw ledger.

Every read response carries provenance.

```json
{
  "data": {
    "month": "2026-10",
    "income": 100000,
    "netConsumptionExpense": 62000,
    "investment": 20000,
    "cashSurplus": 18000,
    "expenseRatio": 0.62,
    "investmentRate": 0.20,
    "verificationCoverage": 0.94,
    "reviewCount": 4
  },
  "provenance": {
    "from": "2026-10-01",
    "to": "2026-10-07",
    "rowCount": 42,
    "definitionVersion": "v1",
    "summaryGeneratedAt": "2026-10-07T23:00:00+05:30",
    "transactionIds": [],
    "completeness": "full"
  },
  "requestId": "REQ-..."
}
```

The principle is:

> **Apps Script provides deterministic facts and provenance; Gemini provides interpretation.**

`completeness` must be explicit so an AI client cannot mistake a truncated result for a complete population.

---

# 48. Data Quality Rules for Gemini

Gemini should treat the following hierarchy as authoritative:

1. deterministic summary formulas
2. normalized Transaction Log
3. Source Log for evidence when needed
4. AI interpretation

Never let an AI-generated narrative overwrite a deterministic ledger value.

Gemini should not recalculate values differently from the sheet unless explicitly asked to audit the formula.

When a conclusion depends on incomplete data, say so.

---

# 49. Charting Philosophy

Charts are not decorations.

A chart is justified only if it answers one of these questions:

- What changed?
- Where did the money go?
- What is growing?
- What is unusually high?
- What is recurring?
- How does this compare with history?
- Is financial behavior improving?
- Is the data trustworthy?

Avoid:

- duplicate pie charts
- charts of one-off metrics with no comparison
- overly dense dashboards
- charts that merely restate one number
- projections based on insufficient history

Prefer line charts, grouped/stacked columns, ranked bars, and compact KPI cards where appropriate.

---

# 50. Agentic Behavior

The system becomes meaningfully agentic when it can make stateful decisions about what to do next.

## Event-driven

```text
Transaction arrives
→ capture
→ classify
→ deduplicate
→ enrich
→ verify
→ request clarification only if needed
```

## Exception-driven

```text
Conflict detected
→ Needs Review
```

```text
Possible duplicate detected
→ Needs Review
```

```text
Unknown merchant
→ ask user purpose
```

## Periodic

### Daily

No routine spending lecture.

### Weekly

Review behavior, changes, anomalies, and one action.

### Monthly

Review trends, structural costs, cash surplus, investment behavior, and one change for the next month.

This cadence avoids notification fatigue.

---

# 51. Recommended Automation Cadence

| Routine | Frequency | Main purpose |
|---|---|---|
| Transaction ingestion | Event-driven | Capture eligible alerts |
| SMS/email reconciliation | Event-driven + delayed check | Link secondary sources |
| Review Queue refresh | Event-driven / periodic | Surface unresolved records only |
| Analytics rebuild | Nightly | Refresh current and dirty derived periods |
| Weekly Money Intelligence | Weekly | Behavior, anomalies, trends, one action |
| Month-End Financial Intelligence | Monthly | Structural trends and decisions |
| Rule-learning proposal | Weekly | Turn repeated user corrections into proposed rules |
| Data-quality audit | Nightly | Detect regressions and capture gaps |

A daily spending lecture is deliberately excluded. Use exception-driven alerts for materially important anomalies or conflicts.

# 52. Migration Plan from Current Schema

Migration is incremental and reversible. Append new columns first, migrate callers, validate, then remove legacy paths.

## Phase 0 — backup and freeze
1. Duplicate production spreadsheet.
2. Redact representative SMS/email fixtures.
3. Record legacy headers.
4. Set a schema-version cell in CONFIG.

## Phase 1 — correctness blockers
Fix the P0/P1 findings from the review before trusting analytics: investment keyword false positives, unknown positive inflows forced to income, card purchase/payment confusion, heuristic override precedence, false-positive duplicate rejection, non-editable Type, manual type limitation, positional newest-row assumptions, timezone drift, unsafe number parsing, merchant/category matcher false positives, dead internal-transfer config, and non-additive CONFIG rules.

## Phase 2 — pure classifier + tests
Create `Classify.gs` and maintain at least 100 redacted real-message fixtures.

## Phase 3 — repository boundary + file split
Make `Repository.gs` the only SpreadsheetApp boundary; add schema assertions and lazy access.

## Phase 4 — Source Log + identity
Add Source Log, source hashing, Source IDs, Match Key/candidate lookup, and idempotent ingestion.

## Phase 5 — verification + review
Add verification states, reference-first matching, fallback matching with time tolerance, order-independent SMS/email reconciliation, and separate verification from review.

## Phase 6 — policy in data
Move merchant mappings, category rules, taxonomy, account/card mappings, and suggestion rules into sheets. Add cache/versioning.

## Phase 7 — clarification + learning
Ask purpose only when needed; update the same Txn ID; audit user corrections; propose repeated corrections as configuration rules for explicit approval.

## Phase 8 — materialized analytics
Build Daily, Weekly, Monthly, Category, Merchant, Recurring, Card Cycle, Account Flow, Anomaly, Data Quality, and Review Queue tables. Rebuild current and dirty periods nightly; support chunked historical backfill.

## Phase 9 — AI tools
Add bounded retrieval, field projections, and provenance.

## Phase 10 — safe agentic writes
Add dry-run/propose/commit, request IDs, idempotency, authentication, rate limits, and replay protection.

# 53. Backward Compatibility

# 53. Backward Compatibility

Existing legacy pipe formats may remain accepted temporarily:

### Legacy 5-field

```text
datetime | signed_amount | bank | account_type | merchant
```

### Current 9-field

```text
datetime | signed_amount | bank | account_type | instrument | type | merchant | counterparty | ref_no
```

### Target 10-field

```text
datetime | signed_amount | bank | account_type | instrument | type | merchant | counterparty | ref_no | balance_after
```

Apps Script should normalize all accepted formats into the same canonical transaction object.

During migration, legacy formats may be accepted behind an explicit compatibility flag. Production clients should send `formatVersion=10` outside the pipe payload. After migration, reject unversioned legacy input. Do not add a version as an extra pipe field.

---

# 54. Testing Strategy

## Parser tests

Maintain examples for:

- UPI expense
- UPI transfer
- credit-card purchase
- credit-card bill payment
- SIP
- salary
- interest
- cashback
- refund
- completed reversal
- failed transaction
- pending transaction
- OTP
- promotional message
- balance-only message
- message with multiple monetary values
- email with subject + body disagreement
- message containing customer-care numbers
- message containing masked account/card numbers

## Reconciliation tests

Test:

- SMS first → email second
- email first → SMS second
- exact ref match
- fallback match with no ref
- no secondary source
- SMS/email conflict
- duplicate SMS
- duplicate email
- different transactions with same amount/merchant

## Data-quality tests

Test:

- invalid amount
- invalid date
- missing category
- missing merchant
- unknown source
- formula break
- missing summary row
- duplicate Transaction ID
- duplicate Source Hash
- unclassified Type
- invalid Category enum
- sign/Type inconsistency
- summary/ledger mismatch
- card-cycle reconciliation gap
- `Needs Review=TRUE` with blank Review Reason
- timezone/schema mismatch

---

# 55. Example End-to-End Flow

## Input

```text
30-09-2026 Dear Customer, your A/c no. XX has been debited with INR 2638.00 on 30-09-26 00:35:26 IST by IMPS/P2A/627300614841/ASISHKUM. Call 18001035577.
```

## Gemini output

```text
2026-09-30 00:35:26 | -2638.00 | Axis | Savings Account | IMPS | transfer | ASISHKUM | ASISHKUM | 627300614841 | NA
```

## Apps Script enrichment

```text
Txn ID: 202609-XXX
Type: transfer
Merchant: ASISHKUM
Merchant Normalized: ASISHKUM
Category: Miscellaneous / Transfer rule
Verification: Pending
Needs Review: possibly TRUE if purpose is required
```

The system may ask:

> What's this transfer for?

User response:

> Sent to mom

Apps Script updates the same transaction:

```text
User Notes: Sent to mom
Category/Subcategory: based on configured personal-transfer rule
Needs Review: FALSE
```

If the email arrives later with the same UTR:

```text
Verification Status: Verified
Verification Source: SMS+Email
Source Count: 2
```

---

# 56. What the final system should be able to answer

Once enough history exists, Gemini should be able to answer questions such as:

### Spending

- Where did my money go this month?
- Which category increased the most?
- Which merchant increased spending the most?
- What are my top 10 merchants?
- Are small transactions adding up?

### Behavior

- Am I spending more often or simply spending larger amounts?
- Has weekend spending increased?
- Which categories are becoming more frequent?
- Which merchants are becoming more important in my total spending?

### Recurring

- What are my recurring monthly commitments?
- What is the annualized recurring cost?
- Which recurring costs changed?

### Cash flow

- Is my cash surplus improving?
- What percentage of income is consumed vs invested?
- Is my financial position improving month over month?

### Data quality

- How much of my ledger is verified?
- Which transactions have conflicts?
- Which transactions still require user input?
- Where are possible duplicates?

### Decision support

- What is the single biggest financial change I should make next month?
- What changed this month that deserves my attention?

These questions are the reason for the data model.

---

# 57. What NOT to Build Yet

Do not add these until the underlying ledger is proven reliable:

- complicated machine-learning forecasting
- budgets for every category
- automatic essential/discretionary classification without user-backed rules
- automatic planned/unplanned classification
- portfolio analytics inside the transaction engine
- daily financial nag notifications
- dozens of dashboards
- overly granular categories
- manually maintained attributes that could become stale

First make the ledger correct and low-maintenance.

Then make the analytics rich.

---

# 58. Success Criteria

The system is successful when:

### Capture

- transaction alerts are logged without manual entry
- the parser rejects noise reliably
- credit-card purchases and bill payments are separated correctly

### Identity

- SMS and email never create duplicate financial events
- multiple sources attach to one Transaction ID

### Verification

- matching sources become `Verified`
- disagreements become `Conflict`
- source absence does not become an error

### Clarification

- the system asks the user only when it genuinely lacks context
- one user response enriches the existing transaction

### Data quality

- the unresolved queue remains small
- review reasons are explicit

### Analytics

- weekly reviews reveal behavior, not just totals
- monthly reviews reveal trends, structure, and decisions
- charts answer questions rather than decorate the report

### Maintenance

- adding a new bank or merchant mostly requires configuration/rules rather than rewriting the entire system

---

# 59. Final Target Model

```text
                    ┌──────────────┐
                    │ SMS / EMAIL  │
                    └──────┬───────┘
                           ↓
                    ┌──────────────┐
                    │    Gemini    │
                    │   Parser     │
                    └──────┬───────┘
                           ↓
                 10-field strict pipe
                           ↓
                    ┌──────────────┐
                    │ Apps Script  │
                    └──────┬───────┘
                           ↓
              ┌─────────────────────────┐
              │ Normalize + Match +    │
              │ Enrich + Deduplicate   │
              └───────────┬─────────────┘
                          ↓
              ┌─────────────────────────┐
              │   Transaction Log       │
              │   canonical ledger      │
              └──────┬──────────┬───────┘
                     │          │
          clarification          │ verification
                     │          │
                     ↓          ↓
               User context   Source Log
                     │          │
                     └────┬─────┘
                          ↓
                clean historical data
                          ↓
        ┌─────────────────┼────────────────┐
        ↓                 ↓                ↓
   Daily Summary     Weekly Summary   Monthly Summary
        │                 │                │
        └──────────────┬──┴────────────────┘
                       ↓
              Merchant / Recurring
                    Analytics
                       ↓
                  Gemini Analyst
                       ↓
              charts + trends +
              anomalies + decisions
```

---

# 60. Final Principle

The system should behave like this:

> **The machine records what happened.**
>
> **The second source proves what happened.**
>
> **The user explains only what the machine cannot know.**
>
> **The ledger remembers the evidence.**
>
> **The analytics layer finds what matters.**

The end product is not a spreadsheet full of transactions.

It is a **reliable personal financial history that requires almost no manual maintenance and can support meaningful financial intelligence over months and years.**

---

# 61. Future Memory and RAG Architecture

This is a future extension, not a prerequisite for the reliable ledger. The architecture is intentionally compatible with a memory/RAG layer.

## Fact memory
`Transaction Log` answers: **what happened?**

## Evidence memory
`Source Log` answers: **what did the bank/email actually say?**

## Derived memory
A future `Insights` table can store durable observations linked to period and evidence:

```text
Insight ID
Created At
Topic
Period
Observation
Confidence
Evidence References
Definition Version
```

## User memory
A future context layer may store explicit goals, decisions, and preferences. These must never be treated as facts extracted from a bank alert.

## Structured RAG first

```text
Question
  ↓
intent/entity/date extraction
  ↓
structured filters
  ↓
derived summaries + targeted transactions
  ↓
provenance/evidence
  ↓
Gemini reasoning
```

Do not dump the full workbook into Gemini. Deterministic retrieval is cheaper, more precise, and easier to audit.

## Hybrid RAG later

If unstructured memory grows large—notes, evidence, receipts, decisions, insights—semantic retrieval/embeddings can be added for those materials. The ledger remains the source of truth; a vector index is an index, not the accounting database.

## Apple Intelligence front end

Long term, Apple Intelligence/Shortcuts can provide one conversational interface while Apps Script remains the deterministic control plane and Gemini remains the reasoning layer.

Example questions:
- How much did I spend at Amazon this year?
- Why was this month more expensive?
- Which recurring commitments increased?
- What is the biggest financial risk visible in my history?
- What happens if I reduce food delivery by 30%?

## Safe agentic writes

```text
proposeChange
    ↓
show effect + evidence
    ↓
user confirmation
    ↓
commitChange(token)
```

# Appendix 0 — Review Decisions Incorporated

The review is treated as a correctness review. The final design incorporates:

- P0 classification and duplicate issues as analytics blockers.
- merchant/category/account policy in sheets with caching.
- source evidence separated from the analytical ledger.
- verification state separated from human review state.
- probable duplicates flagged rather than silently rejected.
- Transaction-ID-based locked/audited updates.
- materialized/rebuildable analytics instead of last-row read-time calculations.
- bounded AI retrieval with provenance.

Deliberate practical decisions:

1. `Source Hash` remains source-level because one transaction may have several evidence sources.
2. `Essentiality`, `Planned`, and `Reimbursable` are not automatic parser facts.
3. `balance_after` ships only with parser + server validation together.
4. Version metadata is outside the 10-field pipe payload (`formatVersion=10`).
5. Sheets remain the current durable source of truth; future semantic memory is additive.

# 62. Implementation Checklist

Before calling the system production-ready, verify:

### Correctness
- [ ] all P0 type and dedupe issues fixed
- [ ] valid model type cannot be overwritten by heuristic
- [ ] unknown inflows remain unresolved instead of becoming income
- [ ] credit-card purchase/payment separation tested

### Identity and evidence
- [ ] source hashing is idempotent
- [ ] one Transaction ID can own multiple Source IDs
- [ ] reference-first reconciliation works in both arrival orders
- [ ] source conflicts are preserved, not overwritten

### Human intervention
- [ ] obvious transactions require no question
- [ ] ambiguous transactions ask one concise question
- [ ] user answer updates the same Transaction ID
- [ ] all mutations create Change Log records

### Analytics
- [ ] derived tables rebuild correctly
- [ ] summary totals reconcile to ledger
- [ ] recurring and anomaly detectors have explainable rules
- [ ] weekly/monthly Gemini charts are based on bounded, deterministic data

### AI/agent readiness
- [ ] tool registry has input/output schemas
- [ ] read responses include provenance and completeness
- [ ] raw evidence is retrieved only deliberately
- [ ] agent writes require propose/commit

## Appendix A — Current Transaction Log to Target Mapping

| Current field | Target field | Action |
|---|---|---|
| Transaction ID | Txn ID | Keep |
| DateTime | DateTime | Keep |
| Amount | Amount | Keep |
| Bank | Bank | Keep |
| Account Type | Account Type | Keep |
| Merchant | Merchant | Keep |
| Category | Category | Keep |
| User Notes | User Notes | Keep |
| Original Text | Source Log.Raw Body | Move out of analytical table |
| Type | Type | Keep |
| Instrument | Instrument | Keep |
| Account | Account | Keep |
| Card Name | Card Name | Keep |
| Is Recurring | Is Recurring | Keep, system-derived |
| Needs Review | Needs Review | Keep, but change logic |
| Counterparty | Counterparty | Keep |
| Ref No | Ref No | Keep |
| Balance After | Balance After | Keep and actually populate when explicit |
| — | Match Key | Add |
| — | Merchant Normalized | Add |
| — | Subcategory | Add |
| — | Parser Confidence | Add/system-derived |
| — | Verification Status | Add |
| — | Verification Source | Add |
| — | Verified At | Add |
| — | Review Reason | Add |
| — | Source Count | Add |
| — | First Seen At | Add |
| — | Last Updated At | Add |

---

## Appendix B — Practical Rule of Thumb

Whenever considering a new field, ask:

1. **Can the source reliably provide it automatically?**
2. **Will it materially improve reconciliation or analytics?**
3. **Can it be derived later instead of manually stored?**

If the answer is no, do not add it.

The system should remain **small at ingestion and rich at analysis**.
