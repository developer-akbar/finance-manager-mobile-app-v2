import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProductStockActivity } from '../utils/stockActivityHistory.js';

test('FinMan Stock Inventory — Item Activity & Transaction History Test Suite', async (suite) => {

  // Sample Mock Batches
  const mockBatches = [
    {
      id: 'batch_oil_1',
      batchId: '2026-05-10_txn-p1_0',
      canonicalProduct: 'Cooking Oil',
      cleanedName: 'Cooking Oil',
      purchasedQty: 5,
      unitPrice: 150,
      paid: 750,
      mrp: 800,
      unit: 'pcs',
      sub_qty: 1,
      sub_unit: 'L',
      purchasedDate: '2026-05-10',
      source: 'DMart',
      txnUniqueId: 'txn-p1',
      variant: '1L*5'
    },
    {
      id: 'batch_oil_2',
      batchId: '2026-06-15_txn-p2_0',
      canonicalProduct: 'Cooking Oil',
      cleanedName: 'Cooking Oil',
      purchasedQty: 3,
      unitPrice: 160,
      paid: 480,
      mrp: 500,
      unit: 'pcs',
      sub_qty: 1,
      sub_unit: 'L',
      purchasedDate: '2026-06-15',
      source: 'Amazon',
      txnUniqueId: 'txn-p2',
      variant: '1L*3'
    },
    {
      id: 'batch_tea_1',
      batchId: '2026-05-12_txn-p3_0',
      canonicalProduct: 'Gemini Tea',
      cleanedName: 'Gemini Tea',
      purchasedQty: 2,
      unitPrice: 120,
      paid: 240,
      mrp: 260,
      unit: 'pcs',
      sub_qty: 500,
      sub_unit: 'g',
      purchasedDate: '2026-05-12',
      source: 'Local Store',
      txnUniqueId: 'txn-p3',
      variant: '500g*2'
    }
  ];

  await suite.test('1. Product-level history aggregates multiple purchase batches and chronological balance', async () => {
    const transactions = [
      {
        id: 'txn-c1',
        Date: '2026-05-20',
        Time: '14:30',
        Account: 'Stock',
        tags: '#stock #consumed #stock_ref_2026-05-10_txn-p1_0:1',
        Description: 'Used 1 pc of Cooking Oil (Batch: 2026-05-10_txn-p1_0)',
        INR: 150
      },
      {
        id: 'txn-l1',
        Date: '2026-06-20',
        Time: '18:00',
        Account: 'Stock',
        ToAccount: 'Lend',
        tags: '#stock #lent #stock_ref_2026-06-15_txn-p2_0:1',
        Note: 'to Ramesh',
        Description: 'Lent 1 pc of Cooking Oil to Ramesh (Batch: 2026-06-15_txn-p2_0)',
        INR: 160
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions,
      batches: mockBatches
    });

    assert.equal(result.summary.productName, 'Cooking Oil');
    assert.equal(result.summary.totalPurchasedQty, 8, '5 + 3 = 8 packs purchased across 2 batches');
    assert.equal(result.summary.totalConsumedQty, 1, '1 consumed');
    assert.equal(result.summary.totalLentQty, 1, '1 lent');
    assert.equal(result.summary.outstandingLentQty, 1, '1 outstanding lent');
    assert.equal(result.summary.currentRemainingQty, 6, '8 - 1 - 1 = 6 remaining');
    assert.equal(result.summary.status, 'Partially Lent');

    // Newest first by default
    assert.equal(result.activities.length, 4, '2 purchases + 1 consume + 1 lend');
    assert.equal(result.activities[0].type, 'lend');
    assert.equal(result.activities[0].person, 'Ramesh');
    assert.equal(result.activities[0].runningBalance, 6, 'Balance after lend is 6');

    assert.equal(result.activities[1].type, 'purchase');
    assert.equal(result.activities[1].date, '2026-06-15');
    assert.equal(result.activities[1].runningBalance, 7, 'Balance after purchase 2 is 4 + 3 = 7');

    assert.equal(result.activities[2].type, 'consume');
    assert.equal(result.activities[2].runningBalance, 4, 'Balance after consume 1 is 5 - 1 = 4');

    assert.equal(result.activities[3].type, 'purchase');
    assert.equal(result.activities[3].runningBalance, 5, 'Initial purchase is 5');
  });

  await suite.test('2. Batch-level history restricted strictly to selected batch without cross-batch pollution', async () => {
    const transactions = [
      {
        id: 'txn-c1',
        Date: '2026-05-20',
        tags: '#stock #consumed #stock_ref_2026-05-10_txn-p1_0:1',
        Description: 'Used 1 pc of Cooking Oil',
        INR: 150
      },
      {
        id: 'txn-c2',
        Date: '2026-06-25',
        tags: '#stock #consumed #stock_ref_2026-06-15_txn-p2_0:2',
        Description: 'Used 2 pcs of Cooking Oil',
        INR: 320
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      selectedBatchId: '2026-05-10_txn-p1_0',
      transactions,
      batches: mockBatches
    });

    assert.equal(result.summary.totalPurchasedQty, 5, 'Only batch 1 purchased qty');
    assert.equal(result.summary.totalConsumedQty, 1, 'Only batch 1 consumption included');
    assert.equal(result.summary.currentRemainingQty, 4);
    assert.equal(result.activities.length, 2, 'Batch 1 purchase and its 1 consumption');
  });

  await suite.test('3. Similar product names do NOT cross-talk (Gemini Tea vs Cooking Oil)', async () => {
    const transactions = [
      {
        id: 'txn-tea-c',
        Date: '2026-05-15',
        tags: '#stock #consumed #stock_ref_2026-05-12_txn-p3_0:1',
        Description: 'Used 1 pc of Gemini Tea',
        INR: 120
      }
    ];

    const resultOil = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions,
      batches: mockBatches
    });

    const teaActivities = resultOil.activities.filter(a => a.type === 'consume');
    assert.equal(teaActivities.length, 0, 'No Gemini Tea consumptions appear in Cooking Oil history');

    const resultTea = extractProductStockActivity({
      productName: 'Gemini Tea',
      transactions,
      batches: mockBatches
    });
    assert.equal(resultTea.summary.totalPurchasedQty, 2);
    assert.equal(resultTea.summary.totalConsumedQty, 1);
    assert.equal(resultTea.summary.currentRemainingQty, 1);
  });

  await suite.test('4. Physical return increases quantity and settles outstanding lent balance', async () => {
    const transactions = [
      {
        id: 'txn-l1',
        Date: '2026-06-01',
        Account: 'Stock',
        ToAccount: 'Lend',
        tags: '#stock #lent #stock_ref_2026-05-10_txn-p1_0:2',
        Note: 'to Priya',
        Description: 'Lent 2 pcs of Cooking Oil',
        INR: 300
      },
      {
        id: 'txn-ret1',
        Date: '2026-06-10',
        Account: 'Lend',
        ToAccount: 'Stock',
        tags: '#stock #return #stock_ref_2026-05-10_txn-p1_0:1',
        Note: 'return from Priya',
        Description: 'Returned 1 pc of Cooking Oil to stock',
        INR: 150
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      selectedBatchId: '2026-05-10_txn-p1_0',
      transactions,
      batches: mockBatches
    });

    assert.equal(result.summary.totalLentQty, 2, '2 lent originally');
    assert.equal(result.summary.totalReturnedQty, 1, '1 returned');
    assert.equal(result.summary.outstandingLentQty, 1, '1 still outstanding');
    assert.equal(result.summary.currentRemainingQty, 4, '5 - 2 + 1 = 4 remaining in stock');

    const returnAct = result.activities.find(a => a.type === 'return');
    assert.ok(returnAct, 'Return activity present');
    assert.equal(returnAct.qtyDelta, 1);
    assert.equal(returnAct.runningBalance, 4);
  });

  await suite.test('5. Installment financial payment does NOT double-deduct physical stock', async () => {
    const transactions = [
      // Part 1: Physical consumption with #stock_ref_
      {
        id: 'txn-inst-1',
        Date: '2026-05-15',
        Account: 'Stock',
        tags: '#stock #instalment #stock_ref_2026-05-10_txn-p1_0:1',
        Description: 'Instalment Use 1 pc of Cooking Oil (Part 1/3)',
        INR: 50
      },
      // Part 2: Purely financial scheduled installment payment
      {
        id: 'txn-inst-2',
        Date: '2026-06-15',
        Account: 'Stock',
        tags: '#stock #instalment',
        Description: 'Instalment Use 1 pc of Cooking Oil (Part 2/3)',
        INR: 50
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      selectedBatchId: '2026-05-10_txn-p1_0',
      transactions,
      batches: mockBatches
    });

    assert.equal(result.summary.totalConsumedQty, 1, 'Only Part 1 deducted physical quantity');
    assert.equal(result.summary.currentRemainingQty, 4, '5 - 1 = 4 remaining');

    const finAct = result.activities.find(a => a.type === 'installment_payment');
    assert.ok(finAct, 'Financial installment payment entry recorded');
    assert.equal(finAct.isPhysical, false);
    assert.equal(finAct.qtyDelta, 0);
    assert.equal(finAct.runningBalance, 4, 'Balance remains 4 after financial payment');
  });

  await suite.test('6. Empty state handled gracefully without mutations or throwing', async () => {
    const result = extractProductStockActivity({
      productName: 'Nonexistent Item',
      transactions: [],
      batches: []
    });

    assert.equal(result.summary.totalBatches, 0);
    assert.equal(result.summary.currentRemainingQty, 0);
    assert.equal(result.activities.length, 0);
  });

  await suite.test('7. Legacy transactions without modern #stock_ref_ match correctly via description', async () => {
    const transactions = [
      {
        id: 'txn-legacy-1',
        Date: '2026-05-18',
        tags: '#stock #consumed',
        Description: 'Used 2 pcs of Cooking Oil (from pantry)',
        INR: 300
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions,
      batches: mockBatches
    });

    const legacyAct = result.activities.find(a => a.id === 'legacy_txn-legacy-1');
    assert.ok(legacyAct, 'Legacy consumption recognized');
    assert.equal(legacyAct.qtyDelta, -2);
    assert.equal(legacyAct.isLegacy, true);
    assert.equal(result.summary.totalConsumedQty, 2);
  });

  await suite.test('8. Ambiguous or unresolved batch references are flagged without cross-talking', async () => {
    const transactions = [
      {
        id: 'txn-unresolved-1',
        Date: '2026-05-19',
        tags: '#stock #consumed #stock_ref_ghost_uuid_999:1',
        Description: 'Used 1 pc of Cooking Oil from unknown ghost batch',
        INR: 150
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions,
      batches: mockBatches
    });

    assert.equal(result.unmatchedRecords.length, 1, 'Ghost batch flagged in unmatchedRecords');
    assert.equal(result.unmatchedRecords[0].reason, 'UNRESOLVED_BATCH_REFERENCE');
  });

  await suite.test('9. No duplicate activity entries when multiple tags exist on same transaction', async () => {
    const transactions = [
      {
        id: 'txn-dup-tag',
        Date: '2026-05-20',
        tags: '#stock #consumed #stock_ref_2026-05-10_txn-p1_0:1 #stock_ref_2026-05-10_txn-p1_0:1',
        Description: 'Used 1 pc of Cooking Oil',
        INR: 150
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions,
      batches: mockBatches
    });

    const consumeActs = result.activities.filter(a => a.txnId === 'txn-dup-tag');
    assert.equal(consumeActs.length, 1, 'Duplicate tag deduped safely to 1 activity');
  });

  await suite.test('10. Running quantity balance correctly handles fractional and multi-step movements', async () => {
    const transactions = [
      {
        id: 'txn-frac-1',
        Date: '2026-05-15',
        tags: '#stock #consumed #stock_ref_2026-05-10_txn-p1_0:1.5',
        Description: 'Used 1 1/2 pcs of Cooking Oil',
        INR: 225
      },
      {
        id: 'txn-frac-2',
        Date: '2026-05-25',
        tags: '#stock #consumed #stock_ref_2026-05-10_txn-p1_0:0.5',
        Description: 'Used 1/2 pc of Cooking Oil',
        INR: 75
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      selectedBatchId: '2026-05-10_txn-p1_0',
      transactions,
      batches: mockBatches
    });

    assert.equal(result.summary.totalConsumedQty, 2, '1.5 + 0.5 = 2 pcs');
    assert.equal(result.summary.currentRemainingQty, 3, '5 - 2 = 3 pcs');
    assert.equal(result.activities[0].runningBalance, 3);
    assert.equal(result.activities[1].runningBalance, 3.5);
    assert.equal(result.activities[2].runningBalance, 5);
  });

  await suite.test('11. Read-only safety: extractProductStockActivity does NOT mutate inputs', async () => {
    const originalTxns = [
      {
        id: 'txn-safety-1',
        Date: '2026-05-20',
        tags: '#stock #consumed #stock_ref_2026-05-10_txn-p1_0:1',
        Description: 'Used 1 pc of Cooking Oil',
        INR: 150
      }
    ];
    const txnCopy = JSON.parse(JSON.stringify(originalTxns));
    const batchCopy = JSON.parse(JSON.stringify(mockBatches));

    extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions: originalTxns,
      batches: mockBatches
    });

    assert.deepEqual(originalTxns, txnCopy, 'Transactions untouched');
    assert.deepEqual(mockBatches, batchCopy, 'Batches untouched');
  });

  await suite.test('12. Chronological ordering respects date and purchase precedence', async () => {
    const transactions = [
      {
        id: 'txn-same-day-consume',
        Date: '2026-05-10',
        Time: '18:00',
        tags: '#stock #consumed #stock_ref_2026-05-10_txn-p1_0:1',
        Description: 'Used 1 pc of Cooking Oil on same date',
        INR: 150
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      selectedBatchId: '2026-05-10_txn-p1_0',
      transactions,
      batches: mockBatches
    });

    // In timeline (newest first), consume is at index 0 and purchase is at index 1
    assert.equal(result.activities[0].type, 'consume');
    assert.equal(result.activities[1].type, 'purchase');
    assert.equal(result.activities[1].runningBalance, 5, 'Purchase established initial 5');
    assert.equal(result.activities[0].runningBalance, 4, 'Same-day consume decremented to 4');
  });

  await suite.test('13. Mixed variants and mixed physical units aggregate both packs and volume accurately', async () => {
    const mixedBatches = [
      {
        id: 'oil_tin_15L',
        batchId: '2026-01-10_b1',
        canonicalProduct: 'Cooking Oil',
        cleanedName: 'Cooking Oil',
        variant: '15L*1',
        purchasedQty: 1, // 1 pack of 15L
        consumedQty: 0,
        remainingQty: 1,
        unitPrice: 2400,
        paid: 2400,
        unit: 'pcs',
        sub_qty: 15,
        sub_unit: 'L',
        purchasedDate: '2026-01-10'
      },
      {
        id: 'oil_can_5L',
        batchId: '2026-02-15_b2',
        canonicalProduct: 'Cooking Oil',
        cleanedName: 'Cooking Oil',
        variant: '5L*2',
        purchasedQty: 2, // 2 packs of 5L = 10L
        consumedQty: 0,
        remainingQty: 2,
        unitPrice: 850,
        paid: 1700,
        unit: 'pcs',
        sub_qty: 5,
        sub_unit: 'L',
        purchasedDate: '2026-02-15'
      },
      {
        id: 'oil_pouch_1L',
        batchId: '2026-03-20_b3',
        canonicalProduct: 'Cooking Oil',
        cleanedName: 'Cooking Oil',
        variant: '1L*25',
        purchasedQty: 25, // 25 packs of 1L = 25L
        consumedQty: 0,
        remainingQty: 25,
        unitPrice: 160,
        paid: 4000,
        unit: 'pcs',
        sub_qty: 1,
        sub_unit: 'L',
        purchasedDate: '2026-03-20'
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions: [],
      batches: mixedBatches
    });

    // 1 + 2 + 25 = 28 packs total!
    assert.equal(result.summary.totalPurchasedQty, 28, 'Total pack count is 28 packs');
    assert.equal(result.summary.currentRemainingQty, 28, 'Remaining pack count is 28 packs');
    assert.equal(result.summary.hasPhysicalData, true, 'Has physical volume data');
    assert.equal(result.summary.purchasedPhysical, '50 L', '15L + 10L + 25L = 50 L total volume');
    assert.equal(result.summary.purchasedDisplay, '28 packs (50 L)');
    assert.equal(result.summary.remainingDisplay, '28 packs (50 L)');
  });

  await suite.test('14. Transfer-Out from Amazon to Stock is classified as Stock Purchase with dual roles', async () => {
    const amazonPurchaseBatch = [
      {
        id: 'batch_amazon_oil',
        batchId: '2026-08-07_txn-amz_0',
        canonicalProduct: 'Cooking Oil',
        cleanedName: 'Cooking Oil',
        purchasedQty: 9,
        unitPrice: 180,
        paid: 1620,
        unit: 'pcs',
        sub_qty: 1,
        sub_unit: 'L',
        purchasedDate: '2026-08-07',
        source: 'Amazon',
        txnUniqueId: 'txn-amz',
        variant: '1L*9',
        originalTxn: {
          id: 'txn-amz',
          Date: '2026-08-07',
          Time: '10:15',
          Account: 'Amazon',
          FromAccount: 'Amazon',
          ToAccount: 'Stock',
          Type: 'Transfer-Out',
          Category: 'Transfer',
          Tags: '#stock',
          Note: 'in stock',
          Description: 'Cooking Oil stock available 1L*9: 1800: @1620',
          INR: 1620
        }
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions: [amazonPurchaseBatch[0].originalTxn],
      batches: amazonPurchaseBatch
    });

    assert.equal(result.activities.length, 1);
    const purchaseAct = result.activities[0];
    assert.equal(purchaseAct.type, 'purchase');
    assert.equal(purchaseAct.typeLabel, 'Purchased / Stock In');
    assert.equal(purchaseAct.classificationStatus, 'verified');
    assert.equal(purchaseAct.financialRole, 'Transfer-Out (Amazon ➔ Stock)');
    assert.equal(purchaseAct.inventoryRole, 'Stock Purchase / Stock In');
    assert.ok(purchaseAct.classificationExplanation.includes('Funded from Amazon'));
  });

  await suite.test('15. Unresolved or ambiguous stock references are isolated in unmatchedRecords', async () => {
    const txns = [
      {
        id: 'txn-unresolved-1',
        Date: '2026-09-01',
        Time: '11:00',
        tags: '#stock_ref_ghost_batch_999:1',
        Description: 'Used 1 pc of Cooking Oil (from deleted mystery batch)',
        INR: 150
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions: txns,
      batches: mockBatches
    });

    // Must NOT be included in verified activities (which establish running balance)
    const verifiedConsumptions = result.activities.filter(a => a.type === 'consume');
    assert.equal(verifiedConsumptions.length, 0, 'Unresolved reference excluded from verified timeline');

    // Must be preserved in unmatchedRecords for user inspection
    assert.equal(result.unmatchedRecords.length, 1, 'Isolated in unmatchedRecords');
    assert.equal(result.unmatchedRecords[0].txnId, 'txn-unresolved-1');
    assert.equal(result.unmatchedRecords[0].reason, 'UNRESOLVED_BATCH_REFERENCE');
    assert.ok(result.unmatchedRecords[0].rawTxn !== undefined, 'Raw transaction available for inspection');
  });

  await suite.test('16. Cooking Oil discrepancy reproduction — 35 batches, 580 purchased, 552 consumed/lent, 28 available', async () => {
    // 33 historical batches totaling 546 packs, all fully consumed with 0 remaining
    const historicalBatches = [];
    let histPurchasedSum = 0;
    for (let i = 1; i <= 33; i++) {
      const pQty = i <= 20 ? 16 : 18; // 20 * 16 + 13 * 18 = 320 + 234 = 554... adjust to 546
      // let's exact: 27 batches of 16 (432) + 6 batches of 19 (114) = 546
      const qty = i <= 27 ? 16 : 19;
      histPurchasedSum += qty;
      const month = String((i % 12) + 1).padStart(2, '0');
      const year = i <= 12 ? '2024' : (i <= 24 ? '2025' : '2026');
      historicalBatches.push({
        id: `batch_oil_hist_${i}`,
        batchId: `batch_oil_hist_${i}`,
        canonicalProduct: 'Cooking Oil',
        cleanedName: 'Cooking Oil',
        purchasedQty: qty,
        remainingQty: 0,
        consumedQty: qty,
        status: 'unavailable',
        unitPrice: 140,
        paid: qty * 140,
        mrp: qty * 160,
        unit: 'pcs',
        sub_qty: 1,
        sub_unit: 'L',
        purchasedDate: `${year}-${month}-05`,
        source: 'DMart',
        variant: `1L*${qty}`
      });
    }
    assert.equal(histPurchasedSum, 546, '33 historical batches sum to 546 packs');

    // Batch 34: 1 pack purchased, lent to neighbor, 0 remaining
    const lendBatch = {
      id: 'batch_oil_lend',
      batchId: 'batch_oil_lend',
      canonicalProduct: 'Cooking Oil',
      cleanedName: 'Cooking Oil',
      purchasedQty: 1,
      remainingQty: 0,
      consumedQty: 1,
      status: 'unavailable',
      unitPrice: 150,
      paid: 150,
      mrp: 160,
      unit: 'pcs',
      sub_qty: 1,
      sub_unit: 'L',
      purchasedDate: '2026-07-10',
      source: 'Local Store',
      variant: '1L*1'
    };

    // Batch 35: 33 packs purchased, 5 consumed dynamically, 28 remaining available
    const activeBatch = {
      id: 'batch_oil_active',
      batchId: 'batch_oil_active',
      canonicalProduct: 'Cooking Oil',
      cleanedName: 'Cooking Oil',
      purchasedQty: 33,
      remainingQty: 28,
      consumedQty: 5,
      status: 'available',
      unitPrice: 155,
      paid: 33 * 155,
      mrp: 33 * 170,
      unit: 'pcs',
      sub_qty: 1,
      sub_unit: 'L',
      purchasedDate: '2026-08-15',
      source: 'DMart',
      variant: '1L*33'
    };

    const all35Batches = [...historicalBatches, lendBatch, activeBatch];
    assert.equal(all35Batches.length, 35, 'Total 35 batches');

    const totalPurchased = all35Batches.reduce((sum, b) => sum + b.purchasedQty, 0);
    const totalRemaining = all35Batches.reduce((sum, b) => sum + b.remainingQty, 0);
    assert.equal(totalPurchased, 580, 'Total purchased across 35 batches is 580 packs');
    assert.equal(totalRemaining, 28, 'Total remaining across 35 batches is 28 packs');

    // Dynamic transactions: 1 lending + 2 dynamic consumptions
    const txns = [
      {
        id: 'txn-lend-1',
        Date: '2026-07-12',
        Time: '10:00',
        tags: '#stock #lent #stock_ref_batch_oil_lend:1',
        Description: 'Lent 1 pc of Cooking Oil to Suresh (Batch: batch_oil_lend)',
        Note: 'to Suresh',
        INR: 150
      },
      {
        id: 'txn-dyn-c1',
        Date: '2026-09-02',
        Time: '14:00',
        tags: '#stock_ref_batch_oil_active:1',
        Description: 'Used 1 pc of Cooking Oil (Batch: batch_oil_active)',
        INR: 155
      },
      {
        id: 'txn-dyn-c2',
        Date: '2026-09-12',
        Time: '18:00',
        tags: '#stock_ref_batch_oil_active:4',
        Description: 'Used 4 pcs of Cooking Oil (Batch: batch_oil_active)',
        INR: 620
      }
    ];

    // Extract product stock activity
    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions: txns,
      batches: all35Batches
    });

    // 1. Authoritative Summary Reconciles with Stock Inventory
    assert.equal(result.summary.totalPurchasedQty, 580, 'Purchased quantity reconciles to 580 packs');
    assert.equal(result.summary.totalConsumedQty, 551, 'Consumed quantity is 551 packs');
    assert.equal(result.summary.totalLentQty, 1, 'Lent quantity is 1 pack');
    assert.equal(result.summary.outstandingLentQty, 1, 'Outstanding lent is 1 pack');
    assert.equal(result.summary.currentRemainingQty, 28, 'Available now reconciles to 28 packs (NOT 573!)');
    assert.equal(result.summary.totalBatches, 35, 'Recognizes all 35 historical batches');

    // 2. Physical Volume distinguishes packs from litres
    assert.equal(result.summary.hasPhysicalData, true, 'Physical quantity detected');
    assert.ok(result.summary.purchasedDisplay.includes('580 packs'), 'Purchased packs displayed');
    assert.ok(result.summary.purchasedDisplay.includes('580 L'), 'Purchased physical volume displayed');
    assert.ok(result.summary.remainingDisplay.includes('28 packs'), 'Remaining packs displayed');
    assert.ok(result.summary.remainingDisplay.includes('28 L'), 'Remaining physical volume displayed');

    // 3. Chronological timeline and running balance
    // The timeline is displayed newest-first, so the top item (activities[0]) reflects the final balance
    const newestItem = result.activities[0];
    assert.equal(newestItem.runningBalance, 28, 'Final running balance terminates at exactly 28 packs');
    assert.equal(newestItem.balanceStr, '28 packs (28 L)', 'Balance string formatted correctly');


    // All 33 historical batches have verified consumption records in the timeline
    const baselineConsumptions = result.activities.filter(a => a.isHistoricalBaseline);
    assert.equal(baselineConsumptions.length, 33, 'All 33 historical finished batches have audited baseline records');

    // Dynamic consumptions and lending are also present
    const dynamicConsumptions = result.activities.filter(a => a.type === 'consume' && !a.isHistoricalBaseline);
    assert.equal(dynamicConsumptions.length, 2, '2 dynamic consumption transactions present in timeline');
    const lendActivities = result.activities.filter(a => a.type === 'lend');
    assert.equal(lendActivities.length, 1, '1 lending activity present in timeline');

    // 4. Batch-level filtering isolation
    const activeBatchResult = extractProductStockActivity({
      productName: 'Cooking Oil',
      selectedBatchId: 'batch_oil_active',
      transactions: txns,
      batches: all35Batches
    });
    assert.equal(activeBatchResult.summary.totalPurchasedQty, 33, 'Active batch purchased 33');
    assert.equal(activeBatchResult.summary.totalConsumedQty, 5, 'Active batch consumed 5');
    assert.equal(activeBatchResult.summary.currentRemainingQty, 28, 'Active batch remaining 28');
    assert.equal(activeBatchResult.activities.length, 3, 'Active batch has exactly 3 records (1 purchase + 2 consumptions)');
    assert.equal(activeBatchResult.activities[0].runningBalance, 28, 'Active batch final balance is 28');

    // Historical batch filtering isolation
    const histBatchResult = extractProductStockActivity({
      productName: 'Cooking Oil',
      selectedBatchId: 'batch_oil_hist_1',
      transactions: txns,
      batches: all35Batches
    });
    assert.equal(histBatchResult.summary.totalPurchasedQty, 16, 'Hist batch 1 purchased 16');
    assert.equal(histBatchResult.summary.totalConsumedQty, 16, 'Hist batch 1 consumed 16');
    assert.equal(histBatchResult.summary.currentRemainingQty, 0, 'Hist batch 1 remaining 0');
    assert.equal(histBatchResult.activities[0].runningBalance, 0, 'Hist batch 1 final balance is 0');
  });

  await suite.test('17. Unit labeling distinguishes discrete container count from physical volume/mass (Tide 10kg & Cooking Oil)', async () => {
    const tideBatch = [
      {
        id: 'batch_tide_10kg',
        batchId: '2026-10-09_txn-tide_0',
        canonicalProduct: 'Tide Detergent',
        cleanedName: 'Tide Detergent',
        purchasedQty: 2,
        unitPrice: 567,
        paid: 1134,
        mrp: 742,
        unit: 'kg', // Legacy unit in DB may say kg
        sub_qty: 10,
        sub_unit: 'kg',
        purchasedDate: '2026-10-09',
        source: 'Amazon',
        txnUniqueId: 'txn-tide-p',
        variant: '10kg*2'
      }
    ];

    const transactions = [
      {
        id: 'txn-tide-c1',
        Date: '2026-10-10',
        Time: '15:00',
        Account: 'Stock',
        tags: '#stock #consumed #stock_ref_2026-10-09_txn-tide_0:1',
        Description: 'Used 1 pack of Tide Detergent (Batch: 2026-10-09_txn-tide_0)',
        INR: 567
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Tide Detergent',
      transactions,
      batches: tideBatch
    });

    assert.equal(result.summary.totalPurchasedQty, 2, '2 containers purchased');
    assert.equal(result.summary.totalConsumedQty, 1, '1 container consumed');
    assert.equal(result.summary.currentRemainingQty, 1, '1 container remaining');
    assert.equal(result.summary.purchasedDisplay, '2 packs (20 kg)', 'Purchased display distinguishes packs from physical weight');
    assert.equal(result.summary.remainingDisplay, '1 pack (10 kg)', 'Remaining display uses singular pack');

    // Chronological order: purchase then consumption
    const consumeAct = result.activities.find(a => a.type === 'consume');
    const purchaseAct = result.activities.find(a => a.type === 'purchase');

    assert.equal(purchaseAct.qtyStr, '+2 packs (20 kg)', 'Purchase delta formatted cleanly');
    assert.equal(consumeAct.qtyStr, '−1 pack (10 kg)', 'Consumption delta formatted cleanly with discrete pack');
    assert.equal(consumeAct.balanceStr, '1 pack (10 kg)', 'Running balance formatted cleanly as 1 pack (10 kg)');
  });

  await suite.test('18. Historical baseline consumption displays Historical baseline consumption: −1 pack (10 kg) without double-deduction', async () => {
    const historicalTideBatches = [
      {
        id: 'batch_tide_hist_1',
        batchId: '2025-09-28_hist_0',
        canonicalProduct: 'Tide Detergent',
        cleanedName: 'Tide Detergent',
        purchasedQty: 1,
        unitPrice: 620,
        paid: 620,
        mrp: 695,
        unit: 'kg',
        sub_qty: 10,
        sub_unit: 'kg',
        purchasedDate: '2025-09-28',
        source: 'Amazon',
        status: 'unavailable',
        remainingQty: 0,
        variant: '10kg'
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Tide Detergent',
      transactions: [],
      batches: historicalTideBatches
    });

    assert.equal(result.summary.totalPurchasedQty, 1);
    assert.equal(result.summary.totalConsumedQty, 1);
    assert.equal(result.summary.currentRemainingQty, 0);
    assert.equal(result.activities.length, 2, 'Contains 1 purchase and 1 baseline consumption');

    const baselineAct = result.activities.find(a => a.isHistoricalBaseline);
    assert.ok(baselineAct, 'Baseline activity generated');
    assert.equal(baselineAct.qtyStr, '−1 pack (10 kg) (Baseline)');
    assert.equal(baselineAct.description, 'Historical baseline consumption: −1 pack (10 kg)');
    assert.equal(baselineAct.balanceStr, '0 packs (0 kg)');
  });

  await suite.test('19. Lending settlement: financially settled loans show ₹0 owed and 0 pending without assuming physical goods were returned', async () => {
    const lentBatches = [
      {
        id: 'batch_tide_loan',
        batchId: '2026-05-10_loan_batch_0',
        canonicalProduct: 'Tide Detergent',
        cleanedName: 'Tide Detergent',
        purchasedQty: 1,
        unitPrice: 611,
        paid: 611,
        mrp: 750,
        unit: 'packs',
        sub_qty: 10,
        sub_unit: 'kg',
        purchasedDate: '2026-05-10',
        source: 'Amazon',
        remainingQty: 0,
        variant: '10kg'
      }
    ];

    const transactions = [
      {
        id: 'txn-tide-lend',
        Date: '2026-05-17',
        Time: '19:33',
        Account: 'Stock',
        ToAccount: 'Lend',
        tags: '#stock #lent #stock_ref_2026-05-10_loan_batch_0:1',
        Note: 'To choti mami',
        Description: 'Tide 10kg, 10/05, received',
        INR: 611
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Tide Detergent',
      transactions,
      batches: lentBatches
    });

    assert.equal(result.summary.totalPurchasedQty, 1, '1 pack purchased');
    assert.equal(result.summary.totalLentQty, 1, '1 pack lent (not 10 packs)');
    assert.equal(result.summary.totalReturnedQty, 0, '0 packs physically returned (powder consumed by borrower)');
    assert.equal(result.summary.outstandingLentQty, 0, '0 pending because debt was financially settled');
    assert.equal(result.summary.financialDebtOwed, 0, '₹0 owed');
    assert.equal(result.summary.financialDebtRepaid, 611, '₹611 repaid');

    const lendAct = result.activities.find(a => a.type === 'lend');
    assert.equal(lendAct.financialStatus, 'settled', 'Financial status is settled');
    assert.equal(lendAct.financialAmountOwed, 0, 'Owed is 0');
    assert.equal(lendAct.qtyStr, '−1 pack (10 kg) (Lent)', 'Lent quantity shows 1 pack of 10 kg');
    assert.ok(lendAct.stockMovementShort.includes('Settled'), 'Concise description mentions Settled');
  });

  await suite.test('20. Cooking Oil reconciliation (580 purchased, 551 consumed, 1 lent, 28 remaining) is strictly preserved', async () => {
    // Re-verify the full Cooking Oil dataset
    const batches = [];
    for (let i = 1; i <= 33; i++) {
      batches.push({
        id: `oil_b_${i}`,
        batchId: `oil_b_${i}`,
        canonicalProduct: 'Cooking Oil',
        purchasedQty: 16,
        remainingQty: 0,
        unit: 'pcs',
        sub_qty: 1,
        sub_unit: 'L',
        purchasedDate: `2024-0${(i % 9) + 1}-01`,
        status: 'unavailable'
      });
    }
    // 33 * 16 = 528
    batches.push({
      id: 'oil_b_34',
      batchId: 'oil_b_34',
      canonicalProduct: 'Cooking Oil',
      purchasedQty: 19,
      remainingQty: 0,
      unit: 'pcs',
      sub_qty: 1,
      sub_unit: 'L',
      purchasedDate: '2026-07-01',
      status: 'unavailable'
    });
    // 528 + 19 = 547
    batches.push({
      id: 'oil_b_35',
      batchId: 'oil_b_35',
      canonicalProduct: 'Cooking Oil',
      purchasedQty: 33,
      remainingQty: 28,
      unit: 'pcs',
      sub_qty: 1,
      sub_unit: 'L',
      purchasedDate: '2026-08-01',
      status: 'available'
    });
    // Total purchased = 580. Total remaining = 28. Total out = 552.

    const transactions = [
      {
        id: 'dyn-c1',
        Date: '2026-08-10',
        Account: 'Stock',
        tags: '#stock #consumed #stock_ref_oil_b_35:2',
        Description: 'Used 2 of Cooking Oil'
      },
      {
        id: 'dyn-c2',
        Date: '2026-08-15',
        Account: 'Stock',
        tags: '#stock #consumed #stock_ref_oil_b_35:2',
        Description: 'Used 2 of Cooking Oil'
      },
      {
        id: 'dyn-l1',
        Date: '2026-08-20',
        Account: 'Stock',
        ToAccount: 'Lend',
        tags: '#stock #lent #stock_ref_oil_b_35:1',
        Note: 'to Friend',
        Description: 'Lent 1 of Cooking Oil'
      }
    ];

    const result = extractProductStockActivity({
      productName: 'Cooking Oil',
      transactions,
      batches
    });

    assert.equal(result.summary.totalPurchasedQty, 580);
    assert.equal(result.summary.totalConsumedQty, 551);
    assert.equal(result.summary.totalLentQty, 1);
    assert.equal(result.summary.currentRemainingQty, 28);
    assert.equal(result.summary.purchasedDisplay, '580 packs (580 L)');
    assert.equal(result.summary.consumedDisplay, '551 packs (551 L)');
    assert.equal(result.summary.remainingDisplay, '28 packs (28 L)');
    assert.equal(result.activities[0].runningBalance, 28);
  });

});


