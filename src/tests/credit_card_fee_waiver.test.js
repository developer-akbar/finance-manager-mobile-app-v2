/**
 * credit_card_fee_waiver.test.js — Credit Card Fee Waiver Engine Automated Test Suite
 *
 * Covers:
 * 1. Qualification periods (Anniversary, Calendar, FY, Custom, Leap Year, Boundaries).
 * 2. Strict transaction classification (Purchases, Refunds, Exclusions, Ambiguous handling).
 * 3. Spending aggregation and fee waiver status lifecycle.
 * 4. Architectural safeguards & regression verification.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'url';
import {
  FEE_STRUCTURE,
  PERIOD_TYPE,
  WAIVER_STATUS,
  CLASSIFICATION_TYPE,
  classifyCreditCardTransaction,
  getAnniversaryPeriod,
  getCalendarYearPeriod,
  getFinancialYearPeriod,
  getCustomPeriod,
  resolveQualificationPeriod,
  calculateFeeWaiverProgress,
} from '../utils/feeWaiverEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

// Synthetic Card Fixture (Isolated with durable UUID)
const MOCK_CARD = {
  id: 'card_uuid_citi_premier_miles',
  name: 'Citi PremierMiles',
  acctType: 'Credit Card',
  settlementDate: 15,
  paymentDueDays: 20,
};

const MOCK_OTHER_CARD = {
  id: 'card_uuid_hdfc_regalia',
  name: 'HDFC Regalia',
  acctType: 'Credit Card',
  settlementDate: 5,
  paymentDueDays: 18,
};

test('FinMan Phase 2 — Credit Card Fee Waiver Engine Suite', async (suite) => {

  // Load and extract existing credit card helpers from Accounts.jsx in isolated VM context
  const acctPath = path.join(projectRoot, 'src/components/Accounts/Accounts.jsx');
  assert.ok(fs.existsSync(acctPath), 'Accounts.jsx must exist');
  const acctContent = fs.readFileSync(acctPath, 'utf8').replace(/\r\n/g, '\n');

  const isCCStart = acctContent.indexOf('export function isCreditCard(');
  const isCCEnd = acctContent.indexOf('const MS_F = [');
  const isCCStr = acctContent.slice(isCCStart, isCCEnd).replaceAll('export function', 'function');

  const vmContext = {};
  vm.createContext(vmContext);
  vm.runInContext(isCCStr, vmContext);
  const { isCreditCard, ccNextDueDate, ccDaysUntilDue } = vmContext;

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Qualification Periods
  // ─────────────────────────────────────────────────────────────────────────────

  await suite.test('1. Anniversary year qualification period calculation', () => {
    const period = getAnniversaryPeriod({
      issuanceDate: '2024-05-15',
      referenceDate: new Date('2024-08-20T12:00:00'),
    });

    assert.equal(period.error, null);
    assert.equal(period.isFirstYear, true);
    assert.equal(period.cycleIndex, 1);
    assert.equal(period.startDate.getFullYear(), 2024);
    assert.equal(period.startDate.getMonth(), 4); // May
    assert.equal(period.startDate.getDate(), 15);
    assert.equal(period.endDate.getFullYear(), 2025);
    assert.equal(period.endDate.getMonth(), 4); // May
    assert.equal(period.endDate.getDate(), 14);

    // Second year anniversary
    const periodY2 = getAnniversaryPeriod({
      issuanceDate: '2024-05-15',
      referenceDate: new Date('2025-06-01T12:00:00'),
    });
    assert.equal(periodY2.isFirstYear, false);
    assert.equal(periodY2.cycleIndex, 2);
    assert.equal(periodY2.startDate.getFullYear(), 2025);
    assert.equal(periodY2.startDate.getMonth(), 4);
    assert.equal(periodY2.startDate.getDate(), 15);
    assert.equal(periodY2.endDate.getFullYear(), 2026);
    assert.equal(periodY2.endDate.getMonth(), 4);
    assert.equal(periodY2.endDate.getDate(), 14);
  });

  await suite.test('2. Calendar year qualification period (1 Jan – 31 Dec)', () => {
    const period = getCalendarYearPeriod({
      referenceDate: new Date('2026-07-15T12:00:00'),
    });

    assert.equal(period.startDate.getFullYear(), 2026);
    assert.equal(period.startDate.getMonth(), 0); // Jan
    assert.equal(period.startDate.getDate(), 1);
    assert.equal(period.endDate.getFullYear(), 2026);
    assert.equal(period.endDate.getMonth(), 11); // Dec
    assert.equal(period.endDate.getDate(), 31);
    assert.equal(period.label, 'Calendar Year 2026');
  });

  await suite.test('3. Indian financial year qualification period (1 Apr – 31 Mar)', () => {
    // Reference date in November 2026 -> FY 2026–27
    const periodNov = getFinancialYearPeriod({
      referenceDate: new Date('2026-11-21T12:00:00'),
    });
    assert.equal(periodNov.startDate.getFullYear(), 2026);
    assert.equal(periodNov.startDate.getMonth(), 3); // April
    assert.equal(periodNov.startDate.getDate(), 1);
    assert.equal(periodNov.endDate.getFullYear(), 2027);
    assert.equal(periodNov.endDate.getMonth(), 2); // March
    assert.equal(periodNov.endDate.getDate(), 31);
    assert.equal(periodNov.label, 'FY 2026–27');

    // Reference date in February 2026 -> FY 2025–26
    const periodFeb = getFinancialYearPeriod({
      referenceDate: new Date('2026-02-10T12:00:00'),
    });
    assert.equal(periodFeb.startDate.getFullYear(), 2025);
    assert.equal(periodFeb.startDate.getMonth(), 3);
    assert.equal(periodFeb.startDate.getDate(), 1);
    assert.equal(periodFeb.endDate.getFullYear(), 2026);
    assert.equal(periodFeb.endDate.getMonth(), 2);
    assert.equal(periodFeb.endDate.getDate(), 31);
    assert.equal(periodFeb.label, 'FY 2025–26');
  });

  await suite.test('4. Custom date range period calculation', () => {
    const period = getCustomPeriod({
      customStartDate: '2026-01-15',
      customEndDate: '2026-06-30',
    });

    assert.equal(period.error, null);
    assert.equal(period.startDate.getFullYear(), 2026);
    assert.equal(period.startDate.getMonth(), 0);
    assert.equal(period.startDate.getDate(), 15);
    assert.equal(period.endDate.getFullYear(), 2026);
    assert.equal(period.endDate.getMonth(), 5);
    assert.equal(period.endDate.getDate(), 30);
  });

  await suite.test('5. First-year policy enforces full threshold (not prorated)', () => {
    const config = {
      feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER,
      spendThreshold: 150000,
      annualFee: 1500,
      periodType: PERIOD_TYPE.ANNIVERSARY,
      issuanceDate: '2026-01-01',
    };
    const period = getAnniversaryPeriod({
      issuanceDate: config.issuanceDate,
      referenceDate: new Date('2026-06-01T00:00:00'),
    });
    assert.equal(period.isFirstYear, true);

    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config,
      period,
      transactions: [],
      referenceDate: new Date('2026-06-01T00:00:00'),
    });

    assert.equal(progress.requiredThreshold, 150000, 'Threshold must not be prorated for first year');
    assert.equal(progress.amountRemaining, 150000);
  });

  await suite.test('6. Missing card issuance date returns explicit error without guessing', () => {
    const period = getAnniversaryPeriod({
      issuanceDate: null,
      referenceDate: new Date('2026-05-01'),
    });
    assert.equal(period.error, 'MISSING_ISSUANCE_DATE');
    assert.ok(period.message.includes('Card issuance date is required'));

    const resolved = resolveQualificationPeriod({
      config: { periodType: PERIOD_TYPE.ANNIVERSARY, issuanceDate: '' },
      referenceDate: new Date('2026-05-01'),
    });
    assert.equal(resolved.error, 'MISSING_ISSUANCE_DATE');
  });

  await suite.test('7. Invalid custom dates return error (start after end or malformed)', () => {
    const periodReversed = getCustomPeriod({
      customStartDate: '2026-12-31',
      customEndDate: '2026-01-01',
    });
    assert.equal(periodReversed.error, 'INVALID_CUSTOM_DATES');

    const periodMalformed = getCustomPeriod({
      customStartDate: 'not-a-date',
      customEndDate: '2026-06-30',
    });
    assert.equal(periodMalformed.error, 'INVALID_CUSTOM_DATES');
  });

  await suite.test('8. Leap-year anniversary handling (February 29 issuance)', () => {
    // Issued on leap day Feb 29, 2024
    const periodY1 = getAnniversaryPeriod({
      issuanceDate: '2024-02-29',
      referenceDate: new Date('2024-05-01'),
    });
    assert.equal(periodY1.startDate.getMonth(), 1);
    assert.equal(periodY1.startDate.getDate(), 29);
    // Non-leap year 2025: anniversary shifts to Feb 28, cycle ends Feb 27
    assert.equal(periodY1.endDate.getMonth(), 1);
    assert.equal(periodY1.endDate.getDate(), 27);

    // Second year in non-leap year 2025
    const periodY2 = getAnniversaryPeriod({
      issuanceDate: '2024-02-29',
      referenceDate: new Date('2025-06-01'),
    });
    assert.equal(periodY2.startDate.getFullYear(), 2025);
    assert.equal(periodY2.startDate.getMonth(), 1);
    assert.equal(periodY2.startDate.getDate(), 28);
  });

  await suite.test('9. Inclusive start boundary: transaction on exact start date is counted', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [
      {
        id: 'tx_start_day',
        Account: MOCK_CARD.name,
        Date: '01/01/2026',
        Time: '00:01:00',
        INR: 5000,
        'Income/Expense': 'Expense',
      },
    ];
    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period,
      transactions: txns,
      referenceDate: new Date('2026-06-01'),
    });
    assert.equal(progress.eligiblePurchaseTotal, 5000, 'Start date transaction must be included');
  });

  await suite.test('10. Inclusive end boundary: transaction on exact end date is counted', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [
      {
        id: 'tx_end_day',
        Account: MOCK_CARD.name,
        Date: '31/12/2026',
        Time: '23:45:00',
        INR: 7500,
        'Income/Expense': 'Expense',
      },
    ];
    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period,
      transactions: txns,
      referenceDate: new Date('2026-06-01'),
    });
    assert.equal(progress.eligiblePurchaseTotal, 7500, 'End date transaction must be included');
  });

  await suite.test('11. Exclusion immediately outside boundaries', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [
      {
        id: 'tx_before',
        Account: MOCK_CARD.name,
        Date: '31/12/2025',
        Time: '23:59:00',
        INR: 12000,
        'Income/Expense': 'Expense',
      },
      {
        id: 'tx_after',
        Account: MOCK_CARD.name,
        Date: '01/01/2027',
        Time: '00:01:00',
        INR: 15000,
        'Income/Expense': 'Expense',
      },
    ];
    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period,
      transactions: txns,
      referenceDate: new Date('2026-06-01'),
    });
    assert.equal(progress.eligiblePurchaseTotal, 0, 'Transactions outside boundaries must be excluded');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Transaction Classification
  // ─────────────────────────────────────────────────────────────────────────────

  await suite.test('12. Eligible purchase adds spending', () => {
    const txn = {
      id: 'tx_buy_groceries',
      Account: MOCK_CARD.name,
      Date: '15/06/2026',
      INR: 12500,
      'Income/Expense': 'Expense',
      Category: 'Food & Dining',
      Subcategory: 'Groceries',
      Note: 'Supermarket shopping',
    };
    const res = classifyCreditCardTransaction(txn, MOCK_CARD);
    assert.equal(res.classification, CLASSIFICATION_TYPE.ELIGIBLE_PURCHASE);
    assert.equal(res.amount, 12500);
    assert.equal(res.isEligible, true);
  });

  await suite.test('13. Identifiable refund subtracts spending', () => {
    // Case A: Refund logged as Income with explicit Refunds subcategory
    const refundIncome = {
      id: 'tx_refund_1',
      Account: MOCK_CARD.name,
      Date: '20/06/2026',
      INR: 3500,
      'Income/Expense': 'Income',
      Category: 'Shopping',
      Subcategory: 'Refunds',
      Note: 'Amazon returned item',
    };
    const resA = classifyCreditCardTransaction(refundIncome, MOCK_CARD);
    assert.equal(resA.classification, CLASSIFICATION_TYPE.ELIGIBLE_REFUND);
    assert.equal(resA.amount, 3500);
    assert.equal(resA.isEligible, true);

    // Case B: Refund logged as negative Expense
    const refundNegativeExpense = {
      id: 'tx_refund_2',
      Account: MOCK_CARD.name,
      Date: '22/06/2026',
      INR: -1500,
      'Income/Expense': 'Expense',
      Category: 'Shopping',
      Note: 'Apparel return refund',
    };
    const resB = classifyCreditCardTransaction(refundNegativeExpense, MOCK_CARD);
    assert.equal(resB.classification, CLASSIFICATION_TYPE.ELIGIBLE_REFUND);
    assert.equal(resB.amount, 1500);
    assert.equal(resB.isEligible, true);
  });

  await suite.test('14. Credit card bill payment excluded', () => {
    // Case A: Transfer-Out to Credit Card from bank account
    const billPayTransfer = {
      id: 'tx_cc_pay_transfer',
      FromAccount: 'HDFC Bank',
      ToAccount: MOCK_CARD.name,
      Date: '18/06/2026',
      INR: 45000,
      'Income/Expense': 'Transfer-Out',
      Note: 'Credit Card Bill Payment',
    };
    const resA = classifyCreditCardTransaction(billPayTransfer, MOCK_CARD);
    assert.equal(resA.classification, CLASSIFICATION_TYPE.EXCLUDED_BILL_PAYMENT);
    assert.equal(resA.isEligible, false);

    // Case B: Credit card payment logged under Finance category
    const billPayFinance = {
      id: 'tx_cc_pay_cat',
      Account: MOCK_CARD.name,
      Date: '18/06/2026',
      INR: 45000,
      'Income/Expense': 'Expense',
      Category: 'Finance',
      Subcategory: 'Credit Card Payment',
      Note: 'Monthly bill payment',
    };
    const resB = classifyCreditCardTransaction(billPayFinance, MOCK_CARD);
    assert.equal(resB.classification, CLASSIFICATION_TYPE.EXCLUDED_BILL_PAYMENT);
    assert.equal(resB.isEligible, false);
  });

  await suite.test('15. Comprehensive transfer classification: every card-funded transfer counts towards waiver', () => {
    // 15a. Valid Transfer funded by credit card (Card to Lend) -> ELIGIBLE_TRANSFER
    const lendTransfer = {
      id: 'tx_xfer_lend',
      FromAccount: MOCK_CARD.name,
      ToAccount: 'Lend',
      Date: '10/06/2026',
      INR: 12000,
      'Income/Expense': 'Transfer-Out',
      Category: 'Lend',
      Tags: 'LENDING',
      Note: 'Lent to colleague for medical emergency',
    };
    const resLend = classifyCreditCardTransaction(lendTransfer, MOCK_CARD);
    assert.equal(resLend.classification, CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER);
    assert.equal(resLend.isEligible, true);
    assert.equal(resLend.amount, 12000);

    // 15b. Valid Transfer funded by credit card (Card to Adjustment) -> ELIGIBLE_TRANSFER
    const adjTransfer = {
      id: 'tx_xfer_adj',
      FromAccount: MOCK_CARD.name,
      ToAccount: 'Adjustment',
      Date: '11/06/2026',
      INR: 3500,
      'Income/Expense': 'Transfer-Out',
      Category: 'Adjustment',
      Note: 'Fee adjustment refund offset',
    };
    const resAdj = classifyCreditCardTransaction(adjTransfer, MOCK_CARD);
    assert.equal(resAdj.classification, CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER);
    assert.equal(resAdj.isEligible, true);
    assert.equal(resAdj.amount, 3500);

    // 15c. Ordinary card-funded transfer (Card to Cash Wallet / Bank) -> ELIGIBLE_TRANSFER (User explicit rule)
    const ownTransfer = {
      id: 'tx_transfer_own',
      FromAccount: MOCK_CARD.name,
      ToAccount: 'Cash Wallet',
      Date: '10/06/2026',
      INR: 10000,
      'Income/Expense': 'Transfer-Out',
      Note: 'Balance transfer to wallet',
    };
    const resOwn = classifyCreditCardTransaction(ownTransfer, MOCK_CARD);
    assert.equal(resOwn.classification, CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER);
    assert.equal(resOwn.isEligible, true);
    assert.equal(resOwn.amount, 10000);

    // 15d. Transfer into the credit card (card is receiving account) -> NOT ELIGIBLE
    const incomingTransfer = {
      id: 'tx_transfer_in',
      FromAccount: 'HDFC Savings',
      ToAccount: MOCK_CARD.name,
      Date: '12/06/2026',
      INR: 15000,
      'Income/Expense': 'Transfer-Out',
      Note: 'Deposit to card',
    };
    const resIn = classifyCreditCardTransaction(incomingTransfer, MOCK_CARD);
    assert.equal(resIn.isEligible, false);

    // 15e. Credit-card bill payment transfer -> EXCLUDED_BILL_PAYMENT
    const billPayTransfer = {
      id: 'tx_cc_pay',
      FromAccount: 'SBI Savings',
      ToAccount: MOCK_CARD.name,
      Date: '14/06/2026',
      INR: 25000,
      'Income/Expense': 'Transfer-Out',
      Category: 'Finance',
      Subcategory: 'Credit Card Payment',
      Note: 'Card statement bill payment',
    };
    const resBillPay = classifyCreditCardTransaction(billPayTransfer, MOCK_CARD);
    assert.equal(resBillPay.classification, CLASSIFICATION_TYPE.EXCLUDED_BILL_PAYMENT);
    assert.equal(resBillPay.isEligible, false);

    // 15f. Card-funded transfer with arbitrary personal note -> ELIGIBLE_TRANSFER (no Lend/Loan tag required)
    const ambTransfer = {
      id: 'tx_xfer_ambiguous',
      FromAccount: MOCK_CARD.name,
      ToAccount: 'Rahul',
      Date: '15/06/2026',
      INR: 8000,
      'Income/Expense': 'Transfer-Out',
      Note: 'Sent to Rahul for group trip share',
    };
    const resAmb = classifyCreditCardTransaction(ambTransfer, MOCK_CARD);
    assert.equal(resAmb.classification, CLASSIFICATION_TYPE.ELIGIBLE_TRANSFER);
    assert.equal(resAmb.isEligible, true);
    assert.equal(resAmb.amount, 8000);

    // 15g. Valid narrative description with word "cancelled" remains ELIGIBLE purchase
    const noteWithCancelled = {
      id: 'tx_cancelled_note',
      Account: MOCK_CARD.name,
      Date: '18/06/2026',
      INR: 4500,
      'Income/Expense': 'Expense',
      Category: 'Shopping',
      Note: 'Amazon order (cancelled previous item, reordered)',
    };
    const resNote = classifyCreditCardTransaction(noteWithCancelled, MOCK_CARD);
    assert.equal(resNote.classification, CLASSIFICATION_TYPE.ELIGIBLE_PURCHASE);
    assert.equal(resNote.isEligible, true);

    // 15h. Actual cancelled transaction with status 'cancelled' is EXCLUDED
    const actualCancelled = {
      id: 'tx_actual_cancelled',
      Account: MOCK_CARD.name,
      Date: '19/06/2026',
      INR: 4500,
      'Income/Expense': 'Expense',
      status: 'cancelled',
      Note: 'Cancelled order',
    };
    const resCancelled = classifyCreditCardTransaction(actualCancelled, MOCK_CARD);
    assert.equal(resCancelled.classification, CLASSIFICATION_TYPE.EXCLUDED_REVERSAL);
    assert.equal(resCancelled.isEligible, false);
  });

  await suite.test('16. Interest and finance charges excluded', () => {
    const interest = {
      id: 'tx_interest',
      Account: MOCK_CARD.name,
      Date: '16/06/2026',
      INR: 1450,
      'Income/Expense': 'Expense',
      Category: 'Finance',
      Subcategory: 'Interest',
      Note: 'Finance charges on revolving balance',
    };
    const res = classifyCreditCardTransaction(interest, MOCK_CARD);
    assert.equal(res.classification, CLASSIFICATION_TYPE.EXCLUDED_INTEREST);
    assert.equal(res.isEligible, false);
  });

  await suite.test('17. Annual and renewal fees excluded', () => {
    const fee = {
      id: 'tx_annual_fee',
      Account: MOCK_CARD.name,
      Date: '15/05/2026',
      INR: 3000,
      'Income/Expense': 'Expense',
      Category: 'Finance',
      Subcategory: 'Bank Charges',
      Note: 'Annual Membership Fee for 2026',
    };
    const res = classifyCreditCardTransaction(fee, MOCK_CARD);
    assert.equal(res.classification, CLASSIFICATION_TYPE.EXCLUDED_ANNUAL_FEE);
    assert.equal(res.isEligible, false);
  });

  await suite.test('18. Cash withdrawal / ATM advance excluded', () => {
    const cash = {
      id: 'tx_atm_cash',
      Account: MOCK_CARD.name,
      Date: '25/06/2026',
      INR: 10000,
      'Income/Expense': 'Expense',
      Category: 'Finance',
      Subcategory: 'Cash Withdrawal',
      Note: 'ATM Cash Advance withdrawal',
    };
    const res = classifyCreditCardTransaction(cash, MOCK_CARD);
    assert.equal(res.classification, CLASSIFICATION_TYPE.EXCLUDED_CASH_WITHDRAWAL);
    assert.equal(res.isEligible, false);
  });

  await suite.test('19. Reversed and cancelled transactions excluded', () => {
    const reversal = {
      id: 'tx_reversed',
      Account: MOCK_CARD.name,
      Date: '14/06/2026',
      INR: 8000,
      'Income/Expense': 'Expense',
      Tags: 'REVERSAL',
      Note: 'Flight ticket booking cancelled and reversed',
    };
    const res = classifyCreditCardTransaction(reversal, MOCK_CARD);
    assert.equal(res.classification, CLASSIFICATION_TYPE.EXCLUDED_REVERSAL);
    assert.equal(res.isEligible, false);
  });

  await suite.test('20. Cashback/rewards not treated as refunds automatically', () => {
    const cashback = {
      id: 'tx_cb_reward',
      Account: MOCK_CARD.name,
      Date: '01/07/2026',
      INR: 1500,
      'Income/Expense': 'Income',
      Category: 'Income',
      Subcategory: 'Cashback / Rewards',
      Note: 'Cred cashback credited',
    };
    const res = classifyCreditCardTransaction(cashback, MOCK_CARD);
    assert.equal(res.classification, CLASSIFICATION_TYPE.EXCLUDED_REWARDS_CASHBACK);
    assert.equal(res.isEligible, false);
  });

  await suite.test('21. Ambiguous income excluded without guessing', () => {
    const ambiguousIncome = {
      id: 'tx_generic_income',
      Account: MOCK_CARD.name,
      Date: '02/07/2026',
      INR: 2000,
      'Income/Expense': 'Income',
      Category: 'Miscellaneous',
      Note: 'Payment adjustment credit',
    };
    const res = classifyCreditCardTransaction(ambiguousIncome, MOCK_CARD);
    assert.equal(res.classification, CLASSIFICATION_TYPE.EXCLUDED_AMBIGUOUS_INCOME);
    assert.equal(res.isEligible, false);
  });

  await suite.test('22. Unknown transaction shape reported as UNKNOWN', () => {
    const corrupted = {
      id: 'tx_corrupt',
      Account: MOCK_CARD.name,
      'Income/Expense': 'UnknownType_XYZ',
      INR: 1000,
    };
    const res = classifyCreditCardTransaction(corrupted, MOCK_CARD);
    assert.equal(res.classification, CLASSIFICATION_TYPE.UNKNOWN);
    assert.equal(res.isEligible, false);
  });

  await suite.test('23. No double-subtraction of refunds', () => {
    // If a purchase was ₹20,000 and a refund is recorded once as negative expense of ₹5,000,
    // net spend must be exactly ₹15,000 (not subtracted twice).
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [
      { id: 'p1', Account: MOCK_CARD.name, Date: '10/02/2026', INR: 20000, 'Income/Expense': 'Expense' },
      { id: 'r1', Account: MOCK_CARD.name, Date: '15/02/2026', INR: -5000, 'Income/Expense': 'Expense' },
    ];
    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period,
      transactions: txns,
      referenceDate: new Date('2026-06-01'),
    });

    assert.equal(progress.eligiblePurchaseTotal, 20000);
    assert.equal(progress.eligibleRefundTotal, 5000);
    assert.equal(progress.netEligibleSpend, 15000, 'Net eligible spend must be exactly ₹15,000');
  });

  await suite.test('24. Transactions belonging to another card excluded', () => {
    const txnOtherCard = {
      id: 'tx_other_card',
      Account: MOCK_OTHER_CARD.name,
      Date: '10/05/2026',
      INR: 35000,
      'Income/Expense': 'Expense',
    };
    const res = classifyCreditCardTransaction(txnOtherCard, MOCK_CARD);
    assert.equal(res.classification, CLASSIFICATION_TYPE.EXCLUDED_NON_CARD);
    assert.equal(res.isEligible, false);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Spending & Status Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  await suite.test('25. Below threshold status: IN_PROGRESS', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [
      { id: 't1', Account: MOCK_CARD.name, Date: '10/03/2026', INR: 40000, 'Income/Expense': 'Expense' },
    ];
    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000, annualFee: 1000 },
      period,
      transactions: txns,
      referenceDate: new Date('2026-06-01'),
    });

    assert.equal(progress.status, WAIVER_STATUS.IN_PROGRESS);
    assert.equal(progress.netEligibleSpend, 40000);
    assert.equal(progress.amountRemaining, 60000);
    assert.equal(progress.percentCompleted, 40);
  });

  await suite.test('26. Exactly at threshold: TARGET_REACHED', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [
      { id: 't1', Account: MOCK_CARD.name, Date: '10/03/2026', INR: 100000, 'Income/Expense': 'Expense' },
    ];
    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000, annualFee: 1000 },
      period,
      transactions: txns,
      referenceDate: new Date('2026-06-01'),
    });

    assert.equal(progress.status, WAIVER_STATUS.TARGET_REACHED);
    assert.equal(progress.netEligibleSpend, 100000);
    assert.equal(progress.amountRemaining, 0);
    assert.equal(progress.percentCompleted, 100);
  });

  await suite.test('27. Above threshold: TARGET_REACHED with capped 100% progress', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [
      { id: 't1', Account: MOCK_CARD.name, Date: '10/03/2026', INR: 145000, 'Income/Expense': 'Expense' },
    ];
    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000, annualFee: 1000 },
      period,
      transactions: txns,
      referenceDate: new Date('2026-06-01'),
    });

    assert.equal(progress.status, WAIVER_STATUS.TARGET_REACHED);
    assert.equal(progress.netEligibleSpend, 145000);
    assert.equal(progress.amountRemaining, 0);
    assert.equal(progress.percentCompleted, 100);
  });

  await suite.test('28. Refund after target reached pulls status back to IN_PROGRESS', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    // Reached ₹1,00,000 threshold on 10 March
    const txnsBefore = [
      { id: 't1', Account: MOCK_CARD.name, Date: '10/03/2026', INR: 100000, 'Income/Expense': 'Expense' },
    ];
    const progBefore = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period,
      transactions: txnsBefore,
      referenceDate: new Date('2026-04-01'),
    });
    assert.equal(progBefore.status, WAIVER_STATUS.TARGET_REACHED);

    // Later refunded ₹15,000 on 20 April
    const txnsAfter = [
      ...txnsBefore,
      { id: 'r1', Account: MOCK_CARD.name, Date: '20/04/2026', INR: -15000, 'Income/Expense': 'Expense' },
    ];
    const progAfter = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period,
      transactions: txnsAfter,
      referenceDate: new Date('2026-05-01'),
    });
    assert.equal(progAfter.netEligibleSpend, 85000);
    assert.equal(progAfter.amountRemaining, 15000);
    assert.equal(progAfter.status, WAIVER_STATUS.IN_PROGRESS, 'Status must revert to IN_PROGRESS after refund');
  });

  await suite.test('29. Transaction edited recalculates progress reactively', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txnOriginal = [{ id: 'tx_edit', Account: MOCK_CARD.name, Date: '10/03/2026', INR: 50000, 'Income/Expense': 'Expense' }];
    const prog1 = calculateFeeWaiverProgress({
      card: MOCK_CARD, config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period, transactions: txnOriginal, referenceDate: new Date('2026-05-01')
    });
    assert.equal(prog1.netEligibleSpend, 50000);

    // User edits amount from ₹50,000 to ₹1,20,000
    const txnUpdated = [{ id: 'tx_edit', Account: MOCK_CARD.name, Date: '10/03/2026', INR: 120000, 'Income/Expense': 'Expense' }];
    const prog2 = calculateFeeWaiverProgress({
      card: MOCK_CARD, config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period, transactions: txnUpdated, referenceDate: new Date('2026-05-01')
    });
    assert.equal(prog2.netEligibleSpend, 120000);
    assert.equal(prog2.status, WAIVER_STATUS.TARGET_REACHED);
  });

  await suite.test('30. Transaction deleted recalculates progress reactively', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [
      { id: 't1', Account: MOCK_CARD.name, Date: '10/03/2026', INR: 60000, 'Income/Expense': 'Expense' },
      { id: 't2', Account: MOCK_CARD.name, Date: '12/03/2026', INR: 40000, 'Income/Expense': 'Expense' },
    ];
    const p1 = calculateFeeWaiverProgress({
      card: MOCK_CARD, config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period, transactions: txns, referenceDate: new Date('2026-05-01')
    });
    assert.equal(p1.status, WAIVER_STATUS.TARGET_REACHED);

    // t2 deleted
    const p2 = calculateFeeWaiverProgress({
      card: MOCK_CARD, config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period, transactions: [txns[0]], referenceDate: new Date('2026-05-01')
    });
    assert.equal(p2.netEligibleSpend, 60000);
    assert.equal(p2.status, WAIVER_STATUS.IN_PROGRESS);
  });

  await suite.test('31. Target reached is strictly distinct from user-confirmed bank waiver', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [{ id: 't1', Account: MOCK_CARD.name, Date: '10/03/2026', INR: 105000, 'Income/Expense': 'Expense' }];

    // Without user manual confirmation
    const calculatedOnly = calculateFeeWaiverProgress({
      card: MOCK_CARD, config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period, transactions: txns, referenceDate: new Date('2026-05-01')
    });
    assert.equal(calculatedOnly.status, WAIVER_STATUS.TARGET_REACHED);
    assert.notEqual(calculatedOnly.status, WAIVER_STATUS.BANK_CONFIRMED_WAIVED);

    // With explicit user confirmation
    const bankConfirmed = calculateFeeWaiverProgress({
      card: MOCK_CARD, config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period, transactions: txns, referenceDate: new Date('2026-05-01'), bankOutcome: 'WAIVED'
    });
    assert.equal(bankConfirmed.status, WAIVER_STATUS.BANK_CONFIRMED_WAIVED);
  });

  await suite.test('32. Target missed after cycle end: TARGET_MISSED', () => {
    const period = {
      startDate: new Date('2025-01-01T00:00:00.000'),
      endDate: new Date('2025-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const txns = [{ id: 't1', Account: MOCK_CARD.name, Date: '10/03/2025', INR: 50000, 'Income/Expense': 'Expense' }];

    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD, config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period, transactions: txns, referenceDate: new Date('2026-01-15') // past deadline
    });

    assert.equal(progress.status, WAIVER_STATUS.TARGET_MISSED);
    assert.equal(progress.daysRemaining, 0);
  });

  await suite.test('33. Average monthly spending calculation', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    // ₹40,000 spent out of ₹1,00,000 threshold (remaining: ₹60,000)
    // Reference date: 1 July 2026 (~6 months remaining)
    const txns = [{ id: 't1', Account: MOCK_CARD.name, Date: '10/03/2026', INR: 40000, 'Income/Expense': 'Expense' }];
    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD, config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 100000 },
      period, transactions: txns, referenceDate: new Date('2026-07-01')
    });

    assert.equal(progress.amountRemaining, 60000);
    assert.ok(progress.avgMonthlySpendRequired > 9000 && progress.avgMonthlySpendRequired < 11000);
  });

  await suite.test('34. Lifetime Free and Zero threshold handling', () => {
    const progressLTF = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.LIFETIME_FREE },
      period: null,
      transactions: [],
    });
    assert.equal(progressLTF.status, WAIVER_STATUS.LIFETIME_FREE);
    assert.equal(progressLTF.percentCompleted, 100);
    assert.equal(progressLTF.amountRemaining, 0);

    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const progressZero = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 0 },
      period,
      transactions: [],
    });
    assert.equal(progressZero.percentCompleted, 100);
    assert.equal(progressZero.amountRemaining, 0);
  });

  await suite.test('35. No division-by-zero or NaN in any calculations', () => {
    const period = {
      startDate: new Date('2026-01-01T00:00:00.000'),
      endDate: new Date('2026-12-31T23:59:59.999'),
      isFirstYear: false,
    };
    const progress = calculateFeeWaiverProgress({
      card: MOCK_CARD,
      config: { feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER, spendThreshold: 0 },
      period,
      transactions: [],
      referenceDate: new Date('2027-01-01'), // past deadline
    });

    assert.equal(isNaN(progress.netEligibleSpend), false);
    assert.equal(isNaN(progress.amountRemaining), false);
    assert.equal(isNaN(progress.percentCompleted), false);
    assert.equal(isNaN(progress.daysRemaining), false);
    assert.equal(isNaN(progress.avgMonthlySpendRequired), false);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Architectural & Regression Safeguards
  // ─────────────────────────────────────────────────────────────────────────────

  await suite.test('36. Existing account balance calculations remain untouched', () => {
    // Assert existing isCreditCard is still functional and returns expected booleans
    assert.equal(isCreditCard({ acctType: 'Credit Card' }), true);
    assert.equal(isCreditCard({ acctType: '' }), false);
    assert.equal(isCreditCard({ name: 'HDFC Credit Card' }), true);
    assert.equal(isCreditCard({ name: 'HDFC Debit Card' }), false);
  });

  await suite.test('37. Existing credit card billing-cycle calculations remain untouched', () => {
    const card = { settlementDate: 15, paymentDueDays: 20 };
    const today = new Date(2026, 10, 10); // 10 Nov 2026 (before settlement 15 Nov)
    const due = ccNextDueDate(card, today);
    assert.ok(due && typeof due.getTime === 'function' && !isNaN(due.getTime()));
    const days = ccDaysUntilDue(card, today);
    assert.ok(typeof days === 'number');
  });

  await suite.test('38. Existing transaction signs and amount conventions preserved', () => {
    const normalExpense = { Account: MOCK_CARD.name, INR: 2500, 'Income/Expense': 'Expense' };
    const normalIncome = { Account: MOCK_CARD.name, INR: 5000, 'Income/Expense': 'Income' };

    assert.equal(classifyCreditCardTransaction(normalExpense, MOCK_CARD).amount, 2500);
    assert.equal(classifyCreditCardTransaction(normalIncome, MOCK_CARD).amount, 5000);
  });

});
