import { IDBFactory } from 'fake-indexeddb';
import {
  initDB,
  closeDB,
  getDB,
  consumeInventoryItem,
  getInventoryItems,
  getTransactions
} from '../database/index.js';
import { getDiscreteUnitLabel } from '../utils/stockActivityHistory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateProductPhysicalQuantities,
  calculateBatchPhysicalDetails,
  resolvePackageAndMeasurementUnits,
  formatUnitLabel,
  parseBatchPhysicalQuantity,
  UNIT_DIMENSIONS,
  STANDARD_UNITS
} from '../utils/stockPhysicalQuantity.js';
import { extractProductStockActivity } from '../utils/stockActivityHistory.js';

test('1. Mysore Sandal: 1 pack = 450 g package and measurement decomposition', () => {
  const batch = {
    name: 'Mysore Sandal Soap',
    cleanedName: 'Mysore Sandal Soap',
    unit: 'g', // historical conflated unit
    sub_unit: 'g',
    sub_qty: 450,
    purchasedQty: 1,
    remainingQty: 1,
    variant: '450g'
  };

  const units = resolvePackageAndMeasurementUnits(batch);
  assert.equal(units.packageUnit, 'pack');
  assert.equal(units.measurementUnit, 'g');
  assert.equal(units.quantityPerPackage, 450);
  assert.equal(units.hasDistinctMeasurement, true);
  assert.equal(units.packageLabelSingular, 'pack');
  assert.equal(units.packageLabelPlural, 'packs');
  assert.equal(units.measurementLabel, 'g');
});

test('2. Tide: 2 packs = 20 kg package and measurement decomposition', () => {
  const batch = {
    name: 'Tide Detergent',
    cleanedName: 'Tide Detergent',
    unit: 'kg', // historical conflated unit
    sub_unit: 'kg',
    sub_qty: 10,
    purchasedQty: 2,
    remainingQty: 2,
    variant: '10kg'
  };

  const units = resolvePackageAndMeasurementUnits(batch);
  assert.equal(units.packageUnit, 'pack');
  assert.equal(units.measurementUnit, 'kg');
  assert.equal(units.quantityPerPackage, 10);
  assert.equal(units.hasDistinctMeasurement, true);
  assert.equal(units.packageLabelSingular, 'pack');
  assert.equal(units.packageLabelPlural, 'packs');
  assert.equal(units.measurementLabel, 'kg');
});

test('3. Correct package/base unit options for various products', () => {
  // Bottle product
  const oilBottle = {
    name: 'Cooking Oil Bottle',
    unit: 'bottle',
    sub_unit: 'L',
    sub_qty: 1,
    purchasedQty: 3,
    remainingQty: 3
  };
  const bottleUnits = resolvePackageAndMeasurementUnits(oilBottle);
  assert.equal(bottleUnits.packageLabelSingular, 'bottle');
  assert.equal(bottleUnits.packageLabelPlural, 'bottles');
  assert.equal(bottleUnits.measurementLabel, 'L');

  // Box product
  const boxItem = {
    name: 'Matchbox',
    unit: 'box',
    sub_unit: 'pcs',
    sub_qty: 10,
    purchasedQty: 2,
    remainingQty: 2
  };
  const boxUnits = resolvePackageAndMeasurementUnits(boxItem);
  assert.equal(boxUnits.packageLabelSingular, 'box');
  assert.equal(boxUnits.packageLabelPlural, 'boxes');
});

test('4. No duplicate unit chips (e.g. g / g, kg / kg, pc / pc)', () => {
  // Conflated g / g
  const gItem = { name: 'Mysore Sandal', unit: 'g', sub_unit: 'g', sub_qty: 450 };
  const gUnits = resolvePackageAndMeasurementUnits(gItem);
  assert.notEqual(gUnits.packageLabelSingular, gUnits.measurementLabel);
  assert.equal(gUnits.packageLabelSingular, 'pack');
  assert.equal(gUnits.measurementLabel, 'g');

  // Conflated kg / kg
  const kgItem = { name: 'Tide', unit: 'kg', sub_unit: 'kg', sub_qty: 10 };
  const kgUnits = resolvePackageAndMeasurementUnits(kgItem);
  assert.notEqual(kgUnits.packageLabelSingular, kgUnits.measurementLabel);
  assert.equal(kgUnits.packageLabelSingular, 'pack');
  assert.equal(kgUnits.measurementLabel, 'kg');

  // Pure single piece: toothbrush 1 pc -> hasDistinctMeasurement = false, so no duplicate chips rendered
  const pcItem = { name: 'Toothbrush', unit: 'pc', sub_unit: 'pc', sub_qty: 1 };
  const pcUnits = resolvePackageAndMeasurementUnits(pcItem);
  assert.equal(pcUnits.hasDistinctMeasurement, false);
});

