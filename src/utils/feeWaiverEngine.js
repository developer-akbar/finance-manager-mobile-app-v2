/**
 * feeWaiverEngine.js — Pure Credit Card Annual Fee Waiver Calculation Engine
 *
 * Implements authoritative qualification period generation, strict transaction classification,
 * net eligible spending aggregation (purchases - refunds), and fee waiver status tracking.
 *
 * Designed as a pure, deterministic module with zero React dependencies or storage side-effects.
 */

import { parseDate } from './format.js';

// ── CONSTANTS & ENUMS ─────────────────────────────────────────────────────────

export const FEE_STRUCTURE = Object.freeze({
  LIFETIME_FREE: 'LIFETIME_FREE',
  FIXED_FEE: 'FIXED_FEE',
  THRESHOLD_WAIVER: 'THRESHOLD_WAIVER',
});

export const PERIOD_TYPE = Object.freeze({
  ANNIVERSARY: 'ANNIVERSARY',
  CALENDAR_YEAR: 'CALENDAR_YEAR',
  FINANCIAL_YEAR: 'FINANCIAL_YEAR',
  CUSTOM: 'CUSTOM',
});

export const WAIVER_STATUS = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  LIFETIME_FREE: 'LIFETIME_FREE',
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  TARGET_REACHED: 'TARGET_REACHED',
  TARGET_MISSED: 'TARGET_MISSED',
  PENDING_BANK_CONFIRMATION: 'PENDING_BANK_CONFIRMATION',
  BANK_CONFIRMED_WAIVED: 'BANK_CONFIRMED_WAIVED',
  BANK_CONFIRMED_CHARGED: 'BANK_CONFIRMED_CHARGED',
});

export const CLASSIFICATION_TYPE = Object.freeze({
  ELIGIBLE_PURCHASE: 'ELIGIBLE_PURCHASE',
  ELIGIBLE_TRANSFER: 'ELIGIBLE_TRANSFER',
  ELIGIBLE_REFUND: 'ELIGIBLE_REFUND',
  EXCLUDED_BILL_PAYMENT: 'EXCLUDED_BILL_PAYMENT',
  EXCLUDED_TRANSFER: 'EXCLUDED_TRANSFER',
  EXCLUDED_AMBIGUOUS_TRANSFER: 'EXCLUDED_AMBIGUOUS_TRANSFER',
  EXCLUDED_INTEREST: 'EXCLUDED_INTEREST',
  EXCLUDED_LATE_FEE: 'EXCLUDED_LATE_FEE',
  EXCLUDED_ANNUAL_FEE: 'EXCLUDED_ANNUAL_FEE',
  EXCLUDED_CASH_WITHDRAWAL: 'EXCLUDED_CASH_WITHDRAWAL',
  EXCLUDED_REVERSAL: 'EXCLUDED_REVERSAL',
  EXCLUDED_REWARDS_CASHBACK: 'EXCLUDED_REWARDS_CASHBACK',
  EXCLUDED_AMBIGUOUS_INCOME: 'EXCLUDED_AMBIGUOUS_INCOME',
  EXCLUDED_NON_CARD: 'EXCLUDED_NON_CARD',
  UNKNOWN: 'UNKNOWN',
});

// ── HELPER UTILITIES ─────────────────────────────────────────────────────────

/**
 * Normalizes an account reference to compare against card identity.
 * Primary match uses persistent account ID. Account name is supported as legacy compatibility fallback.
 */
export function isTransactionForCard(txn, card) {
  if (!txn || !card) return false;
  const cardId = String(card.id || '').trim().toLowerCase();
  const cardName = String(card.name || '').trim().toLowerCase();

  // Inspect persistent account ID fields if available
  const txnAcctId = String(txn.account_id || txn.AccountId || '').trim().toLowerCase();
  const txnFromAcctId = String(txn.from_account_id || txn.FromAccountId || '').trim().toLowerCase();
  const txnToAcctId = String(txn.to_account_id || txn.ToAccountId || '').trim().toLowerCase();

  if (cardId) {
    if (txnAcctId === cardId || txnFromAcctId === cardId || txnToAcctId === cardId) {
      return true;
    }
  }

  // Name references (FinMan schema primarily stores account names in Account, FromAccount, ToAccount)
  const acct = String(txn.Account || txn.account || '').trim().toLowerCase();
  const fromAcct = String(txn.FromAccount || txn.from_account || '').trim().toLowerCase();
  const toAcct = String(txn.ToAccount || txn.to_account || '').trim().toLowerCase();

  if (cardId && (acct === cardId || fromAcct === cardId || toAcct === cardId)) {
    return true;
  }

  // Compatibility fallback: match exact card display name
  if (cardName && (acct === cardName || fromAcct === cardName || toAcct === cardName)) {
    return true;
  }

  return false;
}

