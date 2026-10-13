/**
 * PFIS Transaction Engine v1.0.0 — real Google Sheets integration test harness.
 *
 * These are real Google Apps Script + Google Sheets operations, not in-memory mocks.
 * A separate workbook is deliberate: test records must not pollute the production
 * finance ledger. Re-running tests clears only Transaction Log, Source Log, and
 * Change Log in the explicitly configured test workbook; Rules, Config, Categories
 * remain intact. The test workbook must be created with PFIS_TEST_SETUP first.
 *
 * Run manually in Apps Script:
 * 1) PFIS_TEST_SETUP()
 * 2) Open the logged test spreadsheet URL and confirm it says PFIS TEST - ...
 * 3) PFIS_TEST_RUN_ALL()
 * 4) Review the execution log (scenario start/end times and per-request PFIS_PERF
 *    entries when Script Property PFIS_PERF_LOG=TRUE); inspect test workbook rows.
 */

// Test fixture only. Production category choices always come from the Categories sheet.
const PFIS_TEST_DEFAULT_CATEGORIES = Object.freeze([
  'Bills & subscription', 'Cash', 'Credit card payments', 'Food & dining', 'Healthcare',
  'Housing & utilities', 'Income', 'Investment & savings', 'Miscellaneous', 'Shopping',
  'Transportation'
]);


function PFIS_TEST_SETUP() {
  const properties = PropertiesService.getScriptProperties();
  const liveId = String(properties.getProperty('SPREADSHEET_ID') || '').trim();
  let testId = String(properties.getProperty('PFIS_TEST_SPREADSHEET_ID') || '').trim();
  let spreadsheet = null;

  if (testId) {
    try {
      spreadsheet = SpreadsheetApp.openById(testId);
      if (spreadsheet.getId() === liveId || spreadsheet.getName().indexOf('PFIS TEST - ') !== 0) {
        throw new Error('Existing PFIS_TEST_SPREADSHEET_ID is not a dedicated PFIS test workbook.');
      }
    } catch (error) {
      spreadsheet = null;
      testId = '';
    }
  }

  if (!spreadsheet) {
    const stamp = Utilities.formatDate(new Date(), PFIS_TIME_ZONE, 'yyyyMMdd-HHmmss');
    spreadsheet = SpreadsheetApp.create('PFIS TEST - v1.0.0 - ' + stamp);
    testId = spreadsheet.getId();
    const existingSheets = spreadsheet.getSheets();
    const transactionSheet = existingSheets[0];
    transactionSheet.setName(PFIS_SHEETS.transactions);
    for (let i = 1; i < existingSheets.length; i++) spreadsheet.deleteSheet(existingSheets[i]);
    transactionSheet.getRange(1, 1, 1, PFIS_TX_HEADERS.length).setValues([PFIS_TX_HEADERS.slice()]);
    pfisTestCreateSheet(spreadsheet, PFIS_SHEETS.sources, PFIS_SOURCE_HEADERS);
    pfisTestCreateSheet(spreadsheet, PFIS_SHEETS.changes, PFIS_CHANGE_HEADERS);
    pfisTestCreateSheet(spreadsheet, PFIS_SHEETS.rules, PFIS_RULE_HEADERS);
    pfisTestCreateSheet(spreadsheet, PFIS_SHEETS.config, PFIS_CONFIG_HEADERS);
    const categorySheet = pfisTestCreateSheet(spreadsheet, PFIS_SHEETS.categories, PFIS_CATEGORY_HEADERS);
    categorySheet.getRange(2, 1, PFIS_TEST_DEFAULT_CATEGORIES.length, 2).setValues(
      PFIS_TEST_DEFAULT_CATEGORIES.map(function (category) { return [category, true]; })
    );
  }

  // Mirror the optional legacy columns visible in the production workbook.
  // The core v1 transaction schema remains A:AC (29 fields); AL/AM are guarded
  // optional summary fields and are never used to determine transaction identity.
  const txSheet = spreadsheet.getSheetByName(PFIS_SHEETS.transactions);
  if (txSheet.getMaxColumns() < PFIS_AUX_TX_COLUMNS.auditTrail) {
    txSheet.insertColumnsAfter(txSheet.getMaxColumns(), PFIS_AUX_TX_COLUMNS.auditTrail - txSheet.getMaxColumns());
  }
  txSheet.getRange(1, PFIS_AUX_TX_COLUMNS.flowDirection).setValue('Flow Direction');
  txSheet.getRange(1, PFIS_AUX_TX_COLUMNS.auditTrail).setValue('Audit Trail');

  // Optional Rule metadata columns N:S are read only when their headers match.
  const ruleSheet = spreadsheet.getSheetByName(PFIS_SHEETS.rules);
  if (ruleSheet.getMaxColumns() < PFIS_RULE_FIELDS.length + PFIS_RULE_OPTIONAL_HEADERS.length) {
    ruleSheet.insertColumnsAfter(ruleSheet.getMaxColumns(), PFIS_RULE_FIELDS.length + PFIS_RULE_OPTIONAL_HEADERS.length - ruleSheet.getMaxColumns());
  }
  ruleSheet.getRange(1, PFIS_RULE_FIELDS.length + 1, 1, PFIS_RULE_OPTIONAL_HEADERS.length)
    .setValues([PFIS_RULE_OPTIONAL_HEADERS.slice()]);

  properties.setProperty('PFIS_TEST_SPREADSHEET_ID', testId);
  properties.setProperty('PFIS_TEST_SPREADSHEET_URL', spreadsheet.getUrl());
  Logger.log('PFIS test workbook created/confirmed: ' + spreadsheet.getUrl());
  Logger.log('This is a separate test workbook. Production SPREADSHEET_ID was not changed.');
  return { success: true, testSpreadsheetId: testId, url: spreadsheet.getUrl(), title: spreadsheet.getName() };
}