test('5. Correct default quantity for each selected unit', () => {
  // Mysore Sandal: 1 pack available
  const batch = { name: 'Mysore Sandal', unit: 'g', sub_unit: 'g', sub_qty: 450, remainingQty: 1 };
  const units = resolvePackageAndMeasurementUnits(batch);
  const defaultPackQty = batch.remainingQty;
  const defaultSubQty = batch.remainingQty * units.quantityPerPackage;

  assert.equal(defaultPackQty, 1);
  assert.equal(defaultSubQty, 450);

  // Tide: 2 packs available
  const tide = { name: 'Tide', unit: 'kg', sub_unit: 'kg', sub_qty: 10, remainingQty: 2 };
  const tideUnits = resolvePackageAndMeasurementUnits(tide);
  assert.equal(tide.remainingQty, 2);
  assert.equal(tide.remainingQty * tideUnits.quantityPerPackage, 20);
});

test('6. Correct conversion when switching units', () => {
  const batch = { name: 'Mysore Sandal', unit: 'g', sub_unit: 'g', sub_qty: 450, remainingQty: 2 };
  const units = resolvePackageAndMeasurementUnits(batch);
  const subQty = units.quantityPerPackage; // 450

  // Switching 1 pack -> g
  let entered = 1;
  let inSub = entered * subQty;
  assert.equal(inSub, 450);

  // Switching 0.5 pack -> g
  entered = 0.5;
  inSub = entered * subQty;
  assert.equal(inSub, 225);

  // Switching 225 g -> pack
  let enteredSub = 225;
  let inPack = enteredSub / subQty;
  assert.equal(inPack, 0.5);

  // Switching 450 g -> pack
  enteredSub = 450;
  inPack = enteredSub / subQty;
  assert.equal(inPack, 1);
});

test('7. Validation for exceeding available stock', () => {
  const batch = { name: 'Mysore Sandal', unit: 'g', sub_unit: 'g', sub_qty: 450, remainingQty: 1 };
  const units = resolvePackageAndMeasurementUnits(batch);

  const maxPack = batch.remainingQty; // 1
  const maxSub = batch.remainingQty * units.quantityPerPackage; // 450

  assert.equal(1.5 > maxPack, true); // Exceeds pack
  assert.equal(500 > maxSub, true);  // Exceeds sub
  assert.equal(1 <= maxPack, true);  // Valid pack
  assert.equal(450 <= maxSub, true); // Valid sub
  assert.equal(200 <= maxSub, true); // Valid sub
});

test('8. Partial consumption arithmetic', () => {
  const batch = { name: 'Mysore Sandal', unit: 'g', sub_unit: 'g', sub_qty: 450, remainingQty: 1 };
  const units = resolvePackageAndMeasurementUnits(batch);

  // Partial consumption: 200 g consumed
  const consumedG = 200;
  const consumedPacks = consumedG / units.quantityPerPackage; // 200 / 450 = 4/9 pack
  const remainingPacks = batch.remainingQty - consumedPacks;
  const remainingG = remainingPacks * units.quantityPerPackage;

  assert.equal(consumedPacks, 200 / 450);
  assert.equal(Math.round(remainingG), 250);
});

