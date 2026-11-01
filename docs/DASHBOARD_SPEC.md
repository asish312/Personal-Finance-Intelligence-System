# PFIS Executive Dashboard Specification

This specification describes the live Executive Dashboard structure checked in the uploaded workbook.

## Layout order

1. Primary KPI summary: Dashboard!B5:O10.
2. Account Balances & Liquidity section: Dashboard!B12:O15 (four cards occupy rows 12:14; row 15 is the spacer below the cards).
3. Section A — Cash Flow: begins at Dashboard!B16 (the heading row is 16).

The liquidity cards are positioned between the primary KPI row and Section A, so users see account-level liquidity and card obligations before the cash-flow charts.

## Account Balances & Liquidity cards

| Card | Range | Value cell | Formula | Current displayed value | Meaning |
|---|---|---|---|---:|---|
| 1 — Axis Savings Primary | B12:D14 | B13 | =Config!P2 | ₹68,666.05 | Axis savings balance from ₹11,204 baseline plus date-bounded ledger activity (subject to the ₹202.02 reconciliation adjustment documented in Account Balances) |
| 2 — SBI Savings Wealth & Loans | E12:H14 | E13 | =Config!P3 | -₹73,551.00 | Ledger-derived position, not independently verified bank available balance |
| 3 — Wallets Pluxee / Amazon | I12:L14 | I13 | =Config!P4+Config!P5 | -₹488.86 | Combined Pluxee and Amazon Pay wallet ledger-derived position |
| 4 — Credit Card Obligations | M12:O14 | M13 | =-SUM('Card Reconciliation Log'!P2:P5) | -₹84,716.86 | Liability/credit-card obligation magnitude ₹84,716.86, represented with a negative sign |

The uploaded workbook formulas and values confirm all four mappings.

### Card obligation sign and source range

Card 4 intentionally negates the sum of Dynamic Unbilled Spend in Card Reconciliation Log!P2:P5. Its displayed value is -₹84,716.86; the magnitude of the unbilled card obligation is ₹84,716.86.

The Card Reconciliation Log currently has a second set of LIVE rows in rows 6:9 which repeat the same card-level spend measures. The Dashboard formula uses P2:P5 only. Do not expand the sum to P2:P9 unless the log design is changed to remove the duplicate representation; doing so would double-count the same four cards.

## Relationship to cash flow

The liquidity layer is a balance/position snapshot. It is not a substitute for period income, consumption or net cash flow.

- Axis Savings uses the baseline matrix in Config!L:P.
- SBI and wallet cards show ledger-derived positions using their own baseline/activity anchors.
- Credit-card obligations come from the card reconciliation log.
- Card bill payments are handled separately from card purchase consumption in the financial accounting contract.

See [Account Balances](ACCOUNT_BALANCES.md), [Config](CONFIG.md), and [Financial Accounting Contract](FINANCIAL_ACCOUNTING_CONTRACT.md).

## Maintenance rules

- Preserve the card placement and formulas when editing unrelated Dashboard areas.
- Do not hard-code the displayed amounts.
- Do not treat a negative ledger-derived account position as a confirmed negative bank balance without external verification.
- Do not sum both the verified snapshot rows and the parallel LIVE rows in Card Reconciliation Log.
- Use live Google Sheets formulas as the source of truth; XLSX export formula compatibility is not guaranteed.