function PFIS_TEST_RUN_ALL() {
  const properties = PropertiesService.getScriptProperties();
  let testId = String(properties.getProperty('PFIS_TEST_SPREADSHEET_ID') || '').trim();
  const liveId = String(properties.getProperty('SPREADSHEET_ID') || '').trim();

  // One-click runner: create an isolated test workbook automatically if this is
  // the first run. The workbook is never SPREADSHEET_ID and is clearly named.
  if (!testId) {
    const setup = PFIS_TEST_SETUP();
    if (!setup || setup.success !== true || !setup.testSpreadsheetId) {
      throw new Error('Could not create or validate the dedicated PFIS test workbook.');
    }
    testId = String(setup.testSpreadsheetId);
  }

  if (testId === liveId) throw new Error('Safety stop: test workbook ID equals production SPREADSHEET_ID.');

  const testSpreadsheet = SpreadsheetApp.openById(testId);
  if (testSpreadsheet.getName().indexOf('PFIS TEST - ') !== 0) {
    throw new Error('Safety stop: PFIS_TEST_SPREADSHEET_ID does not point to a dedicated PFIS TEST workbook.');
  }

  PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID = testId;
  PFIS_RUNTIME_SPREADSHEET_CACHE = testSpreadsheet;
  PFIS_RUNTIME_SPREADSHEET_CACHE_ID = testId;
  pfisInvalidateSourceCache();
  pfisInvalidateTransactionCache();
  PFIS_RUNTIME_CATEGORY_CACHE = null;
  const suiteStarted = new Date();
  pfisTestResetData(testSpreadsheet);

  const results = [];
  function run(name, fn) {
    const start = new Date();
    try {
      const detail = fn() || {};
      const end = new Date();
      results.push({ name: name, status: 'PASS', startedAt: start.toISOString(), endedAt: end.toISOString(),
        milliseconds: end.getTime() - start.getTime(), detail: detail });
    } catch (error) {
      const end = new Date();
      results.push({ name: name, status: 'FAIL', startedAt: start.toISOString(), endedAt: end.toISOString(),
        milliseconds: end.getTime() - start.getTime(), error: error.message || String(error) });
    }
  }

  run('00 pure decision-logic smoke tests', function () {
    const cases = [
      ['missing purpose routes to purpose prompt',
        pfisRecommendNextAction('ACCEPTED', { needsReview: true, reviewReason: 'enrichment_required', merchant: 'ACME', category: '' },
          { requiresPurpose: true, requiresCategoryClassification: true }), 'ASK_PURPOSE'],
      ['purpose complete but category missing routes to classification',
        pfisRecommendNextAction('UPDATED', { needsReview: true, reviewReason: 'enrichment_required', merchant: 'ACME', userNotes: 'office supplies' },
          { requiresPurpose: false, requiresCategoryClassification: true }), 'CLASSIFY_CATEGORY'],
      ['cross-channel reconciliation never opens competing prompt',
        pfisRecommendNextAction('RECONCILED', { needsReview: true, reviewReason: 'enrichment_required', merchant: 'ACME' },
          { requiresPurpose: true, requiresCategoryClassification: true }), 'SHOW_RECEIPT'],
      ['exact replay does not re-open enrichment prompt',
        pfisRecommendNextAction('IDEMPOTENT_REPLAY', { needsReview: true, reviewReason: 'enrichment_required', merchant: 'ACME' },
          { requiresPurpose: true, requiresCategoryClassification: true }), 'SHOW_RECEIPT'],
      ['duplicate candidate requires review',
        pfisRecommendNextAction('DUPLICATE_CANDIDATE', { needsReview: true, reviewReason: 'duplicate_candidate' },
          { requiresPurpose: true, requiresCategoryClassification: true }), 'REVIEW'],
      ['complete transaction returns receipt action',
        pfisRecommendNextAction('UPDATED', { needsReview: false, reviewReason: '' },
          { requiresPurpose: false, requiresCategoryClassification: false }), 'SHOW_RECEIPT'],
      ['merchant copied as purpose remains incomplete',
        pfisIsMeaningfulPurpose('SRI VENKATA', 'SRI VENKATA'), false],
      ['useful purpose is meaningful',
        pfisIsMeaningfulPurpose('lunch with colleagues', 'SRI VENKATA'), true]
    ];
    const failures = cases.filter(function (c) { return c[1] !== c[2]; });
    pfisTestAssert(failures.length === 0, 'Decision-logic failures: ' + JSON.stringify(failures));
    return { checks: cases.length, passed: cases.length };
  });

  run('01 schema and health validation', function () {
    const health = pfisTestRouteRequest({ action: 'health', requestId: 'TEST-HEALTH' }, 'GET');
    pfisTestAssert(health.success && health.engineVersion === 'v1.0.0', 'health should report v1.0.0');
    const validation = pfisValidateWorkbook('TEST-VALIDATE');
    pfisTestAssert(validation.success, 'test workbook schema must be valid: ' + JSON.stringify(validation.checks));
    return { schemaStatus: validation.status };
  });

  run('02 Axis sample: SMS first, sanitized email identity, then verified', function () {
    const txnString = '2026-10-10T16:14:08+05:30|-100.00|Axis Bank|NA|UPI|expense|GUDIVENUKALA VIJAYA|GUDIVENUKALA VIJAYA|435513308371|NA';
    const smsBody = 'INR 100.00 debited\nA/c no. XX0156\n10-10-26, 16:14:08\nUPI/P2A/435513308371/GUDIVENUKALA VIJAYA\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank';
    const emailBody = 'Amount Debited: INR 100.00\nAccount Number: XX\nDate & Time: 10-10-26, 16:14:08 IST\nTransaction Info: UPI/P2A/435513308371/GUDIVENUKALA VIJAYA\nAxis Bank';
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: txnString, originalText: smsBody, requestId: 'T-AXIS-SMS' }, 'POST');
    pfisTestAssert(first.success && first.status === 'ACCEPTED', 'SMS should create first transaction: ' + JSON.stringify(first));
    pfisTestAssert(first.verificationStatus === 'SMS_ONLY', 'first source should be SMS_ONLY');
    const id = first.transactionId;
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: txnString, originalText: emailBody, sender: 'alerts@axis.bank.in', subject: 'INR 100 debit', requestId: 'T-AXIS-EMAIL' }, 'POST');
    pfisTestAssert(second.success && second.status === 'RECONCILED', 'email should reconcile: ' + JSON.stringify(second));
    pfisTestAssert(second.transactionId === id, 'opposite channel must retain canonical Transaction ID');
    pfisTestAssert(second.verificationStatus === 'VERIFIED', 'SMS + email should be VERIFIED');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === 1, 'one canonical transaction expected');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.sources) === 2, 'two source evidence rows expected');
    return { transactionId: id, verificationStatus: second.verificationStatus };
  });

  run('03 exact same-channel replay is idempotent', function () {
    const txnString = '2026-10-10T16:14:08+05:30|-100.00|Axis Bank|NA|UPI|expense|GUDIVENUKALA VIJAYA|GUDIVENUKALA VIJAYA|435513308371|NA';
    const smsBody = 'INR 100.00 debited\nA/c no. XX0156\n10-10-26, 16:14:08\nUPI/P2A/435513308371/GUDIVENUKALA VIJAYA\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank';
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions); const beforeSource = pfisTestCount(PFIS_SHEETS.sources);
    const result = pfisTestRouteRequest({ sourceType: 'SMS', txnString: txnString, originalText: smsBody, requestId: 'T-AXIS-REPLAY' }, 'POST');
    pfisTestAssert(result.status === 'IDEMPOTENT_REPLAY', 'same SMS should return IDEMPOTENT_REPLAY');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx, 'replay must not create transaction');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.sources) === beforeSource, 'replay must not create source row');
    return { status: result.status };
  });

  run('04 Email first then SMS is equally valid', function () {
    const emailTxn = '2026-10-10T16:25:00+05:30|-250.00|HDFC Bank|Savings Account|UPI|expense|VIMAN COFFEE|VIMAN COFFEE|RRN-EMAIL-FIRST|NA';
    const smsTxn = '2026-10-10T16:27:00+05:30|-250.00|HDFC Bank|Savings Account|UPI|expense|VIMAN COFFEE|VIMAN COFFEE|RRN-SMS-LATER|NA';
    const emailBody = 'HDFC Bank alert: INR 250 debited. Account Number: XX. Merchant: VIMAN COFFEE at 16:25:00.';
    const smsBody = 'INR 250 debited\nA/c no. XX\n10-10-26, 16:27:00\nVIMAN COFFEE\nHDFC Bank';
    const first = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: emailTxn, originalText: emailBody, requestId: 'T-EMAIL-FIRST' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'SMS', txnString: smsTxn, originalText: smsBody, requestId: 'T-SMS-LATER' }, 'POST');
    pfisTestAssert(first.status === 'ACCEPTED', 'first email should insert');
    pfisTestAssert(second.status === 'RECONCILED' && second.transactionId === first.transactionId, 'later SMS should verify the same event');
    return { transactionId: first.transactionId, status: second.status };
  });

  run('05 distinct same-channel alert inside five minutes is preserved and flagged', function () {
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T12:00:00+05:30|-100.00|Axis Bank|Savings Account|UPI|expense|DUP CAFE|DUP CAFE|REF-DUP-1|NA', originalText: 'SMS DUP1 A/c no. XX0156 12:00 DUP CAFE INR 100 debited', requestId: 'T-DUP-1' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T12:03:00+05:30|-100.00|Axis Bank|Savings Account|UPI|expense|DUP CAFE|DUP CAFE|REF-DUP-2|NA', originalText: 'SMS DUP2 A/c no. XX0156 12:03 DUP CAFE INR 100 debited, alert sequence 2', requestId: 'T-DUP-2' }, 'POST');
    pfisTestAssert(first.transactionId !== second.transactionId, 'both distinct source alerts must have transaction rows');
    pfisTestAssert(second.status === 'DUPLICATE_CANDIDATE', 'second row should be duplicate candidate');
    pfisTestAssert(second.transaction.validationFlag === 'DUPLICATE_CANDIDATE' && second.transaction.needsReview === true, 'duplicate row must require review');
    return { first: first.transactionId, second: second.transactionId, validationFlag: second.transaction.validationFlag };
  });

  run('06 cross-channel source one second outside five minutes does not auto-reconcile', function () {
    const sms = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T13:00:00+05:30|-300.00|ICICI Bank|Savings Account|UPI|expense|LATE WINDOW MART|LATE WINDOW MART|REF-LATE-1|NA', originalText: 'ICICI SMS INR 300 debit at 13:00 LATE WINDOW MART account XX4321', requestId: 'T-LATE-SMS' }, 'POST');
    const email = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T13:05:01+05:30|-300.00|ICICI Bank|Savings Account|UPI|expense|LATE WINDOW MART|LATE WINDOW MART|REF-LATE-1|NA', originalText: 'ICICI email INR 300 debit at 13:05:01 LATE WINDOW MART account XX4321', requestId: 'T-LATE-EMAIL' }, 'POST');
    pfisTestAssert(sms.transactionId !== email.transactionId, 'outside-window messages must not merge');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) >= 2, 'two distinct transaction rows expected');
    return { sms: sms.transactionId, email: email.transactionId, emailStatus: email.status };
  });

  run('07 merchant matching is exact after normalization, never substring', function () {
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T14:00:00+05:30|-75.00|Axis Bank|NA|UPI|expense|ACME STORE|ACME STORE|REF-ACME-1|NA', originalText: 'SMS merchant ACME STORE INR 75 14:00 account XX1122', requestId: 'T-ACME-1' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T14:01:00+05:30|-75.00|Axis Bank|NA|UPI|expense|ACME|ACME|REF-ACME-2|NA', originalText: 'Email merchant ACME INR 75 14:01 account XX1122', requestId: 'T-ACME-2' }, 'POST');
    pfisTestAssert(first.transactionId !== second.transactionId, 'ACME must not partially match ACME STORE');
    return { firstMerchant: first.transaction.merchant, secondMerchant: second.transaction.merchant };
  });

  run('08 date-only evidence does not prove a five-minute match', function () {
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10|-60.00|Axis Bank|NA|UPI|expense|DATE ONLY SHOP|DATE ONLY SHOP|REF-DATE-1|NA', originalText: 'SMS INR 60 DATE ONLY SHOP on 10 Oct 2026 account XX2222', requestId: 'T-DATE-ONLY' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T10:00:00+05:30|-60.00|Axis Bank|NA|UPI|expense|DATE ONLY SHOP|DATE ONLY SHOP|REF-DATE-2|NA', originalText: 'Email INR 60 DATE ONLY SHOP on 10 Oct 2026 at 10 AM account XX2222', requestId: 'T-DATE-TIME' }, 'POST');
    pfisTestAssert(first.transactionId !== second.transactionId, 'date-only source must not be auto-linked');
    const updatedFirst = pfisGetTransaction(first.transactionId, false);
    pfisTestAssert(updatedFirst.needsReview === true, 'original candidate should be flagged for unavailable time precision');
    pfisTestAssert(second.transaction.needsReview === true, 'new candidate should be flagged for unavailable time precision');
    return { firstPrecision: updatedFirst.datePrecision, secondReviewReason: second.transaction.reviewReason };
  });

  run('09 Account Type conflict is retained as source conflict, not auto-merged', function () {
    const before = pfisTestCount(PFIS_SHEETS.transactions);
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T15:00:00+05:30|-500.00|Axis Bank|Savings Account|UPI|expense|ACCOUNT TYPE TEST|ACCOUNT TYPE TEST|REF-CONFLICT-1|NA', originalText: 'SMS A/c no. XX1111 INR 500 ACCOUNT TYPE TEST 15:00', requestId: 'T-TYPE-1' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T15:01:00+05:30|-500.00|Axis Bank|Credit Card|UPI|expense|ACCOUNT TYPE TEST|ACCOUNT TYPE TEST|REF-CONFLICT-1|NA', originalText: 'Email Account Number XX1111 INR 500 ACCOUNT TYPE TEST 15:01', requestId: 'T-TYPE-2' }, 'POST');
    pfisTestAssert(first.transactionId, 'first source must insert transaction');
    pfisTestAssert(second.status === 'CONFLICT', 'conflicting account types should create source conflict');
    pfisTestAssert(second.transactionId !== first.transactionId, 'conflicting evidence must be preserved as a separate transaction');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === before + 2, 'both conflicting events must be recorded in Transaction Log');
    pfisTestAssert(second.transaction.validationFlag === 'SOURCE_CONFLICT', 'new conflict row must be flagged for review');
    return { status: second.status, reason: second.reason, incomingTransactionId: second.transactionId, originalTransactionId: first.transactionId };
  });

  run('10 conflicting meaningful account suffixes are not auto-reconciled', function () {
    const before = pfisTestCount(PFIS_SHEETS.transactions);
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T15:10:00+05:30|-510.00|Axis Bank|Savings Account|UPI|expense|ACCOUNT SUFFIX TEST|ACCOUNT SUFFIX TEST|REF-SUFFIX-1|NA', originalText: 'SMS A/c no. XX1111 INR 510 ACCOUNT SUFFIX TEST 15:10', requestId: 'T-SUFFIX-1' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T15:11:00+05:30|-510.00|Axis Bank|Savings Account|UPI|expense|ACCOUNT SUFFIX TEST|ACCOUNT SUFFIX TEST|REF-SUFFIX-1|NA', originalText: 'Email Account Number XX2222 INR 510 ACCOUNT SUFFIX TEST 15:11', requestId: 'T-SUFFIX-2' }, 'POST');
    pfisTestAssert(second.status === 'CONFLICT', 'different meaningful suffixes must conflict');
    pfisTestAssert(second.transactionId !== first.transactionId, 'conflicting suffix event must be independently recorded');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === before + 2, 'both suffix-conflicting events must have ledger rows');
    return { status: second.status, reason: second.reason, incomingTransactionId: second.transactionId, originalTransactionId: first.transactionId };
  });

  run('11 category/purpose update modifies transaction and writes Change Log', function () {
    const created = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T18:00:00+05:30|-180.00|HDFC Bank|Savings Account|UPI|expense|UPDATE TEST SHOP|UPDATE TEST SHOP|REF-UPDATE-1|NA', originalText: 'SMS HDFC debit INR 180 UPDATE TEST SHOP at 18:00 account XX3333', requestId: 'T-UPDATE-CREATE' }, 'POST');
    pfisTestAssert(created.needsEnrichment === true, 'unmatched transaction should report enrichment required');
    pfisTestAssert(created.transaction.needsReview === true && created.transaction.reviewReason === 'enrichment_required',
      'missing category/purpose must remain visible in the review queue');
    const createdRow = pfisFindTransactionRow(created.transactionId);
    pfisTestAssert(pfisGetRequiredSheet(PFIS_SHEETS.transactions).getRange(createdRow, PFIS_AUX_TX_COLUMNS.flowDirection).getValue() === 'OUTFLOW',
      'negative amount must write OUTFLOW into optional Flow Direction');
    pfisTestAssert(String(pfisGetRequiredSheet(PFIS_SHEETS.transactions).getRange(createdRow, PFIS_AUX_TX_COLUMNS.auditTrail).getValue()).indexOf('Created from SMS') >= 0,
      'creation should write a concise Audit Trail summary');
    const updated = pfisTestRouteRequest({ action: 'update', transactionId: created.transactionId, category: 'Food & dining', purpose: 'Dinner after work', actor: 'user', reason: 'shortcut_enrichment', requestId: 'T-UPDATE' }, 'POST');
    pfisTestAssert(updated.success && updated.status === 'UPDATED', 'update should succeed: ' + JSON.stringify(updated));
    pfisTestAssert(updated.transaction.needsReview === false && updated.needsEnrichment === false,
      'completed purpose/category should clear enrichment-only review state');
    pfisTestAssert(String(pfisGetRequiredSheet(PFIS_SHEETS.transactions).getRange(createdRow, PFIS_AUX_TX_COLUMNS.auditTrail).getValue()).indexOf('Updated category, userNotes') >= 0,
      'update should append a concise Audit Trail summary');
    pfisTestAssert(updated.transaction.category === 'Food & dining', 'category should update');
    pfisTestAssert(updated.transaction.userNotes === 'Dinner after work', 'purpose should update');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.changes) >= 3, 'creation and updates should be audited');
    return { transactionId: created.transactionId, changedFields: updated.changedFields, changeLogRows: pfisTestCount(PFIS_SHEETS.changes) };
  });

  run('12 unknown semantic type is reviewable and not inferred from amount sign', function () {
    const result = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T18:10:00+05:30|-90.00|SBI|NA|UPI|NA|UNKNOWN TYPE SHOP|UNKNOWN TYPE SHOP|REF-TYPE-UNKNOWN|NA', originalText: 'SBI debit INR 90 UNKNOWN TYPE SHOP', requestId: 'T-UNKNOWN-TYPE' }, 'POST');
    pfisTestAssert(result.success && result.transaction.type === '', 'unknown type must remain blank');
    pfisTestAssert(result.transaction.needsReview === true && result.transaction.reviewReason === 'unknown_transaction_type', 'unknown type must be sent to review');
    return { type: result.transaction.type, reviewReason: result.transaction.reviewReason };
  });

  run('13 malformed parser output preserves raw evidence as PARSE_FAILED', function () {
    const result = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: 'too|few|fields', originalText: 'Example invalid financial alert', requestId: 'T-PARSE-FAIL' }, 'POST');
    pfisTestAssert(result.status === 'PARSE_FAILED', 'malformed parser payload should be rejected');
    const source = pfisTestFindSource(result.sourceId);
    pfisTestAssert(source && source.rawBody === 'Example invalid financial alert', 'raw evidence must remain intact');
    return { status: result.status, sourceId: result.sourceId };
  });

  run('14 bounded agent analytics endpoints respond without exposing raw evidence', function () {
    const overview = pfisTestRouteRequest({ action: 'getfinancialoverview', period: 'all_time', requestId: 'T-ANALYTICS' }, 'GET');
    const search = pfisTestRouteRequest({ action: 'searchtransactions', limit: 5, requestId: 'T-SEARCH' }, 'GET');
    pfisTestAssert(overview.success && overview.totals && overview.metricVersion === 'PFIS_METRICS_v1', 'overview endpoint failed');
    pfisTestAssert(search.success && search.limit <= 100, 'search must be bounded');
    pfisTestAssert(!search.data.some(function (row) { return Object.prototype.hasOwnProperty.call(row, 'rawBody'); }), 'analytics must not return rawBody');
    return { transactionCount: overview.counts.total, searchCount: search.data.length };
  });

  run('15 Source Log stores date precision and preserves original Ingested At', function () {
    const body = 'Precision test SMS: INR 123 debited at 09:01:02, merchant PRECISION SHOP, account XX7654';
    const result = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T09:01:02+05:30|-123.00|Axis Bank|NA|UPI|expense|PRECISION SHOP|PRECISION SHOP|REF-PRECISION|NA', originalText: body, requestId: 'T-PRECISION' }, 'POST');
    const source = pfisTestFindSourceByTxnAndType(result.transactionId, 'SMS');
    pfisTestAssert(source && source.datePrecision === 'DATETIME', 'DATETIME precision must be stored in Source Log');
    pfisTestAssert(source.rawBody === body, 'raw body must be preserved exactly');
    const before = new Date(source.ingestedAt).getTime();
    pfisFinalizeSource(source.rowNumber, source.parseStatus, 'timestamp invariant test', '');
    const after = new Date(pfisTestFindSourceByTxnAndType(result.transactionId, 'SMS').ingestedAt).getTime();
    pfisTestAssert(before === after, 'finalizing a source must not overwrite original Ingested At');
    return { datePrecision: source.datePrecision, ingestedAtPreserved: before === after };
  });

  run('16 signed amount mismatch must not reconcile', function () {
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T09:15:00+05:30|-100.00|Axis Bank|Savings Account|UPI|expense|SIGN TEST SHOP|SIGN TEST SHOP|REF-SIGN-OUT|NA', originalText: 'SMS OUT INR 100 SIGN TEST SHOP 09:15 account XX7654', requestId: 'T-SIGN-OUT' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T09:16:00+05:30|100.00|Axis Bank|Savings Account|UPI|income|SIGN TEST SHOP|SIGN TEST SHOP|REF-SIGN-IN|NA', originalText: 'Email IN INR 100 SIGN TEST SHOP 09:16 account XX7654', requestId: 'T-SIGN-IN' }, 'POST');
    pfisTestAssert(first.transactionId !== second.transactionId, 'opposite signs must not share a transaction ID');
    pfisTestAssert(second.status === 'ACCEPTED', 'different signed amount should be treated as a separate event, not conflict by guessed identity');
    return { outgoing: first.transactionId, incoming: second.transactionId };
  });

  run('17 five-minute boundary is inclusive', function () {
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T10:00:00+05:30|-45.00|Axis Bank|NA|UPI|expense|BOUNDARY SHOP|BOUNDARY SHOP|REF-BOUNDARY-1|NA', originalText: 'SMS INR 45 BOUNDARY SHOP at 10:00 account XX7788', requestId: 'T-BOUNDARY-SMS' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T10:05:00+05:30|-45.00|Axis Bank|NA|UPI|expense|BOUNDARY SHOP|BOUNDARY SHOP|REF-BOUNDARY-2|NA', originalText: 'Email INR 45 BOUNDARY SHOP at 10:05 account XX7788', requestId: 'T-BOUNDARY-EMAIL' }, 'POST');
    pfisTestAssert(second.status === 'RECONCILED' && second.transactionId === first.transactionId, 'exactly five minutes must reconcile');
    return { transactionId: first.transactionId, status: second.status };
  });

  run('18 read API blocks on recognized positional schema drift', function () {
    const sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
    const original = sheet.getRange(1, 2).getValue();
    sheet.getRange(1, 2).setValue('Amount'); // Amount belongs at column 3.
    let response;
    const originalConsoleError = console.error;
    try {
      // This rejection is intentionally expected. Suppress the production error
      // log for this one negative test so a passing suite is not misleading.
      console.error = function () {};
      response = pfisTestRouteRequest({ action: 'getfinancialoverview', period: 'all_time', requestId: 'T-SCHEMA-DRIFT' }, 'GET');
    } finally {
      console.error = originalConsoleError;
      sheet.getRange(1, 2).setValue(original);
    }
    pfisTestAssert(!response.success && response.error === 'SCHEMA_INVALID', 'read API must block on positional schema drift');
    return { error: response.error, headerRestored: sheet.getRange(1, 2).getValue() === original };
  });

  run('19 bank mismatch must not reconcile', function () {
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T08:00:00+05:30|-88.00|Axis Bank|NA|UPI|expense|BANK TEST SHOP|BANK TEST SHOP|REF-BANK-1|NA', originalText: 'Axis SMS INR 88 BANK TEST SHOP 08:00 account XX9090', requestId: 'T-BANK-AXIS' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T08:01:00+05:30|-88.00|HDFC Bank|NA|UPI|expense|BANK TEST SHOP|BANK TEST SHOP|REF-BANK-2|NA', originalText: 'HDFC Email INR 88 BANK TEST SHOP 08:01 account XX9090', requestId: 'T-BANK-HDFC' }, 'POST');
    pfisTestAssert(first.transactionId !== second.transactionId, 'different banks must not reconcile');
    return { axis: first.transactionId, hdfc: second.transactionId };
  });

  run('20 explicit reprocessing preserves prior source and creates corrected result', function () {
    const rawBody = 'PFIS reprocess test alert; amount INR 32; merchant REPROCESS SHOP';
    const failed = pfisTestRouteRequest({ sourceType: 'SMS', txnString: 'malformed|payload', originalText: rawBody, requestId: 'T-REPROCESS-FAILED' }, 'POST');
    pfisTestAssert(failed.status === 'PARSE_FAILED' && failed.sourceId, 'initial malformed source must be retained');
    const corrected = pfisTestRouteRequest({ action: 'reprocesssource', sourceId: failed.sourceId,
      txnString: '2026-10-10T07:35:00+05:30|-32.00|Axis Bank|NA|UPI|expense|REPROCESS SHOP|REPROCESS SHOP|REF-REPROCESS|NA',
      requestId: 'T-REPROCESS-CORRECTED' }, 'POST');
    pfisTestAssert(corrected.success && corrected.status === 'ACCEPTED', 'corrected source should insert a valid transaction');
    const oldSource = pfisTestFindSource(failed.sourceId);
    pfisTestAssert(oldSource && oldSource.parseStatus === 'SUPERSEDED', 'old parse-failed source must be retained as SUPERSEDED');
    pfisTestAssert(oldSource.rawBody === rawBody, 'reprocessing must preserve original raw body');
    pfisTestAssert(corrected.transactionId && pfisGetTransaction(corrected.transactionId, false), 'corrected transaction must exist');
    return { previousSourceStatus: oldSource.parseStatus, transactionId: corrected.transactionId, newSourceId: corrected.sourceId };
  });

  run('21 missing or generic merchant is retained for review and not matched', function () {
    const body1 = 'Axis SMS INR 19.00 debit; merchant unavailable; at 06:00 account XX4567';
    const body2 = 'Axis email INR 19.00 debit; merchant unavailable; at 06:01 account XX4567';
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T06:00:00+05:30|-19.00|Axis Bank|NA|UPI|expense|NA|NA|REF-MISSING-MERCHANT-1|NA', originalText: body1, requestId: 'T-MISSING-MERCHANT-SMS' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T06:01:00+05:30|-19.00|Axis Bank|NA|UPI|expense|Unspecified|Unspecified|REF-MISSING-MERCHANT-2|NA', originalText: body2, requestId: 'T-MISSING-MERCHANT-EMAIL' }, 'POST');
    pfisTestAssert(first.transactionId !== second.transactionId, 'generic merchant records must not reconcile');
    pfisTestAssert(first.transaction.needsReview && first.transaction.reviewReason === 'merchant_missing_or_unusable', 'first generic merchant row should be flagged for review');
    return { firstReason: first.transaction.reviewReason, separateTransactions: first.transactionId !== second.transactionId };
  });

  run('22 same real reference with conflicting amount is preserved as CONFLICT', function () {
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T05:00:00+05:30|-20.00|Axis Bank|Savings Account|UPI|expense|REF CONFLICT SHOP|REF CONFLICT SHOP|RRN-CONFLICT-REAL|NA', originalText: 'Axis SMS INR 20 REF CONFLICT SHOP RRN-CONFLICT-REAL at 05:00', requestId: 'T-REF-CONFLICT-SMS' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T05:01:00+05:30|-21.00|Axis Bank|Savings Account|UPI|expense|REF CONFLICT SHOP|REF CONFLICT SHOP|RRN-CONFLICT-REAL|NA', originalText: 'Axis email INR 21 REF CONFLICT SHOP RRN-CONFLICT-REAL at 05:01', requestId: 'T-REF-CONFLICT-EMAIL' }, 'POST');
    pfisTestAssert(second.status === 'CONFLICT', 'same reference and different amount should be conflict');
    pfisTestAssert(first.transactionId !== second.transactionId, 'conflicting amount must be recorded separately, not dropped or merged');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) >= 2, 'conflicting amount must have its own ledger row');
    pfisTestAssert(second.transaction.validationFlag === 'SOURCE_CONFLICT', 'new conflicting transaction must be flagged');
    return { status: second.status, reason: second.reason, originalTransactionId: first.transactionId, incomingTransactionId: second.transactionId };
  });

  run('23 ambiguous matching candidates are not guessed', function () {
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T04:00:00+05:30|-101.00|Axis Bank|NA|UPI|expense|AMBIGUOUS SHOP|AMBIGUOUS SHOP|REF-AMB-1|NA', originalText: 'SMS INR 101 AMBIGUOUS SHOP 04:00 account XX1212 event A', requestId: 'T-AMB-1' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'SMS', txnString: '2026-10-10T04:04:00+05:30|-101.00|Axis Bank|NA|UPI|expense|AMBIGUOUS SHOP|AMBIGUOUS SHOP|REF-AMB-2|NA', originalText: 'SMS INR 101 AMBIGUOUS SHOP 04:04 account XX1212 event B', requestId: 'T-AMB-2' }, 'POST');
    const email = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: '2026-10-10T04:02:00+05:30|-101.00|Axis Bank|NA|UPI|expense|AMBIGUOUS SHOP|AMBIGUOUS SHOP|REF-AMB-3|NA', originalText: 'Email INR 101 AMBIGUOUS SHOP 04:02 account XX1212', requestId: 'T-AMB-EMAIL' }, 'POST');
    pfisTestAssert(first.transactionId !== second.transactionId, 'distinct same-channel records must remain separate');
    pfisTestAssert(email.status === 'CONFLICT', 'equally plausible cross-channel candidates should produce conflict');
    pfisTestAssert((email.conflictingTransactionIds || []).length === 2, 'both candidate transaction IDs should be returned');
    return { status: email.status, candidates: email.conflictingTransactionIds, newTransactionId: email.transactionId };
  });

  run('24 identical text across opposite channels is not an idempotent replay', function () {
    const body = 'Same textual bank alert for cross-channel hash test; INR 67; HASH SCOPE SHOP at 03:00; account XX3434';
    const txn = '2026-10-10T03:00:00+05:30|-67.00|Axis Bank|NA|UPI|expense|HASH SCOPE SHOP|HASH SCOPE SHOP|REF-HASH-SCOPE|NA';
    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: txn, originalText: body, requestId: 'T-HASH-SCOPE-SMS' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: txn, originalText: body, requestId: 'T-HASH-SCOPE-EMAIL' }, 'POST');
    pfisTestAssert(first.status === 'ACCEPTED', 'first SMS should be accepted');
    pfisTestAssert(second.status === 'RECONCILED' && second.transactionId === first.transactionId, 'identical evidence on opposite channel should reconcile instead of replay');
    pfisTestAssert(second.sourceId && second.sourceId !== first.sourceId, 'each channel must retain its own source ID');
    return { status: second.status, smsSourceId: first.sourceId, emailSourceId: second.sourceId };
  });

  run('25 suffix-specific Config does not assign an account when the source identifier is masked', function () {
    const configSheet = pfisGetRequiredSheet(PFIS_SHEETS.config);
    const previousRow = configSheet.getRange(2, 1, 1, PFIS_CONFIG_FIELDS.length).getValues()[0];
    const previousSuffixFormat = configSheet.getRange(2, 3).getNumberFormat();
    try {
      // A suffix is an identifier, not a number. Force Plain text before writing
      // so a leading zero cannot be silently lost by spreadsheet coercion.
      configSheet.getRange(2, 3).setNumberFormat('@');
      configSheet.getRange(2, 1, 1, PFIS_CONFIG_FIELDS.length).setValues([[
        'Axis Bank', 'Savings Account', '', '', 'Axis Savings 0156', '', 'UPI', false, 1
      ]]);
      configSheet.getRange(2, 3).setValue('0156');
      const unknownId = pfisTestRouteRequest({ sourceType: 'EMAIL',
        txnString: '2026-10-10T04:00:00+05:30|-111.00|Axis Bank|Savings Account|UPI|expense|UNKNOWN ID SHOP|UNKNOWN ID SHOP|REF-CFG-UNKNOWN|NA',
        originalText: 'Axis Bank email INR 111 debit at 04:00 Account Number: XX', requestId: 'T-CONFIG-UNKNOWN-ID' }, 'POST');
      pfisTestAssert(unknownId.transaction.account === '', 'unknown/masked identifier must not select a specific account mapping or guess an account from the bank name');
      const knownId = pfisTestRouteRequest({ sourceType: 'SMS',
        txnString: '2026-10-10T04:10:00+05:30|-112.00|Axis Bank|Savings Account|UPI|expense|KNOWN ID SHOP|KNOWN ID SHOP|REF-CFG-KNOWN|NA',
        originalText: 'Axis Bank SMS INR 112 debit at 04:10 A/c no. XX0156', requestId: 'T-CONFIG-KNOWN-ID' }, 'POST');
      const suffixDebug = {
        storedValue: configSheet.getRange(2, 3).getValue(),
        displayedValue: configSheet.getRange(2, 3).getDisplayValue(),
        extractedSourceIdentifier: pfisExtractAccountIdentifier('A/c no. XX0156'),
        normalizedSourceIdentifier: pfisNormalizeAccountIdentifier(pfisExtractAccountIdentifier('A/c no. XX0156')),
        normalizedConfigSuffix: pfisNormalizeConfiguredSuffix(configSheet.getRange(2, 3).getValue()),
        actualAccount: knownId.transaction.account
      };
      pfisTestAssert(knownId.transaction.account === 'Axis Savings 0156', 'matching meaningful suffix should select the configured account; diagnostic=' + JSON.stringify(suffixDebug));
      return { unknownIdentifierAccount: unknownId.transaction.account, knownIdentifierAccount: knownId.transaction.account, suffixDebug: suffixDebug };
    } finally {
      configSheet.getRange(2, 1, 1, PFIS_CONFIG_FIELDS.length).setValues([previousRow]);
      configSheet.getRange(2, 3).setNumberFormat(previousSuffixFormat);
    }
  });

  run('26 ISO timestamps with fractional seconds retain DATETIME precision', function () {
    const result = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-10T04:30:00.250Z|-113.00|Axis Bank|NA|UPI|expense|FRACTIONAL TIME SHOP|FRACTIONAL TIME SHOP|REF-FRACTIONAL-TIME|NA',
      originalText: 'Axis Bank SMS INR 113 debit at 10:00:00.250 IST Account Number XX7878', requestId: 'T-FRACTIONAL-TIME' }, 'POST');
    pfisTestAssert(result.success, 'fractional-second ISO timestamp should parse');
    const source = pfisFindSourceById(result.sourceId);
    pfisTestAssert(source.datePrecision === 'DATETIME', 'fractional seconds must not downgrade timestamp precision to DATE_ONLY');
    return { datePrecision: source.datePrecision };
  });

  run('27 two distinct EMAIL alerts without SMS preserve both and flag the second', function () {
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
    const beforeSources = pfisTestCount(PFIS_SHEETS.sources);
    const first = pfisTestRouteRequest({ sourceType: 'EMAIL',
      txnString: '2026-10-10T02:00:00+05:30|-275.00|Axis Bank|Savings Account|UPI|expense|EMAIL DUP CAFE|EMAIL DUP CAFE|REF-EMAIL-DUP-1|NA',
      originalText: 'Axis Bank email alert #1 INR 275 debited Account Number XX0456 EMAIL DUP CAFE at 02:00',
      sender: 'alerts@axis.bank.in', subject: 'Debit alert 1', requestId: 'T-EMAIL-DUP-1' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'EMAIL',
      txnString: '2026-10-10T02:03:00+05:30|-275.00|Axis Bank|Savings Account|UPI|expense|EMAIL DUP CAFE|EMAIL DUP CAFE|REF-EMAIL-DUP-2|NA',
      originalText: 'Axis Bank email alert #2 INR 275 debited Account Number XX0456 EMAIL DUP CAFE at 02:03; second notification',
      sender: 'alerts@axis.bank.in', subject: 'Debit alert 2', requestId: 'T-EMAIL-DUP-2' }, 'POST');
    pfisTestAssert(first.status === 'ACCEPTED', 'first email should insert: ' + JSON.stringify(first));
    pfisTestAssert(second.status === 'DUPLICATE_CANDIDATE', 'second distinct email within five minutes should be flagged: ' + JSON.stringify(second));
    pfisTestAssert(first.transactionId !== second.transactionId, 'same-channel email duplicate must preserve separate transaction records');
    pfisTestAssert(second.transaction.validationFlag === 'DUPLICATE_CANDIDATE' && second.transaction.needsReview, 'second email transaction must be reviewable');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 2, 'both email transactions must be physically inserted');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.sources) === beforeSources + 2, 'both email source rows must be physically inserted');
    return { firstTransactionId: first.transactionId, secondTransactionId: second.transactionId,
      transactionRowsAdded: 2, sourceRowsAdded: 2, secondStatus: second.status };
  });

  run('28 EMAIL insert -> purpose/category update same row -> SMS verifies without overwriting user data', function () {
    const txnString = '2026-10-10T01:30:00+05:30|-340.00|Axis Bank|Savings Account|UPI|expense|HOME GROCERY TEST|HOME GROCERY TEST|REF-EMAIL-UPDATE-1|NA';
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
    const beforeSources = pfisTestCount(PFIS_SHEETS.sources);
    const email = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: txnString,
      originalText: 'Axis Bank debit email INR 340 at 01:30. Account Number: XX. Merchant HOME GROCERY TEST.',
      sender: 'alerts@axis.bank.in', subject: 'Debit alert', requestId: 'T-EMAIL-UPDATE-INSERT' }, 'POST');
    pfisTestAssert(email.status === 'ACCEPTED', 'email-first event must insert: ' + JSON.stringify(email));
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1, 'email-first event must create one transaction row');

    const update = pfisTestRouteRequest({ action: 'update', transactionId: email.transactionId,
      purpose: 'Weekly household groceries', category: 'Food & dining', actor: 'user',
      reason: 'test_email_origin_enrichment', requestId: 'T-EMAIL-UPDATE-USER' }, 'POST');
    pfisTestAssert(update.success && update.status === 'UPDATED', 'purpose/category update should succeed: ' + JSON.stringify(update));
    pfisTestAssert(update.transactionId === email.transactionId, 'update must retain original transaction ID');
    pfisTestAssert(update.transaction.userNotes === 'Weekly household groceries', 'user purpose should be saved');
    pfisTestAssert(update.transaction.category === 'Food & dining', 'user category should be saved');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1, 'update must not add another transaction row');

    const sms = pfisTestRouteRequest({ sourceType: 'SMS', txnString: txnString,
      originalText: 'INR 340 debited A/c no. XX0156 10-10-26 01:30:00 UPI HOME GROCERY TEST Axis Bank',
      requestId: 'T-EMAIL-UPDATE-SMS' }, 'POST');
    pfisTestAssert(sms.status === 'RECONCILED' && sms.transactionId === email.transactionId,
      'later SMS must reconcile to the email-created transaction: ' + JSON.stringify(sms));
    pfisTestAssert(sms.verificationStatus === 'VERIFIED', 'email + SMS should verify transaction');
    pfisTestAssert(sms.transaction.userNotes === 'Weekly household groceries', 'reconciliation must not overwrite user purpose');
    pfisTestAssert(sms.transaction.category === 'Food & dining', 'reconciliation must not overwrite user category');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1, 'reconciliation must not create a second transaction row');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.sources) === beforeSources + 2, 'email and SMS must both be retained as source rows');
    return { transactionId: email.transactionId, updateStatus: update.status, verificationStatus: sms.verificationStatus,
      transactionRowsAdded: 1, sourceRowsAdded: 2, purpose: sms.transaction.userNotes, category: sms.transaction.category };
  });

  run('29 exact EMAIL replay is idempotent', function () {
    const txnString = '2026-10-10T00:45:00+05:30|-39.00|Axis Bank|NA|UPI|expense|EMAIL REPLAY SHOP|EMAIL REPLAY SHOP|REF-EMAIL-REPLAY|NA';
    const body = 'Axis Bank debit email INR 39; EMAIL REPLAY SHOP; reference REF-EMAIL-REPLAY; time 00:45';
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
    const beforeSources = pfisTestCount(PFIS_SHEETS.sources);
    const first = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: txnString, originalText: body,
      sender: 'alerts@axis.bank.in', subject: 'Debit alert', requestId: 'T-EMAIL-REPLAY-1' }, 'POST');
    const replay = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: txnString, originalText: body,
      sender: 'alerts@axis.bank.in', subject: 'Debit alert', requestId: 'T-EMAIL-REPLAY-2' }, 'POST');
    pfisTestAssert(first.status === 'ACCEPTED', 'first email should insert');
    pfisTestAssert(replay.status === 'IDEMPOTENT_REPLAY', 'exact same email should be idempotent replay');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1, 'email replay must not create another transaction');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.sources) === beforeSources + 1, 'email replay must not create another source');
    return { transactionId: first.transactionId, replayStatus: replay.status, transactionRowsAdded: 1, sourceRowsAdded: 1 };
  });

  run('30 doPost JSON request path physically inserts into the test Google Sheet', function () {
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
    const beforeSources = pfisTestCount(PFIS_SHEETS.sources);
    const request = {
      action: 'ingest',
      sourceType: 'SMS',
      txnString: '2026-10-10T00:15:00+05:30|-58.00|Axis Bank|NA|UPI|expense|POST JSON PATH SHOP|POST JSON PATH SHOP|REF-POST-JSON-1|NA',
      originalText: 'Axis Bank SMS INR 58 debited at 00:15; POST JSON PATH SHOP; A/c no. XX8888',
      requestId: 'T-POST-JSON-SMS'
    };
    const output = doPost({ postData: { contents: JSON.stringify(request) } });
    const result = JSON.parse(output.getContent());
    pfisTestAssert(result.success && result.status === 'ACCEPTED', 'doPost JSON request should be accepted: ' + JSON.stringify(result));
    pfisTestAssert(result.transactionId, 'doPost response should return a transaction ID');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1, 'doPost must write a real Transaction Log row');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.sources) === beforeSources + 1, 'doPost must write a real Source Log row');
    return { transactionId: result.transactionId, status: result.status, transactionRowsAdded: 1, sourceRowsAdded: 1,
      testedEntryPoint: 'doPost JSON' };
  });

  run('31 parse-failed source retries automatically once txnString is corrected', function () {
    const body = 'Source:SMS\nBody:Axis Bank INR 123.00 debited from test merchant';
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
    const failed = pfisTestRouteRequest({ sourceType: 'SMS', originalText: body, requestId: 'T-RETRY-FAILED-1' }, 'POST');
    pfisTestAssert(failed.status === 'PARSE_FAILED' && failed.sourceId, 'missing txnString should retain source as PARSE_FAILED');
    const corrected = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-11T20:00:00+05:30|-123.00|Axis Bank|Savings Account|UPI|expense|RETRY RECOVERY SHOP|RETRY RECOVERY SHOP|RETRY-RECOVERY-1|NA',
      originalText: body, requestId: 'T-RETRY-FAILED-2' }, 'POST');
    pfisTestAssert(corrected.success && corrected.transactionId, 'corrected same-source retry must create/resolve a transaction');
    pfisTestAssert(corrected.status === 'ACCEPTED', 'corrected retry should be accepted');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1, 'corrected retry must create exactly one transaction');
    pfisTestAssert(pfisTestFindSource(failed.sourceId).parseStatus === 'SUPERSEDED', 'old failed source must remain as SUPERSEDED audit evidence');
    return { previousSourceId: failed.sourceId, newTransactionId: corrected.transactionId, previousStatus: 'SUPERSEDED' };
  });

  run('32 empty category/purpose updates are rejected without partial writes', function () {
    const created = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-11T20:10:00+05:30|-44.00|Axis Bank|Savings Account|UPI|expense|EMPTY UPDATE TEST|EMPTY UPDATE TEST|EMPTY-UPDATE-1|NA',
      originalText: 'Axis SMS INR 44 EMPTY UPDATE TEST account XX5555', requestId: 'T-EMPTY-UPDATE-CREATE' }, 'POST');
    const emptyCategory = pfisTestRouteRequest({ action: 'update', transactionId: created.transactionId,
      category: '', purpose: 'Must not partially save', requestId: 'T-EMPTY-CATEGORY' }, 'POST');
    pfisTestAssert(!emptyCategory.success && emptyCategory.error === 'EMPTY_CATEGORY', 'explicit empty category must reject the whole patch');
    pfisTestAssert(pfisGetTransaction(created.transactionId, false).userNotes === '', 'purpose must not partially save on invalid category');
    const emptyPurpose = pfisTestRouteRequest({ action: 'update', transactionId: created.transactionId,
      category: 'Food & dining', purpose: '', requestId: 'T-EMPTY-PURPOSE' }, 'POST');
    pfisTestAssert(!emptyPurpose.success && emptyPurpose.error === 'EMPTY_PURPOSE', 'explicit empty purpose must reject the whole patch');
    pfisTestAssert(pfisGetTransaction(created.transactionId, false).category === '', 'category must not partially save on invalid purpose');
    const updated = pfisTestRouteRequest({ action: 'update', transactionId: created.transactionId,
      category: 'Food & dining', purpose: 'Test purpose', requestId: 'T-VALID-UPDATE' }, 'POST');
    pfisTestAssert(updated.success && updated.status === 'UPDATED', 'valid non-empty patch should update');
    return { transactionId: created.transactionId, emptyCategoryError: emptyCategory.error,
      emptyPurposeError: emptyPurpose.error, finalChangedFields: updated.changedFields };
  });

  run('33 known source instrument wins over a Config default', function () {
    const configSheet = pfisGetRequiredSheet(PFIS_SHEETS.config);
    configSheet.appendRow(['Axis Bank', 'Savings Account', '0156', '', 'AXIS_SAVINGS', 'Axis Test Card', 'Net Banking', false, 1]);
    const temporaryConfigRow = configSheet.getLastRow();
    try {
      const result = pfisTestRouteRequest({ sourceType: 'SMS',
        txnString: '2026-10-11T20:20:00+05:30|-52.00|Axis Bank|Savings Account|UPI|expense|INSTRUMENT PRECEDENCE SHOP|INSTRUMENT PRECEDENCE SHOP|INSTR-PREC-1|NA',
        originalText: 'Axis Bank INR 52 debited A/c no. XX0156 at 20:20 INSTRUMENT PRECEDENCE SHOP', requestId: 'T-INSTRUMENT-PRECEDENCE' }, 'POST');
      pfisTestAssert(result.transaction.instrument === 'UPI', 'parsed instrument must not be overwritten by Config');
      return { transactionId: result.transactionId, instrument: result.transaction.instrument };
    } finally {
      // Rules/Config/Categories persist across test runs; remove this test-only
      // Config row so repeated runs cannot accumulate duplicate test mappings.
      configSheet.getRange(temporaryConfigRow, 1, 1, PFIS_CONFIG_FIELDS.length).clearContent();
    }
  });

  run('34 response exposes one source of truth for enrichment flags and active categories', function () {
    const result = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-11T20:30:00+05:30|-75.00|Axis Bank|Savings Account|UPI|expense|COMPACT RESPONSE SHOP|COMPACT RESPONSE SHOP|COMPACT-RESP-1|NA',
      originalText: 'Axis Bank INR 75 debited COMPACT RESPONSE SHOP at 20:30', requestId: 'T-COMPACT-RESPONSE' }, 'POST');
    pfisTestAssert(result.needsEnrichment === true && result.requiresPurpose === true && result.requiresCategoryClassification === true,
      'missing purpose/category should produce explicit top-level enrichment flags');
    pfisTestAssert(result.needsReview === true, 'review-needed state should be exposed top-level for Shortcut branching');
    pfisTestAssert(!Object.prototype.hasOwnProperty.call(result, 'changedFields'), 'insert response should omit empty changedFields noise');
    pfisTestAssert(Array.isArray(result.allowedCategories) && result.allowedCategories.indexOf('Food & dining') >= 0,
      'active spreadsheet categories should be supplied when classification is required');
    pfisTestAssert(!Object.prototype.hasOwnProperty.call(result.transaction, 'needsEnrichment'),
      'derived enrichment flags must not be duplicated inside transaction');
    pfisTestAssert(!Object.prototype.hasOwnProperty.call(result.transaction, 'sheetRow'),
      'physical row number must not be part of normal ingestion payload');
    return { transactionId: result.transactionId, categoryCount: result.allowedCategories.length, needsEnrichment: result.needsEnrichment };
  });

  run('35 duplicate candidate always gets its own Transaction Log row', function () {
    const before = pfisTestCount(PFIS_SHEETS.transactions);
    const first = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-11T20:40:00+05:30|-88.00|Axis Bank|Savings Account|UPI|expense|DUPLICATE ALWAYS TEST|DUPLICATE ALWAYS TEST|DUP-ALWAYS-1|NA',
      originalText: 'Distinct SMS alert A, INR 88, DUPLICATE ALWAYS TEST, 20:40', requestId: 'T-DUP-ALWAYS-1' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-11T20:42:00+05:30|-88.00|Axis Bank|Savings Account|UPI|expense|DUPLICATE ALWAYS TEST|DUPLICATE ALWAYS TEST|DUP-ALWAYS-2|NA',
      originalText: 'Distinct SMS alert B, INR 88, DUPLICATE ALWAYS TEST, 20:42', requestId: 'T-DUP-ALWAYS-2' }, 'POST');
    pfisTestAssert(second.status === 'DUPLICATE_CANDIDATE', 'near duplicate should be flagged, not blocked');
    pfisTestAssert(first.transactionId !== second.transactionId, 'new candidate must have a new transaction ID');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === before + 2, 'both transactions must be physically present');
    return { firstTransactionId: first.transactionId, secondTransactionId: second.transactionId, status: second.status };
  });

  run('36 recurring merchant rule supplies category and purpose, so no enrichment prompt is needed', function () {
    const ruleSheet = pfisGetRequiredSheet(PFIS_SHEETS.rules);
    const rowNumber = ruleSheet.getLastRow() + 1;
    const row = [
      'Y', 'MERCHANT', '', 'PFIS AUTO SIP TEST', 'Investment & savings', '',
      'Monthly SIP - PFIS Auto Test', 0, 'Y', 'investment', 'ICICI_CC_PRIMARY',
      'ICICI Credit Card', 1,
      'QA-RULE-AUTO-001', 'Suggestion Rule', '', 'FALSE', 0.98, 'Temporary integration test rule'
    ];
    ruleSheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
    try {
      const result = pfisTestRouteRequest({ sourceType: 'SMS',
        txnString: '2026-10-11T20:40:00+05:30|-151.00|ICICI|Credit Card|Credit Card|investment|PFIS AUTO SIP TEST|PFIS AUTO SIP TEST|QA-SIP-AUTO-001|NA',
        originalText: 'ICICI card SMS INR 151.00 for PFIS AUTO SIP TEST on 11-Oct-2026 XX7000', requestId: 'T-AUTO-SIP-RULE' }, 'POST');
      pfisTestAssert(result.success && result.status === 'ACCEPTED', 'rule-based transaction should insert');
      pfisTestAssert(result.transaction.category === 'Investment & savings', 'active rule category should be applied');
      pfisTestAssert(result.transaction.userNotes === 'Monthly SIP - PFIS Auto Test', 'rule notes template should prefill purpose');
      pfisTestAssert(result.transaction.isRecurring === true, 'recurring flag should come from rule');
      pfisTestAssert(result.needsEnrichment === false && result.transaction.needsReview === false,
        'known complete recurring rule should avoid prompting and review backlog');
      pfisTestAssert(pfisGetTransaction(result.transactionId, false).categoryConfidence === 0.98, 'explicit rule confidence should be stored');
      return { transactionId: result.transactionId, category: result.transaction.category,
        purpose: result.transaction.userNotes, isRecurring: result.transaction.isRecurring,
        needsEnrichment: result.needsEnrichment };
    } finally {
      ruleSheet.getRange(rowNumber, 1, 1, row.length).clearContent();
    }
  });

  run('37 exact-merchant history returns purpose only as an editable suggestion', function () {
    const first = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-11T21:00:00+05:30|-60.00|Axis Bank|Savings Account|UPI|expense|PFIS PURPOSE HISTORY SHOP|PFIS PURPOSE HISTORY SHOP|QA-PURPOSE-HISTORY-1|NA',
      originalText: 'Axis SMS INR 60 PFIS PURPOSE HISTORY SHOP at 21:00 XX2345', requestId: 'T-PURPOSE-HISTORY-1' }, 'POST');
    const updated = pfisTestRouteRequest({ action: 'update', transactionId: first.transactionId,
      category: 'Food & dining', purpose: 'Weekly tea and snacks', actor: 'user', requestId: 'T-PURPOSE-HISTORY-UPDATE' }, 'POST');
    pfisTestAssert(updated.success && updated.status === 'UPDATED', 'historical purpose seed update should succeed');
    const second = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-11T21:10:00+05:30|-61.00|Axis Bank|Savings Account|UPI|expense|PFIS PURPOSE HISTORY SHOP|PFIS PURPOSE HISTORY SHOP|QA-PURPOSE-HISTORY-2|NA',
      originalText: 'Axis SMS INR 61 PFIS PURPOSE HISTORY SHOP at 21:10 XX2345, different alert', requestId: 'T-PURPOSE-HISTORY-2' }, 'POST');
    pfisTestAssert(second.transactionId !== first.transactionId, 'new event should receive separate transaction ID');
    pfisTestAssert(second.purposeSuggestion === 'Weekly tea and snacks', 'exact merchant/type history should be returned as a suggestion');
    pfisTestAssert(second.transaction.userNotes === '', 'suggestion must not be automatically saved');
    return { previousTransactionId: first.transactionId, newTransactionId: second.transactionId,
      purposeSuggestion: second.purposeSuggestion };
  });

  run('38 Auto Review metadata cannot suppress required purpose/category enrichment', function () {
    const ruleSheet = pfisGetRequiredSheet(PFIS_SHEETS.rules);
    const rowNumber = ruleSheet.getLastRow() + 1;
    const row = ['Y', 'MERCHANT', '', 'PFIS AUTO REVIEW TEST', 'Bills & subscription', '', '', 0, 'N', '', '', '', 1,
      'QA-RULE-AUTO-REVIEW-001', 'Suggestion Rule', '', 'TRUE', 0.90, 'Purpose remains unknown'];
    ruleSheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
    try {
      const result = pfisTestRouteRequest({ sourceType: 'SMS',
        txnString: '2026-10-11T21:30:00+05:30|-19.00|Axis Bank|Savings Account|UPI|expense|PFIS AUTO REVIEW TEST|PFIS AUTO REVIEW TEST|QA-AUTO-REVIEW-001|NA',
        originalText: 'Axis SMS INR 19 PFIS AUTO REVIEW TEST at 21:30 XX2345', requestId: 'T-AUTO-REVIEW-METADATA' }, 'POST');
      pfisTestAssert(result.transaction.ruleApplied === 'QA-RULE-AUTO-REVIEW-001', 'stable Rule ID should be recorded');
      pfisTestAssert(pfisGetTransaction(result.transactionId, false).categoryConfidence === 0.90, 'explicit configured confidence should be retained');
      pfisTestAssert(result.needsEnrichment === true && result.transaction.needsReview === true,
        'Auto Review must not bypass missing-purpose enrichment');
      return { transactionId: result.transactionId, ruleApplied: result.transaction.ruleApplied,
        needsEnrichment: result.needsEnrichment };
    } finally {
      ruleSheet.getRange(rowNumber, 1, 1, row.length).clearContent();
    }
  });



  run('39 amount-only Rules are not auto-applied; transaction is still inserted for enrichment', function () {
    const ruleSheet = pfisGetRequiredSheet(PFIS_SHEETS.rules);
    const rowNumber = ruleSheet.getLastRow() + 1;
    const rule = ['Y', 'AMOUNT', 123.00, '', 'Investment & savings', '',
      'Monthly SIP - UNKNOWN RECIPIENT', 0, 'Y', 'investment', '', '', 1,
      'QA-AMOUNT-ONLY-001', 'Suggestion Rule', '', 'FALSE', 0.99, 'Must not auto-apply without merchant evidence'];
    ruleSheet.getRange(rowNumber, 1, 1, rule.length).setValues([rule]);
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
    const beforeSource = pfisTestCount(PFIS_SHEETS.sources);
    try {
      const result = pfisTestRouteRequest({ sourceType: 'SMS',
        txnString: '2026-10-11T22:00:00+05:30|-123.00|Axis Bank|Savings Account|UPI|expense|UNRELATED MERCHANT 123|UNRELATED MERCHANT 123|QA-AMOUNT-ONLY-1|NA',
        originalText: 'Axis Bank SMS INR 123 debited at 22:00 for UNRELATED MERCHANT 123', requestId: 'T-AMOUNT-ONLY-SAFETY' }, 'POST');
      pfisTestAssert(result.success && result.transactionId, 'transaction must still be inserted despite skipped amount-only rule');
      pfisTestAssert(result.transaction.category === '', 'unsafe amount-only rule must not assign category');
      pfisTestAssert(result.transaction.userNotes === '', 'unsafe amount-only rule must not assign purpose');
      pfisTestAssert(result.needsEnrichment && result.requiresPurpose && result.requiresCategoryClassification,
        'Shortcut must be told to collect purpose and classify category');
      pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1, 'one new transaction row must be preserved');
      pfisTestAssert(pfisTestCount(PFIS_SHEETS.sources) === beforeSource + 1, 'source evidence must be preserved');
      return { transactionId: result.transactionId, status: result.status, needsEnrichment: result.needsEnrichment };
    } finally {
      ruleSheet.getRange(rowNumber, 1, 1, rule.length).clearContent();
    }
  });

  run('40 merchant-grounded Rules Notes metadata can supply a purpose when Notes Template is blank', function () {
    const ruleSheet = pfisGetRequiredSheet(PFIS_SHEETS.rules);
    const rowNumber = ruleSheet.getLastRow() + 1;
    const rule = ['Y', 'MERCHANT', '', 'PFIS NOTES METADATA TEST', 'Food & dining', '',
      '', 0, 'N', 'expense', '', '', 1,
      'QA-NOTES-METADATA-001', 'Merchant Rule', '', 'FALSE', 0.95, 'Lunch at the office cafe'];
    ruleSheet.getRange(rowNumber, 1, 1, rule.length).setValues([rule]);
    try {
      const result = pfisTestRouteRequest({ sourceType: 'SMS',
        txnString: '2026-10-11T22:05:00+05:30|-86.00|Axis Bank|Savings Account|UPI|expense|PFIS NOTES METADATA TEST|PFIS NOTES METADATA TEST|QA-NOTES-METADATA-1|NA',
        originalText: 'Axis Bank SMS INR 86 debited at 22:05 for PFIS NOTES METADATA TEST', requestId: 'T-NOTES-METADATA' }, 'POST');
      pfisTestAssert(result.transaction.category === 'Food & dining', 'active rule category should be applied');
      pfisTestAssert(result.transaction.userNotes === 'Lunch at the office cafe', 'meaningful Notes metadata should prefill purpose');
      pfisTestAssert(result.needsEnrichment === false, 'complete merchant-grounded rule should suppress unnecessary prompt');
      return { transactionId: result.transactionId, purpose: result.transaction.userNotes, needsEnrichment: result.needsEnrichment };
    } finally {
      ruleSheet.getRange(rowNumber, 1, 1, rule.length).clearContent();
    }
  });

  run('41 purpose equal to merchant is incomplete and is rejected on update', function () {
    const created = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-11T22:10:00+05:30|-100.00|Axis Bank|Savings Account|UPI|expense|PFIS PURPOSE EQUAL MERCHANT|PFIS PURPOSE EQUAL MERCHANT|QA-PURPOSE-MERCHANT-1|NA',
      originalText: 'Axis Bank SMS INR 100 debited at 22:10 for PFIS PURPOSE EQUAL MERCHANT', requestId: 'T-PURPOSE-MERCHANT-CREATE' }, 'POST');
    const rejected = pfisTestRouteRequest({ action: 'update', transactionId: created.transactionId,
      category: 'Shopping', purpose: 'PFIS PURPOSE EQUAL MERCHANT', requestId: 'T-PURPOSE-MERCHANT-REJECT' }, 'POST');
    pfisTestAssert(!rejected.success && rejected.error === 'UNINFORMATIVE_PURPOSE', 'merchant repeated as purpose must be rejected');
    pfisTestAssert(pfisGetTransaction(created.transactionId, false).category === '', 'rejected patch must not partially update category');
    const updated = pfisTestRouteRequest({ action: 'update', transactionId: created.transactionId,
      category: 'Shopping', purpose: 'Household storage purchase', requestId: 'T-PURPOSE-MERCHANT-FIX' }, 'POST');
    pfisTestAssert(updated.success && updated.status === 'UPDATED', 'meaningful purpose/category update should succeed');
    pfisTestAssert(updated.needsEnrichment === false && updated.needsReview === false, 'completed transaction should clear only enrichment review');
    return { transactionId: created.transactionId, rejectedError: rejected.error, finalStatus: updated.status };
  });

  run('42 equally ranked conflicting Config mappings are flagged rather than guessed', function () {
    const configSheet = pfisGetRequiredSheet(PFIS_SHEETS.config);
    const startRow = configSheet.getLastRow() + 1;
    const rows = [
      ['PFIS Tie Bank', 'Savings Account', '', '', 'PFIS_ACCOUNT_A', 'PFIS Card A', 'UPI', 'N', 5],
      ['PFIS Tie Bank', 'Savings Account', '', '', 'PFIS_ACCOUNT_B', 'PFIS Card B', 'UPI', 'N', 5]
    ];
    configSheet.getRange(startRow, 1, rows.length, PFIS_CONFIG_FIELDS.length).setValues(rows);
    try {
      const result = pfisTestRouteRequest({ sourceType: 'SMS',
        txnString: '2026-10-11T22:15:00+05:30|-56.00|PFIS Tie Bank|Savings Account|UPI|expense|PFIS CONFIG TIE TEST|PFIS CONFIG TIE TEST|QA-CONFIG-TIE-1|NA',
        originalText: 'PFIS Tie Bank SMS INR 56 debited at 22:15 for PFIS CONFIG TIE TEST', requestId: 'T-CONFIG-TIE' }, 'POST');
      pfisTestAssert(result.success && result.transactionId, 'ambiguous mapping must not block transaction insertion');
      pfisTestAssert(result.transaction.account === '' && result.transaction.cardName === '', 'conflicting mappings must not choose an account/card arbitrarily');
      pfisTestAssert(result.transaction.needsReview === true && result.transaction.reviewReason === 'config_mapping_ambiguous', 'ambiguous mapping should require review');
      pfisTestAssert(result.status === 'ACCEPTED', 'transaction should be recorded, not rejected');
      return { transactionId: result.transactionId, reviewReason: result.transaction.reviewReason, recorded: true };
    } finally {
      configSheet.getRange(startRow, 1, rows.length, PFIS_CONFIG_FIELDS.length).clearContent();
    }
  });

  run('43 mobile display text is plain text with actionable status and no Markdown syntax', function () {
    const text = pfisBuildDisplayText({
      success: true, status: 'ACCEPTED', transactionId: '202610-TEST',
      needsReview: true, needsEnrichment: true, requiresPurpose: true,
      requiresCategoryClassification: true,
      transaction: { transactionId: '202610-TEST', amount: -25, merchant: 'PFIS DISPLAY TEST',
        category: '', userNotes: '', dateTime: new Date('2026-10-11T16:00:00Z'),
        datePrecision: 'DATETIME', reviewReason: 'enrichment_required', needsReview: true },
      verificationStatus: 'SMS_ONLY', sourceTypes: ['SMS'], sourceCount: 1
    });
    pfisTestAssert(text.indexOf('✅ TRANSACTION SAVED — DETAILS NEEDED') >= 0, 'missing enrichment should be visible in title');
    pfisTestAssert(text.indexOf('Complete missing purpose and category.') >= 0, 'receipt should show precise next step');
    pfisTestAssert(text.indexOf('**') < 0 && text.indexOf('##') < 0, 'display must be plain text, not raw Markdown');
    return { title: text.split('\n')[0], characters: text.length };
  });



  run('44 HTTP JSON response adds readable displayText without changing functional payload', function () {
    const output = pfisJsonOutput({
      success: true, status: 'UPDATED', transactionId: '202610-TEST', needsReview: false,
      transaction: {
        transactionId: '202610-TEST', amount: -18.50, merchant: 'PFIS FORMAT TEST',
        dateTime: new Date('2026-10-11T16:00:00Z'), category: 'Food & dining',
        userNotes: 'Office tea', type: 'expense', instrument: 'UPI', account: 'AXIS_SAVINGS',
        needsReview: false, reviewStatus: 'Approved', validationFlag: 'VALID', datePrecision: 'DATETIME'
      }, verificationStatus: 'SMS_ONLY', sourceTypes: ['SMS'], sourceCount: 1, changedFields: ['category', 'userNotes']
    });
    const body = JSON.parse(output.getContent());
    pfisTestAssert(body.displayText && body.displayText.indexOf('📝 TRANSACTION UPDATED') >= 0,
      'actual HTTP JSON output should include the plain-text receipt');
    pfisTestAssert(body.status === 'UPDATED' && body.transactionId === '202610-TEST',
      'display formatting must preserve API status and transaction identity');
    pfisTestAssert(body.displayText.indexOf('**') < 0 && body.displayText.indexOf('##') < 0,
      'displayText must not include Markdown syntax');
    return { status: body.status, hasDisplayText: true, length: body.displayText.length };
  });

  run('45 public POST requires a JSON body and explicit action', function () {
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
    const beforeSources = pfisTestCount(PFIS_SHEETS.sources);

    const emptyBodyOutput = doPost({ postData: { contents: '' } });
    const emptyBody = JSON.parse(emptyBodyOutput.getContent());
    pfisTestAssert(emptyBody.success === false && emptyBody.error === 'EMPTY_BODY',
      'empty POST body must be rejected clearly');

    const noActionOutput = doPost({ postData: { contents: JSON.stringify({
      sourceType: 'SMS',
      txnString: '2026-10-11T22:30:00+05:30|-9.00|Axis Bank|Savings Account|UPI|expense|MISSING ACTION TEST|MISSING ACTION TEST|QA-NO-ACTION|NA',
      originalText: 'Test source should not be inserted without explicit action.'
    }) } });
    const noAction = JSON.parse(noActionOutput.getContent());
    pfisTestAssert(noAction.success === false && noAction.error === 'MISSING_ACTION',
      'POST without action must be rejected rather than defaulting to ingestion');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx,
      'rejected body must not insert a transaction');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.sources) === beforeSources,
      'rejected body must not append source evidence');

    return { emptyBodyError: emptyBody.error, missingActionError: noAction.error,
      transactionRowsAdded: 0, sourceRowsAdded: 0 };
  });

  const passed = results.filter(function (result) { return result.status === 'PASS'; }).length;
  const failed = results.length - passed;
  const suiteEnded = new Date();
  const report = { success: failed === 0, total: results.length, passed: passed, failed: failed,
    startedAt: suiteStarted.toISOString(), endedAt: suiteEnded.toISOString(),
    totalMilliseconds: suiteEnded.getTime() - suiteStarted.getTime(),
    testSpreadsheetUrl: testSpreadsheet.getUrl(), productionSpreadsheetWasModified: false, results: results };
  Logger.log(JSON.stringify(report, null, 2));
  PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID = '';
  PFIS_RUNTIME_SPREADSHEET_CACHE = null;
  PFIS_RUNTIME_SPREADSHEET_CACHE_ID = '';
  pfisInvalidateSourceCache();
  pfisInvalidateTransactionCache();
  PFIS_RUNTIME_CATEGORY_CACHE = null;
  if (failed) throw new Error('PFIS tests failed: ' + failed + '. See the execution log for details.');
  return report;
}