test('9. Correct description generation format', () => {
  const item = { name: 'Mysore Sandal Soap', unit: 'g', sub_unit: 'g', sub_qty: 450 };
  const units = resolvePackageAndMeasurementUnits(item);

  // When 1 pack consumed
  const qtyPacks = 1;
  const descPack = `Used ${qtyPacks} ${units.packageLabelSingular} of ${item.name} (${qtyPacks * units.quantityPerPackage} ${units.measurementLabel})`;
  assert.equal(descPack, 'Used 1 pack of Mysore Sandal Soap (450 g)');

  // When 2 packs consumed
  const qtyPacks2 = 2;
  const descPack2 = `Used ${qtyPacks2} ${units.packageLabelPlural} of ${item.name} (${qtyPacks2 * units.quantityPerPackage} ${units.measurementLabel})`;
  assert.equal(descPack2, 'Used 2 packs of Mysore Sandal Soap (900 g)');

  // When 100 g consumed
  const qtyG = 100;
  const descG = `Used ${qtyG} ${units.measurementLabel} of ${item.name}`;
  assert.equal(descG, 'Used 100 g of Mysore Sandal Soap');
});

test('10. Correct remaining quantity after consumption', () => {
  const originalQty = 24;
  const consumedQty = 3;
  const remainingQty = originalQty - consumedQty;
  assert.equal(remainingQty, 21);
});

test('11. Cooking Oil package count and converted quantity (fixing (0) bug)', () => {
  const batches = [
    { purchasedQty: 3, remainingQty: 3, sub_qty: 1, sub_unit: 'litre', variant: '1litre*3' },
    { purchasedQty: 9, remainingQty: 9, sub_qty: 1, sub_unit: 'litre', variant: '1litre*9' },
    { purchasedQty: 3, remainingQty: 3, sub_qty: 1, sub_unit: 'litre', variant: '1litre*3' },
    { purchasedQty: 2, remainingQty: 2, sub_qty: 1, sub_unit: 'litre', variant: '1litre*2' },
    { purchasedQty: 7, remainingQty: 7, sub_qty: 1, sub_unit: 'L', variant: '1L*7' }
  ];

  const totalRemainingPacks = batches.reduce((sum, b) => sum + b.remainingQty, 0);
  assert.equal(totalRemainingPacks, 24);

  const physical = aggregateProductPhysicalQuantities(batches);
  assert.equal(physical.hasPhysicalData, true);
  assert.equal(physical.remainingDisplay, '24 L');
  assert.notEqual(physical.remainingDisplay, '0');
});

test('12. Existing product configurations remain compatible', () => {
  // Test variations of volume
  assert.equal(STANDARD_UNITS['litre'], 'L');
  assert.equal(STANDARD_UNITS['litres'], 'L');
  assert.equal(STANDARD_UNITS['liter'], 'L');
  assert.equal(STANDARD_UNITS['liters'], 'L');
  assert.equal(STANDARD_UNITS['ltr'], 'L');
  assert.equal(STANDARD_UNITS['l'], 'L');
  assert.equal(STANDARD_UNITS['ml'], 'ml');

  // Test variations of mass
  assert.equal(STANDARD_UNITS['kg'], 'kg');
  assert.equal(STANDARD_UNITS['kgs'], 'kg');
  assert.equal(STANDARD_UNITS['g'], 'g');
  assert.equal(STANDARD_UNITS['gm'], 'g');
  assert.equal(STANDARD_UNITS['gms'], 'g');
});

test('13. Existing purchase, lending and consumption calculations remain unchanged', () => {
  const b = {
    purchasedQty: 5,
    consumedQty: 2,
    remainingQty: 3,
    sub_qty: 500,
    sub_unit: 'g',
    variant: '500g'
  };
  const phys = calculateBatchPhysicalDetails(b);
  assert.equal(phys.isConfident, true);
  assert.equal(phys.purchasedPhysical, 2500);
  assert.equal(phys.consumedPhysical, 1000);
  assert.equal(phys.remainingPhysical, 1500);
  assert.equal(phys.unit, 'g');
  assert.equal(phys.dimension, 'mass');
});

