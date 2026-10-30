/**
 * Personal Finance Intelligence System (PFIS) — Transaction Engine v1.1.0
 * First documented project release. Includes timezone-safe period bounds, parsed-date sorting/reconciliation,
 * reference-led cross-channel matching, exact same-channel duplicate suppression, card-payment
 * internal-transfer support, configurable amount-rule evidence, logically blank-safe row allocation,
 * and batched AD:AM writes.
 *
 * RESPONSIBILITIES
 * - Deterministic ingestion, source replay protection, reconciliation, duplicate
 *   review, canonical transaction updates, schema validation and audit logging.
 * - Reads/writes the six existing core tabs by their established physical column
 *   positions. It does not create, rename, reorder, clear, or format spreadsheet tabs.
 * - SMS and EMAIL use one ingestion pipeline. The first valid alert creates the
 *   canonical transaction; an opposite-channel match links evidence to that row.
 * - Exact same-channel duplicate transactions (same precise transaction time,
 *   amount, bank, merchant and compatible account identity) are retained as source
 *   evidence linked to the existing transaction; no second ledger row is inserted.
 *   Near-time lookalikes with a different timestamp remain review candidates so
 *   legitimate repeated purchases are not silently discarded. Exact source replays
 *   are also idempotent.
 * - Only a matched rule with Auto Purpose=TRUE and a meaningful configured purpose may
 *   prefill User Notes. Recurrence alone does not authorize purpose autofill.
 * - When an amount-specific rule misses but merchant-anchored rules agree on one active
 *   category, insertion assigns category only; amount-specific purpose/overrides do not leak.
 * - The backend returns purposeSuggestion/purposeExamples from approved history for the
 *   exact normalized merchant and type; suggestions are never saved without confirmation.
 * - Missing categories are routed before purpose questions; Shortcuts may return ASK_PURPOSE
 *   when evidence is insufficient, and the backend validates saved categories/purposes.
 * - No AI/model call occurs in Apps Script. Shortcuts runs category fallback only when the
 *   backend cannot assign a category and collects user-confirmed purpose.
 *
 * API CONTRACT
 * - GET: health/schema/read actions only. Never use GET for a write.
 * - POST: JSON body contains action plus all fields. For ingestion use action
 *   "ingest", sourceType (SMS or EMAIL), txnString, originalText, sender, subject.
 * - For updates use action "update", transactionId, and non-empty category and/or
 *   purpose (userNotes is accepted for backwards compatibility). Do not send empty
 *   values or try to update backend-owned flags from Shortcuts.
 * - For a potential duplicate/source conflict, use action "resolveexception" with
 *   resolution "CONFIRM_DISTINCT" and a human reason. This confirms that the row
 *   is a separate real transaction; it never deletes or merges ledger rows.
 * - Response status describes this request. verificationStatus describes evidence.
 *   needsEnrichment/requiresPurpose/requiresCategoryClassification describe missing
 *   information; needsReview/reviewStatus describe unresolved review conditions.
 *   nextAction tells the Shortcut what to do for this request so a second-channel
 *   reconcile/replay does not open a competing enrichment prompt.
 *
 * REQUIRED Script Property: SPREADSHEET_ID
 * OPTIONAL Script Property: WEB_APP_SECRET (send token in the JSON body if enabled)
 * Time zone: Asia/Kolkata
 */

const ENGINE_VERSION = 'v1.1.0';
const SCHEMA_VERSION = 'v1.0.0';
const PARSER_VERSION = 'v1.1.0';
const PFIS_TIME_ZONE = 'Asia/Kolkata';
const PFIS_MAX_READ_LIMIT = 100;
const PFIS_MATCH_WINDOW_MS = 5 * 60 * 1000;
const PFIS_FINAL_SOURCE_STATUSES = Object.freeze([
  'ACCEPTED', 'RECONCILED', 'DUPLICATE_CANDIDATE', 'DUPLICATE_SUPPRESSED', 'CONFLICT', 'PARSE_FAILED', 'NON_FINANCIAL_IGNORED', 'SUPERSEDED'
]);
const PFIS_PROCESSING_SOURCE_STATUSES = Object.freeze([
  'PROCESSING_INSERT', 'PROCESSING_DUPLICATE', 'PROCESSING_RECONCILE', 'PROCESSING_CONFLICT'
]);
const PFIS_VALID_TYPES = Object.freeze(['expense', 'income', 'card_payment', 'investment', 'transfer', 'refund']);
const PFIS_SHEETS = Object.freeze({
  transactions: 'Transaction Log',
  sources: 'Source Log',
  changes: 'Change Log',
  rules: 'Rules',
  config: 'Config',
  categories: 'Categories',
  archive: 'Rejected & Archive Log'
});

// The field arrays below ARE the physical schema. Runtime never maps using
// displayed header names. Column 1 is index 0 in a JavaScript row array.
const PFIS_TX_FIELDS = Object.freeze([
  'transactionId', 'dateTime', 'amount', 'bank', 'accountType', 'merchant', 'category',
  'userNotes', 'type', 'instrument', 'account', 'cardName', 'isRecurring',
  'isInternalTransfer', 'needsReview', 'counterparty', 'refNo', 'balanceAfter',
  'schemaVersion', 'reviewStatus', 'reviewReason', 'reviewedBy', 'reviewedAt',
  'ruleApplied', 'ruleType', 'categoryConfidence', 'validationFlag', 'createdAt', 'lastUpdatedAt'
]);
const PFIS_TX_HEADERS = Object.freeze([
  'Transaction ID', 'DateTime', 'Amount', 'Bank', 'Account Type', 'Merchant', 'Category',
  'User Notes', 'Type', 'Instrument', 'Account', 'Card Name', 'Is Recurring',
  'Is Internal Transfer', 'Needs Review', 'Counterparty', 'Ref No', 'Balance After',
  'Schema Version', 'Review Status', 'Review Reason', 'Reviewed By', 'Reviewed At',
  'Rule Applied', 'Rule Type', 'Category Confidence', 'Validation Flag', 'Created At', 'Last Updated At'
]);

const PFIS_SOURCE_FIELDS = Object.freeze([
  'sourceId', 'receivedAt', 'sourceType', 'sender', 'subject', 'rawBody', 'sourceHash',
  'parserVersion', 'parseStatus', 'extractedAmount', 'extractedDate', 'datePrecision',
  'accountIdentifier', 'extractedMerchant', 'extractedReferenceNo', 'linkedTxnId',
  'ingestedAt', 'processingError', 'archivedFlag', 'notes', 'requestId', 'batchId'
]);
const PFIS_SOURCE_HEADERS = Object.freeze([
  'Source ID', 'Received At', 'Source Type', 'Sender', 'Subject', 'Raw Body', 'Source Hash',
  'Parser Version', 'Parse Status', 'Extracted Amount', 'Extracted Date',
  'Extracted Date Precision', 'Extracted Account/Card Identifier', 'Extracted Merchant',
  'Extracted Reference No', 'Linked Txn ID', 'Ingested At', 'Processing Error',
  'Archived Flag', 'Notes', 'Request ID', 'Batch ID'
]);

const PFIS_CHANGE_FIELDS = Object.freeze([
  'changeId', 'transactionId', 'changedAt', 'targetTable', 'actor', 'field', 'oldValue',
  'newValue', 'reason', 'requestId'
]);
const PFIS_CHANGE_HEADERS = Object.freeze([
  'Change ID', 'Transaction ID', 'Changed At', 'Target Table', 'Actor', 'Field', 'Old Value',
  'New Value', 'Reason', 'Request ID'
]);

const PFIS_RULE_FIELDS = Object.freeze([
  'enabled', 'matchType', 'amount', 'merchantContains', 'category', 'merchantOverride',
  'notesTemplate', 'monthOffset', 'isRecurring', 'typeOverride', 'accountOverride',
  'cardNameOverride', 'priority'
]);
const PFIS_RULE_HEADERS = Object.freeze([
  'Enabled', 'Match Type', 'Amount', 'Merchant Contains', 'Category', 'Merchant Override',
  'Notes Template', 'Month Offset', 'Is Recurring', 'Type Override', 'Account Override',
  'Card Name Override', 'Priority'
]);
// Optional Rules extensions N:S retain backward compatibility with older workbooks.
// Auto Purpose is a separate optional T column so its absence never disables N:S.
// Optional values are used only when their physical headers match exactly.
const PFIS_RULE_OPTIONAL_FIELDS = Object.freeze([
  'ruleId', 'ruleEngine', 'instrumentOverride', 'autoReview', 'confidence', 'notes'
]);
const PFIS_RULE_OPTIONAL_HEADERS = Object.freeze([
  'Rule ID', 'Rule Engine', 'Instrument Override', 'Auto Review', 'Confidence', 'Notes'
]);
const PFIS_RULE_AUTO_PURPOSE_COLUMN = 20; // T
const PFIS_RULE_AUTO_PURPOSE_HEADER = 'Auto Purpose';
const PFIS_RULE_PURPOSE_TRIGGER_COLUMN = 21; // U
const PFIS_RULE_PURPOSE_TRIGGER_HEADER = 'Purpose Trigger';
const PFIS_RULE_CALENDAR_SCOPE_COLUMN = 22; // V
const PFIS_RULE_CALENDAR_SCOPE_HEADER = 'Calendar Scope';
const PFIS_HOLIDAY_CALENDAR_SHEET = 'Holiday Calendar';
const PFIS_AUX_TX_COLUMNS = Object.freeze({ flowDirection: 38, auditTrail: 39 });
const PFIS_AUDIT_TRAIL_MAX_CHARS = 1800;

const PFIS_CONFIG_FIELDS = Object.freeze([
  'bank', 'accountType', 'accountCardSuffix', 'merchantContains', 'account', 'cardName',
  'instrument', 'isInternal', 'priority'
]);
const PFIS_CONFIG_HEADERS = Object.freeze([
  'Bank', 'Account Type', 'Account/Card Suffix', 'Merchant Contains', 'Account', 'Card Name',
  'Instrument', 'Is Internal', 'Priority'
]);
// Optional Config!J extension in the user's workbook. It is read only when the
// exact header exists, keeping older nine-column workbooks compatible.
const PFIS_CONFIG_TEXT_PATTERN_COLUMN = 10;
const PFIS_CONFIG_TEXT_PATTERN_HEADER = 'Text Pattern';
const PFIS_LEGACY_TX_COLUMNS = Object.freeze({ first: 30, count: 8, flowDirection: 38, auditTrail: 39 });
const PFIS_LEGACY_TX_HEADERS = Object.freeze([
  'Original Text', 'Source ID', 'Batch ID', 'Message Hash', 'Canonical Key',
  'Merchant Cleaned', 'Is Investment', 'Is Card Payment'
]);
const PFIS_CATEGORY_FIELDS = Object.freeze(['category', 'active']);
const PFIS_CATEGORY_HEADERS = Object.freeze(['Category', 'Active']);

const PFIS_HEADER_DEFINITIONS = Object.freeze([
  { name: PFIS_SHEETS.transactions, fields: PFIS_TX_FIELDS, headers: PFIS_TX_HEADERS, required: true },
  { name: PFIS_SHEETS.sources, fields: PFIS_SOURCE_FIELDS, headers: PFIS_SOURCE_HEADERS, required: true },
  { name: PFIS_SHEETS.changes, fields: PFIS_CHANGE_FIELDS, headers: PFIS_CHANGE_HEADERS, required: true },
  { name: PFIS_SHEETS.rules, fields: PFIS_RULE_FIELDS, headers: PFIS_RULE_HEADERS, required: true },
  { name: PFIS_SHEETS.config, fields: PFIS_CONFIG_FIELDS, headers: PFIS_CONFIG_HEADERS, required: true },
  { name: PFIS_SHEETS.categories, fields: PFIS_CATEGORY_FIELDS, headers: PFIS_CATEGORY_HEADERS, required: true }
]);

// Per-execution override used only by the isolated test harness. Do not set this
// in a normal web request. Apps Script executions do not share this variable.
var PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID = '';
var PFIS_RUNTIME_SPREADSHEET_CACHE_ID = '';
var PFIS_RUNTIME_SPREADSHEET_CACHE = null;
var PFIS_RUNTIME_SOURCE_CACHE = null;
var PFIS_RUNTIME_TRANSACTION_CACHE = null;
var PFIS_RUNTIME_CATEGORY_CACHE = null;
var PFIS_RUNTIME_RULE_CACHE = null;
var PFIS_RUNTIME_CONFIG_CACHE = null;
var PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE = null;
var PFIS_PERF_CONTEXT = null;

// -----------------------------------------------------------------------------
// HTTP entry points and router
// -----------------------------------------------------------------------------

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  if (pfisString(params.view).toLowerCase() === 'dashboard' && typeof pfisServeDashboardHtml === 'function') {
    return pfisServeDashboardHtml(e);
  }
  return pfisJsonOutput(pfisRouteRequest(params, 'GET'));
}

function doPost(e) {
  // All public write/read POST calls use one explicit JSON contract. Never silently
  // fall back to query parameters: that hides Shortcut body-mapping mistakes and
  // can accidentally interpret an incomplete request as an ingestion.
  const body = e && e.postData && typeof e.postData.contents === 'string'
    ? e.postData.contents.trim()
    : '';

  if (!body) {
    return pfisJsonOutput({
      success: false, status: 'BAD_REQUEST', error: 'EMPTY_BODY',
      message: 'POST requires a JSON request body. Set Request Body to JSON in Shortcuts/Postman.',
      requestId: Utilities.getUuid()
    });
  }

  let params;
  try {
    params = JSON.parse(body);
  } catch (error) {
    return pfisJsonOutput({
      success: false, status: 'BAD_REQUEST', error: 'BAD_JSON',
      message: 'POST body must be valid JSON.', requestId: Utilities.getUuid()
    });
  }

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return pfisJsonOutput({
      success: false, status: 'BAD_REQUEST', error: 'INVALID_BODY',
      message: 'POST JSON body must be an object of key/value pairs.', requestId: Utilities.getUuid()
    });
  }

  if (!pfisString(params.action)) {
    return pfisJsonOutput({
      success: false, status: 'BAD_REQUEST', error: 'MISSING_ACTION',
      message: 'The JSON body must include an explicit action such as ingest or update.',
      requestId: Utilities.getUuid()
    });
  }

  return pfisJsonOutput(pfisRouteRequest(params, 'POST'));
}

function pfisRouteRequest(input, method) {
  const params = input && typeof input === 'object' ? input : {};
  const requestId = pfisString(params.requestId) || Utilities.getUuid();
  const action = pfisNormalizeAction(params.action);
  const previousPerfContext = PFIS_PERF_CONTEXT;
  const perfContext = pfisPerfBegin(requestId, action, method);
  PFIS_PERF_CONTEXT = perfContext;
  // Keep execution caches request-scoped: avoid stale category/source data when a
  // warm Apps Script runtime is reused, while still reusing reads within this request.
  PFIS_RUNTIME_SOURCE_CACHE = null;
  PFIS_RUNTIME_TRANSACTION_CACHE = null;
  PFIS_RUNTIME_CATEGORY_CACHE = null;
  PFIS_RUNTIME_RULE_CACHE = null;
  PFIS_RUNTIME_CONFIG_CACHE = null;
  PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE = null;

  try {
    pfisPerfMeasure('authorization', function () { return pfisAuthorize(params); });

    // Read-only operations are dispatched before source-specific ingestion.
    if (action === 'health' || action === 'ping') {
      return {
        success: true, status: 'HEALTHY', engineVersion: ENGINE_VERSION,
        schemaVersion: SCHEMA_VERSION, parserVersion: PARSER_VERSION,
        timestamp: new Date().toISOString(), requestId: requestId
      };
    }
    if (action === 'validate' || action === 'validateschema') {
      return pfisValidateWorkbook(requestId);
    }
    const readActions = [
      'gettransaction', 'gettransactiondetail', 'getpendingreview', 'getneedsenrichment',
      'searchtransactions', 'getfinancialoverview', 'getcategorybreakdown', 'getmerchantanalysis',
      'getrecurringcommitments', 'getcashflow', 'getspendingbehavior', 'getanomalies', 'getdataquality'
    ];
    if (readActions.indexOf(action) >= 0) pfisAssertSchema();

    if (['gettransaction', 'gettransactiondetail'].indexOf(action) >= 0) {
      const txnId = pfisString(params.transactionId || params.txnId);
      const transaction = pfisGetTransaction(txnId, pfisTruthy(params.includeEvidence));
      return { success: !!transaction, status: transaction ? 'FOUND' : 'NOT_FOUND', data: transaction, requestId: requestId };
    }
    if (action === 'getpendingreview') {
      const data = pfisGetPendingReview(params.limit);
      return { success: true, count: data.length, data: data, requestId: requestId };
    }
    if (action === 'getneedsenrichment') {
      const data = pfisGetNeedsEnrichment(params.limit);
      return { success: true, count: data.length, data: data, requestId: requestId };
    }
    if (action === 'searchtransactions') {
      return pfisSearchTransactions(params, requestId);
    }
    if (action === 'getfinancialoverview') return pfisGetFinancialOverview(params, requestId);
    if (action === 'getcategorybreakdown') return pfisGetCategoryBreakdown(params, requestId);
    if (action === 'getmerchantanalysis') return pfisGetMerchantAnalysis(params, requestId);
    if (action === 'getrecurringcommitments') return pfisGetRecurringCommitments(params, requestId);
    if (action === 'getcashflow') return pfisGetCashFlow(params, requestId);
    if (action === 'getspendingbehavior') return pfisGetSpendingBehavior(params, requestId);
    if (action === 'getanomalies') return pfisGetAnomalies(params, requestId);
    if (action === 'getdataquality') return pfisGetDataQuality(params, requestId);

    const writeActions = ['', 'ingest', 'ingesttransaction', 'update', 'updatetransaction', 'reprocesssource', 'resolveexception'];
    if (writeActions.indexOf(action) < 0) {
      return { success: false, error: 'UNKNOWN_ACTION', message: 'Unsupported action: ' + action, requestId: requestId };
    }
    if (method === 'GET') {
      return { success: false, error: 'METHOD_NOT_ALLOWED', message: 'Use POST for all write operations.', requestId: requestId };
    }

    const lock = LockService.getScriptLock();
    const lockStartedAt = Date.now();
    const lockAcquired = lock.tryLock(30000);
    pfisPerfRecord('script_lock_wait', Date.now() - lockStartedAt);
    if (!lockAcquired) {
      return { success: false, error: 'BUSY', message: 'Could not acquire the write lock within 30 seconds.', requestId: requestId };
    }
    try {
      pfisAssertSchema();
      if (action === 'update' || action === 'updatetransaction') return pfisPerfMeasure('update_pipeline', function () { return pfisUpdateTransaction(params, requestId); });
      if (action === 'resolveexception') return pfisPerfMeasure('resolve_exception_pipeline', function () { return pfisResolveTransactionException(params, requestId); });
      if (action === 'reprocesssource') return pfisPerfMeasure('reprocess_pipeline', function () { return pfisReprocessSource(params, requestId); });
      return pfisPerfMeasure('ingest_pipeline', function () { return pfisIngestSource(params, requestId); });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error('PFIS request error', requestId, error && error.stack ? error.stack : error);
    let errorLog = { sourceLogLogged: false, changeLogLogged: false };
    try {
      errorLog = pfisLogUnhandledRequestError(params, action, requestId, error) || errorLog;
    } catch (loggingError) {
      // Diagnostics must never mask the original request error.
      console.error('PFIS error logging failed', requestId, loggingError && loggingError.stack ? loggingError.stack : loggingError);
    }
    return {
      success: false,
      error: error && error.code ? error.code : 'SERVER_ERROR',
      message: error && error.message ? error.message : String(error),
      requestId: requestId,
      errorLoggedToSheet: !!(errorLog.sourceLogLogged || errorLog.changeLogLogged),
      sourceLogLogged: !!errorLog.sourceLogLogged,
      changeLogLogged: !!errorLog.changeLogLogged
    };
  } finally {
    pfisPerfFinish(perfContext);
    PFIS_PERF_CONTEXT = previousPerfContext;
  }
}

/**
 * Best-effort audit for unexpected runtime exceptions. Ingestion evidence is
 * recorded in Source Log only when no matching canonical/source record exists,
 * or an unfinished source already exists. Every caught runtime exception also
 * attempts an idempotent Change Log entry. Logging failures are swallowed so
 * the original API error remains visible.
 */
function pfisLogUnhandledRequestError(params, action, requestId, error) {
  const result = { sourceLogLogged: false, changeLogLogged: false };
  const p = params && typeof params === 'object' ? params : {};
  const actionKey = pfisNormalizeAction(action || p.action);
  const message = pfisString(error && error.message ? error.message : error).slice(0, 1500);
  const errorCode = pfisString(error && error.code) || 'SERVER_ERROR';
  const diagnostic = errorCode + ': ' + message;
  const safeSheets = {};
  try {
    // Do not write diagnostics into a sheet whose positional schema is unsafe.
    // Check per-sheet status rather than requiring every unrelated tab to pass.
    const schema = pfisCheckWorkbookStructure();
    schema.checks.forEach(function (check) { safeSheets[check.sheet] = check.status === 'OK'; });
  } catch (schemaError) {
    console.error('PFIS diagnostic schema check failed', requestId, schemaError);
  }

  // Source Log is for source-related failures. Don't manufacture source rows for
  // reads/updates or for malformed requests that contain no source evidence.
  if (['', 'ingest', 'ingesttransaction'].indexOf(actionKey) >= 0) {
    const sourceType = pfisNormalizeSourceType(p.sourceType);
    const evidenceText = p.originalText === undefined || p.originalText === null ? '' : String(p.originalText);
    if (sourceType && evidenceText.trim() && safeSheets[PFIS_SHEETS.sources] === true) {
      try {
        const sourceHash = pfisComputeSourceHash(sourceType, evidenceText);
        const sheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
        const rows = pfisReadFixedRows(sheet, PFIS_SOURCE_FIELDS.length);
        let latest = null;
        for (let i = rows.length - 1; i >= 0; i--) {
          const source = pfisObjectFromRow(rows[i], PFIS_SOURCE_FIELDS);
          if (pfisString(source.sourceHash) !== sourceHash) continue;
          if (pfisNormalizeSourceType(source.sourceType) !== sourceType) continue;
          latest = { source: source, rowNumber: i + 2 };
          break;
        }

        if (latest) {
          const status = pfisString(latest.source.parseStatus).toUpperCase();
          if (status === 'SERVER_ERROR') {
            // Update an existing diagnostic rather than growing duplicates on
            // repeated failures. This status is ignored by replay lookup so retry works.
            sheet.getRange(latest.rowNumber, 18).setValue(diagnostic);
            sheet.getRange(latest.rowNumber, 20).setValue('Unexpected runtime exception. This diagnostic source does not block retries.');
            sheet.getRange(latest.rowNumber, 21).setValue(requestId);
            result.sourceLogLogged = true;
            pfisInvalidateSourceCache();
          } else if (status.indexOf('PROCESSING_') === 0) {
            // Keep the processing status and the Notes JSON intact so interrupted-
            // write recovery still works. Only add the exception to Processing Error.
            sheet.getRange(latest.rowNumber, 18).setValue(diagnostic);
            sheet.getRange(latest.rowNumber, 21).setValue(requestId);
            result.sourceLogLogged = true;
            pfisInvalidateSourceCache();
          }
          // If a final source already exists, do not duplicate the source evidence.
          // The Change Log event below records the request-level exception.
        } else {
          const record = {
            sourceId: pfisMakeId('SRC-'), receivedAt: new Date(), sourceType: sourceType,
            sender: pfisString(p.sender), subject: pfisString(p.subject), rawBody: evidenceText,
            sourceHash: sourceHash, parserVersion: PARSER_VERSION, parseStatus: 'SERVER_ERROR',
            extractedAmount: '', extractedDate: '', datePrecision: '',
            accountIdentifier: '', extractedMerchant: '', extractedReferenceNo: '', linkedTxnId: '',
            ingestedAt: new Date(), processingError: diagnostic, archivedFlag: false,
            notes: 'Unexpected runtime exception before the source was finalized. This diagnostic row is excluded from replay matching; retry is allowed.',
            requestId: requestId, batchId: pfisString(p.batchId)
          };
          pfisAppendSourceRow(record);
          pfisInvalidateSourceCache();
          result.sourceLogLogged = true;
        }
      } catch (sourceLogError) {
        console.error('PFIS Source Log diagnostic write failed', requestId,
          sourceLogError && sourceLogError.stack ? sourceLogError.stack : sourceLogError);
      }
    }
  }

  // Change Log captures exceptions even for requests that were not ingestion.
  try {
    if (safeSheets[PFIS_SHEETS.changes] !== true) return result;
    pfisAppendChangeOnce('request-server-error:' + requestId, {
      transactionId: pfisString(p.transactionId || p.txnId),
      targetTable: ['ingest', 'ingesttransaction', ''].indexOf(actionKey) >= 0 ? PFIS_SHEETS.sources : (actionKey || 'Request'),
      actor: 'system_error', field: 'SERVER_ERROR', oldValue: '', newValue: errorCode,
      reason: diagnostic, requestId: requestId
    });
    result.changeLogLogged = true;
  } catch (changeLogError) {
    console.error('PFIS Change Log diagnostic write failed', requestId,
      changeLogError && changeLogError.stack ? changeLogError.stack : changeLogError);
  }
  return result;
}

// -----------------------------------------------------------------------------
// Ingestion workflow: source replay -> reconciliation -> duplicate review -> insert
// -----------------------------------------------------------------------------

function pfisIngestSource(params, requestId, options) {
  const opts = options || {};
  const sourceType = pfisNormalizeSourceType(params.sourceType);
  if (!sourceType) {
    return { success: false, error: 'INVALID_SOURCE_TYPE', message: 'sourceType must be SMS or EMAIL.', requestId: requestId };
  }

  const txnString = pfisString(params.txnString);
  const evidenceText = params.originalText === undefined || params.originalText === null
    ? '' : String(params.originalText);
  if (!evidenceText.trim()) {
    return { success: false, error: 'EMPTY_BODY', message: 'originalText must contain the complete source message.', requestId: requestId };
  }
  if (!txnString) {
    return pfisStoreParseFailure(sourceType, evidenceText, params, requestId, 'Missing txnString.', opts);
  }

  const sourceHash = pfisPerfMeasure('source_hash_calculation', function () { return pfisComputeSourceHash(sourceType, evidenceText); });
  const previousSource = pfisPerfMeasure('source_replay_lookup', function () { return pfisFindSourceByHash(sourceHash, sourceType, opts.ignoreSourceId || '', !!opts.ignoreParseFailed, !!opts.ignoreOrphaned); });
  if (previousSource && !opts.allowExistingProcessing) {
    const priorStatus = pfisString(previousSource.parseStatus).toUpperCase();
    if (PFIS_PROCESSING_SOURCE_STATUSES.indexOf(priorStatus) >= 0) {
      return pfisRecoverProcessingSource(previousSource, txnString, params, requestId);
    }

    // A failed parse is not a successful replay. If the Shortcut now sends valid
    // parsed fields for the same original alert, retry automatically and retain
    // the old failure as SUPERSEDED audit evidence instead of trapping the user.
    if (priorStatus === 'PARSE_FAILED') {
      return pfisRetryPreviouslyFailedSource(previousSource, params, requestId);
    }
    if (priorStatus === 'CONFLICT') {
      const priorMeta = pfisParseProcessingMeta(previousSource.notes);
      const conflictTransactionId = pfisString(priorMeta.newTransactionId);
      if (!conflictTransactionId || pfisFindTransactionRow(conflictTransactionId) < 2) {
        // Recover legacy conflicts that linked only to
        // an existing candidate and failed to create a separate ledger row.
        return pfisRecoverLegacyConflictSource(previousSource, params, requestId);
      }
    }

    // A final source with a broken/missing transaction link is recoverable. Do
    // not let a stale source row permanently block a valid transaction insert.
    const linkedRow = previousSource.linkedTxnId ? pfisFindTransactionRow(previousSource.linkedTxnId) : -1;
    if (txnString && pfisParseTxnString(txnString) && linkedRow < 2 &&
      ['ACCEPTED', 'RECONCILED', 'DUPLICATE_CANDIDATE', 'CONFLICT'].indexOf(priorStatus) >= 0) {
      return pfisRetryOrphanedSource(previousSource, params, requestId);
    }
    return pfisReplayResponse(previousSource, requestId);
  }

  const parsed = pfisPerfMeasure('pipe_parse', function () { return pfisParseTxnString(txnString); });
  if (!parsed) {
    return pfisStoreParseFailure(sourceType, evidenceText, params, requestId,
      'Expected 10 pipe-separated fields; datetime, non-zero signed amount and bank are required.', opts);
  }
  parsed.rawEvidence = evidenceText;
  parsed.accountIdentifier = pfisExtractAccountIdentifier(evidenceText);
  // An internal midnight value is not a real timestamp unless the original
  // notification contains a clock time. Downgrade it before matching/logging.
  pfisNormalizeSourceDatePrecision(parsed, evidenceText);
  const ruleResult = pfisPerfMeasure('rules_evaluation', function () { return pfisEvaluateRules(parsed, evidenceText); });
  const configResult = pfisPerfMeasure('config_resolution', function () { return pfisResolveConfig(parsed, evidenceText); });
  parsed.account = pfisCleanText(ruleResult.accountOverride || configResult.account);
  parsed.cardName = pfisCleanText(ruleResult.cardNameOverride || configResult.cardName);
  parsed.resolvedType = pfisNormalizeType(ruleResult.typeOverride || parsed.type);
  const canonicalMerchant = pfisCleanText(ruleResult.merchantOverride || parsed.merchant);
  parsed.canonicalMerchant = canonicalMerchant;

  const crossMatch = pfisPerfMeasure('cross_channel_matching', function () { return pfisFindCrossChannelMatch(parsed, sourceType, canonicalMerchant); });
  if (crossMatch.status === 'MATCHED') {
    return pfisLinkOppositeSource(crossMatch, parsed, evidenceText, params, requestId, sourceType, sourceHash, ruleResult, configResult);
  }
  if (crossMatch.status === 'CONFLICT') {
    return pfisRecordSourceConflict(crossMatch, parsed, evidenceText, params, requestId, sourceType, sourceHash, ruleResult, configResult);
  }

  const paymentEventMatch = pfisPerfMeasure('card_payment_event_matching', function () {
    return pfisFindCardPaymentEventMatch(parsed, evidenceText);
  });
  if (paymentEventMatch.status === 'MATCHED') {
    return pfisLinkPaymentEventSource(paymentEventMatch, parsed, evidenceText, params, requestId, sourceType, sourceHash, ruleResult, configResult);
  }
  if (paymentEventMatch.status === 'CONFLICT') {
    return pfisRecordSourceConflict(paymentEventMatch, parsed, evidenceText, params, requestId, sourceType, sourceHash, ruleResult, configResult);
  }

  const duplicate = pfisPerfMeasure('same_channel_duplicate_matching', function () { return pfisFindSameChannelDuplicate(parsed, sourceType, canonicalMerchant); });
  // A high-confidence same-channel duplicate must not create a second canonical
  // Transaction Log row. Keep the incoming message in Source Log, link it to the
  // original transaction, and audit the suppression. Exact time alone is not
  // sufficient: the matcher also requires matching amount/bank/merchant and a
  // compatible account identity; conflicting reference numbers disqualify it.
  if (duplicate && duplicate.exactDateTime === true) {
    return pfisRecordSuppressedSameChannelDuplicate(
      duplicate, parsed, evidenceText, params, requestId, sourceType, sourceHash);
  }
  let reviewReason = '';
  if (!pfisNormalizeType(ruleResult.typeOverride || parsed.type)) reviewReason = 'unknown_transaction_type';
  else if (!canonicalMerchant || !pfisIsMatchableMerchant(canonicalMerchant)) reviewReason = 'merchant_missing_or_unusable';
  if (crossMatch.timePrecisionCandidate && !reviewReason) reviewReason = 'time_precision_unavailable';
  if (duplicate) reviewReason = 'duplicate_candidate';

  const transactionId = opts.forcedTransactionId || pfisGenerateTransactionId(parsed.datetime);
  const sourceId = opts.forcedSourceId || pfisMakeId('SRC-');
  const processStatus = duplicate ? 'PROCESSING_DUPLICATE' : 'PROCESSING_INSERT';
  const processMeta = {
    phase: 'INSERT',
    duplicateCandidateId: duplicate ? duplicate.transactionId : '',
    reviewReason: reviewReason,
    datePrecision: parsed.datePrecision
  };
  let sourceRowNumber = opts.existingSourceRowNumber || 0;

  if (!sourceRowNumber) {
    sourceRowNumber = pfisPerfMeasure('source_log_append', function () {
      return pfisAppendSourceRow({
        sourceId: sourceId, receivedAt: new Date(), sourceType: sourceType,
        sender: pfisString(params.sender), subject: pfisString(params.subject), rawBody: evidenceText,
        sourceHash: sourceHash, parserVersion: PARSER_VERSION, parseStatus: processStatus,
        extractedAmount: parsed.amount, extractedDate: parsed.datetime, datePrecision: parsed.datePrecision,
        accountIdentifier: parsed.accountIdentifier, extractedMerchant: parsed.merchant,
        extractedReferenceNo: parsed.refNo, linkedTxnId: transactionId, ingestedAt: new Date(),
        processingError: '', archivedFlag: false, notes: JSON.stringify(processMeta),
        requestId: requestId, batchId: pfisString(params.batchId)
      });
    });
  }

  const txObject = pfisBuildTransaction(parsed, params, sourceType, transactionId, sourceId,
    sourceHash, ruleResult, configResult, reviewReason, duplicate);
  const existingTxnRow = pfisFindTransactionRow(transactionId);
  if (existingTxnRow < 2) pfisPerfMeasure('transaction_log_append', function () { return pfisAppendTransaction(txObject, 'Created from ' + sourceType + ' source ' + sourceId); });

  pfisAppendChangeOnce('transaction-created:' + transactionId, {
    transactionId: transactionId, targetTable: PFIS_SHEETS.transactions, actor: 'system_ingestion',
    field: 'Created', oldValue: '', newValue: transactionId, reason: 'First valid source inserted canonical transaction.', requestId: requestId
  });
  if (duplicate) {
    pfisAppendChangeOnce('duplicate-candidate:' + sourceId, {
      transactionId: transactionId, targetTable: PFIS_SHEETS.transactions, actor: 'system_matching',
      field: 'Validation Flag', oldValue: '', newValue: 'DUPLICATE_CANDIDATE',
      reason: 'Potential same-channel duplicate of ' + duplicate.transactionId, requestId: requestId
    });
  }
  if (crossMatch.timePrecisionCandidate) {
    pfisFlagTransactionsForReview(crossMatch.timePrecisionCandidateIds || [], 'time_precision_unavailable', 'NEEDS_REVIEW', requestId);
  }

  const finalStatus = duplicate ? 'DUPLICATE_CANDIDATE' : 'ACCEPTED';
  pfisFinalizeSource(sourceRowNumber, finalStatus,
    duplicate ? 'Different same-channel alert resembles transaction ' + duplicate.transactionId + ' within five minutes.' :
      (crossMatch.timePrecisionCandidate ? 'Potential opposite-channel match not auto-linked because a source lacks time precision.' : 'Source accepted and linked to canonical transaction.'), '');

  const transaction = pfisPerfMeasure('response_transaction_read', function () { return pfisGetTransaction(transactionId, false); });
  return pfisBuildIngestResponse(transaction, requestId, sourceType, finalStatus, sourceId);
}

/**
 * A rule-generated purpose is trusted only when its explicit Auto Purpose flag is
 * TRUE and the matched rule supplies a meaningful purpose. Recurrence alone is
 * not permission to infer the purpose of an individual payment.
 */
function pfisGetTrustedPurposeFromRule(ruleResult, merchant, transactionDate) {
  if (!ruleResult) return '';
  const trigger = pfisString(ruleResult.purposeTrigger).toUpperCase();
  const triggerSatisfied = trigger === 'LAST_WORKING_DAY_OF_MONTH' &&
    pfisIsLastWorkingDayOfMonth(transactionDate, ruleResult.calendarScope);
  if (!pfisTruthy(ruleResult.autoPurpose) && !triggerSatisfied) return '';
  const purpose = pfisCleanText(ruleResult.notes);
  return pfisIsMeaningfulPurpose(purpose, merchant) ? purpose : '';
}

/**
 * Tests the transaction's own calendar date, never the request-arrival/current date.
 * Saturday/Sunday are non-working by default. Optional Holiday Calendar rows can
 * override dates per scope (e.g. HCL) or globally (ALL).
 *
 * Holiday Calendar headers: Date | Calendar Scope | Is Working Day | Description
 */
function pfisGetHolidayCalendarOverrides() {
  if (PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE !== null) return PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE;
  const overrides = Object.create(null);
  const sheet = pfisGetSpreadsheet().getSheetByName(PFIS_HOLIDAY_CALENDAR_SHEET);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 3) {
    PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE = overrides;
    return overrides;
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(pfisHeaderToken);
  const dateIndex = headers.indexOf('date');
  const scopeIndex = headers.indexOf('calendarscope');
  const workingIndex = headers.indexOf('isworkingday');
  if (dateIndex < 0 || workingIndex < 0) {
    console.warn('Holiday Calendar ignored: Date and Is Working Day headers are required.');
    PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE = overrides;
    return overrides;
  }
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  rows.forEach(function (row) {
    const date = pfisParseDateValue(row[dateIndex]);
    if (!date) return;
    const workingValue = row[workingIndex];
    if (workingValue === '' || workingValue === null || workingValue === undefined) return;
    const dateKey = Utilities.formatDate(date, PFIS_TIME_ZONE, 'yyyy-MM-dd');
    const scope = scopeIndex >= 0 ? (pfisString(row[scopeIndex]).toUpperCase() || 'ALL') : 'ALL';
    overrides[dateKey + '|' + scope] = pfisTruthy(workingValue);
  });
  PFIS_RUNTIME_HOLIDAY_CALENDAR_CACHE = overrides;
  return overrides;
}

function pfisIsCalendarWorkingDay(dateValue, calendarScope) {
  const date = pfisParseDateValue(dateValue);
  if (!date) return false;
  const dateKey = Utilities.formatDate(date, PFIS_TIME_ZONE, 'yyyy-MM-dd');
  const scope = pfisString(calendarScope).toUpperCase() || 'ALL';
  const overrides = pfisGetHolidayCalendarOverrides();
  const scopedKey = dateKey + '|' + scope;
  const allKey = dateKey + '|ALL';
  if (Object.prototype.hasOwnProperty.call(overrides, scopedKey)) return overrides[scopedKey];
  if (Object.prototype.hasOwnProperty.call(overrides, allKey)) return overrides[allKey];
  const isoDay = Number(Utilities.formatDate(date, PFIS_TIME_ZONE, 'u'));
  return isoDay >= 1 && isoDay <= 5;
}

function pfisIsLastWorkingDayOfMonth(dateValue, calendarScope) {
  const date = pfisParseDateValue(dateValue);
  if (!date || !pfisIsCalendarWorkingDay(date, calendarScope)) return false;
  const year = Number(Utilities.formatDate(date, PFIS_TIME_ZONE, 'yyyy'));
  const month = Number(Utilities.formatDate(date, PFIS_TIME_ZONE, 'M'));
  const day = Number(Utilities.formatDate(date, PFIS_TIME_ZONE, 'd'));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let nextDay = day + 1; nextDay <= daysInMonth; nextDay++) {
    const candidate = pfisCreateIndiaDate(year, month, nextDay, 12, 0, 0);
    if (pfisIsCalendarWorkingDay(candidate, calendarScope)) return false;
  }
  return true;
}

