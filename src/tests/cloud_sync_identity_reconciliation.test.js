import 'fake-indexeddb/auto';
import assert from 'assert';
import {
  getTransactionBusinessKey,
  getInvestmentTransactionBusinessKey,
  getEntityBusinessKey,
  normalizeDateForIdentity
} from '../services/cloudSyncIdentity.js';
import {
  reconcile3Way,
  CONFLICT_TYPES,
  canonicalizeEntity
} from '../services/cloudSyncEngine.js';

function pass(name) {
  console.log(`✅ PASS: ${name}`);
}

async function runTests() {
  console.log('====================================================');
  console.log('Phase 6C.1: Cloud Sync Business Identity Reconciliation Test Suite');
  console.log('====================================================\n');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1 — Same transaction, same ID -> exact-ID match, no duplicate
  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 1: Same Transaction, Same ID ---');
  const t1 = { id: 'txn_01', Date: '2024-01-01', Account: 'HDFC', Amount: '1000', type: 'Expense', Category: 'Food' };
  const plan1 = await reconcile3Way({
    baseManifest: { txn_01: { type: 'transaction', canonical: 'c1' } },
    localEntities: { transactions: [t1] },
    cloudEntities: { transactions: [t1] }
  });
  assert.strictEqual(plan1.plannedLocalInserts.length, 0, 'No local inserts for identical ID');
  assert.strictEqual(plan1.plannedCloudInserts.length, 0, 'No cloud inserts for identical ID');
  assert.strictEqual(plan1.conflicts.length, 0, 'Zero conflicts');
  pass('TEST 1: Same transaction with same ID matches cleanly with zero duplicates');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2 — Same transaction, different IDs -> business-key match, no duplicate
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 2: Same Transaction, Different IDs ---');
  const t2Local = { id: 'local_uuid_02', Date: '01/01/2024', Account: 'HDFC Bank', Amount: '1500', type: 'Expense', Category: 'Groceries', Description: 'Supermarket' };
  const t2Cloud = { id: 'cloud_det_02', Date: '2024-01-01', Account: 'HDFC Bank', Amount: '1500', type: 'Expense', Category: 'Groceries', Description: 'Supermarket' };
  const plan2 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t2Local] },
    cloudEntities: { transactions: [t2Cloud] }
  });
  assert.strictEqual(plan2.plannedLocalInserts.length, 0, 'Planned local inserts must be 0 for business match');
  assert.strictEqual(plan2.plannedCloudInserts.length, 0, 'Planned cloud inserts must be 0 for business match');
  assert.strictEqual(plan2.conflicts.length, 0, 'Zero conflicts for clean 1:1 business match');
  assert.strictEqual(plan2.duplicateInsertsPrevented, 1, 'Exactly 1 duplicate insert prevented');
  pass('TEST 2: Same transaction with different IDs matches on business key without duplicate');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 3 — Different transactions, same date and amount -> must NOT match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 3: Different Transactions, Same Date & Amount ---');
  const t3A = { id: 'local_03', Date: '01/01/2024', Account: 'HDFC Bank', Amount: '500', type: 'Expense', Category: 'Food', Note: 'Lunch with Bob' };
  const t3B = { id: 'cloud_03', Date: '01/01/2024', Account: 'Cash', Amount: '500', type: 'Expense', Category: 'Transport', Note: 'Taxi ride' };
  const plan3 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t3A] },
    cloudEntities: { transactions: [t3B] }
  });
  assert.strictEqual(plan3.plannedLocalInserts.length, 1, 'Cloud taxi expense must be planned for local insert');
  assert.strictEqual(plan3.plannedCloudInserts.length, 1, 'Local lunch expense must be planned for cloud insert');
  pass('TEST 3: Unrelated transactions with same date and amount are not falsely matched');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 4 — One local candidate + one cloud candidate -> deterministic match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 4: Deterministic 1:1 Identity Matching ---');
  const keyLocal = getTransactionBusinessKey(t2Local);
  const keyCloud = getTransactionBusinessKey(t2Cloud);
  assert.strictEqual(keyLocal, keyCloud, 'Business keys must be identical across date formats');
  pass('TEST 4: Deterministic business key correctly extracted and normalized');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 5 — Multiple local candidates with same business key -> IDENTITY_CONFLICT
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 5: Multiple Local Candidates -> IDENTITY_CONFLICT ---');
  const t5Local1 = { id: 'loc_5a', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea' };
  const t5Local2 = { id: 'loc_5b', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea' };
  const t5Cloud = { id: 'cld_5', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea' };
  const plan5 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t5Local1, t5Local2] },
    cloudEntities: { transactions: [t5Cloud] }
  });
  assert.strictEqual(plan5.conflicts.length, 1, 'Must flag an IDENTITY_CONFLICT for ambiguous 2:1 match');
  assert.strictEqual(plan5.conflicts[0].type, CONFLICT_TYPES.IDENTITY_CONFLICT, 'Conflict type is IDENTITY_CONFLICT');
  assert.strictEqual(plan5.plannedLocalInserts.length, 0, 'No automatic merge when ambiguous');
  pass('TEST 5: Ambiguous multiple local candidates safely flagged as IDENTITY_CONFLICT');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 6 — Multiple cloud candidates with same business key -> IDENTITY_CONFLICT
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 6: Multiple Cloud Candidates -> IDENTITY_CONFLICT ---');
  const t6Local = { id: 'loc_6', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea' };
  const t6Cloud1 = { id: 'cld_6a', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea' };
  const t6Cloud2 = { id: 'cld_6b', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea' };
  const plan6 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t6Local] },
    cloudEntities: { transactions: [t6Cloud1, t6Cloud2] }
  });
  assert.strictEqual(plan6.conflicts.length, 1, 'Must flag an IDENTITY_CONFLICT for ambiguous 1:2 match');
  assert.strictEqual(plan6.conflicts[0].type, CONFLICT_TYPES.IDENTITY_CONFLICT, 'Conflict type is IDENTITY_CONFLICT');
  pass('TEST 6: Ambiguous multiple cloud candidates safely flagged as IDENTITY_CONFLICT');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 7 — Deleted local record + matching cloud business key -> must NOT resurrect
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 7: Local Tombstone Prevents Resurrection ---');
  const t7Cloud = { id: 'cld_07', Date: '01/01/2024', Account: 'HDFC', Amount: '2000', type: 'Expense', Category: 'Bills' };
  const plan7 = await reconcile3Way({
    baseManifest: { 'cld_07': { canonical: canonicalizeEntity(t7Cloud, 'transactions') } },
    localEntities: { transactions: [], sync_tombstones: [{ id: 'cld_07', entity_type: 'transaction' }] },
    cloudEntities: { transactions: [t7Cloud] }
  });
  assert.strictEqual(plan7.plannedLocalInserts.length, 0, 'Tombstoned cloud record must not be inserted locally');
  assert.strictEqual(plan7.plannedCloudDeletes.length, 1, 'Deletion propagated to cloud');
  pass('TEST 7: Local deletion tombstone prevents resurrection of matching cloud record');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 8 — Deleted cloud record + matching local business key -> must NOT resurrect
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 8: Cloud Tombstone Prevents Resurrection ---');
  const t8Local = { id: 'loc_08', Date: '01/01/2024', Account: 'HDFC', Amount: '2000', type: 'Expense', Category: 'Bills' };
  const plan8 = await reconcile3Way({
    baseManifest: { 'loc_08': { canonical: canonicalizeEntity(t8Local, 'transactions') } },
    localEntities: { transactions: [t8Local] },
    cloudEntities: { transactions: [], sync_tombstones: [{ id: 'loc_08', entity_type: 'transaction' }] }
  });
  assert.strictEqual(plan8.plannedCloudInserts.length, 0, 'Tombstoned local record must not be inserted on cloud');
  assert.strictEqual(plan8.plannedLocalDeletes.length, 1, 'Deletion propagated to local');
  pass('TEST 8: Cloud deletion tombstone prevents resurrection of local record');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 9 — Investment BUY same business event, different IDs -> one logical event
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 9: Investment BUY Identity Reconciliation ---');
  const inv9Local = { id: 'loc_inv_buy', Date: '2024-02-01', SecuritySymbol: 'RELIANCE', SecurityISIN: 'INE002A01018', Quantity: 10, UnitPrice: 2500, TradeValue: 25000, InvestmentTransactionType: 'BUY', Source: 'zerodha' };
  const inv9Cloud = { id: 'cld_inv_buy', Date: '01/02/2024', SecuritySymbol: 'RELIANCE', SecurityISIN: 'INE002A01018', Quantity: 10, UnitPrice: 2500, TradeValue: 25000, InvestmentTransactionType: 'BUY', Source: 'zerodha' };
  const plan9 = await reconcile3Way({
    baseManifest: {},
    localEntities: { investment_transactions: [inv9Local] },
    cloudEntities: { investment_transactions: [inv9Cloud] }
  });
  assert.strictEqual(plan9.plannedLocalInserts.length, 0, 'No local insert for matching BUY trade');
  assert.strictEqual(plan9.plannedCloudInserts.length, 0, 'No cloud insert for matching BUY trade');
  assert.strictEqual(plan9.conflicts.length, 0, 'Zero conflicts');
  pass('TEST 9: Investment BUY records matched cleanly on investment business key');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 10 — Investment SELL same business event, different IDs -> one logical event
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 10: Investment SELL Identity Reconciliation ---');
  const inv10Local = { id: 'loc_inv_sell', Date: '2024-03-01', SecuritySymbol: 'TCS', SecurityISIN: 'INE467B01029', Quantity: 5, UnitPrice: 3800, TradeValue: 19000, InvestmentTransactionType: 'SELL', Source: 'zerodha' };
  const inv10Cloud = { id: 'cld_inv_sell', Date: '01/03/2024', SecuritySymbol: 'TCS', SecurityISIN: 'INE467B01029', Quantity: 5, UnitPrice: 3800, TradeValue: 19000, InvestmentTransactionType: 'SELL', Source: 'zerodha' };
  const plan10 = await reconcile3Way({
    baseManifest: {},
    localEntities: { investment_transactions: [inv10Local] },
    cloudEntities: { investment_transactions: [inv10Cloud] }
  });
  assert.strictEqual(plan10.plannedLocalInserts.length, 0, 'No local insert for matching SELL trade');
  assert.strictEqual(plan10.plannedCloudInserts.length, 0, 'No cloud insert for matching SELL trade');
  pass('TEST 10: Investment SELL records matched cleanly on investment business key');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 11 — BUY vs SELL same date/security/amount -> must NOT match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 11: BUY vs SELL Must Not Match ---');
  const inv11Buy = { id: 'loc_buy', Date: '2024-04-01', SecuritySymbol: 'INFY', Quantity: 10, UnitPrice: 1500, TradeValue: 15000, InvestmentTransactionType: 'BUY' };
  const inv11Sell = { id: 'cld_sell', Date: '2024-04-01', SecuritySymbol: 'INFY', Quantity: 10, UnitPrice: 1500, TradeValue: 15000, InvestmentTransactionType: 'SELL' };
  const plan11 = await reconcile3Way({
    baseManifest: {},
    localEntities: { investment_transactions: [inv11Buy] },
    cloudEntities: { investment_transactions: [inv11Sell] }
  });
  assert.strictEqual(plan11.plannedLocalInserts.length, 1, 'Cloud SELL must be inserted locally');
  assert.strictEqual(plan11.plannedCloudInserts.length, 1, 'Local BUY must be inserted on cloud');
  pass('TEST 11: BUY and SELL with same date and amount remain distinct');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 12 — CHARGE vs BUY/SELL -> must NOT match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 12: CHARGE vs BUY/SELL Must Not Match ---');
  const inv12Charge = { id: 'loc_charge', Date: '2024-05-01', SecuritySymbol: 'HDFCBANK', TradeValue: 600, InvestmentTransactionType: 'CHARGE' };
  const inv12Buy = { id: 'cld_buy', Date: '2024-05-01', SecuritySymbol: 'HDFCBANK', TradeValue: 600, InvestmentTransactionType: 'BUY' };
  const plan12 = await reconcile3Way({
    baseManifest: {},
    localEntities: { investment_transactions: [inv12Charge] },
    cloudEntities: { investment_transactions: [inv12Buy] }
  });
  assert.strictEqual(plan12.plannedLocalInserts.length, 1, 'Cloud BUY must be planned for insert');
  assert.strictEqual(plan12.plannedCloudInserts.length, 1, 'Local CHARGE must be planned for insert');
  pass('TEST 12: CHARGE and BUY remain distinct events');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 13 — 1,549 historical transaction simulation -> 0 duplicate inserts
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 13: 1,549 Historical Transaction Simulation ---');
  const local1549 = [];
  const cloud1549 = [];
  for (let i = 0; i < 1549; i++) {
    const d = `01/${String((i % 12) + 1).padStart(2, '0')}/2023`;
    const amt = (100 + i).toFixed(2);
    local1549.push({
      id: `local_hist_uuid_${i}`,
      Date: d,
      Amount: amt,
      INR: amt,
      type: 'Expense',
      Account: 'HDFC Savings',
      Category: 'Shopping',
      Description: `Purchase ${i}`
    });
    cloud1549.push({
      id: `cloud_hist_det_${i}`,
      Date: d,
      Amount: amt,
      INR: amt,
      type: 'Expense',
      Account: 'HDFC Savings',
      Category: 'Shopping',
      Description: `Purchase ${i}`
    });
  }

  const plan13 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: local1549 },
    cloudEntities: { transactions: cloud1549 }
  });
  assert.strictEqual(plan13.plannedLocalInserts.length, 0, 'Planned local inserts must be 0 for all 1,549 matched pairs');
  assert.strictEqual(plan13.plannedCloudInserts.length, 0, 'Planned cloud inserts must be 0 for all 1,549 matched pairs');
  assert.strictEqual(plan13.duplicateInsertsPrevented, 1549, 'Exactly 1,549 duplicate inserts prevented');
  pass('TEST 13: 1,549 historical transactions matched with 0 duplicate local or cloud inserts');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 14 — 67 historical investment transaction simulation -> 0 duplicate inserts
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 14: 67 Historical Investment Transaction Simulation ---');
  const local67 = [];
  const cloud67 = [];
  for (let i = 0; i < 67; i++) {
    const d = `15/${String((i % 12) + 1).padStart(2, '0')}/2023`;
    local67.push({
      id: `local_inv_uuid_${i}`,
      Date: d,
      SecuritySymbol: `MUTUAL_FUND_${i}`,
      SecurityISIN: `INF109K01${String(i).padStart(3, '0')}`,
      Quantity: 100 + i,
      UnitPrice: 25.50,
      TradeValue: (100 + i) * 25.50,
      InvestmentTransactionType: 'BUY',
      Source: 'etmoney'
    });
    cloud67.push({
      id: `cloud_inv_det_${i}`,
      Date: d,
      SecuritySymbol: `MUTUAL_FUND_${i}`,
      SecurityISIN: `INF109K01${String(i).padStart(3, '0')}`,
      Quantity: 100 + i,
      UnitPrice: 25.50,
      TradeValue: (100 + i) * 25.50,
      InvestmentTransactionType: 'BUY',
      Source: 'etmoney'
    });
  }

  const plan14 = await reconcile3Way({
    baseManifest: {},
    localEntities: { investment_transactions: local67 },
    cloudEntities: { investment_transactions: cloud67 }
  });
  assert.strictEqual(plan14.plannedLocalInserts.length, 0, 'Planned local inserts must be 0 for all 67 matched investment pairs');
  assert.strictEqual(plan14.plannedCloudInserts.length, 0, 'Planned cloud inserts must be 0 for all 67 matched investment pairs');
  assert.strictEqual(plan14.duplicateInsertsPrevented, 67, 'Exactly 67 duplicate investment inserts prevented');
  pass('TEST 14: 67 historical investment transactions matched with 0 duplicate inserts');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 15 — 24 genuinely new Device A transactions -> plannedCloudInserts = 24
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 15: 24 Genuinely New Local Transactions ---');
  const newLocal24 = [];
  for (let i = 0; i < 24; i++) {
    newLocal24.push({
      id: `new_local_txn_${i}`,
      Date: '24/09/2026',
      Amount: String(50 * (i + 1)),
      INR: String(50 * (i + 1)),
      type: 'Expense',
      Account: 'Cash',
      Category: 'Food',
      Description: `Recent purchase ${i}`
    });
  }

  const plan15 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: newLocal24 },
    cloudEntities: { transactions: [] }
  });
  assert.strictEqual(plan15.plannedCloudInserts.length, 24, 'All 24 genuine new transactions must be staged for cloud upload');
  assert.strictEqual(plan15.plannedLocalInserts.length, 0, 'No local inserts');
  pass('TEST 15: 24 genuinely new local transactions cleanly staged for cloud upload');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 16 — Mixed dataset: 1,549 matched + 67 inv matched + 24 new local -> exact plan
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 16: Complete Mixed Dataset End-to-End Reconcile Plan ---');
  const plan16 = await reconcile3Way({
    baseManifest: {},
    localEntities: {
      transactions: [...local1549, ...newLocal24],
      investment_transactions: local67
    },
    cloudEntities: {
      transactions: cloud1549,
      investment_transactions: cloud67
    }
  });

  assert.strictEqual(plan16.plannedLocalInserts.length, 0, 'Planned local inserts must be exactly 0 (zero false duplicate downloads)');
  assert.strictEqual(plan16.plannedCloudInserts.length, 24, 'Planned cloud inserts must be exactly 24 (the 24 genuine new transactions)');
  assert.strictEqual(plan16.conflicts.length, 0, 'Zero false conflicts');
  assert.strictEqual(plan16.duplicateInsertsPrevented, 1549 + 67, 'Exactly 1,616 duplicate inserts prevented');
  pass('TEST 16: Complete mixed dataset reconciled with zero false duplicates and exact 24 cloud inserts');

  console.log('\n====================================================');
  console.log('SUMMARY: 16 PASSED, 0 FAILED');
  console.log('====================================================\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