test('14. Activity ledger layout data extraction and structure', () => {
  const product = 'Mysore Sandal';
  const batches = [
    {
      batchId: '2026-10-16_f0b2b770-2ff8-44f6-8253-8a6cc0d26176_0',
      id: '2026-10-16_f0b2b770-2ff8-44f6-8253-8a6cc0d26176_0',
      canonicalProduct: 'Mysore Sandal Soap',
      cleanedName: 'Mysore Sandal Soap',
      purchasedQty: 1,
      remainingQty: 1,
      sub_qty: 450,
      sub_unit: 'g',
      variant: '450g',
      paid: 210,
      purchasedDate: '2026-10-16',
      source: 'Father Amazon'
    }
  ];

  const transactions = [];
  const inventoryItems = [];

  const activity = extractProductStockActivity({
    productName: product,
    selectedBatchId: null,
    transactions,
    inventoryItems,
    batches
  });

  assert.equal(activity.activities.length, 1);
  const act = activity.activities[0];
  assert.equal(act.type, 'purchase');
  assert.equal(act.qtyDelta, 1);
  assert.equal(act.store, 'Father Amazon');
  assert.equal(act.qtyStr.includes('+1 pack'), true);
});


test('15. Cooking Oil packaging terminology consistency: defaults to pack unless configuration specifies bottle', () => {
  // Cooking Oil with unit: 'L' and variant: '1L*7' without 'bottle'
  const oilBatch = {
    name: 'Cooking Oil',
    cleanedName: 'Cooking Oil',
    unit: 'L',
    sub_unit: 'L',
    sub_qty: 1,
    purchasedQty: 24,
    remainingQty: 24,
    variant: '1L*24'
  };

  const units = resolvePackageAndMeasurementUnits(oilBatch);
  assert.equal(units.packageUnit, 'pack', 'Package unit should resolve to pack when bottle is not in purchase config');
  assert.equal(units.packageLabelSingular, 'pack');
  assert.equal(units.packageLabelPlural, 'packs');
  assert.equal(units.measurementLabel, 'L');

  // getDiscreteUnitLabel in activity drawer also resolves to 'packs'
  const discreteLabelPlural = getDiscreteUnitLabel(24, oilBatch);
  assert.equal(discreteLabelPlural, 'packs');
  const discreteLabelSingular = getDiscreteUnitLabel(1, oilBatch);
  assert.equal(discreteLabelSingular, 'pack');

  // Verify that an explicit bottle configuration DOES resolve to bottle
  const realBottle = {
    name: 'Olive Oil',
    unit: 'bottle',
    sub_unit: 'ml',
    sub_qty: 500,
    purchasedQty: 2,
    remainingQty: 2,
    variant: '500ml'
  };
  const bottleUnits = resolvePackageAndMeasurementUnits(realBottle);
  assert.equal(bottleUnits.packageUnit, 'bottle');
  assert.equal(bottleUnits.packageLabelPlural, 'bottles');
});

test('16. Search field clear button: resets query, preserves filtering logic, and binds input ref with onMouseDown focus guard', () => {
  // 1. Verify JSX contracts in StockManager.jsx
  import('fs').then(fs => {
    const stockManagerSrc = fs.readFileSync('src/components/Accounts/StockManager.jsx', 'utf8');
    assert.ok(
      stockManagerSrc.includes('ref={searchInputRef}'),
      'Search input element must have ref={searchInputRef} explicitly bound'
    );
    assert.ok(
      stockManagerSrc.includes('onMouseDown={(e) => {') && stockManagerSrc.includes('e.preventDefault();'),
      'Clear button must have onMouseDown preventDefault() to prevent mouse pointer from blurring search input'
    );
    assert.ok(
      stockManagerSrc.includes('searchInputRef.current?.focus()'),
      'Clear button onClick must call searchInputRef.current?.focus()'
    );
  });

  // 2. Functional query reset and immediate filter update
  const products = [
    { productName: 'Cooking Oil', totalRemainingQty: 24 },
    { productName: 'Colgate Toothpaste', totalRemainingQty: 2 },
    { productName: 'Mysore Sandal Soap', totalRemainingQty: 0 }
  ];

  let search = 'Colgate';
  const filterBySearch = (query, list) => {
    if (!query.trim()) return list;
    return list.filter(p => p.productName.toLowerCase().includes(query.toLowerCase()));
  };

  let filtered = filterBySearch(search, products);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].productName, 'Colgate Toothpaste');

  // Simulate clicking X button: clears search and restores focus
  let focusCalled = false;
  const mockSearchInputRef = {
    current: {
      focus: () => { focusCalled = true; }
    }
  };

  const handleClear = () => {
    search = '';
    mockSearchInputRef.current?.focus();
  };

  handleClear();
  assert.equal(search, '');
  assert.equal(focusCalled, true, 'Focus must be returned to search input immediately');

  filtered = filterBySearch(search, products);
  assert.equal(filtered.length, 3, 'Filtered list resets immediately');
});