/**
 * Extracts numeric transaction value reliably from FinMan transaction schema.
 */
function getTxnAmount(t) {
  if (!t) return 0;
  if (t.INR !== undefined && !isNaN(parseFloat(t.INR))) return parseFloat(t.INR);
  if (t.inr !== undefined && !isNaN(parseFloat(t.inr))) return parseFloat(t.inr);
  if (t.Amount !== undefined && !isNaN(parseFloat(t.Amount))) return parseFloat(t.Amount);
  if (t.amount !== undefined && !isNaN(parseFloat(t.amount))) return parseFloat(t.amount);
  return 0;
}

/**
 * Combines transaction date and optional time into a Date instance.
 */
export function getTxnDateTime(txn) {
  if (!txn || !txn.Date) return new Date(0);
  const base = parseDate(txn.Date);
  if (!base || isNaN(base.getTime()) || base.getTime() === 0) return new Date(0);

  const timeStr = String(txn.Time || txn.time || '').trim();
  if (timeStr) {
    const parts = timeStr.split(':');
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const s = parseInt(parts[2], 10) || 0;
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, s);
  }
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0);
}

// ── TRANSACTION CLASSIFICATION ───────────────────────────────────────────────

/**
 * Classifies a transaction against a specific credit card.
 *
 * Strict, non-speculative classification rules:
 * - Excludes non-card transactions immediately (`EXCLUDED_NON_CARD`).
 * - Excludes bill payments, transfers, interest, fees, cash advances, reversals.
 * - Categorizes positive purchases as `ELIGIBLE_PURCHASE`.
 * - Categorizes identifiable refunds as `ELIGIBLE_REFUND`.
 * - Excludes ambiguous income (`EXCLUDED_AMBIGUOUS_INCOME`).
 * - Excludes cashback/rewards (`EXCLUDED_REWARDS_CASHBACK`).
 * - Marks unrecognized transaction shapes as `UNKNOWN`.
 *
 * @param {Object} txn - Transaction object.
 * @param {Object} card - Account/card object with `id` and `name`.
 * @returns {Object} { classification, amount, isEligible, reason }
 */
