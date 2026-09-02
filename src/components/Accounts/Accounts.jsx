import React, { useState, useMemo, useEffect } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseDate, formatINR, formatINRCompact, calcTotals, txnType, txnAmount, currentFY, fyLabel, fyStart, fyEnd } from '../../utils/format.js';
import TransactionItem from '../Transactions/TransactionItem.jsx';
import AddTransaction from '../Transactions/AddTransaction.jsx';
import DebtTracker from './DebtTracker.jsx';
import CardOptimizer from './CardOptimizer.jsx';
import GroupSplitManager from '../Groups/GroupSplitManager.jsx';
import StockManager from './StockManager.jsx';
import InvestmentsPortfolio from './InvestmentsPortfolio.jsx';
import { BulkSelectionBar } from '../Transactions/Transactions.jsx';
import useSwipe from '../../hooks/useSwipe.js';
import { activeHoldingsData } from '../../database/holdingsData.js';
import './Accounts.css';

const MS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Credit Card helpers ───────────────────────────────────────────────────────
/** Returns { start, end } Date objects for the billing cycle that contains `refDate`.
 *  settlementDate = day the billing period CLOSES (e.g. 18).
 *  Cycle: [settlementDate of prev month+1 .. settlementDate of this/next month]
 *  e.g. settlement=18, today=19 Mar → cycle 18 Mar – 17 Apr
 *       settlement=18, today=10 Mar → cycle 18 Feb – 17 Mar  */
export function ccCycleForDate(settlementDate, refDate = new Date()) {
  const sd = settlementDate;
  const cy = refDate.getFullYear();
  const cm = refDate.getMonth();
  const cd = refDate.getDate();
  let cycleStart, cycleEnd;
  if (cd >= sd) {
    cycleStart = new Date(cy, cm, sd);
    cycleEnd = new Date(cy, cm + 1, sd - 1);
  } else {
    cycleStart = new Date(cy, cm - 1, sd);
    cycleEnd = new Date(cy, cm, sd - 1);
  }
  cycleEnd.setHours(23, 59, 59, 999);
  return { start: cycleStart, end: cycleEnd };
}

/** Previous billing cycle (the one whose bill is now payable). */
export function ccPrevCycle(settlementDate, refDate = new Date()) {
  const { start } = ccCycleForDate(settlementDate, refDate);
  // prevEnd = day before current cycle starts
  const prevEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  prevEnd.setHours(23, 59, 59, 999);
  // prevStart = exactly one month before current cycle start
  const prevStart = new Date(start);
  prevStart.setMonth(prevStart.getMonth() - 1);
  return { start: prevStart, end: prevEnd };
}

/** Sum of expenses (+ transfer-outs) for an account within a date range. */
/**
 * Core CC balance calculator — bank-statement model.
 *
 * Returns:
 *   balancePayable  — what you owe on closed/billed cycles (after all payments)
 *   outstanding     — net charges accumulating in the current open cycle
 *
 * Rules:
 *  • Charges (Expense or Transfer-Out FROM card) before currCycleStart
 *      → add to grossPayable
 *  • Charges in currCycleStart..today
 *      → add to grossOutstanding
 *  • Payments (Income TO card, or Transfer-Out FROM another account TO card)
 *      → always reduce balancePayable first; overflow reduces outstanding
 *
 * Sign convention returned: positive = you owe / you've spent (shown as −)
 */
export function ccBalances(txns, acctName, settlementDate, today = new Date()) {
  // Determine start of current (open) cycle
  const sd = settlementDate;
  const cy = today.getFullYear(), cm = today.getMonth(), cd = today.getDate();
  let currStart;
  if (cd >= sd) currStart = new Date(cy, cm, sd);
  else currStart = new Date(cy, cm - 1, sd);
  currStart.setHours(0, 0, 0, 0);

  let grossPayable = 0; // charges in all closed cycles
  let grossOutstanding = 0; // charges in current open cycle
  let totalPayments = 0; // all payments ever made to this card

  for (const t of txns) {
    const d = parseDate(t.Date);
    const amt = txnAmount(t);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || t.FromAccount || '').trim();
    const dest = String(t.ToAccount || '').trim();

    const isCharge = (type === 'Expense' && acct === acctName)
      || (type === 'Transfer-Out' && acct === acctName);
    // Payment = money going INTO the card account (Income credited, or bank→card transfer)
    const isPayment = (type === 'Income' && acct === acctName)
      || (type === 'Transfer-Out' && dest === acctName);

    if (isCharge) {
      if (d < currStart) grossPayable += amt;
      else grossOutstanding += amt;
    }
    if (isPayment) totalPayments += amt;
  }

  // Apply payments: reduce payable first, overflow spills into outstanding
  const netPayable = Math.max(0, grossPayable - totalPayments);
  const overpayment = Math.max(0, totalPayments - grossPayable);
  // netOutstanding: positive = you owe on current cycle, negative = credit balance (overpaid)
  const netOutstanding = grossOutstanding - overpayment;

  return { balancePayable: netPayable, outstanding: netOutstanding };
}

/** Is this account a credit card? */
export function isCreditCard(acct) {
  if (!acct) return false;
  // Explicit type always wins — empty string means explicitly set to Regular
  if (acct.acctType === 'Credit Card') return true;
  if (acct.acctType === '') return false;          // explicitly Regular, never override
  // acctType undefined/null = old account created before this feature: fall back to name
  // Only match 'credit' — never 'card' alone (debit cards, food cards, prepaid cards etc.)
  return /\bcredit\b/i.test(acct.name || '');
}

/**
 * Returns the next payment due date for a CC account, or null if not configured.
 * Due date = paymentDueDays days after the last settlement date.
 */
export function ccNextDueDate(acct, today = new Date()) {
  if (!acct || !acct.settlementDate || !acct.paymentDueDays) return null;
  const sd = acct.settlementDate, pd = acct.paymentDueDays;
  const cy = today.getFullYear(), cm = today.getMonth(), cd = today.getDate();
  // Last settlement date (the one that has already passed or is today)
  let lastSettlement;
  if (cd >= sd) lastSettlement = new Date(cy, cm, sd);
  else lastSettlement = new Date(cy, cm - 1, sd);
  const due = new Date(lastSettlement);
  due.setDate(due.getDate() + pd);
  // If due date already passed this cycle, it means next due is next month's
  if (due < today) {
    const nextSettlement = new Date(cy, cm, sd); // this month's settlement (if cd < sd, this is future)
    if (cd < sd) {
      // settlement is still upcoming — last settlement was previous month, already computed
      // due would be from that, already in the past → next due = next month settlement + pd
    }
    const ns2 = new Date(lastSettlement);
    ns2.setMonth(ns2.getMonth() + 1);
    const due2 = new Date(ns2);
    due2.setDate(due2.getDate() + pd);
    return due2;
  }
  return due;
}

/**
 * Returns days until due (negative = overdue). null if no due date configured.
 */
export function ccDaysUntilDue(acct, today = new Date()) {
  const due = ccNextDueDate(acct, today);
  if (!due) return null;
  const diff = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
  return diff;
}

const MS_F = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PERIODS = ['Month', 'Year', 'FY', 'All', 'Custom', 'CC Cycle'];

/**
 * Compute running balance for a named account from a list of transactions.
 * Rules (matching legacy logic exactly):
 *   Income     → account += INR
 *   Expense    → account -= INR
 *   Transfer-Out → fromAccount -= INR; toAccount (= ToAccount || Category) += INR
 *   Transfer-In  → toAccount += INR (credit side)
 */