function pfisBuildTransaction(parsed, params, sourceType, transactionId, sourceId, sourceHash,
  ruleResult, configResult, reviewReason, duplicate) {
  const now = new Date();
  const type = pfisNormalizeType(ruleResult.typeOverride || parsed.type);
  const categories = pfisGetCategoryList();
  const configuredCategory = pfisCleanText(ruleResult.category);
  const category = categories.indexOf(configuredCategory) >= 0
    ? configuredCategory
    : (categories.indexOf('Miscellaneous') >= 0 ? 'Miscellaneous' : '');
  // Only a matched rule with Auto Purpose=TRUE may prefill User Notes.
  // Recurrence alone does not establish a purpose; otherwise keep it blank.
  // Frontend/model enrichment is saved only through the explicit update action.
  const userNotes = pfisGetTrustedPurposeFromRule(
    ruleResult, ruleResult.merchantOverride || parsed.merchant, parsed.datetime);
  // Purpose is optional. Only an unresolved category is an enrichment gap;
  // an active Miscellaneous fallback is a valid, auditable category.
  const enrichmentMissing = !category;
  const accountOverrideResolvesConfig = !!pfisCleanText(ruleResult.accountOverride);
  const configReviewReason = configResult && configResult.ambiguous ? 'config_mapping_ambiguous' :
    (configResult && configResult.unresolved && !accountOverrideResolvesConfig ? 'config_mapping_unresolved' : '');
  const actualReviewReason = duplicate ? 'duplicate_candidate' :
    (reviewReason || configReviewReason || (enrichmentMissing ? 'enrichment_required' : ''));
  const needsReview = !!actualReviewReason;
  const confidence = pfisParseConfidence(ruleResult.confidence);
  return {
    transactionId: transactionId,
    dateTime: parsed.datetime,
    amount: parsed.amount,
    bank: parsed.bank,
    accountType: pfisFormatAccountType(parsed.accountType),
    merchant: pfisCleanText(ruleResult.merchantOverride || parsed.merchant),
    category: category,
    userNotes: userNotes,
    type: type,
    // Never overwrite a source-provided instrument with a Config/Rule default.
    instrument: pfisCleanText(parsed.instrument || ruleResult.instrumentOverride || configResult.instrument),
    account: pfisCleanText(ruleResult.accountOverride || configResult.account),
    cardName: pfisCleanText(ruleResult.cardNameOverride || configResult.cardName),
    isRecurring: !!ruleResult.isRecurring,
    isInternalTransfer: !!configResult.isInternal && (type === 'transfer' || type === 'card_payment'),
    needsReview: needsReview,
    counterparty: parsed.counterparty,
    refNo: parsed.refNo,
    balanceAfter: parsed.balanceAfter,
    schemaVersion: SCHEMA_VERSION,
    reviewStatus: needsReview ? 'Pending' : 'Approved',
    reviewReason: actualReviewReason,
    reviewedBy: needsReview ? '' : 'SYSTEM_RULES',
    reviewedAt: needsReview ? '' : now,
    ruleApplied: ruleResult.ruleApplied || '',
    ruleType: ruleResult.ruleType || '',
    // Do not fabricate a confidence score: Rules match means assigned, not calibrated confidence.
    categoryConfidence: !category || confidence === null ? '' : confidence,
    validationFlag: duplicate ? 'DUPLICATE_CANDIDATE' : (actualReviewReason === 'source_conflict' ? 'SOURCE_CONFLICT' : (needsReview ? 'NEEDS_REVIEW' : 'VALID')),
    createdAt: now,
    lastUpdatedAt: now,
    // Optional existing workbook columns AD:AK. These properties are not part of
    // the canonical A:AC schema and are written only when matching headers exist.
    originalText: params && params.originalText !== undefined ? String(params.originalText) : '',
    sourceId: sourceId || '', batchId: pfisString(params && params.batchId), sourceHash: sourceHash || '',
    canonicalKey: transactionId ? 'CANON-' + transactionId : '',
    merchantCleaned: pfisNormalizeMerchant(ruleResult.merchantOverride || parsed.merchant),
    isInvestment: type === 'investment', isCardPayment: type === 'card_payment',
    budgetMonthOffset: isFinite(Number(ruleResult.budgetMonthOffset)) ? Math.trunc(Number(ruleResult.budgetMonthOffset)) : 0
  };
}

function pfisLinkOppositeSource(match, parsed, evidenceText, params, requestId, sourceType, sourceHash, ruleResult, configResult) {
  const sourceId = pfisMakeId('SRC-');
  const processMeta = { phase: 'RECONCILE', reason: match.reason, transactionId: match.transactionId };
  const sourceRowNumber = pfisPerfMeasure('source_log_append', function () {
    return pfisAppendSourceRow({
      sourceId: sourceId, receivedAt: new Date(), sourceType: sourceType,
      sender: pfisString(params.sender), subject: pfisString(params.subject), rawBody: evidenceText,
      sourceHash: sourceHash, parserVersion: PARSER_VERSION, parseStatus: 'PROCESSING_RECONCILE',
      extractedAmount: parsed.amount, extractedDate: parsed.datetime, datePrecision: parsed.datePrecision,
      accountIdentifier: parsed.accountIdentifier, extractedMerchant: parsed.merchant,
      extractedReferenceNo: parsed.refNo, linkedTxnId: match.transactionId, ingestedAt: new Date(),
      processingError: '', archivedFlag: false, notes: JSON.stringify(processMeta),
      requestId: requestId, batchId: pfisString(params.batchId)
    });
  });

  pfisPerfMeasure('enrich_existing_transaction', function () { return pfisEnrichBlankTransactionFields(match.transactionId, parsed, ruleResult, configResult, requestId); });
  pfisAppendChangeOnce('source-reconciled:' + sourceId, {
    transactionId: match.transactionId, targetTable: PFIS_SHEETS.sources, actor: 'system_reconciliation',
    field: 'Linked Txn ID', oldValue: '', newValue: match.transactionId,
    reason: 'Opposite-channel evidence matched: ' + match.reason, requestId: requestId
  });
  pfisAppendChangeOnce('verification-updated:' + sourceId, {
    transactionId: match.transactionId, targetTable: PFIS_SHEETS.transactions, actor: 'system_reconciliation',
    field: 'Verification', oldValue: '', newValue: 'VERIFIED',
    reason: 'Both SMS and EMAIL evidence are linked to the same transaction.', requestId: requestId
  });
  pfisPerfMeasure('source_finalize', function () { return pfisFinalizeSource(sourceRowNumber, 'RECONCILED', 'Cross-channel match: ' + match.reason, ''); });
  const transactionRow = pfisFindTransactionRow(match.transactionId);
  if (transactionRow >= 2) {
    pfisWriteLegacyTransactionAux(transactionRow, pfisGetTransaction(match.transactionId, false),
      'Verified by ' + sourceType + ' source ' + sourceId);
  }

  const matchedTransaction = pfisPerfMeasure('response_transaction_read', function () { return pfisGetTransaction(match.transactionId, false); });
  return pfisBuildIngestResponse(matchedTransaction, requestId, sourceType, 'RECONCILED', sourceId);
}

function pfisRecordSourceConflict(match, parsed, evidenceText, params, requestId, sourceType, sourceHash, ruleResult, configResult) {
  // Production-safety rule: contradictions are review flags, not write blockers.
  // Preserve the incoming alert as its own transaction, then flag existing
  // candidates. Never silently discard a distinct financial event.
  const sourceId = pfisMakeId('SRC-');
  const candidates = pfisUnique((match.candidateTransactionIds || []).filter(Boolean));
  const transactionId = pfisGenerateTransactionId(parsed.datetime);
  const meta = {
    phase: 'CONFLICT',
    reason: match.reason,
    candidateTransactionIds: candidates,
    newTransactionId: transactionId
  };
  const sourceRow = pfisAppendSourceRow({
    sourceId: sourceId, receivedAt: new Date(), sourceType: sourceType,
    sender: pfisString(params.sender), subject: pfisString(params.subject), rawBody: evidenceText,
    sourceHash: sourceHash, parserVersion: PARSER_VERSION, parseStatus: 'PROCESSING_CONFLICT',
    extractedAmount: parsed.amount, extractedDate: parsed.datetime, datePrecision: parsed.datePrecision,
    accountIdentifier: parsed.accountIdentifier, extractedMerchant: parsed.merchant,
    extractedReferenceNo: parsed.refNo, linkedTxnId: transactionId, ingestedAt: new Date(),
    processingError: match.reason, archivedFlag: false, notes: JSON.stringify(meta),
    requestId: requestId, batchId: pfisString(params.batchId)
  });

  const reviewReason = 'source_conflict';
  const transaction = pfisBuildTransaction(parsed, params, sourceType, transactionId, sourceId,
    sourceHash, ruleResult, configResult, reviewReason, null);
  pfisAppendTransaction(transaction, 'Created as separate conflict record from ' + sourceType + ' source ' + sourceId);
  pfisAppendChangeOnce('transaction-created:' + transactionId, {
    transactionId: transactionId, targetTable: PFIS_SHEETS.transactions, actor: 'system_ingestion',
    field: 'Created', oldValue: '', newValue: transactionId,
    reason: 'Distinct source recorded as a new transaction because existing opposite-channel evidence conflicts.',
    requestId: requestId
  });

  // Mark any existing potentially related transactions for human review, but do
  // not reuse their IDs or overwrite their financial facts.
  pfisFlagTransactionsForReview(candidates, 'source_conflict', 'SOURCE_CONFLICT', requestId, sourceId, match.reason);
  pfisFinalizeSource(sourceRow, 'CONFLICT',
    'Incoming transaction was recorded separately; conflicting candidate IDs=' + candidates.join(','), match.reason);

  const response = pfisBuildIngestResponse(pfisGetTransaction(transactionId, false), requestId,
    sourceType, 'CONFLICT', sourceId);
  response.recorded = true;
  response.conflictingTransactionIds = candidates;
  response.reason = match.reason;
  response.message = 'Incoming transaction was saved separately and flagged because matching evidence conflicts.';
  return response;
}

/**
 * Recover a source previously stored as PARSE_FAILED when the same alert is now
 * supplied with valid parsed fields. The failed row remains in Source Log as
 * SUPERSEDED for audit; it must not trap the Shortcut in IDEMPOTENT_REPLAY.
 */
function pfisRetryPreviouslyFailedSource(previousSource, params, requestId) {
  const txnString = pfisString(params.txnString);
  if (!txnString || !pfisParseTxnString(txnString)) {
    return {
      success: false, status: 'PARSE_FAILED', error: 'PARSE_FAILED',
      message: 'This alert is already retained as PARSE_FAILED. Supply a valid 10-field txnString to retry; no transaction has been inserted yet.',
      sourceId: previousSource.sourceId, transactionId: null, requestId: requestId
    };
  }
  const result = pfisIngestSource(params, requestId, {
    ignoreSourceId: previousSource.sourceId,
    ignoreParseFailed: true
  });
  if (result && result.success && result.status !== 'PARSE_FAILED') {
    pfisFinalizeSource(previousSource.rowNumber, 'SUPERSEDED',
      'Superseded after a corrected retry. Original parser error retained for audit.',
      previousSource.processingError || 'Previous parse failed; corrected retry completed.');
    pfisAppendChangeOnce('parsefailed-retry:' + previousSource.sourceId + ':' + requestId, {
      transactionId: result.transactionId || '', targetTable: PFIS_SHEETS.sources,
      actor: 'system_recovery', field: 'Parse Status', oldValue: 'PARSE_FAILED', newValue: 'SUPERSEDED',
      reason: 'Valid txnString received for the same original alert; retry was recorded separately.', requestId: requestId
    });
  }
  return result;
}

/** Re-records a valid source if a final Source Log row no longer has its txn. */
function pfisRetryOrphanedSource(previousSource, params, requestId) {
  const result = pfisIngestSource(params, requestId, {
    ignoreSourceId: previousSource.sourceId,
    ignoreParseFailed: true,
    ignoreOrphaned: true
  });
  if (result && result.success && result.status !== 'PARSE_FAILED') {
    pfisFinalizeSource(previousSource.rowNumber, 'SUPERSEDED',
      'Superseded because its transaction link was missing; source was safely re-recorded.',
      previousSource.processingError || 'Missing linked transaction.');
    pfisAppendChangeOnce('orphan-source-retry:' + previousSource.sourceId + ':' + requestId, {
      transactionId: result.transactionId || '', targetTable: PFIS_SHEETS.sources,
      actor: 'system_recovery', field: 'Parse Status', oldValue: previousSource.parseStatus,
      newValue: 'SUPERSEDED', reason: 'Re-recorded source because previous link had no transaction row.', requestId: requestId
    });
  }
  return result;
}

/**
 * Repair a final CONFLICT source written by a legacy engine that linked the
 * source to an existing candidate but never created a transaction row for the
 * incoming event. A valid txnString lets the current engine complete that missing record.
 */
function pfisRecoverLegacyConflictSource(source, params, requestId) {
  const txnString = pfisString(params.txnString);
  const parsed = pfisParseTxnString(txnString);
  if (!parsed) {
    return {
      success: false, status: 'CONFLICT_NEEDS_RECOVERY', error: 'INVALID_TXN_STRING',
      message: 'This conflict source has no independent transaction row yet. Supply a valid 10-field txnString to record it.',
      sourceId: source.sourceId, transactionId: null, requestId: requestId
    };
  }

  parsed.rawEvidence = String(source.rawBody || params.originalText || '');
  parsed.accountIdentifier = pfisExtractAccountIdentifier(parsed.rawEvidence);
  const meta = pfisParseProcessingMeta(source.notes);
  const candidates = pfisUnique((meta.candidateTransactionIds || []).concat(
    source.linkedTxnId ? [source.linkedTxnId] : []));
  const transactionId = pfisString(meta.newTransactionId) || pfisGenerateTransactionId(parsed.datetime);
  meta.phase = 'CONFLICT';
  meta.reason = pfisString(meta.reason || source.processingError) || 'legacy_source_conflict';
  meta.candidateTransactionIds = candidates.filter(function (id) { return id !== transactionId; });
  meta.newTransactionId = transactionId;

  // Persist the reserved transaction ID before writing the ledger row. If Apps
  // Script terminates now, the next retry can finish this exact write safely.
  const sourceSheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
  sourceSheet.getRange(source.rowNumber, 16).setValue(transactionId);
  sourceSheet.getRange(source.rowNumber, 20).setValue(JSON.stringify(meta));
  pfisInvalidateSourceCache();

  if (pfisFindTransactionRow(transactionId) < 2) {
    const rules = pfisEvaluateRules(parsed, parsed.rawEvidence);
    const config = pfisResolveConfig(parsed, parsed.rawEvidence);
    const transaction = pfisBuildTransaction(parsed, params, source.sourceType, transactionId,
      source.sourceId, source.sourceHash, rules, config, 'source_conflict', null);
    pfisAppendTransaction(transaction, 'Recovered legacy conflict from source ' + source.sourceId);
    pfisAppendChangeOnce('transaction-created:' + transactionId, {
      transactionId: transactionId, targetTable: PFIS_SHEETS.transactions, actor: 'system_recovery',
      field: 'Created', oldValue: '', newValue: transactionId,
      reason: 'Upgraded legacy conflict source so its incoming financial event has an independent ledger row.',
      requestId: requestId
    });
  }

  pfisFlagTransactionsForReview(meta.candidateTransactionIds, 'source_conflict', 'SOURCE_CONFLICT',
    requestId, source.sourceId, meta.reason);
  pfisAppendChangeOnce('legacy-conflict-upgraded:' + source.sourceId + ':' + transactionId, {
    transactionId: transactionId, targetTable: PFIS_SHEETS.sources, actor: 'system_recovery',
    field: 'Linked Txn ID', oldValue: source.linkedTxnId || '', newValue: transactionId,
    reason: 'Legacy conflict evidence now has its own Transaction Log row.', requestId: requestId
  });
  pfisInvalidateSourceCache();

  const response = pfisBuildIngestResponse(pfisGetTransaction(transactionId, false), requestId,
    source.sourceType, 'CONFLICT', source.sourceId);
  response.recorded = true;
  response.conflictingTransactionIds = meta.candidateTransactionIds;
  response.reason = meta.reason;
  response.message = 'Legacy conflicting source was preserved as its own transaction and flagged for review.';
  return response;
}

function pfisStoreParseFailure(sourceType, evidenceText, params, requestId, message, options) {
  const opts = options || {};
  const ignoredNonFinancial = pfisIsClearlyNonFinancialAlert(evidenceText);
  const sourceHash = pfisComputeSourceHash(sourceType, evidenceText);
  const prior = pfisFindSourceByHash(sourceHash, sourceType, opts.ignoreSourceId || '');
  if (prior && PFIS_FINAL_SOURCE_STATUSES.indexOf(prior.parseStatus) >= 0) return pfisReplayResponse(prior, requestId);
  if (prior && PFIS_PROCESSING_SOURCE_STATUSES.indexOf(prior.parseStatus) >= 0) {
    return {
      success: false, status: 'PROCESSING_RECOVERY_REQUIRED', error: 'INVALID_RETRY_PAYLOAD',
      message: 'This source already has a pending write. Resubmit its valid 10-field txnString; no second source row was created.',
      sourceId: prior.sourceId, transactionId: prior.linkedTxnId || null, requestId: requestId
    };
  }
  const rowNumber = pfisAppendSourceRow({
    sourceId: pfisMakeId('SRC-'), receivedAt: new Date(), sourceType: sourceType,
    sender: pfisString(params.sender), subject: pfisString(params.subject), rawBody: evidenceText,
    sourceHash: sourceHash, parserVersion: PARSER_VERSION, parseStatus: ignoredNonFinancial ? 'NON_FINANCIAL_IGNORED' : 'PARSE_FAILED',
    extractedAmount: '', extractedDate: '', datePrecision: '', accountIdentifier: pfisExtractAccountIdentifier(evidenceText),
    extractedMerchant: '', extractedReferenceNo: '', linkedTxnId: '', ingestedAt: new Date(),
    processingError: ignoredNonFinancial ? '' : message, archivedFlag: false,
    notes: ignoredNonFinancial ? 'Non-financial OTP/verification alert; no ledger transaction was created.' : 'Parser output could not be validated.',
    requestId: requestId, batchId: pfisString(params.batchId)
  });
  if (ignoredNonFinancial) {
    return {
      success: true, status: 'NON_FINANCIAL_IGNORED', recorded: false, transactionId: null,
      message: 'A clear OTP/verification-only alert was logged as non-financial; no ledger row was created.',
      sourceId: pfisGetSourceIdAtRow(rowNumber), requestId: requestId
    };
  }
  return {
    success: false, status: 'PARSE_FAILED', error: 'PARSE_FAILED', message: message,
    sourceId: pfisGetSourceIdAtRow(rowNumber), requestId: requestId
  };
}

function pfisIsClearlyNonFinancialAlert(evidenceText) {
  const text = pfisSanitizeRawText(evidenceText, false);
  if (!text.trim()) return false;
  const hasOtpSignal = /\bOTP\b|one[- ]time password|verification code|login code|authentication code/i.test(text);
  if (!hasOtpSignal) return false;
  // Financial verbs or a signed money amount override the OTP signal. This keeps
  // a payment alert that contains security boilerplate from being ignored.
  const hasFinancialSignal = /\b(?:debited|credited|spent|purchase|paid|payment|transferred|withdrawn|cash withdrawal|received|refund)\b/i.test(text) ||
    /(?:₹|INR|Rs\.?\s*)\s*\d[\d,]*(?:\.\d{1,2})?/i.test(text);
  return !hasFinancialSignal;
}

