/**
 * Calculate lifetime purchase and order-level savings for Stock Inventory.
 * 
 * "Saved" represents lifetime order/cart savings:
 * gross order value minus actual paid amount, plus standalone promotional
 * cashbacks recorded on Stock transactions.
 * 
 * @param {Array} transactions - List of transactions from ledger
 * @returns {Object} { totalPurchased, totalSaved, savedPercentage, savedPct, headerSavingsTotal, standaloneSavingsTotal, headerDiscountCount, standaloneDiscountCount }
 */
export function calculateLifetimePurchaseSavings(transactions) {
  let totalPurchased = 0;
  let totalSaved = 0;
  let headerSavingsTotal = 0;
  let standaloneSavingsTotal = 0;
  let headerDiscountCount = 0;
  let standaloneDiscountCount = 0;

  (transactions || []).forEach(t => {
    if ((t.ToAccount || '').trim() !== 'Stock') return;

    const paidAmt = parseFloat(t.INR || t.Amount || 0);
    totalPurchased += paidAmt;

    const desc = t.Description || '';
    const lines = desc.split('\n');
    const firstLine = (lines[0] || '').trim();

    // Check for 'with <gross>' header format
    const withMatch = firstLine.match(/with\s+([\d\.\/]+)/i);
    let hasHeaderDiscount = false;

    if (withMatch) {
      const rawGrossStr = withMatch[1];
      let parsedGross = 0;
      if (rawGrossStr.includes('/')) {
        const [num, den] = rawGrossStr.split('/');
        parsedGross = (parseFloat(num) || 0) / (parseFloat(den) || 1);
      } else {
        parsedGross = parseFloat(rawGrossStr) || 0;
      }

      if (parsedGross > paidAmt && parsedGross < 100000) {
        const savings = parsedGross - paidAmt;
        headerSavingsTotal += savings;
        totalSaved += savings;
        hasHeaderDiscount = true;
        headerDiscountCount++;
      }
    }

    // If no header discount, check for standalone promotional cashback
    if (!hasHeaderDiscount) {
      const text = ((t.Note || '') + ' ' + desc).toLowerCase();
      const cbMatch = text.match(/(\d+)\s*(?:cb|cashback|saved|discount)/i);
      if (cbMatch) {
        const standaloneVal = parseFloat(cbMatch[1]);
        if (standaloneVal > 0 && standaloneVal < 5000) {
          standaloneSavingsTotal += standaloneVal;
          totalSaved += standaloneVal;
          standaloneDiscountCount++;
        }
      }
    }
  });

  const totalCostAndSavings = totalPurchased + totalSaved;
  const savedPct = totalCostAndSavings > 0
    ? ((totalSaved / totalCostAndSavings) * 100).toFixed(1)
    : '0.0';
  const savedPercentage = parseFloat(savedPct);

  return {
    totalPurchased,
    totalSaved,
    savedPercentage,
    savedPct,
    headerSavingsTotal,
    standaloneSavingsTotal,
    headerDiscountCount,
    standaloneDiscountCount
  };
}
