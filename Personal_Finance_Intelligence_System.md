# Personal Finance Intelligence System

> A personal financial memory system: capture reliable events first, let the user correct them easily, and add retrieval, reasoning, and proactive help in small safe steps.

**Status:** rewritten implementation plan, October 2026
**Primary objective:** make finance logging dependable and editable now; preserve enough structure and evidence for an agentic, scalable system later.

---

## 1. Product direction

This is not primarily an expense tracker or a Gemini reporting tool. It is a personal financial history that can eventually answer:

> What happened? Why did it happen? Is it normal? What changed? What should I consider doing?

The sequence matters:

```text
Reliable capture → editable ledger → deterministic summaries → retrieval API
→ cited answers → saved insights/context → simulations and selective alerts
```

Do not introduce autonomous financial actions, a vector database, multi-agent frameworks, or broad “chat with the whole Sheet” behaviour before the earlier layers work.

---

## 2. What exists today

The repository already has a practical ingestion foundation.

| Component | Current capability | Keep / change |
| --- | --- | --- |
| `Prompt.txt` | Gemini extracts one completed Indian bank/UPI/card/wallet event into nine strict fields, or returns `IGNORE`. | Keep the constrained role. Add `balance_after` only when the script is ready to accept the ten-field contract. |
| `TrasactionParser.gs` | Apps Script accepts raw parsed transactions and manual entries; creates IDs; stores an 18-column ledger; detects likely duplicates; applies Config and Suggestion Rules; supports review, edits, recent transactions, and a monthly overview. | Treat it as the first ledger service. Harden its validation and edit/audit model before adding intelligence. |
| `Transaction Log` | Has IDs, date, signed amount, bank, merchant, category, notes, raw text, semantic type, instrument/account/card mapping, recurring/review flags, counterparty, reference and balance columns. | Keep it as the initial fact ledger. Make its schema and all readers consistent. |
| `CONFIG` and `Suggestion Rules` | Configure account/card mapping, known transaction patterns, categories, recurring transactions, and note templates. | Keep; this is the correct human-controlled learning mechanism. |
| `Monthly Summary` | Is exposed to Shortcuts through a simple overview endpoint. | Rebuild from the ledger using explicitly defined metrics; do not rely on ambiguous column names. |

### Important current gaps

These are implementation tasks, not reasons to redesign everything:

1. Some read endpoints retrieve only the original nine columns, although the ledger now contains eighteen. They must return the stored semantic `Type`, not infer type from the amount sign.
2. `Needs Review` currently becomes true when notes are blank. Notes are optional; review should mean uncertainty, conflict, or missing information that affects correctness.
3. Row numbers are used for edits. They are fragile after sorting or inserting rows. The public update contract should use `transactionId` and resolve the row server-side.
4. Duplicate detection should first use a deterministic source/reference key, then use a conservative probable-match rule. Exact recent date/amount/bank/merchant matching alone is not enough for SMS/email reconciliation.
5. The raw message is valuable evidence, but it will eventually make the analytical ledger heavy. Add a `Source Log` before the history gets large; retain a temporary compatibility copy during migration.
6. The prompt returns nine fields while the design previously proposed ten. Do not change the contract halfway: ship the ten-field parser and script validation together, or leave both at nine fields for now.
7. The monthly overview currently mixes summary terminology and calendar assumptions. It must calculate a selected period from defined ledger rows, then present it.
8. A deployed web app must require a request secret or signed request, rate-limit public calls where possible, and never return raw evidence by default.

---

## 3. Non-negotiable design rules

