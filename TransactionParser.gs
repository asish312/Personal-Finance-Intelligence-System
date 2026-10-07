/**
 * Personal Finance Web App
 *
 * Transaction Log schema (Transaction Log sheet):
 *  A: Transaction ID (YYYYMM-XXX, server-generated)
 *  B: DateTime
 *  C: Amount (Income +, Expense -)
 *  D: Bank
 *  E: Account Type
 *  F: Merchant
 *  G: Category
 *  H: User Notes
 *  I: Original Text (raw SMS or "[MANUAL]")
 *
 * Summary sheet (Monthly Summary) is read-only for this script.
 */

function test_doGet_rent_case_scratch() {
  // Deliberately logs only. Point tests at a scratch spreadsheet before enabling writes.
  const parsed = parseTransactionString('2026-06-26 07:18:24 | -100.00 | Axis | Credit Card | Credit Card | expense | Bhavyas Tiffin Center | PENUMATSA S | REF123456 | NA', 'Dummy');
  Logger.log(JSON.stringify(parsed));
}

// =============================
// CONFIGURATION
// =============================

/**
 * Google Sheets configuration.
 * Replace SHEET_ID with your actual spreadsheet ID.
 */
const SHEET_ID = 'XXX';
const TRANSACTION_SHEET_NAME = 'Transaction Log';
const SUMMARY_SHEET_NAME = 'Monthly Summary';
const SUGGESTION_RULES_SHEETNAME = 'Suggestion Rules';
const SUGGESTION_RULES_SHEET_NAME = 'Suggestion Rules';
const financeSheet = SpreadsheetApp.openById(SHEET_ID);
const CONFIG_SHEET_NAME = 'CONFIG';
const SOURCE_LOG_SHEET_NAME = 'Source Log';
const CHANGE_LOG_SHEET_NAME = 'Change Log';
const SCHEMA_VERSION = '3.0';
const PARSER_FORMAT_VERSION = '10';

// Transaction Log column indices (1-based)
const TX_COL = {
  ID: 1, DATETIME: 2, AMOUNT: 3, BANK: 4, ACCOUNT_TYPE: 5, MERCHANT: 6, CATEGORY: 7,
  USER_NOTES: 8, ORIGINAL_TEXT: 9, TYPE: 10, INSTRUMENT: 11, ACCOUNT: 12, CARD_NAME: 13,
  IS_RECURRING: 14, NEEDS_REVIEW: 15, COUNTERPARTY: 16, REF_NO: 17, BALANCE_AFTER: 18,
  CREATED_AT: 19, LAST_UPDATED_AT: 20, SOURCE_HASH: 21, SOURCE_ID: 22, REVIEW_REASON: 23,
  TYPE_SOURCE: 24, TYPE_CONFIDENCE: 25, CATEGORY_SOURCE: 26, RULES_APPLIED: 27, SCHEMA_VERSION: 28,
  MATCH_KEY: 29, MERCHANT_NORMALIZED: 30, SUBCATEGORY: 31, PARSER_CONFIDENCE: 32,
  VERIFICATION_STATUS: 33, VERIFICATION_SOURCE: 34, VERIFIED_AT: 35, SOURCE_COUNT: 36, FIRST_SEEN_AT: 37
};

/**
 * Suggestion rules configuration.
 *
 * Sheet: "Suggestion Rules"
 * Columns:
 *  A: Enabled ("Y" to use)
 *  B: Match Type ("AMOUNT", "MERCHANT", or "AMOUNT+MERCHANT")
 *  C: Amount (absolute number)
 *  D: Merchant Contains (optional, substring, case-insensitive)
 *  E: Category
 *  F: Merchant Override (optional)
 *  G: Notes Template (optional, supports {monthLabel})
 *  H: Month Offset (integer, e.g. -1=previous month, 0=current)
 */


// =============================
// MAIN ROUTER
// =============================

/**
 * HTTP GET entry point for Shortcuts and SMS gateway.
 *
 * Supported patterns:
 * - SMS-based transaction:
 *     ?txnString=# | DateTime | Amount | Bank | Account Type | Merchant&originalText=...
 *
 * - Manual transaction (Shortcuts):
 *     ?dateTime=...&type=💰 Income|💵 Expenses&amount=...&bank=...&accountType=...&
 *      merchant=...&mainCategory=...&subCategory=...&notes=...
 *   or:
 *     ?action=manual&dateTime=...&type=...&amount=...
 *
 * - Maintenance / retrieval:
 *     ?action=getLastInserted
 *     ?action=pendingReview&limit=10
 *     ?action=updateTransaction&sheetRow=...&category=...&notes=...
 *     ?action=lastTransactions&limit=5
 *
 * - Monthly overview:
 *     ?menu=overview|minimal
 *
 * Any other call falls back to manual transaction entry.
 */
function doGet(e) {
  const event = e || { parameter: {} };  // NEW: don't reassign e
  const p = event.parameter || {};

  try {
    // 0) Explicit secondary-source ingestion/reconciliation
    if (p.action === 'ingestSource' || p.sourceType) {
      return ingestSecondarySource(p);
    }

    // 1) SMS-based transaction
    if (p.txnString) {
      const originalText = p.originalText || '';
      return handleRawTransaction(p.txnString, originalText, 'SMS');
    }

    // 2) Explicit manual transaction route
    if (p.action === 'manual') {
      return handleManualTransaction(p);
    }

    // 3) Transaction retrieval / maintenance
    if (p.action === 'getLastInserted') {
      return getLastInsertedTransaction();
    }

    if (p.action === 'pendingReview') {
      const limit = parseInt(p.limit, 10) || 10;
      return getTransactionsPendingReview(limit);
    }

    if (p.action === 'updateTransaction') {
      const sheetRow = parseInt(p.sheetRow, 10);
      const category = p.category || '';
      const userNotes = p.notes || '';
      return updateTransaction(sheetRow, category, userNotes);
    }

    if (p.action === 'lastTransactions') {
      const limit = parseInt(p.limit, 10) || 5;
      return getLastTransactions(limit);
    }

    // 4) Monthly overview for shortcuts
    if (p.menu && (p.menu === 'overview' || p.menu === 'minimal')) {
      return getMonthlyOverview(p.menu);
    }

    // 5) Manual transaction entry (fallback)
    return handleManualTransaction(p);

  } catch (error) {
    Logger.log('Error in doGet: ' + error.toString());
    return sendJsonResponse(false, {
      errorCode: 'SERVER_ERROR',
      message: 'Something went wrong while processing your request.',
      requestId: p.requestId || Utilities.getUuid()
    });
  }
}

// =============================
// 1. SMS PARSING & INSERTION
// =============================

/**
 * Parse a pipe-delimited transaction string from SMS.
 *
 * Supported formats:
 *   # | DateTime | Amount | Bank | Account Type | Merchant
 *   DateTime | Amount | Bank | Account Type | Merchant
 *
 * The first field (#) is treated as an optional external reference only;
 * the authoritative Transaction ID is generated server-side.
 */
