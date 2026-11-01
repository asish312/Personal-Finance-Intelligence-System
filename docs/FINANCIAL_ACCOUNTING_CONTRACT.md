# PFIS Financial Accounting Contract

This document defines how PFIS separates purchases, cash movement, credit-card settlements, investments and account balances. The goal is to avoid double-counting without mislabelling a partial operating metric as an all-in bank cash balance.

## 1. Transaction facts

Transaction Log is the canonical fact ledger. Amounts are signed:
- Debit/outflow: negative.
- Credit/inflow: positive.

Category is Transaction Log column G. Type is column I. Is Internal Transfer is column N. Validation Flag is column AA. Review Status is column T.

Do not infer cash flow from merchant text alone. Use the canonical category/type and validated status.

## 2. Cash Flow vs Operating Consumption

The current Dashboard_Calc model defines:

    Income (V6) = eligible positive cash inflows in the selected period
    Net Consumption (V7) = eligible operating consumption outflows
    Investments (V8) = eligible investment outflows
    Credit Card Settlements (V9) = eligible card bill payments, shown separately
    Net Cash Flow (V10) = Income (V6) - Net Consumption (V7) - Investments (V8)

The current V10 formula is:

    =V6 - V7 - V8

The current uploaded workbook evaluates:
- V6 Income: ₹1,34,178.16
- V7 Net Consumption: ₹97,182.55
- V8 Investments: ₹30,000.00
- V9 Credit Card Settlements: ₹1,02,412.95 (reported separately)
- V10 Net Cash Flow: +₹6,995.61

### Credit-card payment double-count rule

A card purchase is consumption when the card is swiped and must be counted once under its purchase category.

A later payment against that card bill is a liability settlement/cash movement. In this PFIS workbook, rows with Category (Transaction Log column G) exactly equal to Credit card payments are reported separately in V9. They must **not** be subtracted again from V10 when the underlying card purchases are already represented in operating consumption.

Do not add V9 to V7, and do not subtract V9 from V10. This prevents the same purchase from reducing operating surplus once at purchase time and again when the liability is settled.

### Scope caveat: V21 other genuine outflows

The uploaded workbook also reports ₹32,225.13 in Dashboard_Calc!V21 as Other Genuine Outflows (Debt Service and Family & Household according to the current formula). V21 is not part of the current V10 formula.

Therefore the dashboard's V10 should be understood as the defined PFIS operating/investment cash-flow KPI, not a complete all-account cash reconciliation. If PFIS later wants an all-in external cash movement measure, it must explicitly decide how to include V21 and any other non-consumption outflows without double-counting transfers. Do not silently change V10's definition.

V18 (Budget Income) is a budget allocation measure and is not interchangeable with V6 actual cash inflow.

## 3. Cumulative operating surplus

The monthly snapshot values in Dashboard_Calc show:
- September 2026 operating surplus: ₹1,31,946.00.
- October 2026 operating surplus: ₹39,414.36.
- Cumulative operating surplus: ₹1,71,360.36.

The requested headline of ₹1,71,360.00 appears to be the whole-rupee rounded total formatted with two decimal places; the precise sum of the visible monthly snapshot values is ₹1,71,360.36.

This cumulative monthly surplus is distinct from:
- current-period V10 net cash flow (+₹6,995.61);
- account live balances (Config!L:P);
- planned/verified savings sweeps.

### Export verification caveat

In the supplied XLSX export, Monthly Summary!C3 (October operating expenses) is a cached value with no formula in the imported formula grid, while Monthly Summary!D3 does contain the formula =B3-C3. Dashboard_Calc!D3 is blank (no formula). Monthly Summary month-list formulas also contain Google Sheets-specific DUMMYFUNCTION wrappers. The displayed cumulative total is therefore an observed workbook snapshot, not proof that every monthly roll-up recalculates dynamically in Excel.

Verify the corresponding formulas in the live Google Sheet before describing this cumulative figure as fully dynamic.

## 4. Category and Type treatment

| Event | Accounting treatment |
|---|---|
| Credit-card swipe | Operating consumption under its purchase category |
| Credit-card bill payment | Liability settlement; Category Credit card payments; separate V9; excluded from V10 |
| Investment/SIP | Investment outflow; separate V8; subtracted once in V10 |
| Internal transfer between owned accounts | Neither income nor consumption; excluded from ordinary cash-flow consumption |
| Refund/cashback | Separate inflow treatment; do not net silently against unrelated purchases |
| Debt Service / Family & Household | Currently shown separately in V21; not included in V7 or V10 under the current model |

## 5. Reconciliation rules

- Count each canonical Transaction ID once.
- Exclude duplicate/rejected/source-conflict and unresolved review rows from verified KPIs.
- Do not count both debit and credit legs of an internal transfer as consumption.
- Never count a card settlement as a second purchase.
- Do not treat a positive balance after transaction as income.
- Keep actual cash inflow separate from budget-allocated income.
- Planned savings are not actual savings; a sweep is verified only with matching source debit and destination credit legs.
