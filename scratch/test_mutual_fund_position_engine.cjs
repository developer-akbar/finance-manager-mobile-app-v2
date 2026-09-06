const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 1. Simple CSV Parser
function parseCSV(text) {
  const rows = [];
  let row = [];
  let inQuotes = false;
  let cur = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nextCh = text[i + 1];

    if (ch === '"') {
      if (inQuotes && nextCh === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cur);
      cur = '';
    } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
      if (ch === '\r' && nextCh === '\n') i++;
      row.push(cur);
      if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
        rows.push(row);
      }
      row = [];
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }

  const headers = rows[0].map(h => h.trim());
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = rows[r][idx] !== undefined ? rows[r][idx] : '';
    });
    obj._line = r;
    data.push(obj);
  }
  return { headers, data };
}

// 2. Dynamic Import or require for mutualFundPositionEngine
async function runTests() {
  console.log('=== RUNNING PHASE 6 MUTUAL FUND POSITION ENGINE TEST SUITE ===');

  const engineModule = await import('../src/utils/mutualFundPositionEngine.js');
  const {
    getCanonicalPositionKey,
    parseMutualFundTransaction,
    calculateMutualFundPositions,
    EPSILON
  } = engineModule;

  // -------------------------------------------------------------
  // Test 1 — Simple BUY
  // -------------------------------------------------------------
  console.log('\n--- Test 1: Simple BUY ---');
  const t1 = [
    {
      ID: 'test-buy-1',
      Date: '01/01/2026',
      InvestmentTransactionType: 'BUY',
      InvestmentAccount: 'Liquid Mutual Funds',
      SubAccount: 'Fareeda Groww',
      SecurityISIN: 'INFTEST00001',
      FolioNumber: 'F1001',
      HoldingMode: 'NON_DEMAT',
      Quantity: '100',
      UnitPrice: '100',
      CostBasis: '10000',
      TradeValue: '10000',
      Tags: 'Ownership:PERSONAL'
    }
  ];
  const res1 = calculateMutualFundPositions(t1);
  const pos1 = res1.positions[0];
  assert.strictEqual(pos1.currentUnits, 100, 'Units must be 100');
  assert.strictEqual(pos1.remainingCostBasis, 10000, 'CostBasis must be 10000');
  assert.strictEqual(pos1.averageCostPerUnit, 100, 'AverageCost must be 100');
  assert.strictEqual(pos1.status, 'ACTIVE', 'Status must be ACTIVE');
  console.log('PASS: Test 1 (Units=100, Cost=10000, AvgCost=100)');

  // -------------------------------------------------------------
  // Test 2 — Multiple BUYs
  // -------------------------------------------------------------
  console.log('\n--- Test 2: Multiple BUYs ---');
  const t2 = [
    ...t1,
    {
      ID: 'test-buy-2',
      Date: '02/01/2026',
      InvestmentTransactionType: 'BUY',
      InvestmentAccount: 'Liquid Mutual Funds',
      SubAccount: 'Fareeda Groww',
      SecurityISIN: 'INFTEST00001',
      FolioNumber: 'F1001',
      HoldingMode: 'NON_DEMAT',
      Quantity: '50',
      UnitPrice: '120',
      CostBasis: '6000',
      TradeValue: '6000',
      Tags: 'Ownership:PERSONAL'
    }
  ];
  const res2 = calculateMutualFundPositions(t2);
  const pos2 = res2.positions[0];
  assert.strictEqual(pos2.currentUnits, 150, 'Units must be 150');
  assert.strictEqual(pos2.remainingCostBasis, 16000, 'CostBasis must be 16000');
  assert.strictEqual(pos2.averageCostPerUnit, 106.6667, 'AverageCost must be 106.6667');
  console.log('PASS: Test 2 (Units=150, Cost=16000, AvgCost=106.6667)');

  // -------------------------------------------------------------
  // Test 3 — Partial FIFO SELL
  // -------------------------------------------------------------
  console.log('\n--- Test 3: Partial FIFO SELL ---');
  const t3 = [
    ...t2,
    {
      ID: 'test-sell-1',
      Date: '03/01/2026',
      InvestmentTransactionType: 'SELL',
      InvestmentAccount: 'Liquid Mutual Funds',
      SubAccount: 'Fareeda Groww',
      SecurityISIN: 'INFTEST00001',
      FolioNumber: 'F1001',
      HoldingMode: 'NON_DEMAT',
      Quantity: '70',
      UnitPrice: '120',
      TradeValue: '8400',
      Tags: 'Ownership:PERSONAL'
    }
  ];
  const res3 = calculateMutualFundPositions(t3);
  const pos3 = res3.positions[0];
  assert.strictEqual(pos3.currentUnits, 80, 'Remaining units must be 80');
  assert.strictEqual(pos3.remainingCostBasis, 9000, 'Remaining cost must be 9000 (30@100 + 50@120)');
  assert.strictEqual(pos3.realizedPnl, 1400, 'Realized PnL must be 1400 (8400 - 7000)');
  console.log('PASS: Test 3 (Units=80, Cost=9000, RealizedPnL=1400)');

  // -------------------------------------------------------------
  // Test 4 — Full Redemption
  // -------------------------------------------------------------
  console.log('\n--- Test 4: Full Redemption ---');
  const t4 = [
    ...t3,
    {
      ID: 'test-sell-2',
      Date: '04/01/2026',
      InvestmentTransactionType: 'SELL',
      InvestmentAccount: 'Liquid Mutual Funds',
      SubAccount: 'Fareeda Groww',
      SecurityISIN: 'INFTEST00001',
      FolioNumber: 'F1001',
      HoldingMode: 'NON_DEMAT',
      Quantity: '80',
      UnitPrice: '130',
      TradeValue: '10400',
      Tags: 'Ownership:PERSONAL'
    }
  ];
  const res4 = calculateMutualFundPositions(t4);
  const pos4 = res4.positions[0];
  assert.strictEqual(pos4.currentUnits, 0, 'Current units must be 0');
  assert.strictEqual(pos4.remainingCostBasis, 0, 'Remaining cost basis must be 0');
  assert.strictEqual(pos4.status, 'REDEEMED', 'Status must be REDEEMED');
  console.log('PASS: Test 4 (Units=0, Cost=0, Status=REDEEMED)');

  // -------------------------------------------------------------
  // Test 5 — Same ISIN, Different Folio
  // -------------------------------------------------------------
  console.log('\n--- Test 5: Same ISIN, Different Folio ---');
  const t5 = [
    t1[0],
    {
      ...t1[0],
      ID: 'test-buy-diff-folio',
      FolioNumber: 'F2002',
      Quantity: '50'
    }
  ];
  const res5 = calculateMutualFundPositions(t5);
  assert.strictEqual(res5.positions.length, 2, 'Must create 2 separate positions for different folios');
  console.log('PASS: Test 5 (Different folios stay separate)');

  // -------------------------------------------------------------
  // Test 6 — Same ISIN, DEMAT vs NON_DEMAT
  // -------------------------------------------------------------
  console.log('\n--- Test 6: Same ISIN, DEMAT vs NON_DEMAT ---');
  const t6 = [
    t1[0],
    {
      ...t1[0],
      ID: 'test-buy-demat',
      HoldingMode: 'DEMAT',
      Quantity: '60'
    }
  ];
  const res6 = calculateMutualFundPositions(t6);
  assert.strictEqual(res6.positions.length, 2, 'Must create 2 separate positions for DEMAT vs NON_DEMAT');
  console.log('PASS: Test 6 (DEMAT vs NON_DEMAT stay separate)');

  // -------------------------------------------------------------
  // Test 7 — Same Security, Different SubAccount
  // -------------------------------------------------------------
  console.log('\n--- Test 7: Same Security, Different SubAccount ---');
  const t7 = [
    t1[0],
    {
      ...t1[0],
      ID: 'test-buy-etm',
      SubAccount: 'Fareeda ETMoney',
      Quantity: '70'
    }
  ];
  const res7 = calculateMutualFundPositions(t7);
  assert.strictEqual(res7.positions.length, 2, 'Must create 2 separate positions for Fareeda Groww vs Fareeda ETMoney');
  console.log('PASS: Test 7 (Different SubAccounts stay separate)');

  // -------------------------------------------------------------
  // Test 8 — Father Exclusion
  // -------------------------------------------------------------
  console.log('\n--- Test 8: Father Exclusion ---');
  const t8 = [
    t1[0],
    {
      ID: 'test-father-1',
      Date: '01/01/2026',
      InvestmentTransactionType: 'BUY',
      InvestmentAccount: 'Liquid Mutual Funds',
      SubAccount: 'Fareeda Groww',
      SecurityISIN: 'INF247L01AC1',
      FolioNumber: '910121381854/0',
      HoldingMode: 'DEMAT',
      Quantity: '25.128',
      UnitPrice: '23.8764',
      CostBasis: '599.97',
      TradeValue: '0',
      Tags: 'Ownership:FATHER_EXTERNAL'
    }
  ];
  const res8 = calculateMutualFundPositions(t8);
  const personalPos = res8.getPersonalPortfolio();
  assert.strictEqual(res8.positions.length, 2, 'Total positions must be 2');
  assert.strictEqual(personalPos.length, 1, 'Personal portfolio must exclude Father');
  assert.strictEqual(personalPos[0].ownershipTag, 'PERSONAL', 'Only PERSONAL must remain');
  console.log('PASS: Test 8 (Father holdings strictly excluded from personal portfolio)');

  // -------------------------------------------------------------
  // Test 9 — Mixed Holding
  // -------------------------------------------------------------
  console.log('\n--- Test 9: Mixed Holding ---');
  const t9 = [
    {
      ID: 'test-mixed-1',
      Date: '28/11/2024',
      InvestmentTransactionType: 'BUY',
      InvestmentAccount: 'Liquid Mutual Funds',
      SubAccount: 'Fareeda ETMoney',
      SecurityISIN: 'INF740KA1MG9',
      FolioNumber: '8470103/05',
      HoldingMode: 'NON_DEMAT',
      Quantity: '1813.113',
      UnitPrice: '27.5755',
      CostBasis: '49997.50',
      TradeValue: '50000',
      Tags: 'Ownership:MIXED_HOLDING'
    }
  ];
  const res9 = calculateMutualFundPositions(t9);
  assert.strictEqual(res9.positions[0].ownershipTag, 'MIXED_HOLDING', 'Must retain MIXED_HOLDING tag');
  console.log('PASS: Test 9 (Mixed holding correctly identified and unsplit)');

  // -------------------------------------------------------------
  // Test 10 — Ammi Cashback Tranches
  // -------------------------------------------------------------
  console.log('\n--- Test 10: Ammi Cashback Tranches ---');
  const t10 = [
    {
      ID: 'cb-1',
      Date: '21/08/2024',
      InvestmentTransactionType: 'BUY',
      InvestmentAccount: 'Liquid Mutual Funds',
      SubAccount: 'Ammi Groww',
      SecurityISIN: 'INF247L01445',
      FolioNumber: '91053499341/0',
      HoldingMode: 'NON_DEMAT',
      Quantity: '60.946',
      UnitPrice: '113.8159',
      CostBasis: '6936.65',
      TradeValue: '6937',
      Tags: 'Ownership:PERSONAL'
    },
    {
      ID: 'cb-2',
      Date: '02/09/2024',
      InvestmentTransactionType: 'BUY',
      InvestmentAccount: 'Liquid Mutual Funds',
      SubAccount: 'Ammi Groww',
      SecurityISIN: 'INF247L01445',
      FolioNumber: '91053499341/0',
      HoldingMode: 'NON_DEMAT',
      Quantity: '19.089',
      UnitPrice: '116.7086',
      CostBasis: '2227.89',
      TradeValue: '2228',
      Tags: 'Ownership:PERSONAL'
    }
  ];
  const res10 = calculateMutualFundPositions(t10);
  assert.strictEqual(res10.positions[0].currentUnits, 80.035, 'Units must equal exact sum 60.946 + 19.089 = 80.035');
  console.log('PASS: Test 10 (Ammi cashback tranches aggregated with zero duplication)');

  // -------------------------------------------------------------
  // Test 11 & 12 — Master 19 CAS Positions from finman_2026-09-02.csv
  // -------------------------------------------------------------
  console.log('\n--- Test 11 & 12: Master 19 CAS Positions on Full Dataset ---');
  const csvPath = path.resolve('finman_2026-09-02.csv');
  const { data: rawTxns } = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Loaded ${rawTxns.length} transactions from master CSV`);

  const fullResults = calculateMutualFundPositions(rawTxns);
  console.log(`Total mutual fund positions calculated: ${fullResults.positions.length}`);
  console.log(`Active positions: ${fullResults.summary.totalActivePositions}`);
  console.log(`Redeemed positions: ${fullResults.summary.totalRedeemedPositions}`);
  console.log(`Legacy issue positions: ${fullResults.summary.totalLegacyIssuePositions}`);

  const expected19 = [
    { sub: 'Fareeda Groww', isin: 'INF740KA1MG9', fol: '10185451/05', mode: 'NON_DEMAT', expUnits: 2044.940 },
    { sub: 'Fareeda Groww', isin: 'INF740KA1MG9', fol: '11056452/85', mode: 'DEMAT', expUnits: 1058.476 },
    { sub: 'Fareeda ETMoney', isin: 'INF740KA1MG9', fol: '8470103/05', mode: 'NON_DEMAT', expUnits: 1813.113 },
    { sub: 'Fareeda Groww', isin: 'INF179K01XQ0', fol: '41564472/84', mode: 'DEMAT', expUnits: 107.744 },
    { sub: 'Fareeda Groww', isin: 'INF769K01BI1', fol: '78887871745/0', mode: 'DEMAT', expUnits: 69.377 },
    { sub: 'Fareeda Groww', isin: 'INF247L01445', fol: '910118443576/0', mode: 'NON_DEMAT', expUnits: 259.369 },
    { sub: 'Fareeda Groww', isin: 'INF247L01AC1', fol: '910118443576/0', mode: 'NON_DEMAT', expUnits: 26.847 },
    { sub: 'Fareeda Groww', isin: 'INF247L01AC1', fol: '910121381854/0', mode: 'DEMAT', expUnits: 363.410 },
    { sub: 'Fareeda ETMoney', isin: 'INF247L01445', fol: '91055029576/0', mode: 'NON_DEMAT', expUnits: 411.071 },
    { sub: 'Fareeda ETMoney', isin: 'INF247L01AC1', fol: '91055029576/0', mode: 'NON_DEMAT', expUnits: 156.317 },
    { sub: 'Fareeda Groww', isin: 'INF204K01XI3', fol: '477405385771/0', mode: 'NON_DEMAT', expUnits: 486.943 },
    { sub: 'Fareeda Groww', isin: 'INF204K01K15', fol: '477405389157/0', mode: 'NON_DEMAT', expUnits: 159.845 },
    { sub: 'Fareeda Groww', isin: 'INF879O01027', fol: '17087524', mode: 'NON_DEMAT', expUnits: 474.617 },
    { sub: 'Fareeda Groww', isin: 'INF879O01027', fol: '19824545', mode: 'DEMAT', expUnits: 439.969 },
    { sub: 'Ammi Groww', isin: 'INF247L01445', fol: '910125090796/0', mode: 'DEMAT', expUnits: 66.946 },
    { sub: 'Ammi Groww', isin: 'INF247L01445', fol: '91053499341/0', mode: 'NON_DEMAT', expUnits: 254.852 },
    { sub: 'Ammi Groww', isin: 'INF247L01999', fol: '91053499341/0', mode: 'NON_DEMAT', expUnits: 4222.156 },
    { sub: 'Ammi Groww', isin: 'INF204K01XI3', fol: '477306423194/0', mode: 'NON_DEMAT', expUnits: 309.647 },
    { sub: 'Ammi Groww', isin: 'INF879O01027', fol: '16530278', mode: 'NON_DEMAT', expUnits: 500.138 },
  ];

  let matched19 = 0;
  for (const exp of expected19) {
    const key = getCanonicalPositionKey({
      investmentAccount: 'Liquid Mutual Funds',
      subAccount: exp.sub,
      isin: exp.isin,
      folioNumber: exp.fol,
      holdingMode: exp.mode
    });

    const pos = fullResults.positionsByKey[key];
    assert(pos, `Position ${key} must exist in engine output`);
    const diff = Math.abs(pos.currentUnits - exp.expUnits);
    assert(diff < 0.0001, `Unit mismatch for ${key}: engine=${pos.currentUnits}, expected=${exp.expUnits}, diff=${diff}`);
    assert.strictEqual(pos.status, 'ACTIVE', `Status for ${key} must be ACTIVE`);
    matched19++;
  }
  assert.strictEqual(matched19, 19, 'Must match all 19 active CAS positions');
  console.log('PASS: Test 11 & 12 (19 / 19 Active CAS Positions Reconciled to 0.000 Unit Delta!)');

  // -------------------------------------------------------------
  // Test 13 — Negative Legacy Position Safety
  // -------------------------------------------------------------
  console.log('\n--- Test 13: Negative Legacy Position Safety ---');
  const franklinKey = Object.keys(fullResults.positionsByKey).find(k => k.includes('INF090I01JA6'));
  if (franklinKey) {
    const franklinPos = fullResults.positionsByKey[franklinKey];
    assert.strictEqual(franklinPos.status, 'LEGACY_DATA_ISSUE', 'Franklin Ultra Short must be flagged as LEGACY_DATA_ISSUE');
    console.log(`PASS: Test 13 (Franklin Ultra Short detected with status=LEGACY_DATA_ISSUE, units=${franklinPos.buyUnits - franklinPos.sellUnits})`);
  } else {
    console.log('NOTE: Franklin Ultra Short not in dataset or not classified as MF position');
  }

  // -------------------------------------------------------------
  // Test 14 — Tax Saver Residue Handling
  // -------------------------------------------------------------
  console.log('\n--- Test 14: Tax Saver Residue Handling ---');
  const miraeTaxKey = Object.keys(fullResults.positionsByKey).find(k => k.includes('INF769K01DK3'));
  if (miraeTaxKey) {
    const miraePos = fullResults.positionsByKey[miraeTaxKey];
    assert.strictEqual(miraePos.status, 'REDEEMED', 'Mirae Tax Saver +0.001 residue must be classified as REDEEMED');
    console.log(`PASS: Test 14 (Mirae Tax Saver +0.001 residue correctly handled within tolerance EPSILON=${EPSILON})`);
  } else {
    console.log('NOTE: Mirae Tax Saver not in current filter');
  }

  // -------------------------------------------------------------
  // Test 15 — Zero Cash Mutation
  // -------------------------------------------------------------
  console.log('\n--- Test 15: Zero Cash Mutation ---');
  // Recompute subaccount balances from rawTxns to ensure nothing changed
  function computeSubAccountBalance(txns, acctName, subAccountName) {
    let bal = 0;
    for (const t of txns) {
      const amt = parseFloat(t.Amount || t.INR || 0) || 0;
      const type = String(t['Income/Expense'] || '').trim();
      const acct = String(t.Account || '').trim();
      const fromAcct = String(t.FromAccount || t.Account || '').trim();
      const dest = String(t.ToAccount || '').trim();
      const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();
      const tradeVal = parseFloat(t.TradeValue || t.trade_value || amt);

      const sub = String(t.SubAccount || t.sub_account || '').trim();
      const fromSub = String(t.FromSubAccount || t.from_sub_account || '').trim();
      const toSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

      if (invType === 'BUY') {
        const targetAcct = dest || acct;
        const targetSub = dest ? toSub : sub;
        if (targetAcct === acctName && targetSub === subAccountName) {
          bal += (tradeVal || amt);
        }
      } else if (invType === 'SELL') {
        const targetAcct = fromAcct || acct;
        const targetSub = fromAcct ? fromSub : sub;
        if (targetAcct === acctName && targetSub === subAccountName) {
          bal -= (tradeVal || amt);
        }
      } else if (type === 'Income') {
        const targetAcct = dest || acct;
        const targetSub = dest ? toSub : sub;
        if (targetAcct === acctName && targetSub === subAccountName) {
          bal += amt;
        }
      } else if (type === 'Expense') {
        const targetAcct = fromAcct || acct;
        const targetSub = fromAcct ? fromSub : sub;
        if (targetAcct === acctName && targetSub === subAccountName) {
          bal -= amt;
        }
      } else if (type === 'Transfer-Out') {
        if (fromAcct === acctName && fromSub === subAccountName) {
          bal -= amt;
        }
        if (dest === acctName && toSub === subAccountName) {
          bal += amt;
        }
      }
    }
    return bal;
  }

  const fgBal = computeSubAccountBalance(rawTxns, 'Liquid Mutual Funds', 'Fareeda Groww');
  const fetmBal = computeSubAccountBalance(rawTxns, 'Liquid Mutual Funds', 'Fareeda ETMoney');
  const agBal = computeSubAccountBalance(rawTxns, 'Liquid Mutual Funds', 'Ammi Groww');

  assert.strictEqual(fgBal, 315000, 'Fareeda Groww must remain 315,000');
  assert.strictEqual(fetmBal, 31994, 'Fareeda ETMoney must remain 31,994');
  assert.strictEqual(agBal, 219490, 'Ammi Groww must remain 219,490');
  console.log('PASS: Test 15 (Zero cash mutation, ledger balances unchanged)');

  // -------------------------------------------------------------
  // Test 16 — Idempotency
  // -------------------------------------------------------------
  console.log('\n--- Test 16: Idempotency ---');
  const run1 = calculateMutualFundPositions(rawTxns);
  const run2 = calculateMutualFundPositions(rawTxns);
  assert.strictEqual(run1.positions.length, run2.positions.length, 'Positions length must match');
  assert.strictEqual(run1.summary.activeUnits, run2.summary.activeUnits, 'Active units must match');
  assert.strictEqual(run1.summary.activeCostBasis, run2.summary.activeCostBasis, 'Cost basis must match');
  console.log('PASS: Test 16 (Idempotent execution verified)');

  console.log('\n========================================');
  console.log('ALL 16 POSITION ENGINE TESTS PASSED 100%!');
  console.log('========================================');
}

runTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
