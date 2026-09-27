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
  console.log('Phase 6C.9: Cloud Sync Business Identity Reconciliation Test Suite');
  console.log('====================================================\n');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1 — Exact same primary ID -> Stage 1 primary-ID match, 0 duplicate
  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 1: Exact Same Primary ID ---');
  const t1 = { id: 'txn_01', Date: '2024-01-01', Account: 'HDFC', Amount: '1000', type: 'Expense', Category: 'Food' };
  const plan1 = await reconcile3Way({
    baseManifest: { txn_01: { type: 'transactions', canonical: canonicalizeEntity(t1, 'transactions') } },
    localEntities: { transactions: [t1] },
    cloudEntities: { transactions: [t1] }
  });
  assert.strictEqual(plan1.plannedLocalInserts.length, 0, 'No local inserts for identical ID');
  assert.strictEqual(plan1.plannedCloudInserts.length, 0, 'No cloud inserts for identical ID');
  assert.strictEqual(plan1.conflicts.length, 0, 'Zero conflicts');
  pass('TEST 1: Exact same primary ID matched with zero duplicates');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2 — Transaction same event / different IDs -> business-key match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 2: Transaction Same Event / Different IDs ---');
  const t2Local = { id: 'local_uuid_02', Date: '01/01/2024', Account: 'HDFC Bank', Amount: '1500', type: 'Expense', Category: 'Groceries', Subcategory: 'Daily', Note: 'Supermarket', Description: 'CRLF\r\nDesc', Tags: '#tag1' };
  const t2Cloud = { id: 'cloud_det_02', Date: '2024-01-01', Account: 'HDFC Bank', Amount: '1500', type: 'Expense', Category: 'Groceries', Subcategory: 'Daily', Note: 'Supermarket', Description: 'LF\nDesc', Tags: '' };
  const plan2 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t2Local] },
    cloudEntities: { transactions: [t2Cloud] }
  });
  assert.strictEqual(plan2.plannedLocalInserts.length, 0, 'Planned local inserts must be 0 for business match');
  assert.strictEqual(plan2.plannedCloudInserts.length, 0, 'Planned cloud inserts must be 0 for business match');
  assert.strictEqual(plan2.conflicts.length, 0, 'Zero conflicts for clean 1:1 business match');
  assert.strictEqual(plan2.duplicateInsertsPrevented, 1, 'Exactly 1 duplicate insert prevented');
  assert.strictEqual(plan2.identityAliases['cloud_det_02'], 'local_uuid_02', 'Alias mapped cloudId -> localId');
  pass('TEST 2: Same transaction with different IDs matches cleanly on business key');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 3 — Investment same event / different IDs -> investment business key match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 3: Investment Same Event / Different IDs ---');
  const inv3Local = { id: 'loc_inv_03', Date: '2024-02-01', SecuritySymbol: 'RELIANCE', SecurityISIN: 'INE002A01018', Quantity: 10, UnitPrice: 2500, TradeValue: 25000, InvestmentTransactionType: 'BUY', TradeId: 'TRD-1', Source: 'CAMS_CAS' };
  const inv3Cloud = { id: 'cld_inv_03', Date: '01/02/2024', SecuritySymbol: 'RELIANCE', SecurityISIN: 'INE002A01018', Quantity: 10, UnitPrice: 2500, TradeValue: 25000, InvestmentTransactionType: 'BUY', TradeId: '', Source: 'CAS' };
  const plan3 = await reconcile3Way({
    baseManifest: {},
    localEntities: { investment_transactions: [inv3Local] },
    cloudEntities: { investment_transactions: [inv3Cloud] }
  });
  assert.strictEqual(plan3.plannedLocalInserts.length, 0, 'No local insert for matching BUY trade');
  assert.strictEqual(plan3.plannedCloudInserts.length, 0, 'No cloud insert for matching BUY trade');
  assert.strictEqual(plan3.conflicts.length, 0, 'Zero conflicts');
  assert.strictEqual(plan3.duplicateInsertsPrevented, 1, '1 duplicate investment insert prevented');
  assert.strictEqual(plan3.identityAliases['cld_inv_03'], 'loc_inv_03', 'Investment alias mapped');
  pass('TEST 3: Investment trade with different IDs matches on investment business key');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 4 — Same date + amount but different category -> must NOT match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 4: Same Date & Amount, Different Category ---');
  const t4A = { id: 'local_04', Date: '01/01/2024', Account: 'HDFC Bank', Amount: '500', type: 'Expense', Category: 'Food', Subcategory: '', Note: 'Lunch' };
  const t4B = { id: 'cloud_04', Date: '01/01/2024', Account: 'HDFC Bank', Amount: '500', type: 'Expense', Category: 'Transport', Subcategory: '', Note: 'Lunch' };
  const plan4 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t4A] },
    cloudEntities: { transactions: [t4B] }
  });
  assert.strictEqual(plan4.plannedLocalInserts.length, 1, 'Cloud transport must be planned for local insert');
  assert.strictEqual(plan4.plannedCloudInserts.length, 1, 'Local food must be planned for cloud insert');
  pass('TEST 4: Different categories do not match');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 5 — Same date + amount + category but different note -> must NOT match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 5: Same Date, Amount, Category, Different Note ---');
  const t5A = { id: 'local_05', Date: '01/01/2024', Account: 'HDFC Bank', Amount: '500', type: 'Expense', Category: 'Food', Subcategory: 'Dining', Note: 'Lunch with Alice' };
  const t5B = { id: 'cloud_05', Date: '01/01/2024', Account: 'HDFC Bank', Amount: '500', type: 'Expense', Category: 'Food', Subcategory: 'Dining', Note: 'Dinner with Bob' };
  const plan5 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t5A] },
    cloudEntities: { transactions: [t5B] }
  });
  assert.strictEqual(plan5.plannedLocalInserts.length, 1, 'Cloud dinner must be planned for local insert');
  assert.strictEqual(plan5.plannedCloudInserts.length, 1, 'Local lunch must be planned for cloud insert');
  pass('TEST 5: Different notes do not match');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 6 — Duplicate/recurrent identical transactions with exact IDs on both sides
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 6: Recurrent Identical Transactions with Same IDs ---');
  const t6A = { id: 'txn_rec_1', Date: '01/01/2024', Account: 'Cash', Amount: '50', type: 'Expense', Category: 'Tea', Note: 'Chai' };
  const t6B = { id: 'txn_rec_2', Date: '01/01/2024', Account: 'Cash', Amount: '50', type: 'Expense', Category: 'Tea', Note: 'Chai' };
  const plan6 = await reconcile3Way({
    baseManifest: {
      txn_rec_1: { type: 'transactions', canonical: canonicalizeEntity(t6A, 'transactions') },
      txn_rec_2: { type: 'transactions', canonical: canonicalizeEntity(t6B, 'transactions') }
    },
    localEntities: { transactions: [t6A, t6B] },
    cloudEntities: { transactions: [t6A, t6B] }
  });
  assert.strictEqual(plan6.plannedLocalInserts.length, 0, 'No local inserts');
  assert.strictEqual(plan6.plannedCloudInserts.length, 0, 'No cloud inserts');
  assert.strictEqual(plan6.conflicts.length, 0, 'Zero conflicts (handled by Stage 1 primary ID)');
  pass('TEST 6: Recurrent identical transactions with same IDs match cleanly via Stage 1');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 7 — 1:N transaction collision -> IDENTITY_CONFLICT
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 7: 1 Local : N Cloud Collision -> IDENTITY_CONFLICT ---');
  const t7Local = { id: 'loc_7', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const t7Cloud1 = { id: 'cld_7a', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const t7Cloud2 = { id: 'cld_7b', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const plan7 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t7Local] },
    cloudEntities: { transactions: [t7Cloud1, t7Cloud2] }
  });
  assert.strictEqual(plan7.conflicts.length, 1, 'Must flag IDENTITY_CONFLICT');
  assert.strictEqual(plan7.conflicts[0].type, CONFLICT_TYPES.IDENTITY_CONFLICT, 'Conflict type is IDENTITY_CONFLICT');
  assert.strictEqual(plan7.plannedLocalInserts.length, 0, 'No auto-insert for ambiguous candidates');
  pass('TEST 7: 1:N collision safely flagged as IDENTITY_CONFLICT');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 8 — N:1 transaction collision -> IDENTITY_CONFLICT
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 8: N Local : 1 Cloud Collision -> IDENTITY_CONFLICT ---');
  const t8Local1 = { id: 'loc_8a', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const t8Local2 = { id: 'loc_8b', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const t8Cloud = { id: 'cld_8', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const plan8 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t8Local1, t8Local2] },
    cloudEntities: { transactions: [t8Cloud] }
  });
  assert.strictEqual(plan8.conflicts.length, 1, 'Must flag IDENTITY_CONFLICT');
  assert.strictEqual(plan8.conflicts[0].type, CONFLICT_TYPES.IDENTITY_CONFLICT, 'Conflict type is IDENTITY_CONFLICT');
  pass('TEST 8: N:1 collision safely flagged as IDENTITY_CONFLICT');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 9 — N:N transaction collision -> IDENTITY_CONFLICT
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 9: N Local : N Cloud Collision -> IDENTITY_CONFLICT ---');
  const t9Local1 = { id: 'loc_9a', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const t9Local2 = { id: 'loc_9b', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const t9Cloud1 = { id: 'cld_9a', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const t9Cloud2 = { id: 'cld_9b', Date: '01/01/2024', Account: 'Cash', Amount: '100', type: 'Expense', Category: 'Tea', Note: '' };
  const plan9 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: [t9Local1, t9Local2] },
    cloudEntities: { transactions: [t9Cloud1, t9Cloud2] }
  });
  assert.strictEqual(plan9.conflicts.length, 1, 'Must flag IDENTITY_CONFLICT');
  assert.strictEqual(plan9.conflicts[0].type, CONFLICT_TYPES.IDENTITY_CONFLICT, 'Conflict type is IDENTITY_CONFLICT');
  pass('TEST 9: N:N collision safely flagged as IDENTITY_CONFLICT');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 10 — BUY vs SELL -> must NOT match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 10: BUY vs SELL Must Not Match ---');
  const inv10Buy = { id: 'loc_buy', Date: '2024-04-01', SecuritySymbol: 'INFY', Quantity: 10, UnitPrice: 1500, TradeValue: 15000, InvestmentTransactionType: 'BUY' };
  const inv10Sell = { id: 'cld_sell', Date: '2024-04-01', SecuritySymbol: 'INFY', Quantity: 10, UnitPrice: 1500, TradeValue: 15000, InvestmentTransactionType: 'SELL' };
  const plan10 = await reconcile3Way({
    baseManifest: {},
    localEntities: { investment_transactions: [inv10Buy] },
    cloudEntities: { investment_transactions: [inv10Sell] }
  });
  assert.strictEqual(plan10.plannedLocalInserts.length, 1, 'Cloud SELL must be inserted locally');
  assert.strictEqual(plan10.plannedCloudInserts.length, 1, 'Local BUY must be inserted on cloud');
  pass('TEST 10: BUY and SELL with same date and amount remain distinct');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 11 — BUY vs CHARGE -> must NOT match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 11: BUY vs CHARGE Must Not Match ---');
  const inv11Charge = { id: 'loc_charge', Date: '2024-05-01', SecuritySymbol: 'HDFCBANK', TradeValue: 600, InvestmentTransactionType: 'CHARGE' };
  const inv11Buy = { id: 'cld_buy', Date: '2024-05-01', SecuritySymbol: 'HDFCBANK', TradeValue: 600, InvestmentTransactionType: 'BUY' };
  const plan11 = await reconcile3Way({
    baseManifest: {},
    localEntities: { investment_transactions: [inv11Charge] },
    cloudEntities: { investment_transactions: [inv11Buy] }
  });
  assert.strictEqual(plan11.plannedLocalInserts.length, 1, 'Cloud BUY must be planned for insert');
  assert.strictEqual(plan11.plannedCloudInserts.length, 1, 'Local CHARGE must be planned for insert');
  pass('TEST 11: BUY and CHARGE remain distinct events');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 12 — Tombstone vs Business Identity Match -> must NOT resurrect
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 12: Tombstone Prevents Resurrection Under Business Key ---');
  const t12Cloud = { id: 'cld_12', Date: '01/01/2024', Account: 'HDFC', Amount: '2000', type: 'Expense', Category: 'Bills', Note: '' };
  const plan12 = await reconcile3Way({
    baseManifest: { 'cld_12': { type: 'transactions', canonical: canonicalizeEntity(t12Cloud, 'transactions') } },
    localEntities: { transactions: [], sync_tombstones: [{ id: 'cld_12', entity_type: 'transaction' }] },
    cloudEntities: { transactions: [t12Cloud] }
  });
  assert.strictEqual(plan12.plannedLocalInserts.length, 0, 'Tombstoned record must not be inserted locally');
  assert.strictEqual(plan12.plannedCloudDeletes.length, 1, 'Deletion propagated to cloud');
  pass('TEST 12: Tombstone precedence prevents resurrection of matching cloud record');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 13 — Historical Base Manifest records with different IDs -> Identity match works
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 13: Historical Base Manifest Records with Different IDs ---');
  const t13Local = { id: 'loc_base_diff', Date: '10/01/2023', Account: 'SBI', Amount: '300', type: 'Expense', Category: 'Food', Note: 'Snack' };
  const t13Cloud = { id: 'cld_base_diff', Date: '10/01/2023', Account: 'SBI', Amount: '300', type: 'Expense', Category: 'Food', Note: 'Snack' };
  // Base manifest contains the local ID from Device A's historical sync
  const plan13 = await reconcile3Way({
    baseManifest: { 'loc_base_diff': { type: 'transactions', canonical: canonicalizeEntity(t13Local, 'transactions') } },
    localEntities: { transactions: [t13Local] },
    cloudEntities: { transactions: [t13Cloud] }
  });
  assert.strictEqual(plan13.plannedLocalInserts.length, 0, 'No local insert for matching base historical record');
  assert.strictEqual(plan13.plannedCloudInserts.length, 0, 'No cloud insert for matching base historical record');
  assert.strictEqual(plan13.duplicateInsertsPrevented, 1, '1 duplicate insert prevented');
  pass('TEST 13: Base manifest presence does not block business identity matching');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 14 — 1,549 Historical Transaction Simulation
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 14: 1,549 Historical Transaction Simulation ---');
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
      Subcategory: 'Apparel',
      Note: `Purchase ${i}`,
      Description: `Local CRLF\r\n${i}`,
      Tags: '#tag'
    });
    cloud1549.push({
      id: `cloud_hist_det_${i}`,
      Date: d,
      Amount: amt,
      INR: amt,
      type: 'Expense',
      Account: 'HDFC Savings',
      Category: 'Shopping',
      Subcategory: 'Apparel',
      Note: `Purchase ${i}`,
      Description: `Cloud LF\n${i}`,
      Tags: ''
    });
  }

  const plan14 = await reconcile3Way({
    baseManifest: {},
    localEntities: { transactions: local1549 },
    cloudEntities: { transactions: cloud1549 }
  });
  assert.strictEqual(plan14.plannedLocalInserts.length, 0, 'Planned local inserts must be 0 for all 1,549 matched pairs');
  assert.strictEqual(plan14.plannedCloudInserts.length, 0, 'Planned cloud inserts must be 0 for all 1,549 matched pairs');
  assert.strictEqual(plan14.duplicateInsertsPrevented, 1549, 'Exactly 1,549 duplicate inserts prevented');
  pass('TEST 14: 1,549 historical transactions matched with 0 duplicate local or cloud inserts');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 15 — 67 Historical Investment Transaction Simulation
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 15: 67 Historical Investment Transaction Simulation ---');
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
      Source: 'CAMS_CAS',
      TradeId: `TRD-${i}`
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
      Source: 'CAS',
      TradeId: ''
    });
  }

  const plan15 = await reconcile3Way({
    baseManifest: {},
    localEntities: { investment_transactions: local67 },
    cloudEntities: { investment_transactions: cloud67 }
  });
  assert.strictEqual(plan15.plannedLocalInserts.length, 0, 'Planned local inserts must be 0 for all 67 matched investment pairs');
  assert.strictEqual(plan15.plannedCloudInserts.length, 0, 'Planned cloud inserts must be 0 for all 67 matched investment pairs');
  assert.strictEqual(plan15.duplicateInsertsPrevented, 67, 'Exactly 67 duplicate investment inserts prevented');
  pass('TEST 15: 67 historical investment transactions matched with 0 duplicate inserts');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 16 — 24 Genuinely New Device A Transactions
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 16: 24 Genuinely New Local Transactions & Full Mixed Plan ---');
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
      Subcategory: 'Groceries',
      Note: `New lunch item ${i}`,
      Description: `Recent purchase ${i}`
    });
  }

  // 26,554 Common Exact-ID Transactions
  const common26554 = [];
  for (let i = 0; i < 26554; i++) {
    const item = {
      id: `common_txn_${i}`,
      Date: '15/05/2024',
      Amount: '100',
      INR: '100',
      type: 'Expense',
      Account: 'HDFC Savings',
      Category: 'Utilities',
      Subcategory: '',
      Note: ''
    };
    common26554.push(item);
  }

  // 830 Common Exact-ID Investments
  const commonInv830 = [];
  for (let i = 0; i < 830; i++) {
    const item = {
      id: `common_inv_${i}`,
      Date: '10/06/2024',
      SecuritySymbol: `STOCK_${i % 50}`,
      SecurityISIN: `INE002A01${String(i % 50).padStart(3, '0')}`,
      Quantity: 10,
      UnitPrice: 100,
      TradeValue: 1000,
      InvestmentTransactionType: 'BUY'
    };
    commonInv830.push(item);
  }

  const baseManifestFull = {};
  common26554.forEach(t => {
    baseManifestFull[t.id] = { type: 'transactions', canonical: canonicalizeEntity(t, 'transactions') };
  });
  commonInv830.forEach(t => {
    baseManifestFull[t.id] = { type: 'investment_transactions', canonical: canonicalizeEntity(t, 'investment_transactions') };
  });

  const plan16 = await reconcile3Way({
    baseManifest: baseManifestFull,
    localEntities: {
      transactions: [...common26554, ...local1549, ...newLocal24],
      investment_transactions: [...commonInv830, ...local67]
    },
    cloudEntities: {
      transactions: [...common26554, ...cloud1549],
      investment_transactions: [...commonInv830, ...cloud67]
    }
  });

  assert.strictEqual(plan16.plannedLocalInserts.length, 0, 'Planned local inserts must be exactly 0 (zero false duplicate downloads)');
  assert.strictEqual(plan16.plannedCloudInserts.length, 24, 'Planned cloud inserts must be exactly 24 (the 24 genuine new transactions)');
  assert.strictEqual(plan16.conflicts.length, 0, 'Zero false conflicts');
  assert.strictEqual(plan16.duplicateInsertsPrevented, 1549 + 67, 'Exactly 1,616 duplicate inserts prevented');
  assert.strictEqual(plan16.identityMatchedTransactions, 1549, '1,549 identity matched transactions');
  assert.strictEqual(plan16.identityMatchedInvestments, 67, '67 identity matched investments');
  assert.strictEqual(plan16.identityDiagnostic.transactionLocalCandidates, 1549 + 24, 'Transaction local candidate count matches');
  assert.strictEqual(plan16.identityDiagnostic.transactionCloudCandidates, 1549, 'Transaction cloud candidate count matches');
  assert.strictEqual(plan16.identityDiagnostic.investmentLocalCandidates, 67, 'Investment local candidate count matches');
  assert.strictEqual(plan16.identityDiagnostic.investmentCloudCandidates, 67, 'Investment cloud candidate count matches');
  pass('TEST 16: Complete mixed dataset (28,127 local vs 28,103 cloud) reconciled with exact 0 local inserts and 24 cloud inserts');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 17 — Strict Collection Dispatch & Type Safety Invariants
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 17: Strict Collection Dispatch & Type-Safety Assertions ---');

  // 1. Diagnostics samples must strictly maintain key prefixes
  for (const s of plan16.identityDiagnostic.sampleTransactionLocalOnly) {
    assert.ok(s.businessKey.startsWith('txn_biz:'), `Transaction local sample key "${s.businessKey}" must start with txn_biz:`);
    assert.ok(!s.businessKey.startsWith('inv_biz:'), `No inv_biz key allowed in transaction samples`);
  }
  for (const s of plan16.identityDiagnostic.sampleTransactionCloudOnly) {
    assert.ok(s.businessKey.startsWith('txn_biz:'), `Transaction cloud sample key "${s.businessKey}" must start with txn_biz:`);
    assert.ok(!s.businessKey.startsWith('inv_biz:'), `No inv_biz key allowed in transaction samples`);
  }
  for (const s of plan16.identityDiagnostic.sampleInvestmentLocalOnly) {
    assert.ok(s.businessKey.startsWith('inv_biz:'), `Investment local sample key "${s.businessKey}" must start with inv_biz:`);
    assert.ok(!s.businessKey.startsWith('txn_biz:'), `No txn_biz key allowed in investment samples`);
  }
  for (const s of plan16.identityDiagnostic.sampleInvestmentCloudOnly) {
    assert.ok(s.businessKey.startsWith('inv_biz:'), `Investment cloud sample key "${s.businessKey}" must start with inv_biz:`);
    assert.ok(!s.businessKey.startsWith('txn_biz:'), `No txn_biz key allowed in investment samples`);
  }

  // 2. getEntityBusinessKey strict collection dispatch invariant
  const ambiguousRecord = {
    Date: '01/01/2024',
    Amount: '500',
    INR: '500',
    type: 'Expense',
    Account: 'HDFC',
    Category: 'Investments',
    SecuritySymbol: 'RELIANCE',
    Quantity: 10,
    UnitPrice: 50
  };

  const keyWhenTxn = getEntityBusinessKey(ambiguousRecord, 'transactions');
  const keyWhenInv = getEntityBusinessKey(ambiguousRecord, 'investment_transactions');
  const keyWhenAcct = getEntityBusinessKey(ambiguousRecord, 'accounts');
  const keyWhenInvItem = getEntityBusinessKey(ambiguousRecord, 'inventory');

  assert.ok(keyWhenTxn.startsWith('txn_biz:'), 'Must generate txn_biz key when entityType is transactions');
  assert.ok(keyWhenInv.startsWith('inv_biz:'), 'Must generate inv_biz key when entityType is investment_transactions');
  assert.strictEqual(keyWhenAcct, null, 'Non-financial entity accounts must return null business key');
  assert.strictEqual(keyWhenInvItem, null, 'Non-financial entity inventory must return null business key');

  pass('TEST 17: Strict collection dispatch and type-safety assertions verified');

  console.log('\n====================================================');
  console.log('SUMMARY: ALL 17 TESTS PASSED (100%)');
  console.log('====================================================\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