function parseTransactionString(txnString, originalText) {
  if (!txnString || typeof txnString !== 'string') {
    return { error: 'Transaction string is empty or invalid' };
  }

  const trimmed = txnString.trim();
  const parts = trimmed.split('|').map(p => (p || '').trim());
  const originalCount = parts.length;

  if (originalCount !== 10 && originalCount !== 9 && originalCount !== 5) {
    return {
      error: 'Invalid format. Expected 10 fields (or legacy 5/9 during migration).',
      example: '2026-06-26 07:18:24 | -100 | Axis | Credit Card | Credit Card | expense | Bhavyas Tiffin Center | PENUMATSA S | REF123456'
    };
  }

  let dateTime = parts[0] || '';
  let amount = parseFloat(parts[1]);
  let bank = parts[2] || '';
  let accountType = parts[3] || '';

  let instrument = '';
  let typeRaw = '';
  let rawMerchant = '';
  let counterparty = '';
  let refNo = '';
  let balanceAfter = '';

  if (originalCount === 5) {
    rawMerchant = parts[4] || '';
  } else if (originalCount === 9) {
    instrument = parts[4] || '';
    typeRaw = parts[5] || '';
    rawMerchant = parts[6] || '';
    counterparty = parts[7] || '';
    refNo = parts[8] || '';
  } else {
    instrument = parts[4] || '';
    typeRaw = parts[5] || '';
    rawMerchant = parts[6] || '';
    counterparty = parts[7] || '';
    refNo = parts[8] || '';
    balanceAfter = parts[9] || '';
  }

  if (!dateTime) return { error: 'DateTime is missing' };
  if (isNaN(amount) || amount === 0) return { error: 'Amount is invalid or zero' };
  if (!bank) return { error: 'Bank name is missing' };
  if (!accountType) return { error: 'Account Type is missing' };

  if (typeRaw === 'NA') typeRaw = '';
  if (balanceAfter === 'NA') balanceAfter = '';

  if (!rawMerchant) {
    rawMerchant = 'Unspecified';
  }

  const merchantName = getMerchantName(rawMerchant);
  let category = suggestCategory(merchantName);

  if (!instrument) {
    instrument = inferInstrumentFromText(originalText || '', accountType);
  }

  let type = normalizeSemanticType(
    typeRaw,
    amount,
    category,
    originalText || '',
    accountType,
    bank,
    merchantName
  );

  if (isCreditCardPayment(originalText || '', accountType, bank, rawMerchant)) {
    type = 'card_payment';
    category = 'Credit card payments';
  }

  return {
    dateTime: dateTime,
    amount: amount,
    bank: bank,
    accountType: accountType,
    merchantName: merchantName,
    category: category,
    instrument: instrument || '',
    type: type || '',
    counterparty: counterparty || '',
    refNo: refNo || '',
    balanceAfter: balanceAfter ? toNumber(balanceAfter) : '',
    account: '',
    cardName: '',
    originalText: originalText || ''
  };
}

function inferInstrumentFromText(originalText, accountType) {
  const text = (originalText || '').toLowerCase();
  const acct = (accountType || '').toLowerCase();

  if (text.includes('upi') || text.includes('vpa') || acct.includes('upi')) {
    return 'UPI';
  }
  if (acct.includes('credit card') || text.includes('credit card') || text.includes('card no')) {
    return 'Credit Card';
  }
  if (text.includes('debit card')) {
    return 'Debit Card';
  }
  if (text.includes('neft')) {
    return 'NEFT';
  }
  if (text.includes('imps')) {
    return 'IMPS';
  }
  if (text.includes('rtgs')) {
    return 'RTGS';
  }
  if (text.includes('auto debit') || text.includes('standing instruction') || text.includes('ecs')) {
    return 'Auto Debit';
  }
  if (text.includes('atm') || text.includes('cash withdrawal')) {
    return 'Cash';
  }
  if (acct.includes('savings')) {
    return 'Net Banking';
  }
  return '';
}

function normalizeSemanticType(typeRaw, amount, category, originalText, accountType, bank, merchantName) {
  const t = (typeRaw || '').toString().trim().toLowerCase();
  const text = (originalText || '').toLowerCase();
  const cat = (category || '').toLowerCase();

  if (['income', 'expense', 'transfer', 'card_payment', 'investment', 'refund'].includes(t)) return t;

  if (isCreditCardPayment(originalText, accountType, bank, merchantName)) return 'card_payment';

  if (/\b(sip|mutual\s+fund|mf|stock|shares?|fd|rd|nps|ppf|investment)\b/i.test(text)) return 'investment';
  if (/\b(refund|reversal|chargeback|money returned)\b/i.test(text)) return 'refund';

  if (/\b(salary|interest|dividend|cashback|pension|bonus)\b/i.test(text)) return 'income';

  if (/\b(transfer|neft|imps|rtgs)\b/i.test(text)) {
    return 'transfer';
  }

  if (amount < 0) return 'expense';
  if (amount > 0 && cat === 'income') return 'income';

  // Never force an unknown inflow into income. Let review handle it.
  return '';
}

/**
 * Stronger duplicate detection:
 * same DateTime + Amount + Bank + Merchant in recent rows.
 */
function isLikelyDuplicateTransaction(sheet, parsed) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return {exact: false, probable: false, row: null};

  const rowCount = Math.min(lastRow - 1, 300);
  const startRow = lastRow - rowCount + 1;
  const data = sheet.getRange(startRow, 1, rowCount, Math.min(TX_COL.FIRST_SEEN_AT, sheet.getLastColumn())).getValues();

  const targetDate = toValidDate(parsed.dateTime);
  const targetAmount = toNumber(parsed.amount);
  const targetBank = String(parsed.bank || '').trim().toLowerCase();
  const targetMerchant = String(parsed.merchantName || '').trim().toLowerCase();
  const targetRef = String(parsed.refNo || '').trim().toLowerCase();

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowRef = String(row[TX_COL.REF_NO - 1] || '').trim().toLowerCase();
    const rowAmount = toNumber(row[TX_COL.AMOUNT - 1]);
    const rowBank = String(row[TX_COL.BANK - 1] || '').trim().toLowerCase();
    const rowMerchant = String(row[TX_COL.MERCHANT_NORMALIZED - 1] || row[TX_COL.MERCHANT - 1] || '').trim().toLowerCase();
    const rowDate = toValidDate(row[TX_COL.DATETIME - 1]);

    if (targetRef && rowRef && targetRef === rowRef && targetBank === rowBank) {
      return {exact: true, probable: true, row: startRow + i};
    }

    const withinMs = Math.abs(rowDate.getTime() - targetDate.getTime());
    const maxWindow = 15 * 60 * 1000;
    const sameDay = rowDate.toDateString() === targetDate.toDateString();
    const probable = sameDay && withinMs <= maxWindow && Math.abs(rowAmount - targetAmount) < 0.01 && rowBank === targetBank && rowMerchant === targetMerchant;
    if (probable) return {exact: false, probable: true, row: startRow + i};
  }
  return {exact: false, probable: false, row: null};
}

/**
 * Insert SMS-based transaction into Transaction Log.
 * Detects duplicates and generates a monthly sequence Transaction ID.
 */
