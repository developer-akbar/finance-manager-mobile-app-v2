import { extractPersonName } from './format.js';
import { getCanonicalProductName, cleanRawItemName, parseDescriptionStockInfo } from './stockInventoryNormalization.js';
import { getDiscreteUnitLabel, formatFraction } from './stockActivityHistory.js';

/**
 * Parses a standard date string into an ISO YYYY-MM-DD string for chronological comparison.
 * Supports DD/MM/YYYY and YYYY-MM-DD.
 */
export function toIsoDate(rawDate) {
  if (!rawDate) return '';
  const str = String(rawDate).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parts = str.split(/[/.-]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      // YYYY-MM-DD
      return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    }
    // DD-MM-YYYY
    return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
  return str;
}

/**
 * Parses #stock_debt_ref_<loanTxnId>[:<amount>] from tags.
 * Returns an array of { loanTxnId: string, amount: number | null }.
 */
export function parseStockDebtRefTags(tags = '') {
  if (!tags) return [];
  const refRegex = /#stock_debt_ref_([a-zA-Z0-9_-]+)(?::([\d.]+))?/g;
  const refs = [];
  let match;
  while ((match = refRegex.exec(tags)) !== null) {
    refs.push({
      loanTxnId: match[1],
      amount: match[2] ? parseFloat(match[2]) : null
    });
  }
  return refs;
}

/**
 * Determines whether a transaction is a physical stock loan.
 * Criteria:
 *  - Source account is Stock and destination/category is Lend, OR tagged #lent
 *  - AND carries #stock / #stock_ref_ or starts with 'Lent <qty>'
 */
export function isStockLoanTransaction(txn = {}) {
  const fromAcct = (txn.FromAccount || txn.Account || txn.account || txn.from_account || '').trim().toLowerCase();
  const toAcct = (txn.ToAccount || txn.to_account || '').trim().toLowerCase();
  const cat = (txn.Category || txn.category || '').trim().toLowerCase();
  const tags = (txn.Tags || txn.tags || '').toLowerCase();
  const desc = (txn.Description || txn.description || '').trim();

  // Primary rule: Outflow from Stock to Lend
  const isStockToLend = fromAcct === 'stock' && (toAcct === 'lend' || cat === 'lend');
  const isExplicitLentTag = tags.includes('#lent') && (fromAcct === 'stock' || tags.includes('#stock'));
  const isLentDescription = desc.startsWith('Lent ') && (fromAcct === 'stock' || tags.includes('#stock'));

  return isStockToLend || isExplicitLentTag || isLentDescription;
}

/**
 * Determines whether a transaction is an ordinary Cash/Bank/Wallet loan to Lend.
 * These must be strictly excluded from the Stock Lending Debt tracker.
 */
export function isCashLoanTransaction(txn = {}) {
  const fromAcct = (txn.FromAccount || txn.Account || txn.account || txn.from_account || '').trim().toLowerCase();
  const toAcct = (txn.ToAccount || txn.to_account || '').trim().toLowerCase();
  const cat = (txn.Category || txn.category || '').trim().toLowerCase();
  const tags = (txn.Tags || txn.tags || '').toLowerCase();

  const isLendTarget = toAcct === 'lend' || cat === 'lend';
  if (!isLendTarget) return false;

  // If source is Stock or carries physical stock tags, it is a stock loan, not a cash loan
  if (fromAcct === 'stock' || tags.includes('#stock_ref_') || tags.includes('#stock')) {
    return false;
  }

  return true;
}

/**
 * Determines whether a transaction is a physical return of lent stock back to Stock account.
 * Criteria:
 *  - From Lend to Stock (or tagged #return and #stock)
 */