export function classifyCreditCardTransaction(txn, card) {
  if (!txn || typeof txn !== 'object') {
    return { classification: CLASSIFICATION_TYPE.UNKNOWN, amount: 0, isEligible: false, reason: 'Invalid transaction record' };
  }

  // 1. Verify card association
  if (!isTransactionForCard(txn, card)) {
    return { classification: CLASSIFICATION_TYPE.EXCLUDED_NON_CARD, amount: 0, isEligible: false, reason: 'Transaction does not belong to this credit card' };
  }

  const rawType = String(txn['Income/Expense'] || txn.type || '').trim();
  const amt = getTxnAmount(txn);
  const absAmt = Math.abs(amt);

  const category = String(txn.Category || txn.category || '').trim();
  const subcategory = String(txn.Subcategory || txn.subcategory || '').trim();
  const note = String(txn.Note || txn.note || '').trim();
  const desc = String(txn.Description || txn.description || '').trim();
  const tags = String(txn.Tags || txn.tags || '').trim().toUpperCase();

  const textContext = `${category} ${subcategory} ${note} ${desc}`.toLowerCase();

  // 2. Check for Reversal / Cancellation
  // Priority:
  // 1. Explicit transaction status field (e.g. status: 'cancelled' or status: 'reversed')
  // 2. Explicit reversal/cancellation flags or references (e.g. is_reversal, is_cancelled, reversal_of, reversed_by)
  // 3. Dedicated category/subcategory or tags designated for reversals
  // Do NOT treat arbitrary words inside note, description, or merchant text as proof of cancellation.
  const txnStatus = String(txn.status || txn.Status || '').trim().toLowerCase();
  const isExplicitCancelledStatus =
    txnStatus === 'cancelled' ||
    txnStatus === 'reversed' ||
    txnStatus === 'void' ||
    txnStatus === 'voided';

  const hasReversalFlags = !!(
    txn.is_reversal ||
    txn.is_cancelled ||
    txn.reversal_of ||
    txn.reversed_by
  );

  const isDedicatedReversalCategory =
    category.toLowerCase() === 'reversal' ||
    category.toLowerCase() === 'reversals' ||
    category.toLowerCase() === 'cancellation' ||
    category.toLowerCase() === 'cancelled' ||
    subcategory.toLowerCase() === 'reversal' ||
    subcategory.toLowerCase() === 'cancellation' ||
    tags.includes('REVERSAL') ||
    tags.includes('CANCELLED');

  if (isExplicitCancelledStatus || hasReversalFlags || isDedicatedReversalCategory) {
    return {
      classification: CLASSIFICATION_TYPE.EXCLUDED_REVERSAL,
      amount: absAmt,
      isEligible: false,
      reason: 'Transaction explicitly marked as reversed or cancelled',
    };
  }

  // 3. Check for Bill Payments and Transfers
  const isTransferType = rawType === 'Transfer' || rawType === 'Transfer-Out' || rawType === 'Transfer-In';
  const fromAcct = String(txn.FromAccount || txn.from_account || txn.Account || txn.account || '').trim().toLowerCase();
  const toAcct = String(txn.ToAccount || txn.to_account || '').trim().toLowerCase();
  const cardName = String(card.name || '').trim().toLowerCase();
  const cardId = String(card.id || '').trim().toLowerCase();
  const txnFromAcctId = String(txn.from_account_id || txn.FromAccountId || '').trim().toLowerCase();
  const txnToAcctId = String(txn.to_account_id || txn.ToAccountId || '').trim().toLowerCase();

  const isFundedByCard = (cardId && (fromAcct === cardId || txnFromAcctId === cardId)) || (cardName && fromAcct === cardName);
  const isReceivingCard = (cardId && (toAcct === cardId || txnToAcctId === cardId)) || (cardName && toAcct === cardName);

  const isPaymentToCard = isReceivingCard;
  const isPaymentContent = /\b(bill\s+payment|card\s+payment|cc\s+payment|payment\s+received|repayment)\b/i.test(textContext) ||
    (category.toLowerCase() === 'finance' && subcategory.toLowerCase() === 'credit card payment');

  if (isTransferType) {
    // 3a. Bill payment or money received by card
    if (isPaymentToCard || isPaymentContent) {
      return {
        classification: CLASSIFICATION_TYPE.EXCLUDED_BILL_PAYMENT,
        amount: absAmt,
        isEligible: false,
        reason: 'Credit card bill payment transfer',
      };
    }

    // 3b. Card is NOT the funding source
    if (!isFundedByCard) {
      return {
        classification: CLASSIFICATION_TYPE.EXCLUDED_TRANSFER,
        amount: absAmt,
        isEligible: false,
        reason: 'Transfer where credit card is not the funding source',
      };
    }

    // 3c. Card IS the funding source -> every valid transfer funded by the selected credit card counts as eligible!
    return {
      classification: CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER,
      amount: absAmt,
      isEligible: true,
      reason: 'Valid card-funded transfer',
    };
  }

  if (isPaymentContent) {
    return { classification: CLASSIFICATION_TYPE.EXCLUDED_BILL_PAYMENT, amount: absAmt, isEligible: false, reason: 'Credit card bill payment' };
  }

  // 4. Check for Fees, Charges, Interest, Cash Withdrawals
  if (
    subcategory.toLowerCase() === 'interest' ||
    /\b(interest(\s+charge)?|finance\s+charge)\b/i.test(textContext)
  ) {
    return { classification: CLASSIFICATION_TYPE.EXCLUDED_INTEREST, amount: absAmt, isEligible: false, reason: 'Credit card interest charge' };
  }

  if (
    subcategory.toLowerCase() === 'late payment fee' ||
    /\blate(\s+payment)?\s+fee\b/i.test(textContext)
  ) {
    return { classification: CLASSIFICATION_TYPE.EXCLUDED_LATE_FEE, amount: absAmt, isEligible: false, reason: 'Late payment fee' };
  }

  if (
    /\b(annual\s+fee|membership\s+fee|renewal\s+fee|joining\s+fee)\b/i.test(textContext)
  ) {
    return { classification: CLASSIFICATION_TYPE.EXCLUDED_ANNUAL_FEE, amount: absAmt, isEligible: false, reason: 'Annual / membership fee' };
  }

  if (
    subcategory.toLowerCase() === 'cash withdrawal' ||
    /\b(cash\s+advance|atm\s+withdrawal|cash\s+withdrawal)\b/i.test(textContext)
  ) {
    return { classification: CLASSIFICATION_TYPE.EXCLUDED_CASH_WITHDRAWAL, amount: absAmt, isEligible: false, reason: 'ATM or cash advance withdrawal' };
  }

  // 5. Check for Cashback / Rewards (Explicitly NOT treated as refunds)
  if (
    subcategory.toLowerCase() === 'cashback / rewards' ||
    /\b(cashback|reward(s)?|points\s+redeem|cash\s+reward|milestone\s+bonus)\b/i.test(textContext)
  ) {
    return { classification: CLASSIFICATION_TYPE.EXCLUDED_REWARDS_CASHBACK, amount: absAmt, isEligible: false, reason: 'Cashback or reward points credit' };
  }

  // 6. Handle Refund detection
  const hasExplicitRefundMarker =
    subcategory.toLowerCase() === 'refunds' ||
    category.toLowerCase() === 'refunds' ||
    tags.includes('REFUND') ||
    tags.includes('REFUNDED') ||
    /\b(refund|refunded|merchant\s+refund|return\s+credit)\b/i.test(textContext);

  // Case A: Explicit Income transaction
  if (rawType === 'Income') {
    if (hasExplicitRefundMarker) {
      return { classification: CLASSIFICATION_TYPE.ELIGIBLE_REFUND, amount: absAmt, isEligible: true, reason: 'Identifiable merchant refund' };
    }
    // Ambiguous Income against credit card without explicit refund markers
    return { classification: CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_INCOME, amount: absAmt, isEligible: false, reason: 'Unclassified credit/income without refund markers' };
  }

  // Case B: Expense transaction
  if (rawType === 'Expense') {
    // Negative expense (e.g. -₹500 return credit)
    if (amt < 0) {
      return { classification: CLASSIFICATION_TYPE.ELIGIBLE_REFUND, amount: absAmt, isEligible: true, reason: 'Negative expense return/refund' };
    }
    // Positive purchase expense
    if (amt > 0) {
      return { classification: CLASSIFICATION_TYPE.ELIGIBLE_PURCHASE, amount: absAmt, isEligible: true, reason: 'Eligible retail purchase' };
    }
    // Zero amount
    return { classification: CLASSIFICATION_TYPE.UNKNOWN, amount: 0, isEligible: false, reason: 'Zero amount expense' };
  }

  // 7. Fallback for unrecognized transaction types
  return { classification: CLASSIFICATION_TYPE.UNKNOWN, amount: absAmt, isEligible: false, reason: `Unrecognized transaction type: ${rawType}` };
}