function computeBalance(txns, acctName) {
  let bal = 0;
  for (const t of txns) {
    const amt = txnAmount(t);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = t.Account || t.FromAccount || '';
    const dest = t.ToAccount || '';

    if (type === 'Income') { if (acct === acctName) bal += amt; }
    else if (type === 'Expense') { if (acct === acctName) bal -= amt; }
    else if (type === 'Transfer-Out') {
      if (acct === acctName) bal -= amt;
      if (dest === acctName) bal += amt;
    }
    // Transfer-In: skip
  }
  return bal;
}

// Build a full balance map over ALL transactions.
// Skips numeric-looking keys that arise from legacy Transfer-Out rows where
// the Account column held the INR amount rather than a real account name.
function buildBalanceMap(transactions) {
  const map = {};
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
  const ensure = n => { if (n && !looksNumeric(n) && !map[n]) map[n] = 0; };
  const addTo = (n, v) => { if (n && !looksNumeric(n)) { ensure(n); map[n] = (map[n] || 0) + v; } };

  for (const t of transactions) {
    const amt = txnAmount(t);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();

    if (type === 'Income') {
      addTo(dest || acct, +amt);
    } else if (type === 'Expense') {
      addTo(fromAcct || acct, -amt);
    } else if (type === 'Transfer-Out') {
      addTo(fromAcct, -amt);
      addTo(dest, +amt);
    }
    // Transfer-In: skip — Transfer-Out handles both sides
  }
  return map;
}

// Build a sub-account balance map over ALL transactions.
function buildSubAccountBalanceMap(transactions) {
  const map = {};
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());

  for (const t of transactions) {
    const amt = txnAmount(t);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();

    const sub = String(t.SubAccount || t.sub_account || '').trim();
    const fromSub = String(t.FromSubAccount || t.from_sub_account || '').trim();
    const toSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

    if (type === 'Income') {
      const targetAcct = dest || acct;
      const targetSub = toSub || sub;
      if (targetAcct && targetSub && !looksNumeric(targetAcct)) {
        if (!map[targetAcct]) map[targetAcct] = {};
        map[targetAcct][targetSub] = (map[targetAcct][targetSub] || 0) + amt;
      }
    } else if (type === 'Expense') {
      const targetAcct = fromAcct || acct;
      const targetSub = fromSub || sub;
      if (targetAcct && targetSub && !looksNumeric(targetAcct)) {
        if (!map[targetAcct]) map[targetAcct] = {};
        map[targetAcct][targetSub] = (map[targetAcct][targetSub] || 0) - amt;
      }
    } else if (type === 'Transfer-Out') {
      if (fromAcct && fromSub && !looksNumeric(fromAcct)) {
        if (!map[fromAcct]) map[fromAcct] = {};
        map[fromAcct][fromSub] = (map[fromAcct][fromSub] || 0) - amt;
      }
      if (dest && toSub && !looksNumeric(dest)) {
        if (!map[dest]) map[dest] = {};
        map[dest][toSub] = (map[dest][toSub] || 0) + amt;
      }
    }
  }
  return map;
}

import { calculateBrokerageState as calcBrokerState, parseTxnFields as parseFields } from '../../utils/brokerageAccounting.js';

export const parseTxnFields = parseFields;
export const calculateShareMarketBalances = (txns, brokerConfigList = [], settings = {}) => {
  return calcBrokerState(txns, brokerConfigList, settings);
};


// Helper to resolve platform and parent for investment transactions
export function resolveInvestmentPlatform(txn) {
  if (!txn) return null;
  const f = parseTxnFields(txn);
  const broker = String(f?.brokerage || txn.Brokerage || txn.brokerage || txn.SubAccount || txn.sub_account || '').trim();
  if (broker) return broker;
  const src = String(txn.Source || txn.source || '').trim();
  if (src.includes('CAS') || src.includes('CAMS')) return 'Ak ETMoney';
  return null;
}

export function resolveInvestmentParent(txn) {
  if (!txn) return null;
  const acct = String(txn.Account || txn.account || '').trim();
  const fromAcct = String(txn.FromAccount || txn.from_account || '').trim();
  const toAcct = String(txn.ToAccount || txn.to_account || '').trim();
  const cat = String(txn.Category || txn.category || '').trim();

  if (toAcct === 'Mutual Funds Tax Saver' || acct === 'Mutual Funds Tax Saver' || fromAcct === 'Mutual Funds Tax Saver' || cat === 'Mutual Funds Tax Saver') {
    return 'Mutual Funds Tax Saver';
  }
  if (toAcct === 'Liquid Mutual Funds' || acct === 'Liquid Mutual Funds' || fromAcct === 'Liquid Mutual Funds' || cat === 'Liquid Mutual Funds') {
    return 'Liquid Mutual Funds';
  }
  if (toAcct === 'Share Market' || acct === 'Share Market' || fromAcct === 'Share Market' || cat === 'Share Market' || cat === 'Equity') {
    return 'Share Market';
  }
  return null;
}

export function isInvestmentTransactionForSubAccount(txn, parentAsset, subAccount) {
  if (!txn || !parentAsset || !subAccount) return false;
  const f = parseTxnFields(txn);
  const isInv = Boolean(
    f?.type ||
    txn.InvestmentTransactionType || txn.investment_transaction_type ||
    txn.Brokerage || txn.brokerage ||
    txn.SecurityISIN || txn.security_isin
  );
  if (!isInv) return false;

  const resolvedParent = resolveInvestmentParent(txn);
  if (resolvedParent !== parentAsset) return false;

  const resolvedPlatform = resolveInvestmentPlatform(txn);
  return resolvedPlatform === subAccount;
}

