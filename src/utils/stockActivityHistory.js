/**
 * stockActivityHistory.js — Item Activity & Transaction History Engine for FinMan Stock Inventory
 * 
 * Accurately extracts, normalizes, links, and orders all financial and physical
 * movements for an individual stock product or purchase batch:
 *   - Purchases (Stock In)
 *   - Consumptions / Uses (Stock Out)
 *   - Lending (Stock Out to Person)
 *   - Returns / Repayments (Stock In or Debt Settle)
 *   - Installment Payments (Financial vs Physical Separation)
 * 
 * Computes chronological running quantity balances without cross-talking between
 * similarly named products or double-counting historical baselines.
 */

import {
  cleanRawItemName,
  getCanonicalProductName,
  resolveTargetBatch,
  parseDescriptionStockInfo
} from './stockInventoryNormalization.js';
import {
  aggregateProductPhysicalQuantities,
  calculateBatchPhysicalDetails
} from './stockPhysicalQuantity.js';
import { formatINR } from './format.js';

export const formatFraction = (val) => {
  if (val === 0 || !val) return '0';
  const integerPart = Math.floor(val);
  const decimalPart = val - integerPart;

  if (decimalPart < 0.005) {
    return String(integerPart);
  }
  if (Math.abs(decimalPart - 1) < 0.005) {
    return String(integerPart + 1);
  }

  const epsilon = 0.01;
  const fractions = [
    { dec: 0.5, frac: '1/2' },
    { dec: 0.25, frac: '1/4' },
    { dec: 0.75, frac: '3/4' },
    { dec: 1 / 3, frac: '1/3' },
    { dec: 2 / 3, frac: '2/3' },
    { dec: 1 / 8, frac: '1/8' },
    { dec: 3 / 8, frac: '3/8' },
    { dec: 5 / 8, frac: '5/8' },
    { dec: 7 / 8, frac: '7/8' },
    { dec: 0.2, frac: '1/5' },
    { dec: 0.4, frac: '2/5' },
    { dec: 0.6, frac: '3/5' },
    { dec: 0.8, frac: '4/5' },
    { dec: 1 / 6, frac: '1/6' },
    { dec: 5 / 6, frac: '5/6' },
  ];

  for (const item of fractions) {
    if (Math.abs(decimalPart - item.dec) < epsilon) {
      return integerPart > 0 ? `${integerPart} ${item.frac}` : item.frac;
    }
  }

  return String(parseFloat(val.toFixed(3)));
};

export const getDiscreteUnitLabel = (qty, batchOrUnit) => {
  const absQty = Math.abs(qty);
  const isSingular = Math.abs(absQty - 1) < 0.001;

  if (typeof batchOrUnit === 'object' && batchOrUnit !== null) {
    const hasPhysical = Boolean(batchOrUnit.sub_unit || (batchOrUnit.unit && ['kg', 'g', 'l', 'ml'].includes(batchOrUnit.unit.toLowerCase())));
    if (hasPhysical) {
      return isSingular ? 'pack' : 'packs';
    }
    const rawUnit = (batchOrUnit.unit || 'pcs').toLowerCase();
    if (['pack', 'packs', 'box', 'boxes', 'bottle', 'bottles', 'can', 'cans', 'tin', 'tins'].includes(rawUnit)) {
      return isSingular ? (rawUnit.endsWith('s') ? rawUnit.slice(0, -1) : rawUnit) : (rawUnit.endsWith('s') ? rawUnit : `${rawUnit}s`);
    }
    return isSingular ? 'pack' : 'packs';
  }

  const str = String(batchOrUnit || 'pcs').toLowerCase();
  if (['kg', 'g', 'l', 'ml'].includes(str)) {
    return isSingular ? 'pack' : 'packs';
  }
  return str === 'pcs' || str === 'pc' ? 'pcs' : (isSingular ? str : `${str}s`);
};


export const extractPersonName = (rawNote) => {
  if (!rawNote) return '';
  let s = rawNote.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
  s = s.replace(/^(to\s*:?|from\s*:?|lend\s*to\s*:?|lend\s*from\s*:?|borrow\s*from\s*:?|given\s*to\s*:?|received\s*from\s*:?|return\s*from\s*:?|repay\s*to\s*:?|paid\s*to\s*:?)\s+/i, '');
  s = s.replace(/\s+(return|settlement|repayment|lent|borrowed|advance)$/i, '');
  return s.trim();
};

/**
 * Standardize date to YYYY-MM-DD
 */
export const toIsoDate = (rawDate) => {
  if (!rawDate) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return rawDate;
  if (rawDate.includes('/')) {
    const parts = rawDate.split('/');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }
  const d = new Date(rawDate);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split('T')[0];
  }
  return String(rawDate);
};

/**
 * Extract item activity timeline and summary metrics for a given product or batch
 * 
 * @param {Object} params
 * @param {string} params.productName - Canonical or raw name of the target product
 * @param {string} [params.selectedBatchId] - Optional batchId to filter strictly to one batch
 * @param {Array} [params.transactions=[]] - All state transactions
 * @param {Array} [params.inventoryItems=[]] - Current SQLite/IDB inventory rows
 * @param {Array} [params.batches=[]] - Normalized batches from extractNormalizedBatchesFromTransactions
 * @returns {Object} Activity result with summary, activities, and unmatched/ambiguous records
 */