export function isStockReturnTransaction(txn = {}) {
  const fromAcct = (txn.FromAccount || txn.Account || txn.account || txn.from_account || '').trim().toLowerCase();
  const toAcct = (txn.ToAccount || txn.to_account || '').trim().toLowerCase();
  const tags = (txn.Tags || txn.tags || '').toLowerCase();
  const desc = (txn.Description || txn.description || '').trim().toLowerCase();

  const isLendToStock = fromAcct === 'lend' && toAcct === 'stock';
  const isReturnTag = tags.includes('#return') && (toAcct === 'stock' || tags.includes('#stock'));
  const isReturnDesc = desc.startsWith('returned ') && (toAcct === 'stock' || tags.includes('#stock'));

  return isLendToStock || isReturnTag || isReturnDesc;
}

/**
 * Determines whether a transaction is an incoming debt repayment from Lend.
 * Criteria:
 *  - From Lend to a non-Stock account (Bank, Cash, Wallet).
 */
export function isRepaymentTransaction(txn = {}) {
  const fromAcct = (txn.FromAccount || txn.Account || txn.account || txn.from_account || '').trim().toLowerCase();
  const toAcct = (txn.ToAccount || txn.to_account || '').trim().toLowerCase();
  return fromAcct === 'lend' && toAcct !== 'stock' && toAcct !== '';
}

/**
 * Extracts product name and physical quantity from a stock loan transaction.
 */