function handleRawTransaction(txnString, originalText, sourceType) {
  sourceType = (sourceType || 'SMS').toUpperCase();
  let parsed = parseTransactionString(txnString, originalText);
  if (parsed.error) {
    return sendJsonResponse(false, {
      errorCode: 'TXN_PARSE_ERROR',
      message: 'Transaction text could not be parsed',
      error: parsed.error,
      example: parsed.example
    });
  }

  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  ensureV3Headers(sheet);
  if (!sheet) {
    return sendJsonResponse(false, {
      errorCode: 'SHEET_MISSING',
      message: 'Transaction sheet not found. Create a sheet named Transaction Log.'
    });
  }

  let dateValue = new Date(parsed.dateTime);
  if (isNaN(dateValue.getTime())) {
    dateValue = new Date(parsed.dateTime);
  }
  const idDateForSeq = toValidDate(dateValue);

  const suggestion = getKnownTransactionSuggestion(parsed.amount, parsed.merchantName, idDateForSeq);
  if (suggestion) {
    if (suggestion.category) parsed.category = suggestion.category;
    if (suggestion.merchantOverride) parsed.merchantName = suggestion.merchantOverride;
    parsed.suggestedNotes = suggestion.notes || '';
    parsed.suggestionIsRecurring = !!suggestion.isRecurring;
    parsed.suggestionTypeOverride = suggestion.typeOverride;
    parsed.suggestionAccountOverride = suggestion.accountOverride;
    parsed.suggestionCardNameOverride = suggestion.cardNameOverride;
  }

  parsed = applyConfigToTransaction(parsed);

  const finalType = parsed.suggestionTypeOverride || parsed.type || '';
  const finalAccount = parsed.suggestionAccountOverride || parsed.account || '';
  const finalCardName = parsed.suggestionCardNameOverride || parsed.cardName || '';
  const finalCounterparty = parsed.counterparty || '';
  const finalRefNo = parsed.refNo || '';
  const finalBalanceAfter = parsed.balanceAfter || '';
  const isRecurring = !!parsed.suggestionIsRecurring;
  const finalNotes = parsed.suggestedNotes || '';
  const finalOriginalText = parsed.originalText || '';
  const sourceTypeFinal = sourceType || 'SMS';
  const sourceHash = sha256Hex(finalOriginalText.trim().replace(/\s+/g,' '));
  const duplicateBySource = findBySourceHash(sourceHash);
  if (duplicateBySource) {
    return sendJsonResponse(true, {success:true, duplicate:true, transactionId: sheet.getRange(duplicateBySource, TX_COL.ID).getValue()});
  }
  const duplicateCandidate = isLikelyDuplicateTransaction(sheet, parsed);
  const needsReview = !finalType || parsed.category === 'Miscellaneous' || duplicateCandidate.probable;
  const reviewReason = !finalType ? 'ambiguous_type' : (parsed.category === 'Miscellaneous' ? 'unknown_category' : (duplicateCandidate.probable ? 'duplicate_candidate' : ''));
  const parserConfidence = finalType ? 0.95 : 0.50;
  const matchKey = buildMatchKey(parsed);
  const now = new Date();
  const sourceId = generateSourceId();
  const merchantNormalized = getMerchantName(parsed.merchantName || '');

  // Probable duplicate is retained; it is never silently rejected.
  if (duplicateCandidate.probable) parsed._probableDuplicateRow = duplicateCandidate.row;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  let sheetRow;
  try {
    const transactionId = generateTransactionId(idDateForSeq);

    sheet.appendRow([
      transactionId, dateValue, parsed.amount, parsed.bank, parsed.accountType, parsed.merchantName, parsed.category,
      finalNotes, finalOriginalText, finalType, parsed.instrument || '', finalAccount, finalCardName, isRecurring, needsReview,
      finalCounterparty, finalRefNo, finalBalanceAfter, now, now, sourceHash, sourceId, reviewReason,
      finalType ? (parsed.suggestionTypeOverride ? 'rule' : 'model') : 'heuristic', parserConfidence,
      parsed.suggestionTypeOverride || parsed.suggestionIsRecurring ? 'rule' : (parsed.category === 'Miscellaneous' ? 'heuristic' : 'model'),
      Array.from(new Set((parsed._rulesApplied || []).concat(suggestion ? [suggestion.ruleId || 'SUGGESTION'] : []))).join(','),
      SCHEMA_VERSION, matchKey, merchantNormalized, '', parserConfidence, 'SMS Only', 'SMS', '', 1, now
    ]);

    sheetRow = sheet.getLastRow();
    const linkedTxnId = transactionId;
    appendSourceLog({
      sourceId: sourceId, txnId: linkedTxnId, sourceType: sourceTypeFinal, rawBody: finalOriginalText,
      sourceHash: sourceHash, refNo: finalRefNo, matchStatus: 'CREATED', matchConfidence: 1
    });
  } finally {
    lock.releaseLock();
  }

  const typeLabel = parsed.amount < 0 ? 'Expense' : 'Income';
  const emoji = parsed.amount < 0 ? '💸' : '💰';
  const absAmount = Math.abs(parsed.amount);
  const categories = getCategoryList();
  const question = parsed.amount < 0
    ? `What's the purpose for spending ${absAmount.toLocaleString('en-IN')} at ${parsed.merchantName}?`
    : `What's the source for income ${absAmount.toLocaleString('en-IN')} from ${parsed.merchantName}?`;

  return sendJsonResponse(true, {
    message: `${emoji} ${typeLabel} of ${absAmount.toLocaleString('en-IN')} logged!`,
    sheetRow: sheetRow,
    transactionId: transactionId,
    requiresUserInput: needsReview,
    question: needsReview ? question : '',
    defaultCategory: parsed.category,
    categories: categories,
    suggestedNotes: finalNotes,
    hasAutoSuggestion: !!suggestion
  });
}
// =============================
// 2. MANUAL TRANSACTION ENTRY
// =============================

/**
 * Manual transaction entry (Shortcuts / manual API calls).
 *
 * Expected key parameters:
 * - dateTime: string
 * - type: emoji/text, e.g. "💰 Income", "💵 Expenses", "income", "expense"
 * - amount: positive number as string
 * - bank, accountType, merchant, notes: optional text
 * - mainCategory, subCategory: used for expenses; for income, category is forced to "Income"
 */
function handleManualTransaction(params) {
  const dateTime = params.dateTime;
  const rawType = params.type;

  if (!dateTime || !rawType) {
    return sendJsonResponse(false, {
      errorCode: 'VALIDATIONREQUIRED',
      message: 'dateTime and type are required for manual transactions.'
    });
  }

  const typeNormalized = normalizeType(rawType); // existing helper: income/expense
  let semanticType = typeNormalized === 'income' ? 'income' : 'expense';

  let mainCategory;
  let subCategory;

  if (semanticType === 'income') {
    mainCategory = 'Income';
    subCategory = params.incomeSource || (params.merchant || 'Other');
  } else {
    mainCategory = params.mainCategory || 'Miscellaneous';
    subCategory = params.subCategory || (params.merchant || 'Other');
  }

  const amountRaw = parseFloat(params.amount || '0');
  if (isNaN(amountRaw) || amountRaw <= 0) {
    return sendJsonResponse(false, {
      errorCode: 'VALIDATIONAMOUNT',
      message: 'Amount must be a number greater than 0.'
    });
  }

  const amount = semanticType === 'income' ? Math.abs(amountRaw) : -Math.abs(amountRaw);

  const bank = (params.bank || params.account || 'Manual').toString().trim();
  const accountType = (params.accountType || 'Manual').toString().trim();
  const merchant = (params.merchant || subCategory || 'Manual Entry').toString().trim();
  const notes = (params.notes || '').toString();

  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  if (!sheet) {
    return sendJsonResponse(false, {
      errorCode: 'SHEETMISSING',
      message: 'Transaction sheet not found. Create a sheet named Transaction Log.'
    });
  }

  let dateValue = new Date(dateTime);
  if (isNaN(dateValue.getTime())) {
    dateValue = new Date(dateTime);
  }
  const idDateForSeq = toValidDate(dateValue);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const transactionId = generateTransactionId(idDateForSeq);

    // Basic instrument inference
    const instrument = inferInstrumentFromText('', accountType);
    const category = semanticType === 'income' ? 'Income' : mainCategory;

    // Apply CONFIG
    let parsed = {
      dateTime: dateTime,
      amount: amount,
      bank: bank,
      accountType: accountType,
      merchantName: merchant,
      category: category,
      instrument: instrument,
      type: semanticType,
      counterparty: '',
      refNo: '',
      originalText: 'MANUAL'
    };
    parsed = applyConfigToTransaction(parsed);

    const isRecurring = false;
    const needsReview = (category === 'Miscellaneous');

    sheet.appendRow([
      transactionId,         // A
      dateValue,             // B
      amount,                // C
      bank,                  // D
      accountType,           // E
      merchant,              // F
      category,              // G
      notes,                 // H
      'MANUAL',              // I
      semanticType,          // J
      parsed.instrument || '',      // K
      parsed.account || '',         // L
      parsed.cardName || '',        // M
      isRecurring,                  // N
      needsReview,                  // O
      '',                           // P
      '',                           // Q
      ''                            // R
    ]);
  } finally {
    lock.releaseLock();
  }

  const label = semanticType === 'income' ? 'Income' : 'Expense';
  return sendJsonResponse(true, {
    message: `${label} of ${Math.abs(amount).toLocaleString('en-IN')} saved!`
  });
}

// =============================
// 3. TRANSACTION RETRIEVAL
// =============================

/**
 * Return the last inserted transaction and category list.
 */