function pfisRecoverProcessingSource(source, txnString, params, requestId) {
  const parsed = pfisParseTxnString(txnString);
  if (!parsed) {
    return {
      success: false, status: 'PROCESSING_RECOVERY_REQUIRED', error: 'PARSE_FAILED',
      message: 'The source is in a recoverable processing state, but the submitted 10-field txnString is invalid.',
      sourceId: source.sourceId, transactionId: source.linkedTxnId, requestId: requestId
    };
  }
  parsed.rawEvidence = String(source.rawBody || params.originalText || '');
  parsed.accountIdentifier = pfisExtractAccountIdentifier(parsed.rawEvidence);
  const recoveryMeta = pfisParseProcessingMeta(source.notes);
  if (recoveryMeta.phase === 'DUPLICATE_SUPPRESSED') {
    const originalTransactionId = pfisString(recoveryMeta.duplicateCandidateId || source.linkedTxnId);
    return pfisCompleteSuppressedSameChannelDuplicate({
      sourceId: source.sourceId, rowNumber: source.rowNumber, sourceType: source.sourceType,
      transactionId: originalTransactionId
    }, requestId, 'Recovered interrupted same-channel duplicate suppression.');
  }
  if (source.parseStatus === 'PROCESSING_RECONCILE') {
    if (pfisFindTransactionRow(source.linkedTxnId) < 2) {
      return { success: false, error: 'RECOVERY_INTEGRITY_ERROR', message: 'A processing reconciliation points to a missing transaction.', sourceId: source.sourceId, requestId: requestId };
    }
    const reconcileRules = pfisEvaluateRules(parsed, source.rawBody || '');
    const reconcileConfig = pfisResolveConfig(parsed, source.rawBody || '');
    pfisEnrichBlankTransactionFields(source.linkedTxnId, parsed, reconcileRules, reconcileConfig, requestId);
    pfisAppendChangeOnce('source-reconciled:' + source.sourceId, {
      transactionId: source.linkedTxnId, targetTable: PFIS_SHEETS.sources, actor: 'system_recovery',
      field: 'Linked Txn ID', oldValue: '', newValue: source.linkedTxnId,
      reason: 'Completed interrupted cross-channel reconciliation.', requestId: requestId
    });
    pfisAppendChangeOnce('verification-updated:' + source.sourceId, {
      transactionId: source.linkedTxnId, targetTable: PFIS_SHEETS.transactions, actor: 'system_recovery',
      field: 'Verification', oldValue: '', newValue: 'VERIFIED', reason: 'Recovered interrupted reconciliation.', requestId: requestId
    });
    pfisFinalizeSource(source.rowNumber, 'RECONCILED', 'Recovered interrupted cross-channel reconciliation.', '');
    return pfisBuildIngestResponse(pfisGetTransaction(source.linkedTxnId, false), requestId, source.sourceType, 'RECONCILED', source.sourceId);
  }
  if (source.parseStatus === 'PROCESSING_CONFLICT') {
    const meta = pfisParseProcessingMeta(source.notes);
    const candidates = meta.candidateTransactionIds || [];
    let conflictTxnId = pfisString(meta.newTransactionId);
    if (!conflictTxnId) {
      // Upgrade a legacy PROCESSING_CONFLICT row from an earlier engine: older code
      // linked it to an existing candidate instead of reserving its own ID.
      // Reserve a fresh ID and persist the link before trying the transaction write.
      conflictTxnId = pfisGenerateTransactionId(parsed.datetime);
      meta.newTransactionId = conflictTxnId;
      const sourceSheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
      sourceSheet.getRange(source.rowNumber, 16).setValue(conflictTxnId);
      sourceSheet.getRange(source.rowNumber, 20).setValue(JSON.stringify(meta));
      pfisInvalidateSourceCache();
    }

    // The source is appended before the transaction. If execution stopped in
    // between, finish the transaction write on retry instead of losing the event.
    if (conflictTxnId && pfisFindTransactionRow(conflictTxnId) < 2) {
      const ruleResult = pfisEvaluateRules(parsed, source.rawBody || '');
      const configResult = pfisResolveConfig(parsed, source.rawBody || '');
      const transaction = pfisBuildTransaction(parsed, { sender: source.sender, subject: source.subject },
        source.sourceType, conflictTxnId, source.sourceId, source.sourceHash,
        ruleResult, configResult, 'source_conflict', null);
      pfisAppendTransaction(transaction, 'Recovered interrupted conflict source ' + source.sourceId);
      pfisAppendChangeOnce('transaction-created:' + conflictTxnId, {
        transactionId: conflictTxnId, targetTable: PFIS_SHEETS.transactions, actor: 'system_recovery',
        field: 'Created', oldValue: '', newValue: conflictTxnId,
        reason: 'Recovered interrupted write for a conflicting incoming source.', requestId: requestId
      });
    }

    pfisFlagTransactionsForReview(candidates, 'source_conflict', 'SOURCE_CONFLICT', requestId, source.sourceId, meta.reason || 'recovered_conflict');
    pfisFinalizeSource(source.rowNumber, 'CONFLICT', 'Recovered conflict; incoming event preserved.', meta.reason || 'source_conflict');
    const recovered = pfisGetTransaction(conflictTxnId, false);
    if (recovered) {
      const response = pfisBuildIngestResponse(recovered, requestId, source.sourceType, 'CONFLICT', source.sourceId);
      response.recorded = true;
      response.conflictingTransactionIds = candidates;
      return response;
    }
    // Legacy processing rows created by an older engine may reference only an
    // existing candidate. Preserve the evidence and report the legacy state.
    return {
      success: true, status: 'CONFLICT', sourceId: source.sourceId, transactionId: source.linkedTxnId || null,
      conflictingTransactionIds: candidates, reason: meta.reason || 'source_conflict', requestId: requestId, recorded: false
    };
  }

  const meta = pfisParseProcessingMeta(source.notes);
  const transactionId = pfisString(source.linkedTxnId);
  const currentRow = pfisFindTransactionRow(transactionId);
  if (currentRow >= 2) {
    const transaction = pfisGetTransaction(transactionId, false);
    const finalStatus = transaction.validationFlag === 'DUPLICATE_CANDIDATE' ? 'DUPLICATE_CANDIDATE' : 'ACCEPTED';
    pfisFinalizeSource(source.rowNumber, finalStatus, 'Recovered interrupted transaction insert.', '');
    return pfisBuildIngestResponse(pfisGetTransaction(transactionId, false), requestId, source.sourceType, 'RECOVERED_WRITE', source.sourceId);
  }
  const ruleResult = pfisEvaluateRules(parsed, '');
  const configResult = pfisResolveConfig(parsed, parsed.rawEvidence);
  const canonicalMerchant = pfisCleanText(ruleResult.merchantOverride || parsed.merchant);
  const duplicate = source.parseStatus === 'PROCESSING_DUPLICATE'
    ? { transactionId: meta.duplicateCandidateId, reason: 'same_amount_bank_account_merchant_within_5m' } : null;
  const reviewReason = duplicate ? 'duplicate_candidate' : (meta.reviewReason || '');
  const transaction = pfisBuildTransaction(parsed, params, source.sourceType, transactionId, source.sourceId,
    source.sourceHash, ruleResult, configResult, reviewReason, duplicate);
  pfisAppendTransaction(transaction, 'Recovered interrupted insert from source ' + source.sourceId);
  pfisAppendChangeOnce('transaction-created:' + transactionId, {
    transactionId: transactionId, targetTable: PFIS_SHEETS.transactions, actor: 'system_recovery', field: 'Created',
    oldValue: '', newValue: transactionId, reason: 'Recovered interrupted source insert.', requestId: requestId
  });
  const finalStatus = duplicate ? 'DUPLICATE_CANDIDATE' : 'ACCEPTED';
  pfisFinalizeSource(source.rowNumber, finalStatus, 'Recovered interrupted transaction insert.', '');
  return pfisBuildIngestResponse(pfisGetTransaction(transactionId, false), requestId, source.sourceType, 'RECOVERED_WRITE', source.sourceId);
}

// -----------------------------------------------------------------------------
// Deterministic matching
// -----------------------------------------------------------------------------

function pfisFindCrossChannelMatch(incoming, sourceType, merchant) {
  const otherType = sourceType === 'SMS' ? 'EMAIL' : 'SMS';
  const txRows = pfisReadTransactions();
  const sourceIndex = pfisBuildSourceIndex();
  const exactMatches = [];
  const conflictMatches = [];
  const datePrecisionCandidates = [];

  txRows.forEach(function (existing) {
    const sources = sourceIndex[existing.transactionId] || [];
    const existingTypes = pfisUnique(sources.map(function (s) { return s.sourceType; }));
    if (existingTypes.indexOf(otherType) < 0 || existingTypes.indexOf(sourceType) >= 0) return;

    const otherSources = sources.filter(function (s) { return s.sourceType === otherType; });
    otherSources.forEach(function (source) {
      const assessment = pfisAssessCrossCandidate(existing, source, incoming, merchant);
      if (assessment.kind === 'MATCH') exactMatches.push({ transactionId: existing.transactionId, reason: assessment.reason, source: source });
      else if (assessment.kind === 'CONFLICT') conflictMatches.push({ transactionId: existing.transactionId, reason: assessment.reason });
      else if (assessment.kind === 'TIME_PRECISION') datePrecisionCandidates.push(existing.transactionId);
    });
  });

  const uniqueMatches = pfisUniqueBy(exactMatches, 'transactionId');
  const uniqueConflicts = pfisUniqueBy(conflictMatches, 'transactionId');
  // Any material contradiction wins over an otherwise plausible match. Do not
  // link to one candidate while another candidate exposes conflicting evidence.
  if (uniqueConflicts.length) {
    const candidates = pfisUnique(uniqueConflicts.map(function (x) { return x.transactionId; })
      .concat(uniqueMatches.map(function (x) { return x.transactionId; })));
    return { status: 'CONFLICT', reason: uniqueConflicts[0].reason, candidateTransactionIds: candidates };
  }
  if (uniqueMatches.length > 1) {
    return { status: 'CONFLICT', reason: 'ambiguous_cross_channel_match', candidateTransactionIds: uniqueMatches.map(function (x) { return x.transactionId; }) };
  }
  if (uniqueMatches.length === 1) return { status: 'MATCHED', transactionId: uniqueMatches[0].transactionId, reason: uniqueMatches[0].reason };
  const timeCandidates = pfisUnique(datePrecisionCandidates);
  if (timeCandidates.length > 1) {
    return { status: 'CONFLICT', reason: 'ambiguous_time_precision_match', candidateTransactionIds: timeCandidates };
  }
  return { status: 'NO_MATCH', timePrecisionCandidate: timeCandidates.length === 1, timePrecisionCandidateIds: timeCandidates };
}

/**
 * Card payment notifications may come from the wallet/payment rail and from the
 * issuer. Treat them as corroborating evidence for one settlement only when
 * amount, IST calendar date and issuer agree, and the match is unique.
 */
function pfisFindCardPaymentEventMatch(incoming, rawEvidence) {
  if (pfisNormalizeType(incoming.resolvedType || incoming.type) !== 'card_payment') {
    return { status: 'NO_MATCH' };
  }
  const incomingIssuer = pfisGetPaymentIssuerKey(rawEvidence, incoming.bank, incoming.merchant, incoming.cardName);
  if (!incomingIssuer) return { status: 'NO_MATCH' };
  const txRows = pfisReadTransactions();
  const sourceIndex = pfisBuildSourceIndex();
  const candidates = [];
  txRows.forEach(function (existing) {
    if (pfisNormalizeType(existing.type) !== 'card_payment') return;
    if (!pfisSameMoney(existing.amount, incoming.amount)) return;
    if (!pfisSameCalendarDay(existing.dateTime, incoming.datetime)) return;
    const linkedSources = sourceIndex[existing.transactionId] || [];
    const existingEvidence = linkedSources.map(function (s) { return s.rawBody || ''; }).join('\n');
    const existingIssuer = pfisGetPaymentIssuerKey(existingEvidence, existing.bank, existing.merchant, existing.cardName);
    if (existingIssuer !== incomingIssuer) return;
    const accountA = pfisString(existing.account).toLowerCase();
    const accountB = pfisString(incoming.account).toLowerCase();
    const bothCreditCardAccounts = pfisNormalizeAccountType(existing.accountType) === 'creditcard' &&
      pfisNormalizeAccountType(incoming.accountType) === 'creditcard';
    // References from the wallet/payment rail and issuer are different namespaces.
    // Compare only when both records are explicit issuer-card account notifications.
    const existingRef = pfisNormalizeReference(existing.refNo);
    const incomingRef = pfisNormalizeReference(incoming.refNo);
    if (bothCreditCardAccounts && existingRef && incomingRef && existingRef !== incomingRef) return;
    if (bothCreditCardAccounts && accountA && accountB && accountA !== accountB) return;
    if (bothCreditCardAccounts && existing.cardName && incoming.cardName &&
        pfisNormalizeMerchant(existing.cardName) !== pfisNormalizeMerchant(incoming.cardName)) return;
    candidates.push({ transactionId: existing.transactionId, reason: 'same_card_payment_issuer_amount_day' });
  });
  const unique = pfisUniqueBy(candidates, 'transactionId');
  if (unique.length === 1) {
    return { status: 'MATCHED', transactionId: unique[0].transactionId, reason: unique[0].reason };
  }
  if (unique.length > 1) {
    return { status: 'CONFLICT', reason: 'ambiguous_card_payment_event_match',
      candidateTransactionIds: unique.map(function (x) { return x.transactionId; }) };
  }
  return { status: 'NO_MATCH' };
}

function pfisGetPaymentIssuerKey(rawEvidence, bank, merchant, cardName) {
  const haystack = pfisNormalizeMerchant([rawEvidence, bank, merchant, cardName].filter(Boolean).join(' '));
  if (!haystack) return '';
  if (haystack.indexOf('state bank of india') >= 0 || /\bsbi\b/.test(haystack) || haystack.indexOf('sbicard') >= 0) return 'sbi';
  if (haystack.indexOf('icici') >= 0) return 'icici';
  if (haystack.indexOf('axis') >= 0) return 'axis';
  if (haystack.indexOf('hdfc') >= 0) return 'hdfc';
  if (haystack.indexOf('kotak') >= 0) return 'kotak';
  if (haystack.indexOf('yes bank') >= 0) return 'yesbank';
  return '';
}

function pfisLinkPaymentEventSource(match, parsed, evidenceText, params, requestId, sourceType, sourceHash, ruleResult, configResult) {
  const sourceId = pfisMakeId('SRC-');
  const transactionId = pfisString(match.transactionId);
  const sourceRowNumber = pfisAppendSourceRow({
    sourceId: sourceId, receivedAt: new Date(), sourceType: sourceType,
    sender: pfisString(params.sender), subject: pfisString(params.subject), rawBody: evidenceText,
    sourceHash: sourceHash, parserVersion: PARSER_VERSION, parseStatus: 'PROCESSING_RECONCILE',
    extractedAmount: parsed.amount, extractedDate: parsed.datetime, datePrecision: parsed.datePrecision,
    accountIdentifier: parsed.accountIdentifier, extractedMerchant: parsed.merchant,
    extractedReferenceNo: parsed.refNo, linkedTxnId: transactionId, ingestedAt: new Date(),
    processingError: '', archivedFlag: false,
    notes: JSON.stringify({ phase: 'PAYMENT_EVENT_RECONCILE', reason: match.reason, transactionId: transactionId }),
    requestId: requestId, batchId: pfisString(params.batchId)
  });
  pfisEnrichBlankTransactionFields(transactionId, parsed, ruleResult, configResult, requestId);
  pfisAppendChangeOnce('payment-event-source-linked:' + sourceId, {
    transactionId: transactionId, targetTable: PFIS_SHEETS.sources, actor: 'system_payment_event',
    field: 'Payment Event Evidence Linked', oldValue: '', newValue: transactionId,
    reason: 'Matching card-payment issuer, amount and calendar date linked this notification to the existing canonical settlement.', requestId: requestId
  });
  pfisFinalizeSource(sourceRowNumber, 'RECONCILED',
    'Linked as supporting evidence for the same card-payment event: ' + match.reason, '');
  const transaction = pfisGetTransaction(transactionId, false);
  const response = pfisBuildIngestResponse(transaction, requestId, sourceType, 'RECONCILED', sourceId);
  response.transactionInserted = false;
  response.sourceRecorded = true;
  response.paymentEventLinked = true;
  response.duplicateOf = transactionId;
  response.message = 'This notification was linked to an existing card-payment event. No second ledger transaction was inserted.';
  return response;
}

function pfisAssessCrossCandidate(existing, existingSource, incoming, incomingMerchant) {
  const sameBank = pfisNormalizeBank(existing.bank) === pfisNormalizeBank(incoming.bank);
  if (!sameBank) return { kind: 'NO_MATCH' };

  const existingMerchant = pfisNormalizeMerchant(existing.merchant);
  const incomingMerchantKey = pfisNormalizeMerchant(incomingMerchant);
  const merchantUsable = pfisIsMatchableMerchant(existingMerchant) && pfisIsMatchableMerchant(incomingMerchantKey);
  const sameMerchant = merchantUsable && existingMerchant === incomingMerchantKey;
  const sameAmount = pfisSameMoney(existing.amount, incoming.amount);
  const existingRef = pfisNormalizeReference(existing.refNo);
  const incomingRef = pfisNormalizeReference(incoming.refNo);
  const sameRef = !!existingRef && existingRef === incomingRef;
  const sameDay = pfisSameCalendarDay(existingSource.extractedDate, incoming.datetime);
  const hasTime = pfisIsPrecision(existingSource.datePrecision) && pfisIsPrecision(incoming.datePrecision);
  const existingDate = pfisParseDateValue(existingSource.extractedDate);
  const incomingDate = pfisParseDateValue(incoming.datetime);
  const withinFive = hasTime && !!existingDate && !!incomingDate &&
    Math.abs(existingDate.getTime() - incomingDate.getTime()) <= PFIS_MATCH_WINDOW_MS;
  const otherwiseSameCore = sameAmount && sameMerchant;
  const existingId = pfisNormalizeAccountIdentifier(existingSource.accountIdentifier);
  const incomingId = pfisNormalizeAccountIdentifier(incoming.accountIdentifier);
  const accountConflict = !!existingId && !!incomingId && existingId !== incomingId;
  const existingType = pfisNormalizeAccountType(existing.accountType);
  const incomingType = pfisNormalizeAccountType(incoming.accountType);
  const accountTypeConflict = !!existingType && !!incomingType && existingType !== incomingType;
  const sameResolvedAccount = !!pfisString(existing.account) && !!pfisString(incoming.account) &&
    pfisString(existing.account).toLowerCase() === pfisString(incoming.account).toLowerCase();

  // Bank emails often replace a real merchant with "Unspecified". Only accept
  // that missing-merchant cross-channel pair when the canonical bank, amount,
  // resolved account and exact source clock time all agree.
  if (sameAmount && sameDay && sameResolvedAccount && hasTime && !!existingDate && !!incomingDate &&
      existingDate.getTime() === incomingDate.getTime() &&
      (!pfisIsMatchableMerchant(existingMerchant) || !pfisIsMatchableMerchant(incomingMerchantKey)) &&
      !accountConflict && !accountTypeConflict) {
    return { kind: 'MATCH', reason: 'exact_time_amount_bank_resolved_account_generic_merchant' };
  }

  // A same-bank, same-day, same-reference, same-amount pair is a strong
  // cross-channel identity even when the email gateway is delayed by more than
  // five minutes or the merchant string differs between SMS and email. Explicit
  // account/account-type contradictions still block auto-linking.
  if (sameRef && sameDay) {
    if (!sameAmount || accountConflict || accountTypeConflict) {
      return {
        kind: 'CONFLICT', reason: !sameAmount ? 'same_reference_amount_conflict' :
          (accountConflict ? 'account_identifier_conflict' : 'account_type_conflict')
      };
    }
    return { kind: 'MATCH', reason: 'exact_reference_amount_bank_day' };
  }

  if (otherwiseSameCore && withinFive && (accountConflict || accountTypeConflict)) {
    return { kind: 'CONFLICT', reason: accountConflict ? 'account_identifier_conflict' : 'account_type_conflict' };
  }
  if (otherwiseSameCore && (!hasTime || !pfisIsPrecision(existingSource.datePrecision) || !pfisIsPrecision(incoming.datePrecision))) {
    if (sameDay) return { kind: 'TIME_PRECISION' };
    return { kind: 'NO_MATCH' };
  }
  if (!otherwiseSameCore || !withinFive) return { kind: 'NO_MATCH' };
  if (accountConflict) return { kind: 'CONFLICT', reason: 'account_identifier_conflict' };
  if (accountTypeConflict) return { kind: 'CONFLICT', reason: 'account_type_conflict' };
  return { kind: 'MATCH', reason: 'exact_core_match_within_5m' };
}

function pfisFindSameChannelDuplicate(incoming, sourceType, merchant) {
  const sourceIndex = pfisBuildSourceIndex();
  const candidates = [];
  const incomingReference = pfisNormalizeReference(incoming.refNo);
  const incomingDatetime = incoming.datetime instanceof Date ? incoming.datetime : pfisParseDateValue(incoming.datetime);

  pfisReadTransactions().forEach(function (existing) {
    // A previously flagged duplicate is not a canonical anchor. Comparing new
    // messages against it would create a chain of duplicate rows on every replay.
    if (pfisString(existing.validationFlag).toUpperCase() === 'DUPLICATE_CANDIDATE') return;

    const sources = sourceIndex[existing.transactionId] || [];
    const relevantSources = sources.filter(function (source) { return source.sourceType === sourceType; });
    if (!relevantSources.length) return;

    const sameAmount = pfisSameMoney(existing.amount, incoming.amount);
    const sameBank = pfisNormalizeBank(existing.bank) === pfisNormalizeBank(incoming.bank);
    const existingMerchant = pfisNormalizeMerchant(existing.merchant);
    const incomingMerchantKey = pfisNormalizeMerchant(merchant);
    const sameMerchant = pfisIsMatchableMerchant(existingMerchant) &&
      pfisIsMatchableMerchant(incomingMerchantKey) && existingMerchant === incomingMerchantKey;
    if (!sameAmount || !sameBank || !sameMerchant) return;

    const accountTypeA = pfisNormalizeAccountType(existing.accountType);
    const accountTypeB = pfisNormalizeAccountType(incoming.accountType);
    if (accountTypeA && accountTypeB && accountTypeA !== accountTypeB) return;

    const incomingId = pfisNormalizeAccountIdentifier(incoming.accountIdentifier);
    const accountCompatible = relevantSources.some(function (source) {
      const existingId = pfisNormalizeAccountIdentifier(source.accountIdentifier);
      return !(existingId && incomingId && existingId !== incomingId);
    });
    if (!accountCompatible) return;

    // If both transaction references are present, they must agree. A different
    // UTR/reference is evidence of a distinct event even when other fields match.
    const existingReference = pfisNormalizeReference(existing.refNo) ||
      pfisNormalizeReference(relevantSources[0].extractedReferenceNo);
    const referenceConflict = !!incomingReference && !!existingReference && incomingReference !== existingReference;

    let timeMatch = false;
    let exactDateTime = false;
    relevantSources.forEach(function (source) {
      if (!pfisIsPrecision(source.datePrecision) || !pfisIsPrecision(incoming.datePrecision) || !incomingDatetime) return;
      const existingDate = pfisParseDateValue(source.extractedDate);
      if (!existingDate) return;
      const difference = Math.abs(existingDate.getTime() - incomingDatetime.getTime());
      if (difference <= PFIS_MATCH_WINDOW_MS) timeMatch = true;
      // A conflicting reference prevents automatic suppression, but the near-time
      // similarity is still returned as a review candidate rather than ignored.
      if (difference === 0 && !referenceConflict) exactDateTime = true;
    });
    if (!timeMatch) return;

    candidates.push({
      transactionId: existing.transactionId,
      sourceId: relevantSources[0].sourceId,
      reason: exactDateTime ? 'exact_same_channel_transaction_fingerprint' :
        (referenceConflict ? 'same_channel_reference_conflict_needs_review' : 'same_amount_bank_account_merchant_within_5m'),
      exactDateTime: exactDateTime,
      referenceConflict: referenceConflict,
      referenceMatch: !!incomingReference && !!existingReference && incomingReference === existingReference
    });
  });

  if (!candidates.length) return null;
  candidates.sort(function (a, b) {
    if (a.exactDateTime !== b.exactDateTime) return a.exactDateTime ? -1 : 1;
    if (a.referenceMatch !== b.referenceMatch) return a.referenceMatch ? -1 : 1;
    return a.transactionId.localeCompare(b.transactionId);
  });

  const exactCandidates = candidates.filter(function (candidate) { return candidate.exactDateTime; });
  if (exactCandidates.length === 1) return exactCandidates[0];
  if (exactCandidates.length > 1) {
    // Never silently suppress against an ambiguous set of otherwise identical
    // canonical transactions. Return a review candidate, not an auto-suppression.
    const withReference = exactCandidates.filter(function (candidate) { return candidate.referenceMatch; });
    if (withReference.length === 1) return withReference[0];
    return Object.assign({}, exactCandidates[0], {
      exactDateTime: false,
      ambiguousExactMatch: true,
      reason: 'ambiguous_exact_same_channel_duplicate'
    });
  }
  return candidates[0];
}

/**
 * Stores the incoming evidence without appending a second canonical transaction.
 * Only called when the same-channel matcher proves exact transaction-time equality
 * along with amount, bank, merchant, and account/reference compatibility.
 */
function pfisRecordSuppressedSameChannelDuplicate(duplicate, parsed, evidenceText, params,
  requestId, sourceType, sourceHash) {
  const sourceId = pfisMakeId('SRC-');
  const transactionId = pfisString(duplicate && duplicate.transactionId);
  if (!transactionId || pfisFindTransactionRow(transactionId) < 2) {
    return {
      success: false, status: 'DUPLICATE_TARGET_MISSING', error: 'DUPLICATE_TARGET_MISSING',
      message: 'A duplicate candidate was found, but its original transaction no longer exists. No source or transaction row was written.',
      requestId: requestId
    };
  }

  const reason = 'exact_same_channel_transaction_fingerprint';
  const meta = {
    phase: 'DUPLICATE_SUPPRESSED', duplicateCandidateId: transactionId,
    reason: reason, datePrecision: parsed.datePrecision
  };
  const sourceRowNumber = pfisAppendSourceRow({
    sourceId: sourceId, receivedAt: new Date(), sourceType: sourceType,
    sender: pfisString(params.sender), subject: pfisString(params.subject), rawBody: evidenceText,
    sourceHash: sourceHash, parserVersion: PARSER_VERSION, parseStatus: 'PROCESSING_DUPLICATE',
    extractedAmount: parsed.amount, extractedDate: parsed.datetime, datePrecision: parsed.datePrecision,
    accountIdentifier: parsed.accountIdentifier, extractedMerchant: parsed.merchant,
    extractedReferenceNo: parsed.refNo, linkedTxnId: transactionId, ingestedAt: new Date(),
    processingError: '', archivedFlag: false, notes: JSON.stringify(meta),
    requestId: requestId, batchId: pfisString(params.batchId)
  });

  return pfisCompleteSuppressedSameChannelDuplicate({
    sourceId: sourceId, rowNumber: sourceRowNumber, sourceType: sourceType,
    transactionId: transactionId
  }, requestId, 'Exact same-channel duplicate detected; no new Transaction Log row inserted.');
}

function pfisCompleteSuppressedSameChannelDuplicate(sourceInfo, requestId, notes) {
  const sourceId = pfisString(sourceInfo && sourceInfo.sourceId);
  const transactionId = pfisString(sourceInfo && sourceInfo.transactionId);
  const sourceType = pfisNormalizeSourceType(sourceInfo && sourceInfo.sourceType);
  const sourceRowNumber = Number(sourceInfo && sourceInfo.rowNumber) || 0;
  if (!sourceId || !transactionId || !sourceType || sourceRowNumber < 2 || pfisFindTransactionRow(transactionId) < 2) {
    return {
      success: false, status: 'DUPLICATE_RECOVERY_REQUIRED', error: 'DUPLICATE_RECOVERY_REQUIRED',
      message: 'Duplicate source could not be finalized because its original transaction or Source Log row is missing. No new transaction was created.',
      sourceId: sourceId || null, transactionId: transactionId || null, requestId: requestId
    };
  }

  pfisAppendChangeOnce('same-channel-duplicate-suppressed:' + sourceId, {
    transactionId: transactionId, targetTable: PFIS_SHEETS.sources, actor: 'system_matching',
    field: 'Duplicate Source Suppressed', oldValue: '', newValue: transactionId,
    reason: 'Same-channel source matched exact transaction datetime, amount, bank and merchant with compatible account/reference; source linked to existing transaction without a second ledger row.',
    requestId: requestId
  });
  pfisFinalizeSource(sourceRowNumber, 'DUPLICATE_SUPPRESSED', notes || 'Exact same-channel duplicate suppressed; linked to existing transaction ' + transactionId + '.', '');

  const transaction = pfisGetTransaction(transactionId, false);
  const response = pfisBuildIngestResponse(transaction, requestId, sourceType, 'DUPLICATE_SUPPRESSED', sourceId);
  response.transactionInserted = false;
  response.sourceRecorded = true;
  response.duplicateOf = transactionId;
  response.nextAction = 'SHOW_RECEIPT';
  response.message = 'This alert matches an existing same-channel transaction at the exact transaction time with the same amount, bank and merchant. The source was retained for audit; no new Transaction Log row was inserted.';
  return response;
}

function pfisGetSourceCache() {
  if (PFIS_RUNTIME_SOURCE_CACHE) return PFIS_RUNTIME_SOURCE_CACHE;
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
  const rows = pfisReadFixedRows(sheet, PFIS_SOURCE_FIELDS.length);
  const byTransaction = {};
  const allByTransaction = {};
  const allRows = [];
  rows.forEach(function (row, i) {
    const source = pfisObjectFromRow(row, PFIS_SOURCE_FIELDS);
    source.rowNumber = i + 2;
    const txnId = pfisString(source.linkedTxnId);
    const status = pfisString(source.parseStatus).toUpperCase();
    const sourceType = pfisNormalizeSourceType(source.sourceType);
    allRows.push(source);
    if (txnId && status !== 'SUPERSEDED') {
      if (!allByTransaction[txnId]) allByTransaction[txnId] = [];
      allByTransaction[txnId].push(source);
    }
    if (!txnId || !sourceType || ['CONFLICT', 'SUPERSEDED', 'PARSE_FAILED'].indexOf(status) >= 0 || status.indexOf('PROCESSING_') === 0) return;
    if (!byTransaction[txnId]) byTransaction[txnId] = [];
    byTransaction[txnId].push({
      sourceId: source.sourceId, sourceType: sourceType, parseStatus: status,
      extractedDate: source.extractedDate, datePrecision: pfisString(source.datePrecision).toUpperCase(),
      accountIdentifier: source.accountIdentifier, rowNumber: i + 2, sourceHash: source.sourceHash,
      rawBody: source.rawBody, notes: source.notes, extractedAmount: source.extractedAmount,
      extractedMerchant: source.extractedMerchant, extractedReferenceNo: source.extractedReferenceNo
    });
  });
  PFIS_RUNTIME_SOURCE_CACHE = { byTransaction: byTransaction, allByTransaction: allByTransaction, allRows: allRows };
  return PFIS_RUNTIME_SOURCE_CACHE;
}

function pfisBuildSourceIndex() {
  return pfisGetSourceCache().byTransaction;
}

function pfisInvalidateSourceCache() {
  PFIS_RUNTIME_SOURCE_CACHE = null;
}

// -----------------------------------------------------------------------------
// Source/transaction writes and interrupted-write recovery
// -----------------------------------------------------------------------------

function pfisAppendTransaction(transaction, auditSummary) {
  // Potential duplicates stay in the live ledger and review queue. Only an
  // explicit human CONFIRM_DUPLICATE decision may send a row to the archive.
  let isDuplicate = transaction && (
    transaction.validationFlag === 'DUPLICATE_REJECTED' ||
    transaction.reviewStatus === 'Rejected - Duplicate'
  );

  const txSheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);

  // Exact source replay is handled by Source Log hash idempotency and event matching.
  // A hash, a generated canonical key, or a shared reference number by itself is
  // not enough evidence to auto-reject a financial transaction.

  // Route to 'Rejected & Archive Log' if duplicate, otherwise 'Transaction Log'
  const targetSheet = isDuplicate
    ? pfisGetSpreadsheet().getSheetByName(PFIS_SHEETS.archive)
    : txSheet;

  if (!targetSheet) {
    throw pfisError('SCHEMA_INVALID', 'Target sheet not found for transaction commit.');
  }

  if (isDuplicate) {
    transaction.needsReview = false;
    transaction.reviewStatus = 'Rejected - Duplicate';
    transaction.validationFlag = 'DUPLICATE_REJECTED';
    transaction.reviewReason = 'Explicitly confirmed duplicate before archive append';
    transaction.reviewedBy = 'SYSTEM_DEDUPLICATION';
    transaction.reviewedAt = new Date();
  }

  const row = pfisRowFromObject(transaction, PFIS_TX_FIELDS);
  const targetRow = pfisGetNextAvailableRow(targetSheet, 1);
  targetSheet.getRange(targetRow, 1, 1, PFIS_TX_FIELDS.length).setValues([row]);

  if (!isDuplicate) {
    pfisInvalidateTransactionCache();
  }

  const summaryText = auditSummary || (isDuplicate
    ? ('Auto-archived duplicate ' + pfisString(transaction.transactionId))
    : ('Created transaction ' + pfisString(transaction.transactionId)));

  pfisWriteLegacyTransactionAux(targetRow, transaction, summaryText, targetSheet);
  pfisWriteOptionalBudgetPeriods(targetRow, transaction, targetSheet);
  return targetRow;
}

/**
 * Optional derived period columns are header-driven for backward compatibility.
 * Income Month = actual transaction month. Budget Month = transaction month plus
 * the explicitly configured Rules!W offset; there is no day-of-month heuristic.
 */
function pfisWriteOptionalBudgetPeriods(rowNumber, transaction, targetSheet) {
  const sheet = targetSheet || pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) return;
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(pfisHeaderToken);
  const date = pfisParseDateValue(transaction && transaction.dateTime);
  if (!date) return;
  const year = Number(Utilities.formatDate(date, PFIS_TIME_ZONE, 'yyyy'));
  const month = Number(Utilities.formatDate(date, PFIS_TIME_ZONE, 'M'));
  const budgetOffset = isFinite(Number(transaction.budgetMonthOffset)) ? Math.trunc(Number(transaction.budgetMonthOffset)) : 0;
  function monthStart(offset) {
    const index = year * 12 + (month - 1) + offset;
    const y = Math.floor(index / 12);
    const m = index - y * 12 + 1;
    return pfisCreateIndiaDate(y, m, 1, 12, 0, 0);
  }
  const incomeMonthCol = headers.indexOf('incomemonth') + 1;
  const budgetMonthCol = headers.indexOf('budgetmonth') + 1;
  if (incomeMonthCol > 0) sheet.getRange(rowNumber, incomeMonthCol).setValue(monthStart(0));
  if (budgetMonthCol > 0) sheet.getRange(rowNumber, budgetMonthCol).setValue(monthStart(budgetOffset));
}

