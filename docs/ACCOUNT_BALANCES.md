# PFIS Account Baselines & Live Balance Matrix

This document defines the account baseline matrix displayed in Config!L:P. It is a reporting/calibration sidecar, not part of the Apps Script ingestion schema.

## Purpose

An account's ledger-derived balance is:

    Live Balance = Opening Baseline Balance + Net Ledger Activity Since Baseline Anchor

The opening baseline is the externally verified account balance at a known anchor point. Net ledger activity is the signed sum of canonical Transaction Log amounts for that account from the anchor date onward. Debits are negative and credits are positive.

Do not fabricate an opening balance to force a dashboard number to match. Do not use an artificial negative opening-balance plug.

## Workbook layout

Config!L1:P5:

| Column | Header | Meaning |
|---|---|---|
| L | Account Name | Friendly account/wallet label |
| M | Account Code | Exact Transaction Log Account key |
| N | Baseline Balance | Verified opening balance at the anchor |
| O | Net Ledger Activity | Signed ledger amount since the configured anchor |
| P | Live Balance | Baseline plus net activity |

## Airtel Axis Savings Account

| Item | Value in uploaded workbook |
|---|---:|
| Account Name | Airtel Axis Savings Account |
| Account Code | AXIS_SAVINGS |
| Baseline anchor date | 2026-10-20 |
| Opening baseline balance (Config!N2) | ₹11,204.00 |
| Displayed net ledger activity (Config!O2) | ₹57,462.05 |
| Displayed live balance (Config!P2) | ₹68,666.05 |

The intended live-balance relationship is:

    Config!P2 = Config!N2 + Config!O2
    ₹68,666.05 = ₹11,204.00 + ₹57,462.05

The date window is inclusive: transactions with DateTime >= 2026-10-20 are included.

### Important calibration exception found in the uploaded workbook

The current Config!O2 formula is:

    =SUMIFS('Transaction Log'!$C:$C,'Transaction Log'!$K:$K,M2,'Transaction Log'!$B:$B,">=2026-10-20")-202.02

The raw SUMIFS result before the subtraction is ₹57,664.07. The formula subtracts an additional hard-coded ₹202.02 to display ₹57,462.05 and reach the externally verified ₹68,666.05 balance.

Therefore, the displayed net activity is **not currently a pure ledger sum**. The ₹202.02 is an unresolved reconciliation adjustment. Do not silently describe it as ledger activity, and do not remove it until the difference is reconciled to a specific omitted, duplicated or incorrect source/transaction record. The legacy artificial baseline plug is obsolete and must not be reintroduced.

The safe target is to resolve the ₹202.02 difference in the underlying ledger/evidence, then make Net Ledger Activity a pure date-bounded SUMIFS. Keep the opening baseline at ₹11,204.00 unless a newer bank-verified baseline and anchor are deliberately recorded.

## Other balances in the current matrix

| Account | Code | Baseline | Activity | Displayed Live Balance | Activity anchor in formula |
|---|---|---:|---:|---:|---|
| SBI Saving Account | SBI_SAVINGS | ₹0.00 | -₹73,551.00 | -₹73,551.00 | 2026-10-01 |
| Pluxee Meal Card | PLUXEE_WALLET | ₹695.56 | ₹475.00 | ₹1,170.56 | 2026-10-01 |
| Amazon Pay Wallet | AMAZON_PAY_WALLET | ₹0.00 | -₹1,659.42 | -₹1,659.42 | 2026-10-01 |

These are ledger-derived positions using the configured baseline and activity window. A negative ledger-derived position must not be described as a verified bank available balance unless it is reconciled to an external statement/balance.

## Formula completeness check

In the uploaded XLSX:
- Config!P2 contains =N2+O2.
- Config!P3:P5 contain displayed values but no formulas were present in the exported formula grid.
- Config!O3:O5 use an activity start date of 2026-10-01.

For a genuinely dynamic matrix, each live-balance row should use:

    P2 = N2 + O2
    P3 = N3 + O3
    P4 = N4 + O4
    P5 = N5 + O5

Fill formulas down rather than hard-coding the displayed values. Preserve each account's deliberate opening baseline and activity anchor.

## Architecture boundary

The Apps Script engine reads Config columns A:I and the optional J Text Pattern extension. It does not read Config!L:P. The baseline matrix and its formulas are a spreadsheet reporting layer.

No Apps Script change is required for the current baseline matrix. Changes to the matrix must be verified in Google Sheets itself; an XLSX export can preserve cached values or Google-specific formula wrappers rather than live recalculation behaviour.

## Operational rules

1. Never overwrite an opening baseline using a current ledger total.
2. Never change an anchor date without recording the verified bank balance at that anchor.
3. Keep activity date-bounded from the anchor using an inclusive lower bound.
4. Do not double-count card bill payments in operating consumption.
5. Treat baseline adjustments as reconciliation exceptions, not invisible plugs.
6. Verify the complete chain: baseline, raw ledger activity, any explained reconciliation adjustment, live balance and external bank balance.