// ── Account Detail ────────────────────────────────────────────────────────────
function AccountDetail({ acctName, subAccountName, allTxns, onBack, backInterceptRef, ccConfig }) {
  const now = new Date();

  // If this is a CC account, default period to 'CC Cycle'; otherwise 'Month'
  const isCC = ccConfig && ccConfig.settlementDate > 0;
  const [period, setPeriod] = useState(isCC ? 'CC Cycle' : 'Month');
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [viewFY, setViewFY] = useState(currentFY());
  const [customFrom, setFrom] = useState('');
  const [customTo, setTo] = useState('');
  const [addDate, setAddDate] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [multiMode, setMultiMode] = useState(false);
  const [copyTxn, setCopyTxn] = useState(null);
  const [addKey, setAddKey] = useState(0);

  // For CC Cycle navigation: which cycle offset (0 = current, -1 = previous, etc.)
  const [ccCycleOffset, setCcCycleOffset] = useState(0);

  const addBackPrevRef = React.useRef(null);
  const multiModePrevHandler = React.useRef(null);
  const multiModeHandler = React.useRef(null);

  React.useEffect(() => {
    if (!backInterceptRef) return;
    const isOpen = Boolean(addDate) || showAdd;
    if (isOpen) {
      const handler = () => { setAddDate(null); setShowAdd(false); };
      addBackPrevRef.current = backInterceptRef.current;
      backInterceptRef.current = handler;
      return () => {
        if (backInterceptRef.current === handler) backInterceptRef.current = addBackPrevRef.current;
        addBackPrevRef.current = null;
      };
    }
    return undefined;
  }, [addDate, showAdd, backInterceptRef]);

  // Handle back button interception for multi-mode
  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (multiMode) {
      multiModePrevHandler.current = backInterceptRef.current;
      multiModeHandler.current = () => { setMultiMode(false); setSelected(new Set()); };
      backInterceptRef.current = multiModeHandler.current;
    } else {
      if (backInterceptRef.current === multiModeHandler.current) {
        backInterceptRef.current = multiModePrevHandler.current;
        multiModePrevHandler.current = null;
        multiModeHandler.current = null;
      }
    }
  }, [multiMode]);

  const handleCopy = (txn) => {
    // Pass txn as-is — the copy picker in DetailSheet sets date/time based on user choice.
    // DetailSheet's handleCopyWithToday will inject today's date; handleCopyWithOriginal uses t as-is.
    setCopyTxn({ ...txn, _id: undefined });
  };

  // When viewing an account, treat transfer rows as income/expense for that account.
  const isMFInvestmentSubAccount = Boolean((acctName === 'Mutual Funds Tax Saver' || acctName === 'Liquid Mutual Funds') && subAccountName);

  const accountTxnType = (t) => {
    const base = txnType(t);
    if (base !== 'transfer') return base;
    const acct = t.Account || t.FromAccount || '';
    const dest = t.ToAccount || '';
    if (acct === acctName) return 'expense';
    if (dest === acctName) return 'income';
    return 'transfer';
  };

  const acctTxns = useMemo(() =>
    allTxns.filter(t => {
      const acct = t.Account || t.FromAccount || '';
      const dest = t.ToAccount || '';
      const sub = t.SubAccount || t.sub_account || '';
      const fromSub = t.FromSubAccount || t.from_sub_account || t.SubAccount || t.sub_account || '';
      const toSub = t.ToSubAccount || t.to_sub_account || '';

      if (subAccountName) {
        if (isMFInvestmentSubAccount) {
          return isInvestmentTransactionForSubAccount(t, acctName, subAccountName);
        }

        const isXfer = t['Income/Expense'] === 'Transfer' || t['Income/Expense'] === 'Transfer-Out' || t['Income/Expense'] === 'Transfer-In';
        if (isXfer) {
          return (acct === acctName && fromSub === subAccountName) || (dest === acctName && toSub === subAccountName);
        } else {
          return acct === acctName && sub === subAccountName;
        }
      }
      return acct === acctName || dest === acctName;
    }), [allTxns, acctName, subAccountName, isMFInvestmentSubAccount]);

  // Compute current CC cycle range based on offset
  const ccCycleRange = useMemo(() => {
    if (!isCC) return null;
    const sd = ccConfig.settlementDate;
    // Shift reference date by ccCycleOffset months
    const ref = new Date(now.getFullYear(), now.getMonth() + ccCycleOffset, now.getDate());
    return ccCycleForDate(sd, ref);
  }, [isCC, ccConfig, ccCycleOffset]);

  const periodTxns = useMemo(() => {
    if (period === 'Month') return acctTxns.filter(t => { const d = parseDate(t.Date); return d.getFullYear() === viewYear && d.getMonth() === viewMonth; });
    if (period === 'Year') return acctTxns.filter(t => parseDate(t.Date).getFullYear() === viewYear);
    if (period === 'FY') return acctTxns.filter(t => { const d = parseDate(t.Date); return d >= fyStart(viewFY) && d <= fyEnd(viewFY); });
    if (period === 'CC Cycle' && ccCycleRange) return acctTxns.filter(t => { const d = parseDate(t.Date); return d >= ccCycleRange.start && d <= ccCycleRange.end; });
    if (period === 'Custom' && customFrom && customTo) { const f = new Date(customFrom), to = new Date(customTo + 'T23:59:59'); return acctTxns.filter(t => { const d = parseDate(t.Date); return d >= f && d <= to; }); }
    return acctTxns;
  }, [acctTxns, period, viewYear, viewMonth, viewFY, customFrom, customTo, ccCycleRange]);

  // Opening balance = balance from all transactions BEFORE the period
  const openingBal = useMemo(() => {
    if (period === 'All') return 0;
    if (isMFInvestmentSubAccount) return 0;
    const beforePeriod = acctTxns.filter(t => {
      const d = parseDate(t.Date);
      if (period === 'Month') return !(d.getFullYear() === viewYear && d.getMonth() === viewMonth) && d < new Date(viewYear, viewMonth, 1);
      if (period === 'Year') return d.getFullYear() < viewYear;
      if (period === 'FY') return d < fyStart(viewFY);
      if (period === 'CC Cycle' && ccCycleRange) return d < ccCycleRange.start;
      if (period === 'Custom' && customFrom) return d < new Date(customFrom);
      return false;
    });
    return computeBalance(beforePeriod, acctName);
  }, [acctTxns, period, viewYear, viewMonth, viewFY, customFrom, acctName, ccCycleRange, isMFInvestmentSubAccount]);

  const periodBalance = useMemo(() => {
    if (isMFInvestmentSubAccount) {
      if (acctName === 'Mutual Funds Tax Saver') return 204000;
      return 0;
    }
    return computeBalance(periodTxns, acctName);
  }, [periodTxns, acctName, isMFInvestmentSubAccount]);

  const closingBal = openingBal + periodBalance;

  // Income/expense/transfer breakdown for the period
  const totals = useMemo(() => {
    let income = 0, expense = 0, xferIn = 0, xferOut = 0, buysInvested = 0, sellsRedeemed = 0, totalRealizedPnl = 0;
    for (const t of periodTxns) {
      const amt = txnAmount(t);
      const type = String(t['Income/Expense'] || '').trim();
      const acct = t.Account || t.FromAccount || '';
      const dest = t.ToAccount || '';
      const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();
      const tradeVal = parseFloat(t.TradeValue || t.trade_value || t.CostBasis || t.cost_basis || t.INR || t.Amount || 0);
      const pnl = parseFloat(t.RealizedPnl || t.realized_pnl || 0);

      if (invType === 'BUY') {
        buysInvested += tradeVal;
      } else if (invType === 'SELL') {
        sellsRedeemed += tradeVal;
        totalRealizedPnl += pnl;
      }

      if (type === 'Income') income += amt;
      else if (type === 'Expense') expense += amt;
      else if (type === 'Transfer-Out') {
        if (acct === acctName) xferOut += amt;
        if (dest === acctName) xferIn += amt;
      }
    }
    return { income, expense, xferIn, xferOut, buysInvested, sellsRedeemed, totalRealizedPnl };
  }, [periodTxns, acctName]);

  const barData = useMemo(() => {
    if (['All', 'Custom'].includes(period)) return [];

    if (period === 'Year') {
      // Last 6 years ending at viewYear
      return Array.from({ length: 6 }, (_, i) => {
        const yr = viewYear - 5 + i;
        const yearTxns = acctTxns.filter(t => parseDate(t.Date).getFullYear() <= yr);
        return { name: String(yr), value: computeBalance(yearTxns, acctName) };
      });
    }

    if (period === 'FY') {
      // Last 6 FYs ending at viewFY
      return Array.from({ length: 6 }, (_, i) => {
        const fy = viewFY - 5 + i;
        const upTo = fyEnd(fy);
        const fyTxns = acctTxns.filter(t => parseDate(t.Date) <= upTo);
        return { name: `FY${String(fy).slice(-2)}`, value: computeBalance(fyTxns, acctName) };
      });
    }

    // Month / CC Cycle — last 6 months ending at viewed month
    const anchorYear = period === 'CC Cycle' ? now.getFullYear() + Math.floor((now.getMonth() + ccCycleOffset) / 12) : viewYear;
    const anchorMonth = period === 'CC Cycle'
      ? ((now.getMonth() + ccCycleOffset) % 12 + 12) % 12
      : viewMonth;

    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(anchorYear, anchorMonth - 5 + i, 1);
      const upToMonth = acctTxns.filter(t => {
        const td = parseDate(t.Date);
        return td <= new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
      });
      return { name: MS_S[d.getMonth()], value: computeBalance(upToMonth, acctName) };
    });
  }, [acctTxns, acctName, period, viewYear, viewMonth, viewFY, ccCycleOffset]);

  const chartTitle = useMemo(() => {
    if (period === 'Year') return '6-Year Balance Trend';
    if (period === 'FY') return '6-FY Balance Trend';
    if (['All', 'Custom'].includes(period)) return null;
    return '6-Month Balance Trend';
  }, [period]);

  const prev = () => {
    if (period === 'Month') { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); }
    if (period === 'Year') setViewYear(y => y - 1);
    if (period === 'FY') setViewFY(y => y - 1);
    if (period === 'CC Cycle') setCcCycleOffset(o => o - 1);
  };
  const next = () => {
    if (period === 'Month') { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); }
    if (period === 'Year') setViewYear(y => y + 1);
    if (period === 'FY') setViewFY(y => y + 1);
    if (period === 'CC Cycle') setCcCycleOffset(o => o + 1);
  };
  const swipe = useSwipe(next, prev);

  const fmtCycleDate = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const periodLabel = period === 'Month' ? `${MS_F[viewMonth]} ${viewYear}` : period === 'Year' ? String(viewYear) : period === 'FY' ? fyLabel(viewFY) : period === 'CC Cycle' && ccCycleRange ? `${fmtCycleDate(ccCycleRange.start)} – ${fmtCycleDate(ccCycleRange.end)}` : period === 'Custom' && customFrom && customTo ? `${customFrom} – ${customTo}` : 'All Time';

  const toggleSel = t => setSelected(p => { const s = new Set(p); s.has(t._id) ? s.delete(t._id) : s.add(t._id); return s; });

  const selTotals = useMemo(() => {
    let inc = 0, exp = 0, xfr = 0;
    for (const t of periodTxns.filter(r => selected.has(r._id))) {
      const tp = accountTxnType(t), amt = txnAmount(t);
      if (tp === 'income') inc += amt;
      else if (tp === 'expense') exp += amt;
      else xfr += amt;
    }
    return { inc, exp, xfr };
  }, [periodTxns, selected, acctName]);

  // Running balance map: txn._id → cumulative account balance AFTER that transaction.
  // Built from ALL account transactions in chronological order (oldest first).
  const runningBalMap = useMemo(() => {
    const sorted = [...acctTxns].sort((a, b) => {
      const da = parseDate(a.Date), db = parseDate(b.Date);
      if (da - db !== 0) return da - db;
      // same date: sort by time ascending
      return (a.Time || '').localeCompare(b.Time || '');
    });
    let bal = 0;
    const map = {};
    for (const t of sorted) {
      const amt = txnAmount(t);
      const type = String(t['Income/Expense'] || '').trim();
      const acct = t.Account || t.FromAccount || '';
      const dest = t.ToAccount || '';
      if (type === 'Income' && acct === acctName) bal += amt;
      else if (type === 'Expense' && acct === acctName) bal -= amt;
      else if (type === 'Transfer-Out') {
        if (acct === acctName) bal -= amt;
        if (dest === acctName) bal += amt;
      }
      map[t._id] = bal;
    }
    return map;
  }, [acctTxns, acctName]);

  const groups = useMemo(() => {
    const map = {};
    for (const t of [...periodTxns].sort((a, b) => {
      const da = parseDate(a.Date), db = parseDate(b.Date);
      if (da - db !== 0) return db - da; // date descending
      return (b.Time || '').localeCompare(a.Time || ''); // time descending within same date
    })) {
      if (!map[t.Date]) map[t.Date] = []; map[t.Date].push(t);
    }
    return Object.entries(map);
  }, [periodTxns]);

  return (
    <div className="acct-detail-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div className="page-hdr-title">{acctName}{subAccountName ? ` › ${subAccountName}` : ''}</div>
          <div className="page-hdr-sub">{subAccountName ? 'Sub Account' : 'Account'} · {acctTxns.length} total txns</div>
        </div>
        <div className="entity-badge" style={{ background: closingBal >= 0 ? 'var(--income-bg)' : 'var(--expense-bg)', color: closingBal >= 0 ? 'var(--income)' : 'var(--expense)' }}>
          {closingBal >= 0 ? '+' : ''}{formatINRCompact(Math.abs(closingBal))}
        </div>
        <button className="add-fab-sm" onClick={() => { setShowAdd(true); setAddKey(k => k + 1); }} title="Add transaction">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      <div className="acct-detail-body" {...(multiMode ? {} : swipe)}>
        <div style={{ padding: '8px var(--page-px) 4px' }}>
          <div className="period-tabs">
            {PERIODS.filter(p => p !== 'CC Cycle' || isCC).map(p => <button key={p} className={`period-tab ${period === p ? 'active' : ''}`} onClick={() => { setPeriod(p); if (p === 'CC Cycle') setCcCycleOffset(0); }}>{p}</button>)}
          </div>
        </div>
        {!['All', 'Custom'].includes(period) && (
          <div className="period-picker-row">
            <button className="pp-arrow" onClick={prev}>‹</button>
            <div className="pp-label">
              {periodLabel}
              {period === 'CC Cycle' && isCC && ccCycleOffset === 0 && <span className="cc-cycle-badge">Current</span>}
            </div>
            <button className="pp-arrow" onClick={next}>›</button>
          </div>
        )}
        {period === 'CC Cycle' && isCC && (
          <div className="cc-cycle-info-strip">
            <span>💳 Billing cycle closes on <strong>
              {(() => { const d = new Date(0, 0, ccConfig.settlementDate); return d.toLocaleDateString('en-IN', { day: 'numeric' }); })()}
            </strong> of each month</span>
          </div>
        )}
        {period === 'Custom' && (
          <div style={{ display: 'flex', gap: 8, padding: '6px var(--page-px)' }}>
            <input type="date" className="form-input" style={{ flex: 1 }} value={customFrom} onChange={e => setFrom(e.target.value)} />
            <span style={{ alignSelf: 'center', color: 'var(--text-muted)' }}>–</span>
            <input type="date" className="form-input" style={{ flex: 1 }} value={customTo} onChange={e => setTo(e.target.value)} />
          </div>
        )}

        {/* Opening / Closing balance for period */}
        {period !== 'All' && (
          <div className="acct-ob-strip">
            <div className="acct-ob-item">
              <div className="acct-ob-l">Opening</div>
              <div className={`acct-ob-v ${openingBal >= 0 ? 'pos' : 'neg'}`}>{openingBal >= 0 ? '+' : ''}{formatINR(Math.abs(openingBal))}</div>
            </div>
            <div className="acct-ob-div" />
            <div className="acct-ob-item">
              <div className="acct-ob-l">Net change</div>
              <div className={`acct-ob-v ${periodBalance >= 0 ? 'pos' : 'neg'}`}>{periodBalance >= 0 ? '+' : ''}{formatINR(Math.abs(periodBalance))}</div>
            </div>
            <div className="acct-ob-div" />
            <div className="acct-ob-item">
              <div className="acct-ob-l">Closing</div>
              <div className={`acct-ob-v ${closingBal >= 0 ? 'pos' : 'neg'}`}>{closingBal >= 0 ? '+' : ''}{formatINR(Math.abs(closingBal))}</div>
            </div>
          </div>
        )}

        {/* Activity strip — banking / investment style */}
        <div className="acct-banking-row">
          <div className="acct-banking-item">
            <div className="acct-banking-l">{isMFInvestmentSubAccount ? 'Invested' : 'Deposits'}</div>
            <div className="acct-banking-v income">{formatINR(isMFInvestmentSubAccount ? totals.buysInvested : (totals.income + totals.xferIn))}</div>
          </div>
          <div className="acct-banking-div" />
          <div className="acct-banking-item">
            <div className="acct-banking-l">{isMFInvestmentSubAccount ? 'Redemptions' : 'Withdrawals'}</div>
            <div className="acct-banking-v expense">{formatINR(isMFInvestmentSubAccount ? totals.sellsRedeemed : (totals.expense + totals.xferOut))}</div>
          </div>
          <div className="acct-banking-div" />
          <div className="acct-banking-item">
            <div className="acct-banking-l">{isMFInvestmentSubAccount ? 'Realized P&L' : 'Txns'}</div>
            <div className={`acct-banking-v ${isMFInvestmentSubAccount ? (totals.totalRealizedPnl >= 0 ? 'income' : 'expense') : ''}`}>
              {isMFInvestmentSubAccount
                ? `${totals.totalRealizedPnl >= 0 ? '+' : ''}${formatINR(totals.totalRealizedPnl)}`
                : periodTxns.length}
            </div>
          </div>
          <div className="acct-banking-div" />
          <div className="acct-banking-item">
            <div className="acct-banking-l">{isMFInvestmentSubAccount ? 'Position' : 'Balance'}</div>
            <div className={`acct-banking-v ${closingBal >= 0 ? 'income' : 'expense'}`} style={{ fontWeight: 900 }}>
              {closingBal >= 0 ? '+' : ''}{formatINR(closingBal)}
            </div>
          </div>
        </div>

        {chartTitle && (
          <div className="chart-wrap">
            <div style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: 6 }}>{chartTitle}</div>
            <ResponsiveContainer width="100%" height={130}>
              <AreaChart data={barData} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00e5a0" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#00e5a0" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} tickFormatter={v => formatINRCompact(Math.abs(v))} width={42} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                <Tooltip
                  formatter={v => [formatINR(v), 'Balance']}
                  labelStyle={{ fontSize: 11, color: 'var(--text-muted)' }}
                  contentStyle={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 11, padding: '6px 10px' }}
                />
                <Area
                  type="monotone" dataKey="value"
                  stroke="#00e5a0" strokeWidth={2.5}
                  fill="url(#balGrad)"
                  dot={{ fill: '#00e5a0', r: 4, strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: '#00e5a0', stroke: 'rgba(0,229,160,0.3)', strokeWidth: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {groups.length === 0
          ? <div className="empty-state"><div className="empty-icon">📭</div><div className="empty-title">No transactions</div><div className="empty-desc">{periodLabel}</div></div>
          : <>
            {multiMode && <BulkSelectionBar selected={selected} setSelected={setSelected} selTotals={selTotals} allTxns={periodTxns}
              onDone={() => { setMultiMode(false); setSelected(new Set()); }}
              onDeleted={() => { setMultiMode(false); setSelected(new Set()); }} />}
            {groups.map(([dk, txns], gi) => {
              const gt = txns.reduce((acc, t) => {
                const amt = txnAmount(t);
                const tp = accountTxnType(t);
                if (tp === 'income') acc.income += amt;
                else if (tp === 'expense') acc.expense += amt;
                return acc;
              }, { income: 0, expense: 0 });
              const d = parseDate(txns[0].Date);
              return (
                <div key={dk} className="date-group-container">
                  <div className="dg-header" onClick={multiMode ? null : () => setAddDate(txns[0].Date)}>
                    <div className="dg-left">
                      <div className="dg-day">{d.getDate()}</div>
                      <div className="dg-meta">
                        <div className="dg-wday">{d.toLocaleDateString('en-IN', { weekday: 'short' }).toUpperCase()}</div>
                        <div className="dg-month">{MS_S[d.getMonth()]} {d.getFullYear()}</div>
                      </div>
                    </div>
                    <div className="dg-totals">
                      {gt.income > 0 && <span className="dg-inc">+{formatINR(gt.income)}</span>}
                      {gt.expense > 0 && <span className="dg-exp">−{formatINR(gt.expense)}</span>}
                    </div>
                  </div>
                  <div className="dg-items">{txns.map((t, ti) => {
                    const runBal = runningBalMap[t._id];
                    // Show "(Balance X)" only on the very first transaction of the whole list
                    // (gi===0 && ti===0) — the newest transaction in the viewed period.
                    const isOverallNewest = gi === 0 && ti === 0;
                    return <TransactionItem key={t._id} transaction={t}
                      selected={selected.has(t._id)}
                      overrideType={accountTxnType(t)}
                      backInterceptRef={backInterceptRef}
                      onLongPress={tt => { setMultiMode(true); setSelected(new Set([tt._id])); }}
                      onTap={multiMode ? toggleSel : null}
                      onCopy={handleCopy}
                      runningBalance={runBal !== undefined ? runBal : null}
                      isNewestInGroup={isOverallNewest}
                    />;
                  })}</div>
                </div>
              );
            })}
          </>
        }
        <div style={{ height: 80 }} />
      </div>
      {addDate && <AddTransaction prefillDate={addDate} prefillAccount={acctName} prefillSubAccount={subAccountName} onClose={() => setAddDate(null)} onSaveAndContinue={() => setAddDate(addDate)} backInterceptRef={backInterceptRef} />}
      {showAdd && <AddTransaction key={addKey} prefillAccount={acctName} prefillSubAccount={subAccountName} onClose={() => setShowAdd(false)} onSaveAndContinue={() => { }} backInterceptRef={backInterceptRef} />}
      {copyTxn && <AddTransaction copyTransaction={copyTxn} onClose={() => setCopyTxn(null)} onSaveAndContinue={() => setCopyTxn({ ...copyTxn, _id: undefined })} backInterceptRef={backInterceptRef} />}
    </div>
  );
}