function PFIS_TEST_CLEANUP() {
  const properties = PropertiesService.getScriptProperties();
  const testId = String(properties.getProperty('PFIS_TEST_SPREADSHEET_ID') || '').trim();
  const liveId = String(properties.getProperty('SPREADSHEET_ID') || '').trim();
  if (!testId) return { success: true, message: 'No test workbook is configured.' };
  if (testId === liveId) throw new Error('Safety stop: refusing to clean the production spreadsheet.');
  const spreadsheet = SpreadsheetApp.openById(testId);
  if (spreadsheet.getName().indexOf('PFIS TEST - ') !== 0) throw new Error('Safety stop: workbook is not titled PFIS TEST - ...');
  pfisTestResetData(spreadsheet);
  Logger.log('Cleared only test Transaction Log, Source Log and Change Log data: ' + spreadsheet.getUrl());
  return { success: true, url: spreadsheet.getUrl() };
}

function pfisTestCreateSheet(spreadsheet, name, headers) {
  const sheet = spreadsheet.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
  return sheet;
}

function pfisTestResetData(spreadsheet) {
  [PFIS_SHEETS.transactions, PFIS_SHEETS.sources, PFIS_SHEETS.changes].forEach(function (name) {
    const sheet = spreadsheet.getSheetByName(name);
    if (sheet && sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(sheet.getLastColumn(), 1)).clearContent();
    }
  });
  pfisInvalidateSourceCache();
}