1. **The ledger records facts; the evidence supports facts; insights interpret facts.** These are separate data types.
2. **LLMs propose; deterministic code validates and commits.** Gemini may extract, classify, plan a permitted query, or draft an explanation. Apps Script validates types, categories, IDs, ownership, and writes.
3. **Every change is editable and attributable.** A correction is normal behaviour, not a failure. Preserve the original and record the correction.
4. **Never count movement as consumption.** `transfer`, `card_payment`, `investment`, and `refund` have distinct meanings and must not silently become expenses or income.
5. **Retrieve narrowly.** Answer a question from an aggregation or a bounded set of relevant transactions, not from the entire spreadsheet.
6. **Evidence is private by default.** Raw SMS/email is only retrieved when an answer needs an explanation or verification.
7. **Automation should be reversible.** Alerts recommend or request confirmation; they do not alter transactions, budgets, goals, or money movement by themselves.
8. **Optimise for useful friction.** Ask the user only for context that a notification cannot know, such as the purpose of an ambiguous transfer.

---

## 4. Architecture: now and later

```text
Capture surfaces
iPhone Shortcut / manual form / SMS or email alert
                  │
                  ▼
Ingestion service (Apps Script)
validate → normalize → deduplicate → append/change-audit → review signal
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
Fact ledger              Evidence store
Transaction Log          Source Log
       │                     │
       └──────────┬──────────┘
                  ▼
Deterministic derived data
monthly/merchant/recurring summaries, review queue, metrics
                  │
                  ▼
Retrieval API (bounded data + citations)
                  │
                  ▼
Gemini reasoning and response generation
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
Answer only          Proposed action for user approval
```

Apps Script is the control plane and policy boundary. Google Sheets is durable structured memory. Gemini is a constrained extraction and reasoning service, not the system of record. Apple Shortcuts is a capture/conversation surface, not a database.

---

## 5. Memory model

Use the right storage for each job. This is the first form of RAG; it does not need embeddings.

| Memory | Purpose | Initial storage | Write authority |
| --- | --- | --- | --- |
| Fact memory | Events that actually happened: transactions and verified fields. | `Transaction Log` | Apps Script after validation; user corrections |
| Evidence memory | Original SMS/email/manual input and parse provenance. | `Source Log` | Ingestion service |
| Derived memory | Summaries, merchant patterns, recurring candidates, deterministic metrics. | Summary sheets | Scheduled/rebuild code only |
| Personal memory | Goals, preferences, explanations, and decision commitments supplied by the user. | Dedicated tables | User-confirmed updates only |
| Insight memory | A dated, reproducible observation over defined facts. | `Insights` | Apps Script stores only validated analyst output |

An insight must contain its period, query/metric definition, source IDs or summary version, generation time, confidence, and invalidation status. It is a useful cached interpretation, never replacement evidence.

---

## 6. Data contracts

### 6.1 Ingestion contract: retain the current narrow parser

The current, supported parser contract is:

```text
datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no
```

It represents one completed event or `IGNORE`. `signed_amount` remains signed in the ledger. Valid `type` values are:

```text
income | expense | transfer | card_payment | investment | refund
```

The next compatible version adds only an explicit `balance_after` field:

```text
datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no | balance_after
```

Roll out both parser and Apps Script validation in the same release. Until then, do not emit a tenth field. The ingestion service may infer instrument, map an account/card, normalize merchant names, and apply approved rules, but it must retain the source value and reason for an override.

### 6.2 Canonical transaction record

Keep the existing columns during the first phase. Add fields through a versioned migration rather than replacing the sheet.

| Group | Fields | Notes |
| --- | --- | --- |
| Identity | `Transaction ID`, `Match Key`, `Created At`, `Last Updated At` | ID is server generated. Match Key supports matching; it is not necessarily unique. |
| Financial fact | `DateTime`, `Amount`, `Type`, `Instrument`, `Bank`, `Account Type`, `Account`, `Card Name` | Signed amount plus semantic type is the canonical representation. |
| Party/classification | `Merchant`, `Merchant Normalized`, `Counterparty`, `Category`, `Subcategory`, `Is Recurring` | Rules and user corrections may enrich these. |
| Traceability | `Ref No`, `Balance After`, `Source Count`, `Verification Status`, `Verification Source`, `Verified At` | Do not demand unavailable values. |
| User context | `User Notes`, `Needs Review`, `Review Reason` | Notes are optional; review is explicit. |