// ── QUALIFICATION PERIOD CALCULATORS ─────────────────────────────────────────

/**
 * Adjusts a leap-year date (Feb 29) to Feb 28 in non-leap years.
 */
function getAnniversaryDateForYear(origMonth, origDate, targetYear) {
  if (origMonth === 1 && origDate === 29) {
    const isLeap = (targetYear % 4 === 0 && targetYear % 100 !== 0) || (targetYear % 400 === 0);
    return new Date(targetYear, 1, isLeap ? 29 : 28);
  }
  return new Date(targetYear, origMonth, origDate);
}

/**
 * Calculates Card Anniversary Year qualification boundaries.
 *
 * Rules:
 * - Cycle 1 (Year 1): Starts on issuanceDate (00:00:00). Ends on day before 1st anniversary (23:59:59.999).
 * - Subsequent cycles: Start on Nth anniversary. End on day before (N+1)th anniversary.
 * - Both start and end dates are inclusive.
 * - Handles leap year issuance dates (Feb 29) gracefully.
 * - Does not silently guess missing issuance dates.
 *
 * @param {Object} options - { issuanceDate, referenceDate }
 * @returns {Object} { startDate, endDate, cycleIndex, isFirstYear, label, error }
 */
export function getAnniversaryPeriod({ issuanceDate, referenceDate = new Date() }) {
  if (!issuanceDate) {
    return { error: 'MISSING_ISSUANCE_DATE', message: 'Card issuance date is required for anniversary qualification periods' };
  }

  const parsedIssuance = parseDate(issuanceDate);
  if (!parsedIssuance || isNaN(parsedIssuance.getTime()) || parsedIssuance.getTime() === 0) {
    return { error: 'INVALID_ISSUANCE_DATE', message: `Invalid issuance date: ${issuanceDate}` };
  }

  const issueYear = parsedIssuance.getFullYear();
  const issueMonth = parsedIssuance.getMonth();
  const issueDay = parsedIssuance.getDate();

  const refDate = referenceDate instanceof Date ? referenceDate : parseDate(referenceDate);
  const refYear = refDate.getFullYear();

  // Find the anniversary year cycle index relative to referenceDate
  let cycleYear = refYear;
  let testAnniv = getAnniversaryDateForYear(issueMonth, issueDay, cycleYear);

  if (refDate < testAnniv) {
    cycleYear = refYear - 1;
  }

  // Safety floor at issuance year
  if (cycleYear < issueYear) {
    cycleYear = issueYear;
  }

  const cycleIndex = cycleYear - issueYear + 1;
  const isFirstYear = cycleIndex === 1;

  // Cycle start: cycleYear anniversary
  const startDate = getAnniversaryDateForYear(issueMonth, issueDay, cycleYear);
  startDate.setHours(0, 0, 0, 0);

  // Cycle end: day before next anniversary
  const nextAnniv = getAnniversaryDateForYear(issueMonth, issueDay, cycleYear + 1);
  const endDate = new Date(nextAnniv.getTime() - 1); // 23:59:59.999 of preceding day

  const fmt = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const label = isFirstYear
    ? `Year 1 Anniversary (${fmt(startDate)} – ${fmt(endDate)})`
    : `Year ${cycleIndex} Anniversary (${fmt(startDate)} – ${fmt(endDate)})`;

  return {
    startDate,
    endDate,
    cycleIndex,
    isFirstYear,
    label,
    error: null,
  };
}