function pfisAppendSourceRow(source) {
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
  const row = pfisRowFromObject(source, PFIS_SOURCE_FIELDS);
  const target = pfisGetNextAvailableRow(sheet, 1);
  sheet.getRange(target, 1, 1, PFIS_SOURCE_FIELDS.length).setValues([row]);
  pfisInvalidateSourceCache();
  return target;
}

function pfisFinalizeSource(rowNumber, status, notes, processingError) {
  return pfisPerfMeasure('source_finalize_write', function () {
    const sheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
    // Ingested At is the original append timestamp and must not be overwritten
    // when processing finishes or recovers. Parse Status is the state transition.
    sheet.getRange(rowNumber, 9).setValue(status);
    sheet.getRange(rowNumber, 18).setValue(processingError || '');
    sheet.getRange(rowNumber, 20).setValue(notes || '');
    pfisInvalidateSourceCache();
  });
}

function pfisAppendChangeOnce(eventKey, change) {
  return pfisPerfMeasure('audit_write', function () { return pfisAppendChangeOnceInternal(eventKey, change); });
}

function pfisAppendChangeOnceInternal(eventKey, change) {
  const changeId = 'CHG-' + pfisComputeHash(eventKey).substring(0, 16);
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.changes);
  const existing = pfisFindRowByValue(sheet, 1, changeId);
  if (existing >= 2) return existing;
  const record = Object.assign({
    changeId: changeId, changedAt: new Date(), targetTable: PFIS_SHEETS.transactions,
    actor: 'system', field: '', oldValue: '', newValue: '', reason: '', requestId: ''
  }, change || {});
  record.changeId = changeId;
  const target = pfisGetNextAvailableRow(sheet, 1);
  sheet.getRange(target, 1, 1, PFIS_CHANGE_FIELDS.length).setValues([pfisRowFromObject(record, PFIS_CHANGE_FIELDS)]);
  return target;
}


/**
 * Batched idempotent Change Log writer. Pass [{eventKey, change}, ...]. Existing
 * deterministic Change IDs are skipped. Missing records are written with one
 * setValues call into a verified contiguous blank block.
 */
function pfisAppendChangeOnceBatch(events) {
  if (!Array.isArray(events) || !events.length) return [];
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.changes);
  const existingKeys = Object.create(null);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function (row) {
      const value = pfisString(row[0]);
      if (value) existingKeys[value] = true;
    });
  }
  const pending = [];
  const seen = Object.create(null);
  events.forEach(function (event) {
    if (!event || !pfisString(event.eventKey)) throw pfisError('BAD_AUDIT_EVENT', 'Each batched Change Log item requires eventKey.');
    const changeId = 'CHG-' + pfisComputeHash(event.eventKey).substring(0, 16);
    if (existingKeys[changeId] || seen[changeId]) return;
    seen[changeId] = true;
    const record = Object.assign({
      changeId: changeId, changedAt: new Date(), targetTable: PFIS_SHEETS.transactions,
      actor: 'system', field: '', oldValue: '', newValue: '', reason: '', requestId: ''
    }, event.change || {});
    record.changeId = changeId;
    pending.push(pfisRowFromObject(record, PFIS_CHANGE_FIELDS));
  });
  if (!pending.length) return [];
  const startRow = pfisGetNextAvailableBlock(sheet, 1, pending.length, PFIS_CHANGE_FIELDS.length);
  sheet.getRange(startRow, 1, pending.length, PFIS_CHANGE_FIELDS.length).setValues(pending);
  return pending.map(function (_, index) { return startRow + index; });
}

function pfisFindSourceByHash(hash, sourceType, ignoreSourceId, ignoreParseFailed, ignoreOrphaned) {
  // Source cache is built once per request and invalidated after source writes.
  // Reuse it here so ingest doesn't scan the entire Source Log twice per call.
  const rows = pfisGetSourceCache().allRows;
  for (let i = rows.length - 1; i >= 0; i--) {
    const source = rows[i];
    if (pfisString(source.sourceId) === pfisString(ignoreSourceId)) continue;
    if (pfisString(source.sourceHash) !== hash) continue;
    if (pfisNormalizeSourceType(source.sourceType) !== sourceType) continue;
    const status = pfisString(source.parseStatus).toUpperCase();
    if (status === 'SUPERSEDED' || status === 'SERVER_ERROR') continue;
    if (ignoreParseFailed && status === 'PARSE_FAILED') continue;
    if (ignoreOrphaned && (!pfisString(source.linkedTxnId) || pfisFindTransactionRow(source.linkedTxnId) < 2)) continue;
    return Object.assign({}, source);
  }
  return null;
}


function pfisGetSourceIdAtRow(rowNumber) {
  return pfisGetRequiredSheet(PFIS_SHEETS.sources).getRange(rowNumber, 1).getValue();
}

function pfisReplayResponse(source, requestId) {
  const status = pfisString(source.parseStatus).toUpperCase();
  if (status === 'NON_FINANCIAL_IGNORED') {
    return {
      success: true, status: 'NON_FINANCIAL_IGNORED', recorded: false, transactionId: null,
      sourceId: source.sourceId, requestId: requestId,
      message: 'Exact replay of a non-financial OTP/verification alert; no ledger transaction was created.'
    };
  }
  if (status === 'PARSE_FAILED') {
    return {
      success: false, status: 'PARSE_FAILED', error: 'PARSE_FAILED',
      message: 'This source is retained as PARSE_FAILED. Retry with a valid txnString; corrected retries are handled automatically.',
      sourceId: source.sourceId, transactionId: null, requestId: requestId
    };
  }

  const transaction = source.linkedTxnId ? pfisGetTransaction(source.linkedTxnId, false) : null;
  if (!transaction) {
    // Do not return success for an evidence row whose canonical transaction is missing.
    return {
      success: false, status: 'SOURCE_LINK_MISSING', error: 'SOURCE_LINK_MISSING',
      message: 'This source has no readable linked transaction. Submit a valid txnString to recover the ledger record.',
      sourceId: source.sourceId, transactionId: source.linkedTxnId || null, requestId: requestId
    };
  }
  const response = pfisBuildIngestResponse(transaction, requestId, source.sourceType, 'IDEMPOTENT_REPLAY', source.sourceId);
  response.previousStatus = status;
  response.message = 'Exact source replay; existing ledger record returned and no duplicate row was inserted.';
  return response;
}

function pfisReprocessSource(params, requestId) {
  const sourceId = pfisString(params.sourceId);
  const correctedTxnString = pfisString(params.txnString);
  if (!sourceId || !correctedTxnString) return { success: false, error: 'BAD_REQUEST', message: 'sourceId and corrected txnString are required.', requestId: requestId };
  const old = pfisFindSourceById(sourceId);
  if (!old) return { success: false, error: 'SOURCE_NOT_FOUND', message: 'Source ID not found.', requestId: requestId };
  const allowed = ['CONFLICT', 'DUPLICATE_CANDIDATE', 'PARSE_FAILED'];
  if (allowed.indexOf(pfisString(old.parseStatus).toUpperCase()) < 0) {
    return { success: false, error: 'REPROCESS_NOT_ALLOWED', message: 'Only CONFLICT, DUPLICATE_CANDIDATE, or PARSE_FAILED sources can be reprocessed.', requestId: requestId };
  }
  const result = pfisIngestSource({
    sourceType: old.sourceType, txnString: correctedTxnString, originalText: old.rawBody,
    sender: old.sender, subject: old.subject, batchId: old.batchId, requestId: requestId
  }, requestId, { ignoreSourceId: sourceId, ignoreParseFailed: true, ignoreOrphaned: true });
  if (result && result.success && result.status !== 'IDEMPOTENT_REPLAY' && result.status !== 'PARSE_FAILED') {
    const sheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
    sheet.getRange(old.rowNumber, 9).setValue('SUPERSEDED');
    sheet.getRange(old.rowNumber, 20).setValue('Superseded by explicit reprocessing at ' + new Date().toISOString() + '; requestId=' + requestId);
    pfisInvalidateSourceCache();
    pfisAppendChangeOnce('source-superseded:' + sourceId + ':' + requestId, {
      transactionId: old.linkedTxnId || result.transactionId || '', targetTable: PFIS_SHEETS.sources,
      actor: 'system_reprocess', field: 'Parse Status', oldValue: old.parseStatus, newValue: 'SUPERSEDED',
      reason: 'Explicit source reprocessing after parser/engine correction.', requestId: requestId
    });
    result.reprocessedSourceId = sourceId;
    result.previousStatus = old.parseStatus;
  }
  return result;
}

