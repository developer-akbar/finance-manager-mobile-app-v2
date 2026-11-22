/**
 * FinMan EMI Calculator Engine
 *
 * Dedicated, pure JavaScript reducing-balance loan and EMI calculation engine.
 * Supports:
 * - Reducing balance method with financial paise-accurate precision
 * - Configurable tenure in Months or Years
 * - Exact date calculation with month-end date clamping (e.g., Jan 31 -> Feb 28)
 * - Zero-interest handling (P / n)
 * - Final installment balance adjustment ensuring closing balance is strictly 0.00
 * - GST on monthly interest (optional toggle, default 18%)
 * - Upfront one-time processing fee and processing fee GST (separated from monthly repayment schedule)
 * - Horizontal and vertical table reconciliation (Principal + Interest + GST = Total Charged)
 */

import { formatINR } from './format.js';

/**
 * Rounds a number to 2 decimal places (paise/cents).
 *
 * @param {number|string} val
 * @returns {number}
 */
export function round2(val) {
  return Math.round((Number(val) || 0) * 100) / 100;
}

/**
 * Calculates installment due date given a start date and month offset.
 * Correctly preserves day of month or clamps to last day of target month
 * (e.g., Jan 31 + 1 month -> Feb 28/29, Jan 31 + 2 months -> Mar 31).
 *
 * @param {string|Date} startDate - Start date (YYYY-MM-DD or Date object)
 * @param {number} monthOffset - Number of months to advance (0 for first installment)
 * @returns {string} - Formatted ISO date string (YYYY-MM-DD)
 */
export function calculateDueDate(startDate, monthOffset = 0) {
  if (!startDate) {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    startDate = `${y}-${m}-${d}`;
  }

  let baseYear, baseMonth, baseDay;

  if (typeof startDate === 'string') {
    const parts = startDate.split('T')[0].split('-');
    if (parts.length >= 3) {
      baseYear = parseInt(parts[0], 10);
      baseMonth = parseInt(parts[1], 10) - 1; // 0-indexed
      baseDay = parseInt(parts[2], 10);
    } else {
      const d = new Date(startDate);
      baseYear = d.getFullYear();
      baseMonth = d.getMonth();
      baseDay = d.getDate();
    }
  } else if (startDate instanceof Date) {
    baseYear = startDate.getFullYear();
    baseMonth = startDate.getMonth();
    baseDay = startDate.getDate();
  } else {
    const d = new Date();
    baseYear = d.getFullYear();
    baseMonth = d.getMonth();
    baseDay = d.getDate();
  }

  const totalMonth = baseMonth + monthOffset;
  const targetYear = baseYear + Math.floor(totalMonth / 12);
  const targetMonth = ((totalMonth % 12) + 12) % 12;

  // Maximum days in target month
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const clampedDay = Math.min(baseDay, daysInTargetMonth);

  const mm = String(targetMonth + 1).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');
  return `${targetYear}-${mm}-${dd}`;
}

/**
 * Format date string into a user-friendly format (e.g., "22 Nov 2026").
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string}
 */
