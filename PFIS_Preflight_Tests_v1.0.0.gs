/**
 * PFIS Transaction Engine v1.0.0 — bounded preflight / regression harness
 *
 * INSTALLATION
 * 1. Add this file to the SAME Apps Script project as the updated PFIS Transaction Engine source file.
 * 2. Save the project.
 * 3. Run PFIS_RUN_ALL_PREFLIGHT_TESTS manually from the Apps Script editor.
 * 4. Review the execution log and the returned JSON report.
 *
 * SAFETY
 * - The configured SPREADSHEET_ID is checked READ-ONLY for required sheet/header layout.
 * - All write/integration tests run against a temporary synthetic spreadsheet.
 * - The production SPREADSHEET_ID property is never changed.
 * - The temporary spreadsheet is trashed in finally{}; if execution is forcibly terminated,
 *   find the file with the prefix PFIS_AUTOTEST_TEMP and trash it manually.
 * - No live transaction, source, or change-log row is inserted/updated/deleted.
 *
 * TIMEOUT CONTROL
 * - The suite is deliberately small and does not scan the full live ledger.
 * - The test budget is 120 seconds; it stops starting new test cases at 105 seconds,
 *   leaving time for cleanup and report output under the common 6-minute editor limit.
 * - A single engine call cannot be interrupted mid-call by Apps Script; the staging
 *   workbook is kept tiny so each call remains bounded.
 */

var PFIS_PREFLIGHT_MAX_RUNTIME_MS = 120000;
var PFIS_PREFLIGHT_CLEANUP_RESERVE_MS = 15000;
var PFIS_PREFLIGHT_TEMP_PREFIX = 'PFIS_AUTOTEST_TEMP_DO_NOT_USE_';

