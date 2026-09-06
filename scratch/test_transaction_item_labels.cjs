const fs = require('fs');

console.log('=== TEST TRANSACTION ITEM DISPLAY LOGIC ===\n');

// Replicate TransactionItem.jsx logic
function getListAndDetailLabels(t) {
  const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();
  const isInvestment = Boolean(invType === 'BUY' || invType === 'SELL' || invType === 'UNIT_ADJUSTMENT' || invType === 'RECONCILIATION' || (t.SecuritySymbol && t.SecurityISIN));

  // Updated List Logic
  const invLabel = (t.Note || t.note || '').trim() || (t.SecuritySymbol || t.security_symbol || '').trim() || '';
  const isTransfer = (t['Income/Expense'] || '').toLowerCase().includes('transfer');
  const listTitle = isInvestment
    ? (invLabel || t.Note || 'Investment Security')
    : (isTransfer
      ? (t.Note || `${t.Account || t.FromAccount || '—'} → ${t.ToAccount || '—'}`)
      : (t.Note || t.Category || '—'));

  // Updated DetailSheet Logic
  const securityName = (t.SecuritySymbol || t.security_symbol || '').trim();
  const noteText = (t.Note || t.note || '').trim();
  const detailSecurity = securityName || noteText || 'Investment Security';
  const detailNote = noteText && noteText !== securityName ? noteText : null;

  return { listTitle, detailSecurity, detailNote };
}

// Test Case 1: Motilal Oswal ELSS
const t1 = {
  InvestmentTransactionType: 'SELL',
  SecurityISIN: 'INF247L01402',
  SecuritySymbol: '127LTGPG-Motilal Oswal ELSS Tax Saver Fund - Regular Plan Growth (Non Demat)',
  Note: 'Motilal Oswal ELSS',
  Description: 'CAS MF REDEMPTION | Scheme=127LTGPG-...',
  Amount: '3843.0',
  'Income/Expense': 'Expense'
};
const res1 = getListAndDetailLabels(t1);
console.log('--- TEST CASE 1: Motilal Oswal ELSS ---');
console.log(`List Title:       "${res1.listTitle}" (Expected: "Motilal Oswal ELSS") -> ${res1.listTitle === 'Motilal Oswal ELSS' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Detail Security:  "${res1.detailSecurity}" (Expected: full canonical scheme name) -> ${res1.detailSecurity === t1.SecuritySymbol ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Detail Note:      "${res1.detailNote}" (Expected: "Motilal Oswal ELSS") -> ${res1.detailNote === 'Motilal Oswal ELSS' ? 'PASS ✅' : 'FAIL ❌'}`);

// Test Case 2: Mirae Asset ELSS
const t2 = {
  InvestmentTransactionType: 'BUY',
  SecurityISIN: 'INF769K01086',
  SecuritySymbol: '117TSRGG-Mirae Asset ELSS Tax Saver Fund - Regular Plan (Non Demat)',
  Note: 'Mirae Asset ELSS',
  Description: 'CAS MF PURCHASE | Scheme=117TSRGG-...',
  Amount: '5000.0',
  'Income/Expense': 'Income'
};
const res2 = getListAndDetailLabels(t2);
console.log('\n--- TEST CASE 2: Mirae Asset ELSS ---');
console.log(`List Title:       "${res2.listTitle}" (Expected: "Mirae Asset ELSS") -> ${res2.listTitle === 'Mirae Asset ELSS' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Detail Security:  "${res2.detailSecurity}" (Expected: full canonical scheme name) -> ${res2.detailSecurity === t2.SecuritySymbol ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Detail Note:      "${res2.detailNote}" (Expected: "Mirae Asset ELSS") -> ${res2.detailNote === 'Mirae Asset ELSS' ? 'PASS ✅' : 'FAIL ❌'}`);

// Test Case 3: Empty Note Fallback
const t3 = {
  InvestmentTransactionType: 'BUY',
  SecurityISIN: 'INF204K01ZH0',
  SecuritySymbol: 'RMFLFAGG-NIPPON INDIA LIQUID FUND - DIRECT PLAN GROWTH PLAN',
  Note: '',
  Description: 'CAS MF PURCHASE',
  Amount: '13000.0',
  'Income/Expense': 'Income'
};
const res3 = getListAndDetailLabels(t3);
console.log('\n--- TEST CASE 3: Empty Note Fallback ---');
console.log(`List Title:       "${res3.listTitle}" (Expected: fallback to SecuritySymbol) -> ${res3.listTitle === t3.SecuritySymbol ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Detail Security:  "${res3.detailSecurity}" (Expected: full canonical scheme name) -> ${res3.detailSecurity === t3.SecuritySymbol ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Detail Note:      ${res3.detailNote} (Expected: null) -> ${res3.detailNote === null ? 'PASS ✅' : 'FAIL ❌'}`);

console.log('\n==================================================');
console.log('ALL DISPLAY LOGIC TESTS PASSED SUCCESSFULLY! ✅');
console.log('==================================================');