export function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  try {
    const [y, m, d] = dateStr.split('-');
    const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Standard default values for the EMI Calculator.
 */
export const DEFAULT_EMI_INPUTS = {
  principal: '',
  annualRate: '',
  tenure: '',
  tenureType: 'months', // 'months' | 'years'
  startDate: '', // Defaults to today's date if empty
  includeGstOnInterest: true,
  gstRateInterest: 18,
  processingFee: 299,
  gstRateProcessingFee: 18,
};

/**
 * Calculate reducing balance EMI and generate full repayment schedule.
 *
 * @param {Object} options
 * @param {number|string} options.principal - Loan principal in INR
 * @param {number|string} options.annualRate - Annual interest rate % (e.g. 15.99)
 * @param {number|string} options.tenure - Loan tenure
 * @param {string} [options.tenureType='months'] - 'months' or 'years'
 * @param {string|Date} [options.startDate] - First installment date (YYYY-MM-DD)
 * @param {boolean} [options.includeGstOnInterest=true] - Whether to apply GST on monthly interest
 * @param {number|string} [options.gstRateInterest=18] - GST rate on interest %
 * @param {number|string} [options.processingFee=299] - One-time upfront fee
 * @param {number|string} [options.gstRateProcessingFee=18] - GST rate on processing fee %
 * @param {boolean} [options.roundProcessingFee=false] - Whether to round processing fee incl GST to nearest rupee
 * @returns {Object} { isValid, errors, summary, schedule, totals }
 */
export function calculateReducingBalanceEmi(options = {}) {
  const opts = { ...DEFAULT_EMI_INPUTS, ...options };

  const errors = [];
  const principal = Number(opts.principal);
  const annualRate = Number(opts.annualRate);
  const rawTenure = Number(opts.tenure);
  const tenureType = opts.tenureType === 'years' ? 'years' : 'months';

  if (isNaN(principal) || principal <= 0) {
    errors.push('Principal amount must be greater than zero.');
  }

  if (isNaN(annualRate) || annualRate < 0) {
    errors.push('Annual interest rate cannot be negative.');
  }

  if (isNaN(rawTenure) || rawTenure <= 0) {
    errors.push('Tenure must be greater than zero.');
  }

  const tenureMonths = tenureType === 'years' ? Math.round(rawTenure * 12) : Math.round(rawTenure);

  if (tenureMonths <= 0 || tenureMonths > 600) {
    errors.push('Tenure must resolve between 1 and 600 months.');
  }

  if (errors.length > 0) {
    return {
      isValid: false,
      errors,
      summary: null,
      schedule: [],
      totals: null,
    };
  }

  // Monthly interest rate
  const monthlyRate = annualRate > 0 ? (annualRate / 100) / 12 : 0;

  // Base monthly EMI calculation
  let baseEmi;
  if (monthlyRate === 0) {
    baseEmi = principal / tenureMonths;
  } else {
    const factor = Math.pow(1 + monthlyRate, tenureMonths);
    baseEmi = (principal * monthlyRate * factor) / (factor - 1);
  }

  const includeGst = Boolean(opts.includeGstOnInterest);
  const gstRateInt = Math.max(0, Number(opts.gstRateInterest) || 0);

  // Generate monthly schedule with financial paise precision
  let balance = principal;
  let totalInterest = 0;
  let totalPrincipal = 0;
  let totalGstInterest = 0;
  const schedule = [];

  const startDateStr = opts.startDate || calculateDueDate(new Date(), 0);

  for (let month = 1; month <= tenureMonths; month++) {
    const openingBalance = balance;
    const interest = monthlyRate === 0 ? 0 : round2(openingBalance * monthlyRate);

    let principalComponent;
    if (month === tenureMonths) {
      // In final installment, absorb penny rounding so closing balance is strictly 0.00
      principalComponent = openingBalance;
      balance = 0;
    } else {
      principalComponent = round2(baseEmi - interest);
      balance = round2(Math.max(0, openingBalance - principalComponent));
    }

    const gstOnInterest = includeGst ? round2(interest * (gstRateInt / 100)) : 0;
    const totalCharged = round2(principalComponent + interest + gstOnInterest);

    totalPrincipal = round2(totalPrincipal + principalComponent);
    totalInterest = round2(totalInterest + interest);
    totalGstInterest = round2(totalGstInterest + gstOnInterest);

    const dueDate = calculateDueDate(startDateStr, month - 1);

    schedule.push({
      month,
      dueDate,
      formattedDueDate: formatDisplayDate(dueDate),
      openingBalance,
      principal: principalComponent,
      interest,
      gstOnInterest,
      totalCharged,
      closingBalance: balance,
    });
  }

  // Processing fee calculations (one-time upfront fee, separate from schedule)
  const baseProcessingFee = round2(Math.max(0, Number(opts.processingFee) || 0));
  const feeGstRate = Math.max(0, Number(opts.gstRateProcessingFee) || 0);
  const processingFeeGst = round2(baseProcessingFee * (feeGstRate / 100));
  const totalProcessingFee = round2(baseProcessingFee + processingFeeGst);

  const totalRepayment = round2(totalPrincipal + totalInterest + totalGstInterest);
  const finalTotalAmount = round2(totalRepayment + totalProcessingFee);

  const tenureDisplay = tenureType === 'years'
    ? `${rawTenure} ${rawTenure === 1 ? 'Year' : 'Years'} (${tenureMonths} Months)`
    : `${tenureMonths} ${tenureMonths === 1 ? 'Month' : 'Months'}`;

  const summary = {
    principal,
    annualRate,
    tenureMonths,
    tenureDisplay,
    monthlyEmi: baseEmi,
    totalPrincipal,
    totalInterest,
    totalGstInterest,
    totalRepayment,
    processingFee: baseProcessingFee,
    gstRateProcessingFee: feeGstRate,
    processingFeeGst,
    totalProcessingFee,
    finalTotalAmount,
    includeGstOnInterest: includeGst,
    gstRateInterest: gstRateInt,
  };

  const totals = {
    principal: totalPrincipal,
    interest: totalInterest,
    gstOnInterest: totalGstInterest,
    totalCharged: totalRepayment,
  };

  return {
    isValid: true,
    errors: [],
    summary,
    schedule,
    totals,
  };
}

/**
 * Format currency amount for display in EMI calculator UI.
 */
export function formatEmiCurrency(amount, decimals = 2) {
  if (amount === null || amount === undefined || isNaN(amount)) return '₹0.00';
  return formatINR(amount, decimals);
}