function pfisTestCount(sheetName) {
  return Math.max(0, pfisGetRequiredSheet(sheetName).getLastRow() - 1);
}

function pfisTestFindSource(sourceId) {
  if (!sourceId) return null;
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
  const rows = pfisReadFixedRows(sheet, PFIS_SOURCE_FIELDS.length);
  for (let i = 0; i < rows.length; i++) {
    const source = pfisObjectFromRow(rows[i], PFIS_SOURCE_FIELDS);
    if (source.sourceId === sourceId) { source.rowNumber = i + 2; return source; }
  }
  return null;
}

function pfisTestFindSourceByTxnAndType(transactionId, sourceType) {
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
  const rows = pfisReadFixedRows(sheet, PFIS_SOURCE_FIELDS.length);
  for (let i = 0; i < rows.length; i++) {
    const source = pfisObjectFromRow(rows[i], PFIS_SOURCE_FIELDS);
    if (source.linkedTxnId === transactionId && source.sourceType === sourceType) {
      source.rowNumber = i + 2;
      return source;
    }
  }
  return null;
}

function pfisTestRouteRequest(params, method) {
  const input = Object.assign({}, params || {});
  // Respect the production authorization configuration without logging the secret.
  const secret = String(PropertiesService.getScriptProperties().getProperty('WEB_APP_SECRET') || '').trim();
  if (secret) input.token = secret;
  return pfisRouteRequest(input, method);
}

