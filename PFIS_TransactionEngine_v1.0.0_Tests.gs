/**
 * PFIS Transaction Engine v1.0.0 — real Google Sheets integration test harness.
 *
 * These are real Google Apps Script + Google Sheets integration tests, not mocks.
 * All writes use a dedicated PFIS TEST workbook; production SPREADSHEET_ID is guarded.
 * This is the FAST CORE suite: only high-value checks are retained to avoid execution
 * timeouts. It covers schema/health, insert + cross-channel reconciliation + replay,
 * duplicate review, purpose/category updates, amount-only rule safety, parse-failure
 * evidence retention, JSON POST validation, and the analytics read endpoint.
 * Test setup/reset clears only Transaction Log, Source Log, and Change Log in the
 * dedicated test workbook. Rules, Config and Categories are left intact.
 *
 * Run manually in Apps Script: PFIS_TEST_RUN_ALL().
 * PFIS_TEST_SETUP() is available if you want to create/inspect the test workbook first.
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
    throw new Error('Safety stop: PFIS_TEST_SPREADSHEET_ID must point to a dedicated PFIS TEST workbook.');
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
    const started = new Date();
    Logger.log('PFIS CORE TEST START: ' + name);
    try {
      const detail = fn() || {};
      const ended = new Date();
      results.push({ name: name, status: 'PASS', milliseconds: ended.getTime() - started.getTime(), detail: detail });
      Logger.log('PFIS CORE TEST PASS: ' + name + ' (' + (ended.getTime() - started.getTime()) + ' ms)');
    } catch (error) {
      const ended = new Date();
      results.push({ name: name, status: 'FAIL', milliseconds: ended.getTime() - started.getTime(), error: error.message || String(error) });
      Logger.log('PFIS CORE TEST FAIL: ' + name + ' — ' + (error.message || String(error)));
    }
  }

  run('1. Health, schema and Shortcut decision logic', function () {
    const decisions = [
      [pfisRecommendNextAction('ACCEPTED', { needsReview: true, reviewReason: 'enrichment_required', merchant: 'ACME', category: '' },
        { requiresPurpose: true, requiresCategoryClassification: true }), 'ASK_PURPOSE'],
      [pfisRecommendNextAction('RECONCILED', { needsReview: true, reviewReason: 'enrichment_required', merchant: 'ACME' },
        { requiresPurpose: true, requiresCategoryClassification: true }), 'SHOW_RECEIPT'],
      [pfisRecommendNextAction('IDEMPOTENT_REPLAY', { needsReview: true, reviewReason: 'enrichment_required' },
        { requiresPurpose: true, requiresCategoryClassification: true }), 'SHOW_RECEIPT'],
      [pfisRecommendNextAction('DUPLICATE_CANDIDATE', { needsReview: true, reviewReason: 'duplicate_candidate' },
        { requiresPurpose: true, requiresCategoryClassification: true }), 'REVIEW'],
      [pfisIsMeaningfulPurpose('SRI VENKATA', 'SRI VENKATA'), false],
      [pfisIsMeaningfulPurpose('lunch with colleagues', 'SRI VENKATA'), true]
    ];
    const failures = decisions.filter(function (entry) { return entry[0] !== entry[1]; });
    pfisTestAssert(failures.length === 0, 'Decision logic failed: ' + JSON.stringify(failures));

    const health = pfisTestRouteRequest({ action: 'health', requestId: 'CORE-HEALTH' }, 'GET');
    pfisTestAssert(health.success && health.engineVersion === 'v1.0.0', 'Health endpoint/version failed.');
    const validation = pfisValidateWorkbook('CORE-TEST-VALIDATE');
    pfisTestAssert(validation.success, 'Test workbook schema validation failed: ' + JSON.stringify(validation.checks));
    return { decisionChecks: decisions.length, engineVersion: health.engineVersion, schemaStatus: validation.status };
  });

  run('2. Insert, SMS/email reconciliation, idempotent replay and analytics read', function () {
    const txn = '2026-10-10T16:14:08+05:30|-100.00|Axis Bank|NA|UPI|expense|GUDIVENUKALA VIJAYA|GUDIVENUKALA VIJAYA|435513308371|NA';
    const smsBody = 'INR 100.00 debited\nA/c no. XX0156\n10-10-26, 16:14:08\nUPI/P2A/435513308371/GUDIVENUKALA VIJAYA\nAxis Bank';
    const emailBody = 'Amount Debited: INR 100.00\nAccount Number: XX\nDate & Time: 10-10-26, 16:14:08 IST\nTransaction Info: UPI/P2A/435513308371/GUDIVENUKALA VIJAYA\nAxis Bank';
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
    const beforeSources = pfisTestCount(PFIS_SHEETS.sources);

    const first = pfisTestRouteRequest({ sourceType: 'SMS', txnString: txn, originalText: smsBody, requestId: 'CORE-SMS-FIRST' }, 'POST');
    pfisTestAssert(first.success && first.status === 'ACCEPTED' && first.transactionId, 'SMS first insert failed: ' + JSON.stringify(first));
    pfisTestAssert(first.verificationStatus === 'SMS_ONLY', 'Initial source should be SMS_ONLY.');
    pfisTestAssert(first.requiresPurpose === true && first.requiresCategoryClassification === true,
      'Unclassified transaction must request purpose and category.');

    const second = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: txn, originalText: emailBody,
      sender: 'alerts@axis.bank.in', subject: 'INR 100 debit', requestId: 'CORE-EMAIL-MATCH' }, 'POST');
    pfisTestAssert(second.success && second.status === 'RECONCILED', 'Opposite channel did not reconcile: ' + JSON.stringify(second));
    pfisTestAssert(second.transactionId === first.transactionId && second.verificationStatus === 'VERIFIED',
      'Reconciled evidence must keep one ID and become VERIFIED.');

    const replay = pfisTestRouteRequest({ sourceType: 'SMS', txnString: txn, originalText: smsBody, requestId: 'CORE-SMS-REPLAY' }, 'POST');
    pfisTestAssert(replay.status === 'IDEMPOTENT_REPLAY', 'Exact source replay should be idempotent.');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1, 'Reconcile/replay must not add ledger rows.');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.sources) === beforeSources + 2, 'Only SMS and EMAIL source evidence rows expected.');

    const overview = pfisTestRouteRequest({ action: 'getfinancialoverview', period: 'all_time', requestId: 'CORE-ANALYTICS' }, 'GET');
    pfisTestAssert(overview.success && overview.totals && overview.metricVersion === 'PFIS_METRICS_v1',
      'Analytics overview endpoint failed: ' + JSON.stringify(overview));
    return { transactionId: first.transactionId, verificationStatus: second.verificationStatus,
      replayStatus: replay.status, transactionRowsAdded: 1, sourceRowsAdded: 2, analyticsEndpoint: 'PASS' };
  });

  run('3. Same-channel duplicate candidate is preserved for review', function () {
    const before = pfisTestCount(PFIS_SHEETS.transactions);
    const first = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-10T12:00:00+05:30|-100.00|Axis Bank|Savings Account|UPI|expense|PFIS CORE DUP CAFE|PFIS CORE DUP CAFE|CORE-DUP-1|NA',
      originalText: 'SMS alert 1: INR 100 debited at 12:00 PFIS CORE DUP CAFE account XX0156', requestId: 'CORE-DUP-1' }, 'POST');
    const second = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-10T12:03:00+05:30|-100.00|Axis Bank|Savings Account|UPI|expense|PFIS CORE DUP CAFE|PFIS CORE DUP CAFE|CORE-DUP-2|NA',
      originalText: 'SMS alert 2: INR 100 debited at 12:03 PFIS CORE DUP CAFE account XX0156 sequence 2', requestId: 'CORE-DUP-2' }, 'POST');
    pfisTestAssert(first.transactionId && second.transactionId && first.transactionId !== second.transactionId,
      'Distinct alerts must be preserved as separate ledger rows.');
    pfisTestAssert(second.status === 'DUPLICATE_CANDIDATE', 'Second alert must be flagged DUPLICATE_CANDIDATE.');
    pfisTestAssert(second.transaction.validationFlag === 'DUPLICATE_CANDIDATE' && second.transaction.needsReview === true,
      'Duplicate candidate must be flagged and sent to review.');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === before + 2, 'Both candidate transactions must remain in ledger.');
    return { first: first.transactionId, second: second.transactionId, status: second.status };
  });

  run('4. Purpose/category update rejects merchant echo and saves valid enrichment', function () {
    const created = pfisTestRouteRequest({ sourceType: 'SMS',
      txnString: '2026-10-11T22:10:00+05:30|-100.00|Axis Bank|Savings Account|UPI|expense|PFIS CORE PURPOSE TEST|PFIS CORE PURPOSE TEST|CORE-PURPOSE-1|NA',
      originalText: 'Axis Bank SMS INR 100 debited at 22:10 for PFIS CORE PURPOSE TEST', requestId: 'CORE-PURPOSE-CREATE' }, 'POST');
    pfisTestAssert(created.success && created.needsEnrichment === true, 'New transaction should require enrichment.');

    const rejected = pfisTestRouteRequest({ action: 'update', transactionId: created.transactionId,
      category: 'Shopping', purpose: 'PFIS CORE PURPOSE TEST', requestId: 'CORE-PURPOSE-REJECT' }, 'POST');
    pfisTestAssert(!rejected.success && rejected.error === 'UNINFORMATIVE_PURPOSE',
      'Purpose identical to merchant should be rejected.');
    pfisTestAssert(pfisGetTransaction(created.transactionId, false).category === '',
      'Rejected patch must not partially apply the category.');

    const updated = pfisTestRouteRequest({ action: 'update', transactionId: created.transactionId,
      category: 'Shopping', purpose: 'Household storage purchase', actor: 'user', reason: 'shortcut_enrichment',
      requestId: 'CORE-PURPOSE-VALID' }, 'POST');
    pfisTestAssert(updated.success && updated.status === 'UPDATED', 'Valid enrichment update failed: ' + JSON.stringify(updated));
    pfisTestAssert(updated.transaction.category === 'Shopping' && updated.transaction.userNotes === 'Household storage purchase',
      'Valid category and purpose must be saved.');
    pfisTestAssert(updated.needsEnrichment === false && updated.needsReview === false,
      'Successfully enriched transaction should no longer need enrichment/review.');
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.changes) > 0, 'Updates must write Change Log audit records.');
    return { transactionId: created.transactionId, rejectedError: rejected.error, finalStatus: updated.status,
      finalNeedsEnrichment: updated.needsEnrichment };
  });

  run('5. Amount-only rule cannot auto-classify a transaction', function () {
    const ruleSheet = pfisGetRequiredSheet(PFIS_SHEETS.rules);
    const rowNumber = ruleSheet.getLastRow() + 1;
    const rule = ['Y', 'AMOUNT', 123.00, '', 'Investment & savings', '',
      'Monthly SIP - UNKNOWN RECIPIENT', 0, 'Y', 'investment', '', '', 1,
      'QA-CORE-AMOUNT-ONLY', 'Suggestion Rule', '', 'FALSE', 0.99, 'Must not auto-apply without merchant evidence'];
    ruleSheet.getRange(rowNumber, 1, 1, rule.length).setValues([rule]);
    try {
      const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
      const beforeSources = pfisTestCount(PFIS_SHEETS.sources);
      const result = pfisTestRouteRequest({ sourceType: 'SMS',
        txnString: '2026-10-11T22:00:00+05:30|-123.00|Axis Bank|Savings Account|UPI|expense|UNRELATED CORE MERCHANT|UNRELATED CORE MERCHANT|CORE-AMOUNT-ONLY-1|NA',
        originalText: 'Axis Bank SMS INR 123 debited at 22:00 for UNRELATED CORE MERCHANT', requestId: 'CORE-AMOUNT-ONLY' }, 'POST');
      pfisTestAssert(result.success && result.transactionId, 'Transaction must still be inserted.');
      pfisTestAssert(result.transaction.category === '' && result.transaction.userNotes === '',
        'Amount-only rule must not assign category or purpose.');
      pfisTestAssert(result.needsEnrichment && result.requiresPurpose && result.requiresCategoryClassification,
        'Response must direct Shortcut to collect missing purpose/category.');
      pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1 && pfisTestCount(PFIS_SHEETS.sources) === beforeSources + 1,
        'Skipped rule must not discard transaction/source evidence.');
      return { transactionId: result.transactionId, status: result.status, needsEnrichment: result.needsEnrichment };
    } finally {
      ruleSheet.getRange(rowNumber, 1, 1, rule.length).clearContent();
    }
  });

  run('6. Malformed parser output retains source evidence as PARSE_FAILED', function () {
    const body = 'PFIS core test: invalid parser output must retain this source body.';
    const result = pfisTestRouteRequest({ sourceType: 'EMAIL', txnString: 'too|few|fields',
      originalText: body, requestId: 'CORE-PARSE-FAIL' }, 'POST');
    pfisTestAssert(result.status === 'PARSE_FAILED' && result.sourceId, 'Malformed parser output must return PARSE_FAILED.');
    const source = pfisTestFindSource(result.sourceId);
    pfisTestAssert(source && source.rawBody === body, 'Original source evidence must be preserved.');
    return { status: result.status, sourceId: result.sourceId, rawEvidencePreserved: true };
  });

  run('7. Public JSON POST writes valid ingest and rejects missing action', function () {
    const beforeTx = pfisTestCount(PFIS_SHEETS.transactions);
    const beforeSources = pfisTestCount(PFIS_SHEETS.sources);
    const secret = String(properties.getProperty('WEB_APP_SECRET') || '').trim();
    const request = {
      action: 'ingest', sourceType: 'SMS',
      txnString: '2026-10-11T22:30:00+05:30|-58.00|Axis Bank|NA|UPI|expense|PFIS CORE JSON POST|PFIS CORE JSON POST|CORE-JSON-POST-1|NA',
      originalText: 'Axis Bank SMS INR 58 debited at 22:30 for PFIS CORE JSON POST', requestId: 'CORE-JSON-POST'
    };
    if (secret) request.token = secret;
    const output = doPost({ postData: { contents: JSON.stringify(request) } });
    const inserted = JSON.parse(output.getContent());
    pfisTestAssert(inserted.success && inserted.status === 'ACCEPTED' && inserted.transactionId,
      'Valid JSON POST should insert: ' + JSON.stringify(inserted));

    const invalid = { sourceType: 'SMS',
      txnString: '2026-10-11T22:31:00+05:30|-9.00|Axis Bank|Savings Account|UPI|expense|PFIS NO ACTION|PFIS NO ACTION|CORE-NO-ACTION|NA',
      originalText: 'Must not be inserted when action is missing.' };
    if (secret) invalid.token = secret;
    const rejectedOutput = doPost({ postData: { contents: JSON.stringify(invalid) } });
    const rejected = JSON.parse(rejectedOutput.getContent());
    pfisTestAssert(rejected.success === false && rejected.error === 'MISSING_ACTION',
      'POST without explicit action must be rejected: ' + JSON.stringify(rejected));
    pfisTestAssert(pfisTestCount(PFIS_SHEETS.transactions) === beforeTx + 1 && pfisTestCount(PFIS_SHEETS.sources) === beforeSources + 1,
      'Only the valid POST may write records.');
    return { validPostStatus: inserted.status, missingActionError: rejected.error, transactionRowsAdded: 1, sourceRowsAdded: 1 };
  });

  const passed = results.filter(function (result) { return result.status === 'PASS'; }).length;
  const failed = results.length - passed;
  const suiteEnded = new Date();
  const report = { success: failed === 0, suite: 'FAST_CORE', total: results.length, passed: passed, failed: failed,
    startedAt: suiteStarted.toISOString(), endedAt: suiteEnded.toISOString(),
    totalMilliseconds: suiteEnded.getTime() - suiteStarted.getTime(),
    testSpreadsheetUrl: testSpreadsheet.getUrl(), productionSpreadsheetWasModified: false, results: results };
  Logger.log('PFIS CORE TEST REPORT\n' + JSON.stringify(report, null, 2));

  PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID = '';
  PFIS_RUNTIME_SPREADSHEET_CACHE = null;
  PFIS_RUNTIME_SPREADSHEET_CACHE_ID = '';
  pfisInvalidateSourceCache();
  pfisInvalidateTransactionCache();
  PFIS_RUNTIME_CATEGORY_CACHE = null;
  if (failed) throw new Error('PFIS core tests failed: ' + failed + ' of ' + results.length + '. See execution log.');
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


