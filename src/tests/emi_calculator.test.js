import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  calculateReducingBalanceEmi,
  calculateDueDate,
  formatDisplayDate,
  formatEmiCurrency,
  DEFAULT_EMI_INPUTS,
} from '../utils/emiCalculator.js';
import {
  generateEmiSummaryText,
  generateEmiReportCanvas,
  copyTextToClipboard,
  copyOrDownloadReportImage,
} from '../utils/emiShareReport.js';
import {
  generateEmiId,
  formatSavedDate,
  validateCalculationName,
  normalizeSavedRecord,
  saveEmiCalculation,
  loadSavedEmiCalculations,
  updateSavedEmiCalculation,
  deleteSavedEmiCalculation,
  SETTINGS_KEY_SAVED_EMI,
} from '../utils/emiStorage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

describe('EMI Calculator Engine & UX Enhancements', () => {
  it('1. Reference calculation verification matches exact user specification', () => {
    // Reference scenario test fixture:
    // Principal: ₹26,209.00
    // Rate: 15.99% p.a.
    // Tenure: 6 months
    // GST on Interest: 18%
    // Processing fee: ₹299.00
    // Processing fee GST (18%): ₹53.82
    // Total Processing fee: ₹352.82
    // Monthly total: ₹27,667.24
    // Final Total: ₹28,020.06
    const result = calculateReducingBalanceEmi({
      principal: 26209,
      annualRate: 15.99,
      tenure: 6,
      tenureType: 'months',
      startDate: '2026-11-22',
      includeGstOnInterest: true,
      gstRateInterest: 18,
      processingFee: 299,
      gstRateProcessingFee: 18,
    });

    assert.equal(result.isValid, true);
    assert.equal(result.errors.length, 0);

    const { summary, schedule, totals } = result;

    // Principal: ₹26,209.00
    assert.equal(summary.principal, 26209);
    assert.equal(totals.principal.toFixed(2), '26209.00');

    // Interest: ₹1,235.80
    assert.equal(summary.totalInterest.toFixed(2), '1235.80');
    assert.equal(totals.interest.toFixed(2), '1235.80');

    // GST on Interest 18%: ₹222.44
    assert.equal(summary.totalGstInterest.toFixed(2), '222.44');
    assert.equal(totals.gstOnInterest.toFixed(2), '222.44');

    // Monthly total: ₹27,667.24 (26,209.00 + 1,235.80 + 222.44)
    const calculatedMonthlyTotal = Number(totals.principal.toFixed(2)) +
      Number(totals.interest.toFixed(2)) +
      Number(totals.gstOnInterest.toFixed(2));
    assert.equal(calculatedMonthlyTotal.toFixed(2), '27667.24');
    assert.equal(summary.totalRepayment.toFixed(2), '27667.24');

    // Processing Fee (Base): ₹299.00
    assert.equal(summary.processingFee, 299);
    assert.equal(summary.processingFee.toFixed(2), '299.00');

    // Processing Fee GST (18% exact): ₹53.82
    assert.equal(summary.processingFeeGst.toFixed(2), '53.82');

    // Total Processing Fee (Base + GST exact): ₹352.82
    assert.equal(summary.totalProcessingFee.toFixed(2), '352.82');

    // Final Total Amount (Repayment + Processing Fee exact): ₹28,020.06
    assert.equal(summary.finalTotalAmount.toFixed(2), '28020.06');

    // Verify schedule length
    assert.equal(schedule.length, 6);

    // Verify closing balance is strictly 0
    assert.equal(schedule[schedule.length - 1].closingBalance, 0);
  });

  it('2. Standard reducing-balance progression: interest declines, principal increases', () => {
    const result = calculateReducingBalanceEmi({
      principal: 100000,
      annualRate: 12,
      tenure: 12,
      tenureType: 'months',
      startDate: '2026-01-01',
      includeGstOnInterest: false,
    });

    assert.equal(result.isValid, true);
    const { schedule } = result;
    assert.equal(schedule.length, 12);

    for (let i = 0; i < schedule.length; i++) {
      const row = schedule[i];
      if (i > 0) {
        assert.ok(row.openingBalance < schedule[i - 1].openingBalance);
        assert.ok(row.interest < schedule[i - 1].interest, 'Interest must decline each month');
        assert.ok(row.principal > schedule[i - 1].principal, 'Principal must increase each month');
      }
    }

    assert.equal(schedule[11].closingBalance, 0);

    const sumPrincipal = schedule.reduce((acc, row) => acc + row.principal, 0);
    assert.equal(Math.round(sumPrincipal * 100) / 100, 100000);
  });

  it('3. Zero interest rate calculation (P / n)', () => {
    const result = calculateReducingBalanceEmi({
      principal: 60000,
      annualRate: 0,
      tenure: 6,
      tenureType: 'months',
      includeGstOnInterest: true,
      processingFee: 0,
    });

    assert.equal(result.isValid, true);
    const { summary, schedule } = result;

    assert.equal(summary.monthlyEmi, 10000);
    assert.equal(summary.totalInterest, 0);
    assert.equal(summary.totalGstInterest, 0);
    assert.equal(summary.totalRepayment, 60000);
    assert.equal(schedule.length, 6);

    for (const row of schedule) {
      assert.equal(row.principal, 10000);
      assert.equal(row.interest, 0);
      assert.equal(row.gstOnInterest, 0);
      assert.equal(row.totalCharged, 10000);
    }
    assert.equal(schedule[5].closingBalance, 0);
  });

  it('4. Tenure in Years conversion', () => {
    const result = calculateReducingBalanceEmi({
      principal: 500000,
      annualRate: 9,
      tenure: 3,
      tenureType: 'years',
    });

    assert.equal(result.isValid, true);
    assert.equal(result.summary.tenureMonths, 36);
    assert.equal(result.schedule.length, 36);
    assert.equal(result.schedule[35].closingBalance, 0);
    assert.equal(result.summary.totalPrincipal.toFixed(2), '500000.00');
  });

  it('5. 1-Month tenure edge case', () => {
    const result = calculateReducingBalanceEmi({
      principal: 10000,
      annualRate: 12,
      tenure: 1,
      tenureType: 'months',
    });

    assert.equal(result.isValid, true);
    assert.equal(result.schedule.length, 1);
    assert.equal(result.schedule[0].principal, 10000);
    assert.equal(result.schedule[0].interest, 100);
    assert.equal(result.schedule[0].closingBalance, 0);
  });

  it('6. Small and large principal scales', () => {
    const micro = calculateReducingBalanceEmi({
      principal: 500,
      annualRate: 10,
      tenure: 2,
      tenureType: 'months',
      processingFee: 0,
    });
    assert.equal(micro.isValid, true);
    assert.equal(micro.totals.principal.toFixed(2), '500.00');
    assert.equal(micro.schedule[1].closingBalance, 0);

    const large = calculateReducingBalanceEmi({
      principal: 10000000,
      annualRate: 8.5,
      tenure: 20,
      tenureType: 'years',
      processingFee: 5000,
      gstRateProcessingFee: 18,
    });
    assert.equal(large.isValid, true);
    assert.equal(large.summary.tenureMonths, 240);
    assert.equal(large.schedule.length, 240);
    assert.equal(large.schedule[239].closingBalance, 0);
    assert.equal(large.totals.principal.toFixed(2), '10000000.00');
  });

  it('7. Invalid inputs handling', () => {
    const invalidPrincipal = calculateReducingBalanceEmi({ principal: -500 });
    assert.equal(invalidPrincipal.isValid, false);
    assert.ok(invalidPrincipal.errors.some(e => e.includes('Principal')));

    const invalidRate = calculateReducingBalanceEmi({ principal: 1000, annualRate: -2 });
    assert.equal(invalidRate.isValid, false);
    assert.ok(invalidRate.errors.some(e => e.includes('rate')));

    const invalidTenure = calculateReducingBalanceEmi({ principal: 1000, tenure: 0 });
    assert.equal(invalidTenure.isValid, false);
    assert.ok(invalidTenure.errors.some(e => e.includes('Tenure')));
  });

  it('8. Due date calculation and month-end clamping', () => {
    assert.equal(calculateDueDate('2028-01-31', 0), '2028-01-31');
    assert.equal(calculateDueDate('2028-01-31', 1), '2028-02-29'); // Leap year 2028
    assert.equal(calculateDueDate('2028-01-31', 2), '2028-03-31');
    assert.equal(calculateDueDate('2028-01-31', 3), '2028-04-30');

    assert.equal(calculateDueDate('2026-01-31', 1), '2026-02-28');
    assert.equal(calculateDueDate('2026-05-31', 1), '2026-06-30');
    assert.equal(calculateDueDate('2026-11-15', 3), '2027-02-15');
  });

  it('9. GST toggle and custom GST rate', () => {
    const withGst = calculateReducingBalanceEmi({
      principal: 50000,
      annualRate: 15,
      tenure: 6,
      includeGstOnInterest: true,
      gstRateInterest: 18,
    });
    const withoutGst = calculateReducingBalanceEmi({
      principal: 50000,
      annualRate: 15,
      tenure: 6,
      includeGstOnInterest: false,
    });

    assert.ok(withGst.summary.totalGstInterest > 0);
    assert.equal(withoutGst.summary.totalGstInterest, 0);
    assert.ok(withGst.summary.totalRepayment > withoutGst.summary.totalRepayment);
    assert.equal(withGst.summary.totalInterest.toFixed(2), withoutGst.summary.totalInterest.toFixed(2));
  });

  it('10. Processing fee independence and exact two-decimal precision', () => {
    const feeCalculation = calculateReducingBalanceEmi({
      principal: 20000,
      annualRate: 12,
      tenure: 6,
      processingFee: 299,
      gstRateProcessingFee: 18,
    });

    // 299 * 0.18 = 53.82, total fee = 352.82
    assert.equal(feeCalculation.summary.processingFee, 299);
    assert.equal(feeCalculation.summary.processingFeeGst.toFixed(2), '53.82');
    assert.equal(feeCalculation.summary.totalProcessingFee.toFixed(2), '352.82');

    // One-time processing fee must NOT be added to any monthly schedule row
    const sumScheduleCharged = feeCalculation.schedule.reduce((acc, row) => acc + row.totalCharged, 0);
    assert.equal(sumScheduleCharged.toFixed(2), feeCalculation.summary.totalRepayment.toFixed(2));

    // Grand total includes repayment + processing fee exactly
    assert.equal(
      (feeCalculation.summary.totalRepayment + feeCalculation.summary.totalProcessingFee).toFixed(2),
      feeCalculation.summary.finalTotalAmount.toFixed(2)
    );
  });

  it('11. Currency and date formatters', () => {
    assert.equal(formatEmiCurrency(26209.5), '₹26,209.50');
    assert.equal(formatEmiCurrency(0), '₹0.00');
    assert.equal(formatDisplayDate('2026-11-22'), '22 Nov 2026');
  });

  it('12. Initial form clean defaults without demo values & empty state', () => {
    assert.equal(DEFAULT_EMI_INPUTS.principal, '', 'Principal must be empty initially');
    assert.equal(DEFAULT_EMI_INPUTS.annualRate, '', 'Annual rate must be empty initially');
    assert.equal(DEFAULT_EMI_INPUTS.tenure, '', 'Tenure must be empty initially');
    assert.equal(DEFAULT_EMI_INPUTS.tenureType, 'months', 'Default tenure unit is months');
    assert.equal(DEFAULT_EMI_INPUTS.includeGstOnInterest, true, 'GST on interest default is checked');
    assert.equal(DEFAULT_EMI_INPUTS.gstRateInterest, 18, 'Default interest GST is 18%');
    assert.equal(DEFAULT_EMI_INPUTS.processingFee, 299, 'Default processing fee is 299');
    assert.equal(DEFAULT_EMI_INPUTS.gstRateProcessingFee, 18, 'Default processing fee GST is 18%');

    const emiCompPath = path.join(projectRoot, 'src/components/Dashboard/EmiCalculator.jsx');
    const emiCode = fs.readFileSync(emiCompPath, 'utf8');

    assert.ok(emiCode.includes("const [calculationResult, setCalculationResult] = useState(null)"), 'Result must be null on load');
    assert.ok(emiCode.includes("const [hasCalculated, setHasCalculated] = useState(false)"), 'hasCalculated must be false on load');

    assert.ok(emiCode.includes('emi-empty-state'), 'Must render emi-empty-state when not calculated');
    assert.ok(emiCode.includes('Ready to Calculate Your Loan EMI'), 'Empty state must invite user to enter loan details');

    assert.ok(emiCode.includes("setPrincipal('')"), 'handleReset must clear principal');
    assert.ok(emiCode.includes("setAnnualRate('')"), 'handleReset must clear rate');
    assert.ok(emiCode.includes("setTenure('')"), 'handleReset must clear tenure');
  });

  it('13. Light and Dark mode contrast & BackButton visibility rules', () => {
    const emiCssPath = path.join(projectRoot, 'src/components/Dashboard/EmiCalculator.css');
    const emiCss = fs.readFileSync(emiCssPath, 'utf8');

    assert.ok(emiCss.includes('.emi-hdr .page-hdr-title'), 'Must define title styling in .emi-hdr');
    assert.ok(emiCss.includes('.emi-hdr .page-hdr-sub'), 'Must define subtitle styling in .emi-hdr');
    assert.ok(emiCss.includes('.emi-hdr .back-btn'), 'Must define back-btn styling in .emi-hdr');

    assert.ok(emiCss.includes('[data-theme="light"] .emi-hdr'), 'Must define light theme header');
    assert.ok(emiCss.includes('[data-theme="light"] .emi-hdr .page-hdr-title'), 'Must define light theme title contrast');
    assert.ok(emiCss.includes('[data-theme="light"] .emi-hdr .page-hdr-sub'), 'Must define light theme subtitle contrast');
    assert.ok(emiCss.includes('[data-theme="light"] .emi-hdr .back-btn'), 'Must define light theme BackButton contrast');
    assert.ok(emiCss.includes('[data-theme="light"] .emi-hdr .back-btn svg'), 'Must define light theme BackButton SVG stroke');
    assert.ok(emiCss.includes('[data-theme="light"] .emi-empty-state'), 'Must define light theme empty state');
  });

  it('14. Plain-text summary formatter with exact two-decimal precision (Copy Summary)', () => {
    const result = calculateReducingBalanceEmi({
      principal: 26209,
      annualRate: 15.99,
      tenure: 6,
      tenureType: 'months',
      startDate: '2026-11-22',
      includeGstOnInterest: true,
      gstRateInterest: 18,
      processingFee: 299,
      gstRateProcessingFee: 18,
    });

    const summaryText = generateEmiSummaryText(result);

    assert.ok(summaryText.includes('FINMAN — EMI CALCULATION SUMMARY'), 'Must have FINMAN heading');
    assert.ok(summaryText.includes('LOAN OVERVIEW'), 'Must have LOAN OVERVIEW section');
    assert.ok(summaryText.includes('REPAYMENT BREAKDOWN'), 'Must have REPAYMENT BREAKDOWN section');
    assert.ok(summaryText.includes('UPFRONT CHARGES'), 'Must have UPFRONT CHARGES section');
    assert.ok(summaryText.includes('MONTHLY REPAYMENT SCHEDULE'), 'Must have MONTHLY REPAYMENT SCHEDULE');

    // Exact two-decimal values verification
    assert.ok(summaryText.includes('₹26,209.00'), 'Must include principal ₹26,209.00');
    assert.ok(summaryText.includes('15.99% p.a.'), 'Must include annual interest rate');
    assert.ok(summaryText.includes('6 Months'), 'Must include tenure');
    assert.ok(summaryText.includes('₹4,574.13'), 'Must include base monthly EMI');
    assert.ok(summaryText.includes('₹1,235.80'), 'Must include total interest');
    assert.ok(summaryText.includes('₹222.44'), 'Must include GST on interest');
    assert.ok(summaryText.includes('₹27,667.24'), 'Must include repayment total');
    assert.ok(summaryText.includes('₹299.00'), 'Must include processing fee ₹299.00');
    assert.ok(summaryText.includes('₹53.82'), 'Must include exact processing fee GST ₹53.82');
    assert.ok(summaryText.includes('₹352.82'), 'Must include exact total processing fee ₹352.82');
    assert.ok(summaryText.includes('₹28,020.06'), 'Must include exact final total ₹28,020.06');

    // No whole-rupee rounding in summary output
    assert.ok(!summaryText.includes('₹353.00'), 'Must not round processing fee to ₹353.00');
    assert.ok(!summaryText.includes('₹28,020.24'), 'Must not use rounded ₹28,020.24');

    assert.ok(summaryText.includes('#    Due Date'), 'Must include table column headers');
    assert.ok(summaryText.includes('TOTAL'), 'Must include TOTAL summary line in table');
    assert.ok(summaryText.includes('Generated by FinMan'), 'Must include FinMan footer');

    assert.equal(generateEmiSummaryText(null), '');
    assert.equal(generateEmiSummaryText({}), '');
  });

  it('15. Sharing UI buttons and feedback in EmiCalculator', () => {
    const emiCompPath = path.join(projectRoot, 'src/components/Dashboard/EmiCalculator.jsx');
    const emiCode = fs.readFileSync(emiCompPath, 'utf8');

    assert.ok(emiCode.includes('Copy Summary'), 'Must have Copy Summary button');
    assert.ok(emiCode.includes('Copy as Image'), 'Must have Copy as Image button');
    assert.ok(emiCode.includes('handleCopySummary'), 'Must define handleCopySummary');
    assert.ok(emiCode.includes('handleCopyAsImage'), 'Must define handleCopyAsImage');

    assert.ok(emiCode.includes('emi-share-feedback'), 'Must render emi-share-feedback toast');
    assert.ok(emiCode.includes('Summary copied to clipboard!'), 'Must include summary copy success message');
    assert.ok(emiCode.includes('Report image copied to clipboard!'), 'Must include image copy success message');
  });

  it('16. Canvas report and clipboard fallback utilities', async () => {
    assert.equal(generateEmiReportCanvas(null), null);
    assert.equal(generateEmiReportCanvas({}), null);

    const res = await copyOrDownloadReportImage(null);
    assert.equal(res.success, false);
    assert.ok(res.error.includes('Canvas not supported'));

    const textRes = await copyTextToClipboard('');
    assert.equal(textRes, false);
  });

  it('17. Placeholder font-weight and muted color contrast styling', () => {
    const emiCssPath = path.join(projectRoot, 'src/components/Dashboard/EmiCalculator.css');
    const emiCss = fs.readFileSync(emiCssPath, 'utf8');

    // Verify placeholder font-weight is 400 (lighter than entered 600 weight)
    assert.ok(emiCss.includes('.emi-input::placeholder'), 'Must define .emi-input::placeholder');
    assert.ok(emiCss.includes('font-weight: 400'), 'Placeholder must use font-weight: 400');

    // Verify dark theme placeholder has muted color
    assert.ok(emiCss.includes('color: var(--text-muted, #8ea1b8)'), 'Dark theme placeholder must use muted text');

    // Verify light theme placeholder override
    assert.ok(emiCss.includes('[data-theme="light"] .emi-input::placeholder'), 'Must define light theme placeholder override');
    assert.ok(emiCss.includes('color: #94a3b8'), 'Light theme placeholder must use muted slate color');
  });

  it('18. Validate calculation name: required, trimmed, duplicate prevention', () => {
    // Empty and whitespace rejection
    const emptyRes = validateCalculationName('');
    assert.equal(emptyRes.isValid, false);
    assert.ok(emptyRes.error.includes('required'));

    const spacesRes = validateCalculationName('   ');
    assert.equal(spacesRes.isValid, false);
    assert.ok(spacesRes.error.includes('required'));

    // Trimming
    const trimmedRes = validateCalculationName('  HDFC Loan  ');
    assert.equal(trimmedRes.isValid, true);
    assert.equal(trimmedRes.trimmedName, 'HDFC Loan');

    // Case-insensitive duplicate detection
    const existing = [
      { id: 'rec_1', name: 'Car Loan' },
      { id: 'rec_2', name: 'HDFC Personal Loan' },
    ];

    const dupExact = validateCalculationName('Car Loan', existing);
    assert.equal(dupExact.isValid, false);
    assert.ok(dupExact.error.includes('already exists'));

    const dupCase = validateCalculationName('  hdfc personal loan  ', existing);
    assert.equal(dupCase.isValid, false);
    assert.ok(dupCase.error.includes('already exists'));

    // Allow unique name
    const validUnique = validateCalculationName('Home Renovation Loan', existing);
    assert.equal(validUnique.isValid, true);
    assert.equal(validUnique.trimmedName, 'Home Renovation Loan');

    // excludeId allows keeping the same name when updating record rec_1
    const updateSelf = validateCalculationName('Car Loan', existing, 'rec_1');
    assert.equal(updateSelf.isValid, true);

    // But excludeId rec_1 still rejects matching rec_2 name
    const updateOtherDup = validateCalculationName('HDFC Personal Loan', existing, 'rec_1');
    assert.equal(updateOtherDup.isValid, false);
  });

  it('19. Format saved timestamp helper', () => {
    const formatted = formatSavedDate('2026-11-22T10:15:00.000Z');
    assert.ok(formatted.startsWith('Saved on '));
    assert.ok(formatted.includes('Nov 2026'));

    assert.equal(formatSavedDate(null), '');
    assert.equal(formatSavedDate(''), '');
    assert.equal(formatSavedDate('invalid-date'), 'invalid-date');
  });

  it('20. Dynamic normalization of saved records', () => {
    const raw = {
      id: 'test_saved_1',
      name: 'Test Car Loan',
      inputs: {
        principal: 500000,
        annualRate: 8.5,
        tenure: 3,
        tenureType: 'years',
        includeGstOnInterest: true,
        gstRateInterest: 18,
        processingFee: 1500,
        gstRateProcessingFee: 18,
      },
    };

    const normalized = normalizeSavedRecord(raw);
    assert.equal(normalized.id, 'test_saved_1');
    assert.equal(normalized.name, 'Test Car Loan');
    assert.equal(normalized.calculationVersion, 1);
    assert.ok(normalized.createdAt);
    assert.ok(normalized.updatedAt);

    // Verifies dynamic recalculation results
    assert.equal(normalized.summary.principal, 500000);
    assert.equal(normalized.summary.tenureMonths, 36);
    assert.ok(normalized.summary.monthlyEmi > 0);
    assert.ok(normalized.summary.finalTotalAmount > 500000);
    assert.equal(normalized.schedule.length, 36);
    assert.equal(normalized.schedule[35].closingBalance, 0);

    // Null safety
    assert.equal(normalizeSavedRecord(null), null);
    assert.equal(normalizeSavedRecord('invalid'), null);
  });

  it('21. Persistent save, load, update, save as new, and delete lifecycle', async () => {
    // Setup in-memory mock storage for Node environment and silence fallback warnings
    const origWarn = console.warn;
    console.warn = () => {};
    const memoryStore = new Map();
    globalThis.localStorage = {
      getItem: (k) => memoryStore.get(k) || null,
      setItem: (k, v) => memoryStore.set(k, String(v)),
      removeItem: (k) => memoryStore.delete(k),
      clear: () => memoryStore.clear(),
    };

    // 1. Initial load should be empty
    const initialList = await loadSavedEmiCalculations();
    assert.equal(initialList.length, 0);

    // 2. Save calculation 1
    const save1 = await saveEmiCalculation({
      name: 'Personal Loan 1',
      inputs: {
        principal: 100000,
        annualRate: 12,
        tenure: 12,
        tenureType: 'months',
        includeGstOnInterest: true,
        gstRateInterest: 18,
        processingFee: 500,
        gstRateProcessingFee: 18,
      },
    });

    assert.equal(save1.success, true);
    assert.ok(save1.record.id);
    assert.equal(save1.record.name, 'Personal Loan 1');
    assert.equal(save1.record.summary.principal, 100000);

    const rec1Id = save1.record.id;

    // 3. Save duplicate name should fail
    const dupSave = await saveEmiCalculation({
      name: '  personal loan 1  ',
      inputs: { principal: 200000 },
    });
    assert.equal(dupSave.success, false);
    assert.ok(dupSave.error.includes('already exists'));

    // 4. Save calculation 2
    const save2 = await saveEmiCalculation({
      name: 'Car Loan',
      inputs: {
        principal: 600000,
        annualRate: 9,
        tenure: 5,
        tenureType: 'years',
        includeGstOnInterest: false,
        processingFee: 1000,
        gstRateProcessingFee: 18,
      },
    });
    assert.equal(save2.success, true);
    const rec2Id = save2.record.id;

    // 5. Load list: should contain both records sorted newest first
    const listAfterSave = await loadSavedEmiCalculations();
    assert.equal(listAfterSave.length, 2);
    assert.equal(listAfterSave[0].id, rec2Id);
    assert.equal(listAfterSave[1].id, rec1Id);

    // 6. Update calculation 1 (Save Changes)
    const update1 = await updateSavedEmiCalculation(rec1Id, {
      name: 'Personal Loan Renamed',
      inputs: {
        principal: 150000,
        annualRate: 11,
        tenure: 18,
        tenureType: 'months',
        includeGstOnInterest: true,
        gstRateInterest: 18,
        processingFee: 750,
        gstRateProcessingFee: 18,
      },
    });

    assert.equal(update1.success, true);
    assert.equal(update1.record.id, rec1Id, 'ID must remain identical');
    assert.equal(update1.record.name, 'Personal Loan Renamed');
    assert.equal(update1.record.summary.principal, 150000);
    assert.equal(update1.record.summary.tenureMonths, 18);

    // 7. Save as New: create independent record using updated parameters
    const saveAsNew = await saveEmiCalculation({
      name: 'Personal Loan Renamed (Copy)',
      inputs: update1.record.inputs,
    });
    assert.equal(saveAsNew.success, true);
    assert.notEqual(saveAsNew.record.id, rec1Id, 'New record must have distinct ID');

    const listWithCopy = await loadSavedEmiCalculations();
    assert.equal(listWithCopy.length, 3);

    // 8. Delete calculation 2 (Car Loan)
    const delRes = await deleteSavedEmiCalculation(rec2Id);
    assert.equal(delRes.success, true);

    const finalList = await loadSavedEmiCalculations();
    assert.equal(finalList.length, 2);
    assert.ok(!finalList.some(r => r.id === rec2Id), 'Deleted record must be removed');
    assert.ok(finalList.some(r => r.id === rec1Id), 'Remaining record must be preserved');

    // Restore console.warn
    console.warn = origWarn;
  });

  it('22. EmiCalculator UI: Saved Calculations list, empty state, badges, and card actions', () => {
    const emiCompPath = path.join(projectRoot, 'src/components/Dashboard/EmiCalculator.jsx');
    const emiCode = fs.readFileSync(emiCompPath, 'utf8');

    // Section header & count badge
    assert.ok(emiCode.includes('Saved EMI Calculations'), 'Must display "Saved EMI Calculations" section title');
    assert.ok(emiCode.includes('emi-saved-count-badge'), 'Must render saved count badge');

    // Empty state message
    assert.ok(
      emiCode.includes('No saved EMI calculations yet. Calculate a loan and save it to access it later.'),
      'Must render empty state message when list is empty'
    );

    // Card metrics display
    assert.ok(emiCode.includes('Principal'), 'Must display Principal metric');
    assert.ok(emiCode.includes('Rate &amp; Tenure'), 'Must display Rate & Tenure metric');
    assert.ok(emiCode.includes('Base EMI'), 'Must display Base EMI metric');
    assert.ok(emiCode.includes('Final Total'), 'Must display Final Total metric');

    // Action buttons
    assert.ok(emiCode.includes('emi-saved-btn-edit'), 'Must render Edit action button');
    assert.ok(emiCode.includes('emi-saved-btn-delete'), 'Must render Delete action button');
    assert.ok(emiCode.includes('handleEditSavedItem'), 'Must bind handleEditSavedItem');
    assert.ok(emiCode.includes('promptDelete'), 'Must bind promptDelete');
  });

  it('23. EmiCalculator UI: Edit mode workflow, unsaved changes banner, Cancel Edit, Save Changes, and Save as New', () => {
    const emiCompPath = path.join(projectRoot, 'src/components/Dashboard/EmiCalculator.jsx');
    const emiCode = fs.readFileSync(emiCompPath, 'utf8');

    // Edit mode banner & cancellation
    assert.ok(emiCode.includes('emi-edit-mode-banner'), 'Must render active edit mode banner');
    assert.ok(emiCode.includes('Cancel Edit'), 'Must render Cancel Edit button');
    assert.ok(emiCode.includes('handleCancelEditing'), 'Must define handleCancelEditing');

    // Unsaved changes detection
    assert.ok(emiCode.includes('emi-unsaved-badge'), 'Must render unsaved changes badge');
    assert.ok(emiCode.includes('hasUnsavedChanges'), 'Must compute hasUnsavedChanges');

    // Save action variants
    assert.ok(emiCode.includes('Save Calculation'), 'Must have Save Calculation button');
    assert.ok(emiCode.includes('Save Changes'), 'Must have Save Changes button when editing');
    assert.ok(emiCode.includes('Save as New'), 'Must have Save as New button when editing');
    assert.ok(emiCode.includes('handleDirectSaveChanges'), 'Must define handleDirectSaveChanges');
  });

  it('24. EmiCalculator UI: Save/Update Modal and Delete Confirmation Modal', () => {
    const emiCompPath = path.join(projectRoot, 'src/components/Dashboard/EmiCalculator.jsx');
    const emiCode = fs.readFileSync(emiCompPath, 'utf8');

    // Save modal title variants
    assert.ok(emiCode.includes("isSaveAsNew ? 'Save as New Calculation' : (editingId ? 'Update Calculation' : 'Save EMI Calculation')"));
    assert.ok(emiCode.includes('emi-modal-preview'), 'Must render calculation quick preview inside save modal');
    assert.ok(emiCode.includes('emi-modal-field-error'), 'Must render field error for duplicate/empty name in modal');

    // Delete confirmation modal
    assert.ok(emiCode.includes('Delete Saved Calculation?'), 'Must have delete modal title');
    assert.ok(emiCode.includes('Are you sure you want to delete'), 'Must ask for explicit confirmation');
    assert.ok(emiCode.includes('This action cannot be undone.'), 'Must warn action cannot be undone');
    assert.ok(emiCode.includes('handleConfirmDelete'), 'Must define handleConfirmDelete');
  });

  it('25. Saved calculations CSS styling and theme contrast rules', () => {
    const emiCssPath = path.join(projectRoot, 'src/components/Dashboard/EmiCalculator.css');
    const emiCss = fs.readFileSync(emiCssPath, 'utf8');

    // Saved calculations list styling
    assert.ok(emiCss.includes('.emi-saved-section'), 'Must style .emi-saved-section');
    assert.ok(emiCss.includes('.emi-saved-grid'), 'Must style .emi-saved-grid');
    assert.ok(emiCss.includes('.emi-saved-card'), 'Must style .emi-saved-card');
    assert.ok(emiCss.includes('.emi-saved-metric'), 'Must style .emi-saved-metric');
    assert.ok(emiCss.includes('.emi-saved-btn-edit'), 'Must style .emi-saved-btn-edit');
    assert.ok(emiCss.includes('.emi-saved-btn-delete'), 'Must style .emi-saved-btn-delete');

    // Edit mode banner & modal dialog
    assert.ok(emiCss.includes('.emi-edit-mode-banner'), 'Must style .emi-edit-mode-banner');
    assert.ok(emiCss.includes('.emi-unsaved-badge'), 'Must style .emi-unsaved-badge');
    assert.ok(emiCss.includes('.emi-modal-dialog'), 'Must style .emi-modal-dialog');
    assert.ok(emiCss.includes('.emi-modal-preview'), 'Must style .emi-modal-preview');

    // Theme contrast rules for Light Mode
    assert.ok(emiCss.includes('[data-theme="light"] .emi-saved-section'), 'Must define light theme for saved section');
    assert.ok(emiCss.includes('[data-theme="light"] .emi-saved-card'), 'Must define light theme for saved card');
    assert.ok(emiCss.includes('[data-theme="light"] .emi-edit-mode-banner'), 'Must define light theme for edit mode banner');
    assert.ok(emiCss.includes('[data-theme="light"] .emi-modal-dialog'), 'Must define light theme for modal dialog');
  });
});