/**
 * Calculates Calendar Year qualification boundaries (1 Jan – 31 Dec).
 */
export function getCalendarYearPeriod({ referenceDate = new Date() }) {
  const refDate = referenceDate instanceof Date ? referenceDate : parseDate(referenceDate);
  const y = refDate.getFullYear();

  const startDate = new Date(y, 0, 1, 0, 0, 0, 0);
  const endDate = new Date(y, 11, 31, 23, 59, 59, 999);

  return {
    startDate,
    endDate,
    cycleIndex: 1,
    isFirstYear: false,
    label: `Calendar Year ${y}`,
    error: null,
  };
}

/**
 * Calculates Indian Financial Year qualification boundaries (1 April – 31 March).
 */
export function getFinancialYearPeriod({ referenceDate = new Date() }) {
  const refDate = referenceDate instanceof Date ? referenceDate : parseDate(referenceDate);
  const y = refDate.getFullYear();
  const m = refDate.getMonth();

  const startYear = m >= 3 ? y : y - 1; // Months 0,1,2 (Jan, Feb, Mar) belong to preceding FY
  const endYear = startYear + 1;

  const startDate = new Date(startYear, 3, 1, 0, 0, 0, 0);
  const endDate = new Date(endYear, 2, 31, 23, 59, 59, 999);

  const shortEnd = String(endYear).slice(-2);
  return {
    startDate,
    endDate,
    cycleIndex: 1,
    isFirstYear: false,
    label: `FY ${startYear}–${shortEnd}`,
    error: null,
  };
}

/**
 * Calculates Custom Date Range qualification boundaries.
 */
export function getCustomPeriod({ customStartDate, customEndDate }) {
  if (!customStartDate || !customEndDate) {
    return { error: 'INVALID_CUSTOM_DATES', message: 'Both start and end dates are required for custom qualification period' };
  }

  const s = parseDate(customStartDate);
  const e = parseDate(customEndDate);

  if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime()) || s.getTime() === 0 || e.getTime() === 0) {
    return { error: 'INVALID_CUSTOM_DATES', message: 'Invalid custom dates provided' };
  }

  if (s > e) {
    return { error: 'INVALID_CUSTOM_DATES', message: 'Custom start date cannot be after end date' };
  }

  const startDate = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0, 0);
  const endDate = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59, 999);

  const fmt = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return {
    startDate,
    endDate,
    cycleIndex: 1,
    isFirstYear: false,
    label: `Custom Period (${fmt(startDate)} – ${fmt(endDate)})`,
    error: null,
  };
}

/**
 * Resolves the active qualification period boundaries based on configuration.
 *
 * @param {Object} options - { config, referenceDate }
 * @returns {Object} Qualification period object with boundaries and metadata.
 */
