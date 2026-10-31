# PFIS Prompt Catalogue — v1.0.0

Use these prompts only for the workflow named in each document.

| Prompt | Used by | Run it when |
|---|---|---|
| [iOS Shortcut Prompts](IOS_SHORTCUT_PROMPTS_v1.0.0.md) | AI/Text actions inside Apple Shortcuts | Every incoming SMS/email extraction, and only when backend requests category classification |
| [Gemini Spreadsheet Repair](GEMINI_SPREADSHEET_REPAIR_v1.0.0.md) | Gemini with the owner's connected Google Sheets workbook | A human asks Gemini to inspect or repair workbook formulas, views, labels or dashboard logic |
| [Gemini Card-Payment Rules](GEMINI_CARD_PAYMENT_RULES_v1.0.0.md) | Gemini with the PFIS workbook | Add/verify the two source-phrase Rules and matching Config rows for owned credit-card settlements |
| [Gemini Legacy Duplicate Mapping](GEMINI_LEGACY_DUPLICATE_MAPPING_v1.0.0.md) | Gemini with the PFIS workbook | Append verified survivor IDs to legacy DUPLICATE_REJECTED rows without archiving or changing financial facts |
| [Gemini Daily Transaction Verifier](GEMINI_DAILY_TRANSACTION_VERIFIER_v1.0.0.md) | Scheduled Gemini Task using Gmail and live PFIS Sheets | Daily transaction-to-email reconciliation, data-quality monitoring and conservative API-only updates |
| [Gemini Help Sheet Setup](GEMINI_HELP_SHEET_SETUP_v1.0.0.md) | Gemini with the live PFIS workbook | Create one beginner-friendly PFIS Help & Prompts tab |


Related implementation guides:

- [PFIS Help & Prompt Center](../docs/PFIS_HELP_AND_PROMPT_CENTER_v1.0.0.md)

- [Getting Started](../docs/GETTING_STARTED_v1.0.0.md)
- [iOS Shortcut Implementation](../docs/IOS_SHORTCUT_IMPLEMENTATION_v1.0.0.md)
- [Gemini Workbook Guide](../docs/GEMINI_WORKBOOK_GUIDE_v1.0.0.md)
- [Optional Gemini Purpose Enrichment](../docs/GEMINI_PURPOSE_ENRICHMENT_v1.0.0.md)

Security: never paste Script Properties, WEB_APP_SECRET, complete account/card numbers or private source messages into public repository files. The repository examples must remain synthetic.