export function extractProductStockActivity({
  productName = '',
  selectedBatchId = null,
  transactions = [],
  inventoryItems = [],
  batches = []
}) {
  if (!productName && !selectedBatchId) {
    return {
      summary: {
        productName: 'Unknown Item',
        totalBatches: 0,
        totalPurchasedQty: 0,
        totalConsumedQty: 0,
        totalLentQty: 0,
        totalReturnedQty: 0,
        currentRemainingQty: 0,
        outstandingLentQty: 0,
        unit: 'pcs',
        subUnit: '',
        status: 'Out of Stock',
        totalPurchaseValue: 0,
        currentRemainingValue: 0
      },
      activities: [],
      unmatchedRecords: []
    };
  }

  const targetCanon = productName ? getCanonicalProductName(productName).toLowerCase() : '';
  const targetClean = productName ? cleanRawItemName(productName).toLowerCase() : '';

  // 1. Identify all batches matching this product or specific batchId
  const matchingBatches = batches.filter(b => {
    if (selectedBatchId) {
      return b.batchId === selectedBatchId || b.id === selectedBatchId || b.altBatchId === selectedBatchId;
    }
    const bCanon = (b.canonicalProduct || getCanonicalProductName(b.cleanedName || b.rawName)).toLowerCase();
    const bClean = cleanRawItemName(b.cleanedName || b.rawName || '').toLowerCase();
    return bCanon === targetCanon || bClean === targetClean;
  });

  const matchingBatchIds = new Set(matchingBatches.map(b => b.batchId).concat(matchingBatches.map(b => b.id)));
  const matchingBatchTxnIds = new Set(matchingBatches.map(b => b.txnUniqueId).filter(Boolean));

  // Determine standard primary unit from matching batches
  const primaryUnit = matchingBatches[0]?.unit || 'pcs';
  const primarySubUnit = matchingBatches[0]?.sub_unit || '';
  const resolvedProductName = matchingBatches[0]?.canonicalProduct || productName || 'Stock Item';

  const activities = [];
  const unmatchedRecords = [];
  const processedTxnRefPairs = new Set(); // Prevent duplicate deduction activities

  // 2. Add Purchase (Stock In) Activities from batches
  matchingBatches.forEach(b => {
    const purchasedQty = parseFloat(b.purchasedQty || b.original_qty || b.pack_qty || 1) || 1;
    const unitPrice = parseFloat(b.unitPrice || 0);
    const paidAmt = parseFloat(b.paid || (unitPrice * purchasedQty));
    const store = (b.source || '').trim();
    const isoDate = toIsoDate(b.purchasedDate || b.rawDate);
    const rawTxn = b.originalTxn || (transactions || []).find(t => (t.id || t.ID || t._id) === b.txnUniqueId);
    const fromAcct = (rawTxn?.Account || rawTxn?.FromAccount || '').trim();
    const toAcct = (rawTxn?.ToAccount || '').trim();
    const txnTags = (rawTxn?.Tags || rawTxn?.tags || '').toLowerCase();
    const isToStock = toAcct.toLowerCase() === 'stock';

    let classificationStatus = 'verified';
    let financialRole = 'Transfer-Out to Stock';
    let inventoryRole = 'Stock Purchase / Stock In';
    let classificationExplanation = '';

    if (isToStock) {
      financialRole = `Transfer-Out (${fromAcct || 'Funding Account'} ➔ Stock)`;
      inventoryRole = 'Stock Purchase / Stock In';
      classificationExplanation = `Funded from ${fromAcct || 'payment account'} and deposited into Stock Asset Account.`;
    } else if (txnTags.includes('#stock')) {
      financialRole = `Stock Account Posting (${fromAcct || 'Account'} ➔ ${toAcct || 'Stock'})`;
      inventoryRole = 'Stock Replenishment / Inflow';
      classificationExplanation = 'Verified by structured #stock inventory tag.';
    } else {
      classificationStatus = 'needs_review';
      classificationExplanation = 'Transaction description contains stock keywords, but structured account direction is unverified.';
    }

    const physDetails = calculateBatchPhysicalDetails(b);
    const unitLabel = getDiscreteUnitLabel(purchasedQty, b);
    const countStr = formatFraction(purchasedQty);
    const physStr = physDetails.isConfident && physDetails.purchasedPhysical ? ` (${formatFraction(physDetails.purchasedPhysical)} ${physDetails.unit})` : '';

    activities.push({
      id: `purchase_${b.batchId}`,
      txnId: b.txnUniqueId || b.batchId,
      date: isoDate,
      rawDate: b.rawDate || isoDate,
      time: rawTxn?.Time || rawTxn?.time || '12:00',
      type: 'purchase',
      typeLabel: 'Purchased / Stock In',
      classificationStatus,
      financialRole,
      inventoryRole,
      classificationExplanation,
      moneyMovedStr: isToStock ? `${fromAcct || 'Account'} → Stock` : (fromAcct ? `${fromAcct} → ${toAcct || 'Stock'}` : 'Stock Asset Account'),
      stockMovementShort: `Stock added: +${countStr} ${unitLabel}${physStr}`,
      fromAccount: fromAcct,
      toAccount: toAcct || 'Stock',
      isPhysical: true,
      isFinancial: true,
      qtyDelta: purchasedQty,
      qtyStr: `+${countStr} ${unitLabel}${physStr}`,
      physicalStr: '',
      unit: unitLabel,
      amount: paidAmt,
      unitPrice,
      mrp: parseFloat(b.mrp || 0),
      store: store && store !== 'Unknown' && store !== 'manual' ? store : '',
      person: '',
      installmentInfo: null,
      batchId: b.batchId,
      batchDate: isoDate,
      batchSource: store,
      variant: b.variant || 'Standard',
      description: rawTxn?.Description || rawTxn?.description || `Purchased ${countStr} ${unitLabel}${physStr}`,
      note: rawTxn?.Note || rawTxn?.note || '',
      rawTxn
    });
  });

  // 3. Scan transactions for Consumptions, Lendings, Returns, and Installments
  transactions.forEach(txn => {
    const txnId = txn.id || txn.ID || txn._id || '';
    const tags = txn.Tags || txn.tags || txn.Tag || '';
    const desc = txn.Description || txn.description || '';
    const rawNote = txn.Note || txn.note || '';
    const isoDate = toIsoDate(txn.Date || txn.date);
    const time = txn.Time || txn.time || '12:00';
    const inrAmt = parseFloat(txn.INR || txn.inr || txn.Amount || txn.amount || 0);
    const isLendCategory = (txn.Category || '').toLowerCase() === 'lend' || (txn.ToAccount || '').toLowerCase() === 'lend' || tags.includes('#lent');
    const isReturnCategory = tags.includes('#return') || desc.toLowerCase().includes('returned') || (txn.FromAccount === 'Lend' && txn.ToAccount === 'Stock');

    // Case A: Dynamic transactions referencing batches via #stock_ref_<refId>:<qty>
    if (tags.includes('#stock_ref_')) {
      const refRegex = /#stock_ref_([^\s,;:]+)(?::([\d\.]+))?/g;
      let match;
      let matchedAnyThisTxn = false;

      while ((match = refRegex.exec(tags)) !== null) {
        const refId = match[1];
        const rawQty = match[2] ? parseFloat(match[2]) : 1;
        const targetBatch = resolveTargetBatch(refId, txn, batches, null);

        if (targetBatch && matchingBatchIds.has(targetBatch.batchId || targetBatch.id)) {
          matchedAnyThisTxn = true;
          const pairKey = `${txnId}_${refId}`;
          if (processedTxnRefPairs.has(pairKey)) continue;
          processedTxnRefPairs.add(pairKey);

          // Handle single-reference explicit quantity override if present in description
          let effectiveQty = rawQty;
          const descInfo = parseDescriptionStockInfo(desc);
          if (descInfo && !isNaN(descInfo.qty) && descInfo.qty > 0) {
            const bClean = (targetBatch.cleanedName || targetBatch.rawName || targetBatch.canonicalProduct || '').toLowerCase();
            const descNameMatch = desc.match(/(?:Used|Lent|Instalment Use)\s+[\d\/\.\s\w]+\s+of\s+([^(]+?)(?:\s*\(|$)/i);
            const descItemName = descNameMatch ? cleanRawItemName(descNameMatch[1].trim()).toLowerCase() : '';
            if (descItemName && (bClean.includes(descItemName) || descItemName.includes(bClean))) {
              if (targetBatch.sub_qty > 0 && descInfo.unit === targetBatch.sub_unit) {
                effectiveQty = descInfo.qty / targetBatch.sub_qty;
              } else {
                effectiveQty = descInfo.qty;
              }
            }
          }

          const person = extractPersonName(rawNote);
          const unitLabel = getDiscreteUnitLabel(effectiveQty, targetBatch || primaryUnit);
          const countStr = formatFraction(effectiveQty);
          const physDetails = targetBatch ? calculateBatchPhysicalDetails(targetBatch) : null;
          const physStr = physDetails?.isConfident && physDetails.unitPhysicalQty
            ? ` (${formatFraction(effectiveQty * physDetails.unitPhysicalQty)} ${physDetails.unit})`
            : '';

          if (isReturnCategory) {
            activities.push({
              id: `return_${txnId}_${refId}`,
              txnId,
              date: isoDate,
              rawDate: txn.Date || txn.date || isoDate,
              time,
              type: 'return',
              typeLabel: 'Returned to Stock',
              classificationStatus: 'verified',
              financialRole: 'Asset Transfer (Lend ➔ Stock)',
              inventoryRole: 'Stock Restoration (Physical Return)',
              classificationExplanation: `Returned from ${person || 'borrower'} and restored to physical stock.`,
              moneyMovedStr: `${txn.FromAccount || 'Lend'} → ${txn.ToAccount || 'Stock'}`,
              stockMovementShort: `Stock returned: +${countStr} ${unitLabel}${physStr}`,
              fromAccount: txn.FromAccount || 'Lend',
              toAccount: txn.ToAccount || 'Stock',
              isPhysical: true,
              isFinancial: false,
              qtyDelta: Math.abs(effectiveQty),
              qtyStr: `+${countStr} ${unitLabel}${physStr}`,
              physicalStr: '',
              unit: unitLabel,
              amount: inrAmt,
              store: '',
              person: person || '',
              installmentInfo: null,
              batchId: targetBatch.batchId,
              batchDate: targetBatch.purchasedDate,
              batchSource: targetBatch.source,
              variant: targetBatch.variant,
              description: desc,
              note: rawNote,
              rawTxn: txn
            });
          } else if (isLendCategory) {
            const descLower = desc.toLowerCase();
            const isExplicitlyReceived = descLower.includes('received') || tags.includes('#settled') || tags.includes('#received');
            let financialStatus = isExplicitlyReceived ? 'settled' : 'pending';
            let financialAmountRepaid = isExplicitlyReceived ? inrAmt : 0;
            let financialAmountOwed = isExplicitlyReceived ? 0 : inrAmt;

            if (!isExplicitlyReceived && person) {
              const personRepayments = transactions.filter(t => {
                const tFrom = (t.FromAccount || t.Account || '').toLowerCase();
                const tNote = (t.Note || t.note || '').toLowerCase();
                return tFrom === 'lend' && tNote.includes(person.toLowerCase());
              });
              const totalRepaidForPerson = personRepayments.reduce((sum, t) => sum + parseFloat(t.INR || t.Amount || 0), 0);
              if (totalRepaidForPerson >= inrAmt) {
                financialStatus = 'settled';
                financialAmountRepaid = inrAmt;
                financialAmountOwed = 0;
              }
            }

            activities.push({
              id: `lend_${txnId}_${refId}`,
              txnId,
              date: isoDate,
              rawDate: txn.Date || txn.date || isoDate,
              time,
              type: 'lend',
              typeLabel: 'Lent / Stock Out',
              classificationStatus: 'verified',
              financialRole: 'Asset Transfer (Stock ➔ Lend)',
              inventoryRole: 'Stock Out (Lent to Person)',
              classificationExplanation: `Stock lent to ${person || 'borrower'}; recorded as receivable in Lend account.`,
              moneyMovedStr: `${txn.Account || txn.FromAccount || 'Stock'} → ${txn.ToAccount || 'Lend'}`,
              stockMovementShort: `Loaned to: ${person || 'Borrower'} • Financial debt: ${financialStatus === 'settled' ? 'Settled (repaid)' : `${formatINR(financialAmountOwed)} owed`}`,
              fromAccount: txn.Account || txn.FromAccount || 'Stock',
              toAccount: txn.ToAccount || 'Lend',
              isPhysical: true,
              isFinancial: true,
              qtyDelta: -Math.abs(effectiveQty),
              qtyStr: `−${countStr} ${unitLabel}${physStr} (Lent)`,
              physicalStr: '',
              unit: unitLabel,
              amount: inrAmt,
              store: '',
              person: person || 'Unspecified Person',
              installmentInfo: null,
              financialStatus,
              financialAmountRepaid,
              financialAmountOwed,
              physicalReturnQty: 0,
              physicalOutstandingQty: 0,
              batchId: targetBatch.batchId,
              batchDate: targetBatch.purchasedDate,
              batchSource: targetBatch.source,
              variant: targetBatch.variant,
              description: desc,
              note: rawNote,
              rawTxn: txn
            });
          } else {
            // Normal consumption or initial installment consumption
            const isInstalment = tags.includes('#instalment') || desc.toLowerCase().includes('instalment');
            activities.push({
              id: `consume_${txnId}_${refId}`,
              txnId,
              date: isoDate,
              rawDate: txn.Date || txn.date || isoDate,
              time,
              type: 'consume',
              typeLabel: isInstalment ? 'Instalment Use / Stock Out' : 'Consumed / Used',
              classificationStatus: 'verified',
              financialRole: `Expense (${txn.Account || txn.FromAccount || 'Stock'} ➔ ${txn.Category || 'Groceries/Home'})`,
              inventoryRole: 'Stock Out (Physical Consumption)',
              classificationExplanation: 'Stock deducted from inventory and posted as expense.',
              moneyMovedStr: `${txn.Account || txn.FromAccount || 'Stock'} → ${txn.Category || 'Groceries/Home'}`,
              stockMovementShort: `Stock consumed: −${countStr} ${unitLabel}${physStr}`,
              fromAccount: txn.Account || txn.FromAccount || 'Stock',
              toAccount: txn.ToAccount || '',
              isPhysical: true,
              isFinancial: true,
              qtyDelta: -Math.abs(effectiveQty),
              qtyStr: `−${countStr} ${unitLabel}${physStr}`,
              physicalStr: '',
              unit: unitLabel,
              amount: inrAmt,
              store: '',
              person: '',
              installmentInfo: isInstalment ? (desc.match(/Part\s+\d+\/\d+/i)?.[0] || 'Instalment') : null,
              batchId: targetBatch.batchId,
              batchDate: targetBatch.purchasedDate,
              batchSource: targetBatch.source,
              variant: targetBatch.variant,
              description: desc,
              note: rawNote,
              rawTxn: txn
            });
          }
        }
      }

      // Check if reference mentioned target product but couldn't be resolved cleanly
      if (!matchedAnyThisTxn && desc) {
        const descMatch = desc.match(/(?:Used|Lent|Instalment Use)\s+([\d\.\s\/]+)\s+(\w+)\s+of\s+([^(]+)/i);
        if (descMatch) {
          const candidate = cleanRawItemName(descMatch[3].trim()).toLowerCase();
          const candCanon = getCanonicalProductName(candidate).toLowerCase();
          if (candCanon === targetCanon || candidate === targetClean) {
            unmatchedRecords.push({
              txnId,
              date: isoDate,
              time,
              amount: inrAmt,
              reason: 'UNRESOLVED_BATCH_REFERENCE',
              reasonLabel: 'Batch Reference Not Found in Inventory',
              description: desc,
              tags,
              rawTxn: txn
            });
          }
        }
      }
      return;
    }

    // Case B: Subsequent Installment Financial Payments (Recurring parts without #stock_ref_)
    const isInstalmentFollowup = (tags.includes('#instalment') || desc.toLowerCase().includes('instalment')) &&
      !tags.includes('#stock_ref_');
    if (isInstalmentFollowup) {
      const nameMatch = desc.match(/(?:Instalment Use|Consumed)\s+[\d\/\.\s\w]+\s+of\s+([^(]+)/i);
      if (nameMatch) {
        const candidate = cleanRawItemName(nameMatch[1].trim()).toLowerCase();
        const candCanon = getCanonicalProductName(candidate).toLowerCase();
        if (candCanon === targetCanon || candidate === targetClean) {
          activities.push({
            id: `inst_pay_${txnId}`,
            txnId,
            date: isoDate,
            rawDate: txn.Date || txn.date || isoDate,
            time,
            type: 'installment_payment',
            typeLabel: 'Installment Payment (Financial)',
            classificationStatus: 'verified',
            financialRole: `Scheduled Payment (${txn.Account || txn.FromAccount || 'Account'} ➔ ${txn.Category || 'Expense'})`,
            inventoryRole: 'Financial Payment (Physical Stock Unchanged)',
            classificationExplanation: 'Scheduled installment payment part; physical inventory was already accounted for.',
            moneyMovedStr: `${txn.Account || txn.FromAccount || 'Account'} → ${txn.Category || 'Expense'}`,
            stockMovementShort: `Payment: ${formatINR(inrAmt)}`,
            fromAccount: txn.Account || txn.FromAccount || 'Stock',
            toAccount: txn.ToAccount || '',
            isPhysical: false, // Purely financial, do not decrement physical inventory twice!
            isFinancial: true,
            qtyDelta: 0,
            qtyStr: '0 (Financial Payment)',
            unit: primaryUnit,
            amount: inrAmt,
            store: '',
            person: '',
            installmentInfo: desc.match(/Part\s+\d+\/\d+/i)?.[0] || 'Scheduled Payment',
            batchId: '',
            batchDate: '',
            batchSource: '',
            variant: '',
            description: desc,
            note: rawNote,
            rawTxn: txn
          });
        }
      }
      return;
    }

    // Case C: Legacy Consumptions (pre-September 2026 without #stock_ref_)
    const isStockOut = tags.includes('#consumed') || tags.includes('#lent') || txn.Account === 'Stock' || txn.FromAccount === 'Stock';
    if (isStockOut && desc) {
      const match = desc.match(/^(Used|Lent|Instalment Use)\s+([\d\.\s\/]+)\s+(\w+)\s+of\s+([^(]+)/i);
      if (match) {
        const candidate = cleanRawItemName(match[4].trim()).toLowerCase();
        const candCanon = getCanonicalProductName(candidate).toLowerCase();
        if (candCanon === targetCanon || candidate === targetClean) {
          const qtyInfo = parseDescriptionStockInfo(desc);
          let legacyQty = qtyInfo?.qty || 1;
          const sampleBatch = matchingBatches[0];
          const phys = sampleBatch ? calculateBatchPhysicalDetails(sampleBatch) : null;
          if (qtyInfo?.unit && sampleBatch?.sub_unit && qtyInfo.unit.toLowerCase() === sampleBatch.sub_unit.toLowerCase()) {
            if (sampleBatch.sub_qty > 0 && legacyQty >= sampleBatch.sub_qty) {
              legacyQty = legacyQty / sampleBatch.sub_qty;
            }
          }
          const unitLabel = getDiscreteUnitLabel(legacyQty, sampleBatch || primaryUnit);
          const countStr = formatFraction(legacyQty);
          const physStr = phys?.isConfident && phys.unitPhysicalQty
            ? ` (${formatFraction(legacyQty * phys.unitPhysicalQty)} ${phys.unit})`
            : '';
          const legacyType = match[1].toLowerCase() === 'lent' ? 'lend' : 'consume';
          const person = extractPersonName(rawNote);

          const descLower = desc.toLowerCase();
          const isExplicitlyReceived = descLower.includes('received') || tags.includes('#settled') || tags.includes('#received');
          const financialStatus = isExplicitlyReceived ? 'settled' : 'pending';
          const financialAmountRepaid = isExplicitlyReceived ? inrAmt : 0;
          const financialAmountOwed = isExplicitlyReceived ? 0 : inrAmt;

          activities.push({
            id: `legacy_${txnId}`,
            txnId,
            date: isoDate,
            rawDate: txn.Date || txn.date || isoDate,
            time,
            type: legacyType,
            typeLabel: legacyType === 'lend' ? 'Lent / Stock Out (Legacy)' : 'Consumed / Used (Legacy)',
            classificationStatus: 'verified',
            financialRole: legacyType === 'lend' ? 'Asset Transfer (Stock ➔ Lend)' : `Expense (Stock ➔ ${txn.Category || 'Groceries'})`,
            inventoryRole: legacyType === 'lend' ? 'Stock Out (Lent to Person)' : 'Stock Out (Legacy Consumption)',
            classificationExplanation: 'Legacy transaction without modern #stock_ref_ tag.',
            moneyMovedStr: legacyType === 'lend' ? `${txn.Account || txn.FromAccount || 'Stock'} → ${txn.ToAccount || 'Lend'}` : `${txn.Account || txn.FromAccount || 'Stock'} → ${txn.Category || 'Groceries'}`,
            stockMovementShort: legacyType === 'lend' ? `Loaned to: ${person || 'Borrower'} • Financial debt: ${financialStatus === 'settled' ? 'Settled (repaid)' : `${formatINR(financialAmountOwed)} owed`}` : `Stock consumed: −${countStr} ${unitLabel}${physStr}`,
            fromAccount: txn.Account || txn.FromAccount || 'Stock',
            toAccount: txn.ToAccount || '',
            isPhysical: true,
            isFinancial: true,
            qtyDelta: -Math.abs(legacyQty),
            qtyStr: `−${countStr} ${unitLabel}${physStr}${legacyType === 'lend' ? ' (Lent)' : ''}`,
            physicalStr: '',
            unit: unitLabel,
            amount: inrAmt,
            store: '',
            person: person || '',
            installmentInfo: null,
            financialStatus,
            financialAmountRepaid,
            financialAmountOwed,
            physicalReturnQty: 0,
            physicalOutstandingQty: 0,
            batchId: 'legacy_unassigned',
            batchDate: '',
            batchSource: '',
            variant: 'Standard',
            description: desc,
            note: rawNote,
            rawTxn: txn,
            isLegacy: true
          });
        }
      }
    }
  });

  // 3.5 Reconcile Historical & Baseline Consumptions from Batches
  // For each batch, if authoritative remaining/consumed data reflects consumption that occurred
  // prior to dynamic #stock_ref_ tracking (or via manual baselines e.g. ", 7"), generate audited
  // baseline consumption records to guarantee 100% reconciliation with Stock Inventory.
  matchingBatches.forEach(b => {
    const hasAuthoritativeData = typeof b.remainingQty === 'number' || b.status === 'unavailable' || (b.explicitRemaining !== null && b.explicitRemaining !== undefined);
    if (!hasAuthoritativeData) return;

    const bPurchased = b.purchasedQty !== undefined ? b.purchasedQty : parseFloat(b.original_qty || b.pack_qty || 1) || 1;
    const bRemaining = typeof b.remainingQty === 'number'
      ? b.remainingQty
      : (b.status === 'unavailable' ? 0 : (b.explicitRemaining !== null ? b.explicitRemaining : bPurchased));
    const bTotalOut = Math.max(0, bPurchased - bRemaining);

    // Sum dynamic deductions already captured in activities for this batch
    const batchDynConsumed = activities
      .filter(a => a.type === 'consume' && (a.batchId === b.batchId || a.batchId === b.id || a.batchId === b.altBatchId))
      .reduce((sum, a) => sum + Math.abs(a.qtyDelta), 0);

    const batchDynLent = activities
      .filter(a => a.type === 'lend' && (a.batchId === b.batchId || a.batchId === b.id || a.batchId === b.altBatchId))
      .reduce((sum, a) => sum + Math.abs(a.qtyDelta), 0);

    const batchBaselineConsumed = Math.max(0, bTotalOut - batchDynConsumed - batchDynLent);

    if (batchBaselineConsumed > 0.0001) {
      const isHistoricalCutoff = b.explicitRemaining !== null && b.explicitRemaining !== undefined;
      const isFullyConsumed = bRemaining === 0 && (!b.dynamicDeductions || b.dynamicDeductions.length === 0);

      // Explicit baseline counts (last edited Aug 2026) take effect at cutoff date (2026-08-31).
      // Completed historical batches (0 remaining) are dated on their purchase date so their
      // lifecycle is self-contained without creating artificial spikes on migration date.
      const baselineDate = isHistoricalCutoff
        ? (b.purchasedDate <= '2026-08-31' ? '2026-08-31' : b.purchasedDate)
        : toIsoDate(b.purchasedDate || b.rawDate || '2026-08-31');

      const physDetails = calculateBatchPhysicalDetails(b);
      const unitPhysicalQty = physDetails.isConfident && physDetails.unitPhysicalQty ? physDetails.unitPhysicalQty : null;
      const unitLabel = getDiscreteUnitLabel(batchBaselineConsumed, b || primaryUnit);
      const countStr = formatFraction(batchBaselineConsumed);
      const physStr = unitPhysicalQty ? ` (${formatFraction(batchBaselineConsumed * unitPhysicalQty)} ${physDetails.unit})` : '';

      activities.push({
        id: `baseline_consume_${b.batchId || b.id}`,
        txnId: b.txnUniqueId || b.batchId || b.id,
        date: baselineDate,
        rawDate: b.rawDate || baselineDate,
        time: '23:59',
        type: 'consume',
        typeLabel: 'Historical Baseline Consumption',
        classificationStatus: 'verified',
        financialRole: `Historical Stock Outflow (${b.source || 'Pantry'})`,
        inventoryRole: 'Stock Out (Reconciled Baseline / Historical Usage)',
        classificationExplanation: isFullyConsumed
          ? `Entire batch of ${formatFraction(bPurchased)} ${unitLabel} consumed historically prior to dynamic tracking.`
          : `Reconciled baseline consumption (${countStr} ${unitLabel} consumed; baseline count: ${formatFraction(b.explicitRemaining)}).`,
        moneyMovedStr: 'Stock → Historical Usage',
        stockMovementShort: `Historical baseline consumption: −${countStr} ${unitLabel}${physStr}`,
        fromAccount: 'Stock',
        toAccount: 'Groceries/Home',
        isPhysical: true,
        isFinancial: false,
        qtyDelta: -Math.abs(batchBaselineConsumed),
        qtyStr: `−${countStr} ${unitLabel}${physStr} (Baseline)`,
        physicalStr: '',
        unit: unitLabel,
        amount: Math.round(batchBaselineConsumed * (b.unitPrice || 0)),
        unitPrice: b.unitPrice || 0,
        mrp: parseFloat(b.mrp || 0),
        store: b.source && b.source !== 'Unknown' && b.source !== 'manual' ? b.source : '',
        person: '',
        installmentInfo: null,
        batchId: b.batchId || b.id,
        batchDate: toIsoDate(b.purchasedDate || b.rawDate),
        batchSource: b.source,
        variant: b.variant || 'Standard',
        description: `Historical baseline consumption: −${countStr} ${unitLabel}${physStr}`,
        note: isHistoricalCutoff ? `Reconciled from manual baseline (${b.explicitRemaining})` : 'Reconciled from inventory batch record',
        rawTxn: b.originalTxn || null,
        isHistoricalBaseline: true
      });
    }
  });

  // 4. Sort activities chronologically (oldest to newest) to compute running balance
  activities.sort((a, b) => {
    // Primary: ISO Date ascending
    const cmpDate = (a.date || '').localeCompare(b.date || '');
    if (cmpDate !== 0) return cmpDate;

    // Purchases come first on the same date/time so stock is available before usage
    if (a.type === 'purchase' && b.type !== 'purchase') return -1;
    if (b.type === 'purchase' && a.type !== 'purchase') return 1;

    // Secondary: Time ascending
    const cmpTime = (a.time || '').localeCompare(b.time || '');
    if (cmpTime !== 0) return cmpTime;

    // Tertiary: ID stability
    return (a.id || '').localeCompare(b.id || '');
  });

  // 5. Compute chronological running balance
  let runningBal = 0;
  activities.forEach(act => {
    if (act.isPhysical) {
      runningBal = Math.max(0, runningBal + act.qtyDelta);
    }
    act.runningBalance = runningBal;
    const actBatch = matchingBatches.find(b => b.batchId === act.batchId || b.id === act.batchId);
    const bPhys = actBatch ? calculateBatchPhysicalDetails(actBatch) : (matchingBatches[0] ? calculateBatchPhysicalDetails(matchingBatches[0]) : null);
    const unitLabel = getDiscreteUnitLabel(runningBal, actBatch || matchingBatches[0] || primaryUnit);
    const balCountStr = formatFraction(runningBal);

    if (bPhys?.isConfident && bPhys.unitPhysicalQty) {
      act.balanceStr = `${balCountStr} ${unitLabel} (${formatFraction(runningBal * bPhys.unitPhysicalQty)} ${bPhys.unit})`;
    } else {
      act.balanceStr = `${balCountStr} ${unitLabel}`;
    }
  });

  // 6. Aggregate Summary Metrics & Physical Quantities
  let totalPurchasedQty = 0;
  let totalConsumedQty = 0;
  let totalLentQty = 0;
  let totalReturnedQty = 0;
  let totalPurchaseValue = 0;

  activities.forEach(act => {
    if (act.type === 'purchase') {
      totalPurchasedQty += act.qtyDelta;
      totalPurchaseValue += act.amount || 0;
    } else if (act.type === 'consume') {
      totalConsumedQty += Math.abs(act.qtyDelta);
    } else if (act.type === 'lend') {
      totalLentQty += Math.abs(act.qtyDelta);
    } else if (act.type === 'return') {
      totalReturnedQty += Math.abs(act.qtyDelta);
    }
  });

  // Financial debt totals on loans
  let financialDebtRepaid = 0;
  let financialDebtOwed = 0;
  activities.forEach(a => {
    if (a.type === 'lend') {
      financialDebtRepaid += a.financialAmountRepaid || 0;
      financialDebtOwed += a.financialAmountOwed || 0;
    }
  });

  // Current remaining = Purchased - Consumed - Lent + Returned
  const currentRemainingQty = Math.max(0, totalPurchasedQty - totalConsumedQty - totalLentQty + totalReturnedQty);
  const rawOutstandingLent = Math.max(0, totalLentQty - totalReturnedQty);
  const outstandingLentQty = financialDebtOwed > 0 ? rawOutstandingLent : 0;

  // Physical Quantity Aggregation (Volume L/ml, Mass kg/g, Count pcs)
  const physicalAgg = aggregateProductPhysicalQuantities(matchingBatches);
  const hasPhysicalData = Boolean(physicalAgg?.hasPhysicalData);

  // Status computation
  let status = 'In Stock';
  if (currentRemainingQty <= 0.0001) {
    status = rawOutstandingLent > 0 ? 'All Lent' : 'Out of Stock';
  } else if (rawOutstandingLent > 0) {
    status = 'Partially Lent';
  } else if (totalConsumedQty > 0.0001) {
    status = 'Partially Used';
  }

  // Unit price estimate from batches for remaining valuation
  const avgUnitPrice = totalPurchasedQty > 0 ? (totalPurchaseValue / totalPurchasedQty) : 0;
  const currentRemainingValue = Math.round(currentRemainingQty * avgUnitPrice);

  const scope = selectedBatchId ? 'batch' : 'all';
  const scopeLabel = selectedBatchId
    ? `Selected Batch (${matchingBatches[0]?.purchasedDate || ''} • ${matchingBatches[0]?.variant || 'Standard'})`
    : `All Product Batches (${matchingBatches.length} historical batches)`;

  const primaryDiscreteUnit = getDiscreteUnitLabel(currentRemainingQty, matchingBatches[0] || primaryUnit);
  const purchasedUnit = getDiscreteUnitLabel(totalPurchasedQty, matchingBatches[0] || primaryUnit);
  const consumedUnit = getDiscreteUnitLabel(totalConsumedQty, matchingBatches[0] || primaryUnit);
  const lentUnit = getDiscreteUnitLabel(totalLentQty, matchingBatches[0] || primaryUnit);
  const confidentBatches = matchingBatches.filter(b => {
    const d = calculateBatchPhysicalDetails(b);
    return d.isConfident && d.unit && d.unitPhysicalQty;
  });

  const firstUnit = confidentBatches[0] ? calculateBatchPhysicalDetails(confidentBatches[0]) : null;
  const isUniformBatchSize = confidentBatches.length > 0 && confidentBatches.every(b => {
    const d = calculateBatchPhysicalDetails(b);
    return d.unit === firstUnit.unit && Math.abs(d.unitPhysicalQty - firstUnit.unitPhysicalQty) < 0.0001;
  });
  const uniformUnit = isUniformBatchSize ? firstUnit.unit : null;
  const uniformUnitSize = isUniformBatchSize ? firstUnit.unitPhysicalQty : null;

  let purchasedPhysStr = '';
  let consumedPhysStr = '';
  let remainingPhysStr = '';
  let lentPhysStr = '';

  if (isUniformBatchSize) {
    purchasedPhysStr = totalPurchasedQty > 0 ? `${formatFraction(totalPurchasedQty * uniformUnitSize)} ${uniformUnit}` : '';
    consumedPhysStr = totalConsumedQty > 0 ? `${formatFraction(totalConsumedQty * uniformUnitSize)} ${uniformUnit}` : '';
    remainingPhysStr = currentRemainingQty > 0 ? `${formatFraction(currentRemainingQty * uniformUnitSize)} ${uniformUnit}` : '';
    lentPhysStr = totalLentQty > 0 ? `${formatFraction(totalLentQty * uniformUnitSize)} ${uniformUnit}` : '';
  } else if (hasPhysicalData) {
    purchasedPhysStr = (physicalAgg.purchasedDisplay && physicalAgg.purchasedDisplay !== '0') ? physicalAgg.purchasedDisplay : '';
    consumedPhysStr = (physicalAgg.consumedDisplay && physicalAgg.consumedDisplay !== '0') ? physicalAgg.consumedDisplay : '';
    remainingPhysStr = (physicalAgg.remainingDisplay && physicalAgg.remainingDisplay !== '0') ? physicalAgg.remainingDisplay : '';
    lentPhysStr = (matchingBatches[0]?.sub_qty && totalLentQty > 0) ? `${formatFraction(totalLentQty * matchingBatches[0].sub_qty)} ${matchingBatches[0].sub_unit || ''}`.trim() : '';
  }

  const summary = {
    productName: resolvedProductName,
    totalBatches: matchingBatches.length,
    totalPurchasedQty,
    totalConsumedQty,
    totalLentQty,
    totalReturnedQty,
    outstandingLentQty,
    physicalOutstandingLentQty: rawOutstandingLent,
    financialDebtRepaid,
    financialDebtOwed,
    currentRemainingQty,
    unit: primaryDiscreteUnit,
    subUnit: primarySubUnit,
    status,
    totalPurchaseValue,
    currentRemainingValue,
    avgUnitPrice,
    // Dual unit and physical quantity metadata
    hasPhysicalData,
    purchasedPhysical: purchasedPhysStr,
    consumedPhysical: consumedPhysStr,
    remainingPhysical: remainingPhysStr,
    lentPhysical: lentPhysStr,
    purchasedDisplay: purchasedPhysStr
      ? `${formatFraction(totalPurchasedQty)} ${purchasedUnit} (${purchasedPhysStr})`
      : `${formatFraction(totalPurchasedQty)} ${purchasedUnit}`,
    consumedDisplay: consumedPhysStr
      ? `${formatFraction(totalConsumedQty)} ${consumedUnit} (${consumedPhysStr})`
      : `${formatFraction(totalConsumedQty)} ${consumedUnit}`,
    remainingDisplay: remainingPhysStr && currentRemainingQty > 0
      ? `${formatFraction(currentRemainingQty)} ${primaryDiscreteUnit} (${remainingPhysStr})`
      : `${formatFraction(currentRemainingQty)} ${primaryDiscreteUnit}`,
    scope,
    scopeLabel,
    physicalTotals: physicalAgg?.rawTotals || null
  };

  // 7. Sort newest first (descending) by default for user display
  const timelineNewestFirst = [...activities].reverse();

  return {
    summary,
    activities: timelineNewestFirst,
    unmatchedRecords
  };
}