function pfisFindSourceById(sourceId) {
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
  const rows = pfisReadFixedRows(sheet, PFIS_SOURCE_FIELDS.length);
  for (let i = 0; i < rows.length; i++) {
    const source = pfisObjectFromRow(rows[i], PFIS_SOURCE_FIELDS);
    if (pfisString(source.sourceId) === sourceId) {
      source.rowNumber = i + 2;
      return source;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Read/update operations
// -----------------------------------------------------------------------------

function pfisGetTransaction(transactionId, includeEvidence) {
  if (!transactionId) return null;
  let sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  let rowNumber = pfisFindTransactionRow(transactionId);

  // If not in active Transaction Log, check Rejected & Archive Log
  if (rowNumber < 2) {
    const archiveSheet = pfisGetSpreadsheet().getSheetByName('Rejected & Archive Log');
    if (archiveSheet) {
      rowNumber = pfisFindRowByValue(archiveSheet, 1, transactionId);
      if (rowNumber >= 2) sheet = archiveSheet;
    }
  }

  if (rowNumber < 2) return null;
  const obj = pfisObjectFromRow(sheet.getRange(rowNumber, 1, 1, PFIS_TX_FIELDS.length).getValues()[0], PFIS_TX_FIELDS);
  const verification = pfisGetVerificationState(transactionId, obj.validationFlag);
  const categories = pfisGetCategoryList();
  const enrichment = pfisGetEnrichmentState(obj.category, obj.userNotes, categories, obj.merchant);
  obj.sheetRow = rowNumber;
  obj.verificationStatus = verification.status;
  obj.verificationSource = verification.source;
  obj.sourceCount = verification.sourceCount;
  obj.sourceTypes = verification.sourceTypes;
  obj.datePrecision = pfisGetTransactionDatePrecision(transactionId);
  obj.requiresPurpose = enrichment.requiresPurpose;
  obj.requiresCategoryClassification = enrichment.requiresCategoryClassification;
  obj.needsEnrichment = enrichment.requiresPurpose || enrichment.requiresCategoryClassification;
  if (includeEvidence) obj.sources = pfisGetSourceDetails(transactionId, true);
  return obj;
}

function pfisGetVerificationState(transactionId, validationFlag) {
  // Include conflicting linked evidence in counts while keeping it from falsely
  // satisfying verification. A conflict must never be reported VERIFIED.
  const allLinked = pfisSourceRowsForTransaction(transactionId).filter(function (source) {
    return pfisString(source.sourceId) && pfisNormalizeSourceType(source.sourceType) &&
      pfisString(source.parseStatus).toUpperCase() !== 'SUPERSEDED';
  });
  const counted = allLinked.filter(function (source) {
    const status = pfisString(source.parseStatus).toUpperCase();
    return ['PARSE_FAILED', 'SUPERSEDED'].indexOf(status) < 0 && status.indexOf('PROCESSING_') !== 0;
  });
  const sourceTypes = pfisUnique(counted.map(function (source) { return pfisNormalizeSourceType(source.sourceType); }));
  const sourceCount = counted.length;
  const hasLinkedConflict = counted.some(function (source) { return pfisString(source.parseStatus).toUpperCase() === 'CONFLICT'; });
  const hasAnyConflict = pfisSourceRowsForTransaction(transactionId).some(function (source) {
    return pfisString(source.parseStatus).toUpperCase() === 'CONFLICT';
  });

  if (String(validationFlag || '').toUpperCase() === 'SOURCE_CONFLICT' || hasLinkedConflict || hasAnyConflict) {
    return { status: 'CONFLICT', source: '', sourceCount: sourceCount, sourceTypes: sourceTypes };
  }
  if (sourceTypes.indexOf('SMS') >= 0 && sourceTypes.indexOf('EMAIL') >= 0) {
    return { status: 'VERIFIED', source: 'SMS+EMAIL', sourceCount: sourceCount, sourceTypes: sourceTypes };
  }
  if (sourceTypes.indexOf('SMS') >= 0) return { status: 'SMS_ONLY', source: 'SMS', sourceCount: sourceCount, sourceTypes: sourceTypes };
  if (sourceTypes.indexOf('EMAIL') >= 0) return { status: 'EMAIL_ONLY', source: 'EMAIL', sourceCount: sourceCount, sourceTypes: sourceTypes };
  return { status: 'UNKNOWN', source: '', sourceCount: sourceCount, sourceTypes: sourceTypes };
}

function pfisGetTransactionDatePrecision(transactionId) {
  const index = pfisBuildSourceIndex();
  const sources = index[transactionId] || [];
  if (sources.some(function (s) { return s.datePrecision === 'DATETIME'; })) return 'DATETIME';
  if (sources.some(function (s) { return s.datePrecision === 'DATE_ONLY'; })) return 'DATE_ONLY';
  return 'UNKNOWN';
}

function pfisGetSourceDetails(transactionId, includeRaw) {
  return pfisSourceRowsForTransaction(transactionId).map(function (source) {
    const out = {
      sourceId: source.sourceId, sourceType: source.sourceType, parseStatus: source.parseStatus,
      receivedAt: source.receivedAt, extractedDate: source.extractedDate, datePrecision: source.datePrecision,
      amount: source.extractedAmount, accountIdentifier: source.accountIdentifier,
      merchant: source.extractedMerchant, referenceNo: source.extractedReferenceNo,
      sourceHash: source.sourceHash, notes: source.notes
    };
    if (includeRaw) out.rawBody = source.rawBody;
    return out;
  });
}

function pfisSourceRowsForTransaction(transactionId) {
  const rows = pfisGetSourceCache().allByTransaction[pfisString(transactionId)] || [];
  return rows.slice();
}

function pfisGetPendingReview(limitInput) {
  const limit = pfisClampLimit(limitInput, 50);
  const txns = pfisReadTransactions().filter(function (txn) {
    const flag = pfisString(txn.validationFlag).toUpperCase();
    return pfisTruthy(txn.needsReview) || pfisString(txn.reviewStatus).toUpperCase() === 'PENDING' ||
      ['DUPLICATE_CANDIDATE', 'SOURCE_CONFLICT', 'NEEDS_REVIEW'].indexOf(flag) >= 0;
  }).map(function (txn) {
    const verification = pfisGetVerificationState(txn.transactionId, txn.validationFlag);
    return {
      kind: 'transaction', transactionId: txn.transactionId, dateTime: txn.dateTime, amount: txn.amount,
      bank: txn.bank, merchant: txn.merchant, category: txn.category, type: txn.type,
      needsReview: true, reviewReason: txn.reviewReason, validationFlag: txn.validationFlag,
      verificationStatus: verification.status
    };
  });
  const sources = pfisReadFixedRows(pfisGetRequiredSheet(PFIS_SHEETS.sources), PFIS_SOURCE_FIELDS.length)
    .map(function (row) { return pfisObjectFromRow(row, PFIS_SOURCE_FIELDS); })
    .filter(function (source) { return pfisString(source.parseStatus).toUpperCase() === 'CONFLICT'; })
    .map(function (source) {
      return {
        kind: 'source_conflict', sourceId: source.sourceId, transactionId: source.linkedTxnId || null,
        sourceType: source.sourceType, receivedAt: source.receivedAt, reason: source.processingError || source.notes
      };
    });
  return txns.concat(sources).slice(0, limit);
}

function pfisGetNeedsEnrichment(limitInput) {
  const limit = pfisClampLimit(limitInput, 50);
  const pending = pfisReadTransactions().map(function (txn) {
    const enrichment = pfisGetEnrichmentState(txn.category, txn.userNotes, undefined, txn.merchant);
    if (!enrichment.requiresCategoryClassification) return null;
    const item = {
      transactionId: txn.transactionId, dateTime: txn.dateTime, amount: txn.amount,
      merchant: txn.merchant, category: txn.category, userNotes: txn.userNotes, type: txn.type,
      requiresPurpose: enrichment.requiresPurpose,
      requiresCategoryClassification: enrichment.requiresCategoryClassification,
      verificationStatus: pfisGetVerificationState(txn.transactionId, txn.validationFlag).status,
      // Retained as compatibility fields; purpose is optional and never queued.
      purposeSuggestion: '',
      purposeExamples: []
    };
    return item;
  }).filter(Boolean);
  return pending.slice(0, limit);
}

/**
 * Explicit human resolution for a potential duplicate/source conflict.
 * This action only confirms that the selected row is a distinct real transaction;
 * it never deletes/merges ledger rows or silently chooses a duplicate to discard.
 * Required POST JSON: {action:"resolveexception", transactionId:"...",
 * resolution:"CONFIRM_DISTINCT", reason:"...", actor:"user"}.
 */
function pfisArchiveConfirmedDuplicate(transactionId, duplicateOf, reason, actor, requestId) {
  const duplicateRow = pfisFindTransactionRow(transactionId);
  const primaryRow = pfisFindTransactionRow(duplicateOf);
  if (duplicateRow < 2 || primaryRow < 2 || transactionId === duplicateOf) {
    return { success: false, status: 'UPDATE_REJECTED', error: 'DUPLICATE_TARGET_INVALID',
      message: 'Both the duplicate candidate and its primary transaction must exist as separate active ledger rows.',
      transactionId: transactionId, duplicateOf: duplicateOf, requestId: requestId };
  }
  const txSheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  const archiveSheet = pfisGetSpreadsheet().getSheetByName(PFIS_SHEETS.archive);
  if (!archiveSheet || archiveSheet.getLastColumn() < PFIS_TX_FIELDS.length) {
    return { success: false, status: 'UPDATE_REJECTED', error: 'ARCHIVE_SHEET_INVALID',
      message: 'Rejected & Archive Log is missing or does not contain the canonical A:AC schema. No rows were changed.',
      transactionId: transactionId, requestId: requestId };
  }
  const primary = pfisObjectFromRow(
    txSheet.getRange(primaryRow, 1, 1, PFIS_TX_FIELDS.length).getValues()[0], PFIS_TX_FIELDS);
  if (['DUPLICATE_CANDIDATE', 'DUPLICATE_REJECTED'].indexOf(pfisString(primary.validationFlag).toUpperCase()) >= 0) {
    return { success: false, status: 'UPDATE_REJECTED', error: 'PRIMARY_NOT_CANONICAL',
      message: 'duplicateOf must identify a surviving canonical transaction, not another duplicate candidate or rejected row.',
      transactionId: transactionId, duplicateOf: duplicateOf, requestId: requestId };
  }
  const rowWidth = Math.max(txSheet.getLastColumn(), PFIS_TX_FIELDS.length);
  const originalValues = txSheet.getRange(duplicateRow, 1, 1, rowWidth).getValues()[0];
  const record = pfisObjectFromRow(originalValues.slice(0, PFIS_TX_FIELDS.length), PFIS_TX_FIELDS);
  if (pfisString(record.validationFlag).toUpperCase() !== 'DUPLICATE_CANDIDATE') {
    return { success: false, status: 'UPDATE_REJECTED', error: 'NOT_DUPLICATE_CANDIDATE',
      message: 'Only a transaction explicitly flagged DUPLICATE_CANDIDATE can be archived this way.',
      transactionId: transactionId, requestId: requestId };
  }
  const now = new Date();
  record.needsReview = false;
  record.reviewStatus = 'Rejected - Duplicate';
  record.reviewReason = 'confirmed_duplicate_of:' + duplicateOf + ' | ' + reason;
  record.reviewedBy = actor;
  record.reviewedAt = now;
  record.validationFlag = 'DUPLICATE_REJECTED';
  record.lastUpdatedAt = now;

  // Copy the complete row, including Budget Month, Income Month and any future
  // auxiliary fields; recomputing from the core A:AC schema would lose metadata.
  const archiveWidth = Math.max(archiveSheet.getLastColumn(), rowWidth);
  const archivedValues = new Array(archiveWidth).fill('');
  originalValues.forEach(function (value, index) { archivedValues[index] = value; });
  pfisRowFromObject(record, PFIS_TX_FIELDS).forEach(function (value, index) { archivedValues[index] = value; });
  let archiveRow = pfisFindRowByValue(archiveSheet, 1, transactionId);
  if (archiveRow < 2) archiveRow = pfisGetNextAvailableRow(archiveSheet, 1);
  archiveSheet.getRange(archiveRow, 1, 1, archiveWidth).setValues([archivedValues]);
  pfisWriteLegacyTransactionAux(archiveRow, record,
    'Human-confirmed duplicate of ' + duplicateOf + ': ' + reason, archiveSheet);

  // Re-point all source evidence to the surviving canonical transaction. The
  // detailed Change Log is written before the destructive active-row clear.
  const sourceSheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
  const sourceRows = pfisReadFixedRows(sourceSheet, PFIS_SOURCE_FIELDS.length);
  sourceRows.forEach(function (row, i) {
    const source = pfisObjectFromRow(row, PFIS_SOURCE_FIELDS);
    if (pfisString(source.linkedTxnId) !== transactionId) return;
    const sourceRow = i + 2;
    sourceSheet.getRange(sourceRow, 16).setValue(duplicateOf);
    sourceSheet.getRange(sourceRow, 9).setValue('DUPLICATE_SUPPRESSED');
    sourceSheet.getRange(sourceRow, 19).setValue(true);
    sourceSheet.getRange(sourceRow, 20).setValue(
      'Human-confirmed duplicate archived as ' + transactionId + '; linked to surviving transaction ' + duplicateOf +
      '. Reason: ' + reason);
  });

  pfisAppendChangeOnceBatch([
    { eventKey: 'duplicate-archived:' + transactionId, change: {
      transactionId: transactionId, targetTable: PFIS_SHEETS.archive, actor: actor,
      field: 'Archive Status', oldValue: 'DUPLICATE_CANDIDATE', newValue: 'DUPLICATE_REJECTED',
      reason: 'Human-confirmed duplicate of ' + duplicateOf + ': ' + reason, requestId: requestId
    }},
    { eventKey: 'duplicate-survivor:' + transactionId + ':' + duplicateOf, change: {
      transactionId: duplicateOf, targetTable: PFIS_SHEETS.transactions, actor: actor,
      field: 'Duplicate Evidence Linked', oldValue: '', newValue: transactionId,
      reason: 'Duplicate transaction ' + transactionId + ' archived; its source evidence was linked to this surviving transaction.', requestId: requestId
    }}
  ]);

  // If archive, source relink, or audit fails, the active row remains reviewable.
  txSheet.getRange(duplicateRow, 1, 1, rowWidth).clearContent();
  pfisInvalidateTransactionCache();
  pfisInvalidateSourceCache();
  return { success: true, status: 'DUPLICATE_ARCHIVED', transactionId: transactionId,
    duplicateOf: duplicateOf, archiveRow: archiveRow, requestId: requestId };
}

function pfisResolveTransactionException(params, requestId) {
  const transactionId = pfisString(params.transactionId || params.txnId);
  const resolution = pfisString(params.resolution).toUpperCase().replace(/[ -]+/g, '_');
  const reason = pfisCleanText(params.reason);
  if (!transactionId) return { success: false, status: 'UPDATE_REJECTED', error: 'BAD_REQUEST', message: 'transactionId is required.', requestId: requestId };
  if (['CONFIRM_DISTINCT', 'CONFIRM_DUPLICATE'].indexOf(resolution) < 0) {
    return {
      success: false, status: 'UPDATE_REJECTED', error: 'UNSUPPORTED_RESOLUTION',
      message: 'Use CONFIRM_DISTINCT to retain a real transaction or CONFIRM_DUPLICATE with duplicateOf to archive a confirmed duplicate.',
      transactionId: transactionId, allowedResolutions: ['CONFIRM_DISTINCT', 'CONFIRM_DUPLICATE'], requestId: requestId
    };
  }
  if (!reason || reason.length < 8) {
    return {
      success: false, status: 'UPDATE_REJECTED', error: 'RESOLUTION_REASON_REQUIRED',
      message: 'Provide a specific human review reason of at least 8 characters; no fields were changed.', transactionId: transactionId, requestId: requestId
    };
  }
  if (resolution === 'CONFIRM_DUPLICATE') {
    const duplicateOf = pfisString(params.duplicateOf);
    if (!duplicateOf) return {
      success: false, status: 'UPDATE_REJECTED', error: 'DUPLICATE_OF_REQUIRED',
      message: 'duplicateOf must contain the surviving canonical transaction ID.', transactionId: transactionId, requestId: requestId
    };
    return pfisArchiveConfirmedDuplicate(transactionId, duplicateOf, reason, pfisString(params.actor) || 'user', requestId);
  }

  const rowNumber = pfisFindTransactionRow(transactionId);
  if (rowNumber < 2) return {
    success: false, status: 'NOT_FOUND', error: 'NOT_FOUND',
    message: 'Transaction not found: ' + transactionId, transactionId: transactionId, requestId: requestId
  };
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  const current = pfisObjectFromRow(sheet.getRange(rowNumber, 1, 1, PFIS_TX_FIELDS.length).getValues()[0], PFIS_TX_FIELDS);
  const currentFlag = pfisString(current.validationFlag).toUpperCase();
  if (['DUPLICATE_CANDIDATE', 'SOURCE_CONFLICT'].indexOf(currentFlag) < 0) {
    return {
      success: false, status: 'UPDATE_REJECTED', error: 'NO_RESOLVABLE_CONFLICT',
      message: 'This transaction does not have a DUPLICATE_CANDIDATE or SOURCE_CONFLICT flag. No fields were changed.',
      transactionId: transactionId, currentValidationFlag: currentFlag, requestId: requestId
    };
  }

  const categories = pfisGetCategoryList();
  let remainingReason = '';
  if (!pfisNormalizeType(current.type)) remainingReason = 'unknown_transaction_type';
  else if (!pfisIsMatchableMerchant(pfisNormalizeMerchant(current.merchant))) remainingReason = 'merchant_missing_or_unusable';
  else if (pfisString(current.reviewReason) === 'time_precision_unavailable') remainingReason = 'time_precision_unavailable';
  else {
    const enrichment = pfisGetEnrichmentState(current.category, current.userNotes, categories, current.merchant);
    if (enrichment.requiresPurpose || enrichment.requiresCategoryClassification) remainingReason = 'enrichment_required';
  }
  const needsReview = !!remainingReason;
  const newFlag = needsReview ? 'NEEDS_REVIEW' : 'VALID';
  const reviewStatus = needsReview ? 'Pending' : 'Approved';
  const actor = pfisString(params.actor) || 'user';
  const now = new Date();

  // Set only system-owned review columns. Financial facts and source evidence are
  // immutable in this action. A user must resolve each conflicting row explicitly.
  const updates = [
    [15, needsReview], [20, reviewStatus], [21, remainingReason],
    [22, needsReview ? '' : actor], [23, needsReview ? '' : now], [27, newFlag], [29, now]
  ];
  updates.forEach(function (item) { sheet.getRange(rowNumber, item[0]).setValue(item[1]); });
  const auditReason = 'Human confirmed distinct transaction: ' + reason + (remainingReason ? '. Remaining review: ' + remainingReason : '');
  pfisAppendChangeOnceBatch([
    { field: 'Validation Flag', oldValue: currentFlag, newValue: newFlag },
    { field: 'Needs Review', oldValue: String(!!current.needsReview), newValue: String(needsReview) },
    { field: 'Review Status', oldValue: pfisString(current.reviewStatus), newValue: reviewStatus },
    { field: 'Review Reason', oldValue: pfisString(current.reviewReason), newValue: remainingReason },
    { field: 'Reviewed By', oldValue: pfisString(current.reviewedBy), newValue: needsReview ? '' : actor },
    { field: 'Reviewed At', oldValue: pfisString(current.reviewedAt), newValue: needsReview ? '' : now.toISOString() }
  ].map(function (event) {
    return {
      eventKey: 'exception-resolve:' + transactionId + ':' + requestId + ':' + event.field,
      change: {
        transactionId: transactionId, targetTable: PFIS_SHEETS.transactions, actor: actor,
        field: event.field, oldValue: event.oldValue, newValue: event.newValue,
        reason: auditReason, requestId: requestId
      }
    };
  }));
  pfisInvalidateTransactionCache();
  pfisWriteLegacyTransactionAux(rowNumber, pfisObjectFromRow(sheet.getRange(rowNumber, 1, 1, PFIS_TX_FIELDS.length).getValues()[0], PFIS_TX_FIELDS),
    'Human confirmed distinct transaction: ' + reason);
  return pfisBuildUpdateResponse(pfisGetTransaction(transactionId, false), requestId,
    needsReview ? 'EXCEPTION_RESOLVED_REVIEW_REMAINS' : 'EXCEPTION_RESOLVED', ['needsReview', 'reviewStatus', 'reviewReason', 'validationFlag']);
}

function pfisUpdateTransaction(params, requestId) {
  const transactionId = pfisString(params.transactionId || params.txnId);
  if (!transactionId) {
    return {
      success: false, status: 'UPDATE_REJECTED', error: 'BAD_REQUEST',
      message: 'transactionId is required.', requestId: requestId
    };
  }
  const rowNumber = pfisFindTransactionRow(transactionId);
  if (rowNumber < 2) {
    return {
      success: false, status: 'NOT_FOUND', error: 'NOT_FOUND',
      message: 'Transaction not found: ' + transactionId, transactionId: transactionId, requestId: requestId
    };
  }

  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  const current = pfisObjectFromRow(
    sheet.getRange(rowNumber, 1, 1, PFIS_TX_FIELDS.length).getValues()[0], PFIS_TX_FIELDS);
  const has = function (key) { return Object.prototype.hasOwnProperty.call(params, key); };
  const patch = {};
  const categories = pfisGetCategoryList();

  // Validate the full patch before writing anything. This prevents a half-update
  // where purpose is saved but an explicitly supplied category is blank/invalid.
  if (has('category')) {
    const category = pfisString(params.category);
    if (!categories.length) {
      return {
        success: false, status: 'UPDATE_REJECTED', error: 'NO_ACTIVE_CATEGORIES',
        message: 'No active categories exist in the Categories sheet; no fields were changed.', transactionId: transactionId, requestId: requestId
      };
    }
    if (!category) {
      const fallback = categories.indexOf('Miscellaneous') >= 0 ? 'Miscellaneous' : '';
      if (!fallback) return {
        success: false, status: 'UPDATE_REJECTED', error: 'NO_MISCELLANEOUS_CATEGORY',
        message: 'Empty category received, but Miscellaneous is not an active category.',
        transactionId: transactionId, allowedCategories: categories, requestId: requestId
      };
      patch.category = fallback;
    } else {
      if (categories.indexOf(category) < 0) {
        return {
          success: false, status: 'UPDATE_REJECTED', error: 'INVALID_CATEGORY',
          message: 'category must exactly match an active Categories sheet value.', transactionId: transactionId,
          allowedCategories: categories, requestId: requestId
        };
      }
      patch.category = category;
    }
  }

  let purposeKey = '';
  if (has('purpose')) purposeKey = 'purpose';
  else if (has('userNotes')) purposeKey = 'userNotes';
  else if (has('notes')) purposeKey = 'notes';
  if (purposeKey) {
    const purpose = pfisString(params[purposeKey]);
    // Blank purpose is valid. It is optional enrichment, not an API failure.
    if (purpose && !pfisIsMeaningfulPurpose(purpose, has('merchant') ? params.merchant : current.merchant)) {
      return {
        success: false, status: 'UPDATE_REJECTED', error: 'UNINFORMATIVE_PURPOSE',
        message: 'purpose is a placeholder or repeats the merchant name. Provide the actual reason for the payment; no fields were changed.',
        transactionId: transactionId, requestId: requestId
      };
    }
    patch.userNotes = purpose;
  }

  if (has('type')) {
    const normalizedType = pfisNormalizeType(params.type);
    if (!normalizedType) {
      return {
        success: false, status: 'UPDATE_REJECTED', error: 'INVALID_TYPE',
        message: 'Unsupported or empty semantic transaction type.', transactionId: transactionId, requestId: requestId
      };
    }
    patch.type = normalizedType;
  }
  if (has('merchant')) {
    const merchant = pfisCleanText(params.merchant);
    if (!merchant) {
      return {
        success: false, status: 'UPDATE_REJECTED', error: 'EMPTY_MERCHANT',
        message: 'merchant was supplied but empty; no fields were changed.', transactionId: transactionId, requestId: requestId
      };
    }
    patch.merchant = merchant;
  }

  if (!Object.keys(patch).length) {
    return {
      success: false, status: 'UPDATE_REJECTED', error: 'NO_UPDATE_FIELDS',
      message: 'Provide at least one non-empty supported field: category, purpose, type, or merchant.',
      transactionId: transactionId, requestId: requestId
    };
  }

  const mutableFields = ['category', 'userNotes', 'type', 'merchant'];
  const changed = mutableFields.filter(function (field) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) return false;
    const oldValue = current[field] === null || current[field] === undefined ? '' : current[field];
    return String(oldValue) !== String(patch[field]);
  });

  if (!changed.length) {
    // Truthful idempotent update: no write, no audit noise, but return current state.
    return pfisBuildUpdateResponse(pfisGetTransaction(transactionId, false), requestId, 'NO_CHANGE', []);
  }

  const updateAuditEvents = [];
  changed.forEach(function (field) {
    const oldValue = current[field] === null || current[field] === undefined ? '' : current[field];
    const newValue = patch[field];
    sheet.getRange(rowNumber, PFIS_TX_FIELDS.indexOf(field) + 1).setValue(newValue);
    updateAuditEvents.push({
      eventKey: 'update:' + transactionId + ':' + requestId + ':' + field,
      change: {
        transactionId: transactionId, targetTable: PFIS_SHEETS.transactions,
        actor: pfisString(params.actor) || 'user', field: field,
        oldValue: String(oldValue), newValue: String(newValue),
        reason: pfisString(params.reason) || 'user_update', requestId: requestId
      }
    });
  });
  pfisAppendChangeOnceBatch(updateAuditEvents);

  // Enrichment can clear only the enrichment-specific review reason. Independent
  // data-integrity/configuration findings must survive partial or complete enrichment.
  const latest = pfisObjectFromRow(
    sheet.getRange(rowNumber, 1, 1, PFIS_TX_FIELDS.length).getValues()[0], PFIS_TX_FIELDS);
  const flag = pfisString(latest.validationFlag).toUpperCase();
  const unresolvedFlag = ['DUPLICATE_CANDIDATE', 'SOURCE_CONFLICT'].indexOf(flag) >= 0;
  if (!unresolvedFlag) {
    let stillNeedsReview = false;
    let reviewReason = pfisString(latest.reviewReason);

    if (pfisIsPersistentReviewReason(reviewReason)) {
      // Do not replace account/configuration, cross-channel, or precision issues
      // with enrichment_required when only category/purpose was updated.
      stillNeedsReview = true;
    } else if (!pfisNormalizeType(latest.type)) {
      stillNeedsReview = true;
      reviewReason = 'unknown_transaction_type';
    } else if (!pfisIsMatchableMerchant(pfisNormalizeMerchant(latest.merchant))) {
      stillNeedsReview = true;
      reviewReason = 'merchant_missing_or_unusable';
    } else {
      const enrichment = pfisGetEnrichmentState(latest.category, latest.userNotes, categories, latest.merchant);
      if (enrichment.requiresPurpose || enrichment.requiresCategoryClassification) {
        stillNeedsReview = true;
        reviewReason = 'enrichment_required';
      } else if (['enrichment_required', 'unknown_transaction_type', 'merchant_missing_or_unusable'].indexOf(reviewReason) >= 0) {
        // Purpose and category are now complete; clear only system-managed reasons.
        stillNeedsReview = false;
        reviewReason = '';
      } else {
        // Do not clear an unrelated/manual review reason implicitly.
        stillNeedsReview = !!latest.needsReview;
      }
    }

    sheet.getRange(rowNumber, 15).setValue(stillNeedsReview);
    sheet.getRange(rowNumber, 20).setValue(stillNeedsReview ? 'Pending' : 'Approved');
    sheet.getRange(rowNumber, 21).setValue(reviewReason);
    sheet.getRange(rowNumber, 22).setValue(stillNeedsReview ? '' : (pfisString(params.actor) || 'user'));
    sheet.getRange(rowNumber, 23).setValue(stillNeedsReview ? '' : new Date());
    sheet.getRange(rowNumber, 27).setValue(stillNeedsReview ? 'NEEDS_REVIEW' : 'VALID');
  }
  sheet.getRange(rowNumber, 29).setValue(new Date());
  pfisInvalidateTransactionCache();
  pfisWriteLegacyTransactionAux(rowNumber, latest, 'Updated ' + changed.join(', ') + ' by ' + (pfisString(params.actor) || 'user'));
  return pfisBuildUpdateResponse(pfisGetTransaction(transactionId, false), requestId, 'UPDATED', changed);
}

function pfisEnrichBlankTransactionFields(transactionId, parsed, ruleResult, configResult, requestId) {
  const rowNumber = pfisFindTransactionRow(transactionId);
  if (rowNumber < 2) return;
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  const activeCategories = pfisGetCategoryList();
  const fieldsToFill = [
    ['accountType', pfisFormatAccountType(parsed.accountType)],
    ['instrument', pfisCleanText(parsed.instrument || ruleResult.instrumentOverride || configResult.instrument)],
    ['type', pfisNormalizeType(ruleResult.typeOverride || parsed.type)],
    ['account', pfisCleanText(ruleResult.accountOverride || configResult.account)],
    ['cardName', pfisCleanText(ruleResult.cardNameOverride || configResult.cardName)],
    ['category', activeCategories.indexOf(pfisCleanText(ruleResult.category)) >= 0
      ? pfisCleanText(ruleResult.category)
      : (activeCategories.indexOf('Miscellaneous') >= 0 ? 'Miscellaneous' : '')],
    ['userNotes', pfisGetTrustedPurposeFromRule(
      ruleResult, ruleResult.merchantOverride || parsed.merchant, parsed.datetime)]
  ];
  fieldsToFill.forEach(function (item) {
    const col = PFIS_TX_FIELDS.indexOf(item[0]) + 1;
    if (col < 1 || !item[1]) return;
    const oldValue = sheet.getRange(rowNumber, col).getValue();
    if (pfisString(oldValue)) return;
    sheet.getRange(rowNumber, col).setValue(item[1]);
    pfisAppendChangeOnce('reconcile-fill:' + transactionId + ':' + item[0], {
      transactionId: transactionId, targetTable: PFIS_SHEETS.transactions,
      actor: 'system_reconciliation', field: item[0], oldValue: '', newValue: String(item[1]),
      reason: 'Filled previously blank canonical field from matching source; no non-empty value overwritten.', requestId: requestId
    });
  });
  sheet.getRange(rowNumber, 29).setValue(new Date());
  pfisInvalidateTransactionCache();
  pfisRefreshReviewStateAfterEnrichment(rowNumber, requestId);
}

/**
 * Reasons that cannot be cleared merely by completing category/purpose enrichment.
 * The single Review Reason cell remains a primary reason, not a lossy replacement
 * for independent configuration and reconciliation findings.
 */
function pfisIsPersistentReviewReason(reason) {
  return [
    'config_mapping_ambiguous', 'config_mapping_unresolved', 'time_precision_unavailable',
    'account_identifier_conflict', 'account_type_conflict', 'same_reference_amount_conflict',
    'same_reference_conflicting_transaction_facts', 'ambiguous_cross_channel_match',
    'ambiguous_time_precision_match', 'ambiguous_exact_same_channel_duplicate',
    'same_channel_reference_conflict_needs_review', 'recovered_conflict',
    'source_conflict', 'duplicate_candidate'
  ].indexOf(pfisString(reason).toLowerCase()) >= 0;
}

/** Keep legacy Needs Review/Review Status columns synchronized after rule-based
 * reconciliation enrichment. Never clear duplicate, conflict, configuration,
 * or time-precision review states automatically. */
function pfisRefreshReviewStateAfterEnrichment(rowNumber, requestId) {
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  const row = pfisObjectFromRow(
    sheet.getRange(rowNumber, 1, 1, PFIS_TX_FIELDS.length).getValues()[0], PFIS_TX_FIELDS);
  const flag = pfisString(row.validationFlag).toUpperCase();
  if (['DUPLICATE_CANDIDATE', 'SOURCE_CONFLICT'].indexOf(flag) >= 0) return;

  const oldNeedsReview = !!row.needsReview;
  const oldReason = pfisString(row.reviewReason);
  let needsReview = oldNeedsReview;
  let reason = oldReason;

  if (pfisIsPersistentReviewReason(oldReason)) {
    needsReview = true;
  } else if (!pfisNormalizeType(row.type)) {
    needsReview = true;
    reason = 'unknown_transaction_type';
  } else if (!pfisIsMatchableMerchant(pfisNormalizeMerchant(row.merchant))) {
    needsReview = true;
    reason = 'merchant_missing_or_unusable';
  } else {
    const enrichment = pfisGetEnrichmentState(row.category, row.userNotes, undefined, row.merchant);
    if (enrichment.requiresPurpose || enrichment.requiresCategoryClassification) {
      needsReview = true;
      reason = 'enrichment_required';
    } else if (['enrichment_required', 'unknown_transaction_type', 'merchant_missing_or_unusable'].indexOf(oldReason) >= 0) {
      needsReview = false;
      reason = '';
    }
  }

  if (needsReview === oldNeedsReview && reason === oldReason) return;
  sheet.getRange(rowNumber, 15).setValue(needsReview);
  sheet.getRange(rowNumber, 20).setValue(needsReview ? 'Pending' : 'Approved');
  sheet.getRange(rowNumber, 21).setValue(reason);
  sheet.getRange(rowNumber, 22).setValue(needsReview ? '' : 'SYSTEM_RECONCILIATION');
  sheet.getRange(rowNumber, 23).setValue(needsReview ? '' : new Date());
  sheet.getRange(rowNumber, 27).setValue(needsReview ? 'NEEDS_REVIEW' : 'VALID');
  sheet.getRange(rowNumber, 29).setValue(new Date());
  pfisInvalidateTransactionCache();
  pfisAppendChangeOnce('reconcile-review-state:' + row.transactionId + ':' + requestId, {
    transactionId: row.transactionId, targetTable: PFIS_SHEETS.transactions,
    actor: 'system_reconciliation', field: 'Needs Review',
    oldValue: String(oldNeedsReview), newValue: String(needsReview),
    reason: 'Recomputed review state after filling rule-derived fields from opposite-channel evidence.',
    requestId: requestId
  });
  pfisWriteLegacyTransactionAux(rowNumber, row, needsReview
    ? 'Reconciliation left transaction pending: ' + reason
    : 'Reconciliation completed rule-based enrichment');
}

function pfisFlagTransactionsForReview(transactionIds, reason, validationFlag, requestId, sourceId, detail) {
  const uniqueIds = pfisUnique((transactionIds || []).filter(Boolean));
  uniqueIds.forEach(function (transactionId) {
    const rowNumber = pfisFindTransactionRow(transactionId);
    if (rowNumber < 2) return;
    const sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
    const oldFlag = pfisString(sheet.getRange(rowNumber, 27).getValue()).toUpperCase();
    if (validationFlag === 'NEEDS_REVIEW' && ['DUPLICATE_CANDIDATE', 'SOURCE_CONFLICT'].indexOf(oldFlag) >= 0) return;
    sheet.getRange(rowNumber, 15).setValue(true);
    sheet.getRange(rowNumber, 20).setValue('Pending');
    sheet.getRange(rowNumber, 21).setValue(reason);
    sheet.getRange(rowNumber, 22).setValue('');
    sheet.getRange(rowNumber, 23).setValue('');
    sheet.getRange(rowNumber, 27).setValue(validationFlag || 'NEEDS_REVIEW');
    sheet.getRange(rowNumber, 29).setValue(new Date());
    pfisWriteLegacyTransactionAux(rowNumber, pfisObjectFromRow(
      sheet.getRange(rowNumber, 1, 1, PFIS_TX_FIELDS.length).getValues()[0], PFIS_TX_FIELDS),
      'Flagged for review: ' + reason);
    pfisAppendChangeOnce('flag:' + (sourceId || requestId) + ':' + transactionId + ':' + reason, {
      transactionId: transactionId, targetTable: PFIS_SHEETS.transactions, actor: 'system_matching',
      field: 'Validation Flag', oldValue: oldFlag, newValue: validationFlag || 'NEEDS_REVIEW',
      reason: detail || reason, requestId: requestId
    });
  });
  pfisInvalidateTransactionCache();
}

// -----------------------------------------------------------------------------
// Rules, Config and Categories — all fixed-position
// -----------------------------------------------------------------------------

/**
 * Category-only fallback using existing merchant-anchored rules.
 *
 * If an AMOUNT+MERCHANT rule misses only because the amount differs, its
 * merchant evidence can still support the category, but it must NOT carry over
 * the amount-specific purpose template, recurrence flag, type/account/card
 * overrides, Auto Purpose permission, or confidence. A unanimous merchant
 * override may be retained as a canonical merchant label because it describes
 * merchant identity rather than transaction purpose.
 *
 * Conflicting categories or invalid configured categories fail closed and leave
 * the category unresolved for the Shortcuts/AI fallback.
 */
function pfisBuildMerchantCategoryFallback_(rules, merchantValue, categories) {
  const merchantKey = pfisNormalizeMerchant(merchantValue);
  if (!merchantKey) return pfisEmptyRuleResult();

  const candidates = [];
  let invalidCategoryCandidate = false;
  (Array.isArray(rules) ? rules : []).forEach(function (rule) {
    if (!pfisTruthy(rule.enabled)) return;
    const matchType = pfisNormalizeRuleMatchType(rule.matchType);
    if (['MERCHANT', 'AMOUNTMERCHANT'].indexOf(matchType) < 0) return;

    const pattern = pfisNormalizeRuleMerchantPattern(rule.merchantContains);
    if (!pattern || merchantKey.indexOf(pattern) < 0) return;

    const category = pfisCleanText(rule.category);
    if (!category || categories.indexOf(category) < 0) {
      invalidCategoryCandidate = true;
      return;
    }
    candidates.push({
      rule: rule,
      category: category,
      rowNumber: Number(rule.rowNumber) || 999999,
      ruleId: pfisCleanText(rule.ruleId) || ('RULE-' + (Number(rule.rowNumber) || 'UNKNOWN')),
      merchantOverride: pfisCleanText(rule.merchantOverride)
    });
  });

  if (!candidates.length || invalidCategoryCandidate) return pfisEmptyRuleResult();

  const categorySet = pfisUnique(candidates.map(function (item) { return item.category; }));
  if (categorySet.length !== 1) {
    console.warn('Merchant category fallback is ambiguous for "' + merchantKey + '": ' +
      candidates.map(function (item) { return item.ruleId + '=' + item.category; }).join(', '));
    return pfisEmptyRuleResult();
  }

  const overrides = pfisUnique(candidates.map(function (item) { return item.merchantOverride; }));
  const result = pfisEmptyRuleResult();
  result.category = categorySet[0];
  result.ruleType = 'MERCHANT_CATEGORY_FALLBACK';
  result.ruleApplied = 'CATEGORY_FALLBACK:' + candidates.map(function (item) { return item.ruleId; }).join(',');
  // Retain a canonical merchant label only when every matching rule agrees.
  result.merchantOverride = overrides.length === 1 ? overrides[0] : '';
  result.autoPurpose = false;
  result.notes = '';
  result.notesMetadata = '';
  result.confidence = null;
  result.isCategoryFallback = true;
  return result;
}

function pfisEvaluateRules(parsed, rawEvidence) {
  const rules = pfisGetRuleRows();
  const categories = pfisGetCategoryList();
  const merchantKey = pfisNormalizeMerchant(parsed.merchant);
  const absoluteAmount = Math.abs(Number(parsed.amount));
  const matches = [];
  let matchedRuleWithInvalidCategory = false;

  rules.forEach(function (rule) {
    if (!pfisTruthy(rule.enabled)) return;
    const matchType = pfisNormalizeRuleMatchType(rule.matchType);
    const pattern = pfisNormalizeRuleMerchantPattern(rule.merchantContains);
    const amount = pfisParseAmount(rule.amount, true);
    let isMatch = false;
    let specificity = 0;

    if (matchType === 'MERCHANT') {
      isMatch = !!pattern && merchantKey.indexOf(pattern) >= 0;
      specificity = 2;
    } else if (matchType === 'AMOUNT') {
      const amountMatches = amount !== '' && Math.abs(Number(amount) - absoluteAmount) < 0.005;
      // Amount-only rules are accepted only when raw evidence corroborates the
      // intended merchant/transaction family. The amount by itself is never enough.
      isMatch = amountMatches && pfisAmountRuleHasEvidence(rule, parsed, rawEvidence);
      if (amountMatches && !isMatch) {
        console.warn('Amount rule skipped: amount matched but corroborating merchant evidence was absent at Rules row ' + rule.rowNumber + '.');
      }
      specificity = 1;
    } else if (matchType === 'AMOUNTMERCHANT') {
      // Both conditions are mandatory. A malformed row must never degrade into
      // amount-only or merchant-only matching.
      isMatch = amount !== '' && !!pattern &&
        Math.abs(Number(amount) - absoluteAmount) < 0.005 && merchantKey.indexOf(pattern) >= 0;
      specificity = 3;
    } else if (matchType) {
      console.warn('Unsupported Rules Match Type at row ' + rule.rowNumber + ': ' + rule.matchType);
    }
    if (!isMatch) return;

    const category = categories.indexOf(pfisCleanText(rule.category)) >= 0
      ? pfisCleanText(rule.category) : '';
    if (!category) {
      matchedRuleWithInvalidCategory = true;
      console.warn('Rules row ' + rule.rowNumber + ' ignored because its Category is blank or not active in Categories.');
      return;
    }
    const priorityRaw = pfisString(rule.priority);
    const priority = priorityRaw !== '' && isFinite(Number(priorityRaw)) ? Number(priorityRaw) : 999;
    matches.push({
      rule: rule, matchType: matchType, category: category, specificity: specificity,
      evidenceQualified: matchType === 'AMOUNT' && isMatch,
      priority: priority, rowNumber: Number(rule.rowNumber) || 999999
    });
  });

  if (!matches.length) {
    // Do not mask a fully matching but misconfigured rule with a weaker fallback.
    if (matchedRuleWithInvalidCategory) return pfisEmptyRuleResult();
    return pfisBuildMerchantCategoryFallback_(rules, parsed.merchant, categories);
  }

  // More constrained rules win over broad amount-only rules. Within the same
  // specificity, lower numeric Priority wins (same convention as Config); blank
  // Priority is 999. Row order is used only as a stable final sort, not to choose
  // between equally ranked rules that would produce conflicting outcomes.
  matches.sort(function (a, b) {
    return b.specificity - a.specificity || a.priority - b.priority || a.rowNumber - b.rowNumber;
  });
  const best = matches[0];
  const tied = matches.filter(function (item) {
    return item.specificity === best.specificity && item.priority === best.priority;
  });
  if (tied.length > 1) {
    const signatures = pfisUnique(tied.map(function (item) {
      const r = item.rule;
      return JSON.stringify([item.category, pfisCleanText(r.merchantOverride),
      pfisCleanText(r.notesTemplate), pfisCleanText(r.notes), pfisNormalizeType(r.typeOverride),
      pfisCleanText(r.accountOverride), pfisCleanText(r.cardNameOverride), pfisCleanText(r.instrumentOverride),
      pfisTruthy(r.isRecurring), pfisParseConfidence(r.confidence), pfisTruthy(r.autoPurpose)]);
    }));
    if (signatures.length > 1) {
      // Ambiguous rules are not guessed. Leave enrichment blank so Shortcuts can
      // obtain purpose/category with user + model; never block transaction insert.
      console.warn('Ambiguous equally ranked Rules rows: ' + tied.map(function (item) { return item.rowNumber; }).join(','));
      return pfisEmptyRuleResult();
    }
  }

  const rule = best.rule;
  const merchantForPurpose = pfisCleanText(rule.merchantOverride || parsed.merchant);
  const renderedTemplate = pfisCleanText(pfisApplyNotesTemplate(rule.notesTemplate, parsed.datetime, rule.monthOffset));
  const notesMetadata = pfisCleanText(rule.notes);
  // Existing optional Rules!S 'Notes' contains concise purpose descriptions in
  // this workbook (for example, 'Idli / Breakfast' and 'Jio telecom/fiber bill').
  // Use it as a fallback only for merchant-grounded or evidence-qualified amount rules.
  const rulePurpose = pfisIsMeaningfulPurpose(renderedTemplate, merchantForPurpose)
    ? renderedTemplate
    : ((best.matchType !== 'AMOUNT' || best.evidenceQualified) && pfisIsMeaningfulPurpose(notesMetadata, merchantForPurpose)
      ? notesMetadata : '');
  return {
    // Stable Rule ID is preferable to a row-number label, but it is optional.
    ruleApplied: pfisCleanText(rule.ruleId) || ('RULE-' + rule.rowNumber),
    ruleType: best.matchType,
    category: best.category,
    merchantOverride: pfisCleanText(rule.merchantOverride),
    notes: rulePurpose,
    isRecurring: pfisTruthy(rule.isRecurring),
    typeOverride: pfisNormalizeType(rule.typeOverride),
    accountOverride: pfisCleanText(rule.accountOverride),
    cardNameOverride: pfisCleanText(rule.cardNameOverride),
    instrumentOverride: pfisCleanText(rule.instrumentOverride),
    confidence: pfisParseConfidence(rule.confidence),
    autoPurpose: pfisTruthy(rule.autoPurpose),
    // Auto Review, Rule Engine and free-form Notes remain informational until
    // their business meaning is explicitly defined; they never bypass validation.
    autoReview: pfisTruthy(rule.autoReview),
    purposeTrigger: pfisString(rule.purposeTrigger).toUpperCase(),
    calendarScope: pfisString(rule.calendarScope).toUpperCase(),
    budgetMonthOffset: isFinite(Number(rule.budgetMonthOffset)) ? Math.trunc(Number(rule.budgetMonthOffset)) : 0,
    ruleEngine: pfisCleanText(rule.ruleEngine),
    notesMetadata: notesMetadata
  };
}

function pfisNormalizeRuleMerchantPattern(value) {
  let pattern = pfisNormalizeMerchant(value);
  const compact = pattern.replace(/\s+/g, '');
  // Repair a known data-entry shape: an identical merchant token pasted twice
  // without a separator (e.g. GUDIVENUKALAGUDIVENUKALA). This is conservative: the
  // whole pattern must consist of two identical halves before it is shortened.
  if (!pattern.includes(' ') && compact.length >= 8 && compact.length % 2 === 0) {
    const half = compact.slice(0, compact.length / 2);
    if (half === compact.slice(compact.length / 2)) pattern = half;
  }
  return pattern;
}

function pfisAmountRuleHasEvidence(rule, parsed, rawEvidence) {
  const evidence = pfisNormalizeMerchant(pfisSanitizeRawText([
    rawEvidence, parsed.merchant, parsed.counterparty, parsed.instrument
  ].filter(Boolean).join(' '), false));
  if (!evidence) return false;

  const override = pfisNormalizeMerchant(rule && rule.merchantOverride);
  const merchantPattern = pfisNormalizeRuleMerchantPattern(rule && rule.merchantContains);
  // Use the configured evidence fields, not names or obligations hard-coded for
  // one household. Merchant Contains is particularly important when Override is
  // intentionally blank in an AMOUNT rule.
  const ignored = [
    'card', 'credit', 'debit', 'bank', 'account', 'savings', 'payment', 'payments',
    'transfer', 'transaction', 'purchase', 'homes', 'home', 'investment', 'and', 'the',
    'upi', 'imps', 'neft', 'rtgs', 'axis', 'sbi', 'icici', 'hdfc', 'kotak', 'yesbank'
  ];
  const candidates = [override, merchantPattern].filter(Boolean);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const candidateTokens = candidate.split(' ').filter(function (token) {
      return token.length >= 3 && ignored.indexOf(token) < 0;
    });
    // Full configured phrases are strongest. Tiny generic rails/bank words do
    // not qualify on their own; a meaningful token from the configured pattern
    // can corroborate a bank message whose punctuation or word order differs.
    if (candidate.length >= 4 && candidateTokens.length > 0 && evidence.indexOf(candidate) >= 0) return true;
    if (candidateTokens.some(function (token) { return evidence.indexOf(token) >= 0; })) return true;
    if (candidate === 'sip' && /\b(?:sip|standing instruction|si fund transfer)\b/i.test(String(rawEvidence || ''))) return true;
  }
  return false;
}

function pfisEmptyRuleResult() {
  return {
    ruleApplied: '', ruleType: '', category: '', merchantOverride: '', notes: '',
    isRecurring: false, typeOverride: '', accountOverride: '', cardNameOverride: '',
    instrumentOverride: '', confidence: null, autoReview: false, autoPurpose: false,
    purposeTrigger: '', calendarScope: '', ruleEngine: '', notesMetadata: ''
  };
}

function pfisGetRuleRows() {
  if (PFIS_RUNTIME_RULE_CACHE !== null) return PFIS_RUNTIME_RULE_CACHE.map(function (row) { return Object.assign({}, row); });
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.rules);
  const baseRows = pfisReadFixedRows(sheet, PFIS_RULE_FIELDS.length);

  // Read the established N:S extension independently. Its absence or a mismatched
  // header must not shift data or disable the base A:M rules engine.
  let useOptional = false;
  if (sheet.getLastColumn() >= PFIS_RULE_FIELDS.length + PFIS_RULE_OPTIONAL_FIELDS.length) {
    const optionalHeaders = sheet.getRange(1, PFIS_RULE_FIELDS.length + 1, 1,
      PFIS_RULE_OPTIONAL_HEADERS.length).getDisplayValues()[0].map(pfisString);
    useOptional = optionalHeaders.every(function (header, i) {
      return pfisHeaderToken(header) === pfisHeaderToken(PFIS_RULE_OPTIONAL_HEADERS[i]);
    });
    if (!useOptional && optionalHeaders.some(pfisString)) {
      console.warn('Rules extension columns N:S ignored because their headers do not match the documented optional layout.');
    }
  }
  const extraRows = useOptional && baseRows.length
    ? sheet.getRange(2, PFIS_RULE_FIELDS.length + 1, baseRows.length, PFIS_RULE_OPTIONAL_FIELDS.length).getValues()
    : [];

  // T: Auto Purpose is optional and independently validated. Missing, blank, or
  // mismatched T is FALSE (safe default); it never affects category rule matching.
  let useAutoPurpose = false;
  if (sheet.getLastColumn() >= PFIS_RULE_AUTO_PURPOSE_COLUMN) {
    const autoPurposeHeader = pfisString(sheet.getRange(1, PFIS_RULE_AUTO_PURPOSE_COLUMN).getDisplayValue());
    useAutoPurpose = pfisHeaderToken(autoPurposeHeader) === pfisHeaderToken(PFIS_RULE_AUTO_PURPOSE_HEADER);
    if (!useAutoPurpose && autoPurposeHeader) {
      console.warn('Rules!T ignored because its header is not exactly "Auto Purpose".');
    }
  }
  const autoPurposeValues = useAutoPurpose && baseRows.length
    ? sheet.getRange(2, PFIS_RULE_AUTO_PURPOSE_COLUMN, baseRows.length, 1).getValues()
    : [];

  // U: Purpose Trigger and V: Calendar Scope are independent optional extensions.
  // They are opt-in and do not alter existing A:T workbooks.
  const purposeTriggerHeader = sheet.getLastColumn() >= PFIS_RULE_PURPOSE_TRIGGER_COLUMN
    ? pfisString(sheet.getRange(1, PFIS_RULE_PURPOSE_TRIGGER_COLUMN).getDisplayValue()) : '';
  const usePurposeTrigger = pfisHeaderToken(purposeTriggerHeader) === pfisHeaderToken(PFIS_RULE_PURPOSE_TRIGGER_HEADER);
  const purposeTriggerValues = usePurposeTrigger && baseRows.length
    ? sheet.getRange(2, PFIS_RULE_PURPOSE_TRIGGER_COLUMN, baseRows.length, 1).getDisplayValues()
    : [];

  const calendarScopeHeader = sheet.getLastColumn() >= PFIS_RULE_CALENDAR_SCOPE_COLUMN
    ? pfisString(sheet.getRange(1, PFIS_RULE_CALENDAR_SCOPE_COLUMN).getDisplayValue()) : '';
  const useCalendarScope = pfisHeaderToken(calendarScopeHeader) === pfisHeaderToken(PFIS_RULE_CALENDAR_SCOPE_HEADER);
  const calendarScopeValues = useCalendarScope && baseRows.length
    ? sheet.getRange(2, PFIS_RULE_CALENDAR_SCOPE_COLUMN, baseRows.length, 1).getDisplayValues()
    : [];

  const budgetOffsetHeader = sheet.getLastColumn() >= 23
    ? pfisString(sheet.getRange(1, 23).getDisplayValue()) : '';
  const useBudgetOffset = pfisHeaderToken(budgetOffsetHeader) === 'budgetmonthoffset';
  const budgetOffsetValues = useBudgetOffset && baseRows.length
    ? sheet.getRange(2, 23, baseRows.length, 1).getValues()
    : [];

  if (purposeTriggerHeader && !usePurposeTrigger) {
    console.warn('Rules!U ignored because its header is not exactly "Purpose Trigger".');
  }
  if (calendarScopeHeader && !useCalendarScope) {
    console.warn('Rules!V ignored because its header is not exactly "Calendar Scope".');
  }

  const mappedRows = baseRows.map(function (row, i) {
    const obj = pfisObjectFromRow(row, PFIS_RULE_FIELDS);
    if (useOptional) {
      PFIS_RULE_OPTIONAL_FIELDS.forEach(function (field, j) { obj[field] = extraRows[i][j]; });
    } else {
      PFIS_RULE_OPTIONAL_FIELDS.forEach(function (field) { obj[field] = ''; });
    }
    obj.autoPurpose = useAutoPurpose ? pfisTruthy(autoPurposeValues[i][0]) : false;
    obj.purposeTrigger = usePurposeTrigger ? pfisString(purposeTriggerValues[i][0]).toUpperCase() : '';
    obj.calendarScope = useCalendarScope ? pfisString(calendarScopeValues[i][0]).toUpperCase() : '';
    const budgetOffset = useBudgetOffset ? Number(budgetOffsetValues[i][0]) : 0;
    obj.budgetMonthOffset = isFinite(budgetOffset) ? Math.trunc(budgetOffset) : 0;
    obj.rowNumber = i + 2;
    return obj;
  });
  PFIS_RUNTIME_RULE_CACHE = mappedRows;
  return mappedRows.map(function (row) { return Object.assign({}, row); });
}