function pfisTestAssert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}


/**
 * OPTIONAL PRODUCTION-WRITE SMOKE TEST.
 *
 * Creates four clearly marked test transactions in the configured SPREADSHEET_ID:
 * 1) SMS-first insert, then category/purpose update to the same Transaction ID;
 * 2) EMAIL-first insert followed by SMS reconciliation to that same ID;
 * 3) two distinct same-channel SMS alerts, both retained, second flagged duplicate.
 *
 * This writes real rows to the configured workbook and does not delete them.
 * It is intentionally separate from PFIS_TEST_RUN_ALL(), which uses an isolated
 * PFIS TEST workbook. Before running, set Script Property
 * PFIS_ENABLE_LIVE_TEST_WRITES=YES and verify SPREADSHEET_ID is the intended sheet.
 * To clean up later, filter Transaction Log Merchant for "PFIS V1 LIVE TEST";
 * remove corresponding Source Log rows by Source ID/Linked Txn ID and Change Log
 * rows for those transaction IDs only after inspecting them. Do not bulk-clear logs.
 */
function PFIS_LIVE_SMOKE_TEST_PRODUCTION() {
  const properties = PropertiesService.getScriptProperties();
  const enabled = String(properties.getProperty('PFIS_ENABLE_LIVE_TEST_WRITES') || '').trim().toUpperCase();
  if (enabled !== 'YES') {
    throw new Error('Safety stop: set Script Property PFIS_ENABLE_LIVE_TEST_WRITES=YES only after you accept test rows will be written to the configured spreadsheet.');
  }

  const spreadsheetId = String(properties.getProperty('SPREADSHEET_ID') || '').trim();
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required.');
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  if (spreadsheet.getName().indexOf('PFIS TEST - ') === 0) {
    throw new Error('SPREADSHEET_ID points to the dedicated test workbook. Use PFIS_TEST_RUN_ALL() for that workbook instead.');
  }

  // Live smoke tests must use the configured target, never the test override.
  PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID = '';
  PFIS_RUNTIME_SPREADSHEET_CACHE = null;
  PFIS_RUNTIME_SPREADSHEET_CACHE_ID = '';
  PFIS_RUNTIME_SOURCE_CACHE = null;
  PFIS_RUNTIME_TRANSACTION_CACHE = null;
  PFIS_RUNTIME_CATEGORY_CACHE = null;
  pfisAssertSchema();

  const runTag = Utilities.formatDate(new Date(), PFIS_TIME_ZONE, 'yyyyMMdd_HHmmss') + '_' +
    Utilities.getUuid().replace(/-/g, '').substring(0, 6);
  const base = new Date();
  const toLocalIso = function (date) {
    return Utilities.formatDate(date, PFIS_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss") + '+05:30';
  };
  const request = function (body) {
    const input = Object.assign({}, body);
    const secret = String(properties.getProperty('WEB_APP_SECRET') || '').trim();
    if (secret) input.token = secret;
    return pfisRouteRequest(input, 'POST');
  };
  const requireSuccess = function (condition, message, result) {
    if (!condition) throw new Error(message + ': ' + JSON.stringify(result));
  };
  const makeTxn = function (date, amount, merchant, reference) {
    return [toLocalIso(date), amount, 'PFIS Test Bank', 'Savings Account', 'UPI', 'expense',
      merchant, merchant, reference, ''].join('|');
  };
  const makeBody = function (tag, merchant, amount) {
    return 'PFIS V1 LIVE TEST ' + tag + '\nPFIS Test Bank\nAmount: ' + amount +
      '\nMerchant: ' + merchant + '\nRun: ' + runTag;
  };

  // 1) Real SMS insert, followed by a real update using transactionId.
  const merchantA = 'PFIS V1 LIVE TEST SMS A ' + runTag;
  const dateA = new Date(base.getTime() - 2 * 60 * 1000);
  const resultA = request({ action: 'ingest', sourceType: 'SMS',
    txnString: makeTxn(dateA, '-101.01', merchantA, 'PFIS-LIVE-A-' + runTag),
    originalText: makeBody('SMS-A', merchantA, 'INR 101.01'), requestId: 'LIVE-A-' + runTag });
  requireSuccess(resultA.success && resultA.transactionId &&
    ['ACCEPTED', 'DUPLICATE_CANDIDATE'].indexOf(resultA.status) >= 0,
    'Live SMS insert failed', resultA);

  const categories = pfisGetCategoryList();
  const chosenCategory = categories.indexOf('Miscellaneous') >= 0 ? 'Miscellaneous' : categories[0];
  if (!chosenCategory) throw new Error('No active category exists; live smoke test cannot validate the update contract.');
  const updatedA = request({ action: 'update', transactionId: resultA.transactionId,
    category: chosenCategory, purpose: 'PFIS live smoke validation ' + runTag,
    actor: 'test', reason: 'PFIS_LIVE_SMOKE_TEST', requestId: 'LIVE-A-UPDATE-' + runTag });
  requireSuccess(updatedA.success && updatedA.transactionId === resultA.transactionId &&
    ['UPDATED', 'NO_CHANGE'].indexOf(updatedA.status) >= 0,
    'Live update did not affect the same transaction', updatedA);

  // 2) EMAIL first, then SMS: one ledger row, two source records.
  const merchantB = 'PFIS V1 LIVE TEST EMAIL FIRST B ' + runTag;
  const dateB = new Date(base.getTime());
  const txnB = makeTxn(dateB, '-202.02', merchantB, 'PFIS-LIVE-B-' + runTag);
  const emailB = request({ action: 'ingest', sourceType: 'EMAIL', txnString: txnB,
    sender: 'PFIS-LIVE-TEST', subject: 'PFIS live smoke test ' + runTag,
    originalText: makeBody('EMAIL-B', merchantB, 'INR 202.02'), requestId: 'LIVE-B-EMAIL-' + runTag });
  requireSuccess(emailB.success && emailB.transactionId &&
    ['ACCEPTED', 'DUPLICATE_CANDIDATE'].indexOf(emailB.status) >= 0,
    'Live email-first insert failed', emailB);
  const smsB = request({ action: 'ingest', sourceType: 'SMS', txnString: txnB,
    originalText: makeBody('SMS-B-MATCH', merchantB, 'INR 202.02'), requestId: 'LIVE-B-SMS-' + runTag });
  requireSuccess(smsB.success && smsB.status === 'RECONCILED' &&
    smsB.transactionId === emailB.transactionId && smsB.sourceCount === 2,
    'Live email-first reconciliation failed', smsB);

  // 3) Distinct same-channel alerts: preserve both, flag the second as a candidate.
  const merchantC = 'PFIS V1 LIVE TEST DUPLICATE C ' + runTag;
  const dateC1 = new Date(base.getTime() + 60 * 1000);
  const dateC2 = new Date(base.getTime() + 3 * 60 * 1000);
  const smsC1 = request({ action: 'ingest', sourceType: 'SMS',
    txnString: makeTxn(dateC1, '-303.03', merchantC, 'PFIS-LIVE-C1-' + runTag),
    originalText: makeBody('SMS-C1', merchantC, 'INR 303.03'), requestId: 'LIVE-C1-' + runTag });
  requireSuccess(smsC1.success && smsC1.transactionId, 'Live duplicate candidate first insert failed', smsC1);
  const smsC2 = request({ action: 'ingest', sourceType: 'SMS',
    txnString: makeTxn(dateC2, '-303.03', merchantC, 'PFIS-LIVE-C2-' + runTag),
    originalText: makeBody('SMS-C2-DISTINCT', merchantC, 'INR 303.03'), requestId: 'LIVE-C2-' + runTag });
  requireSuccess(smsC2.success && smsC2.transactionId !== smsC1.transactionId &&
    smsC2.status === 'DUPLICATE_CANDIDATE', 'Distinct live SMS should be retained as a duplicate candidate', smsC2);

  const report = {
    success: true,
    mode: 'LIVE_PRODUCTION_SHEET_WRITES',
    runTag: runTag,
    spreadsheetUrl: spreadsheet.getUrl(),
    insertedTransactions: [resultA.transactionId, emailB.transactionId, smsC1.transactionId, smsC2.transactionId],
    updatedTransaction: resultA.transactionId,
    reconciledTransaction: emailB.transactionId,
    duplicateCandidate: smsC2.transactionId,
    sourceCountForReconciledEvent: smsB.sourceCount,
    cleanupHint: 'Filter Transaction Log Merchant for "PFIS V1 LIVE TEST" and inspect matching Source Log/Change Log rows before manual cleanup. No rows were deleted.'
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