export function resolveQualificationPeriod({ config, referenceDate = new Date() }) {
  if (!config || typeof config !== 'object') {
    return { error: 'NOT_CONFIGURED', message: 'No waiver configuration provided' };
  }

  const periodType = config.periodType || PERIOD_TYPE.ANNIVERSARY;

  switch (periodType) {
    case PERIOD_TYPE.ANNIVERSARY:
      return getAnniversaryPeriod({
        issuanceDate: config.issuanceDate,
        referenceDate,
      });

    case PERIOD_TYPE.CALENDAR_YEAR:
      return getCalendarYearPeriod({ referenceDate });

    case PERIOD_TYPE.FINANCIAL_YEAR:
      return getFinancialYearPeriod({ referenceDate });

    case PERIOD_TYPE.CUSTOM:
      return getCustomPeriod({
        customStartDate: config.customStartDate,
        customEndDate: config.customEndDate,
      });

    default:
      return { error: 'INVALID_PERIOD_TYPE', message: `Unknown period type: ${periodType}` };
  }
}

// ── SPENDING AGGREGATION & PROGRESS CALCULATION ─────────────────────────────

/**
 * Calculates credit card annual fee waiver progress and qualification status.
 *
 * Deterministic and pure: identical inputs always yield identical outputs.
 *
 * @param {Object} params
 * @param {Object} params.card - Credit card account entity with `id` and `name`.
 * @param {Object} params.config - Fee waiver configuration.
 * @param {Object} params.period - Qualification period with `startDate`, `endDate`, `isFirstYear`.
 * @param {Array}  params.transactions - List of all candidate transactions.
 * @param {Date}   [params.referenceDate=new Date()] - As-of evaluation timestamp.
 * @param {string} [params.bankOutcome=null] - Optional user-recorded bank outcome ("WAIVED" | "CHARGED" | "PENDING").
 * @returns {Object} Comprehensive progress result.
 */
export function isHardExclusion(classification) {
  return (
    classification === CLASSIFICATION_TYPE.EXCLUDED_BILL_PAYMENT ||
    classification === CLASSIFICATION_TYPE.EXCLUDED_REVERSAL ||
    classification === CLASSIFICATION_TYPE.EXCLUDED_NON_CARD
  );
}

function getTxnOverride(overrides, cardId, txnId) {
  if (!overrides || !txnId) return null;
  const cleanTxnId = String(txnId).trim();
  const cleanCardId = String(cardId || '').trim();

  const cardMap = (cleanCardId && overrides[cleanCardId]) ? overrides[cleanCardId] : overrides;
  const entry = cardMap ? cardMap[cleanTxnId] : null;
  if (!entry) return null;
  if (typeof entry === 'string') return entry.toUpperCase();
  if (typeof entry === 'object' && entry.override) return String(entry.override).toUpperCase();
  return null;
}