function pfisGetConfigRows() {
  if (PFIS_RUNTIME_CONFIG_CACHE !== null) return PFIS_RUNTIME_CONFIG_CACHE.map(function (row) { return Object.assign({}, row); });
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.config);
  const rows = pfisReadFixedRows(sheet, PFIS_CONFIG_FIELDS.length);
  let textPatterns = [];
  if (rows.length > 0 && sheet.getLastColumn() >= PFIS_CONFIG_TEXT_PATTERN_COLUMN) {
    const header = pfisString(sheet.getRange(1, PFIS_CONFIG_TEXT_PATTERN_COLUMN).getDisplayValue());
    if (pfisHeaderToken(header) === pfisHeaderToken(PFIS_CONFIG_TEXT_PATTERN_HEADER)) {
      textPatterns = sheet.getRange(2, PFIS_CONFIG_TEXT_PATTERN_COLUMN, rows.length, 1).getDisplayValues().map(function (r) { return pfisString(r[0]); });
    } else if (header) {
      console.warn('Config!J ignored because its header is not exactly "Text Pattern".');
    }
  }
  PFIS_RUNTIME_CONFIG_CACHE = rows.map(function (row, i) {
    const cfg = pfisObjectFromRow(row, PFIS_CONFIG_FIELDS);
    cfg.textPattern = textPatterns[i] || '';
    cfg.rowNumber = i + 2;
    return cfg;
  });
  return PFIS_RUNTIME_CONFIG_CACHE.map(function (row) { return Object.assign({}, row); });
}

function pfisResolveConfig(parsed, rawEvidence) {
  const defaults = { account: '', cardName: '', instrument: parsed.instrument || '', isInternal: false, ambiguous: false, unresolved: true };
  const identifier = pfisNormalizeAccountIdentifier(pfisExtractAccountIdentifier(rawEvidence));
  const bankKey = pfisNormalizeBank(parsed.bank);
  const typeKey = pfisNormalizeAccountType(parsed.accountType);
  const merchantKey = pfisNormalizeMerchant(parsed.merchant);
  const rawText = pfisSanitizeRawText(rawEvidence, false);
  const rawKey = pfisNormalizeMerchant(rawText);
  // Card-product identity is taken from the issuer/product part before "at MERCHANT".
  const cardContextText = rawText.split(/\bat\s+/i)[0];
  const cardContextKey = pfisNormalizeMerchant(cardContextText);
  const cardContextCompact = cardContextKey.replace(/\s+/g, '');
  const configs = pfisGetConfigRows();

  const candidates = [];
  configs.forEach(function (cfg, i) {
    if (!pfisString(cfg.bank) && !pfisString(cfg.accountType) && !pfisString(cfg.accountCardSuffix) && !pfisString(cfg.merchantContains) && !pfisString(cfg.textPattern)) return;
    if (pfisString(cfg.bank) && pfisNormalizeBank(cfg.bank) !== bankKey) return;
    const cfgType = pfisNormalizeAccountType(cfg.accountType);
    if (cfgType && typeKey && cfgType !== typeKey) return;
    const cfgMerchant = pfisNormalizeMerchant(cfg.merchantContains);
    if (cfgMerchant && merchantKey.indexOf(cfgMerchant) < 0) return;

    const configuredSuffixRaw = pfisCleanText(cfg.accountCardSuffix);
    const suffixCompact = configuredSuffixRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
    const numericSuffix = !!configuredSuffixRaw && /^(?:[x*]{0,8}\d{2,8}|\d{4,8})$/i.test(configuredSuffixRaw.replace(/[\s-]/g, ''));
    const textPattern = pfisNormalizeMerchant(cfg.textPattern);
    const textPatternMatched = !!textPattern && !!rawKey && rawKey.indexOf(textPattern) >= 0;
    let specificity = (pfisString(cfg.bank) ? 1 : 0) + (cfgType ? 1 : 0) + (cfgMerchant ? 2 : 0);
    let identityEvidence = false;

    if (numericSuffix) {
      const cfgId = pfisNormalizeConfiguredSuffix(configuredSuffixRaw);
      // If evidence exposes a suffix, it must agree. If no suffix is exposed, a
      // workbook-authored Text Pattern can serve as the alternate unique identity.
      if (identifier && (!cfgId || cfgId !== identifier)) return;
      if (!identifier && !textPatternMatched) return;
      if (identifier) { specificity += 8; identityEvidence = true; }
    } else if (configuredSuffixRaw) {
      // Some existing rows use symbolic aliases in the suffix column (e.g.
      // AIRTELAXIS_CC / AMAZONPAY_CC). Treat them as product hints, not digits.
      const alias = suffixCompact.replace(/(?:creditcard|debitcard|cc|card)$/i, '');
      const aliasMatched = !!alias && cardContextCompact.indexOf(alias) >= 0;
      if (aliasMatched) { specificity += 6; identityEvidence = true; }
    }

    if (textPattern) {
      if (!textPatternMatched) return;
      specificity += 7;
      identityEvidence = true;
    }

    const cardName = pfisNormalizeMerchant(cfg.cardName);
    const distinctiveCardTokens = cardName.split(' ').filter(function (token) {
      return token.length >= 4 && ['credit', 'debit', 'card', 'bank', 'account', 'savings', 'axis', 'sbi', 'icici', 'state', 'indian'].indexOf(token) < 0;
    });
    if (distinctiveCardTokens.length && distinctiveCardTokens.some(function (token) {
      return cardContextKey.indexOf(token) >= 0;
    })) {
      specificity += 4;
      identityEvidence = true;
    }

    const priorityText = pfisString(cfg.priority);
    const priority = priorityText !== '' && isFinite(Number(priorityText)) ? Number(priorityText) : 999;
    candidates.push({ cfg: cfg, specificity: specificity, priority: priority, order: i, identityEvidence: identityEvidence });
  });

  if (!candidates.length) return defaults;
  candidates.sort(function (a, b) { return b.specificity - a.specificity || a.priority - b.priority || a.order - b.order; });
  const bestSpecificity = candidates[0].specificity;
  // Priority is for display/order, not proof of card identity. If top-specificity
  // candidates point at different ledger accounts/cards, stop for review instead
  // of assigning the lowest-priority number's card silently.
  const top = candidates.filter(function (candidate) { return candidate.specificity === bestSpecificity; });
  const signatures = pfisUnique(top.map(function (candidate) {
    const cfg = candidate.cfg;
    return JSON.stringify([pfisCleanText(cfg.account), pfisCleanText(cfg.cardName), pfisCleanText(cfg.instrument), pfisTruthy(cfg.isInternal)]);
  }));
  if (signatures.length > 1) {
    console.warn('Ambiguous Config mapping; top candidates disagree: ' + top.map(function (candidate) { return candidate.order + 2; }).join(', '));
    return {
      account: '', cardName: '', instrument: defaults.instrument,
      isInternal: false, ambiguous: true, unresolved: false,
      ambiguousRows: top.map(function (candidate) { return candidate.order + 2; })
    };
  }

  const best = top[0];
  const cfg = best.cfg;
  return {
    account: pfisCleanText(cfg.account), cardName: pfisCleanText(cfg.cardName),
    instrument: pfisCleanText(cfg.instrument) || defaults.instrument,
    isInternal: pfisTruthy(cfg.isInternal) && !!pfisNormalizeMerchant(cfg.merchantContains),
    ambiguous: false, unresolved: false, rowNumber: best.order + 2,
    identityEvidence: !!best.identityEvidence
  };
}
function pfisGetCategoryList() {
  if (PFIS_RUNTIME_CATEGORY_CACHE !== null) return PFIS_RUNTIME_CATEGORY_CACHE.slice();
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.categories);
  const categories = [];
  pfisReadFixedRows(sheet, PFIS_CATEGORY_FIELDS.length).forEach(function (row) {
    const category = pfisCleanText(row[0]);
    const active = row[1];
    if (!category) return;
    // A blank Active cell remains active for backwards compatibility; explicit
    // FALSE/INACTIVE disables the category. Do not fall back to hidden defaults.
    if (pfisString(active) && !pfisIsActive(active)) return;
    if (categories.indexOf(category) < 0) categories.push(category);
  });
  PFIS_RUNTIME_CATEGORY_CACHE = categories;
  return categories.slice();
}

function pfisApplyNotesTemplate(template, dateValue, monthOffset) {
  if (!template) return '';
  const date = pfisParseDateValue(dateValue) || new Date();
  // Derive the source calendar month in the declared PFIS time zone, not the
  // Apps Script runtime zone, so a UTC-midnight boundary cannot shift monthLabel.
  const year = Number(Utilities.formatDate(date, PFIS_TIME_ZONE, 'yyyy'));
  const month = Number(Utilities.formatDate(date, PFIS_TIME_ZONE, 'M'));
  const offsetInput = Number(monthOffset || 0);
  const offset = isFinite(offsetInput) ? Math.trunc(offsetInput) : 0;
  const monthIndex = year * 12 + (month - 1) + offset;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex - targetYear * 12 + 1;
  const target = pfisCreateIndiaDate(targetYear, targetMonth, 1, 12, 0, 0);
  const label = Utilities.formatDate(target, PFIS_TIME_ZONE, 'MMM-yy');
  return String(template).replace(/\{\{?monthLabel\}\}?/g, label);
}

// -----------------------------------------------------------------------------
// Date/amount/input normalization
// -----------------------------------------------------------------------------

function pfisNormalizeSourceDatePrecision(parsed, evidenceText) {
  if (!parsed || !(parsed.datetime instanceof Date) || parsed.datePrecision !== 'DATETIME') return parsed;
  const time = Utilities.formatDate(parsed.datetime, PFIS_TIME_ZONE, 'HH:mm:ss');
  const raw = String(evidenceText || '');
  const hasClockTime = /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(raw) ||
    /\b\d{1,2}\s*(?:AM|PM)\b/i.test(raw);
  if (time === '00:00:00' && !hasClockTime) parsed.datePrecision = 'DATE_ONLY';
  return parsed;
}

function pfisParseTxnString(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('|').map(function (value) { return String(value === undefined || value === null ? '' : value).trim(); });
  // Some Shortcuts concatenate an optional leading value as " | datetime|...".
  // Accept only the unambiguous case: 11 fields with the first field empty. Do
  // not guess how to repair arbitrary missing middle fields because that shifts
  // the meaning of amount/account/type/merchant fields.
  if (parts.length === 11 && parts[0] === '') parts.shift();
  if (parts.length !== 10) return null;
  const dateInfo = pfisParseInputDate(parts[0]);
  const amount = pfisParseAmount(parts[1], false);
  const bank = pfisCleanText(parts[2]);
  const accountType = pfisCleanText(parts[3]); // optional by contract
  const instrument = pfisCleanText(parts[4]);
  const type = pfisNormalizeType(parts[5]);
  const merchant = pfisCleanText(parts[6]);
  const counterparty = pfisCleanText(parts[7]);
  const refNo = pfisCleanText(parts[8]);
  const balanceAfter = pfisParseAmount(parts[9], true);
  if (!dateInfo || !isFinite(amount) || amount === 0 || !bank) return null;
  return {
    datetime: dateInfo.date, datePrecision: dateInfo.precision, amount: amount, bank: bank,
    accountType: accountType, instrument: instrument, type: type, merchant: merchant,
    counterparty: counterparty, refNo: refNo, balanceAfter: balanceAfter
  };
}

function pfisParseInputDate(value) {
  const text = pfisString(value);
  if (!text) return null;
  const hasExplicitTime = /(?:T|\s)\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?\s*(?:AM|PM)?(?:\s*(?:IST|Z|[+-]\d{2}:?\d{2}))?$/i.test(text);
  let date = null;
  // Strict Indian DD-MM-YY/ DD-MM-YYYY formats used by bank alerts.
  let m = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:[, T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(IST|Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (m) {
    const day = Number(m[1]); const month = Number(m[2]);
    let year = Number(m[3]); if (year < 100) year += 2000;
    let hour = Number(m[4] || 0); const minute = Number(m[5] || 0); const second = Number(m[6] || 0);
    const ampm = pfisString(m[7]).toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    if (!pfisValidCalendarDate(null, year, month, day, hour, minute, second)) return null;
    if (m[8]) {
      let zone = m[8].toUpperCase();
      if (zone === 'IST') zone = '+05:30';
      if (zone === 'Z') zone = '+00:00';
      if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ':' + zone.slice(3);
      const iso = year + '-' + pfisPad2(month) + '-' + pfisPad2(day) + 'T' + pfisPad2(hour) + ':' + pfisPad2(minute) + ':' + pfisPad2(second) + zone;
      date = new Date(iso);
    } else {
      date = pfisCreateIndiaDate(year, month, day, hour, minute, second);
    }
    if (isNaN(date.getTime())) return null;
    return { date: date, precision: hasExplicitTime ? 'DATETIME' : 'DATE_ONLY' };
  }
  // ISO yyyy-MM-dd with optional time/offset. A timestamp without an explicit
  // zone is interpreted in PFIS_TIME_ZONE, never in the script runtime's zone.
  m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s+)?(.*)$/);
  if (m) {
    const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
    const rest = pfisString(m[4]);
    if (!rest) {
      if (!pfisValidCalendarDate(null, year, month, day, 0, 0, 0)) return null;
      return { date: pfisCreateIndiaDate(year, month, day, 0, 0, 0), precision: 'DATE_ONLY' };
    }
    const timeMatch = rest.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(AM|PM)?\s*(IST|Z|[+-]\d{2}:?\d{2})?$/i);
    if (timeMatch) {
      let hour = Number(timeMatch[1]); const minute = Number(timeMatch[2]); const second = Number(timeMatch[3] || 0);
      const millis = Number((timeMatch[4] || '').padEnd(3, '0').slice(0, 3) || 0);
      const ampm = pfisString(timeMatch[5]).toUpperCase();
      if (ampm === 'PM' && hour < 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      if (!pfisValidCalendarDate(null, year, month, day, hour, minute, second)) return null;
      const zoneText = pfisString(timeMatch[6]).toUpperCase();
      if (zoneText) {
        let zone = zoneText === 'IST' ? '+05:30' : (zoneText === 'Z' ? '+00:00' : zoneText);
        if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ':' + zone.slice(3);
        date = new Date(year + '-' + pfisPad2(month) + '-' + pfisPad2(day) + 'T' + pfisPad2(hour) + ':' + pfisPad2(minute) + ':' + pfisPad2(second) + (millis ? '.' + String(millis).padStart(3, '0') : '') + zone);
      } else {
        date = pfisCreateIndiaDate(year, month, day, hour, minute, second, millis);
      }
      if (isNaN(date.getTime())) return null;
      return { date: date, precision: hasExplicitTime ? 'DATETIME' : 'DATE_ONLY' };
    }
    return null;
  }
  return null;
}

function pfisParseDateValue(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (value === '' || value === null || value === undefined) return null;
  const parsed = pfisParseInputDate(String(value));
  if (parsed) return parsed.date;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function pfisValidCalendarDate(date, year, month, day, hour, minute, second) {
  // Validate the requested calendar components, not the normalized Date object.
  // E.g. JavaScript otherwise turns 31 February into a date in March.
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function pfisCreateIndiaDate(year, month, day, hour, minute, second, millisecond) {
  // Explicit UTC arithmetic makes this independent of the Apps Script project's
  // configured time zone. India Standard Time is UTC+05:30 year-round.
  return new Date(Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisecond || 0) - (5 * 60 + 30) * 60 * 1000);
}

function pfisParseAmount(value, allowBlank) {
  if (value === undefined || value === null || String(value).trim() === '') return allowBlank ? '' : NaN;
  if (typeof value === 'number') return isFinite(value) ? value : (allowBlank ? '' : NaN);
  let text = String(value).trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (/^-/.test(text)) negative = true;
  text = text.replace(/[₹$€£,\s]/g, '').replace(/^[+-]/, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return allowBlank ? '' : NaN;
  const amount = Number(text);
  if (!isFinite(amount)) return allowBlank ? '' : NaN;
  return negative ? -amount : amount;
}

function pfisExtractAccountIdentifier(rawEvidence) {
  const text = pfisSanitizeRawText(rawEvidence, false);
  if (!text) return '';
  const patterns = [
    /\b(?:a\/c|account)\s*(?:no\.?|number|#)\s*[:.-]?\s*([xX*]{2,}\s*\d{0,8}|\d{4,8})/i,
    /\bcard\s*(?:no\.?|number|#)\s*[:.-]?\s*([xX*]{2,}\s*\d{0,8}|\d{4,8})/i,
    /\b(?:ending|ends?\s+in|last\s+(?:four|4|digits?))\s*[:.-]?\s*(?:[xX*]{2,}\s*)?(\d{4})\b/i,
    /\b(?:a\/c|account|card)\s*[:.-]?\s*([xX*]{2,}\s*\d{0,8}|\d{4,8})/i
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = text.match(patterns[i]);
    if (match && match[1]) return String(match[1]).replace(/\s+/g, '').trim();
  }
  return '';
}

function pfisNormalizeAccountIdentifier(value) {
  let token = pfisCleanText(value).toLowerCase().replace(/[\s-]/g, '');
  if (!token || /^(?:x+|\*+|na|n\/a|unknown|none|null|notavailable|xx|-)$/i.test(token)) return '';
  const masked = token.match(/^[x*]+(\d{2,8})$/i);
  if (masked) return 'suffix:' + masked[1].slice(-4);
  if (/^\d{4,8}$/.test(token)) return 'suffix:' + token.slice(-4);
  // Don't allow arbitrary descriptive words to act as identity.
  if (!/[0-9]/.test(token)) return '';
  return 'id:' + token.replace(/[^a-z0-9]/g, '');
}

function pfisNormalizeConfiguredSuffix(value) {
  // Never guess a lost leading zero. Config suffixes must be preserved as text;
  // if Sheets already converted '0156' to numeric 156, it cannot safely match.
  const clean = pfisCleanText(value).toLowerCase().replace(/[\s-]/g, '');
  if (!clean) return '';
  return pfisNormalizeAccountIdentifier(clean);
}

function pfisFormatAccountType(value) {
  const key = pfisNormalizeAccountType(value);
  if (key === 'creditcard') return 'Credit Card';
  if (key === 'savingsaccount') return 'Savings Account';
  if (key === 'currentaccount') return 'Current Account';
  if (key === 'wallet') return 'Wallet';
  if (key === 'cash') return 'Cash';
  return pfisCleanText(value);
}

function pfisNormalizeAccountType(value) {
  const text = pfisCleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!text || ['na', 'unknown', 'none', 'null', 'notavailable', 'unavailable'].indexOf(text) >= 0) return '';
  if (text.indexOf('creditcard') >= 0 || text === 'cc') return 'creditcard';
  if (text.indexOf('savings') >= 0 || text === 'saving' || text === 'sb') return 'savingsaccount';
  if (text.indexOf('currentaccount') >= 0 || text === 'current') return 'currentaccount';
  if (text.indexOf('wallet') >= 0) return 'wallet';
  if (text === 'cash') return 'cash';
  return text;
}

function pfisNormalizeBank(value) {
  const text = pfisCleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!text) return '';
  const known = [
    [['axis', 'axisbank'], 'axis'], [['hdfc', 'hdfcbank'], 'hdfc'],
    [['icici', 'icicibank'], 'icici'], [['sbicard', 'statebankofindiacard'], 'sbicard'],
    [['sbi', 'statebankofindia'], 'sbi'], [['kotak', 'kotakmahindra'], 'kotak'],
    [['idfc', 'idfcbank'], 'idfc'], [['yesbank', 'yes'], 'yesbank'],
    [['indusind', 'indusindbank'], 'indusind'], [['pnb', 'punjabnationalbank'], 'pnb']
  ];
  for (let i = 0; i < known.length; i++) {
    if (known[i][0].some(function (part) { return text.indexOf(part) >= 0; })) return known[i][1];
  }
  return text;
}

function pfisNormalizeMerchant(value) {
  return pfisCleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pfisIsMatchableMerchant(value) {
  const key = typeof value === 'string' ? value : pfisNormalizeMerchant(value);
  return !!key && ['na', 'n a', 'unknown', 'unspecified', 'none', 'not available', 'notprovided', 'null'].indexOf(key) < 0;
}

function pfisNormalizeReference(value) {
  const text = pfisCleanText(value).toLowerCase().replace(/\s+/g, '');
  return ['na', 'n/a', 'unknown', 'none', 'null', 'notavailable', '-'].indexOf(text) >= 0 ? '' : text;
}

function pfisNormalizeType(value) {
  const raw = pfisCleanText(value).toLowerCase().replace(/[ -]+/g, '_');
  if (PFIS_VALID_TYPES.indexOf(raw) >= 0) return raw;
  const compact = raw.replace(/_/g, '');
  const aliases = {
    'cardpayment': 'card_payment', 'creditcardpayment': 'card_payment', 'creditcardbill': 'card_payment',
    'investmentandsavings': 'investment', 'savingandinvestment': 'investment', 'refunds': 'refund'
  };
  return aliases[compact] || '';
}

function pfisNormalizeRuleMatchType(value) {
  const token = pfisCleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (['CONTAINS', 'MERCHANT', 'MERCHANTCONTAINS', 'KEYWORD', 'TEXT'].indexOf(token) >= 0) return 'MERCHANT';
  if (['AMOUNT', 'EXACTAMOUNT'].indexOf(token) >= 0) return 'AMOUNT';
  if (['AMOUNTCONTAINS', 'CONTAINSAMOUNT', 'AMOUNTMERCHANT', 'AMOUNTANDCONTAINS', 'AMOUNTANDMERCHANT', 'MERCHANTAMOUNT'].indexOf(token) >= 0) return 'AMOUNTMERCHANT';
  return token;
}

function pfisSameMoney(a, b) {
  const x = Number(a); const y = Number(b);
  return isFinite(x) && isFinite(y) && Math.round(x * 100) === Math.round(y * 100);
}

function pfisIsPrecision(value) { return String(value || '').toUpperCase() === 'DATETIME'; }

function pfisSameCalendarDay(a, b) {
  const da = pfisParseDateValue(a); const db = pfisParseDateValue(b);
  if (!da || !db) return false;
  return Utilities.formatDate(da, PFIS_TIME_ZONE, 'yyyy-MM-dd') === Utilities.formatDate(db, PFIS_TIME_ZONE, 'yyyy-MM-dd');
}

// -----------------------------------------------------------------------------
// Positional sheet access and schema validation
// -----------------------------------------------------------------------------

function pfisGetSpreadsheet() {
  const override = pfisString(PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID);
  const id = override || pfisString(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
  if (!id) throw pfisError('CONFIG_MISSING', 'Set Script Property SPREADSHEET_ID to the target Google Spreadsheet ID.');
  if (PFIS_RUNTIME_SPREADSHEET_CACHE && PFIS_RUNTIME_SPREADSHEET_CACHE_ID === id) return PFIS_RUNTIME_SPREADSHEET_CACHE;
  let spreadsheet;
  try { spreadsheet = SpreadsheetApp.openById(id); }
  catch (error) { throw pfisError('SPREADSHEET_ACCESS_ERROR', 'Cannot open configured spreadsheet. Verify SPREADSHEET_ID and execution permissions.'); }
  PFIS_RUNTIME_SPREADSHEET_CACHE_ID = id;
  PFIS_RUNTIME_SPREADSHEET_CACHE = spreadsheet;
  return spreadsheet;
}

function pfisGetRequiredSheet(name) {
  const sheet = pfisGetSpreadsheet().getSheetByName(name);
  if (!sheet) throw pfisError('SCHEMA_INVALID', 'Required sheet not found: ' + name);
  return sheet;
}

function pfisReadFixedRows(sheet, width) {
  if (sheet.getLastRow() <= 1) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
}


/**
 * Finds the first logically blank row. It never reuses a row with other data or
 * formulas even when its key cell is blank. The only permitted nonblank values
 * are literal FALSE defaults in documented PFIS checkbox columns on an otherwise
 * empty Transaction Log or Source Log row. Empty dropdown validations/formatting
 * do not count as data. Searches through the used-row boundary, then appends.
 */
function pfisGetNextAvailableRow(sheet, keyColIndex) {
  const col = Number(keyColIndex) > 0 ? Math.floor(Number(keyColIndex)) : 1;
  const lastUsedRow = Math.max(1, Number(sheet.getLastRow()) || 1);
  if (lastUsedRow <= 1) {
    if (sheet.getMaxRows() < 2) sheet.insertRowsAfter(sheet.getMaxRows(), 2 - sheet.getMaxRows());
    return 2;
  }

  // Do not trust a blank key cell alone: a partially damaged row could still
  // contain audit data. A row may be reused only when every cell is blank,
  // except literal FALSE values in known checkbox columns that commonly pollute
  // unused PFIS rows. Formula cells always make a row occupied.
  const width = Math.max(col, Number(sheet.getLastColumn()) || col);
  const range = sheet.getRange(2, 1, lastUsedRow - 1, width);
  const values = range.getValues();
  const formulas = range.getFormulas();
  const name = typeof sheet.getName === 'function' ? sheet.getName() : '';
  const ignorableCheckboxColumns = name === PFIS_SHEETS.transactions ? [13, 14, 15, 36, 37] :
    (name === PFIS_SHEETS.sources ? [19] : []);

  for (let rowIndex = 0; rowIndex < values.length; rowIndex++) {
    const key = values[rowIndex][col - 1];
    if (!(key === '' || key === null || key === undefined || (typeof key === 'string' && key.trim() === ''))) continue;

    let logicallyBlank = true;
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      if (formulas[rowIndex][columnIndex]) { logicallyBlank = false; break; }
      const value = values[rowIndex][columnIndex];
      if (value === '' || value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) continue;
      const oneBasedColumn = columnIndex + 1;
      if (value === false && ignorableCheckboxColumns.indexOf(oneBasedColumn) >= 0) continue;
      logicallyBlank = false;
      break;
    }
    if (logicallyBlank) return rowIndex + 2;
  }

  const next = lastUsedRow + 1;
  if (next > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), next - sheet.getMaxRows());
  return next;
}

/**
 * Finds a safe contiguous blank block for a multi-row append. It checks both
 * the key column and the data columns before reusing a gap, so a partial/malformed
 * log row is not silently overwritten. Falls back to a new block below lastRow.
 */
function pfisGetNextAvailableBlock(sheet, keyColIndex, rowCount, dataColCount) {
  const col = Number(keyColIndex) > 0 ? Math.floor(Number(keyColIndex)) : 1;
  const count = Math.max(1, Math.floor(Number(rowCount) || 1));
  const width = Math.max(col, Math.floor(Number(dataColCount) || col));
  const lastUsedRow = Math.max(1, Number(sheet.getLastRow()) || 1);
  if (lastUsedRow >= 2) {
    const dataRange = sheet.getRange(2, 1, lastUsedRow - 1, width);
    const rows = dataRange.getValues();
    const formulas = dataRange.getFormulas();
    let runStart = -1;
    let runLength = 0;
    for (let i = 0; i < rows.length; i++) {
      const key = rows[i][col - 1];
      const allBlank = rows[i].every(function (value, index) { return (value === '' || value === null || value === undefined) && !formulas[i][index]; });
      if ((key === '' || key === null || key === undefined) && allBlank) {
        if (runStart < 0) runStart = i + 2;
        runLength++;
        if (runLength >= count) return runStart;
      } else {
        runStart = -1;
        runLength = 0;
      }
    }
  }
  const target = lastUsedRow + 1;
  const finalRow = target + count - 1;
  if (finalRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), finalRow - sheet.getMaxRows());
  return target;
}

/**
 * Manual, conservative cleanup for legacy rows polluted only by default unchecked
 * checkboxes. Clears literal FALSE values in M:O and AJ:AK only when the row has
 * no Transaction ID, no formulas, and no other content anywhere in A:AM. It
 * preserves validations/dropdowns and never touches a row containing transaction
 * data. Run manually once after reviewing the reported count; not called on ingest.
 */
function pfisCleanupBlankTransactionCheckboxDefaults() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw pfisError('BUSY', 'Could not acquire the script lock for blank-row cleanup.');
  try {
    const sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
    const lastRow = Math.max(1, Number(sheet.getLastRow()) || 1);
    if (lastRow < 2) return { success: true, rowsChecked: 0, cellsCleared: 0 };
    const width = 39; // Workbook contract: Transaction Log A:AM.
    const range = sheet.getRange(2, 1, lastRow - 1, width);
    const values = range.getValues();
    const formulas = range.getFormulas();
    const checkboxCols = [13, 14, 15, 36, 37]; // M, N, O, AJ, AK (1-based)
    let cellsCleared = 0;
    const cellsToClear = [];
    for (let r = 0; r < values.length; r++) {
      if (pfisString(values[r][0]) !== '') continue; // Never touch a keyed transaction.
      let safe = true;
      for (let c = 0; c < width; c++) {
        if (formulas[r][c]) { safe = false; break; }
        const isTargetCheckbox = checkboxCols.indexOf(c + 1) >= 0;
        const val = values[r][c];
        if (isTargetCheckbox) {
          if (val === false) continue;
          if (val === '' || val === null || val === undefined) continue;
          safe = false; break;
        }
        if (!(val === '' || val === null || val === undefined)) { safe = false; break; }
      }
      if (!safe) continue;
      checkboxCols.forEach(function (col) {
        if (values[r][col - 1] === false) {
          cellsToClear.push(sheet.getRange(r + 2, col).getA1Notation());
          cellsCleared++;
        }
      });
    }
    // clearContent retains the cells' checkbox validation and formatting. Chunked RangeLists reduce service calls.
    for (let start = 0; start < cellsToClear.length; start += 100) {
      sheet.getRangeList(cellsToClear.slice(start, start + 100)).clearContent();
    }
    return {
      success: true, rowsChecked: values.length, cellsCleared: cellsCleared,
      message: 'Only literal FALSE defaults on fully otherwise-empty rows were cleared. No keyed transaction rows were changed.'
    };
  } finally {
    lock.releaseLock();
  }
}

function pfisReadTransactions() {
  if (PFIS_RUNTIME_TRANSACTION_CACHE !== null) {
    return PFIS_RUNTIME_TRANSACTION_CACHE.map(function (row) { return Object.assign({}, row); });
  }
  PFIS_RUNTIME_TRANSACTION_CACHE = pfisReadFixedRows(
    pfisGetRequiredSheet(PFIS_SHEETS.transactions), PFIS_TX_FIELDS.length
  ).map(function (row, i) {
    const obj = pfisObjectFromRow(row, PFIS_TX_FIELDS);
    obj.sheetRow = i + 2;
    return obj;
  }).filter(function (row) { return pfisString(row.transactionId) !== ''; });
  return PFIS_RUNTIME_TRANSACTION_CACHE.map(function (row) { return Object.assign({}, row); });
}

function pfisInvalidateTransactionCache() {
  PFIS_RUNTIME_TRANSACTION_CACHE = null;
}

function pfisFindTransactionRow(transactionId) {
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  if (!transactionId || sheet.getLastRow() <= 1) return -1;
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (pfisString(ids[i][0]) === pfisString(transactionId)) return i + 2;
  return -1;
}

function pfisFindRowByValue(sheet, column, value) {
  if (sheet.getLastRow() <= 1) return -1;
  const cells = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < cells.length; i++) if (pfisString(cells[i][0]) === pfisString(value)) return i + 2;
  return -1;
}

function pfisRowFromObject(object, fields) {
  return fields.map(function (field) {
    const value = object[field];
    return value === undefined || value === null ? '' : value;
  });
}

