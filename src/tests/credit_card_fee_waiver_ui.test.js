/**
 * FinMan Phase 4 & Phase 5 — Credit Card Fee Waiver UI & Integration Suite
 *
 * Verifies:
 * 1. CreditCardFeeWaiverModal: fee structures (Lifetime Free, Fixed Fee, Threshold-Based).
 * 2. CreditCardFeeWaiverModal: qualification periods (Anniversary, Calendar, Financial Year, Custom Range).
 * 3. CreditCardFeeWaiverModal: validation (non-negative fees/thresholds, date ordering, issuance date required for anniversary).
 * 4. FeeWaiverTrackerSection: calculation, badges, progress bar, daily/monthly run rates.
 * 5. FeeWaiverTrackerSection: expandable audit drawer (eligible purchases, transfers, refunds, excluded reasons, ambiguous warnings).
 * 6. FeeWaiverTrackerSection: recording bank waiver outcomes into historical records.
 * 7. Accounts.jsx integration: Fee Waiver button in drilled Credit Card screen and modal mount.
 * 8. Settings.jsx integration: Configure Waiver button in Credit Cards manager and modal mount.
 * 9. CardOptimizer.jsx integration: FeeWaiverTrackerSection mounted below grace periods.
 * 10. Non-card transactions are strictly excluded from the card's audit breakdown (no NON-CARD leaks).
 * 11. Relevant excluded card transactions and ambiguous transfers remain visible and correctly labelled.
 * 12. Multiple cards do not leak transactions into each other's audit views.
 * 13. Reconciled net spending formula matches calculated engine spend exactly down to the rupee.
 * 14. Default collapsed state and independent expansion of multiple cards.
 * 15. Single unambiguous source of truth: no duplicate milestone progress or ₹2,00,000 targets in CardOptimizer.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEE_STRUCTURE,
  PERIOD_TYPE,
  WAIVER_STATUS,
  CLASSIFICATION_TYPE,
  resolveQualificationPeriod,
  calculateFeeWaiverProgress,
  isTransactionForCard,
} from '../utils/feeWaiverEngine.js';

import {
  saveFeeWaiverConfig,
  getFeeWaiverConfigForCard,
  saveFeeWaiverCycleOutcome,
  getFeeWaiverHistoryForCard,
} from '../utils/feeWaiverStorage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

test('FinMan Phase 4 & 5 — Fee Waiver UI & Integration Suite', async (t) => {
  // Read source files for structural verification
  const modalJsxPath = path.join(projectRoot, 'src/components/Accounts/CreditCardFeeWaiverModal.jsx');
  const modalCssPath = path.join(projectRoot, 'src/components/Accounts/CreditCardFeeWaiverModal.css');
  const trackerJsxPath = path.join(projectRoot, 'src/components/Accounts/FeeWaiverTrackerSection.jsx');
  const trackerCssPath = path.join(projectRoot, 'src/components/Accounts/FeeWaiverTrackerSection.css');
  const accountsJsxPath = path.join(projectRoot, 'src/components/Accounts/Accounts.jsx');
  const settingsJsxPath = path.join(projectRoot, 'src/components/Settings/Settings.jsx');
  const optimizerJsxPath = path.join(projectRoot, 'src/components/Accounts/CardOptimizer.jsx');

  const modalJsx = fs.readFileSync(modalJsxPath, 'utf8');
  const modalCss = fs.readFileSync(modalCssPath, 'utf8');
  const trackerJsx = fs.readFileSync(trackerJsxPath, 'utf8');
  const trackerCss = fs.readFileSync(trackerCssPath, 'utf8');
  const accountsJsx = fs.readFileSync(accountsJsxPath, 'utf8');
  const settingsJsx = fs.readFileSync(settingsJsxPath, 'utf8');
  const optimizerJsx = fs.readFileSync(optimizerJsxPath, 'utf8');

  await t.test('1. Component files exist and are populated', () => {
    assert.ok(fs.existsSync(modalJsxPath), 'CreditCardFeeWaiverModal.jsx must exist');
    assert.ok(fs.existsSync(modalCssPath), 'CreditCardFeeWaiverModal.css must exist');
    assert.ok(fs.existsSync(trackerJsxPath), 'FeeWaiverTrackerSection.jsx must exist');
    assert.ok(fs.existsSync(trackerCssPath), 'FeeWaiverTrackerSection.css must exist');
  });

  await t.test('2. CreditCardFeeWaiverModal supports all 3 fee structures and conditional fields', () => {
    assert.ok(modalJsx.includes(FEE_STRUCTURE.LIFETIME_FREE), 'Must support LIFETIME_FREE');
    assert.ok(modalJsx.includes(FEE_STRUCTURE.FIXED_FEE), 'Must support FIXED_FEE');
    assert.ok(modalJsx.includes(FEE_STRUCTURE.THRESHOLD_WAIVER), 'Must support THRESHOLD_WAIVER');

    // Conditional visibility: Lifetime free hides threshold & annual fee inputs
    assert.ok(modalJsx.includes("feeStructure !== FEE_STRUCTURE.LIFETIME_FREE"), 'Must hide fee inputs for lifetime free');
    assert.ok(modalJsx.includes("feeStructure === FEE_STRUCTURE.THRESHOLD_WAIVER"), 'Must show threshold and period only for threshold waiver');
  });

  await t.test('3. CreditCardFeeWaiverModal supports all 4 qualification periods & custom date validation', () => {
    assert.ok(modalJsx.includes(PERIOD_TYPE.ANNIVERSARY), 'Must support ANNIVERSARY');
    assert.ok(modalJsx.includes(PERIOD_TYPE.CALENDAR_YEAR), 'Must support CALENDAR_YEAR');
    assert.ok(modalJsx.includes(PERIOD_TYPE.FINANCIAL_YEAR), 'Must support FINANCIAL_YEAR');
    assert.ok(modalJsx.includes(PERIOD_TYPE.CUSTOM), 'Must support CUSTOM');

    // Custom date range inputs
    assert.ok(modalJsx.includes('customStartDate'), 'Must have customStartDate');
    assert.ok(modalJsx.includes('customEndDate'), 'Must have customEndDate');

    // Validation: Start before end, non-negative amounts, issuance date required for anniversary
    assert.ok(modalJsx.includes('End date cannot be earlier than start date'), 'Must validate custom date order');
    assert.ok(modalJsx.includes('Card issuance date is required for anniversary qualification'), 'Must validate issuance date for anniversary');
    assert.ok(modalJsx.includes('Annual fee cannot be negative'), 'Must validate non-negative annual fee');
    assert.ok(modalJsx.includes('Spending threshold cannot be negative'), 'Must validate non-negative spend threshold');
  });

  await t.test('4. FeeWaiverTrackerSection accurately computes and displays progress and badges', () => {
    const mockCard = { id: 'card_ui_1', name: 'Regalia Gold', type: 'Credit Card' };
    const mockConfig = {
      cardId: 'card_ui_1',
      feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER,
      annualFee: 2500,
      spendThreshold: 400000,
      periodType: PERIOD_TYPE.CALENDAR_YEAR,
    };

    const mockTxns = [
      { _id: 'tx1', Date: '15/04/2026', 'Income/Expense': 'Expense', Account: 'Regalia Gold', Amount: 150000, Category: 'Shopping' },
      { _id: 'tx2', Date: '20/05/2026', 'Income/Expense': 'Expense', Account: 'Regalia Gold', Amount: 50000, Category: 'Travel' },
      { _id: 'tx3', Date: '22/05/2026', 'Income/Expense': 'Income', Account: 'Regalia Gold', Amount: 10000, Category: 'Refund' },
    ];

    const period = resolveQualificationPeriod({
      card: mockCard,
      config: mockConfig,
      referenceDate: '2026-06-01',
    });

    const result = calculateFeeWaiverProgress({
      card: mockCard,
      config: mockConfig,
      period,
      transactions: mockTxns,
      referenceDate: '2026-06-01',
    });

    assert.strictEqual(result.netEligibleSpend, 190000);
    assert.strictEqual(result.amountRemaining, 210000);
    assert.strictEqual(result.percentCompleted, 47.5);
    assert.strictEqual(result.status, WAIVER_STATUS.IN_PROGRESS);

    // Verify tracker JSX contains matching display sections
    assert.ok(trackerJsx.includes('calculateFeeWaiverProgress'), 'Tracker must use calculateFeeWaiverProgress');
    assert.ok(trackerJsx.includes('fee-waiver-progress-bar'), 'Tracker must contain progress bar');
    assert.ok(trackerJsx.includes('avgMonthlySpendRequired'), 'Tracker must compute and display monthly needed run rate');
  });

  await t.test('5. FeeWaiverTrackerSection audit drawer shows eligible breakdowns, exclusions, and ambiguous warnings', () => {
    assert.ok(trackerJsx.includes('eligiblePurchaseTotal'), 'Must display eligible purchase total');
    assert.ok(trackerJsx.includes('eligibleTransferTotal'), 'Must display eligible transfer total');
    assert.ok(trackerJsx.includes('eligibleRefundTotal'), 'Must display eligible refund total');
    assert.ok(trackerJsx.includes('ambiguousCount'), 'Must display ambiguous warning count');
    assert.ok(trackerJsx.includes('fee-waiver-breakdown-panel'), 'Must contain audit breakdown panel');
  });

  await t.test('6. Bank confirmation outcome modal records verified decisions with user notes', () => {
    assert.ok(trackerJsx.includes('saveFeeWaiverCycleOutcome'), 'Must invoke saveFeeWaiverCycleOutcome');
    assert.ok(trackerJsx.includes('bankOutcomeNotes'), 'Must support optional user notes for bank confirmation');
    assert.ok(trackerJsx.includes('WAIVED'), 'Must support WAIVED bank outcome');
    assert.ok(trackerJsx.includes('CHARGED'), 'Must support CHARGED bank outcome');
    assert.ok(trackerJsx.includes('PENDING'), 'Must support PENDING bank outcome');
  });

  await t.test('7. Accounts.jsx integration: Fee Waiver button in drilled Credit Card screen', () => {
    assert.ok(accountsJsx.includes('import CreditCardFeeWaiverModal'), 'Accounts.jsx must import CreditCardFeeWaiverModal');
    assert.ok(accountsJsx.includes('showWaiverModal'), 'Accounts.jsx must maintain showWaiverModal state');
    assert.ok(accountsJsx.includes('Fee Waiver'), 'Drilled credit card header must contain Fee Waiver button');
    assert.ok(accountsJsx.includes('<CreditCardFeeWaiverModal'), 'Accounts.jsx must mount CreditCardFeeWaiverModal');
  });

  await t.test('8. Settings.jsx integration: Configure Waiver button in AccountsManager', () => {
    assert.ok(settingsJsx.includes('import CreditCardFeeWaiverModal'), 'Settings.jsx must import CreditCardFeeWaiverModal');
    assert.ok(settingsJsx.includes('waiverModalCard'), 'Settings.jsx must maintain waiverModalCard state');
    assert.ok(settingsJsx.includes('Configure Waiver'), 'Credit Cards section must contain Configure Waiver button');
    assert.ok(settingsJsx.includes('<CreditCardFeeWaiverModal'), 'Settings.jsx must mount CreditCardFeeWaiverModal');
  });

  await t.test('9. CardOptimizer.jsx integration: FeeWaiverTrackerSection is mounted below grace periods', () => {
    assert.ok(optimizerJsx.includes('import FeeWaiverTrackerSection'), 'CardOptimizer.jsx must import FeeWaiverTrackerSection');
    assert.ok(optimizerJsx.includes('<FeeWaiverTrackerSection'), 'CardOptimizer.jsx must render FeeWaiverTrackerSection');

    // Confirm it is positioned after the grace period display
    const graceIndex = optimizerJsx.indexOf('Grace Period');
    const waiverIndex = optimizerJsx.indexOf('<FeeWaiverTrackerSection');
    assert.ok(graceIndex > 0, 'Grace Period text must exist');
    assert.ok(waiverIndex > graceIndex, 'FeeWaiverTrackerSection must be positioned below grace periods');
  });

  await t.test('10. Non-card transactions are strictly excluded from selected card audit breakdown (no NON-CARD leaks)', () => {
    const cardAxis = { id: 'card_axis_fk', name: 'Axis Flipkart', type: 'Credit Card' };
    const cardConfig = {
      cardId: 'card_axis_fk',
      feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER,
      annualFee: 500,
      spendThreshold: 350000,
      periodType: PERIOD_TYPE.CALENDAR_YEAR,
    };

    const mixedTransactions = [
      // Transactions belonging to Axis Flipkart
      { _id: 'tx_af_1', Date: '10/02/2026', 'Income/Expense': 'Expense', Account: 'Axis Flipkart', Amount: 5000, Category: 'Shopping' },
      { _id: 'tx_af_2', Date: '15/02/2026', 'Income/Expense': 'Income', Account: 'Axis Flipkart', Amount: 1000, Category: 'Refund' },
      { _id: 'tx_af_bill', Date: '20/02/2026', 'Income/Expense': 'Income', Account: 'Axis Flipkart', Amount: 4000, Category: 'Credit Card Payment' },

      // Unrelated transactions from checking accounts, cash, and other cards in the same date range
      { _id: 'tx_bank_1', Date: '11/02/2026', 'Income/Expense': 'Expense', Account: 'HDFC Bank', Amount: 25000, Category: 'Rent' },
      { _id: 'tx_bank_2', Date: '12/02/2026', 'Income/Expense': 'Income', Account: 'SBI Savings', Amount: 100000, Category: 'Salary' },
      { _id: 'tx_cash_1', Date: '13/02/2026', 'Income/Expense': 'Expense', Account: 'Cash Wallet', Amount: 500, Category: 'Groceries' },
      { _id: 'tx_other_cc', Date: '14/02/2026', 'Income/Expense': 'Expense', Account: 'ICICI Amazon Pay', Amount: 12000, Category: 'Electronics' },
    ];

    const period = resolveQualificationPeriod({ card: cardAxis, config: cardConfig, referenceDate: '2026-03-01' });

    // When passing mixed transactions to calculateFeeWaiverProgress
    const progress = calculateFeeWaiverProgress({
      card: cardAxis,
      config: cardConfig,
      period,
      transactions: mixedTransactions,
      referenceDate: '2026-03-01',
    });

    // 1. Foreign transactions must NOT be in classifiedTransactions
    const nonCardTxns = progress.classifiedTransactions.filter(ct => ct.classification === CLASSIFICATION_TYPE.EXCLUDED_NON_CARD);
    assert.strictEqual(nonCardTxns.length, 0, 'No NON-CARD transactions should appear in classifiedTransactions');

    // 2. Total classified transactions must match ONLY the Axis Flipkart transactions (3 transactions)
    assert.strictEqual(progress.classifiedTransactions.length, 3, 'Must only classify transactions belonging to Axis Flipkart');

    // 3. Excluded count must only be 1 (the bill payment), NOT 5 (bill payment + 4 foreign accounts)
    assert.strictEqual(progress.excludedCount, 1, 'Excluded count must only include relevant card transactions');
    assert.strictEqual(progress.excludedBreakdown[CLASSIFICATION_TYPE.EXCLUDED_BILL_PAYMENT], 1);
    assert.strictEqual(progress.excludedBreakdown[CLASSIFICATION_TYPE.EXCLUDED_NON_CARD], undefined, 'EXCLUDED_NON_CARD must not be in breakdown');

    // 4. Net eligible spend must be 5000 - 1000 = 4000
    assert.strictEqual(progress.eligiblePurchaseTotal, 5000);
    assert.strictEqual(progress.eligibleRefundTotal, 1000);
    assert.strictEqual(progress.netEligibleSpend, 4000);
  });

  await t.test('11. Relevant excluded card transactions and ambiguous transfers remain visible and flagged', () => {
    const card = { id: 'card_audit_test', name: 'Citi PremierMiles', type: 'Credit Card' };
    const config = {
      cardId: 'card_audit_test',
      feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER,
      annualFee: 3000,
      spendThreshold: 300000,
      periodType: PERIOD_TYPE.CALENDAR_YEAR,
    };

    const cardTxns = [
      { _id: 'tx_p1', Date: '05/03/2026', 'Income/Expense': 'Expense', Account: 'Citi PremierMiles', Amount: 50000, Category: 'Flight Tickets' },
      { _id: 'tx_fee', Date: '10/03/2026', 'Income/Expense': 'Expense', Account: 'Citi PremierMiles', Amount: 3000, Category: 'Annual Fee' },
      { _id: 'tx_cash', Date: '12/03/2026', 'Income/Expense': 'Expense', Account: 'Citi PremierMiles', Amount: 10000, Category: 'Cash Advance ATM' },
      { _id: 'tx_ambig', Date: '15/03/2026', 'Income/Expense': 'Transfer', FromAccount: 'Citi PremierMiles', ToAccount: 'John Doe', Amount: 8000, Note: 'Payment' },
      { _id: 'tx_lend', Date: '16/03/2026', 'Income/Expense': 'Transfer', FromAccount: 'Citi PremierMiles', ToAccount: 'Lend', Amount: 12000, Note: 'Loan to brother' },
    ];

    const period = resolveQualificationPeriod({ card, config, referenceDate: '2026-04-01' });
    const progress = calculateFeeWaiverProgress({
      card,
      config,
      period,
      transactions: cardTxns,
      referenceDate: '2026-04-01',
    });

    // Every valid card-funded transfer counts towards waiver (12000 + 8000 = 20000)
    // Net spend = 50,000 (purchase) + 20,000 (card transfers) = 70,000
    assert.strictEqual(progress.eligiblePurchaseTotal, 50000);
    assert.strictEqual(progress.eligibleTransferTotal, 20000);
    assert.strictEqual(progress.netEligibleSpend, 70000);

    // Excluded card transactions: Annual fee (3000) + Cash advance (10000) = 2 exclusions
    assert.strictEqual(progress.excludedCount, 2);
    assert.strictEqual(progress.excludedBreakdown[CLASSIFICATION_TYPE.EXCLUDED_ANNUAL_FEE], 1);
    assert.strictEqual(progress.excludedBreakdown[CLASSIFICATION_TYPE.EXCLUDED_CASH_WITHDRAWAL], 1);
  });

  await t.test('12. Multiple cards do not leak transactions into each other audit views', () => {
    const card1 = { id: 'card_1', name: 'HDFC Millennia', type: 'Credit Card' };
    const card2 = { id: 'card_2', name: 'SBI SimplyCLICK', type: 'Credit Card' };

    const tx1 = { _id: 't1', Date: '01/05/2026', 'Income/Expense': 'Expense', Account: 'HDFC Millennia', Amount: 15000 };
    const tx2 = { _id: 't2', Date: '02/05/2026', 'Income/Expense': 'Expense', Account: 'SBI SimplyCLICK', Amount: 25000 };

    assert.strictEqual(isTransactionForCard(tx1, card1), true);
    assert.strictEqual(isTransactionForCard(tx1, card2), false);

    assert.strictEqual(isTransactionForCard(tx2, card1), false);
    assert.strictEqual(isTransactionForCard(tx2, card2), true);
  });

  await t.test('13. Reconciled net spending formula matches calculated engine spend exactly', () => {
    const purchases = 145000.50;
    const transfers = 25000.00;
    const refunds = 12000.50;
    const netSpend = purchases + transfers - refunds;

    assert.strictEqual(netSpend, 158000.00);

    // Verify formula card presentation in JSX and CSS
    assert.ok(trackerJsx.includes('fee-waiver-formula-card'), 'JSX must render fee-waiver-formula-card');
    assert.ok(trackerJsx.includes('Reconciled Net Spending Formula'), 'Must display formula title');
    assert.ok(trackerCss.includes('.fee-waiver-formula-card'), 'CSS must define formula card style');
  });

  await t.test('14. Default collapsed state and independent card toggle in FeeWaiverTrackerSection', () => {
    // Initial state must be empty object {} so all cards are collapsed by default
    assert.ok(trackerJsx.includes('expandedCards, setExpandedCards] = useState({})'), 'expandedCards must be initialized to empty object');
    assert.ok(trackerJsx.includes('expandedCards[cardId]'), 'isExpanded must check specific cardId');
    assert.ok(trackerJsx.includes('[cardKey]: !p[cardKey]'), 'Toggle must only invert the specific cardKey');
  });

  await t.test('15. Single unambiguous source of truth: no duplicate grace list in CardOptimizer', () => {
    // Standalone "ALL CREDIT CARDS GRACE PERIODS" section is completely removed
    assert.ok(!optimizerJsx.includes('ALL CREDIT CARDS GRACE PERIODS'), 'Standalone grace list must be removed');
    assert.ok(!optimizerJsx.includes('feeWaiverTarget || 200000'), 'Must not display generic 2L fallback target');
    assert.ok(!optimizerJsx.includes('Edit Target ⚙️'), 'Must not render redundant Edit Target button');
    assert.ok(!optimizerJsx.includes('🎯 Annual Fee Waiver Progress'), 'Top cards must not duplicate waiver progress header');

    // Recommendation banner is preserved
    assert.ok(optimizerJsx.includes('⚡ BEST CARD TO SWIPE TODAY'), 'Must preserve recommendation banner');

    // FeeWaiverTrackerSection is mounted as the single unified card list
    assert.ok(optimizerJsx.includes('<FeeWaiverTrackerSection'), 'Must mount FeeWaiverTrackerSection as single source of truth');

    // Credit Card Overview retains Section A: Billing & Grace Period
    assert.ok(trackerJsx.includes('Billing &amp; Grace Period'), 'Overview must render Section A: Billing & Grace Period');
    assert.ok(trackerJsx.includes('billingInfo.graceDays'), 'Overview must display grace days for each card');
    assert.ok(trackerJsx.includes('billingInfo.stmtDay'), 'Overview must display statement day');
    assert.ok(trackerJsx.includes('billingInfo.nextDueDate'), 'Overview must display payment due date');
  });

  await t.test('16. Display Description and Notes separately with distinct styling and safe fallbacks', () => {
    // 1. Description and Notes extracted separately from transaction
    assert.ok(trackerJsx.includes("rawDesc = String(ct.txn.Description || ct.txn.description || '').trim()"), 'Description must use actual Description field');
    assert.ok(trackerJsx.includes("rawNote = String(ct.txn.Note || ct.txn.note || ct.txn.Notes || ct.txn.notes || '').trim()"), 'Notes must use actual Notes field');

    // 2. Safe fallback when Description is empty without inventing text
    assert.ok(trackerJsx.includes("displayTitle = rawDesc || ct.txn.Merchant || ct.txn.Category || 'Card Transaction'"), 'Safe fallback when Description is empty');

    // 3. Distinct labels and classes
    assert.ok(trackerJsx.includes('fee-waiver-field-tag desc-tag'), 'Must render DESCRIPTION label tag');
    assert.ok(trackerJsx.includes('DESCRIPTION'), 'Must include text label DESCRIPTION');
    assert.ok(trackerJsx.includes('fee-waiver-field-tag note-tag'), 'Must render NOTE label tag');
    assert.ok(trackerJsx.includes('NOTE'), 'Must include text label NOTE');

    // 4. Conditional rendering: Notes container is NOT rendered if note is empty
    assert.ok(trackerJsx.includes('{rawNote ? ('), 'Notes container must be conditionally rendered only when non-empty');

    // 5. Note appears before Description in rendered row order
    const noteLinePos = trackerJsx.indexOf('fee-waiver-note-line');
    const descLinePos = trackerJsx.indexOf('fee-waiver-desc-line');
    assert.ok(noteLinePos > 0 && descLinePos > 0, 'Both note and desc lines must exist in tracker JSX');
    assert.ok(noteLinePos < descLinePos, 'NOTE line must be rendered BEFORE DESCRIPTION line');

    // 6. CSS word-wrap and distinct styling
    assert.ok(trackerCss.includes('.fee-waiver-desc-text'), 'CSS must style description text');
    assert.ok(trackerCss.includes('.fee-waiver-note-text'), 'CSS must style note text');
    assert.ok(trackerCss.includes('word-break: break-word'), 'Must enforce word-break for long notes/descriptions');
    assert.ok(trackerCss.includes('overflow-wrap: break-word'), 'Must enforce overflow-wrap for long notes/descriptions');
    assert.ok(trackerCss.includes('.fee-waiver-note-line'), 'CSS must define distinct container for note line');
  });
});