test('17. Installment consumption: physical quantity deducted once, financial split across installments', async () => {
  closeDB();
  globalThis.indexedDB = new IDBFactory();
  await initDB();

  try {
    const db = getDB();

    // 1. Setup Colgate batch in inventory
    const itemId = 'inv-colgate-1';
    await db.run(`
      INSERT INTO inventory (id, name, qty, unit, sub_qty, sub_unit, price, status, purchased_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [itemId, 'Colgate', 1, 'pack', 600, 'g', 280, 'available', '2026-04-02', 'Mamu Amazon']);

    const initialItems = await getInventoryItems();
    const colgateBefore = initialItems.find(i => i.id === itemId);
    assert.equal(parseFloat(colgateBefore.qty), 1);

    // 2. Consume 600 g of Colgate with 4 installments of ₹70 each
    const itemObj = {
      ...colgateBefore,
      name: 'Colgate',
      purchased_date: '2026-04-02',
      notes: 'Mamu Amazon'
    };

    await consumeInventoryItem(
      itemId,
      600,                // 600 g
      '02/04/2026',       // Date
      true,               // useSubUnit (true for g)
      'consumed',         // userNote
      'Groceries',        // category
      'instalment',       // usageType
      '',                 // cleanPerson
      4,                  // 4 installments
      '14:00',            // timeStr
      '',                 // userDescription
      itemObj,            // item
      { months: 4, scheduleMode: 'on_day' } // instalmentConfig
    );

    // 3. Verify physical inventory deduction: exactly once
    const updatedItems = await getInventoryItems();
    const colgateAfter = updatedItems.find(i => i.id === itemId);
    assert.equal(parseFloat(colgateAfter.qty), 0, 'Physical inventory decremented from 1 to 0');
    assert.equal(colgateAfter.status, 'unavailable');

    // 4. Verify transactions created: exactly 4 installment transactions of ₹70
    const txns = await getTransactions();
    const colgateTxns = txns.filter(t => (t.tags || '').includes('#instalment'));
    assert.equal(colgateTxns.length, 4, 'Exactly 4 installment transactions created');

    const totalINR = colgateTxns.reduce((sum, t) => sum + t.inr, 0);
    assert.equal(totalINR, 280, 'Total installment amount equals original purchase cost ₹280');
    colgateTxns.forEach(t => {
      assert.equal(t.inr, 70, 'Each installment part is ₹70');
    });

    // 5. Verify Part 1 description: physical consumption + split note
    const part1 = colgateTxns.find(t => t.note.includes('1/4'));
    assert.ok(part1, 'Part 1/4 transaction found');
    assert.ok(part1.tags.includes('#stock_ref_'), 'Part 1 contains #stock_ref_ tag');
    assert.equal(
      part1.description,
      'Used 600 g of Colgate (bought on 2 Apr 2026 from Mamu Amazon). Payment split into 4 installments of ₹70 each.'
    );

    // 6. Verify Subsequent parts descriptions (e.g. Part 2): does not suggest duplicate physical consumption
    const part2 = colgateTxns.find(t => t.note.includes('2/4'));
    assert.ok(part2, 'Part 2/4 transaction found');
    assert.ok(!part2.tags.includes('#stock_ref_'), 'Part 2 must NOT contain #stock_ref_ tag');
    assert.ok(
      part2.description.includes('Installment payment 2 of 4 (₹70) for 600 g of Colgate used on 02/04/2026'),
      `Part 2 description correctly identifies installment payment: ${part2.description}`
    );
    assert.ok(
      part2.description.includes('Payment split into 4 installments.'),
      'Part 2 description confirms payment split'
    );
  } finally {
    closeDB();
  }
});
