# PFIS v1.0.0 — Gemini Card-Payment Rules/Config Prompt

Use this prompt in Gemini with the live PFIS Google Sheets workbook open. This task is Rules and Config only. Do not edit Transaction Log, Source Log, Change Log or Rejected & Archive Log.

~~~text
Inspect the existing PFIS Rules, Config and Categories sheets before editing.

I need two exact merchant-evidence patterns configured for future credit-card bill settlements:

1. "CreditCard Payment"
2. "SBI Cards and Payme"

For each pattern:
- Add a new enabled Rules row (do not overwrite existing rules).
- Match Type = MERCHANT.
- Merchant Contains = the exact phrase above.
- Category = the existing active category "Credit card payments".
- Type Override = card_payment.
- Is Recurring = FALSE.
- Auto Purpose = FALSE.
- Leave Amount, Notes Template, Account Override and Card Name Override blank unless an existing documented requirement proves otherwise.
- Assign a unique Rule ID and an unused Priority.
- Keep all existing Rules schema columns, including N:S and T:W optional extensions, in their established positions.

Also add a matching Config row for each phrase, but only because both are confirmed to identify the user's own card bill payments from the Axis savings account:
- Bank = use the same exact value already used for Axis in Config.
- Account Type = Savings Account.
- Merchant Contains = the exact phrase above.
- Account = AXIS_SAVINGS (use the existing account key exactly).
- Card Name = use the existing friendly label for the Axis savings account.
- Instrument = UPI for the SBI Cards and Payme source pattern; use the source-supported instrument for CreditCard Payment.
- Is Internal = TRUE.
- Priority = a unique unused value.
- Do not invent a card-product suffix, receiving card name or Text Pattern.

If the evidence does not establish that either destination card belongs to the same person, DO NOT set Is Internal=TRUE for that pattern. Leave it unconfigured and report the ambiguity.

Before writing:
- Check whether an equivalent active rule/config row already exists; do not create duplicates.
- Confirm "Credit card payments" is active in Categories.
- Preserve all existing rows and physical column positions.

After writing:
- Report the exact new row numbers and values.
- Confirm both phrases match only the intended source alerts.
- Confirm no existing rules/config mappings were changed.
- Do not update historical Transaction Log rows in this task. Historical reclassification must be performed through the Apps Script reclassifyfromevidence API so changes are audited.
- Do not modify Apps Script, iOS Shortcuts, source evidence, audit history or other workbook tabs.
~~~

After Gemini saves these Rules and Config rows, deploy the updated Apps Script engine and use the two reclassifyfromevidence API examples in docs/LEDGER_CLEANUP_OPERATIONS_v1.0.0.md for the existing transactions.
