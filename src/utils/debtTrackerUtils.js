/**
 * debtTrackerUtils.js
 *
 * Authoritative utility functions and calculation engine for Debt & Lending Tracker:
 * - Strict person-scope extraction from transaction notes
 * - Exclusion of non-person internal clearings, platform accounts, and trip memos
 * - Single source of truth for FIFO itemized debt allocations and counterparty aggregation
 */
import { parseDate } from './format.js';

/**
 * Normalizes a person identifier for canonical deduplication.
 * Eliminates case discrepancies, leading/trailing whitespace, and redundant spaces.
 */
export function normalizePersonKey(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Extracts a person's name from a transaction note.
 * Enforces strict directional prefix and filters out non-person tokens.
 */
export function extractPersonName(rawNote) {
  if (!rawNote || typeof rawNote !== 'string') return null;
  let s = rawNote.trim();

  // Must match standard directional person prefix in note
  const match = s.match(/^(to\s*:?|from\s*:?|lend\s*to\s*:?|lend\s*from\s*:?|borrow\s*from\s*:?|given\s*to\s*:?|received\s*from\s*:?|return\s*from\s*:?|repay\s*to\s*:?|paid\s*to\s*:?)\s+(.+)$/i);
  if (!match) return null;

  let name = match[2].trim();
  // Strip trailing notes/numbers like "(1/3)", "repayment", "loan", "advance", etc.
  name = name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
  name = name.replace(/\s+(return|settlement|repayment|lent|borrowed|advance|loan|dues?|clearing|alignment|share)$/i, '').trim();
  if (!name) return null;

  const lower = name.toLowerCase();

  // Exclude non-person targets: accounts, platforms, asset classes, clearing phrases, locations, generic terms
  const nonPersonTokens = [
    'share market', 'sharemarket', 'market', 'stock', 'mutual fund', 'bank', 'capital',
    'drawer', 'clearing', 'alignment', 'replenishment', 'adjustment', 'settlement',
    'goa', 'vellore', 'ooty', 'trip', 'hospital', 'food', 'transportation', 'hotel', 'flight',
    'house', 'rent', 'office', 'gplay', 'google play', 'amazon', 'flipkart', 'paytm', 'cash',
    'family members', 'self', 'internal', 'for adjustment', 'refund', 'recover'
  ];

  if (nonPersonTokens.some(token => lower === token || lower.startsWith(token + ' ') || lower.endsWith(' ' + token))) {
    return null;
  }

  // Canonical title-casing of first letter while preserving original inner casing
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Parses #debt_ref_<txnId> and #stock_debt_ref_<txnId> tags for explicit linked repayments.
 */
export function parseDebtRefTags(tags = '', desc = '') {
  if (!tags && !desc) return [];
  const combined = `${tags || ''} ${desc || ''}`;
  const refRegex = /#(?:debt_ref_|stock_debt_ref_)([a-zA-Z0-9_-]+)(?::([\d.]+))?/g;
  const refs = [];
  let match;
  while ((match = refRegex.exec(combined)) !== null) {
    refs.push({
      targetTxnId: match[1],
      amount: match[2] ? parseFloat(match[2]) : null,
    });
  }
  return refs;
}

/**
 * Authoritative Debt & Lending Ledger Calculation
 * Single source of truth shared across DebtTracker and Dashboard.
 *
 * @param {Array} transactions - All transaction records
 * @returns {Object} { totalReceivable, totalPayable, personLedgers, counterparties, topCounterparties }
 */
export function calculateDebtLedgers(transactions = []) {
  const ledgerMap = new Map();

  for (const t of transactions) {
    const acct = (t.Account || t.FromAccount || '').toLowerCase().trim();
    const toAcct = (t.ToAccount || '').toLowerCase().trim();
    const cat = (t.Category || '').toLowerCase().trim();
    const type = (t['Income/Expense'] || 'Expense').toLowerCase().trim();
    const rawNote = t.Note || t.Description || '';
    const amt = parseFloat(t.INR || t.Amount || 0);

    // A transaction belongs to Debt Tracker ONLY if Account or Category is explicitly Lend or Borrow
    const isLendAccount = acct === 'lend' || toAcct === 'lend' || cat === 'lend';
    const isBorrowAccount = acct === 'borrow' || toAcct === 'borrow' || cat === 'borrow';

    if (!isLendAccount && !isBorrowAccount) continue;

    // Extract genuine person counterparty
    const personRaw = extractPersonName(rawNote);
    if (!personRaw) continue;

    const normalizedKey = normalizePersonKey(personRaw);
    if (!normalizedKey) continue;

    if (!ledgerMap.has(normalizedKey)) {
      ledgerMap.set(normalizedKey, {
        name: personRaw, // Display name
        normalizedKey,
        lent: 0,
        received: 0,
        borrowed: 0,
        repaid: 0,
        txnCount: 0,
        lastDate: t.Date,
        rawTxns: [],
      });
    }

    const p = ledgerMap.get(normalizedKey);
    p.txnCount += 1;

    // Prefer more cleanly capitalized display name if already set
    if (personRaw.length > p.name.length || (!/[a-z]/.test(p.name) && /[a-z]/.test(personRaw))) {
      p.name = personRaw;
    }

    if (isLendAccount) {
      // Giving money to someone (Lend Account as destination OR Expense from Lend)
      const isGiving = toAcct === 'lend' || (type === 'expense' && acct === 'lend') || /^(to|lend\s*to|given\s*to)\s+/i.test(rawNote);
      if (isGiving) {
        p.lent += amt;
        p.rawTxns.push({ ...t, _role: 'lent', _amt: amt });
      } else {
        // Receiving repayment from someone
        p.received += amt;
        p.rawTxns.push({ ...t, _role: 'received', _amt: amt });
      }
    } else if (isBorrowAccount) {
      // Borrowing money from someone (Borrow Account as source OR Income from Borrow)
      const isBorrowing = acct === 'borrow' || (type === 'income' && acct === 'borrow') || /^(borrow\s*from|from|received\s*from)\s+/i.test(rawNote);
      if (isBorrowing) {
        p.borrowed += amt;
        p.rawTxns.push({ ...t, _role: 'borrowed', _amt: amt });
      } else {
        // Repaying money to someone
        p.repaid += amt;
        p.rawTxns.push({ ...t, _role: 'repaid', _amt: amt });
      }
    }
  }

  const list = Array.from(ledgerMap.values()).map(p => {
    const net = (p.lent - p.received) - (p.borrowed - p.repaid);

    // Sort chronologically (oldest first)
    const chronoTxns = [...p.rawTxns].sort((a, b) => parseDate(a.Date) - parseDate(b.Date));

    const lendTxns = chronoTxns.filter(x => x._role === 'lent');
    const receivedTxns = chronoTxns.filter(x => x._role === 'received');
    const borrowTxns = chronoTxns.filter(x => x._role === 'borrowed');
    const repaidTxns = chronoTxns.filter(x => x._role === 'repaid');

    // 1. Allocate Lend repayments against lent items
    const lendMap = new Map();
    const lendAllocations = new Map();
    for (const item of lendTxns) {
      const id = String(item._id || item.ID || item.id || '');
      if (id) lendMap.set(id, item);
      lendAllocations.set(item, 0);
    }

    // First pass: Explicit linked returns (#debt_ref_<loanTxnId>)
    let unallocatedReceived = 0;
    for (const ret of receivedTxns) {
      const refs = parseDebtRefTags(ret.Tags || ret.tags || '', ret.Description || ret.description || '');
      let retAmtRemaining = ret._amt;

      for (const ref of refs) {
        const target = lendMap.get(ref.targetTxnId);
        if (target && retAmtRemaining > 0) {
          const currentPaid = lendAllocations.get(target) || 0;
          const targetRemaining = Math.max(0, target._amt - currentPaid);
          const allocAmt = ref.amount != null
            ? Math.min(ref.amount, retAmtRemaining, targetRemaining)
            : Math.min(retAmtRemaining, targetRemaining);

          if (allocAmt > 0) {
            lendAllocations.set(target, currentPaid + allocAmt);
            retAmtRemaining = Math.round((retAmtRemaining - allocAmt) * 100) / 100;
          }
        }
      }

      if (retAmtRemaining > 0) {
        unallocatedReceived += retAmtRemaining;
      }
    }

    // Second pass: FIFO allocation for remaining unallocated returns
    const processedLendTxns = [];
    for (const item of lendTxns) {
      let paid = lendAllocations.get(item) || 0;
      let pending = Math.max(0, Math.round((item._amt - paid) * 100) / 100);

      if (pending > 0 && unallocatedReceived > 0) {
        if (unallocatedReceived >= pending) {
          paid = item._amt;
          unallocatedReceived = Math.round((unallocatedReceived - pending) * 100) / 100;
          pending = 0;
        } else {
          paid = Math.round((paid + unallocatedReceived) * 100) / 100;
          pending = Math.round((item._amt - paid) * 100) / 100;
          unallocatedReceived = 0;
        }
      }

      const itemStatus = pending <= 0.005 ? 'settled' : (paid > 0.005 ? 'partial' : 'pending');
      processedLendTxns.push({
        ...item,
        itemStatus,
        pendingAmt: pending,
        paidAmt: paid,
      });
    }

    // 2. Symmetrical allocation for Borrow repayments against borrowed items
    const borrowMap = new Map();
    const borrowAllocations = new Map();
    for (const item of borrowTxns) {
      const id = String(item._id || item.ID || item.id || '');
      if (id) borrowMap.set(id, item);
      borrowAllocations.set(item, 0);
    }

    let unallocatedMyRepaid = 0;
    for (const rep of repaidTxns) {
      const refs = parseDebtRefTags(rep.Tags || rep.tags || '', rep.Description || rep.description || '');
      let repAmtRemaining = rep._amt;

      for (const ref of refs) {
        const target = borrowMap.get(ref.targetTxnId);
        if (target && repAmtRemaining > 0) {
          const currentPaid = borrowAllocations.get(target) || 0;
          const targetRemaining = Math.max(0, target._amt - currentPaid);
          const allocAmt = ref.amount != null
            ? Math.min(ref.amount, repAmtRemaining, targetRemaining)
            : Math.min(repAmtRemaining, targetRemaining);

          if (allocAmt > 0) {
            borrowAllocations.set(target, currentPaid + allocAmt);
            repAmtRemaining = Math.round((repAmtRemaining - allocAmt) * 100) / 100;
          }
        }
      }

      if (repAmtRemaining > 0) {
        unallocatedMyRepaid += repAmtRemaining;
      }
    }

    const processedBorrowTxns = [];
    for (const item of borrowTxns) {
      let paid = borrowAllocations.get(item) || 0;
      let pending = Math.max(0, Math.round((item._amt - paid) * 100) / 100);

      if (pending > 0 && unallocatedMyRepaid > 0) {
        if (unallocatedMyRepaid >= pending) {
          paid = item._amt;
          unallocatedMyRepaid = Math.round((unallocatedMyRepaid - pending) * 100) / 100;
          pending = 0;
        } else {
          paid = Math.round((paid + unallocatedMyRepaid) * 100) / 100;
          pending = Math.round((item._amt - paid) * 100) / 100;
          unallocatedMyRepaid = 0;
        }
      }

      const itemStatus = pending <= 0.005 ? 'settled' : (paid > 0.005 ? 'partial' : 'pending');
      processedBorrowTxns.push({
        ...item,
        itemStatus,
        pendingAmt: pending,
        paidAmt: paid,
      });
    }

    // 3. Mark Repayments received & made
    const otherTxns = chronoTxns
      .filter(x => x._role === 'received' || x._role === 'repaid')
      .map(x => ({
        ...x,
        itemStatus: 'repayment',
        pendingAmt: 0,
        paidAmt: x._amt,
      }));

    // Combine and sort newest first for ledger view
    const allProcessedTxns = [...processedLendTxns, ...processedBorrowTxns, ...otherTxns]
      .sort((a, b) => parseDate(b.Date) - parseDate(a.Date));

    const pendingCount = allProcessedTxns.filter(t => t.itemStatus === 'pending' || t.itemStatus === 'partial').length;

    return {
      ...p,
      netBalance: Math.round(net * 100) / 100,
      txns: allProcessedTxns,
      pendingCount,
    };
  }).sort((a, b) => Math.abs(b.netBalance) - Math.abs(a.netBalance));

  let recSum = 0;
  let paySum = 0;
  const counterparties = [];

  for (const p of list) {
    if (p.netBalance > 0.5) {
      recSum += p.netBalance;
      counterparties.push({ name: p.name, type: 'lent', amount: p.netBalance });
    } else if (p.netBalance < -0.5) {
      paySum += Math.abs(p.netBalance);
      counterparties.push({ name: p.name, type: 'borrowed', amount: Math.abs(p.netBalance) });
    }
  }

  const totalReceivable = Math.round(recSum * 100) / 100;
  const totalPayable = Math.round(paySum * 100) / 100;

  return {
    totalReceivable,
    totalPayable,
    personLedgers: list,
    counterparties,
    topCounterparties: counterparties.slice(0, 8),
  };
}
