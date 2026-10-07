/**
 * Personal Finance Web App
 *
 * Transaction Log schema (Transaction Log sheet):
 * The canonical Transaction Log schema is defined by TX_COL below (A:R).
 * Original Text is retained as temporary evidence for the current phase and
 * will migrate to a separate Source Log in the next design phase.
 *
 * Summary sheet (Monthly Summary) is read-only for this script.
 */

function test_doGet_rent_case() {
  const e = {
    parameter: {
      txnString: '2026-06-26 07:18:24 | -100 | Axis | Credit Card | Credit Card | expense | Bhavyas Tiffin Center | PENUMATSA S | REF123456',
      originalText: 'Dummy'
    }
  };

  const result = doGet(e);
  Logger.log(result.getContent());
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
const SUGGESTION_RULES_SHEET_NAME = 'Suggestion Rules';
const financeSheet = SpreadsheetApp.openById(SHEET_ID);
const CONFIG_SHEET_NAME = 'CONFIG';
const PARSED_TRANSACTION_FIELD_COUNT = 9;
const SEMANTIC_TYPES = ['income', 'expense', 'transfer', 'card_payment', 'investment', 'refund'];

// Transaction Log column indices (1-based)
const TX_COL = {
  ID: 1,              // A: Transaction ID
  DATETIME: 2,        // B: DateTime
  AMOUNT: 3,          // C: Amount
  BANK: 4,            // D: Bank
  ACCOUNT_TYPE: 5,    // E: Account Type
  MERCHANT: 6,        // F: Merchant
  CATEGORY: 7,        // G: Category
  USER_NOTES: 8,      // H: User Notes
  ORIGINAL_TEXT: 9,   // I: Original Text
  TYPE: 10,           // J: Type
  INSTRUMENT: 11,     // K: Instrument
  ACCOUNT: 12,        // L: Account
  CARD_NAME: 13,      // M: Card Name
  IS_RECURRING: 14,   // N: Is Recurring (TRUE/FALSE)
  NEEDS_REVIEW: 15,   // O: Needs Review (TRUE/FALSE)
  COUNTERPARTY: 16,   // P: Counterparty
  REF_NO: 17,         // Q: Ref No
  BALANCE_AFTER: 18   // R: Balance After (optional)
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
 *     ?txnString=DateTime | Amount | Bank | Account Type | Instrument | Type | Merchant | Counterparty | RefNo&originalText=...
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
 *     ?action=updateTransaction&transactionId=...&category=...&notes=...
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
    // 1) SMS-based transaction
    if (p.txnString) {
      const originalText = p.originalText || '';
      return handleRawTransaction(p.txnString, originalText);
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
      const limit = getBoundedLimit(p.limit, 10);
      return getTransactionsPendingReview(limit);
    }

    if (p.action === 'updateTransaction') {
      let transactionId = (p.transactionId || '').toString().trim();
      // Temporary compatibility for existing Shortcuts. New callers must send
      // transactionId because row numbers can change when the sheet is sorted.
      if (!transactionId && p.sheetRow) {
        transactionId = getTransactionIdAtLegacyRow(p.sheetRow);
      }
      const category = p.category || '';
      const hasNotes = Object.prototype.hasOwnProperty.call(p, 'notes');
      const userNotes = hasNotes ? p.notes : undefined;
      return updateTransaction(transactionId, category, userNotes);
    }

    if (p.action === 'lastTransactions') {
      const limit = getBoundedLimit(p.limit, 5);
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
      debug: `doGet: ${error.toString()}`
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
 *   DateTime | Amount | Bank | Account Type | Merchant
 *   DateTime | Amount | Bank | Account Type | Instrument | Type | Merchant | Counterparty | RefNo
 *
 * The five-field form is retained only for legacy Shortcuts. New parser output
 * must always use the nine-field contract in Prompt.txt.
 */
function parseTransactionString(txnString, originalText) {
  if (!txnString || typeof txnString !== 'string') {
    return { error: 'Transaction string is empty or invalid' };
  }

  const trimmed = txnString.trim();
  const parts = trimmed.split('|').map(p => (p || '').trim());
  const originalCount = parts.length;

  if (originalCount !== 5 && originalCount !== PARSED_TRANSACTION_FIELD_COUNT) {
    return {
      error: 'Invalid format. Expected exactly 5 legacy fields or 9 current fields.',
      example: '2026-06-26 07:18:24 | -100 | Axis | Credit Card | Credit Card | expense | Bhavyas Tiffin Center | PENUMATSA S | REF123456'
    };
  }

  let dateTime = parts[0] || '';
  const amountText = parts[1] || '';
  let amount = Number(amountText);
  let bank = normalizeUnknownValue(parts[2]);
  let accountType = normalizeUnknownValue(parts[3]);

  let instrument = '';
  let typeRaw = '';
  let rawMerchant = '';
  let counterparty = '';
  let refNo = '';

  if (originalCount === 5) {
    // Legacy format:
    // datetime | signed_amount | bank | account_type | merchant_name
    rawMerchant = normalizeUnknownValue(parts[4]);
  } else {
    // Current format:
    // datetime | signed_amount | bank | account_type | instrument | type | merchant_name | counterparty | ref_no
    instrument = normalizeUnknownValue(parts[4]);
    typeRaw = normalizeUnknownValue(parts[5]);
    rawMerchant = normalizeUnknownValue(parts[6]);
    counterparty = normalizeUnknownValue(parts[7]);
    refNo = normalizeUnknownValue(parts[8]);
  }

  if (!dateTime) return { error: 'DateTime is missing' };
  if (!parseCanonicalDateTime(dateTime)) return { error: 'DateTime must use yyyy-MM-dd HH:mm:ss.' };
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(amountText) || !isFinite(amount) || amount === 0) return { error: 'Amount is invalid or zero' };
  if (!bank) return { error: 'Bank name is missing' };
  if (!accountType) return { error: 'Account Type is missing' };

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
    balanceAfter: '',
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
  const t = (typeRaw || '').toLowerCase();
  const text = (originalText || '').toLowerCase();
  const cat = (category || '').toLowerCase();

  // If the prompt supplied a valid semantic type, preserve it.
  if (isSemanticType(t)) {
    return t;
  }

  // A positive refund must not be collapsed into generic income.
  if (text.includes('refund') || text.includes('reversal') || text.includes('chargeback')) {
    return 'refund';
  }

  // Inflows
  if (amount > 0) {
    if (cat === 'income' || text.includes('salary') || text.includes('credited') || text.includes('interest') || text.includes('cashback')) {
      return 'income';
    }
    return 'income';
  }

  // Outflows
  if (isCreditCardPayment(originalText, accountType, bank, merchantName)) {
    return 'card_payment';
  }
  if (cat === 'investment & savings' || text.includes('sip') || text.includes('mutual fund') || text.includes('stock') || text.includes('fd ') || text.includes('rd ')) {
    return 'investment';
  }

  // Simple internal transfer heuristic: bank transfer with generic merchant names
  const m = (merchantName || '').toLowerCase();
  if (text.includes('transfer') || text.includes('neft') || text.includes('imps')) {
    // You can refine this later using CONFIG
    if (m.includes('self') || m.includes('wallet') || m.includes('axis') || m.includes('sbi')) {
      return 'transfer';
    }
  }

  return 'expense';
}

/**
 * Stronger duplicate detection:
 * same DateTime + Amount + Bank + Merchant in recent rows.
 */
function isLikelyDuplicateTransaction(sheet, parsed) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;

  const checkStart = Math.max(2, lastRow - 49);
  const numRows = lastRow - checkStart + 1;
  const recentData = sheet.getRange(checkStart, 2, numRows, 5).getValues();
  // B: DateTime, C: Amount, D: Bank, E: Account Type, F: Merchant

  const targetDate = toDateKey(parsed.dateTime);
  const targetAmount = toNumber(parsed.amount);
  const targetBank = (parsed.bank || '').toString().trim().toLowerCase();
  const targetMerchant = (parsed.merchantName || '').toString().trim().toLowerCase();

  return recentData.some(row => {
    const rowDate = toDateKey(row[0]);
    const rowAmount = toNumber(row[1]);
    const rowBank = (row[2] || '').toString().trim().toLowerCase();
    const rowMerchant = (row[4] || '').toString().trim().toLowerCase();

    return (
      rowDate === targetDate &&
      Math.abs(rowAmount - targetAmount) < 0.01 &&
      rowBank === targetBank &&
      rowMerchant === targetMerchant
    );
  });
}

/**
 * Insert SMS-based transaction into Transaction Log.
 * Detects duplicates and generates a monthly sequence Transaction ID.
 */
function handleRawTransaction(txnString, originalText) {
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
  if (!sheet) {
    return sendJsonResponse(false, {
      errorCode: 'SHEET_MISSING',
      message: 'Transaction sheet not found. Create a sheet named Transaction Log.'
    });
  }

  const dateValue = parseCanonicalDateTime(parsed.dateTime);
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

  if (!getCategoryList().includes(parsed.category)) {
    parsed.category = 'Miscellaneous';
  }

  const finalType = isSemanticType(parsed.suggestionTypeOverride)
    ? parsed.suggestionTypeOverride
    : parsed.type || '';
  const finalAccount = parsed.suggestionAccountOverride || parsed.account || '';
  const finalCardName = parsed.suggestionCardNameOverride || parsed.cardName || '';
  const finalCounterparty = parsed.counterparty || '';
  const finalRefNo = parsed.refNo || '';
  const finalBalanceAfter = parsed.balanceAfter || '';
  const isRecurring = !!parsed.suggestionIsRecurring;
  const needsReview = parsed.category === 'Miscellaneous' || !isSemanticType(finalType);
  const finalNotes = parsed.suggestedNotes || '';
  const finalOriginalText = parsed.originalText || 'SMSAUTO';

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  let sheetRow;
  try {
    if (isLikelyDuplicateTransaction(sheet, parsed)) {
      return sendJsonResponse(false, {
        errorCode: 'DUPLICATE_TRANSACTION',
        message: 'This transaction looks like a duplicate and was not added.',
        duplicate: {
          dateTime: parsed.dateTime,
          amount: parsed.amount,
          bank: parsed.bank,
          merchant: parsed.merchantName
        }
      });
    }

    const transactionId = generateTransactionId(idDateForSeq);

    sheet.appendRow([
      transactionId,
      dateValue,
      parsed.amount,
      parsed.bank,
      parsed.accountType,
      parsed.merchantName,
      parsed.category,
      finalNotes,
      finalOriginalText,
      finalType,
      parsed.instrument || '',
      finalAccount,
      finalCardName,
      isRecurring,
      needsReview,
      finalCounterparty,
      finalRefNo,
      finalBalanceAfter
    ]);

    sheetRow = sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }

  const typeLabel = getTypeLabel(finalType);
  const emoji = parsed.amount < 0 ? '💸' : '💰';
  const absAmount = Math.abs(parsed.amount);
  const categories = getCategoryList();
  const question = parsed.amount < 0
    ? `What's the purpose for spending ${absAmount.toLocaleString('en-IN')} at ${parsed.merchantName}?`
    : `What's the source for income ${absAmount.toLocaleString('en-IN')} from ${parsed.merchantName}?`;

  return sendJsonResponse(true, {
    message: `${emoji} ${typeLabel} of ${absAmount.toLocaleString('en-IN')} logged!`,
    sheetRow: sheetRow,
    question: question,
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

  const typeNormalized = normalizeType(rawType);
  if (!typeNormalized) {
    return sendJsonResponse(false, {
      errorCode: 'VALIDATION_TYPE',
      message: 'type must be income or expense for manual entries.'
    });
  }
  const semanticType = typeNormalized;

  let mainCategory;
  let subCategory;

  if (semanticType === 'income') {
    mainCategory = 'Income';
    subCategory = params.incomeSource || (params.merchant || 'Other');
  } else {
    mainCategory = params.mainCategory || 'Miscellaneous';
    subCategory = params.subCategory || (params.merchant || 'Other');
  }

  if (!getCategoryList().includes(mainCategory)) {
    return sendJsonResponse(false, {
      errorCode: 'VALIDATION_CATEGORY',
      message: `Category must be one of: ${getCategoryList().join(', ')}.`
    });
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

  const dateValue = parseCanonicalDateTime(dateTime);
  if (!dateValue) {
    return sendJsonResponse(false, {
      errorCode: 'VALIDATION_DATETIME',
      message: 'dateTime must use yyyy-MM-dd HH:mm:ss.'
    });
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
    const finalCategory = getCategoryList().includes(parsed.category)
      ? parsed.category
      : category;
    const finalMerchant = parsed.merchantName || merchant;
    const needsReview = (finalCategory === 'Miscellaneous');

    sheet.appendRow([
      transactionId,         // A
      dateValue,             // B
      amount,                // C
      bank,                  // D
      accountType,           // E
      finalMerchant,         // F
      finalCategory,         // G
      notes,                 // H
      'MANUAL',              // I
      parsed.type || semanticType, // J
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

function transactionRowToResponse(row, sheetRow) {
  const amount = toNumber(row[TX_COL.AMOUNT - 1]);
  const type = (row[TX_COL.TYPE - 1] || '').toString().toLowerCase();
  const needsReviewCell = row[TX_COL.NEEDS_REVIEW - 1];
  const needsReview = needsReviewCell === true || String(needsReviewCell).toUpperCase() === 'TRUE';

  return {
    transactionId: row[TX_COL.ID - 1],
    sheetRow,
    dateTime: row[TX_COL.DATETIME - 1],
    amount,
    bank: row[TX_COL.BANK - 1],
    accountType: row[TX_COL.ACCOUNT_TYPE - 1],
    merchantName: row[TX_COL.MERCHANT - 1],
    category: row[TX_COL.CATEGORY - 1],
    userNotes: row[TX_COL.USER_NOTES - 1],
    type,
    typeLabel: getTypeLabel(type),
    instrument: row[TX_COL.INSTRUMENT - 1],
    account: row[TX_COL.ACCOUNT - 1],
    cardName: row[TX_COL.CARD_NAME - 1],
    isRecurring: row[TX_COL.IS_RECURRING - 1] === true || String(row[TX_COL.IS_RECURRING - 1]).toUpperCase() === 'TRUE',
    needsReview,
    counterparty: row[TX_COL.COUNTERPARTY - 1],
    refNo: row[TX_COL.REF_NO - 1],
    balanceAfter: row[TX_COL.BALANCE_AFTER - 1],
    emoji: amount < 0 ? '💸' : '💰',
    formattedAmount: `₹${Math.abs(amount).toLocaleString('en-IN')}`,
    isComplete: !!row[TX_COL.CATEGORY - 1] &&
      row[TX_COL.CATEGORY - 1] !== 'Miscellaneous' &&
      isSemanticType(type) &&
      !needsReview
  };
}

function findTransactionRowById(sheet, transactionId) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;

  const ids = sheet.getRange(2, TX_COL.ID, lastRow - 1, 1).getValues();
  const target = transactionId.toString().trim();
  for (let i = 0; i < ids.length; i++) {
    if ((ids[i][0] || '').toString().trim() === target) return i + 2;
  }
  return 0;
}

function getTransactionIdAtLegacyRow(value) {
  const sheetRow = parseInt(value, 10);
  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  if (!sheet || isNaN(sheetRow) || sheetRow < 2 || sheetRow > sheet.getLastRow()) return '';
  return (sheet.getRange(sheetRow, TX_COL.ID).getValue() || '').toString().trim();
}

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

  const data = sheet.getRange(lastRow, 1, 1, TX_COL.BALANCE_AFTER).getValues()[0];
  const transaction = transactionRowToResponse(data, lastRow);

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
      const transaction = transactionRowToResponse(row, index + 2);
      const shouldReview = transaction.needsReview || !transaction.isComplete;
      if (!shouldReview) return null;
      return transaction;
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
  const data = sheet.getRange(startRow, 1, numRows, TX_COL.BALANCE_AFTER).getValues();

  const transactions = data
    .reverse()
    .map((row, index) => transactionRowToResponse(row, startRow + (numRows - 1 - index)));

  return sendJsonResponse(true, { transactions });
}

/**
 * Update category and/or user notes for a transaction ID.
 */
function updateTransaction(transactionId, category, userNotes) {
  if (!transactionId) {
    return sendJsonResponse(false, {
      errorCode: 'VALIDATION_REQUIRED',
      message: 'transactionId is required.'
    });
  }

  const sheet = financeSheet.getSheetByName(TRANSACTION_SHEET_NAME);
  if (!sheet) {
    return sendJsonResponse(false, {
      errorCode: 'SHEET_MISSING',
      message: "Transaction sheet not found. Create a sheet named 'Transaction Log'."
    });
  }

  const sheetRow = findTransactionRowById(sheet, transactionId);
  if (!sheetRow) {
    return sendJsonResponse(false, {
      errorCode: 'TRANSACTION_NOT_FOUND',
      message: 'No transaction was found for this transactionId.'
    });
  }

  const categories = getCategoryList();
  if (category && !categories.includes(category)) {
    return sendJsonResponse(false, {
      errorCode: 'VALIDATION_CATEGORY',
      message: `Category must be one of: ${categories.join(', ')}.`
    });
  }

  if (category) {
    sheet.getRange(sheetRow, 7).setValue(category);
  }

  if (userNotes !== undefined && userNotes !== null) {
    sheet.getRange(sheetRow, 8).setValue(userNotes);
  }

  const updated = sheet.getRange(sheetRow, 1, 1, TX_COL.BALANCE_AFTER).getValues()[0];
  const finalCategory = updated[TX_COL.CATEGORY - 1];
  const finalType = updated[TX_COL.TYPE - 1];
  const shouldReview = finalCategory === 'Miscellaneous' || !isSemanticType(finalType);
  sheet.getRange(sheetRow, TX_COL.NEEDS_REVIEW).setValue(shouldReview);
  updated[TX_COL.NEEDS_REVIEW - 1] = shouldReview;

  return sendJsonResponse(true, {
    message: '✅ Transaction updated successfully!',
    transaction: transactionRowToResponse(updated, sheetRow),
    isComplete: !!finalCategory &&
      finalCategory !== 'Miscellaneous' &&
      isSemanticType(finalType) &&
      !shouldReview
  });
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

  function getCell(label, row) {
    const idx = headers.indexOf(label);
    return idx === -1 || !row ? null : row[idx];
  }

  function firstNumeric(labels, row) {
    for (const label of labels) {
      const value = safeGet(label, row);
      if (value !== null) return value;
    }
    return 0;
  }

  const monthFromSheet = getCell('Month', current);
  const month = monthFromSheet == null || monthFromSheet === '' ? getMonthLabel() : formatMonthLabel(monthFromSheet);

  const leftToSpend = firstNumeric(['Cash Surplus', 'Savings'], current);
  const totalSpent = firstNumeric(['Consumption Expense', 'Expenses'], current);
  const creditCardDue = safeGet('CC Due (Net Outstanding)', current) || 0;
  const income = safeGet('Income', current) || 0;

  const percentSpent = (income > 0 && totalSpent > 0)
    ? Math.round((totalSpent / income) * 100)
    : 0;

  let improved = false;
  if (previous) {
    const prevSpent = firstNumeric(['Consumption Expense', 'Expenses'], previous);
    if (totalSpent != null && prevSpent != null && prevSpent > 0) {
      improved = totalSpent < prevSpent;
    }
  }

  const selectedMonth = parseSummaryMonth(monthFromSheet);
  const today = new Date();
  const isCurrentMonth = selectedMonth &&
    selectedMonth.getFullYear() === today.getFullYear() &&
    selectedMonth.getMonth() === today.getMonth();
  const lastDayOfMonth = isCurrentMonth
    ? new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    : 0;
  const daysLeft = isCurrentMonth ? Math.max(0, lastDayOfMonth - today.getDate()) : 0;
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

function parseSummaryMonth(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), 1);
  }

  const text = (value || '').toString().trim();
  const iso = /^(\d{4})-(\d{2})$/.exec(text);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, 1);

  const short = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}|\d{4})$/i.exec(text);
  if (!short) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const rawYear = Number(short[2]);
  const year = short[2].length === 2 ? 2000 + rawYear : rawYear;
  return new Date(year, months.indexOf(short[1].toLowerCase()), 1);
}

function formatMonthLabel(value) {
  const month = parseSummaryMonth(value);
  if (!month) return (value || '').toString();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[month.getMonth()]}-${String(month.getFullYear()).slice(-2)}`;
}

// =============================
// 5. MERCHANT & CATEGORY HELPERS
// =============================

function getMerchantName(rawMerchant) {
  if (!rawMerchant || typeof rawMerchant !== 'string') return 'Unknown Merchant';
  const upper = rawMerchant.toUpperCase().trim();

  const merchantMap = {
    'AVENUE SUPE': 'DMart Shopping',
    'DMART': 'DMart Shopping',
    'METRO CASH': 'METRO Shopping mall',
    'RELIANCE FRESH': 'Reliance Fresh',
    'RELIANCE SMART': 'Reliance Smart',
    'MORE MEGASTORE': 'More Megastore',
    'BIGBASKET': 'BigBasket',
    'BLINKIT': 'Blinkit',
    'INSTAMART': 'Swiggy Instamart',
    'ZEPTO': 'Zepto',
    'SWIGGY': 'Swiggy',
    'ZOMATO': 'Zomato',
    'DUNZO': 'Dunzo',
    'STARBUCKS': 'Starbucks',
    'CCD': 'Cafe Coffee Day',
    'MCDONALDS': "McDonald's",
    'KFC': 'KFC',
    'DOMINOS': "Domino's",
    'PIZZA HUT': 'Pizza Hut',
    'SUBWAY': 'Subway',
    'AMAZON': 'Amazon Shopping',
    'FLIPKART': 'Flipkart',
    'MYNTRA': 'Myntra',
    'AJIO': 'Ajio',
    'MEESHO': 'Meesho',
    'UBER': 'Uber',
    'OLA': 'Ola',
    'RAPIDO': 'Rapido',
    'IRCTC': 'IRCTC',
    'INDIGO': 'IndiGo',
    'SPICEJET': 'SpiceJet',
    'AIRTEL': 'Airtel',
    'JIO': 'Jio',
    'VI': 'Vijetha Supermarkets',
    'BSNL': 'BSNL',
    'NETFLIX': 'Netflix',
    'AMAZON PRIME': 'Amazon Prime',
    'HOTSTAR': 'Disney+ Hotstar',
    'SPOTIFY': 'Spotify',
    'YOUTUBE': 'YouTube Premium',
    'BOOKMYSHOW': 'BookMyShow',
    'PVR': 'PVR Cinemas',
    'INOX': 'INOX',
    'APOLLO': 'Apollo Pharmacy',
    'PRACTO': 'Practo',
    'ZERODHA': 'Zerodha',
    'GROWW': 'Groww',
    'UPSTOX': 'Upstox',
    'SI FUND TRANSFER': 'SIP Investment',
    'NEFT': 'Bank Transfer',
    'IMPS': 'Instant Transfer',
    'UPI': 'UPI Payment',
    'SARADA.': 'Mom',
    'SUSIL': 'Baba',
    'SUCHITRA': 'Babu♥',
    'ASISHKUM': 'SELF',
    'SARALA': 'Rgda Mom',
    'SURESH LOHITH': 'H610 Rent',
    'MEDPLUS': 'Medplus Health Services',
    'PENUMATSA S': 'Bhavyas Tiffin Center',
    'VIJAY': 'H610 Garbage Collection',
    'HCL': 'HCLTech'
  };

  if (merchantMap[upper]) return merchantMap[upper];

  for (const [key, value] of Object.entries(merchantMap)) {
    if (upper.includes(key)) return value;
  }

  return rawMerchant
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function suggestCategory(merchant) {
  if (!merchant || typeof merchant !== 'string') return 'Miscellaneous';
  const lower = merchant.toLowerCase();

  const categories = {
    'Shopping': /(avenue supe|dmart|reliance fresh|reliance smart|more|bigbasket|blinkit|instamart|zepto|grocer|amazon|flipkart|myntra|shop|mall|store|lifestyle|ajio|meesho)/i,
    'Food & dining': /(swiggy|zomato|dunzo|restaurant|cafe|food|pizza|burger|starbucks|ccd|mcdonald|kfc|domino|subway|pizza hut)/i,
    'Transportation': /(uber|ola|rapido|petrol|fuel|metro|irctc|flight|indigo|spicejet|cab|taxi)/i,
    'Bills & subscription': /(netflix|prime|spotify|hotstar|youtube|electricity|water|gas|internet|airtel|jio|vi\b|bsnl|broadband|recharge)/i,
    'Healthcare': /(pharma|apollo|medplus|hospital|doctor|medicine|clinic|health|practo)/i,
    'Investment & savings': /(mutual fund|sip|stock|zerodha|groww|upstox|invest|si fund)/i,
    'Housing & utilities': /(rent|sarada kumari|house|apartment)/i,
    'Cash': /(cash|atm|withdrawal)/i,
    'Credit card payments': /(credit card bill|card bill payment|card bill|card payment|cc payment)/i,
    'Income': /(salary|income|hcl|payment received|credited)/i
  };

  for (const [category, pattern] of Object.entries(categories)) {
    if (pattern.test(lower)) return category;
  }

  return 'Miscellaneous';
}

function isCreditCardPayment(originalText, accountType, bank, merchant) {
  const text = (originalText || '').toLowerCase();
  const acct = (accountType || '').toLowerCase();
  const merch = (merchant || '').toLowerCase();
  const b = (bank || '').toLowerCase();

  const directPatterns = /(credit card bill|card bill payment|card bill|card payment|cc payment|payment towards your .*credit card|thanks for paying your credit card bill)/i;
  if (directPatterns.test(text)) return true;

  const issuerPatterns = /(sbi cards?|axis ?bank ?card|hdfc(card)?|icici ?card|kotak ?card|credit ?card)/i;
  if (issuerPatterns.test(text) && /(upi|imps|neft|internet banking|saving|savings)/i.test(text + ' ' + acct)) {
    return true;
  }

  if (/(sbi cards?|axis ?bank|hdfc|icici|kotak)/i.test(merch) && /(card)/i.test(text + ' ' + merch)) {
    return true;
  }

  if (issuerPatterns.test(text) && /(paid|payment|bill)/i.test(text)) {
    return true;
  }

  return false;
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

function isSemanticType(value) {
  return SEMANTIC_TYPES.includes((value || '').toString().trim().toLowerCase());
}

function getTypeLabel(type) {
  const labels = {
    income: 'Income',
    expense: 'Expense',
    transfer: 'Transfer',
    card_payment: 'Card payment',
    investment: 'Investment',
    refund: 'Refund'
  };
  return labels[(type || '').toString().toLowerCase()] || 'Unclassified';
}

function normalizeUnknownValue(value) {
  const text = (value || '').toString().trim();
  return /^(na|n\/a|unknown|null|-)?$/i.test(text) ? '' : text;
}

function getBoundedLimit(value, defaultValue) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1) return defaultValue;
  return Math.min(parsed, 100);
}

/**
 * Parse the one date format accepted from the parser and manual capture.
 * Constructing the date numerically avoids host-dependent string parsing.
 */
function parseCanonicalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec((value || '').toString().trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const date = new Date(year, month - 1, day, hour, minute, second);

  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
    date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second
  ) return null;

  return date;
}

function toDateKey(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  }

  const parsed = parseCanonicalDateTime(value);
  if (!parsed) return '';
  return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
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
  const canonical = parseCanonicalDateTime(value);
  if (canonical) return canonical;
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
  const cleaned = value
    .toString()
    .replace(/[^0-9.\-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? NaN : num;
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

  const seqStr = String(current).padStart(3, '0');
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

  if (t.includes('income')) return 'income';
  if (t.includes('expense') || t.includes('expenses') || t.includes('spend') || t.includes('debit')) {
    return 'expense';
  }

  if (t === 'income' || t === 'expense') return t;

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
  const sheet = financeSheet.getSheetByName(SUGGESTION_RULES_SHEET_NAME);
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const rules = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const enabled = row[0].toString().trim().toUpperCase() === 'Y';
    if (!enabled) continue;

    const matchType = row[1].toString().trim().toUpperCase(); // AMOUNT / MERCHANT / AMOUNTMERCHANT
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
  const bankLower = (parsed.bank || '').toLowerCase();
  const acctLower = (parsed.accountType || '').toLowerCase();
  const merchLower = (parsed.merchantName || '').toLowerCase();
  const textLower = (parsed.originalText || '').toLowerCase();

  const configs = getConfigRecords();

  for (const cfg of configs) {
    if (cfg.bank && !bankLower.includes(cfg.bank)) continue;
    if (cfg.accountTypePattern && !acctLower.includes(cfg.accountTypePattern)) continue;
    if (cfg.merchantPattern && !merchLower.includes(cfg.merchantPattern)) continue;
    if (cfg.textPattern && !textLower.includes(cfg.textPattern)) continue;

    if (cfg.account) parsed.account = cfg.account;
    if (cfg.cardName) parsed.cardName = cfg.cardName;
    if (cfg.instrument && !parsed.instrument) parsed.instrument = cfg.instrument;
    parsed.isInternalAccount = cfg.isInternalAccount;

    return parsed;
  }

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
    const mt = rule.matchType.toUpperCase();

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
