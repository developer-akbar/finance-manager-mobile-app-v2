import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNormalizedBatchesFromTransactions,
  isProductConcordant,
  extractExpectedProductName,
  getCanonicalProductName,
  cleanRawItemName
} from '../utils/stockInventoryNormalization.js';

test('FinMan Stock Inventory — Cross-Product Reference Validation Suite (Phase 9)', async (suite) => {

  // 1. Canonical cross-product reference is rejected and does not deduct the wrong batch
  await suite.test('1. Canonical cross-product reference is rejected and does not deduct the wrong batch', () => {
    const purchaseTxn = {
      id: 'txn-pb-purchase',
      date: '04/07/2026',
      description: 'Amazon\n\nCinthol stock available 600g: 158: @132\nOats stock available 1kg*2: 280: @237\nPintola Peanut butter stock available 1kg: 358: @299'
    };
    // Line 4 in purchaseTxn is Pintola Peanut butter
    const crossProductTxn = {
      id: 'txn-cinthol-loan-cross',
      date: '30/09/2026',
      description: 'Lent 1 g of Cinthol (1 g (bought on 4 Jul 2026 from Amazon))',
      tags: '#stock #lent #stock_ref_2026-07-04_txn-pb-purchase_4:1'
    };

    const diag = { unresolvedRefs: [] };
    const batches = extractNormalizedBatchesFromTransactions([purchaseTxn, crossProductTxn], diag);
    const pbBatch = batches.find(b => b.canonicalProduct === 'Pintola Peanut Butter');

    assert.ok(pbBatch, 'Pintola Peanut Butter batch must exist');
    assert.equal(pbBatch.purchasedQty, 1, 'Purchased quantity is 1');
    assert.equal(pbBatch.consumedQty, 0, 'Deduction rejected: consumed quantity must be 0');
    assert.equal(pbBatch.remainingQty, 1, 'Remaining quantity is preserved at 1');
    assert.equal(pbBatch.status, 'available', 'Status remains available');
    assert.equal(pbBatch.dynamicDeductions.length, 0, 'Zero deductions applied to batch');

    assert.equal(diag.unresolvedRefs.length, 1, 'One diagnostic must be recorded');
    assert.equal(diag.unresolvedRefs[0].reason, 'CANONICAL_REF_PRODUCT_NAME_MISMATCH');
    assert.equal(diag.unresolvedRefs[0].expectedProduct, 'Cinthol');
    assert.equal(diag.unresolvedRefs[0].referencedProduct, 'Pintola Peanut Butter');
    assert.equal(diag.unresolvedRefs[0].candidateBatchId, '2026-07-04_txn-pb-purchase_4');
  });

  // 2. Legacy UUID mapping to the correct product still works cleanly
  await suite.test('2. Legacy UUID mapping to the correct product still works cleanly', () => {
    const purchaseTxn = {
      id: '98e275ea-49da-4234-ab95-ccc78912f85b',
      date: '28/04/2026',
      description: 'Mami Amazon\n\nSantoor Red stock available 125g*8: 264: @229, 5\nCinthol stock available 600g*2: 302: @264'
    };
    const legacySantoorTxn = {
      id: 'txn-legacy-santoor',
      date: '03/09/2026',
      description: 'Used 1 pcs of Santoor Red (1 pcs (bought on 28 Apr 2026 from Mami Amazon))',
      tags: '#stock #consumed #stock_ref_9ba4ff10-0847-40dd-9398-d5903ba598ec:1'
    };

    const diag = { unresolvedRefs: [] };
    const batches = extractNormalizedBatchesFromTransactions([purchaseTxn, legacySantoorTxn], diag);
    const santoorBatch = batches.find(b => b.canonicalProduct === 'Santoor Soap');

    assert.ok(santoorBatch, 'Santoor batch must exist');
    assert.equal(santoorBatch.dynamicDeductions.length, 1, 'Legacy UUID resolved and added dynamic deduction');
    assert.equal(santoorBatch.dynamicDeductions[0].qty, 1, 'Deduction quantity is 1');
    assert.equal(santoorBatch.remainingQty, 4, 'Remaining baseline decremented from 5 to 4');
    assert.equal(diag.unresolvedRefs.length, 0, 'No unresolved diagnostics for valid legacy mapping');
  });

  // 3. Known aliases, abbreviations and brand variations remain accepted
  await suite.test('3. Known aliases, abbreviations and brand variations remain accepted', () => {
    const testCases = [
      { expected: 'Oil', batchProduct: 'Cooking Oil', rawName: 'Fortune oil 5L', shouldMatch: true },
      { expected: 'Cooking Oil', batchProduct: 'Cooking Oil', rawName: 'Oil 5L', shouldMatch: true },
      { expected: 'Fortune oil', batchProduct: 'Cooking Oil', rawName: 'Oil stock available 5L', shouldMatch: true },
      { expected: 'Presto Floor Cleaner', batchProduct: 'Presto Floor Cleaner', rawName: 'Presto', shouldMatch: true },
      { expected: 'Presto', batchProduct: 'Presto Floor Cleaner', rawName: 'Presto Floor Cleaner 1L', shouldMatch: true },
      { expected: 'Pestro Gel', batchProduct: 'Presto Dishwash Gel', rawName: 'Presto Gel 1L', shouldMatch: true },
      { expected: 'Presto Gel', batchProduct: 'Presto Dishwash Gel', rawName: 'Pestro Gel 1L', shouldMatch: true },
      { expected: 'Dabur amla', batchProduct: 'Dabur Amla Hair Oil', rawName: 'Dabur Amla 550ml', shouldMatch: true },
      { expected: 'Santoor Red', batchProduct: 'Santoor Soap', rawName: 'Santoor Red 125g*8', shouldMatch: true },
      { expected: 'Tide', batchProduct: 'Tide Detergent', rawName: 'Tide 10kg', shouldMatch: true },
      { expected: 'Cinthol', batchProduct: 'Cinthol Soap', rawName: 'Cinthol 600g', shouldMatch: true },
      // Distinct products must mismatch:
      { expected: 'Cinthol', batchProduct: 'Pintola Peanut Butter', rawName: 'Pintola Peanut butter 1kg', shouldMatch: false },
      { expected: 'Detergent Powder', batchProduct: 'Cooking Oil', rawName: 'Fortune oil 5L', shouldMatch: false },
      { expected: 'Dove Soap', batchProduct: 'Cooking Oil', rawName: 'Oil 5L', shouldMatch: false }
    ];

    testCases.forEach(({ expected, batchProduct, rawName, shouldMatch }) => {
      const mockBatch = {
        cleanedName: cleanRawItemName(rawName),
        rawName,
        canonicalProduct: batchProduct
      };
      const result = isProductConcordant(expected, mockBatch);
      assert.equal(
        result,
        shouldMatch,
        `Expected "${expected}" vs Batch "${batchProduct}" ("${rawName}") should evaluate to ${shouldMatch}`
      );
    });
  });

  // 4. Valid unit conversions remain unchanged
  await suite.test('4. Valid unit conversions remain unchanged', () => {
    const purchaseTxn = {
      id: 'txn-oil-purchase-conv',
      date: '07/08/2026',
      description: 'Amazon Fresh\n\n\n\nOil stock available 1L*9: 1549: @1387'
    };
    const validConvTxn = {
      id: 'txn-oil-conv',
      date: '01/09/2026',
      description: 'Used 4 pcs of Oil (4 pcs (bought on 7 Aug 2026 from Amazon Fresh))',
      tags: '#stock #consumed #stock_ref_2026-08-07_txn-oil-purchase-conv_4:7' // Tag suffix :7, description says 4 pcs
    };

    const diag = { unresolvedRefs: [] };
    const batches = extractNormalizedBatchesFromTransactions([purchaseTxn, validConvTxn], diag);
    const oil = batches.find(b => b.canonicalProduct === 'Cooking Oil');

    assert.equal(oil.consumedQty, 4, 'Unit conversion overrides tag quantity from 7 to 4 L');
    assert.equal(oil.remainingQty, 5, 'Remaining is 9 - 4 = 5 L');
    assert.equal(diag.unresolvedRefs.length, 0, 'No unresolved diagnostics for valid conversion');
  });

  // 5. Multi-reference / FIFO split deductions remain correct
  await suite.test('5. Multi-reference / FIFO split deductions remain correct', () => {
    const batchA = {
      id: 'txn-fifo-a',
      date: '01/08/2026',
      description: 'Dove Soap stock available 100g*2: 100: @80'
    };
    const batchB = {
      id: 'txn-fifo-b',
      date: '05/08/2026',
      description: 'Dove Soap stock available 100g*2: 100: @80'
    };
    const fifoTxn = {
      id: 'txn-fifo-consume',
      date: '10/08/2026',
      description: 'Used 3 pcs of Dove Soap (1 pc from batch A, 2 pcs from batch B)',
      tags: '#stock #consumed #stock_ref_2026-08-01_txn-fifo-a_0:1 #stock_ref_2026-08-05_txn-fifo-b_0:2'
    };

    const batches = extractNormalizedBatchesFromTransactions([batchA, batchB, fifoTxn]);
    const bA = batches.find(b => b.batchId.includes('txn-fifo-a'));
    const bB = batches.find(b => b.batchId.includes('txn-fifo-b'));

    assert.equal(bA.consumedQty, 1, 'Batch A consumed quantity is 1');
    assert.equal(bA.remainingQty, 1, 'Batch A remaining quantity is 1');
    assert.equal(bB.consumedQty, 2, 'Batch B consumed quantity is 2');
    assert.equal(bB.remainingQty, 0, 'Batch B remaining quantity is 0');
  });

  // 6. Cinthol regression: afd13723... does not corrupt Peanut Butter batch
  await suite.test('6. Cinthol regression: afd13723... does not corrupt Peanut Butter batch', () => {
    const purchaseTxn = {
      Date: '04/07/2026',
      ID: '37817ebc-60a3-4f8e-90ab-08f7a0455b75',
      Description: 'Amazon\n\nCinthol stock available 600g: 158: @132\nOats stock available 1kg*2: 280: @237\nPintola Peanut butter stock available 1kg: 358: @299'
    };
    const cintholLoan30Sep = {
      Date: '30/09/2026',
      ID: 'afd13723-b454-48a6-9ecf-9a184fc7cdc0',
      Description: 'Lent 1 g of Cinthol (1 g (bought on 4 Jul 2026 from Amazon))',
      Tags: '#stock #lent #stock_ref_2026-07-04_37817ebc-60a3-4f8e-90ab-08f7a0455b75_4:1',
      Note: 'To choti mami',
      Amount: '132'
    };

    const diag = { unresolvedRefs: [] };
    const batches = extractNormalizedBatchesFromTransactions([purchaseTxn, cintholLoan30Sep], diag);

    const pbBatch = batches.find(b => b.batchId === '2026-07-04_37817ebc-60a3-4f8e-90ab-08f7a0455b75_4');
    assert.ok(pbBatch, 'Peanut Butter batch exists');
    assert.equal(pbBatch.remainingQty, 1, 'Peanut butter stock is preserved at 1 pack');
    assert.equal(pbBatch.consumedQty, 0, 'Zero packs deducted from Peanut butter');
    assert.equal(pbBatch.status, 'available', 'Peanut butter status is available');
    assert.equal(pbBatch.dynamicDeductions.length, 0, 'No deductions allocated to Peanut Butter batch');

    const cintholBatch = batches.find(b => b.batchId === '2026-07-04_37817ebc-60a3-4f8e-90ab-08f7a0455b75_2');
    assert.ok(cintholBatch, 'Cinthol batch exists');
    assert.equal(cintholBatch.remainingQty, 1, 'Cinthol batch is not guessed; remains untouched at 1 pack');
    assert.equal(cintholBatch.consumedQty, 0, 'Zero packs deducted from Cinthol batch');
    assert.equal(cintholBatch.dynamicDeductions.length, 0, 'No deductions allocated to Cinthol batch');

    assert.equal(diag.unresolvedRefs.length, 1, 'Diagnostic recorded for the mismatch');
    assert.equal(diag.unresolvedRefs[0].reason, 'CANONICAL_REF_PRODUCT_NAME_MISMATCH');
    assert.equal(diag.unresolvedRefs[0].txnId, 'afd13723-b454-48a6-9ecf-9a184fc7cdc0');
    assert.equal(diag.unresolvedRefs[0].expectedProduct, 'Cinthol');
    assert.equal(diag.unresolvedRefs[0].referencedProduct, 'Pintola Peanut Butter');
    assert.equal(diag.unresolvedRefs[0].candidateBatchId, '2026-07-04_37817ebc-60a3-4f8e-90ab-08f7a0455b75_4');
  });

  // 7. Unparseable / uncertain product names do not destructively deduct inventory
  await suite.test('7. Unparseable / uncertain product names do not destructively deduct inventory', () => {
    const purchaseTxn = {
      id: 'txn-soap-purchase',
      date: '01/08/2026',
      description: 'Dove Soap stock available 100g*2: 100: @80'
    };
    const unparseableTxn = {
      id: 'txn-unparseable',
      date: '10/08/2026',
      description: 'Used some items for household cleaning', // No extractable product name
      tags: '#stock #consumed #stock_ref_2026-08-01_txn-soap-purchase_0:1'
    };

    const diag = { unresolvedRefs: [] };
    const batches = extractNormalizedBatchesFromTransactions([purchaseTxn, unparseableTxn], diag);
    const soap = batches.find(b => b.batchId.includes('txn-soap-purchase'));

    assert.equal(soap.consumedQty, 0, 'Unparseable consumption product cannot deduct inventory');
    assert.equal(soap.remainingQty, 2, 'Soap inventory remains untouched at 2');
    assert.equal(diag.unresolvedRefs.length, 1, 'Diagnostic recorded for unparseable product');
    assert.equal(diag.unresolvedRefs[0].reason, 'CANONICAL_REF_PRODUCT_NAME_MISMATCH');
  });

  // 8. Stock Manager diagnostic collection, visible warning data, and stable deduplication
  await suite.test('8. Stock Manager diagnostic collection, visible warning data, and stable deduplication', () => {
    const purchaseA = {
      id: '37817ebc-60a3-4f8e-90ab-08f7a0455b75',
      date: '04/07/2026',
      description: 'Amazon\n\nCinthol stock available 600g: 158: @132\nOats stock available 1kg*2: 280: @237\nPintola Peanut butter stock available 1kg: 358: @299'
    };
    // 30 September Cinthol loan pointing to Peanut butter batch _4
    const loan30Sep = {
      id: 'afd13723-b454-48a6-9ecf-9a184fc7cdc0',
      date: '30/09/2026',
      description: 'Lent 1 g of Cinthol (1 g (bought on 4 Jul 2026 from Amazon))',
      tags: '#stock #lent #stock_ref_2026-07-04_37817ebc-60a3-4f8e-90ab-08f7a0455b75_4:1',
      note: 'To choti mami'
    };
    // Duplicate entry simulation (e.g. if re-processed or referenced multiple times)
    const duplicateLoan30Sep = { ...loan30Sep };

    // Another distinct mismatch
    const secondMismatch = {
      id: '0bb7ef43-875e-489b-83e3-0433417d29f2',
      date: '02/09/2026',
      description: 'Lent 1 pcs of Cinthol (1 pcs (bought on 4 Jul 2026 from Amazon))',
      tags: '#stock #lent #stock_ref_2026-07-04_37817ebc-60a3-4f8e-90ab-08f7a0455b75_4:1',
      note: 'To nani'
    };

    const diag = { unresolvedRefs: [] };
    const batches = extractNormalizedBatchesFromTransactions([purchaseA, loan30Sep, duplicateLoan30Sep, secondMismatch], diag);

    // Verify deduplication logic matching StockManager.jsx
    const seen = new Set();
    const deduplicated = [];
    (diag.unresolvedRefs || []).forEach(d => {
      if (d.reason === 'CANONICAL_REF_PRODUCT_NAME_MISMATCH') {
        const key = `${d.txnId || ''}_${d.refId || ''}_${d.reason}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduplicated.push(d);
        }
      }
    });

    // 1. Exactly 2 distinct rejected transactions should be collected (duplicateLoan30Sep deduplicated)
    assert.equal(deduplicated.length, 2, 'Deduplicated warning count must be exactly 2');

    // 2. Data payload must include all visible fields: txnId, date, expectedProduct, referencedProduct, reason, candidateBatchId
    const item1 = deduplicated.find(d => d.txnId === 'afd13723-b454-48a6-9ecf-9a184fc7cdc0');
    assert.ok(item1, '30 September Cinthol loan exists in visible warning data');
    assert.equal(item1.expectedProduct, 'Cinthol');
    assert.equal(item1.referencedProduct, 'Pintola Peanut Butter');
    assert.equal(item1.reason, 'CANONICAL_REF_PRODUCT_NAME_MISMATCH');
    assert.equal(item1.candidateBatchId, '2026-07-04_37817ebc-60a3-4f8e-90ab-08f7a0455b75_4');

    const item2 = deduplicated.find(d => d.txnId === '0bb7ef43-875e-489b-83e3-0433417d29f2');
    assert.ok(item2, '2 September loan exists in visible warning data');
    assert.equal(item2.expectedProduct, 'Cinthol');
    assert.equal(item2.referencedProduct, 'Pintola Peanut Butter');

    // 3. Confirm target Peanut Butter batch was NOT deducted despite multiple referencing transactions
    const pbBatch = batches.find(b => b.batchId === '2026-07-04_37817ebc-60a3-4f8e-90ab-08f7a0455b75_4');
    assert.equal(pbBatch.consumedQty, 0, 'Zero deductions applied to Peanut Butter batch');
    assert.equal(pbBatch.remainingQty, 1, 'Peanut Butter remaining quantity is preserved at 1');
  });

  // 9. StockManager UI source wiring: diagnostics collection, banner rendering, toggle, and responsive wrapping
  await suite.test('9. StockManager UI source wiring: diagnostics collection, banner rendering, toggle, and responsive wrapping', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const stockManagerPath = path.resolve(__dirname, '../components/Accounts/StockManager.jsx');
    const stockManagerCssPath = path.resolve(__dirname, '../components/Accounts/StockManager.css');

    const jsxSource = fs.readFileSync(stockManagerPath, 'utf8');
    const cssSource = fs.readFileSync(stockManagerCssPath, 'utf8');

    // 1. Verify diagnostic collector passed to extractNormalizedBatchesFromTransactions
    assert.ok(
      jsxSource.includes('const diag = { unresolvedRefs: [] }') &&
      jsxSource.includes('extractNormalizedBatchesFromTransactions(transactions || [], diag)'),
      'StockManager must pass diagnosticContext to extractNormalizedBatchesFromTransactions'
    );

    // 2. Verify state and deduplication
    assert.ok(
      jsxSource.includes('showRejectedRefsDetails') &&
      jsxSource.includes('setShowRejectedRefsDetails'),
      'StockManager must manage showRejectedRefsDetails toggle state'
    );
    assert.ok(
      jsxSource.includes("d.reason === 'CANONICAL_REF_PRODUCT_NAME_MISMATCH'") &&
      jsxSource.includes('seen.add(key)'),
      'StockManager must deduplicate rejected references using stable key'
    );

    // 3. Verify UI banner elements and accessibility
    assert.ok(
      jsxSource.includes('className="stock-ref-warning-banner"'),
      'StockManager must render stock-ref-warning-banner'
    );
    assert.ok(
      jsxSource.includes('className="stock-ref-warning-toggle"') &&
      jsxSource.includes('aria-expanded={showRejectedRefsDetails}'),
      'StockManager must render toggle button with aria-expanded attribute'
    );
    assert.ok(
      jsxSource.includes('className="stock-ref-warning-details"'),
      'StockManager must render stock-ref-warning-details container'
    );

    // 4. Verify CSS classes exist and support wrapping for long UUIDs
    assert.ok(cssSource.includes('.stock-ref-warning-banner'), 'CSS must define .stock-ref-warning-banner');
    assert.ok(cssSource.includes('.stock-ref-warning-details'), 'CSS must define .stock-ref-warning-details');
    assert.ok(cssSource.includes('.stock-ref-warning-mono'), 'CSS must define .stock-ref-warning-mono');
    assert.ok(cssSource.includes('flex-wrap: wrap'), 'CSS must wrap item rows to prevent layout breakage on long IDs');
  });

});