### 6.3 Source Log

Add this in Phase 2, not during the first logging release.

```text
Source ID | Received At | Source Type | Raw Body | Parser Version |
Parse Result | Parse Confidence | Ref No | Source Hash | Linked Transaction ID |
Match Status | Match Reason | Processing Error
```

One source can link to one transaction. A transaction can have many sources. Hash the raw body for source deduplication. Restrict raw-body responses to an explicit evidence endpoint.

### 6.4 Change Log

Editable does not mean silently mutable. When updates begin, add:

```text
Change ID | Transaction ID | Changed At | Actor | Field | Old Value | New Value | Reason | Request ID
```

For an early single-user Sheet this is sufficient. It allows fixes without needing a database or event-sourcing framework.

---

## 7. The first deliverable: reliable, editable logging

This is the priority. Complete it before creating an “Ask My Money” agent.

### User experience

1. The user pastes an alert or opens a quick manual entry Shortcut.
2. Gemini extracts a structured candidate for one message, or returns `IGNORE`.
3. Apps Script validates it, applies deterministic rules, and commits a transaction or returns a precise error/review request.
4. The response shows the saved transaction and offers only relevant edits: category, merchant, account/card, type, and optional note.
5. An edit calls `updateTransaction(transactionId, patch, reason)`; Apps Script validates, records Change Log, recalculates affected summaries, and responds with the final canonical record.

### Acceptance criteria

- Replaying the same source never creates a second transaction.
- A valid manual, SMS, or email event returns its canonical `transactionId`.
- An edit survives row sorting and is traceable.
- Credit-card purchases are expenses; card bill payments are `card_payment`; internal transfers are not expenses; refunds are not income.
- Missing notes do not create a review item.
- A review queue identifies a concrete reason, for example `unknown_merchant`, `ambiguous_type`, `source_conflict`, or `duplicate_candidate`.
- All endpoint responses use stored fields from one schema, including semantic `type`.

### Minimal API for this stage

| Intent | Endpoint/action | Result |
| --- | --- | --- |
| Ingest parsed source | `ingestTransaction` | Canonical record, duplicate/review state, allowed next step |
| Manual entry | `manual` | Same canonical record/result |
| Read one transaction | `getTransaction(transactionId)` | Safe ledger fields; raw evidence excluded |
| Modify transaction | `updateTransaction(transactionId, patch, reason)` | Validated record + change ID |
| List reviews | `pendingReview(limit)` | Reason and suggested resolution |
| Recent transactions | `lastTransactions(limit)` | Canonical records |

Do not accept arbitrary column names or raw row numbers from a Shortcut.

---

## 8. Derived summaries: deterministic before intelligent

Reports are deterministic views over facts, not Gemini-generated truth. Build them from `Transaction Log` and make the definitions visible.

Initial tables:

| Table | Purpose |
| --- | --- |
| `Monthly Summary` | Income, consumption expense, investment, transfers/card payments, cash surplus, ratios, category totals. |
| `Merchant Summary` | Merchant spend/count/trend over selected windows. |
| `Recurring Summary` | Confirmed and candidate recurring payments; never silently label a candidate as confirmed. |
| `Review Queue` | Actionable data-quality exceptions. |

Definitions:

- **Consumption expense:** absolute amounts where `Type = expense`, net of an explicitly linked refund where that relationship exists.
- **Income:** amounts where `Type = income`; refunds are reported separately.
- **Investment:** absolute amounts where `Type = investment`, reported separately from consumption.
- **Cash surplus:** income − consumption expense − investment, with transfers and card payments excluded from both sides.
- **Savings rate:** document whether this means `(income - consumption expense) / income` or a cash-surplus measure; provide the chosen definition in every summary response.

All summaries must be rebuildable for any period. The displayed period determines days remaining and comparisons; never use today’s month to interpret historical rows.

---

## 9. Structured retrieval: the first real RAG capability

The initial retrieval layer is a set of safe Apps Script functions, not a general Sheet dump.

Example question:

> How has my Amazon spending changed this year?

```text
Question
  → query plan: merchant=Amazon, type=expense, Jan 1–today, monthly trend
  → deterministic retrieval and aggregation
  → compact evidence packet
  → Gemini explains the result
  → response cites data range, transaction count, and source IDs/summary version
```

Example evidence packet:

```json
{
  "query": {"merchant": "Amazon", "type": "expense", "from": "2026-01-01", "to": "2026-10-07"},
  "totalsByMonth": [{"month": "2026-01", "amount": 4200}],
  "transactionCount": 42,
  "averageTransaction": 1240,
  "topCategories": [{"name": "Household", "amount": 18000}],
  "sources": {"ledgerVersion": "summary-2026-10-07T10:00:00Z", "transactionIds": ["...bounded..."]}
}
```

Gemini receives this compact packet, not every row and never unrestricted raw SMS text. The final response must distinguish calculation from interpretation and list the period, transaction count, and source scope.

### Initial retrieval tools

- `getPeriodOverview(from, to)`
- `getCategoryTrend(category, from, to, grain)`
- `getMerchantTrend(merchant, from, to, grain)`
- `getTransactions(filters, limit, cursor)`
- `getRecurringCommitments(asOf)`
- `getReviewQueue(limit)`
- `getGoalProgress(goalId, asOf)` later
- `getEvidence(transactionId)` only after explicit user request and authorization

Each tool has typed inputs, bounds on date range/result size, an explicit definition of included types, and response provenance. Tools return data; Gemini does not construct spreadsheet formulas or perform direct writes.

---

## 10. Agent behaviour: constrained and approval-based

The system becomes agentic through a disciplined loop, not because it uses an LLM.

```text
Observe a new fact or user question
→ choose a permitted retrieval/check
→ calculate deterministic result
→ generate an explanation or proposed action
→ user confirms when a durable change is needed
→ validate and commit through Apps Script
→ retain correction/decision for future retrieval
```

### Authority levels

| Level | Allowed behaviour | Example |
| --- | --- | --- |
| Read | Retrieve bounded facts and explain them. | “Food spending rose 18% month over month.” |
| Propose | Draft a category, note, insight, anomaly, or simulation. | “This appears to be a recurring subscription; confirm?” |
| Commit after confirmation | Write a correction, preference, goal, decision, or approved insight. | User confirms `Apollo Pharmacy → Healthcare`. |
| Never autonomous | Move money, delete financial records/evidence, alter confirmed history, or issue financial instructions as fact. | No exception. |

Every proposed write carries: proposed change, evidence/source IDs, reason, confidence, and a confirmation token. The server rejects writes without a valid confirmation context.

---

## 11. Personal memory and insight memory

Add these only after structured retrieval returns trustworthy cited answers.

### Preferences

```text
Preference ID | Scope | Key | Value | Created At | Updated At | Source/Confirmation
```

Examples: preferred category for a merchant, whether a repeated transfer is family support, notification thresholds. Preferences should be narrow and overrideable.

### Goals

```text
Goal ID | Name | Target Amount | Current Baseline | Deadline | Monthly Contribution |
Priority | Status | Assumption Notes | Updated At
```

Goal progress is calculated from facts and clearly states assumptions. It must never claim that an account balance is known when balance evidence is incomplete.

### Decisions

```text
Decision ID | Statement | Reason | Made At | Review On | Status | Related Categories/Merchants | User Confirmed
```

Decision memory supports respectful checks such as: “This large phone purchase conflicts with a decision you asked me to remember. Is it intentional?” It is a reminder, not a judgement.

### Insights

```text
Insight ID | Topic | Observation | Period | Metric Definition | Source Scope |
Confidence | Generated At | Confirmed At | Superseded By | Status
```

Insights may be retrieved as a shortcut, but stale or superseded insights must not be presented as current analysis.

---

## 12. Later capabilities

### What-if analysis

Simulations are read-only scenarios:

```text
Scenario input → deterministic model → assumptions + range → Gemini explanation
```

