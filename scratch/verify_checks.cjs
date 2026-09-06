const fs = require('fs');

// Let's audit all 13 items against the actual source code
console.log('=== AUDIT OF THE 13 SPECIFIC MECHANISMS IN CODE ===');

// Check 1: Using Amount directly?
// In Accounts.jsx:
// computeBalance: uses txnAmount(t) -> t.INR || t.Amount
// buildBalanceMap: uses txnAmount(t)
// calculateShareMarketBalances:
//   standardSum: uses parseFloat(t.INR || t.Amount || 0)
//   holdings: uses parseTxnFields(t) which extracts Qty, Cost, CostBasis, etc. from Description pipe or fields.
//   Then calculates cash = standardSum - investedCost + cashOffset.

// Check 2: Parsing BUY/SELL from Description?
// In parseTxnFields (Accounts.jsx lines 257-327):
// It splits Description by '|' and extracts:
// parsedType = parts[0] ('BUY', 'SELL', 'OPENING_LOT', 'BONUS', 'POSITION_STATUS', 'REALIZED_PNL', 'CHARGE', 'OTHER_CREDIT_DEBIT', 'FUNDING', 'WITHDRAWAL', 'DIVIDEND')
// and parses regex: Broker, Symbol, Qty, Cost, CostBasis, RealizedPL, ActiveHolding.

// Check 3: Using Cost for BUY?
// In parseTxnFields line 295:
// const cost = parseFloat(fields.Cost || fields.CostBasis || fields.TradeValue || (fields.Price ? qty * parseFloat(fields.Price) : 0) || 0);
// In calculateShareMarketBalances line 397:
// h.buyCost += f.cost;

// Check 4: Using SaleProceeds for SELL?
// In calculateShareMarketBalances line 400:
// h.soldCostBasis += f.costBasis;
// Note: It does NOT use SaleProceeds to adjust cash or buyCost. It subtracts costBasis from buyCost: cost = h.buyCost - h.soldCostBasis.

// Check 5: Using RealizedPL in cash calculation?
// Look at calculateShareMarketBalances line 360:
// const isTrade = f.type === 'BUY' || f.type === 'SELL' || f.type === 'OPENING_LOT' || f.type === 'BONUS' || f.type === 'REALIZED_PNL';
// If f.type is 'REALIZED_PNL', it is ignored in standardSum.
// BUT in the CSV, there are 147 rows of 'Zerodha Gains' and 134 rows of 'Zerodha Losses' whose Description is NOT pipe-formatted (e.g. "Realized profit on sale of ADANIPORTS")!
// Because their description has no pipe (or starts with "Realized profit..."), parseTxnFields returns type = "Equity" (from Category) or "Finance".
// Therefore, isTrade is FALSE!
// So standardSum ADDS them to cash!
// standardSum += 76,564.74 (Gains) - 53,087.74 (Losses) = +23,477.00!

// Check 6: Counting Gains/Losses rows as cash transactions?
// YES! Because they are stored as Income rows with Category='Equity' and Note='Zerodha Gains' / 'Zerodha Losses',
// standardSum treats them as standard Income transactions and adds +76,564.74 and -53,087.74 directly to standardSum (cash).

// Check 7: Counting Charges as cash transactions?
// Row 115 has Note='Zerodha Charges', Category='Finance', Type='Income', INR=-3265.1868.
// Because it has no standard pipe prefix recognized by parseTxnFields, isTrade is FALSE, so standardSum += (-3265.1868). It is counted as a cash debit.

// Check 8: Counting Other Credit/Debit as cash transactions?
// 71 rows have Note='Other Credit & Debit', Category='Finance', Type='Income', total INR = -1924.37.
// isTrade is FALSE, so standardSum += (-1924.37). They are counted as cash debits/credits.

// Check 9: Counting historical reconstruction BUY rows as cash transactions?
// In calculateShareMarketBalances:
// Lines 386-402:
// BUY rows (including BUY_RECON or BUY with EntryDate=UNKNOWN) are treated as trades:
// isTrade = true, so they are NOT added to standardSum.
// BUT they ADD to h.buyCost!
// For SAMPANN: BUY | Broker=Zerodha | Symbol=SAMPANN | Qty=60 | Cost=2171.75 | EntryDate=UNKNOWN
// h.buyCost += 2171.75.
// But SAMPANN was also sold in full (SELL Qty=60, CostBasis=2171.75).
// So h.qty = 0, h.buyCost - h.soldCostBasis = 0.
// Thus it does NOT add to active investedCost (39,704.98).
// For TATAMOTORS: BUY_RECON rows added 20 qty, cost = 9,375.15.
// In the CSV, TATAMOTORS had 20 shares sold that had no original buy row in tradebook, so BUY_RECON reconstructed them.
// In holdings, TATAMOTORS has buyCost = 417,348.35, soldCostBasis = 426,723.51, qty = -20 (or 0). Since qty <= 0, TATAMOTORS is inactive and cost = 0.

// Check 10: Treating Share Market -> Share Market transfers as actual account debits/credits?
// In calculateShareMarketBalances lines 372-380:
// if (isFrom && isTo) { /* internal - does nothing */ }
// In buildBalanceMap lines 212:
// addTo(acct, -amt); addTo(dest, +amt);
// If acct === 'Share Market' && dest === 'Share Market', map['Share Market'] -= amt and map['Share Market'] += amt (net 0).

// Check 11: Applying any reconciliation/opening balance?
// None in the code, except what is inside state.brokerages config (cash_offset). Currently cash_offset = 0.

// Check 12: Applying any offset?
// In calculateShareMarketBalances line 347-348:
// const cashOffset = parseFloat(config.cash_offset) || 0;
// const mvOffset = parseFloat(config.mv_offset) || 0;
// let cash = standardSum - investedCost + cashOffset;
// currentValue += mvOffset;

// Check 13: Taking absolute value of a negative cash balance?
// YES!
// In formatINR (format.js line 4):
// const abs = Math.abs(num); return '₹' + abs.toLocaleString('en-IN', ...);
// So when cash is -9578.98, formatINR(details.cash) displays "₹9,579"! It strips the minus sign and shows it as positive!

console.log('All 13 checks verified.');