function getLastInsertedTransaction() {
  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  if (!sheet) {
    return sendJsonResponse(false, {
      errorCode: 'SHEET_MISSING',
      message: "Transaction sheet not found. Create a sheet named 'Transaction Log'."
    });
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return sendJsonResponse(false, {
      errorCode: 'NO_DATA',
      message: 'No transactions found.'
    });
  }

  const data = sheet.getRange(lastRow, 1, 1, 9).getValues()[0];
  const amount = data[2];

  const transaction = {
    transactionId: data[0],
    sheetRow: lastRow,
    dateTime: data[1],
    amount,
    bank: data[3],
    accountType: data[4],
    merchantName: data[5],
    category: data[6],
    userNotes: data[7],
    originalText: data[8],
    type: amount < 0 ? 'Expense' : 'Income',
    emoji: amount < 0 ? '💸' : '💰',
    formattedAmount: `₹${Math.abs(amount).toLocaleString('en-IN')}`,
    isComplete: !!(data[6] && data[7])
  };

  return sendJsonResponse(true, {
    transaction,
    categories: getCategoryList()
  });
}

/**
 * Get transactions where Category or User Notes are missing (pending review).
 */
function getTransactionsPendingReview(limit) {
  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  if (!sheet) {
    return sendJsonResponse(false, {
      errorCode: 'SHEET_MISSING',
      message: "Transaction sheet not found. Create a sheet named 'Transaction Log'."
    });
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return sendJsonResponse(true, {
      transactions: [],
      count: 0,
      message: 'No transactions yet',
      categories: getCategoryList()
    });
  }

  // Read all 18 v2 columns
  const allData = sheet.getRange(2, 1, lastRow - 1, 18).getValues();

  const pending = allData
    .map((row, index) => {
      const amount = row[TX_COL.AMOUNT - 1];
      const category = row[TX_COL.CATEGORY - 1];
      const userNotes = row[TX_COL.USER_NOTES - 1];
      const needsReviewCell = row[TX_COL.NEEDS_REVIEW - 1];

      const isComplete = !!category && !!userNotes;
      const needsReview =
        needsReviewCell === true ||
        String(needsReviewCell).toUpperCase() === 'TRUE';

      const shouldReview = needsReview || !isComplete;
      if (!shouldReview) return null;

      const sheetRow = index + 2; // row index in sheet

      return {
        transactionId: row[TX_COL.ID - 1],
        sheetRow,
        dateTime: row[TX_COL.DATETIME - 1],
        amount,
        bank: row[TX_COL.BANK - 1],
        accountType: row[TX_COL.ACCOUNT_TYPE - 1],
        merchantName: row[TX_COL.MERCHANT - 1],
        category,
        userNotes,
        originalText: row[TX_COL.ORIGINAL_TEXT - 1],
        type: amount < 0 ? 'Expense' : 'Income',
        emoji: amount < 0 ? '💸' : '💰',
        formattedAmount: `₹${Math.abs(amount).toLocaleString('en-IN')}`,
        isComplete,
        needsReview: shouldReview
      };
    })
    .filter(Boolean)
    .reverse()
    .slice(0, limit);

  return sendJsonResponse(true, {
    transactions: pending,
    count: pending.length,
    message: pending.length > 0
      ? `${pending.length} transactions need review`
      : 'All caught up! 🎉',
    categories: getCategoryList()
  });
}

/**
 * Get the last N transactions for quick review.
 */
function getLastTransactions(limit) {
  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  if (!sheet) {
    return sendJsonResponse(false, {
      errorCode: 'SHEET_MISSING',
      message: "Transaction sheet not found. Create a sheet named 'Transaction Log'."
    });
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return sendJsonResponse(true, {
      transactions: [],
      message: 'No transactions yet'
    });
  }

  const numRows = Math.min(limit, lastRow - 1);
  const startRow = lastRow - numRows + 1;
  const data = sheet.getRange(startRow, 1, numRows, 9).getValues();

  const transactions = data
    .reverse()
    .map((row, index) => {
      const amount = row[2];
      return {
        transactionId: row[0],
        sheetRow: startRow + (numRows - 1 - index),
        dateTime: row[1],
        amount,
        bank: row[3],
        accountType: row[4],
        merchantName: row[5],
        category: row[6],
        userNotes: row[7],
        originalText: row[8],
        type: amount < 0 ? 'Expense' : 'Income',
        emoji: amount < 0 ? '💸' : '💰',
        formattedAmount: `₹${Math.abs(amount).toLocaleString('en-IN')}`,
        isComplete: !!(row[6] && row[7])
      };
    });

  return sendJsonResponse(true, { transactions });
}

/**
 * Update category and/or user notes for a specific row.
 */
function updateTransaction(sheetRowOrId, category, userNotes, patch, reason, actor) {
  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  if (!sheet) return sendJsonResponse(false,{errorCode:'SHEET_MISSING',message:'Transaction sheet not found.'});

  let rowNumber = Number(sheetRowOrId);
  let txnId = '';
  if (!rowNumber || rowNumber < 2) {
    txnId = String(sheetRowOrId || (patch && patch.transactionId) || '');
    rowNumber = findTransactionRowByTxnIdSafe(txnId);
  } else {
    txnId = String(sheet.getRange(rowNumber, TX_COL.ID).getValue());
  }
  if (rowNumber < 2) return sendJsonResponse(false,{errorCode:'NOT_FOUND',message:'Transaction not found.'});

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const p = patch || {};
    if (category) p.category = category;
    if (userNotes !== undefined) p.userNotes = userNotes;
    const allowed = {category:TX_COL.CATEGORY,userNotes:TX_COL.USER_NOTES,type:TX_COL.TYPE,merchant:TX_COL.MERCHANT,merchantNormalized:TX_COL.MERCHANT_NORMALIZED,subcategory:TX_COL.SUBCATEGORY,needsReview:TX_COL.NEEDS_REVIEW,reviewReason:TX_COL.REVIEW_REASON};
    const row = sheet.getRange(rowNumber,1,1,TX_COL.FIRST_SEEN_AT).getValues()[0];
    const requestId = p.requestId || Utilities.getUuid();
    Object.keys(p).forEach(function(field){
      if (!allowed[field]) return;
      if (p[field] === undefined) return;
      const col = allowed[field];
      const oldValue = row[col-1];
      const newValue = p[field];
      if (String(oldValue) !== String(newValue)) {
        sheet.getRange(rowNumber,col).setValue(newValue);
        setChangeLog(txnId, actor || 'user', field, oldValue, newValue, reason || 'user_update', requestId);
      }
    });
    sheet.getRange(rowNumber,TX_COL.LAST_UPDATED_AT).setValue(new Date());
    return sendJsonResponse(true,{message:'Transaction updated successfully!',transactionId:txnId,sheetRow:rowNumber,requestId});
  } finally {
    lock.releaseLock();
  }
}

/**
 * Static list of valid categories, shared by SMS and manual flows.
 */
function getCategoryList() {
  return [
    'Bills & subscription',
    'Cash',
    'Credit card payments',
    'Food & dining',
    'Healthcare',
    'Housing & utilities',
    'Income',
    'Investment & savings',
    'Miscellaneous',
    'Shopping',
    'Transportation'
  ];
}

// =============================
// 4. MONTHLY OVERVIEW (AI-READY)
// =============================