function PFIS_RUN_ALL_PREFLIGHT_TESTS() {
  var startedAt = Date.now();
  var report = {
    suite: 'PFIS Transaction Engine v1.0.0 preflight',
    startedAt: new Date(startedAt).toISOString(),
    maxRuntimeMs: PFIS_PREFLIGHT_MAX_RUNTIME_MS,
    productionSpreadsheet: { status: 'NOT_CHECKED' },
    syntheticIntegration: { status: 'NOT_STARTED' },
    tests: [],
    cleanup: { attempted: false, success: false },
    stoppedEarly: false
  };

  var originalOverride = pfisString(PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID);
  var tempSpreadsheetId = '';
  var tempSpreadsheetName = '';

  try {
    // Read-only production preflight: only tab names, row/column counts and first-row headers.
    var configuredSpreadsheetId = pfisString(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
    if (!configuredSpreadsheetId) {
      report.productionSpreadsheet = {
        status: 'BLOCKED',
        message: 'SPREADSHEET_ID is not set. Synthetic tests can still run, but the configured workbook cannot be checked.'
      };
    } else {
      PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID = '';
      pfisPreflightResetEngineCaches_();
      try {
        var liveSchema = pfisCheckWorkbookStructure();
        report.productionSpreadsheet = {
          status: liveSchema.success ? 'SCHEMA_OK_READ_ONLY' : 'SCHEMA_ERRORS',
          spreadsheetId: configuredSpreadsheetId,
          checks: liveSchema.checks,
          message: 'Read-only header/layout check only; no live transaction rows were modified.'
        };
        pfisPreflightRecord_(report, 'Configured workbook schema (read-only)', !!liveSchema.success,
          liveSchema.success ? 'Required core tabs and positional headers were detected.' : 'One or more required core tabs/headers are invalid.', 0);
      } catch (liveError) {
        report.productionSpreadsheet = {
          status: 'ERROR', spreadsheetId: configuredSpreadsheetId,
          message: String(liveError && liveError.message ? liveError.message : liveError)
        };
        pfisPreflightRecord_(report, 'Configured workbook schema (read-only)', false, report.productionSpreadsheet.message, 0);
      }
    }

    // Pure logic tests do not access or mutate any spreadsheet.
    pfisPreflightRunCase_(report, 'Currency and comma amount parsing', function () {
      pfisPreflightAssert_(pfisParseAmount('₹15,250.00', false) === 15250, '₹15,250.00 did not parse to 15250.');
      return '₹15,250.00 -> 15250';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Negative amount parsing', function () {
      pfisPreflightAssert_(pfisParseAmount('-125.50', false) === -125.5, 'Negative signed amount was not preserved.');
      return '-125.50 -> -125.5';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Required ingestion helpers are defined', function () {
      var missing = [];
      if (typeof pfisFindSourceByHash !== 'function') missing.push('pfisFindSourceByHash');
      if (typeof pfisGetSourceCache !== 'function') missing.push('pfisGetSourceCache');
      if (typeof pfisBuildSourceIndex !== 'function') missing.push('pfisBuildSourceIndex');
      if (typeof pfisInvalidateSourceCache !== 'function') missing.push('pfisInvalidateSourceCache');
      if (typeof pfisAppendTransaction !== 'function') missing.push('pfisAppendTransaction');
      if (typeof pfisAppendSourceRow !== 'function') missing.push('pfisAppendSourceRow');
      if (typeof pfisFinalizeSource !== 'function') missing.push('pfisFinalizeSource');
      if (typeof pfisAppendChangeOnce !== 'function') missing.push('pfisAppendChangeOnce');
      if (typeof pfisAppendChangeOnceInternal !== 'function') missing.push('pfisAppendChangeOnceInternal');
      if (typeof pfisAppendChangeOnceBatch !== 'function') missing.push('pfisAppendChangeOnceBatch');
      if (typeof pfisLogUnhandledRequestError !== 'function') missing.push('pfisLogUnhandledRequestError');
      if (typeof pfisBuildMerchantCategoryFallback_ !== 'function') missing.push('pfisBuildMerchantCategoryFallback_');
      pfisPreflightAssert_(missing.length === 0, 'Missing runtime functions: ' + missing.join(', '));
      return 'All 12 ingestion/cache/audit/category-fallback helpers are defined';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Axis Shortcut payload tolerates one leading blank pipe field', function () {
      var input = ' | 2026-10-18 10:16:36 | -150.00 | Axis | Savings Account | UPI | transfer | DEMO PERSON | DEMO PERSON | DEMO-UTR-0001 | NA';
      var parsed = pfisParseTxnString(input);
      pfisPreflightAssert_(!!parsed, 'Valid Axis payload with a single leading blank was rejected.');
      pfisPreflightAssert_(Utilities.formatDate(parsed.datetime, PFIS_TIME_ZONE, 'yyyy-MM-dd HH:mm:ss') === '2026-10-18 10:16:36', 'Transaction timestamp changed.');
      pfisPreflightAssert_(parsed.amount === -150, 'Signed amount did not remain -150.');
      pfisPreflightAssert_(parsed.bank === 'Axis', 'Bank field shifted.');
      pfisPreflightAssert_(parsed.accountType === 'Savings Account', 'Account Type field shifted.');
      pfisPreflightAssert_(parsed.instrument === 'UPI', 'Instrument field shifted.');
      pfisPreflightAssert_(parsed.type === 'transfer', 'Transaction Type field shifted.');
      pfisPreflightAssert_(parsed.merchant === 'DEMO PERSON' && parsed.counterparty === 'DEMO PERSON', 'Merchant/counterparty fields shifted.');
      pfisPreflightAssert_(parsed.refNo === 'DEMO-UTR-0001', 'Reference field shifted.');
      pfisPreflightAssert_(parsed.balanceAfter === '', 'NA balance should be treated as absent, not numeric.');
      return 'Parsed all 10 fields correctly; NA balance normalized to blank';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Parser still rejects shifted or unexplained extra fields', function () {
      var malformed = '2026-10-18 10:16:36|-150.00|Axis||Savings Account|UPI|transfer|DEMO PERSON|DEMO PERSON|DEMO-UTR-0001|NA';
      pfisPreflightAssert_(pfisParseTxnString(malformed) === null, 'Parser guessed the meaning of a shifted 11-field payload.');
      return 'An extra field that is not the supported leading-empty-field case remains rejected';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Server errors show the spreadsheet audit status in the UI text', function () {
      var display = pfisBuildDisplayText({
        success: false, error: 'SERVER_ERROR', message: 'Simulated server error',
        requestId: 'PFIS-TEST-LOG-DISPLAY', errorLoggedToSheet: true,
        sourceLogLogged: true, changeLogLogged: true
      });
      pfisPreflightAssert_(display.indexOf('Recorded in Source Log and Change Log') >= 0,
        'UI display did not disclose that diagnostics were sheet-logged: ' + display);
      return 'UI reports Source Log and Change Log when error diagnostics were persisted';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Indian DD/MM/YYYY date parsing', function () {
      var d = pfisParseDateValue('01/10/2026 00:30:00');
      pfisPreflightAssert_(!!d, 'Indian date string was rejected.');
      var formatted = Utilities.formatDate(d, PFIS_TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
      pfisPreflightAssert_(formatted === '2026-10-01 00:30:00', 'Parsed timestamp shifted: ' + formatted);
      return formatted + ' IST';
    }, startedAt);

    pfisPreflightRunCase_(report, 'ISO date-only payload preserves DATE_ONLY precision', function () {
      var parsed = pfisParseTxnString('2026-10-01|-125.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRDATEONLY123|NA');
      pfisPreflightAssert_(!!parsed, 'ISO date-only txnString was rejected.');
      pfisPreflightAssert_(parsed.datePrecision === 'DATE_ONLY', 'Date-only precision was not preserved.');
      pfisPreflightAssert_(Utilities.formatDate(parsed.datetime, PFIS_TIME_ZONE, 'yyyy-MM-dd HH:mm:ss') === '2026-10-01 00:00:00',
        'Date-only date did not resolve to start of the correct IST calendar date.');
      return 'yyyy-MM-dd accepted and marked DATE_ONLY; zero time is internal storage only, not source precision';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Midnight timestamps are downgraded when raw source has no clock time', function () {
      var dateOnly = { datetime: pfisCreateIndiaDate(2026, 10, 30, 0, 0, 0), datePrecision: 'DATETIME' };
      pfisNormalizeSourceDatePrecision(dateOnly, 'Transaction date 30-10-2026');
      pfisPreflightAssert_(dateOnly.datePrecision === 'DATE_ONLY', 'A synthetic midnight was retained as DATETIME.');
      var actualTime = { datetime: pfisCreateIndiaDate(2026, 10, 30, 6, 45, 43), datePrecision: 'DATETIME' };
      pfisNormalizeSourceDatePrecision(actualTime, 'Date & Time: 30-10-26, 06:45:43 IST');
      pfisPreflightAssert_(actualTime.datePrecision === 'DATETIME', 'An explicit source clock time was downgraded.');
      return 'No-clock midnight => DATE_ONLY; real source clock time remains DATETIME';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Invalid calendar date rejection', function () {
      pfisPreflightAssert_(pfisParseInputDate('31/02/2026 10:00:00') === null, '31 February should be rejected.');
      return 'Invalid date rejected';
    }, startedAt);

    pfisPreflightRunCase_(report, 'ISO timestamp without zone uses IST', function () {
      var d = pfisParseDateValue('2026-10-01 09:00:00');
      pfisPreflightAssert_(!!d, 'ISO-style timestamp was rejected.');
      var formatted = Utilities.formatDate(d, PFIS_TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
      pfisPreflightAssert_(formatted === '2026-10-01 09:00:00', 'Timezone handling differed: ' + formatted);
      return formatted + ' IST';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Rules match-type normalization', function () {
      pfisPreflightAssert_(pfisNormalizeRuleMatchType('AMOUNT+MERCHANT') === 'AMOUNTMERCHANT', 'AMOUNT+MERCHANT was not normalized.');
      return 'AMOUNT+MERCHANT -> AMOUNTMERCHANT';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Unicode whitespace sanitization', function () {
      var clean = pfisSanitizeRawText('Axis\u00A0Bank\u200B  debit\nalert', false);
      pfisPreflightAssert_(clean.indexOf('\u00A0') < 0 && clean.indexOf('\u200B') < 0, 'Unicode whitespace remains.');
      pfisPreflightAssert_(clean === 'Axis Bank debit alert', 'Unexpected normalized text: ' + clean);
      return clean;
    }, startedAt);

    pfisPreflightRunCase_(report, 'Bank and account-suffix normalization', function () {
      pfisPreflightAssert_(pfisNormalizeBank('Axis Bank') === 'axis', 'Axis Bank normalization failed.');
      pfisPreflightAssert_(pfisNormalizeAccountIdentifier('XXXX1234') === 'suffix:1234', 'Masked account suffix normalization failed.');
      return 'Axis Bank -> axis; XXXX1234 -> suffix:1234';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Auto Purpose requires explicit permission, not recurrence', function () {
      var recurringWithoutPermission = pfisGetTrustedPurposeFromRule({
        isRecurring: true, autoPurpose: false, notes: 'Monthly home loan EMI'
      }, 'Bank');
      pfisPreflightAssert_(recurringWithoutPermission === '',
        'Is Recurring must not independently authorize purpose autofill.');
      var explicitlyTrusted = pfisGetTrustedPurposeFromRule({
        isRecurring: false, autoPurpose: true, notes: 'Example recurring payment'
      }, 'EXAMPLEMERCHANTEXAMPLEMERCHANT');
      pfisPreflightAssert_(explicitlyTrusted === 'Example recurring payment',
        'Auto Purpose=TRUE should authorize a meaningful trusted purpose.');
      var placeholder = pfisGetTrustedPurposeFromRule({
        isRecurring: true, autoPurpose: true, notes: 'Done for Oct-26'
      }, 'Bank');
      pfisPreflightAssert_(placeholder === '', 'Generic month template must not count as purpose.');
      return 'Only Auto Purpose=TRUE plus meaningful purpose allows autofill; recurrence alone does not';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Amount rule with blank override requires merchant evidence', function () {
      var rule = { merchantOverride: '', merchantContains: 'Test Merchant' };
      var parsed = { merchant: 'Test Merchant', counterparty: '', instrument: 'UPI' };
      pfisPreflightAssert_(pfisAmountRuleHasEvidence(rule, parsed, 'Paid at Test Merchant'), 'Configured merchant evidence should qualify.');
      return 'Blank override accepted when configured merchant evidence exists';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Amount rule rejects unrelated evidence', function () {
      var rule = { merchantOverride: '', merchantContains: 'Skyline Apartments' };
      var parsed = { merchant: 'Corner Store', counterparty: '', instrument: 'UPI' };
      pfisPreflightAssert_(!pfisAmountRuleHasEvidence(rule, parsed, 'Paid at Corner Store'), 'Unrelated merchant evidence was accepted.');
      return 'Unrelated evidence rejected';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Period boundary is midnight IST', function () {
      var bounds = pfisGetPeriodBounds('this_month');
      pfisPreflightAssert_(!!bounds.start && !!bounds.endExclusive, 'Month bounds are missing.');
      var startText = Utilities.formatDate(bounds.start, PFIS_TIME_ZONE, 'dd HH:mm:ss');
      pfisPreflightAssert_(startText === '01 00:00:00', 'Month start is not 1st at midnight IST: ' + startText);
      pfisPreflightAssert_(bounds.endExclusive.getTime() > bounds.start.getTime(), 'Month end is not after start.');
      return 'Month begins on day 01 at 00:00:00 IST';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Same calendar day accepts Date and DD/MM/YYYY string', function () {
      var dateObj = pfisCreateIndiaDate(2026, 10, 1, 23, 50, 0);
      pfisPreflightAssert_(pfisSameCalendarDay(dateObj, '01/10/2026 00:05:00'), 'Same IST day was not detected.');
      pfisPreflightAssert_(!pfisSameCalendarDay(dateObj, '02/10/2026 00:05:00'), 'Different IST day was treated as same.');
      return 'Mixed Date/string values compare by IST calendar day';
    }, startedAt);

    // Create a disposable synthetic workbook; every integration write goes here.
    pfisPreflightCheckBudget_(startedAt);
    tempSpreadsheetName = PFIS_PREFLIGHT_TEMP_PREFIX + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd_HHmmss') + '_' + Utilities.getUuid().slice(0, 6);
    var testSpreadsheet = SpreadsheetApp.create(tempSpreadsheetName);
    tempSpreadsheetId = testSpreadsheet.getId();
    report.syntheticIntegration.spreadsheetName = tempSpreadsheetName;
    report.syntheticIntegration.spreadsheetId = tempSpreadsheetId;
    pfisPreflightSetupWorkbook_(testSpreadsheet);

    PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID = tempSpreadsheetId;
    pfisPreflightResetEngineCaches_();
    report.syntheticIntegration.status = 'RUNNING_ON_DISPOSABLE_WORKBOOK';

    pfisPreflightRunCase_(report, 'Synthetic workbook schema', function () {
      var schema = pfisCheckWorkbookStructure();
      pfisPreflightAssert_(schema.success, JSON.stringify(schema.checks));
      return 'All six required tabs and expected header positions are present';
    }, startedAt);

    var txSheet = testSpreadsheet.getSheetByName(PFIS_SHEETS.transactions);
    var sourceSheet = testSpreadsheet.getSheetByName(PFIS_SHEETS.sources);
    var rulesSheet = testSpreadsheet.getSheetByName(PFIS_SHEETS.rules);
    var archiveSheet = testSpreadsheet.getSheetByName('Rejected & Archive Log');
    var holidaySheet = testSpreadsheet.getSheetByName(PFIS_HOLIDAY_CALENDAR_SHEET);

    pfisPreflightRunCase_(report, 'Auto Purpose T header/value is read independently from N:S', function () {
      PFIS_RUNTIME_RULE_CACHE = null;
      var before = pfisGetRuleRows()[0];
      pfisPreflightAssert_(before.autoPurpose === false, 'FALSE in Rules!T was not loaded as false.');
      try {
        rulesSheet.getRange(2, PFIS_RULE_AUTO_PURPOSE_COLUMN).setValue(true);
        PFIS_RUNTIME_RULE_CACHE = null;
        var after = pfisGetRuleRows()[0];
        pfisPreflightAssert_(after.autoPurpose === true, 'TRUE in Rules!T was not loaded as true.');
        var exactParsed = {
          datetime: pfisCreateIndiaDate(2026, 10, 4, 13, 0, 0), datePrecision: 'DATETIME',
          amount: -125, bank: 'Axis Bank', accountType: 'Savings Account', instrument: 'UPI',
          type: 'expense', merchant: 'Test Merchant', counterparty: 'Test Merchant',
          refNo: 'UTRAUTOPURPOSE125', balanceAfter: ''
        };
        var exactRule = pfisEvaluateRules(exactParsed, 'Axis Bank paid INR 125 to Test Merchant.');
        pfisPreflightAssert_(exactRule.category === 'Food & Dining' && exactRule.autoPurpose === true,
          'Exact rule did not retain its explicit Auto Purpose permission.');
        pfisPreflightAssert_(pfisGetTrustedPurposeFromRule(exactRule, 'Test Merchant') === 'Test purchase',
          'Exact rule purpose was not trusted when Auto Purpose=TRUE.');
        var unmatchedAmount = Object.assign({}, exactParsed, { amount: -50, refNo: 'UTRAUTOPURPOSE050' });
        var fallbackRule = pfisEvaluateRules(unmatchedAmount, 'Axis Bank paid INR 50 to Test Merchant.');
        pfisPreflightAssert_(fallbackRule.category === 'Food & Dining' && fallbackRule.autoPurpose === false,
          'Unmatched amount incorrectly inherited Auto Purpose.');
        pfisPreflightAssert_(pfisGetTrustedPurposeFromRule(fallbackRule, 'Test Merchant') === '',
          'Unmatched amount inherited an amount-specific purpose.');
      } finally {
        rulesSheet.getRange(2, PFIS_RULE_AUTO_PURPOSE_COLUMN).setValue(false);
        PFIS_RUNTIME_RULE_CACHE = null;
      }
      return 'Rules!T controls explicit purpose autofill; amount-mismatch fallback inherits category only';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Example Employer salary purpose is triggered by the transaction date last working day', function () {
      var before = rulesSheet.getRange(2, 7, 1, 17).getValues()[0];
      var transactionDate = pfisCreateIndiaDate(2026, 10, 30, 2, 34, 29);
      try {
        rulesSheet.getRange(2, 7).setValue('Salary from Example Employer for {{monthLabel}}');
        rulesSheet.getRange(2, 8).setValue(0);
        rulesSheet.getRange(2, PFIS_RULE_AUTO_PURPOSE_COLUMN).setValue(false);
        rulesSheet.getRange(2, PFIS_RULE_PURPOSE_TRIGGER_COLUMN, 1, 3)
          .setValues([['LAST_WORKING_DAY_OF_MONTH', 'EMPLOYER_DEMO', 1]]);
        PFIS_RUNTIME_RULE_CACHE = null;
        var parsed = {
          datetime: transactionDate, datePrecision: 'DATETIME', amount: -125,
          bank: 'Axis Bank', accountType: 'Savings Account', instrument: 'UPI',
          type: 'expense', merchant: 'Test Merchant', counterparty: 'Test Merchant',
          refNo: 'UTRHCLSALARYTEST', balanceAfter: ''
        };
        var result = pfisEvaluateRules(parsed, 'Example Employer payroll notification at Test Merchant on 30/10/2026 02:34:29.');
        pfisPreflightAssert_(result.autoPurpose === false, 'The test must prove the working-day trigger works with Auto Purpose FALSE.');
        pfisPreflightAssert_(result.notes === 'Salary from Example Employer for Oct-26', 'Salary description used the wrong month: ' + result.notes);
        pfisPreflightAssert_(result.budgetMonthOffset === 1, 'Example Employer salary should allocate to next month.');
        pfisPreflightAssert_(pfisGetTrustedPurposeFromRule(result, 'Test Merchant', transactionDate) === 'Salary from Example Employer for Oct-26',
          'Last-working-day trigger did not authorize the salary purpose.');
        pfisPreflightAssert_(!pfisIsLastWorkingDayOfMonth(pfisCreateIndiaDate(2026, 10, 29, 12, 0, 0), 'EMPLOYER_DEMO'),
          '29 October should not be last working day while 30 October is a weekday.');
        holidaySheet.getRange(2, 1, 1, 4).setValues([[
          pfisCreateIndiaDate(2026, 10, 30, 12, 0, 0), 'EMPLOYER_DEMO', false, 'Synthetic Example Employer holiday override'
        ]]);
        PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE = null;
        pfisPreflightAssert_(!pfisIsLastWorkingDayOfMonth(transactionDate, 'EMPLOYER_DEMO'),
          'The employer-specific holiday override should make 30 October non-working.');
        pfisPreflightAssert_(pfisIsLastWorkingDayOfMonth(pfisCreateIndiaDate(2026, 10, 29, 12, 0, 0), 'EMPLOYER_DEMO'),
          '29 October should become the last working day after the holiday override.');
        holidaySheet.getRange(2, 1, 1, 4).clearContent();
        PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE = null;
      } finally {
        rulesSheet.getRange(2, 7, 1, 17).setValues([before]);
        rulesSheet.getRange(2, PFIS_RULE_AUTO_PURPOSE_COLUMN).setValue(false);
        holidaySheet.getRange(2, 1, 1, 4).clearContent();
        PFIS_RUNTIME_RULE_CACHE = null;
        PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE = null;
      }
      return 'Transaction date controls earned-month purpose; Example Employer working-day calendar controls trigger; Budget Month +1 allocates to November';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Blank purpose and missing category are non-blocking', function () {
      var parsed = {
        datetime: pfisCreateIndiaDate(2026, 10, 5, 12, 0, 0), datePrecision: 'DATETIME',
        amount: -80, bank: 'Axis Bank', accountType: 'Savings Account', instrument: 'UPI',
        type: 'expense', merchant: 'Unknown Test Merchant', counterparty: 'Unknown Test Merchant',
        refNo: 'UTRMISCOPTIONAL80', balanceAfter: ''
      };
      var config = { account: 'AXIS_SAVINGS', cardName: '', instrument: 'UPI',
        isInternal: false, ambiguous: false, unresolved: false };
      var tx = pfisBuildTransaction(parsed, {}, 'SMS', '202610-999', 'SRC-PREFLIGHT', 'HASH-PREFLIGHT',
        pfisEmptyRuleResult(), config, '', null);
      pfisPreflightAssert_(tx.category === 'Miscellaneous', 'Missing category did not fall back to Miscellaneous.');
      pfisPreflightAssert_(tx.userNotes === '', 'A purpose was unexpectedly fabricated.');
      pfisPreflightAssert_(tx.needsReview === false && tx.validationFlag === 'VALID',
        'Blank purpose or Miscellaneous fallback incorrectly blocked transaction acceptance.');
      return 'Missing category => Miscellaneous; blank Purpose => accepted transaction, not Needs Review';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Different amount reuses merchant category only', function () {
      PFIS_RUNTIME_RULE_CACHE = null;
      var parsed = {
        datetime: pfisCreateIndiaDate(2026, 10, 4, 12, 0, 0), datePrecision: 'DATETIME',
        amount: -50, bank: 'Axis Bank', accountType: 'Savings Account', instrument: 'UPI',
        type: 'expense', merchant: 'Test Merchant', counterparty: 'Test Merchant',
        refNo: 'UTRFALLBACKUNIT50', balanceAfter: ''
      };
      var result = pfisEvaluateRules(parsed, 'Axis Bank paid INR 50 to Test Merchant.');
      pfisPreflightAssert_(result.category === 'Food & Dining', 'Merchant category fallback failed: ' + JSON.stringify(result));
      pfisPreflightAssert_(result.ruleType === 'MERCHANT_CATEGORY_FALLBACK', 'Fallback source was not recorded.');
      pfisPreflightAssert_(result.notes === '' && result.autoPurpose === false, 'Amount-specific purpose leaked into fallback.');
      pfisPreflightAssert_(result.typeOverride === '' && result.accountOverride === '' && result.cardNameOverride === '',
        'Amount-specific type/account/card override leaked into fallback.');
      var state = pfisGetEnrichmentState(result.category, '', ['Food & Dining', 'Transport', 'Bills & subscription'], 'Test Merchant');
      pfisPreflightAssert_(state.requiresCategoryClassification === false && state.requiresPurpose === false,
        'Missing purpose must not be a required enrichment field.');
      pfisPreflightAssert_(pfisRecommendNextAction('ACCEPTED', {
        category: result.category, userNotes: '', merchant: 'Test Merchant', needsReview: false,
        reviewReason: ''
      }, state) === 'SHOW_RECEIPT', 'A known category with blank purpose must not open a purpose prompt.');
      return 'Amount mismatch retained category; blank purpose is optional and does not block receipt';
    }, startedAt);

    pfisPreflightRunCase_(report, 'Conflicting merchant category evidence fails closed', function () {
      var rules = [
        { enabled: true, matchType: 'AMOUNT+MERCHANT', amount: 150, merchantContains: 'Known Merchant',
          category: 'Housing & utilities', merchantOverride: 'Known Utility', ruleId: 'R1', rowNumber: 2 },
        { enabled: true, matchType: 'MERCHANT', merchantContains: 'Known Merchant',
          category: 'Healthcare', merchantOverride: 'Known Clinic', ruleId: 'R2', rowNumber: 3 }
      ];
      var result = pfisBuildMerchantCategoryFallback_(rules, 'Known Merchant', ['Housing & utilities', 'Healthcare']);
      pfisPreflightAssert_(result.category === '', 'Conflicting categories should not be guessed.');
      pfisPreflightAssert_(result.ruleType === '', 'Ambiguous fallback should not claim a matched rule.');
      return 'Conflicting category mappings leave category unresolved for fallback classification';
    }, startedAt);

    // M/N/O and AJ/AK are literal FALSE defaults; no transaction data exists in the row.
    [13, 14, 15, 36, 37].forEach(function (col) { txSheet.getRange(2, col).setValue(false); });
    pfisPreflightRunCase_(report, 'Checkbox-only transaction row can be reused', function () {
      var row = pfisGetNextAvailableRow(txSheet, 1);
      pfisPreflightAssert_(row === 2, 'Expected safe row reuse at row 2, got ' + row + '.');
      return 'FALSE-only checkbox row safely resolves to row 2';
    }, startedAt);

    // A blank key with non-key content must never be overwritten.
    sourceSheet.getRange(2, 2).setValue('PRESERVE_THIS_PARTIAL_ROW');
    pfisPreflightRunCase_(report, 'Partially populated source row is not reused', function () {
      var row = pfisGetNextAvailableRow(sourceSheet, 1);
      pfisPreflightAssert_(row === 3, 'Expected append below preserved row 2; got ' + row + '.');
      pfisPreflightAssert_(sourceSheet.getRange(2, 2).getValue() === 'PRESERVE_THIS_PARTIAL_ROW', 'Sentinel was changed.');
      return 'Partial row preserved; new source row should be row 3 or later';
    }, startedAt);

    var testToken = pfisString(PropertiesService.getScriptProperties().getProperty('WEB_APP_SECRET'));
    var txnStringSms = '01/10/2026 10:00:00|-125.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRTEST123456|';
    var originalSms = 'Axis Bank alert: INR 125.00 debited at Test Merchant on 01/10/2026 10:00:00. Account 1234. UTR UTRTEST123456.';
    var originalEmail = 'Axis Bank email alert: INR 125.00 debited at Test Merchant on 01/10/2026 10:10:00. Account 1234. UTR UTRTEST123456.';

    var smsResponse = pfisPreflightRunCase_(report, 'End-to-end SMS insertion', function () {
      var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
        action: 'ingest', sourceType: 'SMS', txnString: txnStringSms,
        originalText: originalSms, sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-SMS-001'
      }), 'POST');
      pfisPreflightAssert_(response && response.success === true, 'SMS ingestion failed: ' + JSON.stringify(response));
      pfisPreflightAssert_(response.status === 'ACCEPTED', 'Unexpected SMS status: ' + response.status);
      pfisPreflightAssert_(!!response.transactionId, 'SMS response has no transactionId.');
      pfisPreflightAssert_(response.transaction && response.transaction.category === 'Food & Dining', 'Configured rule did not apply category.');
      pfisPreflightAssert_(response.transaction.account === 'AXIS_SAVINGS', 'Config Text Pattern did not map AXIS_SAVINGS.');
      pfisPreflightAssert_(response.transaction.ruleApplied === 'TEST-RULE', 'Configured rule ID was not applied.');
      var rowNumber = pfisFindTransactionRow(response.transactionId);
      pfisPreflightAssert_(rowNumber === 2, 'The new transaction did not reuse the checkbox-only row 2; actual row ' + rowNumber + '.');
      pfisWriteOptionalBudgetPeriods(rowNumber, {
        dateTime: pfisCreateIndiaDate(2026, 10, 30, 2, 34, 29),
        type: 'income', category: 'Income', budgetMonthOffset: 1
      }, txSheet);
      var incomeMonth = txSheet.getRange(rowNumber, 41).getValue();
      var budgetMonth = txSheet.getRange(rowNumber, 40).getValue();
      pfisPreflightAssert_(Utilities.formatDate(incomeMonth, PFIS_TIME_ZONE, 'yyyy-MM-dd') === '2026-10-01',
        'Income Month must be October.');
      pfisPreflightAssert_(Utilities.formatDate(budgetMonth, PFIS_TIME_ZONE, 'yyyy-MM-dd') === '2026-11-01',
        'Budget Month must be November for October income.');
      return response;
    }, startedAt);

    if (smsResponse && smsResponse.transactionId) {
      // Simulate a legacy source row whose extracted date is stored as a DD/MM/YYYY text value.
      pfisPreflightRunCase_(report, 'Legacy non-ISO source date is preserved for reconciliation', function () {
        var sourceIdCell = sourceSheet.getRange(3, 1).getValue();
        pfisPreflightAssert_(!!sourceIdCell, 'Expected first SMS source at row 3 after the preserved partial row.');
        sourceSheet.getRange(3, 11).setNumberFormat('@').setValue('01/10/2026 10:00:00');
        return 'Existing source extractedDate changed to an explicit legacy DD/MM/YYYY text value in test workbook';
      }, startedAt);

      var emailResponse = pfisPreflightRunCase_(report, 'Delayed email reconciles by same bank/reference/amount/day', function () {
        var emailTxnString = '01/10/2026 10:10:00|-125.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRTEST123456|';
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'EMAIL', txnString: emailTxnString,
          originalText: originalEmail, sender: 'PFIS TEST EMAIL', subject: 'Payment alert', requestId: 'PFIS-TEST-EMAIL-001'
        }), 'POST');
        pfisPreflightAssert_(response && response.success === true, 'Email ingestion failed: ' + JSON.stringify(response));
        pfisPreflightAssert_(response.status === 'RECONCILED', 'Delayed email did not reconcile: ' + response.status);
        pfisPreflightAssert_(response.transactionId === smsResponse.transactionId, 'Email created/linked the wrong transaction.');
        return response;
      }, startedAt);

      pfisPreflightRunCase_(report, 'Generic Unspecified bank email links to exact-time account debit', function () {
        var before = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var debitTxn = '02/10/2026 12:30:00|-128.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRGENERIC123456|NA';
        var debitText = 'Axis Bank SMS: INR 128.00 debited at Test Merchant on 02/10/2026 12:30:00. Account 1234. UTR UTRGENERIC123456.';
        var seed = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: debitTxn, originalText: debitText,
          sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-GENERIC-SEED'
        }), 'POST');
        pfisPreflightAssert_(seed && seed.success === true && seed.status === 'ACCEPTED', 'Generic match seed failed: ' + JSON.stringify(seed));
        var genericTxn = '02/10/2026 12:30:00|-128.00|Axis Bank|Savings Account|UPI|expense|Unspecified|Unspecified|UTRGENERIC123456|NA';
        var genericEmail = 'Axis Bank email: Amount Debited INR 128.00. Merchant: Unspecified. Original transaction merchant detail: Test Merchant. Account 1234. Date & Time: 02/10/2026 12:30:00 IST. UTR UTRGENERIC123456.';
        var linked = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'EMAIL', txnString: genericTxn, originalText: genericEmail,
          sender: 'PFIS TEST EMAIL', subject: 'Generic merchant notification', requestId: 'PFIS-TEST-GENERIC-EMAIL'
        }), 'POST');
        pfisPreflightAssert_(linked && linked.success === true && linked.status === 'RECONCILED',
          'Generic merchant cross-channel match failed: ' + JSON.stringify(linked));
        pfisPreflightAssert_(linked.transactionId === seed.transactionId, 'Generic alert linked to the wrong canonical row.');
        pfisPreflightAssert_(linked.transactionInserted === false, 'Generic email inserted a second ledger row.');
        pfisPreflightAssert_(pfisPreflightCountNonblankKeys_(txSheet, 1) === before + 1,
          'Expected exactly one new canonical transaction for the two generic-alert sources.');
        return 'Unspecified email linked by exact bank + amount + transaction time + resolved account; no second transaction';
      }, startedAt);

      pfisPreflightRunCase_(report, 'Wallet payment confirmation links to card-issuer acknowledgement', function () {
        var before = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var walletTxn = '02/10/2026 15:00:00|-4537.00|Amazon Pay|Wallet|UPI|card_payment|ICICI Credit Card Bill|ICICI Bank|ORDERICICI4537|NA';
        var walletText = 'Amazon Pay: Your Credit Card Bill Payment is successful. Paid to ICICI Bank. Amount INR 4537.00. Order Id ORDERICICI4537.';
        var wallet = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'EMAIL', txnString: walletTxn, originalText: walletText,
          sender: 'PFIS TEST AMAZON PAY', subject: 'Payment successful', requestId: 'PFIS-TEST-CARD-WALLET'
        }), 'POST');
        pfisPreflightAssert_(wallet && wallet.success === true && wallet.status === 'ACCEPTED',
          'Wallet/card payment seed failed: ' + JSON.stringify(wallet));
        var issuerTxn = '02/10/2026 15:05:00|-4537.00|ICICI Bank|Credit Card|Credit Card|card_payment|ICICI Credit Card Bill|ICICI Bank|ICICIREF4537|NA';
        var issuerText = 'ICICI Bank: Payment of INR 4537.00 received towards your ICICI Credit Card on 02/10/2026 15:05:00. Reference ICICIREF4537.';
        var issuer = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: issuerTxn, originalText: issuerText,
          sender: 'ICICI TEST SMS', requestId: 'PFIS-TEST-CARD-ISSUER'
        }), 'POST');
        pfisPreflightAssert_(issuer && issuer.success === true && issuer.status === 'RECONCILED',
          'Card issuer event did not link to the wallet/payment event: ' + JSON.stringify(issuer));
        pfisPreflightAssert_(issuer.transactionId === wallet.transactionId, 'Card issuer alert linked to the wrong settlement.');
        pfisPreflightAssert_(issuer.paymentEventLinked === true, 'Response did not identify payment-event linkage.');
        pfisPreflightAssert_(issuer.transactionInserted === false, 'Issuer acknowledgement created a second canonical transaction.');
        pfisPreflightAssert_(pfisPreflightCountNonblankKeys_(txSheet, 1) === before + 1,
          'Wallet and issuer notifications should produce exactly one canonical payment event.');
        return 'Wallet and ICICI issuer confirmations retained as source evidence linked to one card-payment ledger event';
      }, startedAt);

      pfisPreflightRunCase_(report, 'Same-channel issuer receipt links when one reference is absent', function () {
        var before = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var firstTxn = '03/10/2026|-1500.00|SBI Card|Credit Card|Credit Card|card_payment|SBI Credit Card Payment|SBI Card|NA|NA';
        var firstText = 'SBI Card SMS: We have received your payment of INR 1500.00 via UPI towards your credit card on 03/10/2026.';
        var first = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: firstTxn, originalText: firstText,
          sender: 'PFIS TEST SBI SMS', requestId: 'PFIS-TEST-SBI-CARD-FIRST'
        }), 'POST');
        pfisPreflightAssert_(first && first.success && first.status === 'ACCEPTED',
          'First SBI card payment notification failed: ' + JSON.stringify(first));
        var secondTxn = '03/10/2026|-1500.00|SBI Card|Credit Card|Credit Card|card_payment|SBI Credit Card Payment|SBI Card|SBIRECEIPT1500|NA';
        var secondText = 'SBI Card SMS: Payment of INR 1500.00 has been credited to your SBI Card account on 03/10/2026. Reference SBIRECEIPT1500.';
        var second = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: secondTxn, originalText: secondText,
          sender: 'PFIS TEST SBI SMS', requestId: 'PFIS-TEST-SBI-CARD-SECOND'
        }), 'POST');
        pfisPreflightAssert_(second && second.success && second.status === 'RECONCILED',
          'Same-channel card issuer messages did not reconcile: ' + JSON.stringify(second));
        pfisPreflightAssert_(second.transactionId === first.transactionId,
          'Same-channel issuer receipt did not link to the first payment event.');
        pfisPreflightAssert_(second.transactionInserted === false,
          'Same-channel issuer acknowledgement created another canonical row.');
        pfisPreflightAssert_(pfisPreflightCountNonblankKeys_(txSheet, 1) === before + 1,
          'Expected one canonical row for two same-channel issuer notifications.');
        return 'Same issuer + card account + amount + date + unique candidate linked when only one reference was provided';
      }, startedAt);

      pfisPreflightRunCase_(report, 'Exact SMS replay is idempotent', function () {
        var before = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var sourcesBefore = pfisPreflightCountPrefixedKeys_(sourceSheet, 1, 'SRC-');
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: txnStringSms,
          originalText: originalSms, sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-SMS-REPLAY'
        }), 'POST');
        var after = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var sourcesAfter = pfisPreflightCountPrefixedKeys_(sourceSheet, 1, 'SRC-');
        pfisPreflightAssert_(response && response.success === true && response.status === 'IDEMPOTENT_REPLAY', 'Replay was not idempotent: ' + JSON.stringify(response));
        pfisPreflightAssert_(before === after, 'Replay inserted a new transaction.');
        pfisPreflightAssert_(sourcesBefore === sourcesAfter, 'Replay inserted a new source row.');
        return 'Replay returned existing transaction without increasing transaction/source counts';
      }, startedAt);

      var exactDuplicateResponse = pfisPreflightRunCase_(report, 'Same-channel exact transaction duplicate is suppressed', function () {
        var beforeTransactions = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var beforeSources = pfisPreflightCountPrefixedKeys_(sourceSheet, 1, 'SRC-');
        var variantBody = originalSms + ' Extra footer included in this delivery.';
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: txnStringSms,
          originalText: variantBody, sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-SMS-SAME-TIME-DUP'
        }), 'POST');
        var afterTransactions = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var afterSources = pfisPreflightCountPrefixedKeys_(sourceSheet, 1, 'SRC-');
        pfisPreflightAssert_(response && response.success === true, 'Exact duplicate suppression failed: ' + JSON.stringify(response));
        pfisPreflightAssert_(response.status === 'DUPLICATE_SUPPRESSED', 'Expected DUPLICATE_SUPPRESSED, got ' + response.status + '.');
        pfisPreflightAssert_(response.transactionId === smsResponse.transactionId, 'Suppressed duplicate did not link to the original transaction.');
        pfisPreflightAssert_(response.transactionInserted === false, 'Response did not confirm that no transaction was inserted.');
        pfisPreflightAssert_(afterTransactions === beforeTransactions, 'Exact duplicate created a new Transaction Log row.');
        pfisPreflightAssert_(afterSources === beforeSources + 1, 'Duplicate evidence was not retained in Source Log.');
        var sourceRow = pfisFindSourceById(response.sourceId);
        pfisPreflightAssert_(sourceRow && sourceRow.linkedTxnId === smsResponse.transactionId, 'Duplicate source was not linked to the original transaction.');
        pfisPreflightAssert_(sourceRow.parseStatus === 'DUPLICATE_SUPPRESSED', 'Source row status did not record suppression.');
        return 'No Transaction Log insert; one Source Log evidence row linked to ' + smsResponse.transactionId;
      }, startedAt);

      pfisPreflightRunCase_(report, 'Replay of a suppressed duplicate source is idempotent', function () {
        var variantBody = originalSms + ' Extra footer included in this delivery.';
        var beforeTransactions = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var beforeSources = pfisPreflightCountPrefixedKeys_(sourceSheet, 1, 'SRC-');
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: txnStringSms,
          originalText: variantBody, sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-SMS-SUPPRESSED-REPLAY'
        }), 'POST');
        pfisPreflightAssert_(response && response.success === true && response.status === 'IDEMPOTENT_REPLAY', 'Suppressed-source replay was not idempotent: ' + JSON.stringify(response));
        pfisPreflightAssert_(pfisPreflightCountNonblankKeys_(txSheet, 1) === beforeTransactions, 'Suppressed-source replay inserted a transaction.');
        pfisPreflightAssert_(pfisPreflightCountPrefixedKeys_(sourceSheet, 1, 'SRC-') === beforeSources, 'Suppressed-source replay inserted a source.');
        return 'Replaying the suppressed source inserted neither transaction nor source rows';
      }, startedAt);

      var duplicateResponse = pfisPreflightRunCase_(report, 'Similar same-channel alert becomes review candidate', function () {
        var duplicateTxnString = '01/10/2026 10:02:00|-125.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRDIFFERENT98765|';
        var duplicateText = 'Axis Bank alert reference UTRDIFFERENT98765: INR 125.00 debited at Test Merchant on 01/10/2026 10:02:00. Account 1234. Test event B.';
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: duplicateTxnString,
          originalText: duplicateText, sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-SMS-DUP-001'
        }), 'POST');
        pfisPreflightAssert_(response && response.success === true, 'Duplicate candidate ingestion failed: ' + JSON.stringify(response));
        pfisPreflightAssert_(response.status === 'DUPLICATE_CANDIDATE', 'Similar same-channel alert was not flagged: ' + response.status);
        pfisPreflightAssert_(response.transaction && response.transaction.validationFlag === 'DUPLICATE_CANDIDATE', 'Duplicate validation flag missing.');
        pfisPreflightAssert_(pfisFindTransactionRow(response.transactionId) >= 2,
          'A potential duplicate candidate must remain in the active Transaction Log.');
        pfisPreflightAssert_(pfisFindRowByValue(archiveSheet, 1, response.transactionId) < 2,
          'A potential duplicate must not be auto-archived.');
        pfisPreflightAssert_(response.transaction.needsReview === true,
          'A potential duplicate must remain in the review queue.');
        var pending = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'getpendingreview', limit: 100, requestId: 'PFIS-TEST-DUPLICATE-PENDING-QUEUE'
        }), 'POST');
        pfisPreflightAssert_((pending.data || []).some(function (item) { return item.transactionId === response.transactionId; }),
          'Potential duplicate is missing from getpendingreview.');
        var quality = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'getdataquality', requestId: 'PFIS-TEST-DUPLICATE-DATA-QUALITY'
        }), 'POST');
        pfisPreflightAssert_(quality.data && quality.data.needsReview >= 1,
          'Data quality Needs Review count did not include the duplicate candidate.');
        return response;
      }, startedAt);

      var conflictSeedResponse = pfisPreflightRunCase_(report, 'Cross-channel conflict seed SMS is inserted', function () {
        var seedTxnString = '01/10/2026 11:00:00|-90.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRCONFLICT123456|';
        var seedText = 'Axis Bank alert: INR 90.00 debited at Test Merchant on 01/10/2026 11:00:00. Account 1234. UTR UTRCONFLICT123456.';
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: seedTxnString,
          originalText: seedText, sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-CONFLICT-SEED'
        }), 'POST');
        pfisPreflightAssert_(response && response.success === true && response.status === 'ACCEPTED', 'Conflict seed did not insert: ' + JSON.stringify(response));
        pfisPreflightAssert_(!!response.transactionId, 'Conflict seed has no transaction ID.');
        return response;
      }, startedAt);

      if (conflictSeedResponse && conflictSeedResponse.transactionId) {
        pfisPreflightRunCase_(report, 'Same reference with a conflicting amount is preserved and flagged', function () {
          var conflictTxnString = '01/10/2026 11:10:00|-95.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRCONFLICT123456|';
          var conflictText = 'Axis Bank email alert: INR 95.00 debited at Test Merchant on 01/10/2026 11:10:00. Account 1234. UTR UTRCONFLICT123456.';
          var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
            action: 'ingest', sourceType: 'EMAIL', txnString: conflictTxnString,
            originalText: conflictText, sender: 'PFIS TEST EMAIL', subject: 'Conflicting amount test', requestId: 'PFIS-TEST-CONFLICT-EMAIL'
          }), 'POST');
          pfisPreflightAssert_(response && response.success === true && response.status === 'CONFLICT', 'Conflicting same-reference amount was not flagged: ' + JSON.stringify(response));
          pfisPreflightAssert_(response.recorded === true, 'Incoming conflicting evidence was not retained separately.');
          pfisPreflightAssert_(Array.isArray(response.conflictingTransactionIds) && response.conflictingTransactionIds.indexOf(conflictSeedResponse.transactionId) >= 0,
            'The original conflicting transaction was not identified.');
          var flagged = pfisGetTransaction(conflictSeedResponse.transactionId, false);
          pfisPreflightAssert_(flagged.validationFlag === 'SOURCE_CONFLICT', 'Existing candidate was not flagged SOURCE_CONFLICT.');
          return 'Incoming alert recorded separately; original candidate flagged SOURCE_CONFLICT';
        }, startedAt);
      } else {
        pfisPreflightRecord_(report, 'Same reference with a conflicting amount is preserved and flagged', null,
          'Skipped because conflict-seed SMS insertion failed.', 0);
      }

      pfisPreflightRunCase_(report, 'Confirmed transaction update saves category and purpose', function () {
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'update', transactionId: smsResponse.transactionId,
          category: 'Transport', purpose: 'Staging test purchase for transport',
          actor: 'PFIS_PRELIGHT_TEST', requestId: 'PFIS-TEST-UPDATE-001'
        }), 'POST');
        pfisPreflightAssert_(response && response.success === true, 'Update failed: ' + JSON.stringify(response));
        var stored = pfisGetTransaction(smsResponse.transactionId, false);
        pfisPreflightAssert_(stored.category === 'Transport', 'Updated category was not stored.');
        pfisPreflightAssert_(stored.userNotes === 'Staging test purchase for transport', 'Updated purpose was not stored.');

        var blankPurpose = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'update', transactionId: smsResponse.transactionId, purpose: '',
          actor: 'PFIS_PREFLIGHT_TEST', reason: 'Purpose intentionally left blank',
          requestId: 'PFIS-TEST-UPDATE-BLANK-PURPOSE'
        }), 'POST');
        pfisPreflightAssert_(blankPurpose && blankPurpose.success === true, 'Blank purpose update was rejected: ' + JSON.stringify(blankPurpose));
        stored = pfisGetTransaction(smsResponse.transactionId, false);
        pfisPreflightAssert_(stored.userNotes === '', 'Blank purpose did not clear User Notes.');
        pfisPreflightAssert_(stored.needsReview === false, 'Blank purpose incorrectly created a review requirement.');

        var blankCategory = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'update', transactionId: smsResponse.transactionId, category: '',
          actor: 'PFIS_PREFLIGHT_TEST', reason: 'Unknown category sent by client',
          requestId: 'PFIS-TEST-UPDATE-BLANK-CATEGORY'
        }), 'POST');
        pfisPreflightAssert_(blankCategory && blankCategory.success === true, 'Blank category did not fall back: ' + JSON.stringify(blankCategory));
        stored = pfisGetTransaction(smsResponse.transactionId, false);
        pfisPreflightAssert_(stored.category === 'Miscellaneous', 'Blank update category did not resolve to Miscellaneous.');
        return 'Purpose can be cleared without review; blank Category is saved as active Miscellaneous';
      }, startedAt);

      if (duplicateResponse && duplicateResponse.transactionId) {
          pfisPreflightRunCase_(report, 'Human duplicate resolution updates review state', function () {
          var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
            action: 'resolveexception', transactionId: duplicateResponse.transactionId,
            resolution: 'CONFIRM_DISTINCT', reason: 'Preflight confirms this represents a separate test transaction',
            actor: 'PFIS_PREFLIGHT_TEST', requestId: 'PFIS-TEST-RESOLVE-001'
          }), 'POST');
          pfisPreflightAssert_(response && response.success === true, 'Exception resolution failed: ' + JSON.stringify(response));
          pfisPreflightAssert_(['EXCEPTION_RESOLVED', 'EXCEPTION_RESOLVED_REVIEW_REMAINS'].indexOf(response.status) >= 0,
            'Unexpected exception status: ' + response.status);

          var oldBudgetOffset = rulesSheet.getRange(2, 23).getValue();
          rulesSheet.getRange(2, 23).setValue(1);
          PFIS_RUNTIME_RULE_CACHE = null;
          var archiveTxn = '01/10/2026 10:03:00|-125.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRARCHIVE99999|NA';
          var archiveText = 'Axis Bank alert reference UTRARCHIVE99999: INR 125.00 debited at Test Merchant on 01/10/2026 10:03:00. Account 1234. Test event C.';
          var candidate = pfisRouteRequest(pfisPreflightParams_(testToken, {
            action: 'ingest', sourceType: 'SMS', txnString: archiveTxn, originalText: archiveText,
            sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-ARCHIVE-CANDIDATE'
          }), 'POST');
          rulesSheet.getRange(2, 23).setValue(oldBudgetOffset);
          PFIS_RUNTIME_RULE_CACHE = null;
          pfisPreflightAssert_(candidate && candidate.success && candidate.status === 'DUPLICATE_CANDIDATE',
            'Archive test candidate was not flagged: ' + JSON.stringify(candidate));
          pfisPreflightAssert_(pfisFindTransactionRow(candidate.transactionId) >= 2,
            'Candidate should be live before explicit archive decision.');
          var archived = pfisRouteRequest(pfisPreflightParams_(testToken, {
            action: 'resolveexception', transactionId: candidate.transactionId,
            resolution: 'CONFIRM_DUPLICATE', duplicateOf: smsResponse.transactionId,
            reason: 'Confirmed same underlying Axis bank payment notification',
            actor: 'PFIS_PREFLIGHT_TEST', requestId: 'PFIS-TEST-CONFIRM-DUPLICATE'
          }), 'POST');
          pfisPreflightAssert_(archived && archived.success && archived.status === 'DUPLICATE_ARCHIVED',
            'Explicit duplicate archive failed: ' + JSON.stringify(archived));
          pfisPreflightAssert_(pfisFindTransactionRow(candidate.transactionId) < 2,
            'Archived duplicate still exists in the active Transaction Log.');
          var archiveRow = pfisFindRowByValue(archiveSheet, 1, candidate.transactionId);
          pfisPreflightAssert_(archiveRow >= 2, 'Confirmed duplicate was not copied to Rejected & Archive Log.');
          pfisPreflightAssert_(pfisHeaderToken(archiveSheet.getRange(1, 40).getDisplayValue()) === 'budgetmonth',
            'Archive helper did not add the missing Budget Month header.');
          pfisPreflightAssert_(pfisHeaderToken(archiveSheet.getRange(1, 41).getDisplayValue()) === 'incomemonth',
            'Archive helper did not add the missing Income Month header.');
          var archivedBudgetMonth = archiveSheet.getRange(archiveRow, 40).getValue();
          pfisPreflightAssert_(Utilities.formatDate(archivedBudgetMonth, PFIS_TIME_ZONE, 'yyyy-MM-dd') === '2026-11-01',
            'Archive operation did not preserve the original November Budget Month.');
          var sources = pfisReadFixedRows(sourceSheet, PFIS_SOURCE_FIELDS.length)
            .map(function (row) { return pfisObjectFromRow(row, PFIS_SOURCE_FIELDS); });
          pfisPreflightAssert_(sources.some(function (source) {
            return source.linkedTxnId === smsResponse.transactionId &&
              pfisString(source.parseStatus).toUpperCase() === 'DUPLICATE_SUPPRESSED' &&
              String(source.notes).indexOf(candidate.transactionId) >= 0;
          }), 'Archived duplicate source evidence was not re-linked to the surviving canonical transaction.');
          return 'Distinct resolution retains the row; confirmed duplicate resolution archives with reason and re-links evidence';
        }, startedAt);
      } else {
        pfisPreflightRecord_(report, 'Human duplicate resolution updates review state', null, 'Skipped because duplicate-candidate setup failed.', 0);
      }

      pfisPreflightRunCase_(report, 'Malformed transaction payload logs parse failure without ledger insertion', function () {
        var before = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: 'not-a-date|bad-amount|Axis Bank',
          originalText: 'PFIS test invalid payload - not a financial alert',
          sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-PARSE-FAIL-001'
        }), 'POST');
        var after = pfisPreflightCountNonblankKeys_(txSheet, 1);
        pfisPreflightAssert_(response && response.status === 'PARSE_FAILED', 'Malformed payload did not return PARSE_FAILED: ' + JSON.stringify(response));
        pfisPreflightAssert_(before === after, 'Malformed payload created a ledger transaction.');
        return 'PARSE_FAILED recorded in Source Log; Transaction Log count unchanged';
      }, startedAt);

      pfisPreflightRunCase_(report, 'Search can sort legacy non-ISO DateTime text', function () {
        var duplicateRow = pfisFindTransactionRow(duplicateResponse && duplicateResponse.transactionId);
        if (duplicateRow >= 2) {
          txSheet.getRange(duplicateRow, 2).setNumberFormat('@').setValue('01/10/2026 10:02:00');
          pfisInvalidateTransactionCache();
        }
        var response = pfisSearchTransactions({ limit: 10 }, 'PFIS-TEST-SEARCH-001');
        pfisPreflightAssert_(response && response.success === true, 'Search failed: ' + JSON.stringify(response));
        pfisPreflightAssert_(response.data && response.data.length >= 2, 'Expected both test transactions in search.');
        pfisPreflightAssert_(response.data.every(function (row) { return !!pfisParseDateValue(row.dateTime); }), 'Search returned an unparseable date.');
        return 'Search completed and all returned dates were parsed';
      }, startedAt);

      pfisPreflightRunCase_(report, 'Configured internal card payment remains internal', function () {
        var parsed = {
          datetime: pfisCreateIndiaDate(2026, 10, 1, 11, 0, 0), amount: -1000,
          bank: 'Axis Bank', accountType: 'Credit Card', instrument: 'Credit Card',
          type: 'card_payment', merchant: 'Axis credit card payment', counterparty: '', refNo: 'CARDTEST1000', balanceAfter: ''
        };
        var rule = pfisEmptyRuleResult();
        rule.category = 'Bills & subscription'; rule.typeOverride = 'card_payment'; rule.notes = 'Monthly card bill settlement';
        var config = { account: 'AXIS_CC', cardName: 'Test Card', instrument: 'Credit Card', isInternal: true, ambiguous: false, unresolved: false };
        var built = pfisBuildTransaction(parsed, { originalText: 'synthetic card-payment test' }, 'SMS', 'PFIS-TEST-CARD-1', 'SRC-TEST-CARD-1', 'hash', rule, config, '', false);
        pfisPreflightAssert_(built.isInternalTransfer === true, 'Configured internal card payment was not marked internal.');
        pfisPreflightAssert_(built.type === 'card_payment', 'Card-payment type changed unexpectedly.');
        return 'card_payment + Is Internal=true -> isInternalTransfer=true';
      }, startedAt);

      pfisPreflightRunCase_(report, 'Blank checkbox cleanup clears only default FALSE values', function () {
        [13, 14, 15, 36, 37].forEach(function (col) { txSheet.getRange(20, col).setValue(false); });
        var beforeTxCount = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var cleanup = pfisCleanupBlankTransactionCheckboxDefaults();
        pfisPreflightAssert_(cleanup && cleanup.success === true, 'Cleanup routine did not succeed: ' + JSON.stringify(cleanup));
        pfisPreflightAssert_(cleanup.cellsCleared === 5, 'Expected exactly 5 default checkbox values cleared, got ' + cleanup.cellsCleared + '.');
        [13, 14, 15, 36, 37].forEach(function (col) {
          pfisPreflightAssert_(txSheet.getRange(20, col).getValue() === '', 'Checkbox default was not cleared from column ' + col + '.');
        });
        pfisPreflightAssert_(pfisPreflightCountNonblankKeys_(txSheet, 1) === beforeTxCount, 'Cleanup changed transaction IDs.');
        pfisPreflightAssert_(txSheet.getRange(2, 1).getValue() !== '', 'Cleanup touched a keyed transaction.');
        return 'Five FALSE defaults cleared on empty row 20; keyed transaction rows preserved';
      }, startedAt);

      pfisPreflightRunCase_(report, 'Unhandled ingestion exception is sheet-logged and retryable', function () {
        var diagnosticText = 'PFIS PREFLIGHT DIAGNOSTIC ONLY ' + Utilities.getUuid();
        var beforeTransactions = pfisPreflightCountNonblankKeys_(txSheet, 1);
        var beforeSources = pfisPreflightCountPrefixedKeys_(sourceSheet, 1, 'SRC-');
        var requestId = 'PFIS-TEST-ERROR-LOG-001';
        var logged = pfisLogUnhandledRequestError({
          action: 'ingest', sourceType: 'SMS', originalText: diagnosticText,
          sender: 'PFIS PREFLIGHT', txnString: 'not-run'
        }, 'ingest', requestId, new Error('SIMULATED_PREFLIGHT_ERROR'));
        pfisPreflightAssert_(logged && logged.sourceLogLogged === true, 'Diagnostic was not recorded in Source Log: ' + JSON.stringify(logged));
        pfisPreflightAssert_(logged.changeLogLogged === true, 'Diagnostic was not recorded in Change Log: ' + JSON.stringify(logged));
        pfisPreflightAssert_(pfisPreflightCountNonblankKeys_(txSheet, 1) === beforeTransactions, 'Diagnostic test created a transaction.');
        pfisPreflightAssert_(pfisPreflightCountPrefixedKeys_(sourceSheet, 1, 'SRC-') === beforeSources + 1, 'Expected one diagnostic Source Log row.');
        var hash = pfisComputeSourceHash('SMS', diagnosticText);
        pfisPreflightAssert_(pfisFindSourceByHash(hash, 'SMS', '', false, false) === null, 'SERVER_ERROR row incorrectly blocked a retry.');
        var expectedChangeId = 'CHG-' + pfisComputeHash('request-server-error:' + requestId).substring(0, 16);
        pfisPreflightAssert_(pfisFindRowByValue(testSpreadsheet.getSheetByName(PFIS_SHEETS.changes), 1, expectedChangeId) >= 2,
          'System error audit entry was not found in Change Log.');
        return 'Error written to Source Log and Change Log; no transaction inserted; retry lookup remains available';
      }, startedAt);

      pfisPreflightRunCase_(report, 'Blank purpose is optional and is not queued', function () {
        var suggestionTxnString = '02/10/2026 10:00:00|-126.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRPREFILL126|';
        var suggestionBody = 'PFIS synthetic purchase for purpose-prefill test: INR 126 at Test Merchant on 02/10/2026 10:00:00. Ref UTRPREFILL126.';
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: suggestionTxnString,
          originalText: suggestionBody, sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-PURPOSE-PREFILL-001'
        }), 'POST');
        pfisPreflightAssert_(response && response.success === true, 'Suggestion test transaction failed to insert: ' + JSON.stringify(response));
        pfisPreflightAssert_(response.requiresPurpose === false, 'Purpose must be optional even when historical suggestions exist.');
        pfisPreflightAssert_(response.nextAction === 'SHOW_RECEIPT', 'Blank purpose should not open a prompt: ' + response.nextAction);
        pfisPreflightAssert_(response.purposeSuggestion === '',
          'Optional purpose contract must not return a prompt default.');
        pfisPreflightAssert_(Array.isArray(response.purposeExamples) && response.purposeExamples.length === 0,
          'Purpose examples should not be part of a required enrichment queue.');
        pfisPreflightAssert_(response.transaction && response.transaction.userNotes === '',
          'Optional purpose must remain blank unless the user supplied it.');

        var queueResponse = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'getneedsenrichment', limit: 50, requestId: 'PFIS-TEST-PURPOSE-PREFILL-QUEUE-001'
        }), 'POST');
        pfisPreflightAssert_(queueResponse && queueResponse.success === true, 'getneedsenrichment failed: ' + JSON.stringify(queueResponse));
        var queued = (queueResponse.data || []).filter(function (item) { return item.transactionId === response.transactionId; })[0];
        pfisPreflightAssert_(!queued, 'A purpose-only gap should not appear in the required enrichment queue.');
        return 'Missing purpose remains blank, is not prompted, and is not added to the required enrichment queue';
      }, startedAt);

      pfisPreflightRunCase_(report, 'Purpose suggestion is explicitly blank when no history matches', function () {
        var txn = '03/10/2026 11:00:00|-127.00|Axis Bank|Savings Account|UPI|expense|Never Before Merchant|Never Before Merchant|UTRNOPURPOSEHISTORY|';
        var body = 'PFIS synthetic purchase at Never Before Merchant, INR 127, reference UTRNOPURPOSEHISTORY.';
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: txn, originalText: body,
          sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-PURPOSE-NO-HISTORY-001'
        }), 'POST');
        pfisPreflightAssert_(response && response.success === true, 'No-history test transaction failed: ' + JSON.stringify(response));
        pfisPreflightAssert_(response.requiresPurpose === false, 'Purpose should remain optional when no history exists.');
        pfisPreflightAssert_(response.nextAction === 'SHOW_RECEIPT', 'Missing purpose must not block the receipt.');
        pfisPreflightAssert_(Object.prototype.hasOwnProperty.call(response, 'purposeSuggestion') && response.purposeSuggestion === '',
          'An optional purpose should not fabricate a default.');
        pfisPreflightAssert_(Array.isArray(response.purposeExamples) && response.purposeExamples.length === 0,
          'No purpose examples should be returned when no historical purpose exists.');
        return 'No purpose history is normal; transaction is accepted with blank User Notes';
      }, startedAt);

      pfisPreflightRunCase_(report, 'End-to-end unmatched amount assigns category and accepts blank purpose', function () {
        var txn = '04/10/2026 12:00:00|-50.00|Axis Bank|Savings Account|UPI|expense|Test Merchant|Test Merchant|UTRFALLBACK050|NA';
        var body = 'PFIS synthetic payment INR 50 to Test Merchant on 04/10/2026 12:00:00. Reference UTRFALLBACK050.';
        var response = pfisRouteRequest(pfisPreflightParams_(testToken, {
          action: 'ingest', sourceType: 'SMS', txnString: txn, originalText: body,
          sender: 'PFIS TEST SMS', requestId: 'PFIS-TEST-MERCHANT-CATEGORY-FALLBACK-001'
        }), 'POST');
        pfisPreflightAssert_(response && response.success === true, 'Fallback transaction failed to insert: ' + JSON.stringify(response));
        pfisPreflightAssert_(response.transaction && response.transaction.category === 'Food & Dining',
          'Merchant category was not assigned during insertion: ' + JSON.stringify(response.transaction));
        pfisPreflightAssert_(response.transaction.userNotes === '', 'A purpose was inherited despite the amount rule not matching.');
        pfisPreflightAssert_(response.transaction.ruleType === 'MERCHANT_CATEGORY_FALLBACK',
          'Insertion did not report merchant-category fallback.');
        pfisPreflightAssert_(response.nextAction === 'SHOW_RECEIPT', 'Blank purpose should not require another interaction: ' + response.nextAction);
        pfisPreflightAssert_(response.requiresPurpose === false, 'The backend still marks purpose as required.');
        pfisPreflightAssert_(response.needsReview === false, 'Missing purpose should not mark the transaction for review.');
        return 'Insertion assigned category and accepted the transaction without asking for purpose';
      }, startedAt);
    } else {
      report.syntheticIntegration.status = 'BLOCKED_AFTER_SMS_INSERTION_FAILURE';
      pfisPreflightRecord_(report, 'Remaining end-to-end workflow', null,
        'Skipped because the initial SMS insert failed; no further dependent writes were attempted.', 0);
    }

    report.syntheticIntegration.status = report.tests.some(function (t) { return t.status === 'FAIL' && /^Synthetic|^Checkbox|^Partially|^End-to-end|^Legacy|^Delayed|^Exact|^Same-channel exact|^Replay of a suppressed|^Similar|^Cross-channel|^Confirmed|^Human|^Malformed|^Search|^Configured internal|^Blank checkbox cleanup|^Purpose suggestion|^End-to-end unmatched amount|^Auto Purpose T header|^Different amount reuses|^Conflicting merchant category/.test(t.name); })
      ? 'FAILED' : 'COMPLETED';

  } catch (error) {
    if (error && error.code === 'PFIS_PREFLIGHT_SAFE_STOP') {
      report.stoppedEarly = true;
      report.stopReason = 'Safe runtime budget reached; remaining tests were not started so cleanup could run.';
      report.syntheticIntegration.status = report.syntheticIntegration.status === 'NOT_STARTED' ? 'NOT_STARTED' : 'STOPPED_EARLY';
      pfisPreflightRecord_(report, 'Runtime budget guard', null, report.stopReason, 0);
    } else {
      report.fatalError = String(error && error.stack ? error.stack : error);
      pfisPreflightRecord_(report, 'Harness setup / fatal error', false, String(error && error.message ? error.message : error), 0);
    }
  } finally {
    report.cleanup.attempted = !!tempSpreadsheetId;
    PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID = originalOverride;
    pfisPreflightResetEngineCaches_();
    if (tempSpreadsheetId) {
      try {
        DriveApp.getFileById(tempSpreadsheetId).setTrashed(true);
        report.cleanup.success = true;
        report.cleanup.message = 'Temporary synthetic spreadsheet was moved to Trash.';
      } catch (cleanupError) {
        report.cleanup.success = false;
        report.cleanup.temporarySpreadsheetId = tempSpreadsheetId;
        report.cleanup.message = 'Could not trash temporary spreadsheet automatically. Manually trash file: ' + tempSpreadsheetName + ' (' + tempSpreadsheetId + '). Error: ' + cleanupError;
      }
    } else {
      report.cleanup.success = true;
      report.cleanup.message = 'No temporary spreadsheet was created.';
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  report.passed = report.tests.filter(function (test) { return test.status === 'PASS'; }).length;
  report.failed = report.tests.filter(function (test) { return test.status === 'FAIL'; }).length;
  report.skipped = report.tests.filter(function (test) { return test.status === 'SKIP'; }).length;

  var liveSchemaOk = report.productionSpreadsheet.status === 'SCHEMA_OK_READ_ONLY';
  var testsPassed = report.failed === 0 && !report.stoppedEarly && report.syntheticIntegration.status === 'COMPLETED';
  report.overallStatus = !testsPassed ? 'FAILED_OR_INCOMPLETE' : (liveSchemaOk ? 'PREFLIGHT_PASSED_STAGING_AND_LIVE_SCHEMA' : 'STAGING_PASSED_LIVE_SCHEMA_NOT_VERIFIED');
  report.productionWritePerformed = false;
  report.note = 'A pass means the engine passed this bounded synthetic suite and (if available) the live header/layout check. It does not replace a human-reviewed first production transaction.';

  Logger.log('PFIS_PREFLIGHT_REPORT\n' + JSON.stringify(report, null, 2));
  return report;
}

function pfisPreflightSetupWorkbook_(spreadsheet) {
  var first = spreadsheet.getSheets()[0];
  first.setName(PFIS_SHEETS.transactions);

  var txHeaders = PFIS_TX_HEADERS.concat(PFIS_LEGACY_TX_HEADERS)
    .concat(['Flow Direction', 'Audit Trail', 'Budget Month', 'Income Month']);
  var sourceHeaders = PFIS_SOURCE_HEADERS.slice();
  var changeHeaders = PFIS_CHANGE_HEADERS.slice();
  var ruleHeaders = PFIS_RULE_HEADERS.concat(PFIS_RULE_OPTIONAL_HEADERS);
  var configHeaders = PFIS_CONFIG_HEADERS.concat([PFIS_CONFIG_TEXT_PATTERN_HEADER]);
  var categoryHeaders = PFIS_CATEGORY_HEADERS.slice();

  pfisPreflightWriteHeaders_(first, txHeaders);
  pfisPreflightWriteHeaders_(spreadsheet.insertSheet(PFIS_SHEETS.sources), sourceHeaders);
  pfisPreflightWriteHeaders_(spreadsheet.insertSheet(PFIS_SHEETS.changes), changeHeaders);
  var rulesSheet = spreadsheet.insertSheet(PFIS_SHEETS.rules);
  pfisPreflightWriteHeaders_(rulesSheet, ruleHeaders);
  // T:W are independent optional rule extensions.
  rulesSheet.getRange(1, PFIS_RULE_AUTO_PURPOSE_COLUMN).setValue(PFIS_RULE_AUTO_PURPOSE_HEADER);
  rulesSheet.getRange(1, PFIS_RULE_PURPOSE_TRIGGER_COLUMN, 1, 3).setValues([[
    PFIS_RULE_PURPOSE_TRIGGER_HEADER, PFIS_RULE_CALENDAR_SCOPE_HEADER, 'Budget Month Offset'
  ]]);
  var configSheet = spreadsheet.insertSheet(PFIS_SHEETS.config);
  pfisPreflightWriteHeaders_(configSheet, configHeaders);
  var categoriesSheet = spreadsheet.insertSheet(PFIS_SHEETS.categories);
  pfisPreflightWriteHeaders_(categoriesSheet, categoryHeaders);
  var archiveSheet = spreadsheet.insertSheet('Rejected & Archive Log');
  // Mimic the current production archive tab, which stops at AM and lacks
  // Budget Month / Income Month even though the ledger has those fields.
  var archiveHeaders = PFIS_TX_HEADERS.concat(PFIS_LEGACY_TX_HEADERS)
    .concat(['Flow Direction', 'Audit Trail']);
  pfisPreflightWriteHeaders_(archiveSheet, archiveHeaders);
  var holidaySheet = spreadsheet.insertSheet(PFIS_HOLIDAY_CALENDAR_SHEET);
  pfisPreflightWriteHeaders_(holidaySheet, ['Date', 'Calendar Scope', 'Is Working Day', 'Description']);

  // One deterministic, explicitly synthetic Rule row. N:S match the optional extension contract.
  rulesSheet.getRange(2, 1, 1, ruleHeaders.length).setValues([[
    true, 'AMOUNT+MERCHANT', 125, 'Test Merchant', 'Food & Dining', 'Test Merchant',
    'Test purchase', 0, false, 'expense', '', '', 1,
    'TEST-RULE', 'preflight', '', false, 0.95, 'Test purpose'
  ]]);
  rulesSheet.getRange(2, PFIS_RULE_AUTO_PURPOSE_COLUMN).setValue(false);

  // Explicit text identity avoids account/card guessing during the test.
  configSheet.getRange(2, 1, 1, configHeaders.length).setValues([[
    'Axis Bank', 'Savings Account', '', '', 'AXIS_SAVINGS', '', 'UPI', false, 1, 'Test Merchant'
  ]]);

  categoriesSheet.getRange(2, 1, 4, 2).setValues([
    ['Food & Dining', true],
    ['Transport', true],
    ['Bills & subscription', true],
    ['Miscellaneous', true]
  ]);
  SpreadsheetApp.flush();
}

function pfisPreflightWriteHeaders_(sheet, headers) {
  if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function pfisPreflightParams_(token, values) {
  var params = Object.assign({}, values || {});
  if (token) params.token = token;
  if (!params.requestId) params.requestId = 'PFIS-PREFLIGHT-' + Utilities.getUuid();
  return params;
}

function pfisPreflightRunCase_(report, name, callback, startedAt) {
  pfisPreflightCheckBudget_(startedAt);
  var caseStarted = Date.now();
  try {
    var details = callback();
    pfisPreflightRecord_(report, name, true, details, Date.now() - caseStarted);
    pfisPreflightCheckBudget_(startedAt);
    return details;
  } catch (error) {
    if (error && error.code === 'PFIS_PREFLIGHT_SAFE_STOP') throw error;
    pfisPreflightRecord_(report, name, false, String(error && error.message ? error.message : error), Date.now() - caseStarted);
    return null;
  }
}

function pfisPreflightAssert_(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed.');
}

function pfisPreflightRecord_(report, name, passed, details, durationMs) {
  report.tests.push({
    name: name,
    status: passed === true ? 'PASS' : (passed === false ? 'FAIL' : 'SKIP'),
    details: details === undefined || details === null ? '' : (typeof details === 'string' ? details : JSON.stringify(details)),
    durationMs: durationMs || 0
  });
}

function pfisPreflightCheckBudget_(startedAt) {
  if (Date.now() - startedAt >= PFIS_PREFLIGHT_MAX_RUNTIME_MS - PFIS_PREFLIGHT_CLEANUP_RESERVE_MS) {
    var error = new Error('Safe runtime budget reached; stop before further test cases and clean up.');
    error.code = 'PFIS_PREFLIGHT_SAFE_STOP';
    throw error;
  }
}

function pfisPreflightResetEngineCaches_() {
  PFIS_RUNTIME_SPREADSHEET_CACHE_ID = '';
  PFIS_RUNTIME_SPREADSHEET_CACHE = null;
  PFIS_RUNTIME_SOURCE_CACHE = null;
  PFIS_RUNTIME_TRANSACTION_CACHE = null;
  PFIS_RUNTIME_CATEGORY_CACHE = null;
  PFIS_RUNTIME_RULE_CACHE = null;
  PFIS_RUNTIME_CONFIG_CACHE = null;
  PFIS_PERF_CONTEXT = null;
}

function pfisPreflightCountNonblankKeys_(sheet, column) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  return sheet.getRange(2, column, lastRow - 1, 1).getValues().filter(function (row) {
    return pfisString(row[0]) !== '';
  }).length;
}

function pfisPreflightCountPrefixedKeys_(sheet, column, prefix) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  return sheet.getRange(2, column, lastRow - 1, 1).getValues().filter(function (row) {
    return pfisString(row[0]).indexOf(prefix) === 0;
  }).length;
}