For example, reducing food delivery by 30% changes a projected spend/savings line; it never changes the ledger. Make the period, baseline, and handling of irregular costs explicit.

### Anomaly assistant

Start with transparent, deterministic candidates:

- transaction amount far outside a merchant/category baseline,
- same/similar reference or amount appearing twice,
- unexpected recurring-payment increase,
- category trajectory materially above comparable prior periods,
- a new high-value merchant on a card.

An anomaly notification always includes the baseline, comparison window, affected transaction(s), confidence, and a dismiss/confirm action. Lack of a notification means only that no configured rule triggered—not that all activity is safe.

### Semantic retrieval

Only add embeddings when narrative records are large enough that structured filters cannot find relevant notes, decisions, emails, or insights. Keep structured retrieval as the first stage, then search semantic text within a small allowed corpus. A vector database is an optional implementation detail, not an architectural milestone.

---

## 13. Delivery roadmap

### Phase 0 — stabilize the current prototype

- Freeze the nine-field parser contract and document a test corpus of real, redacted message patterns.
- Fix schema-inconsistent readers, stored-type usage, review logic, summary definitions, and request authentication.
- Replace public row-number updates with `transactionId` lookup.
- Add request IDs and structured error codes.

**Exit:** a transaction can be logged, displayed, corrected, and replayed without data loss or accidental duplication.

### Phase 1 — establish the editable ledger

- Implement canonical read/update endpoints and Change Log.
- Validate categories/types against `CONFIG`; maintain rule provenance.
- Improve deduplication using source hash/reference first and conservative probable matches second.
- Turn review into a reasoned queue with a one-tap correction path.

**Exit:** the ledger is trustworthy enough to be the sole input to summaries.

### Phase 2 — separate evidence and build repeatable reports

- Introduce Source Log and migrate raw text incrementally.
- Add source-to-transaction links and SMS/email reconciliation.
- Build rebuildable monthly, merchant, recurring, and review summaries.

**Exit:** a report can be reproduced from facts and source provenance.

### Phase 3 — expose structured retrieval

- Implement bounded retrieval functions and evidence-packet responses.
- Support a small set of high-value questions in Shortcuts.
- Require every answer to name its period, included event count, and source scope.

**Exit:** “Ask My Money” answers routine questions accurately without sending the whole sheet to Gemini.

### Phase 4 — add reasoning with citations

- Let Gemini map natural language to approved retrieval tools or a typed query plan.
- Generate explanations from the returned packet only.
- Store user-confirmed merchant corrections as rules/preferences.

**Exit:** conversational answers are explainable and corrections improve future results.

### Phase 5 — memory and proactive intelligence

- Add goals, decisions, preferences, reproducible insights, scenario models, and conservative anomaly candidates.
- Introduce semantic retrieval only if structured retrieval no longer covers the narrative corpus.

**Exit:** the system can offer relevant, consented, evidence-backed financial context without altering money or historical facts autonomously.

---

## 14. Explicitly out of scope for now

- Sending the full sheet or raw SMS archive to Gemini.
- Automatic transaction overwrites based solely on model confidence.
- Autonomous categorisation that changes confirmed history.
- A vector database, embeddings, Pinecone, or multi-agent orchestration.
- Account-balance or credit-limit claims without an authoritative, current source.
- Investment, tax, legal, or credit recommendations presented as personalised professional advice.
- Deleting raw evidence or change history.

---

## 15. Definition of success

The next milestone is successful when logging is so dependable that it becomes routine:

- Most common alerts create one correct, searchable transaction with no manual form filling.
- The user can fix any field quickly, and the system remembers an approved rule where appropriate.
- Duplicate/reconciliation/review states are visible and explainable.
- Monthly and merchant totals are reproducible from the ledger and use correct financial semantics.
- A future assistant has small, safe retrieval functions and evidence citations to build on.

At that point the project has the essential asset: a reliable personal financial memory. Intelligence can then grow without replacing or destabilising the foundation.
