/**
 * stock_source_regression.test.js
 * Regression tests covering:
 * - Create purchase -> save -> reload -> display Source
 * - Edit -> save -> display Source
 * - Preserve source values during edits, reloads, and sync
 * - Do not overwrite a valid source with an empty value
 * - Physical quantity single unit recovery from rawNameStr
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDB,
  closeDB,
  addInventoryPurchase,
  updateInventoryItem,
  getInventoryItems,
  getTransactions,
  syncStockFromPastTransactions
} from '../database/index.js';
import {
  extractNormalizedBatchesFromTransactions,
  parseStockLine
} from '../utils/stockInventoryNormalization.js';
import {
  parseBatchPhysicalQuantity,
  aggregateProductPhysicalQuantities
} from '../utils/stockPhysicalQuantity.js';

test('FinMan Stock Inventory — Purchase Source & Available Quantity Regression Suite', async (suite) => {
  suite.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    await initDB();
  });

  suite.afterEach(() => {
    closeDB();
  });

  // 1. Create purchase -> save -> reload -> verify Source persisted in inventory & transaction
  await suite.test('1. Create purchase with store name preserves source in inventory row and transaction', async () => {
    await addInventoryPurchase({
      fromAccount: 'HDFC',
      date: '2026-10-20',
      time: '14:30',
      note: 'in stock',
      items: [
        {
          name: 'Cooking Oil',
          price: 1549,
          discounted_price: 1387,
          original_qty: 1,
          qty: 1,
          pack_qty: 1,
          sub_qty: 9,
          sub_unit: 'L',
          notes: 'Amzad Amazon'
        }
      ]
    });

    // Reload from database
    const invItems = await getInventoryItems();
    assert.equal(invItems.length, 1, 'One inventory row saved');
    assert.equal(invItems[0].notes, 'Amzad Amazon', 'Store name saved in inventory notes field');

    const txns = await getTransactions();
    assert.equal(txns.length, 1, 'One transaction saved');
    assert.match(txns[0].Description || txns[0].description, /Amzad Amazon/, 'Transaction description contains store header');
    assert.equal(txns[0].Note || txns[0].note, 'Amzad Amazon', 'Transaction note contains store name');

    // Extract normalized batches from transactions
    const batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches.length, 1, 'One batch extracted');
    assert.equal(batches[0].source, 'Amzad Amazon', 'Batch source correctly extracted as Amzad Amazon');
  });

  // 2. Edit batch -> save -> reload -> verify Source is updated and preserved
  await suite.test('2. Edit batch details preserves and updates source', async () => {
    await addInventoryPurchase({
      fromAccount: 'HDFC',
      date: '2026-10-21',
      items: [
        {
          name: 'Fortune Sunflower Oil',
          price: 900,
          discounted_price: 850,
          original_qty: 1,
          qty: 1,
          pack_qty: 1,
          sub_qty: 5,
          sub_unit: 'L',
          notes: 'DMart'
        }
      ]
    });

    let invItems = await getInventoryItems();
    assert.equal(invItems[0].notes, 'DMart');

    // Edit the batch source to "Flipkart Supermarket"
    await updateInventoryItem(invItems[0].id, {
      ...invItems[0],
      notes: 'Flipkart Supermarket'
    });

    // Reload from DB
    invItems = await getInventoryItems();
    assert.equal(invItems[0].notes, 'Flipkart Supermarket', 'Updated source persisted on reload');
  });

  // 3. syncStockFromPastTransactions does NOT overwrite valid source with empty value
  await suite.test('3. syncStockFromPastTransactions preserves existing valid source notes', async () => {
    await addInventoryPurchase({
      fromAccount: 'Canara',
      date: '2026-10-22',
      items: [
        {
          name: 'Gemini Cooking Oil',
          price: 750,
          discounted_price: 680,
          original_qty: 1,
          qty: 1,
          pack_qty: 1,
          sub_qty: 5,
          sub_unit: 'L',
          notes: 'Amzad Amazon'
        }
      ]
    });

    let invBefore = await getInventoryItems();
    assert.equal(invBefore[0].notes, 'Amzad Amazon');

    // Run stock sync from past transactions
    await syncStockFromPastTransactions();

    const invAfter = await getInventoryItems();
    assert.equal(invAfter.length, 1, 'Inventory row exists after sync');
    assert.equal(invAfter[0].notes, 'Amzad Amazon', 'Valid source was NOT overwritten with empty value');
  });

  // 4. Fallback storeName extraction from transaction Note if description lacks header
  await suite.test('4. parseStockLine extracts store from txn Note when description header lacks store name', async () => {
    const rawLine = 'Cooking Oil stock available 5L: 750: @680';
    const txn = {
      id: 'txn-note-fallback',
      Note: 'Amzad Amazon',
      Description: 'Cooking Oil stock available 5L: 750: @680',
      Date: '2026-10-23'
    };

    const parsed = parseStockLine(rawLine, txn, 0);
    assert.ok(parsed, 'Stock line parsed');
    assert.equal(parsed.source, 'Amzad Amazon', 'Source extracted from txn.Note when header starts with stock');
  });

  // 5. Single unit physical quantity recovery from rawNameStr for Standard variant
  await suite.test('5. Single unit recovery in parseBatchPhysicalQuantity for Standard variant', async () => {
    const meta = parseBatchPhysicalQuantity('Standard', 'Cooking Oil 1L', 1);
    assert.equal(meta.confidence, 'recoverable');
    assert.equal(meta.physicalUnit, 'L');
    assert.equal(meta.packSizeValue, 1);
    assert.equal(meta.totalPhysicalQty, 1);

    const meta5L = parseBatchPhysicalQuantity('Standard', 'Fortune Cooking Oil 5L', 2);
    assert.equal(meta5L.confidence, 'recoverable');
    assert.equal(meta5L.physicalUnit, 'L');
    assert.equal(meta5L.unitPhysicalQty, 5);
    assert.equal(meta5L.totalPhysicalQty, 10);
  });

  // 6. Aggregate physical quantity keeps discrete packs and physical volume distinct
  await suite.test('6. Aggregate physical quantity produces accurate volumes alongside discrete pack counts', async () => {
    const batches = [
      {
        variant: '1L',
        rawName: 'Cooking Oil 1L',
        purchasedQty: 20,
        consumedQty: 18,
        remainingQty: 2
      },
      {
        variant: '2L',
        rawName: 'Cooking Oil 2L',
        purchasedQty: 5,
        consumedQty: 4,
        remainingQty: 1
      }
    ];

    const agg = aggregateProductPhysicalQuantities(batches);
    assert.ok(agg.hasPhysicalData);
    assert.equal(agg.purchasedDisplay, '30 L'); // (20*1) + (5*2) = 30L
    assert.equal(agg.consumedDisplay, '26 L');  // (18*1) + (4*2) = 26L
    assert.equal(agg.remainingDisplay, '4 L');   // (2*1) + (1*2) = 4L
  });
});