function getMonthlyOverview(menuType) {
  const summarySheet = financeSheet.getSheetByName(SUMMARY_SHEET_NAME);
  if (!summarySheet) {
    return sendJsonResponse(false, {
      errorCode: 'SHEET_MISSING',
      message: "Summary sheet not found. Create a sheet named 'Monthly Summary'."
    });
  }

  const allData = summarySheet
    .getRange(1, 1, summarySheet.getLastRow(), summarySheet.getLastColumn())
    .getValues();

  let lastDataRow = 1;
  for (let i = allData.length - 1; i >= 1; i--) {
    if (allData[i][0] !== '' && allData[i][0] != null) {
      lastDataRow = i + 1;
      break;
    }
  }

  if (lastDataRow === 1) {
    return sendJsonResponse(true, { message: 'No summary data available yet.' });
  }

  const headers = allData[0];
  const current = allData[lastDataRow - 1];
  let previous = null;
  if (lastDataRow > 2) {
    previous = allData[lastDataRow - 2];
  }

  function safeGet(label, row) {
    const idx = headers.indexOf(label);
    if (idx === -1 || !row || row[idx] === '' || row[idx] == null) return null;
    const numValue = parseFloat(row[idx]);
    return isNaN(numValue) ? null : numValue;
  }

  const monthFromSheet = safeGet('Month', current);
  const month = (monthFromSheet && monthFromSheet !== '') ? monthFromSheet : getMonthLabel();

  const leftToSpend = safeGet('Savings', current) || 0;
  const totalSpent = safeGet('Expenses', current) || 0;
  const creditCardDue = safeGet('CC Due (Net Outstanding)', current) || 0;
  const income = safeGet('Income', current) || 0;

  const percentSpent = (income > 0 && totalSpent > 0)
    ? Math.round((totalSpent / income) * 100)
    : 0;

  let improved = false;
  if (previous) {
    const prevSpent = safeGet('Expenses', previous);
    if (totalSpent != null && prevSpent != null && prevSpent > 0) {
      improved = totalSpent < prevSpent;
    }
  }

  const today = new Date();
  const monthNum = today.getMonth();
  const year = today.getFullYear();
  const lastDayOfMonth = new Date(year, monthNum + 1, 0).getDate();
  const daysLeft = Math.max(0, lastDayOfMonth - today.getDate());
  const dailyAverage = (leftToSpend > 0 && daysLeft > 0)
    ? Math.round(leftToSpend / daysLeft)
    : 0;

  const progressBar = generateProgressBar(percentSpent);

  const leftToSpendFormatted = formatCurrency(leftToSpend);
  const totalSpentFormatted = formatCurrency(totalSpent);
  const creditCardDueFormatted = formatCurrency(creditCardDue);
  const dailyAverageFormatted = formatCurrency(dailyAverage);

  const semanticAnalysis = generateSemanticAnalysis(
    leftToSpend,
    dailyAverage,
    percentSpent,
    improved,
    income
  );
  const aiPrompt = generateOptimizedAIPrompt(semanticAnalysis);

  if (menuType === 'minimal') {
    return sendJsonResponse(true, {
      month,
      leftToSpendFormatted,
      creditCardDueFormatted,
      dailyAverageFormatted,
      daysLeft,
      progressBar,
      aiPrompt
    });
  } else {
    return sendJsonResponse(true, {
      month,
      leftToSpendFormatted,
      totalSpentFormatted,
      creditCardDueFormatted,
      percentSpent,
      dailyAverageFormatted,
      daysLeft,
      progressBar,
      aiPrompt
    });
  }
}

function getMonthLabel() {
  const today = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[today.getMonth()]}-${today.getFullYear().toString().slice(-2)}`;
}

// =============================
// 5. MERCHANT & CATEGORY HELPERS
// =============================

function getMerchantName(rawMerchant) {
  if (!rawMerchant || typeof rawMerchant !== 'string') return 'Unknown Merchant';
  const upper = rawMerchant.toUpperCase().trim();
  const merchantMap = {
    'AVENUE SUPE': 'DMart Shopping','DMART': 'DMart Shopping','METRO CASH': 'METRO Shopping mall',
    'RELIANCE FRESH': 'Reliance Fresh','RELIANCE SMART': 'Reliance Smart','MORE MEGASTORE': 'More Megastore',
    'BIGBASKET': 'BigBasket','BLINKIT': 'Blinkit','INSTAMART': 'Swiggy Instamart','ZEPTO': 'Zepto',
    'SWIGGY': 'Swiggy','ZOMATO': 'Zomato','DUNZO': 'Dunzo','STARBUCKS': 'Starbucks','CCD': 'Cafe Coffee Day',
    'MCDONALDS': "McDonald's",'KFC': 'KFC','DOMINOS': "Domino's",'PIZZA HUT': 'Pizza Hut','SUBWAY': 'Subway',
    'AMAZON PRIME': 'Amazon Prime','AMAZON': 'Amazon','FLIPKART': 'Flipkart','MYNTRA': 'Myntra','AJIO': 'Ajio','MEESHO': 'Meesho',
    'UBER': 'Uber','OLA': 'Ola','RAPIDO': 'Rapido','IRCTC': 'IRCTC','INDIGO': 'IndiGo','SPICEJET': 'SpiceJet',
    'AIRTEL': 'Airtel','JIO': 'Jio','VIJETHA': 'Vijetha Supermarkets','BSNL': 'BSNL','NETFLIX': 'Netflix',
    'HOTSTAR': 'Disney+ Hotstar','SPOTIFY': 'Spotify','YOUTUBE': 'YouTube Premium','BOOKMYSHOW': 'BookMyShow',
    'PVR': 'PVR Cinemas','INOX': 'INOX','APOLLO': 'Apollo Pharmacy','PRACTO': 'Practo','ZERODHA': 'Zerodha',
    'GROWW': 'Groww','UPSTOX': 'Upstox','SI FUND TRANSFER': 'SIP Investment','NEFT': 'Bank Transfer','IMPS': 'Instant Transfer',
    'UPI': 'UPI Payment','SARADA.': 'Mom','SUSIL': 'Baba','SUCHITRA': 'Babu♥','ASISHKUM': 'SELF',
    'SARALA': 'Rgda Mom','SURESH LOHITH': 'H610 Rent','MEDPLUS': 'Medplus Health Services','PENUMATSA S': 'Bhavyas Tiffin Center',
    'HCL': 'HCLTech'
  };
  const keys = Object.keys(merchantMap).sort((a,b)=>b.length-a.length);
  for (const key of keys) {
    const pattern = new RegExp('\\b' + key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\b','i');
    if (pattern.test(upper)) return merchantMap[key];
  }
  return rawMerchant.split(/\s+/).map(word => word ? word.charAt(0).toUpperCase()+word.slice(1).toLowerCase() : '').join(' ').trim();
}

function suggestCategory(merchant) {
  if (!merchant || typeof merchant !== 'string') return 'Miscellaneous';
  const lower = merchant.toLowerCase();
  const categories = [
    ['Bills & subscription', /\b(netflix|amazon prime|spotify|hotstar|youtube|electricity|water|gas|internet|airtel|jio|vi|bsnl|broadband|recharge)\b/i],
    ['Healthcare', /\b(pharma|apollo|medplus|hospital|doctor|medicine|clinic|health|practo)\b/i],
    ['Investment & savings', /\b(zerodha|groww|upstox|sip|mutual fund|stock|investment)\b/i],
    ['Transportation', /\b(uber|ola|rapido|petrol|fuel|metro|irctc|flight|indigo|spicejet|cab|taxi)\b/i],
    ['Food & dining', /\b(swiggy|zomato|dunzo|restaurant|cafe|food|pizza|burger|starbucks|ccd|mcdonald|kfc|domino|subway|pizza hut)\b/i],
    ['Shopping', /\b(dmart|reliance fresh|reliance smart|more|bigbasket|blinkit|instamart|zepto|amazon|flipkart|myntra|shop|mall|store|lifestyle|ajio|meesho)\b/i],
    ['Housing & utilities', /\b(rent|house|apartment|maintenance|utility)\b/i],
    ['Cash', /\b(cash|atm|withdrawal)\b/i],
    ['Credit card payments', /\b(credit card bill|card bill payment|card bill|cc payment)\b/i],
    ['Income', /\b(salary|income)\b/i]
  ];
  for (const [category, pattern] of categories) if (pattern.test(lower)) return category;
  return 'Miscellaneous';
}

function isCreditCardPayment(originalText, accountType, bank, merchant) {
  const text = (originalText || '').toLowerCase();
  const acct = (accountType || '').toLowerCase();
  if (/(spent|purchase|txn\s+of|debited\s+for)\b/i.test(text) && /credit\s*card/i.test(acct + ' ' + text)) return false;

  const explicitSettlement = /(credit\s*card\s*(bill|payment|outstanding)|card\s*bill\s*(payment|paid)|payment\s+(towards|toward|against)\s+.*credit\s*card|paid\s+.*credit\s*card\s+bill)/i;
  if (!explicitSettlement.test(text)) return false;

  const fundingSource = /(upi|imps|neft|rtgs|internet\s*banking|savings?\s*(account|a\/c)|a\/c)/i.test(text + ' ' + acct);
  return fundingSource || /card_payment/i.test(text);
}

// =============================
// 6. UTILITIES
// =============================

function generateProgressBar(percentSpent) {
  if (percentSpent == null || isNaN(percentSpent)) return '░░░░░░ 0%';

  const clampedPercent = Math.min(100, Math.max(0, percentSpent));
  const filledBlocks = Math.round((clampedPercent / 100) * 6);
  const emptyBlocks = 6 - filledBlocks;

  return '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks) + ` ${clampedPercent}%`;
}

function formatCurrency(value) {
  if (value == null || value === '' || isNaN(value)) return '₹0';
  return '₹' + parseFloat(value).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
}

function generateSemanticAnalysis(leftToSpend, dailyAverage, percentSpent, improved, income) {
  if (percentSpent == null || isNaN(percentSpent)) percentSpent = 0;
  if (leftToSpend == null || isNaN(leftToSpend)) leftToSpend = 0;

  let bufferStatus = 'neutral';
  if (percentSpent > 90) bufferStatus = 'critical';
  else if (percentSpent > 70) bufferStatus = 'tight';
  else if (percentSpent < 30) bufferStatus = 'comfortable';
  else if (percentSpent < 50) bufferStatus = 'healthy';

  let dailyCapacityDescriptor = 'moderate daily spending capacity';
  if (income > 0) {
    if (dailyAverage > income / 20) dailyCapacityDescriptor = 'strong daily spending capacity';
    else if (dailyAverage > income / 30) dailyCapacityDescriptor = 'moderate daily spending capacity';
    else dailyCapacityDescriptor = 'limited daily spending capacity';
  }

  let trendDescriptor = improved ? 'positive spending trend' : 'neutral spending pattern';

  let urgencyLevel = 'low';
  if (percentSpent > 85) urgencyLevel = 'high';
  else if (percentSpent > 70) urgencyLevel = 'medium';

  return {
    bufferStatus,
    dailyCapacityDescriptor,
    trendDescriptor,
    urgencyLevel,
    spendingPercentage: percentSpent
  };
}

function generateOptimizedAIPrompt(semanticAnalysis) {
  if (!semanticAnalysis) {
    return 'You are a friendly financial coach. Generate a one-line motivational message about money management. Keep it under 12 words with 1-2 emojis.';
  }

  const { bufferStatus, dailyCapacityDescriptor, trendDescriptor, urgencyLevel } = semanticAnalysis;

  let basePrompt = `You are an empathetic, motivational financial wellness coach. Your role is to provide brief, actionable encouragement about money management.... CONSTRAINTS:
- Output: Exactly 1 line, under 12 words
- Use 1-2 emojis strategically (not excessive)
- No numbers, percentages, or financial figures
- Be conversational and human
- Tone: Warm, supportive, practical
- Avoid generic phrases; be specific to the situation

FINANCIAL CONTEXT (semantic only, no raw data):
- Budget Buffer Status: ${bufferStatus || 'neutral'}
- Daily Spending Capacity: ${dailyCapacityDescriptor || 'moderate daily spending capacity'}
- Recent Trend: ${trendDescriptor || 'neutral spending pattern'}
- Action Urgency: ${urgencyLevel || 'low'}`;

  if (bufferStatus === 'critical') {
    basePrompt += `

SITUATION: User is in critical spending territory. Provide urgent but compassionate guidance.
EXAMPLE: "⚠️ Time to pause—reset spending TODAY!"`;
  } else if (bufferStatus === 'tight') {
    basePrompt += `

SITUATION: User has tight budget. Encourage discipline. Acknowledge effort.
EXAMPLE: "💪 Stay disciplined—you're almost there!"`;
  } else if (bufferStatus === 'healthy' || bufferStatus === 'comfortable') {
    if (trendDescriptor === 'positive spending trend') {
      basePrompt += `

SITUATION: User is improving AND has healthy buffer. Celebrate progress.
EXAMPLE: "🚀 You're crushing it—keep this momentum!"`;
    } else {
      basePrompt += `

SITUATION: Good buffer, neutral pattern. Reinforce consistency, suggest small improvements.
EXAMPLE: "📊 Steady progress—small wins compound!"`;
    }
  } else if (bufferStatus === 'neutral' && urgencyLevel === 'low') {
    basePrompt += `

SITUATION: Balanced path. Provide supportive message.
EXAMPLE: "💡 Keep your eyes on the goal—you've got this!"`;
  }

  basePrompt += `