function extractLoanProductDetails(txn, batches = []) {
  const tags = txn.Tags || txn.tags || '';
  const desc = txn.Description || txn.description || '';
  const inrAmt = parseFloat(txn.INR || txn.Amount || txn.inr || txn.amount || 0);

  let batchId = '';
  let refQty = 1;
  const refMatch = tags.match(/#stock_ref_([^\s,;:]+)(?::([\d.]+))?/);
  if (refMatch) {
    batchId = refMatch[1];
    if (refMatch[2]) refQty = parseFloat(refMatch[2]);
  }

  // Look up matched batch from batches if provided
  const matchedBatch = batches.find(b => b.batchId === batchId || b.id === batchId);

  let rawName = '';
  let qty = refQty;
  let unit = matchedBatch?.unit || 'pcs';
  let variant = matchedBatch?.variant || '';

  // Extract from description if present: "Lent <qty> <unit> of <product>"
  const descMatch = desc.match(/(?:Lent|Used)\s+([\d/.\s\w]+)\s+of\s+([^(]+?)(?:\s*\(|$)/i);
  if (descMatch) {
    rawName = cleanRawItemName(descMatch[2].trim());
    const descStockInfo = parseDescriptionStockInfo(desc);
    if (descStockInfo && !isNaN(descStockInfo.qty) && descStockInfo.qty > 0) {
      qty = descStockInfo.qty;
      if (descStockInfo.unit) unit = descStockInfo.unit;
    }
  }

  if (!rawName && matchedBatch) {
    rawName = matchedBatch.cleanedName || matchedBatch.rawName || matchedBatch.canonicalProduct || '';
  }
  if (!rawName) {
    rawName = 'Stock Item';
  }

  const canonicalProduct = getCanonicalProductName(rawName);

  // Unit price calculation and confidence
  let unitPrice = 0;
  let unitPriceEstimated = false;

  if (matchedBatch && matchedBatch.unitPrice > 0) {
    unitPrice = matchedBatch.unitPrice;
  } else if (qty > 0 && inrAmt > 0) {
    unitPrice = Math.round((inrAmt / qty) * 100) / 100;
  } else {
    unitPrice = inrAmt;
    unitPriceEstimated = true;
  }

  return {
    productName: rawName,
    canonicalProduct,
    batchId,
    variant,
    lentQty: qty,
    unit,
    unitPrice,
    unitPriceEstimated
  };
}

/**
 * Core Pure Engine: Reconciles all physical stock loans, evidence-backed repayments,
 * physical returns, and unassigned repayments across a transaction array.
 *
 * @param {Object} params
 * @param {Array} params.transactions - Full transactions array
 * @param {Array} [params.batches=[]] - Optional normalized inventory batches
 * @returns {Object} Deterministic reconciliation result
 */
export function reconcileStockLendingDebts({ transactions = [], batches = [] } = {}) {
  const loans = [];
  const rawRepayments = [];
  const rawReturns = [];

  // 1. Separate loans, returns, and repayments; completely ignore ordinary cash loans
  for (const txn of transactions) {
    if (isCashLoanTransaction(txn)) {
      continue; // Strict isolation: never count Cash/Bank -> Lend as stock loans
    }
    if (isStockReturnTransaction(txn)) {
      rawReturns.push(txn);
    } else if (isRepaymentTransaction(txn)) {
      rawRepayments.push(txn);
    } else if (isStockLoanTransaction(txn)) {
      const loanId = txn.ID || txn.id;
      const borrower = extractPersonName(txn.Note || txn.note || '') || 'Unknown';
      const date = txn.Date || txn.date || '';
      const isoDate = toIsoDate(date);
      const originalValue = parseFloat(txn.INR || txn.Amount || txn.inr || txn.amount || 0);

      const productDetails = extractLoanProductDetails(txn, batches);

      loans.push({
        loanId,
        date,
        isoDate,
        borrower,
        productName: productDetails.productName,
        canonicalProduct: productDetails.canonicalProduct,
        batchId: productDetails.batchId,
        variant: productDetails.variant,
        unit: productDetails.unit,
        lentQty: productDetails.lentQty,
        returnedQty: 0,
        physicalOutstandingQty: productDetails.lentQty,
        originalValue,
        unitPrice: productDetails.unitPrice,
        unitPriceEstimated: productDetails.unitPriceEstimated,
        confirmedRepaidValue: 0,
        returnedValue: 0,
        outstandingValue: originalValue,
        status: 'pending', // 'pending' | 'partial' | 'settled'
        confirmedRepayments: [],
        physicalReturns: [],
        suggestedRepayments: [],
        sourceTxn: txn
      });
    }
  }

  // Create fast lookup map for loans by loanId
  const loanMap = new Map();
  for (const loan of loans) {
    loanMap.set(loan.loanId, loan);
  }

  // Track allocation capacities of repayments to prevent double counting
  const repaymentAllocations = new Map();
  for (const rep of rawRepayments) {
    const repId = rep.ID || rep.id;
    const repAmt = parseFloat(rep.INR || rep.Amount || rep.inr || rep.amount || 0);
    repaymentAllocations.set(repId, {
      totalAmount: repAmt,
      allocatedAmount: 0,
      txn: rep
    });
  }

  // 2. Process Physical Returns (Lend -> Stock)
  // Physical returns restore inventory and reduce monetary debt
  for (const retTxn of rawReturns) {
    const retId = retTxn.ID || retTxn.id;
    const retTags = retTxn.Tags || retTxn.tags || '';
    const retDesc = retTxn.Description || retTxn.description || '';
    const retDate = retTxn.Date || retTxn.date || '';
    const borrower = extractPersonName(retTxn.Note || retTxn.note || '');

    // Check for explicit loan reference in tags
    const debtRefs = parseStockDebtRefTags(retTags);
    let targetLoan = null;

    if (debtRefs.length > 0) {
      targetLoan = loanMap.get(debtRefs[0].loanTxnId);
    }

    // Fallback: match by borrower and product if unambiguous
    if (!targetLoan && borrower) {
      const descMatch = retDesc.match(/(?:Returned|Return)\s+([\d/.\s\w]+)\s+of\s+([^(]+)/i);
      const productWord = descMatch ? cleanRawItemName(descMatch[2].trim()).toLowerCase() : '';
      const candidateLoans = loans.filter(l => {
        const bMatch = l.borrower.toLowerCase() === borrower.toLowerCase();
        if (!bMatch) return false;
        if (productWord) {
          return l.productName.toLowerCase().includes(productWord) ||
                 l.canonicalProduct.toLowerCase().includes(productWord);
        }
        return true;
      });
      if (candidateLoans.length === 1) {
        targetLoan = candidateLoans[0];
      }
    }

    // Determine returned quantity
    let returnedQty = 1;
    const descInfo = parseDescriptionStockInfo(retDesc);
    if (descInfo && descInfo.qty > 0) {
      returnedQty = descInfo.qty;
    } else {
      const refMatch = retTags.match(/#stock_ref_[^\s,;:]+:([\d.]+)/);
      if (refMatch) returnedQty = parseFloat(refMatch[1]);
    }

    if (targetLoan) {
      const effectiveReturnedQty = Math.min(returnedQty, targetLoan.physicalOutstandingQty);
      const creditVal = Math.round(effectiveReturnedQty * targetLoan.unitPrice * 100) / 100;
      const effectiveCredit = Math.min(creditVal, targetLoan.outstandingValue);

      targetLoan.returnedQty += effectiveReturnedQty;
      targetLoan.physicalOutstandingQty = Math.max(0, targetLoan.physicalOutstandingQty - effectiveReturnedQty);
      targetLoan.returnedValue += effectiveCredit;
      targetLoan.outstandingValue = Math.max(0, Math.round((targetLoan.outstandingValue - effectiveCredit) * 100) / 100);

      targetLoan.physicalReturns.push({
        returnTxnId: retId,
        date: retDate,
        qty: effectiveReturnedQty,
        creditValue: effectiveCredit,
        evidence: `Physical return from ${borrower || 'borrower'}; inventory restored +${effectiveReturnedQty} ${targetLoan.unit}.`
      });
    }
  }

  // 3. Process Confirmed Monetary Repayments (via explicit #stock_debt_ref_<loanTxnId> tags)
  for (const rep of rawRepayments) {
    const repId = rep.ID || rep.id;
    const tags = rep.Tags || rep.tags || '';
    const repRefs = parseStockDebtRefTags(tags);
    if (repRefs.length === 0) continue;

    const repAlloc = repaymentAllocations.get(repId);
    if (!repAlloc) continue;

    for (const ref of repRefs) {
      const targetLoan = loanMap.get(ref.loanTxnId);
      if (!targetLoan) {
        // Tag references a nonexistent or deleted loan; will surface in unassigned
        continue;
      }

      const availableToAllocate = repAlloc.totalAmount - repAlloc.allocatedAmount;
      if (availableToAllocate <= 0) break;

      let amountToAllocate = ref.amount !== null
        ? Math.min(ref.amount, availableToAllocate)
        : Math.min(availableToAllocate, targetLoan.outstandingValue);

      amountToAllocate = Math.min(amountToAllocate, targetLoan.outstandingValue);
      amountToAllocate = Math.round(amountToAllocate * 100) / 100;

      if (amountToAllocate > 0) {
        targetLoan.confirmedRepaidValue += amountToAllocate;
        targetLoan.outstandingValue = Math.max(0, Math.round((targetLoan.outstandingValue - amountToAllocate) * 100) / 100);
        repAlloc.allocatedAmount += amountToAllocate;

        targetLoan.confirmedRepayments.push({
          repaymentTxnId: repId,
          date: rep.Date || rep.date || '',
          amount: amountToAllocate,
          source: 'tag',
          evidence: `Explicit verified tag: #stock_debt_ref_${targetLoan.loanId}${ref.amount ? `:${ref.amount}` : ''}`
        });
      }
    }
  }

  // 4. Process Suggestions and Unassigned Repayments
  // Repayments without explicit #stock_debt_ref_ must NEVER be silently applied.
  const unassignedRepayments = [];

  for (const rep of rawRepayments) {
    const repId = rep.ID || rep.id;
    const repAlloc = repaymentAllocations.get(repId);
    const unallocatedAmount = repAlloc
      ? Math.round((repAlloc.totalAmount - repAlloc.allocatedAmount) * 100) / 100
      : parseFloat(rep.INR || rep.Amount || 0);

    if (unallocatedAmount <= 0.005) {
      continue; // Fully allocated via explicit tags
    }

    const borrower = extractPersonName(rep.Note || rep.note || '') || 'Unknown';
    const repDate = rep.Date || rep.date || '';
    const repIsoDate = toIsoDate(repDate);
    const repDesc = (rep.Description || rep.description || '').trim();
    const repDescLower = repDesc.toLowerCase();

    // Check if repayment explicitly names a stock product in Description
    let candidateLoans = loans.filter(l => l.borrower.toLowerCase() === borrower.toLowerCase());
    let explicitProductMatchLoan = null;

    if (repDesc) {
      // Find all loans for this borrower that match the product text
      const matchingLoans = [];
      for (const loan of candidateLoans) {
        const prodWords = loan.productName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const canonWords = loan.canonicalProduct.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const allKeywords = [...new Set([...prodWords, ...canonWords])];

        const mentionsProduct = allKeywords.some(kw => repDescLower.includes(kw));
        if (mentionsProduct) {
          const loanTime = loan.isoDate ? new Date(loan.isoDate).getTime() : 0;
          const repTime = repIsoDate ? new Date(repIsoDate).getTime() : 0;
          const diffDays = (repTime - loanTime) / (1000 * 60 * 60 * 24);
          matchingLoans.push({ loan, diffDays });
        }
      }

      if (matchingLoans.length > 0) {
        // Sort matching loans:
        // 1. Prefer loans on or before repayment (diffDays >= 0)
        // 2. Or near-advance loans where repayment preceded by <= 30 days (diffDays >= -30)
        // 3. Closest in time
        matchingLoans.sort((a, b) => {
          const aValid = a.diffDays >= -30;
          const bValid = b.diffDays >= -30;
          if (aValid && !bValid) return -1;
          if (!aValid && bValid) return 1;
          return Math.abs(a.diffDays) - Math.abs(b.diffDays);
        });

        // Only attach if it's within a plausible window (diffDays >= -30, or repayment after loan)
        if (matchingLoans[0].diffDays >= -30) {
          explicitProductMatchLoan = matchingLoans[0].loan;
        }
      }
    }

    if (explicitProductMatchLoan) {
      // Repayment explicitly mentions the product!
      // Check date sequence: Does repayment precede the loan?
      const loanIsoDate = explicitProductMatchLoan.isoDate;
      const isDatePreceding = repIsoDate && loanIsoDate && repIsoDate < loanIsoDate;

      const reason = isDatePreceding
        ? 'DATE_PRECEDES_LOAN'
        : 'EXPLICIT_PRODUCT_TEXT_MATCH';

      explicitProductMatchLoan.suggestedRepayments.push({
        repaymentTxnId: repId,
        date: repDate,
        amount: unallocatedAmount,
        reason,
        confidence: isDatePreceding ? 'medium' : 'high',
        evidence: `Repayment description mentions "${repDesc}"; counterparty "${borrower}" matches.`
      });

      unassignedRepayments.push({
        txnId: repId,
        date: repDate,
        isoDate: repIsoDate,
        borrower,
        amount: repAlloc.totalAmount,
        unallocatedAmount,
        note: rep.Note || rep.note || '',
        description: repDesc,
        reason: isDatePreceding
          ? 'SUGGESTED_MATCH_DATE_ANOMALY (Repayment precedes recorded loan)'
          : 'SUGGESTED_MATCH_REQUIRES_CONFIRMATION',
        candidateLoanIds: [explicitProductMatchLoan.loanId],
        rawTxn: rep
      });
    } else {
      // Generic repayment: no product mention in description (or empty description)
      // Strict Safeguard: NEVER allocate based only on amount or borrower name!
      // Keep completely unassigned
      const amountMatchingLoans = candidateLoans.filter(l => Math.abs(l.outstandingValue - unallocatedAmount) < 0.01);

      unassignedRepayments.push({
        txnId: repId,
        date: repDate,
        isoDate: repIsoDate,
        borrower,
        amount: repAlloc.totalAmount,
        unallocatedAmount,
        note: rep.Note || rep.note || '',
        description: repDesc,
        reason: amountMatchingLoans.length > 0
          ? 'UNASSIGNED_AMOUNT_MATCH_NO_PRODUCT_TEXT'
          : 'UNASSIGNED_GENERIC_REPAYMENT',
        candidateLoanIds: amountMatchingLoans.map(l => l.loanId),
        rawTxn: rep
      });
    }
  }

  // 5. Finalize Loan Settlement Status
  for (const loan of loans) {
    if (loan.outstandingValue <= 0.005) {
      loan.status = 'settled';
      loan.outstandingValue = 0;
    } else if (loan.confirmedRepaidValue > 0 || loan.returnedValue > 0) {
      loan.status = 'partial';
    } else {
      loan.status = 'pending';
    }
  }

  // 6. Build Borrower Grouped Ledgers
  const borrowerLedgerMap = new Map();
  for (const loan of loans) {
    const bKey = loan.borrower.toLowerCase();
    if (!borrowerLedgerMap.has(bKey)) {
      borrowerLedgerMap.set(bKey, {
        borrower: loan.borrower,
        totalLentValue: 0,
        totalRepaidValue: 0,
        totalReturnedValue: 0,
        netOutstandingValue: 0,
        loansCount: 0,
        pendingLoansCount: 0,
        loanIds: []
      });
    }
    const bLedger = borrowerLedgerMap.get(bKey);
    bLedger.totalLentValue += loan.originalValue;
    bLedger.totalRepaidValue += loan.confirmedRepaidValue;
    bLedger.totalReturnedValue += loan.returnedValue;
    bLedger.netOutstandingValue += loan.outstandingValue;
    bLedger.loansCount += 1;
    if (loan.status !== 'settled') {
      bLedger.pendingLoansCount += 1;
    }
    bLedger.loanIds.push(loan.loanId);
  }

  const borrowerLedgers = Array.from(borrowerLedgerMap.values()).map(b => ({
    ...b,
    totalLentValue: Math.round(b.totalLentValue * 100) / 100,
    totalRepaidValue: Math.round(b.totalRepaidValue * 100) / 100,
    totalReturnedValue: Math.round(b.totalReturnedValue * 100) / 100,
    netOutstandingValue: Math.round(b.netOutstandingValue * 100) / 100
  })).sort((a, b) => b.netOutstandingValue - a.netOutstandingValue);

  // 7. Global Summary
  const totalLentValue = Math.round(loans.reduce((s, l) => s + l.originalValue, 0) * 100) / 100;
  const totalConfirmedRepaidValue = Math.round(loans.reduce((s, l) => s + l.confirmedRepaidValue, 0) * 100) / 100;
  const totalReturnedValue = Math.round(loans.reduce((s, l) => s + l.returnedValue, 0) * 100) / 100;
  const totalOutstandingValue = Math.round(loans.reduce((s, l) => s + l.outstandingValue, 0) * 100) / 100;
  const unassignedRepaymentsValue = Math.round(unassignedRepayments.reduce((s, r) => s + r.unallocatedAmount, 0) * 100) / 100;
  const suggestedMatchesCount = loans.reduce((s, l) => s + l.suggestedRepayments.length, 0);

  // Deterministic sorting of loans (by ISO date descending, then loanId ascending)
  loans.sort((a, b) => {
    if (a.isoDate !== b.isoDate) return b.isoDate.localeCompare(a.isoDate);
    return a.loanId.localeCompare(b.loanId);
  });

  return {
    summary: {
      totalLoansCount: loans.length,
      totalLentValue,
      totalConfirmedRepaidValue,
      totalReturnedValue,
      totalOutstandingValue,
      totalSettledLoansCount: loans.filter(l => l.status === 'settled').length,
      totalPendingLoansCount: loans.filter(l => l.status !== 'settled').length,
      unassignedRepaymentsCount: unassignedRepayments.length,
      unassignedRepaymentsValue,
      suggestedMatchesCount
    },
    loans,
    unassignedRepayments,
    borrowerLedgers
  };
}
