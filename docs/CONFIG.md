# PFIS Config Sheet Contract

The Config sheet contains two logically separate areas:

1. Config!A:I (and optional J): Apps Script account/card resolution input.
2. Config!L:P: account baseline and live-balance reporting matrix.

Do not mix these responsibilities.

## A:I — Apps Script mapping schema

| Column | Header | Meaning |
|---|---|---|
| A | Bank | Normalised bank/provider |
| B | Account Type | Savings, credit card, wallet, etc. |
| C | Account/Card Suffix | Source-visible identifying suffix or product alias |
| D | Merchant Contains | Optional merchant-specific qualifier |
| E | Account | Canonical friendly account code written to Transaction Log |
| F | Card Name | Friendly account/card label |
| G | Instrument | UPI, card, net banking etc. |
| H | Is Internal | Whether the mapping identifies an account owned by the user for internal transfer classification |
| I | Priority | Tie-break after specificity |

Optional J header: Text Pattern. The Apps Script reads J only when its header is exactly Text Pattern.

The engine currently declares nine core Config fields A:I and optionally reads J. Do not insert or reorder columns in A:J.

For a card whose SMS exposes a symbolic product label (for example SBI_CASHBACK_CC), set that exact label in **Account/Card Suffix** (column C). The extraction prompt preserves it as account_alias; the engine uses it as identity evidence to resolve this Config row. Keep column E as the canonical PFIS account code and column F as the friendly card name—do not use the raw alias as a substitute for a canonical Account code unless that is intentionally your configured account code.

## Current mapped rows relevant to cash flow

The latest uploaded workbook contains the following account mappings:

| Bank | Account Type | Merchant Contains | Account | Instrument | Is Internal | Priority |
|---|---|---|---|---|---|---:|
| Axis | Savings Account | CreditCard Payment | AXIS_SAVINGS | blank | Y | 10 |
| Axis | Savings Account | SBI Cards and Payme | AXIS_SAVINGS | UPI | Y | 11 |
| Axis | Savings Account | Amazon Pay Credit C | AXIS_SAVINGS | UPI | Y | 12 |

These mappings identify the Axis savings account as the paying account for card settlements. The Is Internal flag is only appropriate when the receiving card is also owned by the same person. Do not infer ownership from the merchant phrase alone.

## L:P — reporting baseline matrix

| Column | Header | Contract |
|---|---|---|
| L | Account Name | Friendly label |
| M | Account Code | Must match Transaction Log column K |
| N | Baseline Balance | Verified opening amount |
| O | Net Ledger Activity | Signed SUMIFS activity after the baseline anchor |
| P | Live Balance | N + O |

Current verified calibration snapshot:

- AXIS_SAVINGS: baseline ₹11,204.00, displayed activity ₹57,462.05, displayed live ₹68,666.05; anchor 2026-10-20.
- SBI_SAVINGS: baseline ₹0.00, activity -₹73,551.00, displayed position -₹73,551.00.
- PLUXEE_WALLET: baseline ₹695.56, activity ₹475.00, displayed position ₹1,170.56.
- AMAZON_PAY_WALLET: baseline ₹0.00, activity -₹1,659.42, displayed position -₹1,659.42.

For the baseline formula and the unresolved ₹202.02 difference in Config!O2, see [Account Balances](ACCOUNT_BALANCES.md).

## Validation

- Account Code values in M must match the actual Account codes used in Transaction Log K.
- Baseline must be independently verified and tied to an anchor date.
- Net Ledger Activity must include only rows on/after that account's anchor date.
- P rows should be formulas, not pasted values.
- Negative positions for bank accounts/wallets must be described as ledger-derived positions until reconciled with external available balances.
- Never modify Config!L:P when the task is to adjust account/card matching in A:J, and vice versa.

The reporting matrix L:P is not consumed by the Apps Script engine. No engine schema extension is required for this area.