export function calculateFeeWaiverProgress({
  card,
  config,
  period,
  transactions = [],
  referenceDate = new Date(),
  bankOutcome = null,
  overrides = {},
}) {
  // 1. Check Card & Configuration validity
  if (!card || !card.name) {
    return {
      status: WAIVER_STATUS.NOT_CONFIGURED,
      error: 'INVALID_CARD',
      message: 'Card account is required',
    };
  }

  if (!config || !config.feeStructure) {
    return {
      status: WAIVER_STATUS.NOT_CONFIGURED,
      error: 'NOT_CONFIGURED',
      message: 'Card fee waiver is not configured',
    };
  }

  // 2. Check for Lifetime Free (LTF)
  if (config.feeStructure === FEE_STRUCTURE.LIFETIME_FREE) {
    return {
      cardId: card.id || card.name,
      cardName: card.name,
      feeStructure: FEE_STRUCTURE.LIFETIME_FREE,
      annualFee: 0,
      requiredThreshold: 0,
      eligiblePurchaseTotal: 0,
      eligibleTransferTotal: 0,
      eligibleRefundTotal: 0,
      netEligibleSpend: 0,
      amountRemaining: 0,
      percentCompleted: 100,
      daysRemaining: null,
      avgMonthlySpendRequired: 0,
      status: WAIVER_STATUS.LIFETIME_FREE,
      statusLabel: 'Lifetime Free',
      excludedCount: 0,
      ambiguousCount: 0,
      ambiguousTransactions: [],
      unknownCount: 0,
      classifiedTransactions: [],
      period: null,
      error: null,
    };
  }

  // 3. Check for Period Configuration Errors
  if (!period || period.error || !period.startDate || !period.endDate) {
    return {
      cardId: card.id || card.name,
      cardName: card.name,
      feeStructure: config.feeStructure,
      annualFee: config.annualFee || 0,
      status: WAIVER_STATUS.NOT_CONFIGURED,
      error: period?.error || 'INVALID_PERIOD',
      message: period?.message || 'Valid qualification period is required',
    };
  }

  const annualFee = Math.max(0, Number(config.annualFee) || 0);

  // 4. Fixed Annual Fee (No threshold waiver)
  if (config.feeStructure === FEE_STRUCTURE.FIXED_FEE) {
    const ref = referenceDate instanceof Date ? referenceDate : parseDate(referenceDate);
    const daysRemaining = Math.max(0, Math.ceil((period.endDate.getTime() - ref.getTime()) / (1000 * 60 * 60 * 24)));
    const isPastDeadline = ref > period.endDate;

    return {
      cardId: card.id || card.name,
      cardName: card.name,
      feeStructure: FEE_STRUCTURE.FIXED_FEE,
      annualFee,
      requiredThreshold: 0,
      eligiblePurchaseTotal: 0,
      eligibleTransferTotal: 0,
      eligibleRefundTotal: 0,
      netEligibleSpend: 0,
      amountRemaining: 0,
      percentCompleted: 0,
      daysRemaining,
      avgMonthlySpendRequired: 0,
      status: isPastDeadline ? WAIVER_STATUS.TARGET_MISSED : WAIVER_STATUS.IN_PROGRESS,
      statusLabel: isPastDeadline ? 'Fee Renewal Due' : 'Fixed Annual Fee Active',
      excludedCount: 0,
      ambiguousCount: 0,
      ambiguousTransactions: [],
      unknownCount: 0,
      classifiedTransactions: [],
      period,
      error: null,
    };
  }

  // 5. Threshold-Based Waiver
  // Requirement: First year always enforces full configured threshold, not prorated.
  const rawThreshold = Number(config.spendThreshold) || 0;
  const requiredThreshold = Math.max(0, rawThreshold);

  let eligiblePurchaseTotal = 0;
  let eligibleTransferTotal = 0;
  let eligibleRefundTotal = 0;
  let excludedCount = 0;
  let ambiguousCount = 0;
  let unknownCount = 0;

  const excludedBreakdown = {};
  const classifiedTransactions = [];
  const ambiguousTransactions = [];

  const startMs = period.startDate.getTime();
  const endMs = period.endDate.getTime();

  for (const t of transactions) {
    const tDateTime = getTxnDateTime(t);
    const tMs = tDateTime.getTime();

    // Strict boundary inclusion: transactions outside [startDate, endDate] are excluded
    if (tMs < startMs || tMs > endMs) {
      continue;
    }

    const autoClassification = classifyCreditCardTransaction(t, card);

    // If transaction does not belong to this credit card, exclude it from this card's audit breakdown
    if (autoClassification.classification === CLASSIFICATION_TYPE.EXCLUDED_NON_CARD) {
      continue;
    }

    const txnId = String(t._id || t.id || t.ID || '').trim();
    const cardId = card.id || card.name;
    const manualAction = getTxnOverride(overrides, cardId, txnId);

    let classification = { ...autoClassification, isManualOverride: false, manualOverride: null };

    if (manualAction === 'ELIGIBLE') {
      // Hard exclusions (confirmed bill payments, actual cancellations/reversals) cannot be overridden
      if (!isHardExclusion(autoClassification.classification)) {
        classification.isEligible = true;
        classification.isManualOverride = true;
        classification.manualOverride = 'ELIGIBLE';
        classification.reason = 'Manually marked eligible by user';
        if (classification.amount === 0) {
          classification.amount = Math.abs(getTxnAmount(t));
        }
        if (autoClassification.classification !== CLASSIFICATION_TYPE.ELIGIBLE_REFUND) {
          const rawType = String(t['Income/Expense'] || t.type || '').trim();
          const isXfer = rawType === 'Transfer' || rawType === 'Transfer-Out' || rawType === 'Transfer-In';
          classification.classification = isXfer
            ? CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER
            : CLASSIFICATION_TYPE.ELIGIBLE_PURCHASE;
        }
      }
    } else if (manualAction === 'EXCLUDED') {
      classification.isEligible = false;
      classification.isManualOverride = true;
      classification.manualOverride = 'EXCLUDED';
      classification.reason = 'Manually excluded by user';
    }

    classifiedTransactions.push({ txn: t, ...classification });

    if (classification.isEligible) {
      if (classification.classification === CLASSIFICATION_TYPE.ELIGIBLE_REFUND) {
        eligibleRefundTotal += classification.amount;
      } else if (classification.classification === CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER) {
        eligibleTransferTotal += classification.amount;
      } else {
        eligiblePurchaseTotal += classification.amount;
      }
    } else {
      if (
        classification.classification === CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_TRANSFER ||
        classification.classification === CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_INCOME
      ) {
        ambiguousCount++;
        ambiguousTransactions.push({ txn: t, ...classification });
        excludedCount++;
        excludedBreakdown[classification.classification] = (excludedBreakdown[classification.classification] || 0) + 1;
      } else if (classification.classification === CLASSIFICATION_TYPE.UNKNOWN) {
        unknownCount++;
        ambiguousCount++;
        ambiguousTransactions.push({ txn: t, ...classification });
      } else {
        excludedCount++;
        const breakdownKey = classification.manualOverride === 'EXCLUDED' ? 'MANUAL_EXCLUDED' : classification.classification;
        excludedBreakdown[breakdownKey] = (excludedBreakdown[breakdownKey] || 0) + 1;
      }
    }
  }

  // Net eligible spending: Purchases + Eligible Transfers minus Refunds (cannot be negative)
  const netEligibleSpend = Math.max(0, Math.round((eligiblePurchaseTotal + eligibleTransferTotal - eligibleRefundTotal) * 100) / 100);
  const amountRemaining = Math.max(0, Math.round((requiredThreshold - netEligibleSpend) * 100) / 100);

  // Percentage completed: 0-100 (handles zero threshold safely)
  let percentCompleted = 0;
  if (requiredThreshold > 0) {
    percentCompleted = Math.min(100, Math.round((netEligibleSpend / requiredThreshold) * 1000) / 10);
  } else {
    percentCompleted = 100;
  }

  const refDate = referenceDate instanceof Date ? referenceDate : parseDate(referenceDate);
  const refMs = refDate.getTime();
  const daysRemaining = Math.max(0, Math.ceil((endMs - refMs) / (1000 * 60 * 60 * 24)));

  // Average monthly spend required to hit target
  let avgMonthlySpendRequired = 0;
  if (amountRemaining > 0 && daysRemaining > 0) {
    const monthsRemaining = daysRemaining / 30.4375;
    avgMonthlySpendRequired = Math.round(amountRemaining / Math.max(monthsRemaining, 0.1));
  }

  // 6. Status Determination
  let status = WAIVER_STATUS.IN_PROGRESS;
  let statusLabel = 'In Progress';

  if (bankOutcome) {
    const upperOutcome = String(bankOutcome).toUpperCase();
    if (upperOutcome === 'WAIVED') {
      status = WAIVER_STATUS.BANK_CONFIRMED_WAIVED;
      statusLabel = 'Fee Waived by Bank';
    } else if (upperOutcome === 'CHARGED') {
      status = WAIVER_STATUS.BANK_CONFIRMED_CHARGED;
      statusLabel = 'Fee Charged by Bank';
    } else if (upperOutcome === 'PENDING') {
      status = WAIVER_STATUS.PENDING_BANK_CONFIRMATION;
      statusLabel = 'Pending Bank Confirmation';
    }
  } else {
    const isTargetMet = netEligibleSpend >= requiredThreshold && requiredThreshold > 0;
    const isPastDeadline = refMs > endMs;
    const isBeforeStart = refMs < startMs;

    if (isBeforeStart) {
      status = WAIVER_STATUS.NOT_STARTED;
      statusLabel = 'Qualification Not Started';
    } else if (isTargetMet) {
      status = WAIVER_STATUS.TARGET_REACHED;
      statusLabel = 'Spend Target Reached';
    } else if (isPastDeadline) {
      status = WAIVER_STATUS.TARGET_MISSED;
      statusLabel = 'Spend Target Missed';
    } else {
      status = WAIVER_STATUS.IN_PROGRESS;
      statusLabel = 'In Progress';
    }
  }

  return {
    cardId: card.id || card.name,
    cardName: card.name,
    feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER,
    annualFee,
    requiredThreshold,
    eligiblePurchaseTotal: Math.round(eligiblePurchaseTotal * 100) / 100,
    eligibleTransferTotal: Math.round(eligibleTransferTotal * 100) / 100,
    eligibleRefundTotal: Math.round(eligibleRefundTotal * 100) / 100,
    netEligibleSpend,
    amountRemaining,
    percentCompleted,
    daysRemaining,
    avgMonthlySpendRequired,
    status,
    statusLabel,
    isFirstYear: !!period.isFirstYear,
    excludedCount,
    excludedBreakdown,
    ambiguousCount,
    ambiguousTransactions,
    unknownCount,
    classifiedTransactions,
    period,
    error: null,
  };
}