function pfisObjectFromRow(row, fields) {
  const object = {};
  fields.forEach(function (field, index) { object[field] = row[index] === undefined ? '' : row[index]; });
  return object;
}

function pfisAssertSchema() {
  return pfisPerfMeasure('schema_validation', function () {
    const result = pfisCheckWorkbookStructure();
    if (!result.success) {
      const problems = result.checks.filter(function (c) { return c.status !== 'OK'; })
        .map(function (c) { return c.sheet + ': ' + c.status + ' - ' + (c.message || ''); });
      throw pfisError('SCHEMA_INVALID', 'Operation blocked because the physical v1 schema is unsafe: ' + problems.join(' | '));
    }
    return result;
  });
}

function pfisCheckWorkbookStructure() {
  const checks = [];
  let success = true;
  PFIS_HEADER_DEFINITIONS.forEach(function (definition) {
    let sheet;
    try { sheet = pfisGetSpreadsheet().getSheetByName(definition.name); }
    catch (error) { sheet = null; }
    if (!sheet) {
      checks.push({ sheet: definition.name, status: 'MISSING', message: 'Required core sheet is missing.' });
      success = false; return;
    }
    if (sheet.getLastColumn() < definition.fields.length) {
      checks.push({ sheet: definition.name, status: 'INVALID', message: 'Expected at least ' + definition.fields.length + ' columns; detected ' + sheet.getLastColumn() + '.' });
      success = false; return;
    }
    const observed = sheet.getRange(1, 1, 1, Math.max(definition.fields.length, 1)).getValues()[0];
    const recognized = {};
    definition.headers.forEach(function (header, index) { recognized[pfisHeaderToken(header)] = index + 1; });
    const aliases = pfisKnownHeaderAliases(definition.name);
    Object.keys(aliases).forEach(function (alias) { recognized[pfisHeaderToken(alias)] = aliases[alias]; });
    const misplaced = [];
    for (let i = 0; i < definition.fields.length; i++) {
      const token = pfisHeaderToken(observed[i]);
      if (token && recognized[token] && recognized[token] !== i + 1) {
        misplaced.push('"' + observed[i] + '" at col ' + (i + 1) + ' (expected col ' + recognized[token] + ')');
      }
    }
    // Header text that is unknown or renamed is not used for mapping. A known
    // target field visibly moved to another position is a physical-layout error.
    if (misplaced.length) {
      checks.push({ sheet: definition.name, status: 'INVALID', message: 'Recognized schema fields are displaced: ' + misplaced.join(', ') });
      success = false; return;
    }
    const headerWarnings = [];
    for (let i = 0; i < definition.fields.length; i++) {
      const actual = pfisHeaderToken(observed[i]);
      const expected = pfisHeaderToken(definition.headers[i]);
      if (actual && actual !== expected && !aliases[pfisString(observed[i])]) {
        // Informational only: runtime field mapping remains positional.
        headerWarnings.push('col ' + (i + 1) + ' label differs from target label');
      }
    }
    checks.push({
      sheet: definition.name, status: 'OK', columnsRequired: definition.fields.length,
      columnsDetected: sheet.getLastColumn(), rows: Math.max(0, sheet.getLastRow() - 1),
      headerWarnings: headerWarnings.slice(0, 10)
    });
  });
  return { success: success, checks: checks };
}

function pfisKnownHeaderAliases(sheetName) {
  const maps = {};
  if (sheetName === PFIS_SHEETS.transactions) {
    maps['Date Time'] = 2; maps['Datetime'] = 2; maps['Signed Amount'] = 3; maps['Institution'] = 4;
    maps['Transaction Type'] = 9; maps['Recurring'] = 13; maps['NeedsReview'] = 15;
    maps['Reference No'] = 17; maps['Balance'] = 18; maps['ReviewStatus'] = 20;
  } else if (sheetName === PFIS_SHEETS.sources) {
    maps['SourceID'] = 1; maps['ReceivedAt'] = 2; maps['Channel'] = 3; maps['Body'] = 6;
    maps['Message Hash'] = 7; maps['Parser Name'] = 8; maps['Status'] = 9; maps['Extracted DateTime'] = 11;
    maps['Extracted Date Precision'] = 12; maps['Extracted Account Ref'] = 15;
    maps['Transaction ID'] = 16; maps['Txn ID'] = 16;
  } else if (sheetName === PFIS_SHEETS.changes) {
    maps['ChangeID'] = 1; maps['Txn ID'] = 2; maps['Timestamp'] = 3; maps['Table'] = 4; maps['Changed By'] = 5;
  } else if (sheetName === PFIS_SHEETS.categories) {
    maps['Category Name'] = 1; maps['Name'] = 1; maps['Enabled'] = 2; maps['Status'] = 2;
  }
  return maps;
}

function pfisValidateWorkbook(requestId) {
  const structure = pfisCheckWorkbookStructure();
  const issues = pfisDataIntegritySummary();
  const success = structure.success && issues.warnings.length === 0;
  return {
    success: success,
    status: !structure.success ? 'INVALID' : (issues.warnings.length ? 'VALID_WITH_WARNINGS' : 'VALID'),
    engineVersion: ENGINE_VERSION, schemaVersion: SCHEMA_VERSION, parserVersion: PARSER_VERSION,
    timeZoneExpected: PFIS_TIME_ZONE, checks: structure.checks, dataIntegrity: issues,
    generatedAt: new Date().toISOString(), requestId: requestId
  };
}

function PFIS_VALIDATE() {
  const result = pfisValidateWorkbook(Utilities.getUuid());
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Read-only physical schema diagnostic for the configured SPREADSHEET_ID. */
function PFIS_DIAGNOSE_SHEET_COLUMNS() {
  if (pfisString(PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID)) {
    throw pfisError('DIAGNOSTIC_SCOPE_ERROR', 'Run this diagnostic directly, not from inside a test override.');
  }
  const spreadsheet = pfisGetSpreadsheet();
  const structureReport = pfisCheckWorkbookStructure();
  const coreDefinitions = {};
  PFIS_HEADER_DEFINITIONS.forEach(function (definition) { coreDefinitions[definition.name] = definition; });
  const structureByName = {};
  structureReport.checks.forEach(function (check) { structureByName[check.sheet] = check; });
  const checks = spreadsheet.getSheets().map(function (sheet) {
    const name = sheet.getName();
    const definition = coreDefinitions[name] || null;
    const structure = structureByName[name] || null;
    const lastColumn = sheet.getLastColumn();
    const headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
    return {
      sheet: name, kind: definition ? 'CORE' : 'EXISTING_NON_CORE',
      status: definition ? (structure ? structure.status : 'UNKNOWN') : 'PRESERVE_UNCHANGED',
      lastRow: sheet.getLastRow(), lastColumn: lastColumn, actualHeaders: headers,
      expectedHeaders: definition ? definition.headers.slice() : null,
      structureMessage: structure && structure.message ? structure.message : '',
      expectedColumns: definition ? definition.fields.length : null
    };
  });
  const report = {
    success: structureReport.success,
    spreadsheetName: spreadsheet.getName(), spreadsheetId: spreadsheet.getId(),
    generatedAt: new Date().toISOString(), readOnly: true, checks: checks
  };
  Logger.log('PFIS_SCHEMA_DIAGNOSTIC ' + JSON.stringify(report, null, 2));
  return report;
}

function pfisDataIntegritySummary() {
  const warnings = [];
  let duplicateTransactionIds = 0;
  let duplicateSourceIds = 0;
  let brokenLinks = 0;
  let missingTransactionIds = 0;
  let missingSourceIds = 0;
  let unknownDatePrecision = 0;
  let sourceRows = 0;
  let transactionRows = 0;
  try {
    const txSheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
    const rawTxRows = pfisReadFixedRows(txSheet, PFIS_TX_FIELDS.length);
    const txIds = {};
    rawTxRows.forEach(function (row) {
      const hasData = row.some(function (value) { return value !== '' && value !== null && value !== undefined; });
      if (!hasData) return;
      transactionRows++;
      const transactionId = pfisString(row[0]);
      if (!transactionId) { missingTransactionIds++; return; }
      txIds[transactionId] = (txIds[transactionId] || 0) + 1;
    });
    duplicateTransactionIds = Object.keys(txIds).filter(function (id) { return txIds[id] > 1; }).length;

    const sourceSheet = pfisGetRequiredSheet(PFIS_SHEETS.sources);
    const rawSourceRows = pfisReadFixedRows(sourceSheet, PFIS_SOURCE_FIELDS.length);
    const sourceIds = {};
    rawSourceRows.forEach(function (row) {
      const hasData = row.some(function (value) { return value !== '' && value !== null && value !== undefined; });
      if (!hasData) return;
      sourceRows++;
      const source = pfisObjectFromRow(row, PFIS_SOURCE_FIELDS);
      const sourceId = pfisString(source.sourceId);
      if (!sourceId) missingSourceIds++;
      else sourceIds[sourceId] = (sourceIds[sourceId] || 0) + 1;

      const linked = pfisString(source.linkedTxnId);
      const parseStatus = pfisString(source.parseStatus).toUpperCase();
      if (linked && parseStatus !== 'SUPERSEDED' && !txIds[linked]) brokenLinks++;
      if (pfisString(source.extractedDate) && parseStatus !== 'SUPERSEDED' && parseStatus !== 'PARSE_FAILED' &&
        ['DATETIME', 'DATE_ONLY'].indexOf(pfisString(source.datePrecision).toUpperCase()) < 0) {
        unknownDatePrecision++;
      }
    });
    duplicateSourceIds = Object.keys(sourceIds).filter(function (id) { return sourceIds[id] > 1; }).length;

    if (duplicateTransactionIds) warnings.push('Duplicate Transaction ID groups: ' + duplicateTransactionIds);
    if (duplicateSourceIds) warnings.push('Duplicate Source ID groups: ' + duplicateSourceIds);
    if (missingTransactionIds) warnings.push('Non-empty Transaction Log rows with missing Transaction ID: ' + missingTransactionIds);
    if (missingSourceIds) warnings.push('Non-empty Source Log rows with missing Source ID: ' + missingSourceIds);
    if (brokenLinks) warnings.push('Source rows link to missing transactions: ' + brokenLinks);
    if (unknownDatePrecision) warnings.push('Source rows with extracted dates but unresolved Extracted Date Precision: ' + unknownDatePrecision);
  } catch (error) {
    warnings.push('Data integrity scan incomplete: ' + error.message);
  }
  return {
    transactionRows: transactionRows, sourceRows: sourceRows,
    duplicateTransactionIdGroups: duplicateTransactionIds, duplicateSourceIdGroups: duplicateSourceIds,
    missingTransactionIds: missingTransactionIds, missingSourceIds: missingSourceIds,
    brokenSourceLinks: brokenLinks, sourcesWithUnknownDatePrecision: unknownDatePrecision,
    warnings: warnings
  };
}

// -----------------------------------------------------------------------------
// Agent-facing bounded analytics/read tools
// -----------------------------------------------------------------------------

function pfisSearchTransactions(params, requestId) {
  const filters = params.filters && typeof params.filters === 'object' ? params.filters : params;
  const limit = pfisClampLimit(params.limit, 50);
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const bounds = pfisGetPeriodBounds(filters.period, filters.startDate, filters.endDate);
  const merchantFilter = pfisNormalizeMerchant(filters.merchant || '');
  const categoryFilter = pfisString(filters.category);
  const typeFilter = pfisNormalizeType(filters.type);
  const minAmount = filters.minAmount === undefined || filters.minAmount === '' ? null : Number(filters.minAmount);
  const maxAmount = filters.maxAmount === undefined || filters.maxAmount === '' ? null : Number(filters.maxAmount);
  const all = pfisReadTransactions().filter(function (tx) {
    const date = pfisParseDateValue(tx.dateTime);
    if (date && bounds.start && date < bounds.start) return false;
    if (date && bounds.endExclusive && date >= bounds.endExclusive) return false;
    if (merchantFilter && pfisNormalizeMerchant(tx.merchant).indexOf(merchantFilter) < 0) return false;
    if (categoryFilter && pfisString(tx.category) !== categoryFilter) return false;
    if (typeFilter && pfisNormalizeType(tx.type) !== typeFilter) return false;
    const amount = Number(tx.amount);
    if (minAmount !== null && (!isFinite(minAmount) || Math.abs(amount) < minAmount)) return false;
    if (maxAmount !== null && (!isFinite(maxAmount) || Math.abs(amount) > maxAmount)) return false;
    return true;
  }).sort(function (a, b) {
    const dateA = pfisParseDateValue(a.dateTime);
    const dateB = pfisParseDateValue(b.dateTime);
    const timeA = dateA ? dateA.getTime() : Number.NEGATIVE_INFINITY;
    const timeB = dateB ? dateB.getTime() : Number.NEGATIVE_INFINITY;
    if (timeA !== timeB) return timeB - timeA;
    return pfisString(a.transactionId).localeCompare(pfisString(b.transactionId));
  });
  return {
    success: true, status: 'OK', period: bounds.label, timeZone: PFIS_TIME_ZONE,
    generatedAt: new Date().toISOString(), totalMatches: all.length, limit: limit, offset: offset,
    complete: offset + limit >= all.length, data: all.slice(offset, offset + limit).map(pfisStripForAnalytics), requestId: requestId
  };
}

function pfisGetFinancialOverview(params, requestId) {
  const data = pfisPeriodTransactions(params);
  const totals = {
    income: 0, expenses: 0, refunds: 0, netConsumption: 0, investments: 0,
    cardPayments: 0, transfers: 0, internalTransfers: 0, cashFlowNet: 0
  };
  const counts = { total: data.transactions.length, review: 0, verified: 0 };
  data.transactions.forEach(function (tx) {
    const amount = Number(tx.amount) || 0; const type = pfisNormalizeType(tx.type);
    if (pfisTruthy(tx.needsReview)) counts.review++;
    if (pfisGetVerificationState(tx.transactionId, tx.validationFlag).status === 'VERIFIED') counts.verified++;
    if (type === 'income') totals.income += Math.max(0, amount);
    else if (type === 'expense') totals.expenses += Math.abs(amount);
    else if (type === 'refund') totals.refunds += Math.abs(amount);
    else if (type === 'investment') totals.investments += Math.abs(amount);
    else if (type === 'card_payment') totals.cardPayments += Math.abs(amount);
    else if (type === 'transfer') {
      totals.transfers += Math.abs(amount);
      if (pfisTruthy(tx.isInternalTransfer)) totals.internalTransfers += Math.abs(amount);
    }
    if (!pfisTruthy(tx.isInternalTransfer)) totals.cashFlowNet += amount;
  });
  totals.netConsumption = Math.max(0, totals.expenses - totals.refunds);
  return {
    success: true, status: 'OK', period: data.bounds.label, timeZone: PFIS_TIME_ZONE,
    generatedAt: new Date().toISOString(), metricVersion: 'PFIS_METRICS_v1', totals: totals, counts: counts,
    coverage: { transactionRows: data.transactions.length, note: 'Totals reflect captured and classified alerts, not guaranteed complete bank statement coverage.' }, requestId: requestId
  };
}

function pfisGetCategoryBreakdown(params, requestId) {
  const data = pfisPeriodTransactions(params); const buckets = {};
  data.transactions.forEach(function (tx) {
    const type = pfisNormalizeType(tx.type);
    if (['expense', 'refund'].indexOf(type) < 0 || pfisTruthy(tx.isInternalTransfer)) return;
    const category = pfisString(tx.category) || 'Uncategorized';
    if (!buckets[category]) buckets[category] = { category: category, grossExpenses: 0, refunds: 0, netConsumption: 0, transactionCount: 0 };
    if (type === 'expense') buckets[category].grossExpenses += Math.abs(Number(tx.amount) || 0);
    if (type === 'refund') buckets[category].refunds += Math.abs(Number(tx.amount) || 0);
    buckets[category].transactionCount++;
  });
  const result = Object.keys(buckets).map(function (key) {
    buckets[key].netConsumption = Math.max(0, buckets[key].grossExpenses - buckets[key].refunds); return buckets[key];
  }).sort(function (a, b) { return b.netConsumption - a.netConsumption; });
  return { success: true, period: data.bounds.label, timeZone: PFIS_TIME_ZONE, generatedAt: new Date().toISOString(), data: result, requestId: requestId };
}

function pfisGetMerchantAnalysis(params, requestId) {
  const data = pfisPeriodTransactions(params); const buckets = {};
  data.transactions.forEach(function (tx) {
    if (['expense', 'refund'].indexOf(pfisNormalizeType(tx.type)) < 0) return;
    const merchant = pfisString(tx.merchant) || 'Unspecified';
    if (!buckets[merchant]) buckets[merchant] = { merchant: merchant, grossExpenses: 0, refunds: 0, netConsumption: 0, transactionCount: 0 };
    if (pfisNormalizeType(tx.type) === 'expense') buckets[merchant].grossExpenses += Math.abs(Number(tx.amount) || 0);
    if (pfisNormalizeType(tx.type) === 'refund') buckets[merchant].refunds += Math.abs(Number(tx.amount) || 0);
    buckets[merchant].transactionCount++;
  });
  const results = Object.keys(buckets).map(function (merchant) {
    buckets[merchant].netConsumption = Math.max(0, buckets[merchant].grossExpenses - buckets[merchant].refunds); return buckets[merchant];
  }).sort(function (a, b) { return b.netConsumption - a.netConsumption; });
  const limit = pfisClampLimit(params.limit, 10);
  return { success: true, period: data.bounds.label, timeZone: PFIS_TIME_ZONE, generatedAt: new Date().toISOString(), totalMerchants: results.length, data: results.slice(0, limit), requestId: requestId };
}

function pfisGetRecurringCommitments(params, requestId) {
  const data = pfisPeriodTransactions(params);
  const results = data.transactions.filter(function (tx) { return pfisTruthy(tx.isRecurring); })
    .map(function (tx) {
      return {
        transactionId: tx.transactionId, dateTime: tx.dateTime, merchant: tx.merchant,
        amount: tx.amount, category: tx.category, type: tx.type, estimatedAnnualAmount: Math.abs(Number(tx.amount) || 0) * 12
      };
    })
    .sort(function (a, b) { return b.estimatedAnnualAmount - a.estimatedAnnualAmount; });
  return { success: true, period: data.bounds.label, generatedAt: new Date().toISOString(), data: results, requestId: requestId };
}

function pfisGetCashFlow(params, requestId) {
  const data = pfisPeriodTransactions(params);
  const totals = { income: 0, outflows: 0, refunds: 0, internalTransfersExcluded: 0, netCashFlow: 0, transactionCount: data.transactions.length };
  data.transactions.forEach(function (tx) {
    const amount = Number(tx.amount) || 0; const type = pfisNormalizeType(tx.type);
    if (type === 'income') totals.income += Math.max(0, amount);
    if (type === 'expense' || type === 'investment' || type === 'card_payment') totals.outflows += Math.abs(amount);
    if (type === 'refund') totals.refunds += Math.abs(amount);
    if (pfisTruthy(tx.isInternalTransfer)) totals.internalTransfersExcluded += Math.abs(amount);
    else totals.netCashFlow += amount;
  });
  return {
    success: true, period: data.bounds.label, generatedAt: new Date().toISOString(), totals: totals,
    note: 'Card payments are included in cash flow but excluded from consumption to avoid double-counting card purchases.', requestId: requestId
  };
}

function pfisGetSpendingBehavior(params, requestId) {
  const data = pfisPeriodTransactions(params); const weekdays = {};
  data.transactions.forEach(function (tx) {
    if (pfisNormalizeType(tx.type) !== 'expense') return;
    const date = pfisParseDateValue(tx.dateTime); if (!date) return;
    const day = Utilities.formatDate(date, PFIS_TIME_ZONE, 'EEEE');
    if (!weekdays[day]) weekdays[day] = { weekday: day, transactionCount: 0, grossSpend: 0 };
    weekdays[day].transactionCount++; weekdays[day].grossSpend += Math.abs(Number(tx.amount) || 0);
  });
  return {
    success: true, period: data.bounds.label, generatedAt: new Date().toISOString(), data: Object.keys(weekdays).map(function (k) { return weekdays[k]; }),
    note: 'Descriptive statistics only; do not infer intent or essential/discretionary status from timing alone.', requestId: requestId
  };
}

function pfisGetAnomalies(params, requestId) {
  const data = pfisPeriodTransactions(params);
  const duplicateRows = data.transactions.filter(function (tx) { return pfisString(tx.validationFlag).toUpperCase() === 'DUPLICATE_CANDIDATE'; });
  const conflicts = data.transactions.filter(function (tx) { return pfisString(tx.validationFlag).toUpperCase() === 'SOURCE_CONFLICT'; });
  const expenseAmounts = data.transactions.filter(function (tx) { return pfisNormalizeType(tx.type) === 'expense'; }).map(function (tx) { return Math.abs(Number(tx.amount) || 0); }).sort(function (a, b) { return a - b; });
  const median = expenseAmounts.length ? expenseAmounts[Math.floor(expenseAmounts.length / 2)] : 0;
  const highExpenses = data.transactions.filter(function (tx) {
    return pfisNormalizeType(tx.type) === 'expense' && median > 0 && Math.abs(Number(tx.amount) || 0) >= Math.max(median * 3, median + 1);
  }).map(pfisStripForAnalytics);

  // Flag, but never auto-merge, exact timestamp/amount/bank collisions across
  // different merchants. These are investigation candidates, not proof of fraud.
  const collisionBuckets = {};
  data.transactions.forEach(function (tx) {
    const date = pfisParseDateValue(tx.dateTime);
    const amount = Math.abs(Number(tx.amount) || 0).toFixed(2);
    const bank = pfisNormalizeBank(tx.bank);
    if (!date || !bank || Number(amount) === 0) return;
    const key = date.getTime() + '|' + bank + '|' + amount;
    if (!collisionBuckets[key]) collisionBuckets[key] = [];
    collisionBuckets[key].push(tx);
  });
  const sameTimestampAmountDifferentMerchants = Object.keys(collisionBuckets).map(function (key) {
    const group = collisionBuckets[key];
    const merchants = pfisUnique(group.map(function (tx) { return pfisNormalizeMerchant(tx.merchant); }).filter(Boolean));
    if (group.length < 2 || merchants.length < 2) return null;
    return {
      dateTime: group[0].dateTime, bank: group[0].bank, absoluteAmount: Math.abs(Number(group[0].amount) || 0),
      transactions: group.map(pfisStripForAnalytics),
      reason: 'Same bank, exact timestamp and absolute amount, but different merchants; manually verify before changing either record.'
    };
  }).filter(Boolean);
  const suspectedInventedMidnightTimestamps = pfisFindSuspectedInventedMidnightTimestamps(data.transactions);

  return {
    success: true, period: data.bounds.label, generatedAt: new Date().toISOString(),
    duplicateCandidates: duplicateRows.map(pfisStripForAnalytics), sourceConflictTransactions: conflicts.map(pfisStripForAnalytics),
    unusuallyLargeRelativeToPeriodMedian: highExpenses,
    sameTimestampAmountDifferentMerchants: sameTimestampAmountDifferentMerchants,
    suspectedInventedMidnightTimestamps: suspectedInventedMidnightTimestamps,
    method: 'Expense >= max(3x median, median + 1) is a relative-size heuristic. Timestamp/amount collisions and suspected invented midnight times are review signals, not proof of duplicates or fraud.',
    requestId: requestId
  };
}

/**
 * A conservative diagnostic for alerts stored as DATETIME at midnight when the
 * raw source text contains no clock time at all. It only flags records for review;
 * it never edits timestamps or source precision automatically.
 */
function pfisFindSuspectedInventedMidnightTimestamps(transactions) {
  const txs = Array.isArray(transactions) ? transactions : [];
  if (!txs.length) return [];
  const ids = {};
  txs.forEach(function (tx) { if (pfisString(tx.transactionId)) ids[tx.transactionId] = tx; });
  const sources = pfisReadFixedRows(pfisGetRequiredSheet(PFIS_SHEETS.sources), PFIS_SOURCE_FIELDS.length)
    .map(function (row) { return pfisObjectFromRow(row, PFIS_SOURCE_FIELDS); });
  const findings = [];
  sources.forEach(function (source) {
    const tx = ids[pfisString(source.linkedTxnId)];
    if (!tx || pfisString(source.parseStatus).toUpperCase() === 'SUPERSEDED') return;
    if (pfisString(source.datePrecision).toUpperCase() !== 'DATETIME') return;
    const sourceDate = pfisParseDateValue(source.extractedDate);
    if (!sourceDate || Utilities.formatDate(sourceDate, PFIS_TIME_ZONE, 'HH:mm:ss') !== '00:00:00') return;
    const raw = String(source.rawBody || '');
    // Any time-like token suppresses this heuristic because it may be source context
    // rather than transaction time; false negatives are preferred to risky rewrites.
    if (/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(raw) || /\b\d{1,2}\s*(?:AM|PM)\b/i.test(raw)) return;
    findings.push({
      transactionId: tx.transactionId, dateTime: tx.dateTime, merchant: tx.merchant,
      sourceId: source.sourceId, sourceType: source.sourceType,
      reason: 'Source is marked DATETIME at 00:00:00, but the raw message contains no clock time; verify date precision.'
    });
  });
  return pfisUniqueBy(findings, 'transactionId');
}

function pfisGetDataQuality(params, requestId) {
  const data = pfisPeriodTransactions(params);
  const activeCategories = pfisGetCategoryList();
  const result = {
    transactionCount: data.transactions.length, needsReview: 0, duplicateCandidates: 0, sourceConflicts: 0,
    missingMerchant: 0, missingCategory: 0, invalidCategory: 0, missingPurpose: 0, unknownType: 0, dateOnly: 0,
    suspectedInventedMidnightTimestamps: 0,
    verified: 0, smsOnly: 0, emailOnly: 0, unresolvedSourceConflicts: 0
  };
  data.transactions.forEach(function (tx) {
    const flag = pfisString(tx.validationFlag).toUpperCase();
    if (pfisTruthy(tx.needsReview) || pfisString(tx.reviewStatus).toUpperCase() === 'PENDING' ||
        ['DUPLICATE_CANDIDATE', 'SOURCE_CONFLICT', 'NEEDS_REVIEW'].indexOf(flag) >= 0) result.needsReview++;
    if (flag === 'DUPLICATE_CANDIDATE') result.duplicateCandidates++;
    if (flag === 'SOURCE_CONFLICT') result.sourceConflicts++;
    if (!pfisIsMatchableMerchant(pfisNormalizeMerchant(tx.merchant))) result.missingMerchant++;
    const category = pfisCleanText(tx.category);
    if (!category) result.missingCategory++;
    else if (activeCategories.indexOf(category) < 0) result.invalidCategory++;
    // A purpose equal to the merchant or a placeholder is still missing purpose.
    if (!pfisIsMeaningfulPurpose(tx.userNotes, tx.merchant)) result.missingPurpose++;
    if (!pfisNormalizeType(tx.type)) result.unknownType++;
    if (pfisGetTransactionDatePrecision(tx.transactionId) === 'DATE_ONLY') result.dateOnly++;
    const verification = pfisGetVerificationState(tx.transactionId, tx.validationFlag).status;
    if (verification === 'VERIFIED') result.verified++;
    else if (verification === 'SMS_ONLY') result.smsOnly++;
    else if (verification === 'EMAIL_ONLY') result.emailOnly++;
  });
  result.suspectedInventedMidnightTimestamps = pfisFindSuspectedInventedMidnightTimestamps(data.transactions).length;
  const sourceBounds = pfisGetPeriodBounds(params.period, params.startDate, params.endDate);
  result.unresolvedSourceConflicts = pfisReadFixedRows(pfisGetRequiredSheet(PFIS_SHEETS.sources), PFIS_SOURCE_FIELDS.length)
    .map(function (row) { return pfisObjectFromRow(row, PFIS_SOURCE_FIELDS); })
    .filter(function (source) {
      if (pfisString(source.parseStatus).toUpperCase() !== 'CONFLICT') return false;
      const date = pfisParseDateValue(source.extractedDate || source.receivedAt);
      if (date && sourceBounds.start && date < sourceBounds.start) return false;
      if (date && sourceBounds.endExclusive && date >= sourceBounds.endExclusive) return false;
      return true;
    }).length;
  return { success: true, period: data.bounds.label, generatedAt: new Date().toISOString(), data: result, requestId: requestId };
}

function pfisPeriodTransactions(params) {
  const bounds = pfisGetPeriodBounds(params.period, params.startDate, params.endDate);
  const transactions = pfisReadTransactions().filter(function (tx) {
    const date = pfisParseDateValue(tx.dateTime);
    if (!date) return false;
    if (bounds.start && date < bounds.start) return false;
    if (bounds.endExclusive && date >= bounds.endExclusive) return false;
    return true;
  });
  return { bounds: bounds, transactions: transactions };
}

function pfisGetPeriodBounds(periodValue, startDateValue, endDateValue) {
  const today = new Date();
  const localText = Utilities.formatDate(today, PFIS_TIME_ZONE, 'yyyy-MM-dd');
  const pieces = localText.split('-').map(Number);
  const thisMonthStart = pfisCreateIndiaDate(pieces[0], pieces[1], 1, 0, 0, 0);
  const nextMonthStart = pfisCreateIndiaDate(pieces[0], pieces[1] + 1, 1, 0, 0, 0);
  const previousMonthStart = pfisCreateIndiaDate(pieces[0], pieces[1] - 1, 1, 0, 0, 0);
  const period = pfisString(periodValue).toLowerCase();
  let start = null;
  let endExclusive = null;
  let label = 'all_time';

  if (startDateValue || endDateValue) {
    start = startDateValue ? pfisParseDateValue(String(startDateValue)) : null;
    const end = endDateValue ? pfisParseDateValue(String(endDateValue)) : null;
    if (end) {
      // Treat endDate as inclusive in the PFIS calendar (Asia/Kolkata), not the
      // Apps Script runtime zone. Extracting its IST calendar date also handles
      // stored Date objects and DD/MM/YYYY input consistently.
      const endParts = Utilities.formatDate(end, PFIS_TIME_ZONE, 'yyyy-MM-dd').split('-').map(Number);
      endExclusive = pfisCreateIndiaDate(endParts[0], endParts[1], endParts[2] + 1, 0, 0, 0);
    }
    label = (startDateValue || 'beginning') + '..' + (endDateValue || 'latest');
  } else if (period === 'this_month' || period === 'current_month') {
    start = thisMonthStart; endExclusive = nextMonthStart; label = 'this_month';
  } else if (period === 'last_month' || period === 'previous_month') {
    start = previousMonthStart; endExclusive = thisMonthStart; label = 'last_month';
  } else if (period === 'this_year') {
    start = pfisCreateIndiaDate(pieces[0], 1, 1, 0, 0, 0);
    endExclusive = pfisCreateIndiaDate(pieces[0] + 1, 1, 1, 0, 0, 0);
    label = 'this_year';
  }
  return { start: start, endExclusive: endExclusive, label: label };
}

function pfisStripForAnalytics(tx) {
  return {
    transactionId: tx.transactionId, dateTime: tx.dateTime, amount: tx.amount, bank: tx.bank,
    accountType: tx.accountType, merchant: tx.merchant, category: tx.category, type: tx.type,
    isRecurring: tx.isRecurring, isInternalTransfer: tx.isInternalTransfer, needsReview: tx.needsReview,
    reviewReason: tx.reviewReason, validationFlag: tx.validationFlag
  };
}

// -----------------------------------------------------------------------------
// ID generation, hashing, common utilities, authorization
// -----------------------------------------------------------------------------

function pfisGenerateTransactionId(dateValue) {
  const date = pfisParseDateValue(dateValue) || new Date();
  const period = Utilities.formatDate(date, PFIS_TIME_ZONE, 'yyyyMM');
  const prefix = period + '-';
  const sheet = pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  let maxInSheet = 0;
  if (sheet.getLastRow() > 1) {
    const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    ids.forEach(function (row) {
      const id = pfisString(row[0]);
      if (id.indexOf(prefix) !== 0) return;
      const number = Number(id.substring(prefix.length)); if (isFinite(number) && number > maxInSheet) maxInSheet = number;
    });
  }
  let next = maxInSheet + 1;
  // Isolated tests intentionally do not consume the live production sequence.
  if (!pfisString(PFIS_RUNTIME_SPREADSHEET_OVERRIDE_ID)) {
    const properties = PropertiesService.getScriptProperties();
    const key = 'PFIS_TXN_SEQ_' + period;
    const previous = Number(properties.getProperty(key)) || 0;
    next = Math.max(next, previous + 1);
    properties.setProperty(key, String(next));
  }
  return prefix + String(next).padStart(3, '0');
}

function pfisMakeId(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').substring(0, 12); }

function pfisComputeSourceHash(sourceType, evidenceText) {
  return pfisComputeHash(pfisNormalizeEvidence(evidenceText) + '\nCHANNEL:' + sourceType);
}

function pfisComputeHash(value) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return digest.map(function (byte) { const hex = (byte < 0 ? byte + 256 : byte).toString(16); return hex.length === 1 ? '0' + hex : hex; }).join('');
}

function pfisNormalizeEvidence(value) {
  return pfisSanitizeRawText(value, true).replace(/[ \t]+\n/g, '\n').trim();
}

/** Normalize invisible/irregular Unicode whitespace before text matching. When preserveLineBreaks is true, keep line boundaries for line-aware parsers. */
function pfisSanitizeRawText(raw, preserveLineBreaks) {
  if (raw === null || raw === undefined) return '';
  let text = String(raw)
    .replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/[\u200C\u200D\u2060]/g, '')
    .replace(/\r\n?/g, '\n');
  if (preserveLineBreaks === true) {
    text = text.split('\n').map(function (line) { return line.replace(/[\t ]+/g, ' ').trim(); }).join('\n');
  } else {
    text = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');
  }
  return text.trim();
}