Now, create your motivational message:`;
  return basePrompt;
}

/**
 * Normalize various date representations into a valid Date.
 * If parsing fails, falls back to "now" so ID generation still works.
 */
function toValidDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }
  const d = new Date(value);
  if (!isNaN(d.getTime())) {
    return d;
  }
  return new Date();
}

/**
 * Normalize a cell value into a Number.
 * Handles values like "25000", "25000.00", "25,000", "₹25,000.00".
 */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (value == null) return NaN;
  let s = value.toString().trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { negative = true; s = s.slice(0, -1); }
  const cleaned = s.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return NaN;
  return negative ? -num : num;
}

/**
 * Generate a monthly transaction ID.
 *
 * Format: "YYYYMM-XXX"
 * - YYYYMM derived from the transaction's own date
 * - XXX is a 3-digit sequence number (001, 002, ...) per month
 *
 * Sequence is stored in Script Properties under key "txnSeq_YYYYMM".
 */
function generateTransactionId(dateValue) {
  const d = toValidDate(dateValue);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const monthStr = month < 10 ? '0' + month : '' + month;
  const periodKey = `${year}${monthStr}`;
  const propKey = `txnSeq_${periodKey}`;

  const props = PropertiesService.getScriptProperties();
  let current = parseInt(props.getProperty(propKey), 10);
  if (isNaN(current) || current < 0) current = 0;

  current += 1;
  props.setProperty(propKey, String(current));

  const seqStr = ('000' + current).slice(-3);
  return `${periodKey}-${seqStr}`;
}

/**
 * Normalize emoji/text type labels coming from Shortcuts.
 */
function normalizeType(rawType) {
  const t = (rawType || '').toString().trim().toLowerCase();
  if (!t) return '';
  if (t.includes('💰')) return 'income';
  if (t.includes('💵') || t.includes('💸')) return 'expense';
  if (t === 'income' || t === 'expense' || t === 'transfer' || t === 'card_payment' || t === 'investment' || t === 'refund') return t;
  if (t.includes('income')) return 'income';
  if (t.includes('expense') || t.includes('expenses') || t.includes('spend') || t.includes('debit')) return 'expense';
  if (t.includes('transfer')) return 'transfer';
  if (t.includes('investment')) return 'investment';
  if (t.includes('refund')) return 'refund';
  if (t.includes('card_payment') || t.includes('card payment')) return 'card_payment';
  return '';
}

/**
 * Helper to respond with JSON payloads.
 */
function sendJsonResponse(success, obj) {
  const output = ContentService.createTextOutput(
    JSON.stringify({ success, ...obj })
  );
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * Load configurable suggestion rules from "Suggestion Rules" sheet.
 */
function getSuggestionRules() {
  const sheet = financeSheet.getSheetByName(SUGGESTION_RULES_SHEETNAME);
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const rules = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const enabled = (row[0] || '').toString().trim().toUpperCase() === 'Y';
    if (!enabled) continue;

    const matchType = (row[1] || '').toString().trim().toUpperCase().replace(/[^A-Z]/g, '');
    const amount = toNumber(row[2]);
    const merchantContains = row[3].toString().trim();
    const category = row[4].toString().trim() || 'Miscellaneous';
    const merchantOverride = row[5].toString().trim();
    const notesTemplate = row[6].toString();
    const monthOffsetRaw = parseInt(row[7], 10);
    const monthOffset = isNaN(monthOffsetRaw) ? 0 : monthOffsetRaw;

    // v2: new columns
    const isRecurringRaw = (row[8] || '').toString().trim().toUpperCase();
    const typeOverride = (row[9] || '').toString().trim().toLowerCase(); // income/expense/transfer/card_payment/investment/refund
    const accountOverride = (row[10] || '').toString().trim();
    const cardNameOverride = (row[11] || '').toString().trim();

    // Basic validation
    if (matchType === 'AMOUNT' || matchType === 'AMOUNTMERCHANT') {
      if (isNaN(amount) || amount === 0) continue;
    }
    if (matchType === 'MERCHANT' || matchType === 'AMOUNTMERCHANT') {
      if (!merchantContains) continue;
    }

    rules.push({
      matchType: matchType,
      amount: amount,
      merchantContains: merchantContains,
      category: category,
      merchantOverride: merchantOverride,
      notesTemplate: notesTemplate,
      monthOffset: monthOffset,
      isRecurring: isRecurringRaw === 'Y',
      typeOverride: typeOverride,
      accountOverride: accountOverride,
      cardNameOverride: cardNameOverride
    });
  }

  return rules;
}

function getConfigRecords() {
  const sheet = financeSheet.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const configs = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    configs.push({
      bank: (row[0] || '').toString().trim().toLowerCase(),
      accountTypePattern: (row[1] || '').toString().trim().toLowerCase(),
      merchantPattern: (row[2] || '').toString().trim().toLowerCase(),
      account: (row[3] || '').toString().trim(),
      cardName: (row[4] || '').toString().trim(),
      instrument: (row[5] || '').toString().trim(),
      isInternalAccount: (row[6] || '').toString().trim().toUpperCase() === 'Y',
      textPattern: (row[7] || '').toString().trim().toLowerCase()
    });
  }

  return configs;
}

function applyConfigToTransaction(parsed) {
  const bankLower = String(parsed.bank || '').toLowerCase();
  const acctLower = String(parsed.accountType || '').toLowerCase();
  const merchLower = String(parsed.merchantName || '').toLowerCase();
  const textLower = String(parsed.originalText || '').toLowerCase();
  const configs = getConfigRecords();

  parsed._rulesApplied = Array.isArray(parsed._rulesApplied) ? parsed._rulesApplied : [];
  let matched = false;

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    if (cfg.bank && !bankLower.includes(cfg.bank)) continue;
    if (cfg.accountTypePattern && !acctLower.includes(cfg.accountTypePattern)) continue;
    if (cfg.merchantPattern && !merchLower.includes(cfg.merchantPattern)) continue;
    if (cfg.textPattern && !textLower.includes(cfg.textPattern)) continue;

    matched = true;
    parsed._rulesApplied.push('CONFIG_' + (i + 1));
    if (cfg.account) parsed.account = cfg.account;
    if (cfg.cardName) parsed.cardName = cfg.cardName;
    if (cfg.instrument) parsed.instrument = cfg.instrument;
    if (cfg.isInternalAccount && !parsed.type) parsed.type = 'transfer';
    if (cfg.isInternalAccount) parsed.isInternalAccount = true;
  }

  parsed._configMatched = matched;
  return parsed;
}

/**
 * Compute a month label like "May-26" from a base date and offset.
 */
function getMonthLabelForOffset(baseDate, offset) {
  const d = toValidDate(baseDate);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const year = d.getFullYear();
  const month = d.getMonth();
  const target = new Date(year, month + (offset || 0), 1);
  return `${months[target.getMonth()]}-${String(target.getFullYear()).slice(-2)}`;
}

/**
 * Apply a notes template, replacing placeholders.
 */
function applyNotesTemplate(template, baseDate, offset) {
  if (!template) return '';
  const monthLabel = getMonthLabelForOffset(baseDate, offset || 0);
  return template.replace(/\{monthLabel\}/g, monthLabel);
}

/**
 * Known transaction suggestions based on configuration.
 * All amounts are matched on ABSOLUTE value.
 */
function getKnownTransactionSuggestion(amount, merchantName, dateValue) {
  const absAmt = Math.abs(toNumber(amount));
  const merch = (merchantName || '').toString().trim().toLowerCase();
  const d = toValidDate(dateValue);
  const rules = getSuggestionRules();

  for (const rule of rules) {
    const mt = String(rule.matchType || '').toUpperCase().replace(/[^A-Z]/g, '');

    if (mt === 'AMOUNT') {
      if (Math.abs(rule.amount - absAmt) > 0.0001) continue;
    } else if (mt === 'AMOUNTMERCHANT') {
      if (Math.abs(rule.amount - absAmt) > 0.0001) continue;
      if (!rule.merchantContains || !merch.includes(rule.merchantContains.toLowerCase())) continue;
    } else if (mt === 'MERCHANT') {
      if (!rule.merchantContains || !merch.includes(rule.merchantContains.toLowerCase())) continue;
    } else {
      continue;
    }

    const notes = applyNotesTemplate(rule.notesTemplate, d, rule.monthOffset);
    return {
      ruleId: 'SUGGESTION_' + (rules.indexOf(rule) + 1),
      category: rule.category || 'Miscellaneous',
      merchantOverride: rule.merchantOverride || '',
      notes: notes || '',
      isRecurring: rule.isRecurring,
      typeOverride: rule.typeOverride,
      accountOverride: rule.accountOverride,
      cardNameOverride: rule.cardNameOverride
    };
  }

  return null;
}


// ============================================================
// v3.0 MIGRATION HELPERS
// ============================================================

function getSchemaHeaders() {
  return [
    'Transaction ID','DateTime','Amount','Bank','Account Type','Merchant','Category','User Notes','Original Text',
    'Type','Instrument','Account','Card Name','Is Recurring','Needs Review','Counterparty','Ref No','Balance After',
    'Created At','Last Updated At','Source Hash','Source ID','Review Reason','Type Source','Type Confidence','Category Source',
    'Rules Applied','Schema Version','Match Key','Merchant Normalized','Subcategory','Parser Confidence','Verification Status',
    'Verification Source','Verified At','Source Count','First Seen At'
  ];
}

function ensureV3Headers(sheet) {
  const headers = getSchemaHeaders();
  if (sheet.getLastColumn() < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    const mismatch = headers.some((h, i) => current[i] !== h && !(i < 18 && current[i]));
    if (mismatch) throw new Error('Transaction Log schema mismatch. Run the spreadsheet migration before deploying v3.0.');
  }
}

function ensureSourceLog() {
  let sheet = financeSheet.getSheetByName(SOURCE_LOG_SHEET_NAME);
  if (!sheet) sheet = financeSheet.insertSheet(SOURCE_LOG_SHEET_NAME);
  const headers = ['Source ID','Linked Txn ID','Source Type','Received At','Sender','Subject','Raw Body','Parser Version','Parse Status','Parse Result','Source Hash','Ref No','Candidate Txn IDs','Match Status','Match Confidence','Request ID','Idempotency Key','Created At'];
  if (sheet.getLastRow() === 0) sheet.getRange(1,1,1,headers.length).setValues([headers]);
  return sheet;
}

function ensureChangeLog() {
  let sheet = financeSheet.getSheetByName(CHANGE_LOG_SHEET_NAME);
  if (!sheet) sheet = financeSheet.insertSheet(CHANGE_LOG_SHEET_NAME);
  const headers = ['Change ID','Transaction ID','Changed At','Actor','Field','Old Value','New Value','Reason','Request ID'];
  if (sheet.getLastRow() === 0) sheet.getRange(1,1,1,headers.length).setValues([headers]);
  return sheet;
}

function sha256Hex(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text || '', Utilities.Charset.UTF_8);
  return bytes.map(function(b){ const v=(b<0?b+256:b).toString(16); return v.length===1?'0'+v:v; }).join('');
}

function generateSourceId() {
  return 'SRC-' + Utilities.getUuid();
}

function buildMatchKey(parsed) {
  const ref = String(parsed.refNo || '').trim().toLowerCase();
  if (ref) return 'REF|' + String(parsed.bank || '').trim().toLowerCase() + '|' + ref;
  const dt = toValidDate(parsed.dateTime);
  const day = Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return ['FP', String(parsed.bank||'').trim().toLowerCase(), String(parsed.accountType||'').trim().toLowerCase(),
    Number(parsed.amount).toFixed(2), getMerchantName(parsed.merchantName||'').toLowerCase(), day, String(parsed.type||'').toLowerCase()].join('|');
}

function setChangeLog(txnId, actor, field, oldValue, newValue, reason, requestId) {
  const sheet = ensureChangeLog();
  sheet.appendRow([Utilities.getUuid(), txnId, new Date(), actor || 'system', field, oldValue == null ? '' : oldValue, newValue == null ? '' : newValue, reason || '', requestId || '']);
}

function findTransactionRowByTxnIdSafe(txnId) {
  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  if (!sheet || !txnId) return -1;
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  const values = sheet.getRange(2, TX_COL.ID, lastRow - 1, 1).getValues();
  for (let i=0;i<values.length;i++) if (String(values[i][0]) === String(txnId)) return i+2;
  return -1;
}

function findBySourceHash(hash) {
  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  if (!sheet || !hash || sheet.getLastRow() <= 1 || sheet.getLastColumn() < TX_COL.SOURCE_HASH) return null;
  const values = sheet.getRange(2, TX_COL.SOURCE_HASH, sheet.getLastRow()-1, 1).getValues();
  for (let i=0;i<values.length;i++) if (String(values[i][0]) === hash) return i+2;
  return null;
}

function appendSourceLog(source) {
  const sheet = ensureSourceLog();
  sheet.appendRow([
    source.sourceId || generateSourceId(), source.txnId || '', source.sourceType || 'SMS', source.receivedAt || new Date(),
    source.sender || '', source.subject || '', source.rawBody || '', source.parserVersion || PARSER_FORMAT_VERSION,
    source.parseStatus || 'PARSED', source.parseResult || '', source.sourceHash || '', source.refNo || '',
    source.candidateTxnIds || '', source.matchStatus || 'UNMATCHED', source.matchConfidence == null ? '' : source.matchConfidence,
    source.requestId || '', source.idempotencyKey || '', new Date()
  ]);
}

function markVerification(sheetRow, status, source, reason) {
  const now = new Date();
  sheet.getRange(sheetRow, TX_COL.VERIFICATION_STATUS).setValue(status);
  sheet.getRange(sheetRow, TX_COL.VERIFICATION_SOURCE).setValue(source || '');
  sheet.getRange(sheetRow, TX_COL.VERIFIED_AT).setValue(status === 'Verified' ? now : '');
  if (reason) sheet.getRange(sheetRow, TX_COL.REVIEW_REASON).setValue(reason);
  sheet.getRange(sheetRow, TX_COL.LAST_UPDATED_AT).setValue(now);
}

function updateVerificationFromSourceMatch(txnRow, parsedEmail) {
  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  const values = sheet.getRange(txnRow,1,1,TX_COL.FIRST_SEEN_AT).getValues()[0];
  const sameAmount = Math.abs(toNumber(values[TX_COL.AMOUNT-1]) - toNumber(parsedEmail.amount)) < 0.01;
  const sameRef = String(values[TX_COL.REF_NO-1] || '').trim() && String(parsedEmail.refNo || '').trim() && String(values[TX_COL.REF_NO-1]).trim() === String(parsedEmail.refNo).trim();
  const sameBank = String(values[TX_COL.BANK-1]).trim().toLowerCase() === String(parsedEmail.bank).trim().toLowerCase();
  const merchantOld = String(values[TX_COL.MERCHANT_NORMALIZED-1] || values[TX_COL.MERCHANT-1] || '').trim().toLowerCase();
  const merchantNew = String(getMerchantName(parsedEmail.merchantName||'')).trim().toLowerCase();
  const merchantCompatible = !merchantNew || merchantNew === 'unspecified' || merchantOld === merchantNew || merchantOld.includes(merchantNew) || merchantNew.includes(merchantOld);
  const verified = sameAmount && sameBank && (sameRef || merchantCompatible);
  const source = String(values[TX_COL.VERIFICATION_SOURCE-1] || '').trim();
  markVerification(txnRow, verified ? 'Verified' : 'Conflict', source ? source + '+EMAIL' : 'SMS+EMAIL', verified ? '' : 'source_conflict');
  return verified;
}

function ingestSecondarySource(params) {
  const rawText = params.originalText || params.sourceBody || '';
  const txnString = params.txnString || '';
  const sourceType = (params.sourceType || 'EMAIL').toString().toUpperCase();
  const requestId = params.requestId || Utilities.getUuid();
  const idempotencyKey = params.idempotencyKey || sha256Hex(sourceType + '|' + rawText);
  const sourceHash = sha256Hex((rawText || '').trim().replace(/\\s+/g,' '));
  const dupRow = findBySourceHash(sourceHash);
  if (dupRow) return sendJsonResponse(true, {duplicate:true, transactionId: financeSheet.getSheetByName(TRANSACTION_SHEET_NAME).getRange(dupRow,TX_COL.ID).getValue(), requestId});

  const parsed = parseTransactionString(txnString, rawText);
  if (parsed.error) return sendJsonResponse(false, {errorCode:'TXN_PARSE_ERROR', message:'Transaction text could not be parsed', error:parsed.error, requestId});

  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  ensureV3Headers(sheet);
  const candidates = isLikelyDuplicateTransaction(sheet, parsed);
  if (candidates.row) {
    const existingId = sheet.getRange(candidates.row, TX_COL.ID).getValue();
    const verified = updateVerificationFromSourceMatch(candidates.row, parsed);
    const sourceCount = Number(sheet.getRange(candidates.row, TX_COL.SOURCE_COUNT).getValue() || 0) + 1;
    sheet.getRange(candidates.row, TX_COL.SOURCE_COUNT).setValue(sourceCount);
    appendSourceLog({sourceId:generateSourceId(),txnId:existingId,sourceType,rawBody:rawText,sourceHash,refNo:parsed.refNo,matchStatus:verified?'MATCHED':'CONFLICT',matchConfidence:candidates.exact?1:0.8,requestId,idempotencyKey});
    return sendJsonResponse(true,{transactionId:existingId,reconciled:true,verified,requestId});
  }

  return handleRawTransaction(txnString, rawText, sourceType);
}
function applyConfigToTransaction(parsed) {
  const bankLower = String(parsed.bank || '').toLowerCase();
  const acctLower = String(parsed.accountType || '').toLowerCase();
  const merchLower = String(parsed.merchantName || '').toLowerCase();
  const textLower = String(parsed.originalText || '').toLowerCase();
  const configs = getConfigRecords();

  parsed._rulesApplied = Array.isArray(parsed._rulesApplied) ? parsed._rulesApplied : [];
  let matched = false;

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    if (cfg.bank && !bankLower.includes(cfg.bank)) continue;
    if (cfg.accountTypePattern && !acctLower.includes(cfg.accountTypePattern)) continue;
    if (cfg.merchantPattern && !merchLower.includes(cfg.merchantPattern)) continue;
    if (cfg.textPattern && !textLower.includes(cfg.textPattern)) continue;

    matched = true;
    parsed._rulesApplied.push('CONFIG_' + (i + 1));
    if (cfg.account) parsed.account = cfg.account;
    if (cfg.cardName) parsed.cardName = cfg.cardName;
    if (cfg.instrument) parsed.instrument = cfg.instrument;
    if (cfg.isInternalAccount && !parsed.type) parsed.type = 'transfer';
    if (cfg.isInternalAccount) parsed.isInternalAccount = true;
  }

  parsed._configMatched = matched;
  return parsed;
}