// ── Main Accounts screen ──────────────────────────────────────────────────────
export default function Accounts({ backInterceptRef } = {}) {
  const { state, navigate } = useApp();
  const { accounts, accountGroups, transactions } = state;
  const [drill, setDrill] = useState(null);
  const [drillSub, setDrillSub] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const [expandedAccounts, setExpandedAccounts] = useState(new Set());
  const [showDebtTracker, setShowDebtTracker] = useState(false);
  const [showOptimizer, setShowOptimizer] = useState(false);
  const [showGroups, setShowGroups] = useState(false);
  const [showStockManager, setShowStockManager] = useState(false);
  const [showInvestments, setShowInvestments] = useState(false);
  const [settlePrefill, setSettlePrefill] = useState(null);

  // Handle double-tap reset for Accounts tab
  useEffect(() => {
    const handleReset = () => {
      setDrill(null);
      setDrillSub(null);
      setShowDebtTracker(false);
      setShowOptimizer(false);
      setShowGroups(false);
      setShowStockManager(false);
      setShowInvestments(false);
      setSettlePrefill(null);
      setCollapsedGroups(new Set());
      setExpandedAccounts(new Set());
    };
    window.addEventListener('reset-accounts-view', handleReset);
    return () => window.removeEventListener('reset-accounts-view', handleReset);
  }, []);

  // Back button interception for Accounts sub-screens
  useEffect(() => {
    if (!backInterceptRef) return;
    if (settlePrefill) {
      backInterceptRef.current = () => setSettlePrefill(null);
    } else if (showGroups) {
      backInterceptRef.current = () => setShowGroups(false);
    } else if (showOptimizer) {
      backInterceptRef.current = () => setShowOptimizer(false);
    } else if (showDebtTracker) {
      backInterceptRef.current = () => setShowDebtTracker(false);
    } else if (showStockManager) {
      backInterceptRef.current = () => setShowStockManager(false);
    } else if (drill) {
      backInterceptRef.current = () => { setDrill(null); setDrillSub(null); };
    } else {
      backInterceptRef.current = null;
    }
    return () => { if (backInterceptRef) backInterceptRef.current = null; };
  }, [settlePrefill, showGroups, showOptimizer, showDebtTracker, showStockManager, drill, backInterceptRef]);

  const PAID_ALERT_STORAGE = 'finman-paid-due-alerts';
  const DISMISS_ALERT_STORAGE = 'finman-dismissed-due-alerts';

  const [paidDueAlerts, setPaidDueAlerts] = useState(() => {
    if (typeof localStorage === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(PAID_ALERT_STORAGE);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
      return new Set();
    }
  });

  const [dismissedDueAlerts, setDismissedDueAlerts] = useState(() => {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(DISMISS_ALERT_STORAGE);
      const obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) {
      return {};
    }
  });

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(PAID_ALERT_STORAGE, JSON.stringify([...paidDueAlerts]));
    } catch (e) {
      // ignore localStorage failures
    }
  }, [paidDueAlerts]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(DISMISS_ALERT_STORAGE, JSON.stringify(dismissedDueAlerts));
    } catch (e) {
      // ignore localStorage failures
    }
  }, [dismissedDueAlerts]);

  const todayKey = new Date().toISOString().split('T')[0];

  const markPaid = (acctName) => {
    setPaidDueAlerts(prev => {
      if (prev.has(acctName)) return prev;
      const next = new Set(prev);
      next.add(acctName);
      return next;
    });
    setDismissedDueAlerts(prev => {
      const next = { ...prev };
      delete next[acctName];
      return next;
    });
  };

  const markDismissed = (acctName) => {
    setDismissedDueAlerts(prev => ({ ...prev, [acctName]: todayKey }));
  };

  // Compute due-date alerts for all configured CC accounts
  const dueAlerts = useMemo(() => {
    const today = new Date();
    const alerts = [];
    for (const a of (accounts || [])) {
      if (!isCreditCard(a) || !a.settlementDate || !a.paymentDueDays) continue;
      const days = ccDaysUntilDue(a, today);
      if (days === null) continue;
      if (days <= 7) {
        // ONLY alert if there is actual balance payable
        const { balancePayable } = ccBalances(transactions, a.name, a.settlementDate, today);
        if (balancePayable > 0) {
          alerts.push({ acct: a, days, due: ccNextDueDate(a, today) });
        }
      }
    }
    return alerts;
  }, [accounts, transactions]);

  const toggleGroup = (groupName) => {
    setCollapsedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(groupName)) {
        newSet.delete(groupName);
      } else {
        newSet.add(groupName);
      }
      return newSet;
    });
  };

  const toggleAccountExpand = (acctName) => {
    setExpandedAccounts(prev => {
      const newSet = new Set(prev);
      if (newSet.has(acctName)) {
        newSet.delete(acctName);
      } else {
        newSet.add(acctName);
      }
      return newSet;
    });
  };

  // Register Android back intercept when drill-down, debt tracker or investments portfolio is open
  useEffect(() => {
    if (!backInterceptRef) return;
    if (showDebtTracker) {
      backInterceptRef.current = () => setShowDebtTracker(false);
    } else if (showInvestments) {
      backInterceptRef.current = () => setShowInvestments(false);
    } else if (drill) {
      backInterceptRef.current = () => setDrill(null);
    } else {
      backInterceptRef.current = null;
    }
    return () => { if (backInterceptRef) backInterceptRef.current = null; };
  }, [showDebtTracker, showInvestments, drill, backInterceptRef]);


  const shareMarketBalances = useMemo(() => calculateShareMarketBalances(transactions, state.brokerages, state.settings), [transactions, state.brokerages, state.settings]);

  const acctBalances = useMemo(() => {
    const map = buildBalanceMap(transactions);
    if (map['Share Market'] !== undefined) {
      let totalSm = 0;
      Object.values(shareMarketBalances).forEach(b => {
        totalSm += b.totalValue;
      });
      map['Share Market'] = totalSm;
    }
    return map;
  }, [transactions, shareMarketBalances]);

  const subAcctBalances = useMemo(() => {
    const map = buildSubAccountBalanceMap(transactions);
    if (map['Share Market']) {
      map['Share Market'] = {};
      Object.entries(shareMarketBalances).forEach(([sub, b]) => {
        map['Share Market'][sub] = b.totalValue;
      });
    }

    // Mutual Funds Tax Saver platform position
    if (!map['Mutual Funds Tax Saver']) map['Mutual Funds Tax Saver'] = {};
    if (map['Mutual Funds Tax Saver']['Ak ETMoney'] === undefined) {
      map['Mutual Funds Tax Saver']['Ak ETMoney'] = map['Mutual Funds Tax Saver'][''] ?? 204000;
    }

    // Liquid Mutual Funds platform positions
    if (!map['Liquid Mutual Funds']) map['Liquid Mutual Funds'] = {};
    if (map['Liquid Mutual Funds']['Ak ETMoney'] === undefined) {
      map['Liquid Mutual Funds']['Ak ETMoney'] = 0;
    }

    return map;
  }, [transactions, shareMarketBalances]);

  const netWorth = useMemo(() => Object.values(acctBalances).reduce((s, v) => s + v, 0), [acctBalances]);
  const assets = useMemo(() => {
    return Object.entries(acctBalances).reduce((sum, [name, val]) => {
      const a = accounts.find(acc => (acc.name || acc) === name);
      const isAsset = a?.isAsset !== undefined ? a.isAsset : !['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later', 'installments'].some(k => name.toLowerCase().includes(k));
      if (isAsset && val > 0) return sum + val;
      return sum;
    }, 0);
  }, [acctBalances, accounts]);

  const liabilities = useMemo(() => {
    return Object.entries(acctBalances).reduce((sum, [name, val]) => {
      const a = accounts.find(acc => (acc.name || acc) === name);
      const isAsset = a?.isAsset !== undefined ? a.isAsset : !['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later', 'installments'].some(k => name.toLowerCase().includes(k));
      if (!isAsset) return sum + Math.abs(val);
      if (isAsset && val < 0) return sum + Math.abs(val); // overdraft
      return sum;
    }, 0);
  }, [acctBalances, accounts]);

  const uniqueAccountGroups = useMemo(() => [...new Set(accountGroups)], [accountGroups]);
  const uniqueAccounts = useMemo(() => {
    const seen = new Set();
    return accounts.filter(acc => {
      const duplicate = seen.has(acc.name);
      seen.add(acc.name);
      return !duplicate;
    });
  }, [accounts]);

  const grouped = useMemo(() => {
    const groups = {};
    const ungrouped = [];
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
    const normalizedAccts = (uniqueAccounts || [])
      .map(a => typeof a === 'string' ? { name: a, group: '', icon: '💳' } : a)
      .filter(a => a.name && !looksNumeric(a.name)); // skip numeric-named accounts
    for (const a of normalizedAccts) {
      const grp = a.group || '';
      if (grp && (uniqueAccountGroups || []).includes(grp)) {
        if (!groups[grp]) groups[grp] = [];
        groups[grp].push(a);
      } else ungrouped.push(a);
    }
    return { groups, ungrouped };
  }, [uniqueAccounts, uniqueAccountGroups]);

  if (showGroups) {
    return <GroupSplitManager onBack={() => setShowGroups(false)} backInterceptRef={backInterceptRef} />;
  }

  if (showOptimizer) {
    return <CardOptimizer onBack={() => setShowOptimizer(false)} backInterceptRef={backInterceptRef} />;
  }

  if (showDebtTracker) {
    return (
      <>
        <DebtTracker
          onBack={() => setShowDebtTracker(false)}
          backInterceptRef={backInterceptRef}
          onSettle={({ name, amount, type }) => {
            const firstSavings = (accounts || []).find(a => !['credit card', 'credit', 'lend', 'borrow'].some(k => (a.name || a).toLowerCase().includes(k))) || 'Cash';
            const bankName = typeof firstSavings === 'object' ? firstSavings.name : firstSavings;
            setSettlePrefill({
              type: 'Transfer-Out',
              fromAccount: type === 'receive' ? 'Lend' : bankName,
              toAccount: type === 'receive' ? '' : 'Borrow',
              amount: String(amount),
              note: type === 'receive' ? `From ${name}` : `To ${name}`,
            });
          }}
        />
        {settlePrefill && (
          <AddTransaction
            prefillType={settlePrefill.type}
            prefillFromAccount={settlePrefill.fromAccount}
            prefillToAccount={settlePrefill.toAccount}
            prefillAmount={settlePrefill.amount}
            prefillNote={settlePrefill.note}
            onClose={() => setSettlePrefill(null)}
            onSaveAndContinue={() => setSettlePrefill(null)}
            backInterceptRef={backInterceptRef}
          />
        )}
      </>
    );
  }

  if (showStockManager) {
    return <StockManager onBack={() => setShowStockManager(false)} backInterceptRef={backInterceptRef} />;
  }

  if (showInvestments) {
    return <InvestmentsPortfolio onBack={() => setShowInvestments(false)} backInterceptRef={backInterceptRef} />;
  }

  if (drill) {
    const drillAcct = (uniqueAccounts || []).find(a => (a.name || a) === drill);
    const ccCfg = drillAcct && isCreditCard(drillAcct) ? drillAcct : null;
    return <AccountDetail acctName={drill} subAccountName={drillSub} allTxns={transactions} onBack={() => { setDrill(null); setDrillSub(null); }} backInterceptRef={backInterceptRef} ccConfig={ccCfg} />;
  }

  const renderAcctRow = (a) => {
    const name = a.name || a;
    const bal = acctBalances[name] ?? 0;
    const acctObj = typeof a === 'object' ? a : { name };
    const isShareMarket = name === 'Share Market';
    const isMFTaxSaver = name === 'Mutual Funds Tax Saver';
    const isLiquidMF = name === 'Liquid Mutual Funds';

    let subAccountsToRender = acctObj.subAccounts || [];
    if (isShareMarket) {
      subAccountsToRender = Object.keys(shareMarketBalances).map(subName => ({ name: subName }));
    } else if (isMFTaxSaver) {
      const existingSubs = (acctObj.subAccounts || []).map(s => s.name || s);
      const allSubs = new Set([...existingSubs, 'Ak ETMoney']);
      subAccountsToRender = Array.from(allSubs).map(s => ({ name: s }));
    } else if (isLiquidMF) {
      const existingSubs = (acctObj.subAccounts || []).map(s => s.name || s);
      const allSubs = new Set([...existingSubs, 'Fareeda Groww', 'Ammi Groww', 'Ak ETMoney']);
      subAccountsToRender = Array.from(allSubs).filter(s => s !== 'Groww' || existingSubs.includes('Groww')).map(s => ({ name: s }));
    }

    const hasSubs = subAccountsToRender.length > 0;
    const isAcctExpanded = expandedAccounts.has(name);

    let parentRow;
    if (isCreditCard(acctObj)) {
      const now = new Date();
      let balancePayable = 0, outstanding = 0;
      if (acctObj.settlementDate > 0) {
        ({ balancePayable, outstanding } = ccBalances(transactions, name, acctObj.settlementDate, now));
      }

      // outstanding: positive = you owe (shown as −), negative = credit/overpaid (shown as +)
      const outAmt = Math.abs(outstanding);
      const outSign = outstanding > 0 ? '−' : outstanding < 0 ? '+' : '';
      const outCls = outstanding > 0 ? 'warn' : outstanding < 0 ? 'pos' : '';

      const dueDays = ccDaysUntilDue(acctObj, now);
      const showDueDot = !paidDueAlerts.has(name) && dueDays !== null && dueDays <= 7 && balancePayable > 0;
      parentRow = (
        <div key={name} className="acct-row acct-row-cc" onClick={() => setDrill(name)}>
          <div className="acct-row-name">
            {name}
            {showDueDot && (
              <span className={`cc-due-dot ${dueDays <= 0 ? 'overdue' : dueDays <= 2 ? 'urgent' : 'warn'}`}>
                {dueDays <= 0 ? '!' : dueDays}
              </span>
            )}
          </div>
          <div className="acct-row-cc-amounts">
            <div className="acct-row-cc-col">
              <div className={`acct-row-cc-val ${balancePayable > 0 ? 'neg' : balancePayable < 0 ? 'pos' : ''}`}>
                {balancePayable < 0 ? '+' : balancePayable > 0 ? '−' : ''}{formatINR(Math.abs(balancePayable))}
              </div>
            </div>
            <div className="acct-row-cc-col">
              <div className={`acct-row-cc-val ${outCls}`}>
                {outSign}{formatINR(outAmt)}
              </div>
            </div>
          </div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="11" height="11" style={{ flexShrink: 0 }}><path d="M9 18l6-6-6-6" /></svg>
        </div>
      );
    } else {
      parentRow = (
        <div key={name} className="acct-row" style={{ display: 'flex', alignItems: 'center' }}>
          {hasSubs && (
            <button
              type="button"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                padding: '0 8px 0 0',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'transform 0.2s',
                transform: isAcctExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleAccountExpand(name);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" width="10" height="10"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          )}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', cursor: 'pointer' }} onClick={() => setDrill(name)}>
            <div className="acct-row-name" style={{ flex: 1 }}>{name}</div>
            <div className={`acct-row-bal ${bal >= 0 ? 'pos' : 'neg'}`} style={{ marginRight: 6 }}>{bal < 0 ? '−' : ''}{formatINR(Math.abs(bal))}</div>
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="11" height="11"><path d="M9 18l6-6-6-6" /></svg>
          </div>
        </div>
      );
    }

    if (hasSubs) {
      return (
        <React.Fragment key={name}>
          {parentRow}
          {isAcctExpanded && [...subAccountsToRender]
            .sort((a, b) => {
              const balA = subAcctBalances[name]?.[a.name] ?? 0;
              const balB = subAcctBalances[name]?.[b.name] ?? 0;
              return balB - balA;
            })
            .map(sub => {
              const subBal = subAcctBalances[name]?.[sub.name] ?? 0;
              return (
                <div
                  key={`${name}-${sub.name}`}
                  className="acct-row"
                  style={{
                    paddingLeft: '32px',
                    background: 'var(--bg-card2)',
                    borderBottom: '1px solid var(--border-light)',
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer'
                  }}
                  onClick={() => {
                    setDrill(name);
                    setDrillSub(sub.name);
                  }}
                >
                  <div className="acct-row-name" style={{ flex: 1, fontSize: '0.8rem', opacity: 0.9 }}>
                    <div>{sub.name}</div>
                    {isShareMarket && shareMarketBalances[sub.name] && (
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 'normal', marginTop: 1 }}>
                        Cash {shareMarketBalances[sub.name].cashBalance < 0 ? '−' : ''}{formatINR(Math.abs(shareMarketBalances[sub.name].cashBalance))} · Inv {formatINR(shareMarketBalances[sub.name].investedCost)}
                      </div>
                    )}
                  </div>
                  <div className={`acct-row-bal ${subBal >= 0 ? 'pos' : 'neg'}`} style={{ fontSize: '0.8rem', marginRight: 6 }}>
                    {subBal < 0 ? '−' : ''}{formatINR(Math.abs(subBal))}
                  </div>
                  <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="9" height="9"><path d="M9 18l6-6-6-6" /></svg>
                </div>
              );
            })}
        </React.Fragment>
      );
    }

    return parentRow;
  };

  return (
    <div className="accounts-screen">
      <div className="page-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <div className="page-hdr-title">Accounts</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            onClick={() => setShowOptimizer(true)}
            style={{
              padding: '6px 9px',
              borderRadius: 14,
              fontSize: '0.7rem',
              fontWeight: 700,
              border: '1px solid var(--border)',
              background: 'var(--bg-card2)',
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              cursor: 'pointer',
            }}
          >
            <span>💳</span> Card Perks
          </button>
          <button
            onClick={() => setShowInvestments(true)}
            style={{
              padding: '6px 9px',
              borderRadius: 14,
              fontSize: '0.7rem',
              fontWeight: 700,
              border: '1px solid var(--border)',
              background: 'var(--bg-card2)',
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              cursor: 'pointer',
            }}
          >
            <span>📈</span> Portfolio
          </button>
          <button
            onClick={() => setShowDebtTracker(true)}
            style={{
              padding: '6px 9px',
              borderRadius: 14,
              fontSize: '0.7rem',
              fontWeight: 700,
              border: '1px solid var(--border)',
              background: 'var(--bg-card2)',
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              cursor: 'pointer',
            }}
          >
            <span>🤝</span> Debt Tracker
          </button>
        </div>
      </div>

      {/* Assets / Liabilities strip */}
      <div className="bal-strip" style={{ flexShrink: 0 }}>
        <div className="bal-strip-item"><div className="bal-strip-l">Assets</div><div className="bal-strip-v" style={{ color: 'var(--income)' }}>{formatINR(assets)}</div></div>
        <div className="bal-strip-div" />
        <div className="bal-strip-item"><div className="bal-strip-l">Liabilities</div><div className="bal-strip-v" style={{ color: 'var(--expense)' }}>{formatINR(liabilities)}</div></div>
        <div className="bal-strip-div" />
        <div className="bal-strip-item"><div className="bal-strip-l">Net Worth</div><div className="bal-strip-v" style={{ color: netWorth >= 0 ? 'var(--income)' : 'var(--expense)', fontWeight: 900 }}>{netWorth >= 0 ? '+' : ''}{formatINR(netWorth)}</div></div>
      </div>

      {/* CC Payment Due Alerts */}
      {dueAlerts.filter(a => !paidDueAlerts.has(a.acct.name)).filter(alert => {
        const canDismiss = dismissedDueAlerts[alert.acct.name] === todayKey;
        return !canDismiss;
      }).map(alert => {
        const { acct, days, due } = alert;
        const { balancePayable } = ccBalances(transactions, acct.name, acct.settlementDate, new Date());
        const isOverdue = days <= 0;
        const isUrgent = days <= 2;
        const dueLabel = isOverdue ? `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`
          : days === 0 ? 'Due today'
            : `Due in ${days} day${days === 1 ? '' : 's'}`;
        const dueDateStr = due ? due.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        return (
          <div key={acct.name} className={`cc-due-banner ${isOverdue ? 'overdue' : isUrgent ? 'urgent' : 'warning'}`}>
            <div className="cc-due-banner-icon">{isOverdue ? '🚨' : isUrgent ? '⚠️' : '🔔'}</div>
            <div className="cc-due-banner-body">
              <div className="cc-due-banner-title">
                {acct.name} — <span className="cc-due-banner-label">{dueLabel}</span>
              </div>
              <div className="cc-due-banner-sub">
                Payment due {dueDateStr}
                {balancePayable > 0 ? ` · ₹${balancePayable.toLocaleString('en-IN')} payable` : ' · No outstanding balance'}
              </div>
            </div>
            <div className="cc-due-banner-actions">
              <button className="cc-due-banner-chip" onClick={() => markPaid(acct.name)}>Paid</button>
              <button className="cc-due-banner-chip" onClick={() => markDismissed(acct.name)}>Dismiss</button>
            </div>
          </div>
        );
      })}

      <div className="accounts-list">
        {(uniqueAccountGroups || []).map(grp => {
          const accts = grouped.groups[grp] || [];
          if (!accts.length) return null;
          const isCollapsed = collapsedGroups.has(grp);

          // Check if this group has any CC accounts with settlement config
          const now = new Date();
          const ccAccts = accts.filter(a => isCreditCard(a) && a.settlementDate > 0);
          const isAllCC = ccAccts.length === accts.length;

          // Calculate CC totals upfront if needed
          let totalPayable = 0, totalOutstanding = 0, grpOutAmt = 0, grpOutSign = '', grpOutCls = '';
          if (ccAccts.length > 0 && isAllCC) {
            const totals = ccAccts.reduce((s, a) => {
              const { balancePayable, outstanding } = ccBalances(transactions, a.name, a.settlementDate, now);
              return { balancePayable: s.balancePayable + balancePayable, outstanding: s.outstanding + outstanding };
            }, { balancePayable: 0, outstanding: 0 });
            totalPayable = totals.balancePayable;
            totalOutstanding = totals.outstanding;
            grpOutAmt = Math.abs(totalOutstanding);
            grpOutSign = totalOutstanding > 0 ? '−' : totalOutstanding < 0 ? '+' : '';
            grpOutCls = totalOutstanding > 0 ? 'warn' : totalOutstanding < 0 ? 'pos' : '';
          }

          let grpHeader;
          if (isAllCC && ccAccts.length > 0) {
            grpHeader = (
              <div className="acct-group-header acct-group-header-cc" onClick={() => toggleGroup(grp)}>
                <div className="acct-group-label">📁 {grp}</div>
                <div className="acct-group-cc-totals">
                  <div className="acct-group-cc-col">
                    <div className="acct-group-cc-lbl">Balance Payable</div>
                    <div className={`acct-group-cc-val ${totalPayable > 0 ? 'neg' : totalPayable < 0 ? 'pos' : ''}`}>
                      {totalPayable < 0 ? '+' : totalPayable > 0 ? '−' : ''}{formatINR(Math.abs(totalPayable))}
                    </div>
                  </div>
                  <div className="acct-group-cc-divider" />
                  <div className="acct-group-cc-col">
                    <div className="acct-group-cc-lbl">Outst. Balance</div>
                    <div className={`acct-group-cc-val ${grpOutCls}`}>
                      {grpOutSign}{formatINR(grpOutAmt)}
                    </div>
                  </div>
                </div>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 12, height: 12, transition: 'transform 0.2s', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', flexShrink: 0 }}><path d="M6 9l6 6 6-6" /></svg>
              </div>
            );
          } else {
            const grpTotal = accts.reduce((s, a) => s + (acctBalances[a.name || a] ?? 0), 0);
            grpHeader = (
              <div className="acct-group-header" onClick={() => toggleGroup(grp)}>
                <div className="acct-group-label">📁 {grp}</div>
                <span className={`acct-group-bal ${grpTotal >= 0 ? 'pos' : 'neg'}`}>{grpTotal < 0 ? '−' : ''}{formatINR(Math.abs(grpTotal))}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 12, height: 12, transition: 'transform 0.2s', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}><path d="M6 9l6 6 6-6" /></svg>
              </div>
            );
          }

          return (
            <div key={grp}>
              {grpHeader}
              {!isCollapsed && (
                <>
                  {accts.map(renderAcctRow)}
                  {grp === 'Investments' && (
                    <button
                      onClick={() => setShowInvestments(true)}
                      className="investments-portfolio-banner-btn"
                      style={{
                        margin: '8px 12px',
                        width: 'calc(100% - 24px)',
                        padding: '10px 12px',
                        borderRadius: '12px',
                        background: 'linear-gradient(135deg, rgba(0, 229, 160, 0.08), rgba(0, 229, 160, 0.02))',
                        border: '1.5px dashed rgba(0, 229, 160, 0.3)',
                        color: 'var(--accent)',
                        fontSize: '0.78rem',
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                        cursor: 'pointer',
                        transition: 'all 0.25s ease',
                        boxSizing: 'border-box'
                      }}
                    >
                      📈 View Investment Portfolio Dashboard
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
        {grouped.ungrouped.length > 0 && (() => {
          const hasCC = grouped.ungrouped.some(a => isCreditCard(typeof a === 'object' ? a : { name: a.name || a }));
          return (
            <div>
              {(uniqueAccountGroups || []).length > 0 && (
                <div className="acct-group-header" style={{ opacity: 0.55 }}><span>📋 Ungrouped</span></div>
              )}
              {grouped.ungrouped.map(renderAcctRow)}
            </div>
          );
        })()}
        {uniqueAccounts.length === 0 && (
          <div className="empty-state"><div className="empty-icon">💳</div><div className="empty-title">No accounts yet</div><div className="empty-desc">Add accounts in Settings</div></div>
        )}
        <div style={{ height: 80 }} />
      </div>
    </div>
  );
}