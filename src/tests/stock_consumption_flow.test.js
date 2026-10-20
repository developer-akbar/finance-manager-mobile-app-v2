/**
 * stock_consumption_flow.test.js — Regression test suite for Stock Inventory consumption and quantity-decrement flow
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDB,
  closeDB,
  getDB,
  addTransaction,
  updateTransaction,
  getTransactions,
  consumeInventoryItem,
  getInventoryItems,
  getTombstones,
  resolveBatchRefForInventoryRow
} from '../database/index.js';
import {
  extractNormalizedBatchesFromTransactions,
  groupBatchesByProduct,
  parseStockLine
} from '../utils/stockInventoryNormalization.js';

test('FinMan Stock Inventory — Quantity Decrement & Reconciliation Suite', async (suite) => {

  suite.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    await initDB();
  });

  suite.afterEach(() => {
    closeDB();
  });

  // 1. Single-batch consumption decreases the correct batch exactly once
  await suite.test('1. Single-batch consumption decreases the correct batch exactly once', async () => {
    const purchaseTxnId = 'txn-p1';
    await addTransaction({
      id: purchaseTxnId,
      date: '2026-10-01',
      time: '10:00',
      type: 'Transfer-Out',
      amount: 250,
      inr: 250,
      account: 'Checking',
      to_account: 'Stock',
      category: 'Stock',
      description: 'Basmati Rice stock available 1kg*5: 250: @200'
    });

    let txns = await getTransactions();
    let batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].purchasedQty, 5);
    assert.equal(batches[0].remainingQty, 5);

    // Consume 2 pieces
    const batch = batches[0];
    await consumeInventoryItem(
      batch.batchId,
      2,
      '2026-10-02',
      false,
      'To Home',
      'Groceries',
      'consume',
      '',
      3,
      '12:00',
      'Cooking lunch',
      batch
    );

    txns = await getTransactions();
    batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches[0].purchasedQty, 5);
    assert.equal(batches[0].remainingQty, 3, '5 packs - 2 consumed = 3 remaining');
    assert.equal(batches[0].consumedQty, 2, 'Consumed quantity is 2');
    assert.equal(batches[0].status, 'available');
  });

  // 2. FIFO consumption spanning two or more batches decrements each batch correctly
  await suite.test('2. FIFO consumption spanning two or more batches decrements each batch correctly', async () => {
    const db = getDB();

    // Batch 1: 1 pack bought 10 Jan 2026
    await addTransaction({
      id: 'txn-batch-a',
      date: '10/01/2026',
      time: '10:00',
      type: 'Transfer-Out',
      amount: 40,
      inr: 40,
      to_account: 'Stock',
      category: 'Stock',
      description: 'Dove Soap stock available 100g*1: 50: @40'
    });

    // Batch 2: 2 packs bought 15 Jan 2026
    await addTransaction({
      id: 'txn-batch-b',
      date: '15/01/2026',
      time: '10:00',
      type: 'Transfer-Out',
      amount: 80,
      inr: 80,
      to_account: 'Stock',
      category: 'Stock',
      description: 'Dove Soap stock available 100g*2: 100: @80'
    });

    // Insert corresponding inventory table rows (even with legacy UUIDs)
    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['inv-uuid-batch-a', 'Dove Soap', 1, 'pcs', 40, 'available', '2026-01-10']
    );
    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['inv-uuid-batch-b', 'Dove Soap', 2, 'pcs', 40, 'available', '2026-01-15']
    );

    let txns = await getTransactions();
    let batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches.length, 2);
    const initialTotal = batches.reduce((sum, b) => sum + b.remainingQty, 0);
    assert.equal(initialTotal, 3);

    // Consume 2 packs: 1 from Batch A, 1 from Batch B via FIFO
    const batchA = batches.find(b => b.batchId.includes('txn-batch-a'));
    await consumeInventoryItem(
      batchA.batchId,
      2,
      '2026-01-20',
      false,
      'To Home',
      'Groceries',
      'consume',
      '',
      3,
      '12:00',
      'Used 2 soaps',
      batchA
    );

    txns = await getTransactions();
    batches = extractNormalizedBatchesFromTransactions(txns);
    const updatedA = batches.find(b => b.batchId.includes('txn-batch-a'));
    const updatedB = batches.find(b => b.batchId.includes('txn-batch-b'));

    assert.equal(updatedA.remainingQty, 0, 'Batch A fully consumed (1 -> 0)');
    assert.equal(updatedA.consumedQty, 1);
    assert.equal(updatedA.status, 'unavailable');

    assert.equal(updatedB.remainingQty, 1, 'Batch B decremented via FIFO (2 -> 1)');
    assert.equal(updatedB.consumedQty, 1);
    assert.equal(updatedB.status, 'available');

    const finalTotal = batches.reduce((sum, b) => sum + b.remainingQty, 0);
    assert.equal(finalTotal, 1, 'Total stock remaining after FIFO is 1');
  });

  // 3. Legacy UUID-based stock references resolve to the correct batch when unambiguous
  await suite.test('3. Legacy UUID-based stock references resolve to the correct batch when unambiguous', async () => {
    const txns = [
      {
        id: '6e3ffd37-3455-43c4-ab27-89d04f402aea',
        ID: '6e3ffd37-3455-43c4-ab27-89d04f402aea',
        date: '07/08/2026',
        description: 'My Amazon\n\n\n\n\n\nOil stock available 1L*9: 1549: @1387'
      },
      {
        id: 'txn-oil-legacy-1',
        date: '22/08/2026',
        description: 'Used 2 pcs of Oil (2 pcs (bought on 7 Aug 2026 from Amazon Fresh))',
        tags: '#stock #consumed #stock_ref_de34ffd0-8639-4a05-81fd-f429eab188e4:2'
      },
      {
        id: 'txn-oil-legacy-2',
        date: '30/08/2026',
        description: 'Lent 1 pcs of Oil (1 pcs (bought on 7 Aug 2026 from Amazon Fresh))',
        tags: '#stock #lent #stock_ref_de34ffd0-8639-4a05-81fd-f429eab188e4:1'
      }
    ];

    const batches = extractNormalizedBatchesFromTransactions(txns);
    const oilBatch = batches.find(b => b.canonicalProduct === 'Cooking Oil');
    assert(oilBatch !== undefined, 'Oil batch found');
    assert.equal(oilBatch.purchasedQty, 9);
    assert.equal(oilBatch.consumedQty, 3, '2 used + 1 lent = 3 consumed via legacy UUID ref');
    assert.equal(oilBatch.remainingQty, 6, '9 purchased - 3 consumed = 6 remaining');
  });

  // 4. Santoor Soap's reported historical case produces the verified expected remaining quantity
  await suite.test("4. Santoor Soap's reported historical case produces verified expected remaining quantity (6)", async () => {
    const historicalTxns = [
      {
        id: '98e275ea-49da-4234-ab95-ccc78912f85b',
        ID: '98e275ea-49da-4234-ab95-ccc78912f85b',
        date: '28/04/2026',
        description: 'Mami Amazon\n\n\n\nSantoor Red stock available 125g*8: 264: @229, 7\n\nCinthol stock available 600g*2: 302: @264'
      },
      {
        id: '2a4227ec-928d-42d1-9a41-9b1338f960ce',
        date: '27/07/2026',
        description: 'Used 1 g of Santoor Red (1 g (bought on 28 Apr 2026 from Mami Amazon))',
        tags: '#stock #consumed #stock_ref_2026-04-28_98e275ea-49da-4234-ab95-ccc78912f85b_4:1'
      },
      {
        id: '878745a9-ec87-4904-86a4-7efecef0c922',
        date: '03/09/2026',
        description: 'Used 1 pcs of Santoor Red (1 pcs (bought on 28 Apr 2026 from Mami Amazon))',
        tags: '#stock #consumed #stock_ref_9ba4ff10-0847-40dd-9398-d5903ba598ec:1'
      }
    ];

    const batches = extractNormalizedBatchesFromTransactions(historicalTxns);
    const santoor = batches.find(b => b.canonicalProduct === 'Santoor Soap');

    assert(santoor !== undefined, 'Santoor Soap batch exists');
    assert.equal(santoor.purchasedQty, 8, 'Original purchase was 8 packs');
    assert.equal(santoor.consumedQty, 2, 'Exactly 2 soaps consumed in total (1 on 27/07, 1 on 03/09)');
    assert.equal(santoor.remainingQty, 6, 'Verified remaining count is exactly 6 (not 5 from double deduction, not 7 from skipped 03/09)');
    assert.equal(santoor.status, 'available');
  });

  // 5. Manual remaining-quantity baselines do not cause double deductions
  await suite.test('5. Manual remaining-quantity baselines do not cause double deductions', async () => {
    // Purchase with manual baseline ", 4" on a 10-pack item
    const txns = [
      {
        id: 'txn-base-p',
        date: '2026-06-01',
        description: 'Almonds stock available 100g*10: 1000: @800, 4'
      },
      // Retroactive tag representing usage prior to baseline cutoff (should not double-deduct from 4)
      {
        id: 'txn-base-c1',
        date: '2026-07-01',
        description: 'Used 1 pcs of Almonds',
        tags: '#stock #consumed #stock_ref_2026-06-01_txn-base-p_0:1'
      },
      // New tag after baseline cutoff (should deduct 1 from 4 -> 3)
      {
        id: 'txn-base-c2',
        date: '2026-09-15',
        description: 'Used 1 pcs of Almonds',
        tags: '#stock #consumed #stock_ref_2026-06-01_txn-base-p_0:1'
      }
    ];

    const batches = extractNormalizedBatchesFromTransactions(txns);
    const almonds = batches[0];
    assert.equal(almonds.purchasedQty, 10);
    assert.equal(almonds.remainingQty, 3, 'Baseline of 4 decrements by 1 (post-baseline txn) to 3, without double-deducting July txn');
    assert.equal(almonds.consumedQty, 7);
  });

  // 6. Unresolvable or ambiguous references fail safely and are surfaced for diagnosis
  await suite.test('6. Unresolvable or ambiguous references fail safely and are surfaced for diagnosis', async () => {
    const diagnostic = { unresolvedRefs: [] };
    const txns = [
      {
        id: 'txn-coffee-p',
        date: '2026-08-01',
        description: 'Coffee stock available 200g: 300: @250'
      },
      {
        id: 'txn-unknown-c',
        date: '2026-08-10',
        description: 'Used unknown item',
        tags: '#stock #consumed #stock_ref_unknown-ghost-uuid-123:1'
      }
    ];

    const batches = extractNormalizedBatchesFromTransactions(txns, diagnostic);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].remainingQty, 1, 'Existing batch is completely unaffected by bogus ref');
    assert.equal(diagnostic.unresolvedRefs.length, 1, 'Unresolved reference was tracked for diagnosis');
    assert.equal(diagnostic.unresolvedRefs[0].refId, 'unknown-ghost-uuid-123');
  });

  // 7. Stock consumption does not create deletion tombstones or alter unrelated records
  await suite.test('7. Stock consumption does not create deletion tombstones or alter unrelated records', async () => {
    const db = getDB();

    await addTransaction({
      id: 'txn-tea-p',
      date: '2026-10-05',
      to_account: 'Stock',
      category: 'Stock',
      description: 'Green Tea stock available 100g*4: 200: @160'
    });

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, status) VALUES (?, ?, ?, ?, ?, ?)',
      ['inv-green-tea', 'Green Tea', 4, 'pcs', 40, 'available']
    );

    // Unrelated transaction record
    await addTransaction({
      id: 'txn-unrelated-rent',
      date: '2026-10-05',
      type: 'Expense',
      amount: 15000,
      inr: 15000,
      category: 'Rent',
      account: 'HDFC',
      note: 'House Rent'
    });

    const tombsBefore = (await getTombstones()).length;

    await consumeInventoryItem(
      'inv-green-tea',
      2,
      '2026-10-06',
      false,
      'To Home',
      'Groceries',
      'consume',
      '',
      3,
      '15:00',
      'Afternoon tea'
    );

    const tombsAfter = (await getTombstones()).length;
    assert.equal(tombsBefore, tombsAfter, 'Zero deletion tombstones created during consumption');

    const invAfter = (await getInventoryItems()).find(i => i.id === 'inv-green-tea');
    assert.equal(parseFloat(invAfter.qty), 2, 'Inventory table decremented 4 -> 2');

    const allTxns = await getTransactions();
    const unrelatedTxn = allTxns.find(t => (t.id || t.ID || t._id) === 'txn-unrelated-rent');
    assert(unrelatedTxn !== undefined, 'Unrelated transaction completely intact');
    assert.equal(unrelatedTxn.INR, 15000, 'Unrelated amount unchanged');
  });

  // 8. Two genuinely ambiguous candidate batches remain unresolved and neither is decremented
  await suite.test('8. Two genuinely ambiguous candidate batches remain unresolved and neither is decremented', async () => {
    const diagnostic = { unresolvedRefs: [] };
    const txns = [
      {
        id: 'txn-dmart-purchase',
        date: '01/08/2026',
        description: 'DMart\n\n\n\nDove Soap stock available 100g*2: 100: @80\n\nDove Soap stock available 100g*3: 150: @120'
      },
      {
        id: 'txn-ambiguous-consume',
        date: '10/08/2026',
        description: 'Used 1 pcs of Dove Soap (1 pcs (bought on 1 Aug 2026 from DMart))',
        tags: '#stock #consumed #stock_ref_legacy-ambiguous-uuid-999:1'
      }
    ];

    const batches = extractNormalizedBatchesFromTransactions(txns, diagnostic);
    assert.equal(batches.length, 2, 'Two batches created from purchase lines');

    // Neither batch should be decremented because reference is ambiguous
    const batch1 = batches.find(b => b.purchasedQty === 2);
    const batch2 = batches.find(b => b.purchasedQty === 3);

    assert.equal(batch1.remainingQty, 2, 'Batch 1 remaining quantity untouched');
    assert.equal(batch1.consumedQty, 0, 'Batch 1 consumed quantity is 0');
    assert.equal(batch2.remainingQty, 3, 'Batch 2 remaining quantity untouched');
    assert.equal(batch2.consumedQty, 0, 'Batch 2 consumed quantity is 0');

    assert.equal(diagnostic.unresolvedRefs.length, 1, 'Ambiguous reference captured in diagnostic log');
    assert.equal(diagnostic.unresolvedRefs[0].refId, 'legacy-ambiguous-uuid-999');
  });

  // 9. Safe handling and disambiguation for duplicate / multi-line purchase transactions in resolveBatchRefForInventoryRow
  await suite.test('9. Safe handling and disambiguation for duplicate / multi-line purchase transactions in resolveBatchRefForInventoryRow', async () => {
    const db = getDB();

    // Case A: Truly duplicate identical lines on the same date (cannot be disambiguated)
    await addTransaction({
      id: 'txn-dup-lines',
      date: '10/08/2026',
      to_account: 'Stock',
      category: 'Stock',
      description: 'DMart\n\n\n\nDove Soap stock available 100g*2: 100: @80\n\nDove Soap stock available 100g*2: 100: @80'
    });

    const invRowIdentical = {
      id: 'inv-legacy-dup-uuid',
      name: 'Dove Soap',
      purchased_date: '2026-08-10',
      sub_qty: 100,
      sub_unit: 'g',
      pack_qty: 2,
      original_qty: 2,
      price: 80
    };

    const resolvedIdentical = await resolveBatchRefForInventoryRow(db, invRowIdentical);
    assert.equal(
      resolvedIdentical,
      'inv-legacy-dup-uuid',
      'Does not silently pick first line when duplicate identical lines exist; safely returns existing ID'
    );

    // Case B: Disambiguatable multi-lines on the same date (differing pack sizes)
    await addTransaction({
      id: 'txn-distinct-lines',
      date: '12/08/2026',
      to_account: 'Stock',
      category: 'Stock',
      description: 'DMart\n\n\n\nDove Soap stock available 100g*2: 100: @80\n\nDove Soap stock available 100g*5: 250: @200'
    });

    const invRow5Pack = {
      id: 'inv-legacy-5pack-uuid',
      name: 'Dove Soap',
      purchased_date: '2026-08-12',
      sub_qty: 100,
      sub_unit: 'g',
      pack_qty: 5,
      original_qty: 5,
      price: 200
    };

    const resolved5Pack = await resolveBatchRefForInventoryRow(db, invRow5Pack);
    assert.equal(
      resolved5Pack,
      '2026-08-12_txn-distinct-lines_6',
      'Successfully disambiguates to line index 6 for 5-pack item using pack attributes'
    );
  });

  // 10. Multi-line purchase transaction does not assign deduction to earlier sibling batch sharing the same txnUniqueId
  await suite.test('10. Multi-line purchase transaction does not assign deduction to earlier sibling batch', async () => {
    const purchaseTxn = {
      id: 'txn-multi-sibling',
      date: '07/08/2026',
      description: 'Amazon Fresh\n\n\n\nColgate stock available 800g: 360: @322\n\nOil stock available 1L*9: 1549: @1387'
    };

    const consumeTxn = {
      id: 'txn-consume-oil-7',
      date: '01/09/2026',
      description: 'Used 7 L of Oil (7 L (bought on 7 Aug 2026 from Amazon Fresh))',
      tags: '#stock #consumed #stock_ref_2026-08-07_txn-multi-sibling_6:7'
    };

    const batches = extractNormalizedBatchesFromTransactions([purchaseTxn, consumeTxn]);
    const colgate = batches.find(b => b.rawName.toLowerCase().includes('colgate'));
    const oil = batches.find(b => b.rawName.toLowerCase().includes('oil'));

    assert(colgate !== undefined, 'Colgate batch found');
    assert.equal(colgate.purchasedQty, 1, 'Colgate purchased quantity is 1');
    assert.equal(colgate.remainingQty, 1, 'Colgate batch on line 4 was not incorrectly decremented');
    assert.equal(colgate.consumedQty, 0, 'Colgate consumed quantity remains 0');

    assert(oil !== undefined, 'Cooking Oil batch found');
    assert.equal(oil.purchasedQty, 9, 'Cooking Oil purchased quantity is 9');
    assert.equal(oil.remainingQty, 2, 'Cooking Oil on line 6 correctly decremented from 9 to 2');
    assert.equal(oil.consumedQty, 7, 'Cooking Oil consumed quantity is 7');
  });

  // 11. Transaction edit from 7 L to 4 L updates canonical stock-reference suffix from :7 to :4 and reconciles inventory
  await suite.test('11. Transaction edit from 7 L to 4 L updates canonical stock-reference suffix and reconciles inventory', async () => {
    // 1. Cooking Oil purchase: 9 L bought on 07/08/2026
    const purchaseTxnId = '6e3ffd37-3455-43c4-ab27-89d04f402aea';
    await addTransaction({
      id: purchaseTxnId,
      date: '07/08/2026',
      time: '10:00',
      type: 'Transfer-Out',
      amount: 1387,
      inr: 1387,
      account: 'Checking',
      to_account: 'Stock',
      category: 'Stock',
      description: 'Amazon Fresh\n\n\n\nColgate stock available 800g: 360: @322\n\nOil stock available 1L*9: 1549: @1387'
    });

    const canonicalBatchId = `2026-08-07_${purchaseTxnId}_6`;

    // 2. Existing deductions: 2 L used (22/08) and 1 L lent (30/08)
    await addTransaction({
      id: 'txn-oil-deduct-2',
      date: '22/08/2026',
      time: '12:00',
      type: 'Expense',
      amount: 308,
      inr: 308,
      account: 'Stock',
      category: 'Groceries',
      description: 'Used 2 pcs of Oil (2 pcs (bought on 7 Aug 2026 from Amazon Fresh))',
      tags: `#stock #consumed #stock_ref_${canonicalBatchId}:2`
    });

    await addTransaction({
      id: 'txn-oil-deduct-1',
      date: '30/08/2026',
      time: '12:00',
      type: 'Expense',
      amount: 154,
      inr: 154,
      account: 'Lend',
      category: 'Lend',
      description: 'Lent 1 pcs of Oil (1 pcs (bought on 7 Aug 2026 from Amazon Fresh))',
      tags: `#stock #lent #stock_ref_${canonicalBatchId}:1`
    });

    // 3. September 1 consumption transaction: initially logged as 7 L / ₹1,079
    const consumeTxnId = '373a1f21-fec7-4d7e-9c6a-12142302af02';
    await addTransaction({
      id: consumeTxnId,
      date: '01/09/2026',
      time: '09:00',
      type: 'Expense',
      amount: 1079,
      inr: 1079,
      account: 'Stock',
      category: 'Groceries',
      note: 'groceries',
      description: 'Used 7 pcs of Oil (7 pcs (bought on 7 Aug 2026 from Amazon Fresh))',
      tags: `#stock #consumed #stock_ref_${canonicalBatchId}:7`
    });

    // Initial check before edit: 2 + 1 + 7 = 10 (capped at 9 purchased -> remaining 0, consumed 9)
    let txns = await getTransactions();
    let batches = extractNormalizedBatchesFromTransactions(txns);
    let oil = batches.find(b => b.canonicalProduct === 'Cooking Oil');
    assert.equal(oil.remainingQty, 0);
    assert.equal(oil.consumedQty, 9);

    // 4. Edit the September 1 consumption transaction from 7 L / ₹1,079 to 4 L / ₹616
    const updatedResult = await updateTransaction(consumeTxnId, {
      Description: 'Used 4 pcs of Oil (4 pcs (bought on 7 Aug 2026 from Amazon Fresh))',
      Amount: '616',
      INR: 616,
      Note: 'groceries',
      Tags: `#stock #consumed #stock_ref_${canonicalBatchId}:7` // original tags passed by UI
    });

    // Verify the canonical stock-reference suffix changes from :7 to :4
    assert.equal(
      updatedResult.tags,
      `#stock #consumed #stock_ref_${canonicalBatchId}:4`,
      'Stock reference tag suffix updated from :7 to :4'
    );

    // Verify transaction ID, batch ID, date, and unrelated tags remain unchanged
    assert.equal(updatedResult.id, consumeTxnId, 'Transaction ID remains unchanged');
    assert.equal(updatedResult.date, '01/09/2026', 'Transaction date remains unchanged');
    assert.equal(updatedResult.amount, '616', 'Financial amount is authoritative and updated to 616');
    assert.equal(updatedResult.inr, 616, 'Financial INR is authoritative and updated to 616');
    assert(updatedResult.tags.includes('#stock'), 'Unrelated tag #stock preserved');
    assert(updatedResult.tags.includes('#consumed'), 'Unrelated tag #consumed preserved');
    assert(updatedResult.tags.includes(canonicalBatchId), 'Exact canonical batch ID preserved');

    // Verify inventory shows Consumed = 7 L and Remaining = 2 L (2 used + 1 lent + 4 consumed = 7 L; 9 - 7 = 2 L)
    txns = await getTransactions();
    batches = extractNormalizedBatchesFromTransactions(txns);
    oil = batches.find(b => b.canonicalProduct === 'Cooking Oil');
    assert(oil !== undefined, 'Cooking Oil batch exists');
    assert.equal(oil.purchasedQty, 9, 'Purchased quantity remains 9 L');
    assert.equal(oil.consumedQty, 7, 'Inventory Consumed = 7 L (2 L used + 1 L lent + 4 L consumed)');
    assert.equal(oil.remainingQty, 2, 'Inventory Remaining = 2 L (9 L purchased - 7 L consumed)');
    assert.equal(oil.status, 'available', 'Batch status is available');
  });

  // 12. Normal transaction edit with no stock-reference tag
  await suite.test('12. Normal transaction edit with no stock-reference tag preserves tags and does not add stock refs', async () => {
    const normalTxnId = 'txn-normal-groceries';
    await addTransaction({
      id: normalTxnId,
      date: '15/09/2026',
      time: '18:30',
      type: 'Expense',
      amount: 450,
      inr: 450,
      account: 'HDFC',
      category: 'Food',
      note: 'Dinner',
      tags: '#dining #family'
    });

    const updated = await updateTransaction(normalTxnId, {
      amount: 550,
      inr: 550,
      note: 'Dinner with friends',
      tags: '#dining #family'
    });

    assert.equal(updated.amount, '550');
    assert.equal(updated.inr, 550);
    assert.equal(updated.note, 'Dinner with friends');
    assert.equal(updated.tags, '#dining #family', 'Tags remain untouched with no spurious stock refs');
    assert(!updated.tags.includes('#stock_ref_'), 'No stock-reference tag injected');
  });

  // 13. Transaction with multiple stock-reference tags / FIFO split deductions preserves distinct tags
  await suite.test('13. Transaction with multiple stock-reference tags / FIFO split deductions preserves distinct tags', async () => {
    const fifoTxnId = 'txn-fifo-consumption';
    const initialTags = '#stock #consumed #stock_ref_batch_alpha:1 #stock_ref_batch_beta:2';
    await addTransaction({
      id: fifoTxnId,
      date: '18/09/2026',
      time: '14:00',
      type: 'Expense',
      amount: 300,
      inr: 300,
      account: 'Stock',
      category: 'Groceries',
      description: 'Used 3 pcs of Dove Soap (1 pc from alpha, 2 pcs from beta)',
      tags: initialTags
    });

    // Edit transaction description and note without changing individual batch tags
    const updated = await updateTransaction(fifoTxnId, {
      note: 'Updated household consumption note',
      description: 'Used 3 pcs of Dove Soap (1 pc from alpha, 2 pcs from beta)',
      tags: initialTags
    });

    assert.equal(
      updated.tags,
      initialTags,
      'Multi-reference tags are preserved distinctly and not collapsed into a single aggregate tag'
    );
    assert(updated.tags.includes('#stock_ref_batch_alpha:1'), 'First FIFO batch tag preserved');
    assert(updated.tags.includes('#stock_ref_batch_beta:2'), 'Second FIFO batch tag preserved');
  });

  // 14. Description that does not contain a reliable explicit quantity preserves existing tags safely
  await suite.test('14. Description that does not contain a reliable explicit quantity preserves existing tags safely', async () => {
    const unparseableTxnId = 'txn-unreliable-desc';
    const initialTags = '#stock #consumed #stock_ref_batch_gamma:3';
    await addTransaction({
      id: unparseableTxnId,
      date: '20/09/2026',
      time: '11:00',
      type: 'Expense',
      amount: 150,
      inr: 150,
      account: 'Stock',
      category: 'Groceries',
      description: 'Used 3 pcs of Soap',
      tags: initialTags
    });

    // Edit description to a string without any identifiable quantity
    const updated = await updateTransaction(unparseableTxnId, {
      description: 'Used some soap for laundry purposes',
      tags: initialTags
    });

    assert.equal(
      updated.tags,
      initialTags,
      'Tags remain completely intact when description lacks explicit numeric quantity'
    );
  });

  // 15. Ambiguous or failed edit must not corrupt existing tags
  await suite.test('15. Ambiguous or failed edit must not corrupt existing tags', async () => {
    const ambigTxnId = 'txn-ambig-safety';
    const initialTags = '#stock #consumed #stock_ref_2026-08-07_6e3ffd37-3455-43c4-ab27-89d04f402aea_6:7';
    await addTransaction({
      id: ambigTxnId,
      date: '22/09/2026',
      time: '16:00',
      type: 'Expense',
      amount: 1079,
      inr: 1079,
      account: 'Stock',
      category: 'Groceries',
      description: 'Used 7 pcs of Oil',
      tags: initialTags
    });

    // Update with completely unrelated description (non-matching format)
    const updated = await updateTransaction(ambigTxnId, {
      description: 'Routine general monthly grocery purchase review',
      tags: initialTags
    });

    assert.equal(
      updated.tags,
      initialTags,
      'Existing canonical tag and quantity suffix preserved without corruption'
    );
  });

  // 16. Normalizer fallback reconciliation safely handles single-reference vs multi-reference FIFO transactions
  await suite.test('16. Normalizer fallback reconciliation safely handles single-reference vs multi-reference FIFO transactions', async () => {
    // Case A1: Unambiguous single-reference consumption WITH parentheses matching candidate batch
    const purchaseTxn = {
      id: 'txn-oil-purchase-test16',
      date: '07/08/2026',
      description: 'Amazon Fresh\n\n\n\nOil stock available 1L*9: 1549: @1387'
    };
    const staleTagWithParens = {
      id: 'txn-stale-with-parens',
      date: '01/09/2026',
      description: 'Used 4 pcs of Oil (4 pcs (bought on 7 Aug 2026 from Amazon Fresh))',
      tags: '#stock #consumed #stock_ref_2026-08-07_txn-oil-purchase-test16_4:7' // Stale tag suffix :7, description says 4 pcs
    };

    let batches = extractNormalizedBatchesFromTransactions([purchaseTxn, staleTagWithParens]);
    let oil = batches.find(b => b.canonicalProduct === 'Cooking Oil');
    assert.equal(oil.consumedQty, 4, 'Single-ref fallback with parens reconciled to 4 L');
    assert.equal(oil.remainingQty, 5, 'Remaining is 9 - 4 = 5 L');

    // Case A2: Single-reference consumption WITHOUT parentheses matching candidate batch
    const staleTagWithoutParens = {
      id: 'txn-stale-no-parens',
      date: '01/09/2026',
      description: 'Used 4 pcs of Oil',
      tags: '#stock #consumed #stock_ref_2026-08-07_txn-oil-purchase-test16_4:7'
    };
    batches = extractNormalizedBatchesFromTransactions([purchaseTxn, staleTagWithoutParens]);
    oil = batches.find(b => b.canonicalProduct === 'Cooking Oil');
    assert.equal(oil.consumedQty, 4, 'Single-ref fallback without parens reconciled to 4 L');
    assert.equal(oil.remainingQty, 5, 'Remaining is 9 - 4 = 5 L');

    // Case A3: Mismatched product name WITH parentheses preserves tag and logs diagnostic
    const diagWithParens = { unresolvedRefs: [] };
    const mismatchWithParens = {
      id: 'txn-mismatch-parens',
      date: '01/09/2026',
      description: 'Used 2 pcs of Detergent Powder (bought on 7 Aug 2026 from Amazon Fresh)',
      tags: '#stock #consumed #stock_ref_2026-08-07_txn-oil-purchase-test16_4:7'
    };
    batches = extractNormalizedBatchesFromTransactions([purchaseTxn, mismatchWithParens], diagWithParens);
    oil = batches.find(b => b.canonicalProduct === 'Cooking Oil');
    assert.equal(oil.consumedQty, 7, 'Mismatched product with parens strictly preserves tag :7');
    assert.equal(oil.remainingQty, 2, 'Remaining is 9 - 7 = 2 L');
    assert.equal(diagWithParens.unresolvedRefs.length, 1, 'Diagnostic recorded for product mismatch with parens');
    assert.equal(diagWithParens.unresolvedRefs[0].reason, 'FALLBACK_PRODUCT_NAME_MISMATCH');

    // Case A4: Mismatched product name WITHOUT parentheses preserves tag and logs diagnostic
    const diagNoParens = { unresolvedRefs: [] };
    const mismatchNoParens = {
      id: 'txn-mismatch-no-parens',
      date: '01/09/2026',
      description: 'Used 2 pcs of Detergent Powder',
      tags: '#stock #consumed #stock_ref_2026-08-07_txn-oil-purchase-test16_4:7'
    };
    batches = extractNormalizedBatchesFromTransactions([purchaseTxn, mismatchNoParens], diagNoParens);
    oil = batches.find(b => b.canonicalProduct === 'Cooking Oil');
    assert.equal(oil.consumedQty, 7, 'Mismatched product without parens strictly preserves tag :7');
    assert.equal(oil.remainingQty, 2, 'Remaining is 9 - 7 = 2 L');
    assert.equal(diagNoParens.unresolvedRefs.length, 1, 'Diagnostic recorded for product mismatch without parens');
    assert.equal(diagNoParens.unresolvedRefs[0].reason, 'FALLBACK_PRODUCT_NAME_MISMATCH');

    // Case B: Multi-reference FIFO transaction where description is "Used 3 pcs of Soap" across two 1-pack batches
    // Proves that FIFO / multi-reference transactions remain untouched and are NOT overridden by aggregate description quantity
    const soapBatchA = {
      id: 'txn-soap-a',
      date: '01/08/2026',
      description: 'Dove Soap stock available 100g*2: 100: @80'
    };
    const soapBatchB = {
      id: 'txn-soap-b',
      date: '05/08/2026',
      description: 'Dove Soap stock available 100g*2: 100: @80'
    };
    const fifoConsumeTxn = {
      id: 'txn-fifo-multi-ref',
      date: '10/08/2026',
      description: 'Used 3 pcs of Dove Soap (1 pc from batch A, 2 pcs from batch B)',
      tags: '#stock #consumed #stock_ref_2026-08-01_txn-soap-a_0:1 #stock_ref_2026-08-05_txn-soap-b_0:2'
    };

    batches = extractNormalizedBatchesFromTransactions([soapBatchA, soapBatchB, fifoConsumeTxn]);
    const bA = batches.find(b => b.batchId.includes('txn-soap-a'));
    const bB = batches.find(b => b.batchId.includes('txn-soap-b'));
    assert.equal(bA.consumedQty, 1, 'Batch A consumed quantity remains exactly 1 from its specific tag');
    assert.equal(bA.remainingQty, 1, 'Batch A remaining quantity is 2 - 1 = 1');
    assert.equal(bB.consumedQty, 2, 'Batch B consumed quantity remains exactly 2 from its specific tag');
    assert.equal(bB.remainingQty, 0, 'Batch B remaining quantity is 2 - 2 = 0');
  });

});


