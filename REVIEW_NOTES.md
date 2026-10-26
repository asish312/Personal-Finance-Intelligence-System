# PFIS v1.0.0 — Category Fallback and Auto Purpose Review Package

## Purpose
This ZIP is a review candidate, not a repository commit. It contains the current uploaded implementation and Shortcut guidance. Before check-in, compare the uploaded engine/test files with current `main` and decide explicitly whether to replace the current test harness or retain both under non-conflicting names. The current repository README and analytics prompts remain useful baseline assets; do not delete or overwrite them without review.

## Main implementation carried in the uploaded engine
- Merchant-anchored category-only fallback when matching rules agree on one active category after an amount-specific rule misses.
- The fallback does not inherit amount-specific purpose templates, recurrence, account/card/type overrides, Auto Purpose permission, or confidence.
- `Auto Purpose=TRUE` is a separate optional Rules column (T) and must be explicitly enabled; recurrence alone cannot auto-fill a purpose.
- Approved-history `purposeSuggestion`/`purposeExamples` are returned for user confirmation, not silently saved.
- `nextAction` routes category-required transactions to `CLASSIFY_CATEGORY` before purpose-required transactions are routed to `ASK_PURPOSE`.
- Backend remains AI-free. Category fallback is handled in the Shortcut and must validate the candidate against `allowedCategories`.

## Critical Shortcut contract
1. Route on exact `nextAction` first.
2. `ASK_PURPOSE`: preserve `insertedTransaction.category`; ask purpose with `purposeSuggestion` as editable default if present; do not call `PFIS - Classify Category`.
3. `CLASSIFY_CATEGORY`: build a dictionary input with `purpose`, `merchant`, `amount`, `type`, `allowedCategories`, and `rawMessage`; call the helper; validate output exactly.
4. `ASK_PURPOSE` classifier result: ask the user, then rerun the classifier with the confirmed purpose.
5. Do not send any update with `ASK_PURPOSE`, an invalid category, an empty purpose, or a provisional category. Send one update once final values are valid.
6. A purpose-only enrichment path must keep the backend category. An enrichment update must not clear non-enrichment review states.
7. Remove only diagnostic Show/Quick Look actions after verification; retain error handling.

## Contents
- `PFIS_TransactionEngine_v1.0.0.gs` — uploaded engine implementation.
- `PFIS_Preflight_Tests_v1.0.0_CategoryFallback_AutoPurpose.gs` — uploaded expanded preflight harness.
- `PFIS_Prompts_Final_v1.0.0_Prompts.txt` — uploaded prompts.
- `PFIS_Shortcut_Implementation_v1.0.0.txt` — uploaded manual Shortcut instructions.
- `PFIS_Debug_Response_Snapshot_Template_v1.0.0.json` — template to store the raw ingest and update JSON responses together during development.
- `README.md` — project README, annotated for review with the current enrichment/category flow and debug-snapshot advice.
- `REVIEW_NOTES.md` — this file.

## Validation status
- Local parser/syntax check: engine and uploaded preflight harness pass `node --check`.
- Repository baseline: current `main` includes canonical engine, test harness, README, and Gemini analytics prompts. The committed engine/test files are not byte-for-byte identical to the uploaded engine/preflight files; review the diff before replacement.
- Not verified here: Apps Script runtime behavior, test spreadsheet writes, deployed web-app behavior, Shortcut visual wiring, or a live transaction. The harness must still run in Apps Script; local syntax validation is not integration validation.
- No GitHub files, branch, commits, PR, or deployments have been modified by preparing this ZIP.

## Before checking in
1. Review the diff between uploaded engine and current `main` engine; ensure every pre-existing feature is preserved.
2. Run `PFIS_RUN_ALL_PREFLIGHT_TESTS()` in a safe Apps Script project or staged copy; inspect result report and cleanup.
3. Review whether to replace the committed test suite or keep the uploaded preflight as the canonical new harness. Do not install both blindly if they have colliding globals.
4. Execute the three logical paths in Shortcuts: existing category + missing purpose (`ASK_PURPOSE`); missing category (`CLASSIFY_CATEGORY`); fully enriched (`SHOW_RECEIPT`). Verify no classification runs in the first path.
5. Check the combined debug snapshot design using synthetic data only; keep the snapshot out of Git when it contains real personal/financial data.
6. Once the diff and tests pass, create a review branch/PR rather than pushing straight to `main`.