/** Parse only explicit numeric confidence in the range [0,1]; never fabricate one. */
function pfisParseConfidence(value) {
  if (value === null || value === undefined || pfisString(value) === '') return null;
  const n = Number(value);
  return isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * Optional legacy workbook columns at AL/AM. They are not part of the v1 core
 * schema (A:AC), so writes occur only when both physical headers match exactly.
 * A mismatch never blocks the canonical ledger write. Change Log remains the
 * authoritative detailed audit; AM is only a concise per-row summary.
 */
function pfisWriteLegacyTransactionAux(rowNumber, transaction, auditEvent, targetSheet) {
  const sheet = targetSheet || pfisGetRequiredSheet(PFIS_SHEETS.transactions);
  const legacy = PFIS_LEGACY_TX_COLUMNS;
  const firstCol = legacy.first; // AD
  if (sheet.getMaxColumns() < firstCol) return;

  // Read the optional AD:AM legacy block once and write it once. Formula cells
  // are copied back as formulas, never replaced by their calculated values.
  const availableCols = Math.min(10, sheet.getMaxColumns() - firstCol + 1);
  if (availableCols < legacy.count) return; // The auxiliary schema is incomplete.
  const headers = sheet.getRange(1, firstCol, 1, availableCols).getDisplayValues()[0].map(function (v) {
    return pfisString(v).trim();
  });
  const expectedLegacy = PFIS_LEGACY_TX_HEADERS;
  const legacyHeadersOk = expectedLegacy.every(function (header, i) {
    return pfisHeaderToken(headers[i]) === pfisHeaderToken(header);
  });
  const flowHeaderOk = headers.length >= 9 && pfisHeaderToken(headers[8]) === pfisHeaderToken('Flow Direction');
  const auditHeaderOk = headers.length >= 10 && pfisHeaderToken(headers[9]) === pfisHeaderToken('Audit Trail');
  if (!legacyHeadersOk && !flowHeaderOk && !auditHeaderOk) return;

  const range = sheet.getRange(rowNumber, firstCol, 1, availableCols);
  const currentValues = range.getValues()[0];
  const formulas = range.getFormulas()[0];
  const output = currentValues.map(function (value, i) { return formulas[i] || value; });
  let changed = false;
  const t = transaction || {};

  if (legacyHeadersOk) {
    const values = [
      t.originalText,
      t.sourceId,
      t.batchId,
      t.sourceHash,
      t.canonicalKey || (t.transactionId ? 'CANON-' + t.transactionId : undefined),
      t.merchantCleaned !== undefined ? t.merchantCleaned : (t.merchant !== undefined ? pfisNormalizeMerchant(t.merchant) : undefined),
      t.isInvestment !== undefined ? !!t.isInvestment : (t.type !== undefined ? pfisNormalizeType(t.type) === 'investment' : undefined),
      t.isCardPayment !== undefined ? !!t.isCardPayment : (t.type !== undefined ? pfisNormalizeType(t.type) === 'card_payment' : undefined)
    ];
    values.forEach(function (value, i) {
      if (value === undefined || value === null || formulas[i]) return;
      if (output[i] !== value) { output[i] = value; changed = true; }
    });
  }

  const flowIndex = PFIS_AUX_TX_COLUMNS.flowDirection - firstCol;
  if (flowHeaderOk && flowIndex < availableCols && !formulas[flowIndex]) {
    const amount = Number(t.amount);
    if (isFinite(amount)) {
      const flow = amount > 0 ? 'INFLOW' : (amount < 0 ? 'OUTFLOW' : 'NEUTRAL');
      if (output[flowIndex] !== flow) { output[flowIndex] = flow; changed = true; }
    }
  }

  const auditIndex = PFIS_AUX_TX_COLUMNS.auditTrail - firstCol;
  if (auditHeaderOk && auditIndex < availableCols && !formulas[auditIndex] && pfisString(auditEvent)) {
    const now = Utilities.formatDate(new Date(), PFIS_TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
    const entry = now + ' | ' + pfisString(auditEvent);
    const previous = pfisString(currentValues[auditIndex]);
    let combined = previous ? previous + '\n' + entry : entry;
    if (combined.length > PFIS_AUDIT_TRAIL_MAX_CHARS) combined = combined.substring(combined.length - PFIS_AUDIT_TRAIL_MAX_CHARS);
    if (output[auditIndex] !== combined) { output[auditIndex] = combined; changed = true; }
  }

  if (changed) range.setValues([output]);
}

/**
 * Suggest a prior purpose only for the exact normalized merchant and transaction
 * type. It is returned to Shortcuts as an editable hint; it is never saved by the
 * backend without the user's confirmation. Reads only a bounded recent window.
 */
function pfisFindPurposeExamples(transactionId, merchant, transactionType, limitInput) {
  // Return only high-quality examples, never full raw messages. Matching is exact
  // on normalized merchant and semantic type; only approved, non-review, valid
  // ledger rows with meaningful purpose and valid category are eligible.
  const merchantKey = pfisNormalizeMerchant(merchant);
  const typeKey = pfisNormalizeType(transactionType);
  if (!merchantKey || !pfisIsMatchableMerchant(merchantKey) || !typeKey) return [];

  const limit = Math.max(1, Math.min(3, Math.floor(Number(limitInput) || 3)));
  // pfisReadTransactions filters rows without Transaction IDs, so checkbox defaults
  // or formatting below the ledger cannot shift this historical search window.
  const transactions = pfisReadTransactions();
  const recent = transactions.slice(Math.max(0, transactions.length - 500)).reverse();
  const categories = pfisGetCategoryList();
  const examples = [];
  const seen = Object.create(null);

  for (let i = 0; i < recent.length && examples.length < limit; i++) {
    const row = recent[i];
    if (pfisString(row.transactionId) === pfisString(transactionId)) continue;
    if (pfisNormalizeMerchant(row.merchant) !== merchantKey) continue;
    if (pfisNormalizeType(row.type) !== typeKey) continue;
    if (pfisTruthy(row.needsReview)) continue;

    const reviewStatus = pfisString(row.reviewStatus).toUpperCase();
    if (reviewStatus && reviewStatus !== 'APPROVED') continue;
    const validationFlag = pfisString(row.validationFlag).toUpperCase();
    if (validationFlag && validationFlag !== 'VALID') continue;

    const purpose = pfisCleanText(row.userNotes);
    const category = pfisCleanText(row.category);
    if (!pfisIsMeaningfulPurpose(purpose, row.merchant)) continue;
    if (!category || categories.indexOf(category) < 0) continue;

    const fingerprint = pfisNormalizeMerchant(purpose) + '|' + category;
    if (seen[fingerprint]) continue;
    seen[fingerprint] = true;
    examples.push({ purpose: purpose, category: category, type: typeKey });
  }
  return examples;
}

// Compatibility helper for internal tests/tools that need just the best hint.
function pfisFindPurposeSuggestion(transactionId, merchant, transactionType) {
  const examples = pfisFindPurposeExamples(transactionId, merchant, transactionType, 1);
  return examples.length ? examples[0].purpose : '';
}

function pfisBuildIngestResponse(transaction, requestId, sourceType, status, sourceId) {
  const response = pfisBuildTransactionResponse(transaction, requestId, status, []);
  response.sourceType = sourceType;
  response.sourceId = sourceId || null;
  if (transaction && transaction.validationFlag === 'SOURCE_CONFLICT') response.recorded = true;
  return response;
}

/**
 * Compact, stable API view. Stored transaction facts appear once in transaction;
 * verification/enrichment are derived states and appear only at top level.
 */
function pfisBuildTransactionResponse(transaction, requestId, status, changedFields) {
  const safeTransaction = transaction ? pfisTransactionResponseView(transaction) : null;
  const categories = pfisGetCategoryList();
  const enrichment = transaction
    ? pfisGetEnrichmentState(transaction.category, transaction.userNotes, categories, transaction.merchant)
    : { requiresPurpose: false, requiresCategoryClassification: false };
  const verification = transaction ? {
    status: transaction.verificationStatus || 'UNKNOWN',
    sourceCount: Number(transaction.sourceCount) || 0,
    sourceTypes: Array.isArray(transaction.sourceTypes) ? transaction.sourceTypes : []
  } : { status: 'UNKNOWN', sourceCount: 0, sourceTypes: [] };

  const response = {
    success: !!transaction,
    status: status,
    requestId: requestId, // Correlates this request with backend logs and audit rows.
    transactionId: transaction ? transaction.transactionId : null,
    transaction: safeTransaction,
    verificationStatus: verification.status,
    sourceCount: verification.sourceCount,
    sourceTypes: verification.sourceTypes,
    needsReview: transaction ? pfisTruthy(transaction.needsReview) : false,
    needsEnrichment: enrichment.requiresPurpose || enrichment.requiresCategoryClassification,
    requiresPurpose: enrichment.requiresPurpose,
    requiresCategoryClassification: enrichment.requiresCategoryClassification
  };
  response.nextAction = transaction
    ? pfisRecommendNextAction(status, transaction, enrichment)
    : 'SHOW_ERROR';

  if (enrichment.requiresCategoryClassification) response.allowedCategories = categories;

  // Stable top-level keys support the existing Shortcut's default-answer field.
  // Suggestions come only from approved history for the exact normalized merchant
  // and semantic type; the backend never saves the suggestion automatically.
  response.purposeSuggestion = '';
  response.purposeExamples = [];
  if (enrichment.requiresPurpose && transaction) {
    const examples = pfisFindPurposeExamples(transaction.transactionId, transaction.merchant, transaction.type, 3);
    response.purposeExamples = examples;
    response.purposeSuggestion = examples.length ? examples[0].purpose : '';
  }
  if (Array.isArray(changedFields) && changedFields.length) response.changedFields = changedFields;
  return response;
}

/**
 * Frontend routing hint. This is deliberately separate from needsEnrichment:
 * data may remain incomplete after a second-channel reconciliation/replay, but
 * that second Shortcut must not open a competing purpose/category prompt.
 */
function pfisRecommendNextAction(status, transaction, enrichment) {
  const operation = pfisString(status).toUpperCase();
  const tx = transaction || {};
  const reviewReason = pfisString(tx.reviewReason).toLowerCase();

  if (['CONFLICT', 'SOURCE_CONFLICT', 'DUPLICATE_CANDIDATE'].indexOf(operation) >= 0) {
    return 'REVIEW';
  }
  if (['RECONCILED', 'IDEMPOTENT_REPLAY'].indexOf(operation) >= 0) {
    return 'SHOW_RECEIPT';
  }

  // Serious source/type conflicts require review before AI enrichment. Missing
  // category, purpose, merchant readability, card mapping, and timestamp precision
  // must not block safe enrichment of fields that have independent evidence.
  const hardReviewReasons = [
    'source_conflict', 'same_reference_conflicting_transaction_facts',
    'duplicate_candidate', 'unknown_transaction_type'
  ];
  if (hardReviewReasons.indexOf(reviewReason) >= 0) return 'REVIEW';

  const state = enrichment || pfisGetEnrichmentState(
    tx.category, tx.userNotes, undefined, tx.merchant
  );
  // Category first: the Shortcut's classifier returns ASK_PURPOSE only when the
  // merchant and raw alert do not provide enough evidence for a reliable category.
  if (state.requiresCategoryClassification) return 'CLASSIFY_CATEGORY';
  if (state.requiresPurpose) return 'ASK_PURPOSE';
  if (pfisTruthy(tx.needsReview)) return 'REVIEW';
  return 'SHOW_RECEIPT';
}

function pfisTransactionResponseView(transaction) {
  if (!transaction) return null;
  // Values Shortcuts and support actually use. Physical row numbers, internal
  // categoryConfidence placeholders, duplicate verification flags, and sheet
  // timestamps remain available in the workbook / gettransaction endpoint.
  const fields = [
    'transactionId', 'dateTime', 'amount', 'bank', 'accountType', 'merchant', 'category',
    'userNotes', 'type', 'instrument', 'account', 'cardName', 'isRecurring',
    'isInternalTransfer', 'needsReview', 'counterparty', 'refNo', 'balanceAfter',
    'reviewStatus', 'reviewReason', 'reviewedBy', 'reviewedAt', 'ruleApplied',
    'ruleType', 'validationFlag', 'datePrecision'
  ];
  const view = {};
  fields.forEach(function (field) {
    if (Object.prototype.hasOwnProperty.call(transaction, field)) view[field] = transaction[field];
  });
  return view;
}

function pfisBuildUpdateResponse(transaction, requestId, status, changedFields) {
  const response = pfisBuildTransactionResponse(transaction, requestId, status, changedFields || []);
  return response;
}

function pfisGetEnrichmentState(category, notes, categoryList, merchant) {
  const categories = Array.isArray(categoryList) ? categoryList : pfisGetCategoryList();
  const categoryValue = pfisCleanText(category);
  // Purpose is optional. It remains visible in data-quality metrics but never
  // blocks capture, approval, review completion or reporting.
  return {
    requiresCategoryClassification: !categoryValue || categories.indexOf(categoryValue) < 0,
    requiresPurpose: false
  };
}

function pfisIsMeaningfulPurpose(value, merchant) {
  const purpose = pfisCleanText(value);
  if (!purpose) return false;

  // Purpose is free-form user intent, not merely the merchant/counterparty name.
  // Reject placeholders and generic status/template text so they cannot silently
  // suppress the Shortcut enrichment prompt.
  const normalized = purpose.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const placeholders = [
    'na', 'n a', 'unknown', 'unspecified', 'none', 'null',
    'not available', 'not provided', 'not specified', 'pending',
    'needs input', 'miscellaneous', 'unknown purpose', '-'
  ];
  if (placeholders.indexOf(normalized) >= 0) return false;
  if (/\b(unknown|unspecified|pending|not known|not clear|to be confirmed|needs input)\b/.test(normalized)) return false;
  if (/^done for [a-z]{3} \d{2,4}$/.test(normalized)) return false;
  if (/^purpose (remains )?(unknown|unspecified|pending)$/.test(normalized)) return false;

  const merchantKey = pfisNormalizeMerchant(merchant);
  if (merchantKey && pfisIsMatchableMerchant(merchantKey) &&
    pfisNormalizeMerchant(purpose) === merchantKey) return false;
  return true;
}

function pfisClampLimit(value, fallback) {
  const number = Math.floor(Number(value));
  if (!isFinite(number) || number < 1) return Math.min(fallback || 50, PFIS_MAX_READ_LIMIT);
  return Math.min(number, PFIS_MAX_READ_LIMIT);
}

function pfisAuthorize(params) {
  const expected = pfisString(PropertiesService.getScriptProperties().getProperty('WEB_APP_SECRET'));
  if (!expected) return;
  const supplied = pfisString(params.token);
  if (!supplied || supplied !== expected) throw pfisError('UNAUTHORIZED', 'Unauthorized request.');
}

function pfisJsonOutput(payload) {
  const output = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.assign({}, payload)
    : { success: false, message: 'Invalid response.' };

  // Standardize client routing for error responses from all handlers, including
  // validation, bad JSON, unknown actions, lock timeouts and parser failures.
  if (!output.nextAction && output.success === false) {
    output.nextAction = 'SHOW_ERROR';
  }

  // Generate a readable mobile message without changing API data.
  if (!output.displayText &&
    (output.status || output.error || output.transactionId || output.transaction)) {
    output.displayText = pfisBuildDisplayText(output);
  }

  return ContentService.createTextOutput(JSON.stringify(output))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Builds a grouped, mobile-friendly transaction receipt for iOS Shortcuts.
 * Presentation only: does not alter transaction data or processing status.
 */
function pfisBuildDisplayText(payload) {
  const p = payload || {};
  const tx = p.transaction || {};
  const status = pfisString(p.status).toUpperCase();

  function isTrue(value) {
    return value === true ||
      ['TRUE', 'YES', 'Y', '1'].indexOf(
        String(value == null ? '' : value).trim().toUpperCase()
      ) !== -1;
  }

  function safe(value) {
    return String(value == null ? '' : value)
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  function firstValue() {
    for (let i = 0; i < arguments.length; i++) {
      const value = arguments[i];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
    return '';
  }

  function add(lines, label, value) {
    if (value !== undefined && value !== null && value !== '') {
      lines.push(label + ': ' + safe(value));
    }
  }

  function section(lines, heading) {
    lines.push('');
    lines.push(heading);
  }

  function formatDate(value) {
    if (!value) return '';

    try {
      const date = value instanceof Date ? value : new Date(value);

      if (isNaN(date.getTime())) return safe(value);

      const dateOnly =
        String(tx.datePrecision || p.datePrecision).toUpperCase() ===
        'DATE_ONLY';

      return Utilities.formatDate(
        date,
        'Asia/Kolkata',
        dateOnly ? 'dd MMM yyyy' : 'dd MMM yyyy, h:mm a'
      );
    } catch (e) {
      return safe(value);
    }
  }

  const needsPurpose =
    isTrue(p.requiresPurpose) || isTrue(tx.requiresPurpose);

  const needsCategory =
    isTrue(p.requiresCategoryClassification) ||
    isTrue(tx.requiresCategoryClassification);

  const needsEnrichment =
    isTrue(p.needsEnrichment) ||
    isTrue(tx.needsEnrichment) ||
    needsPurpose ||
    needsCategory;

  const reviewStatus = String(
    firstValue(tx.reviewStatus, p.reviewStatus)
  ).toUpperCase();

  const needsReview =
    isTrue(p.needsReview) ||
    isTrue(tx.needsReview) ||
    reviewStatus === 'PENDING';

  const validationFlag = String(
    firstValue(tx.validationFlag, p.validationFlag)
  ).toUpperCase();

  const isDuplicate =
    status === 'DUPLICATE_CANDIDATE' ||
    validationFlag === 'DUPLICATE_CANDIDATE';

  const isConflict =
    ['CONFLICT', 'SOURCE_CONFLICT'].indexOf(status) !== -1 ||
    ['CONFLICT', 'SOURCE_CONFLICT'].indexOf(validationFlag) !== -1;

  const isError =
    p.success === false ||
    [
      'PARSE_FAILED',
      'UPDATE_REJECTED',
      'NOT_FOUND',
      'BUSY'
    ].indexOf(status) !== -1;

  // Use stable, recognizable headings. Do not randomize status emojis.
  let title;

  if (isError) {
    title = status === 'UPDATE_REJECTED'
      ? '⚠️ TRANSACTION UPDATE REJECTED'
      : status === 'PARSE_FAILED'
        ? '❌ TRANSACTION PARSING FAILED'
        : status === 'NOT_FOUND'
          ? '🔎 TRANSACTION NOT FOUND'
          : status === 'BUSY'
            ? '⏳ PFIS TEMPORARILY BUSY'
            : '❌ REQUEST FAILED';
  } else if (isConflict) {
    title = '🚧 DATA CONFLICT — REVIEW REQUIRED';
  } else if (isDuplicate) {
    title = '⚠️ POSSIBLE DUPLICATE — REVIEW';
  } else if (needsEnrichment &&
    ['enrichment_required', ''].indexOf(String(tx.reviewReason || p.reviewReason || '').toLowerCase()) >= 0) {
    title = status === 'IDEMPOTENT_REPLAY'
      ? '♻️ EXISTING TRANSACTION — DETAILS STILL NEEDED'
      : (status === 'RECONCILED'
        ? '🔗 ALERTS VERIFIED — DETAILS STILL NEEDED'
        : (status === 'UPDATED'
          ? '📝 UPDATE SAVED — DETAILS NEEDED'
          : '✅ TRANSACTION SAVED — DETAILS NEEDED'));
  } else if (needsReview) {
    title = '🟡 TRANSACTION NEEDS REVIEW';
  } else if (status === 'IDEMPOTENT_REPLAY') {
    title = '♻️ ALREADY PROCESSED';
  } else if (status === 'RECONCILED') {
    title = '🔗 TRANSACTIONS RECONCILED';
  } else if (status === 'UPDATED') {
    title = '📝 TRANSACTION UPDATED';
  } else if (status === 'NO_CHANGE') {
    title = '👌 NO CHANGES NEEDED';
  } else if (status === 'HEALTHY') {
    title = '🟢 PFIS HEALTHY';
  } else if (status === 'ACCEPTED') {
    title = needsEnrichment
      ? '✅ TRANSACTION SAVED — DETAILS NEEDED'
      : '✅ TRANSACTION SAVED';
  } else {
    title = p.success === true
      ? '✅ REQUEST COMPLETED'
      : '❌ REQUEST FAILED';
  }

  // 1. Transaction identity and amount
  const lines = [
    title,
    '────────────',
    '🧾 TRANSACTION'
  ];
  add(lines, 'ID', firstValue(p.transactionId, tx.transactionId));

  if (tx.amount !== undefined && tx.amount !== null && tx.amount !== '') {
    const amount = Number(tx.amount);

    const formatted = Number.isFinite(amount)
      ? (amount < 0 ? '−₹' : '+₹') +
      Math.abs(amount).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
      : safe(tx.amount);

    add(lines, '💰 Amount', formatted);
  }

  add(lines, '🏪 Merchant', tx.merchant);
  add(lines, '📅 Date', formatDate(
    firstValue(tx.dateTime, tx.date, tx.transactionDate)
  ));

  // 2. Classification and payment details
  section(lines, '🏷️ CLASSIFICATION & PAYMENT');

  add(
    lines,
    'Category',
    firstValue(
      tx.category,
      needsCategory ? 'Pending classification' : ''
    )
  );

  add(
    lines,
    'Purpose',
    firstValue(
      tx.userNotes,
      tx.purpose,
      needsPurpose ? 'Needs input' : ''
    )
  );

  add(lines, '🏦 Account', firstValue(tx.cardName, tx.account));
  add(lines, '💳 Instrument', tx.instrument);
  add(lines, '🔄 Type', tx.type);

  if (isTrue(tx.isRecurring)) {
    add(lines, '🔁 Recurring', 'Yes');
  }

  if (isTrue(tx.isInternalTransfer)) {
    add(lines, '↔️ Internal transfer', 'Yes');
  }

  // 3. Source verification
  section(lines, '🔐 VERIFICATION');

  add(
    lines,
    'Status',
    firstValue(p.verificationStatus, tx.verificationStatus)
  );

  const sources = firstValue(p.sourceTypes, tx.sourceTypes);

  if (Array.isArray(sources) && sources.length) {
    add(lines, '📨 Sources', sources.join(' + '));
  } else if (typeof sources === 'string' && sources) {
    add(lines, '📨 Sources', sources);
  }

  const evidenceCount = firstValue(p.sourceCount, tx.sourceCount);

  if (evidenceCount !== '') {
    add(lines, '📎 Evidence records', evidenceCount);
  }

  // 4. Changes and review state, only when relevant
  const changedFields = p.changedFields;

  if (Array.isArray(changedFields) && changedFields.length) {
    section(lines, '✏️ UPDATE DETAILS');
    add(lines, 'Fields changed', changedFields.join(', '));
  }

  if (needsReview || isDuplicate || isConflict) {
    section(lines, '🔎 REVIEW');

    add(lines, 'Status', firstValue(tx.reviewStatus, p.reviewStatus));
    add(
      lines,
      'Reason',
      firstValue(tx.reviewReason, p.reviewReason, validationFlag)
    );

    add(lines, 'Sheet row', firstValue(tx.sheetRow, p.sheetRow));
  }

  // 5. Actionable next step, prioritized by severity
  let nextStep = '';

  if (isError) {
    nextStep = firstValue(
      p.message,
      p.error,
      'Inspect the response before retrying.'
    );
  } else if (isConflict) {
    nextStep =
      'Compare Transaction Log and Source Log. Resolve the conflicting facts.';
  } else if (isDuplicate) {
    nextStep =
      'Confirm whether both alerts represent genuine transactions.';
  } else if (needsEnrichment &&
    ['enrichment_required', ''].indexOf(String(tx.reviewReason || p.reviewReason || '').toLowerCase()) >= 0) {
    const missing = [];
    if (needsPurpose) missing.push('purpose');
    if (needsCategory) missing.push('category');
    nextStep = 'Complete missing ' + missing.join(' and ') + '.';
  } else if (needsReview) {
    nextStep =
      'Inspect the transaction in the Transaction Log before approving.';
  } else if (needsEnrichment) {
    const missing = [];
    if (needsPurpose) missing.push('purpose');
    if (needsCategory) missing.push('category');
    nextStep = 'Complete missing ' + missing.join(' and ') + '.';
  } else if (status === 'IDEMPOTENT_REPLAY') {
    nextStep = 'Existing record returned; no duplicate row inserted.';
  } else if (
    String(firstValue(p.verificationStatus, tx.verificationStatus))
      .toUpperCase() === 'SMS_ONLY'
  ) {
    nextStep =
      'Enrichment is complete; only SMS evidence is currently available.';
  } else if (p.success === true) {
    nextStep = 'No further action required.';
  }

  if (nextStep) {
    section(lines, '➡️ NEXT STEP');
    lines.push(safe(nextStep));
  }

  // Show error diagnostics only for failures.
  if (isError) {
    add(lines, '❗ Error', p.error);
    add(lines, 'Details', p.message);
    if (p.errorLoggedToSheet === true) {
      const loggedPlaces = [];
      if (p.sourceLogLogged === true) loggedPlaces.push('Source Log');
      if (p.changeLogLogged === true) loggedPlaces.push('Change Log');
      add(lines, '🗂️ Audit log', loggedPlaces.length ? 'Recorded in ' + loggedPlaces.join(' and ') : 'Recorded');
    } else if (p.errorLoggedToSheet === false) {
      add(lines, '🗂️ Audit log', 'Could not be written; check Apps Script execution logs.');
    }
    add(lines, '🔎 Request reference', firstValue(p.requestId, p.sourceId));
  } else if (p.message && status !== 'IDEMPOTENT_REPLAY') {
    section(lines, 'ℹ️ DETAILS');
    lines.push(safe(p.message));
  }

  return lines.join('\n');
}

function pfisPerfEnabled() {
  return ['TRUE', '1', 'YES', 'ON'].indexOf(String(PropertiesService.getScriptProperties().getProperty('PFIS_PERF_LOG') || '').trim().toUpperCase()) >= 0;
}

function pfisPerfBegin(requestId, action, method) {
  if (!pfisPerfEnabled()) return null;
  return {
    requestId: requestId, action: action || 'ingest', method: method || 'UNKNOWN',
    startedMs: Date.now(), startedAt: new Date().toISOString(), phases: []
  };
}

function pfisPerfMeasure(name, callback) {
  if (typeof callback !== 'function') throw new Error('pfisPerfMeasure requires a callback.');
  if (!PFIS_PERF_CONTEXT) return callback();
  const started = Date.now();
  try { return callback(); }
  finally { pfisPerfContextRecord(PFIS_PERF_CONTEXT, name, Date.now() - started); }
}

function pfisPerfRecord(name, elapsedMs) {
  if (!PFIS_PERF_CONTEXT) return;
  pfisPerfContextRecord(PFIS_PERF_CONTEXT, name, elapsedMs);
}

function pfisPerfContextRecord(context, name, elapsedMs) {
  if (!context) return;
  context.phases.push({ phase: name, milliseconds: Math.max(0, Number(elapsedMs) || 0) });
}

function pfisPerfFinish(context) {
  if (!context) return;
  const endedMs = Date.now();
  const entry = {
    event: 'PFIS_PERF', requestId: context.requestId, action: context.action, method: context.method,
    startedAt: context.startedAt, endedAt: new Date(endedMs).toISOString(), totalMilliseconds: endedMs - context.startedMs,
    phases: context.phases
  };
  console.log('PFIS_PERF ' + JSON.stringify(entry));
}

function pfisError(code, message) { const error = new Error(message); error.code = code; return error; }
function pfisString(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function pfisCleanText(value) {
  const text = pfisString(value);
  if (!text) return '';
  const token = text.toUpperCase().replace(/[.\s]/g, '');
  return ['NA', 'N/A', 'UNKNOWN', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTPROVIDED', 'UNAVAILABLE', '-', '--', '—', '–'].indexOf(token) >= 0 ? '' : text;
}
function pfisTruthy(value) { return value === true || ['TRUE', 'YES', 'Y', '1', 'ACTIVE', 'ENABLED'].indexOf(pfisString(value).toUpperCase()) >= 0; }
function pfisIsActive(value) { return pfisTruthy(value) || ['ACTIVE', 'ENABLED'].indexOf(pfisString(value).toUpperCase()) >= 0; }
function pfisNormalizeSourceType(value) { const type = pfisString(value).toUpperCase(); return type === 'SMS' || type === 'EMAIL' ? type : ''; }
function pfisNormalizeAction(value) { return pfisString(value).toLowerCase().replace(/[^a-z]/g, ''); }
function pfisHeaderToken(value) { return pfisString(value).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function pfisPad2(value) { return String(value).padStart(2, '0'); }
function pfisUnique(values) { const seen = {}; return values.filter(function (value) { const key = pfisString(value); if (!key || seen[key]) return false; seen[key] = true; return true; }); }
function pfisUniqueBy(values, key) { const seen = {}; return values.filter(function (value) { const token = pfisString(value[key]); if (!token || seen[token]) return false; seen[token] = true; return true; }); }
function pfisParseProcessingMeta(value) { try { return JSON.parse(String(value || '{}')); } catch (error) { return {}; } }
