/**
 * stock_lending_flow.test.js — Regression test suite for Stock Inventory lending, transfers,
 * returns, and account reconciliation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDB,
  closeDB,
  getDB,
  addTransaction,
  deleteTransaction,
  getTransactions,
  addInventoryPurchase,
  consumeInventoryItem,
  restoreInventoryItem,
  getInventoryItems
} from '../database/index.js';
import {
  extractNormalizedBatchesFromTransactions
} from '../utils/stockInventoryNormalization.js';
import { extractPersonName } from '../utils/format.js';

// Standard FinMan balance calculator (identical to buildBalanceMap in Accounts.jsx)
function calculateBalances(transactions) {
  const map = { Stock: 0, Lend: 0 };
  for (const t of transactions) {
    const amt = parseFloat(t.INR || t.inr || t.Amount || t.amount || 0);
    const type = String(t['Income/Expense'] || t.type || '').trim();
    const fromAcct = String(t.FromAccount || t.from_account || t.Account || t.account || '').trim();
    const toAcct = String(t.ToAccount || t.to_account || '').trim();

    if (type === 'Income') {
      const dest = toAcct || fromAcct;
      if (dest) map[dest] = (map[dest] || 0) + amt;
    } else if (type === 'Expense') {
      if (fromAcct) map[fromAcct] = (map[fromAcct] || 0) - amt;
    } else if (type === 'Transfer-Out' || type === 'Transfer') {
      if (fromAcct) map[fromAcct] = (map[fromAcct] || 0) - amt;
      if (toAcct) map[toAcct] = (map[toAcct] || 0) + amt;
    }
  }
  return map;
}

// Debt Tracker ledger calculation logic (identical to DebtTracker.jsx useMemo)
function calculateDebtLedgers(transactions) {
  const ledgerMap = {};
  for (const t of transactions) {
    const acct = String(t.Account || t.FromAccount || t.from_account || t.account || '').toLowerCase().trim();
    const toAcct = String(t.ToAccount || t.to_account || '').toLowerCase().trim();
    const cat = String(t.Category || t.category || '').toLowerCase().trim();
    const type = String(t['Income/Expense'] || t.type || 'Expense').toLowerCase().trim();
    const rawNote = String(t.Note || t.note || '');
    const amt = parseFloat(t.INR || t.inr || t.Amount || t.amount || 0);

    const isLendAccount = acct === 'lend' || toAcct === 'lend' || cat === 'lend';
    const isBorrowAccount = acct === 'borrow' || toAcct === 'borrow' || cat === 'borrow';

    if (!isLendAccount && !isBorrowAccount) continue;

    const personKey = extractPersonName(rawNote);
    if (!personKey) continue;

    if (!ledgerMap[personKey]) {
      ledgerMap[personKey] = {
        name: personKey,
        lent: 0,
        received: 0,
        borrowed: 0,
        repaid: 0,
        txnCount: 0,
        rawTxns: []
      };
    }
    const p = ledgerMap[personKey];
    p.txnCount += 1;

    if (isLendAccount) {
      const isGiving = toAcct === 'lend' || (type === 'expense' && acct === 'lend') || /^(to|lend\s*to|given\s*to)\s+/i.test(rawNote);
      if (isGiving) {
        p.lent += amt;
        p.rawTxns.push({ ...t, _role: 'lent', _amt: amt });
      } else {
        p.received += amt;
        p.rawTxns.push({ ...t, _role: 'received', _amt: amt });
      }
    }
  }

  const list = Object.values(ledgerMap).map(p => {
    const net = (p.lent - p.received) - (p.borrowed - p.repaid);
    return { ...p, netBalance: Math.round(net * 100) / 100 };
  });

  let recSum = 0;
  for (const p of list) {
    if (p.netBalance > 0.5) recSum += p.netBalance;
  }
  return { totalReceivable: Math.round(recSum * 100) / 100, personLedgers: list };
}

test('FinMan Stock Lending & Account Transfer Flow Test Suite', async (suite) => {
  suite.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    await initDB();
  });

  suite.afterEach(() => {
    closeDB();
  });

  // 1. Lending ₹100 reduces Stock by ₹100 and increases Lend by ₹100
  await suite.test('1. Lending stock posts Transfer-Out from Stock to Lend with exact amount', async () => {
    const db = getDB();

    // Purchase 2 packs of Cooking Oil @ ₹100 = ₹200 into Stock
    await addTransaction({
      id: 'txn-purchase-oil',
      date: '2026-10-01',
      time: '10:00',
      type: 'Transfer-Out',
      account: 'Bank Account',
      from_account: 'Bank Account',
      to_account: 'Stock',
      category: 'Stock',
      amount: 200,
      inr: 200,
      description: 'Cooking Oil stock available 1L*2: 240: @200'
    });

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['inv-oil-1', 'Cooking Oil', 2, 'pcs', 120, 100, 'available', '2026-10-01']
    );

    let txns = await getTransactions();
    let balances = calculateBalances(txns);
    assert.equal(balances.Stock, 200, 'Stock balance starts at ₹200');
    assert.equal(balances.Lend, 0, 'Lend balance starts at ₹0');

    let batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].remainingQty, 2);

    // Lend 1 pack (worth ₹100) to 'Amzad'
    const lendBatch = batches[0];
    const res = await consumeInventoryItem(
      'inv-oil-1',
      1,
      '2026-10-02',
      false,
      'Default',
      'Groceries',
      'lend',
      'Amzad',
      3,
      '11:00',
      'Lend to Amzad',
      lendBatch
    );

    assert.equal(res.totalAmount, 100, 'Lent value is ₹100');

    txns = await getTransactions();
    balances = calculateBalances(txns);

    // Assert account balances
    assert.equal(balances.Stock, 100, 'Stock balance decreases by ₹100 (from ₹200 to ₹100)');
    assert.equal(balances.Lend, 100, 'Lend balance increases by ₹100 (from ₹0 to ₹100)');

    // Verify transaction fields
    const lendTxn = txns.find(t => (t.tags || t.Tags || '').includes('#lent'));
    assert.ok(lendTxn, 'Lending transaction exists with #lent tag');
    assert.equal(lendTxn.type || lendTxn['Income/Expense'], 'Transfer-Out', 'Transaction type is Transfer-Out');
    assert.equal(lendTxn.from_account || lendTxn.FromAccount, 'Stock', 'from_account is Stock');
    assert.equal(lendTxn.to_account || lendTxn.ToAccount, 'Lend', 'to_account is Lend');
    assert.equal(lendTxn.category || lendTxn.Category, 'Transfer', 'Category is Transfer');
    assert.equal(lendTxn.subcategory || lendTxn.Subcategory, '', 'Subcategory is empty for transfer');
    assert.equal(lendTxn.note || lendTxn.Note, 'to Amzad', 'Note specifies recipient with canonical to prefix');
    assert.equal(parseFloat(lendTxn.amount || lendTxn.Amount), 100, 'Amount is ₹100');
  });

  // 2. Lending preserves the combined Stock + Lend value
  await suite.test('2. Lending preserves total assets across Stock and Lend without creating expense', async () => {
    const db = getDB();

    await addTransaction({
      id: 'txn-purchase-soap',
      date: '2026-10-05',
      time: '09:00',
      type: 'Transfer-Out',
      from_account: 'Cash',
      to_account: 'Stock',
      category: 'Stock',
      amount: 500,
      inr: 500,
      description: 'Cinthol Soap stock available 100g*5: 500: @500'
    });

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['inv-soap-1', 'Cinthol Soap', 5, 'pcs', 100, 100, 'available', '2026-10-05']
    );

    let txns = await getTransactions();
    let balances = calculateBalances(txns);
    const initialCombined = balances.Stock + balances.Lend;
    assert.equal(initialCombined, 500, 'Initial Stock + Lend is ₹500');

    let batches = extractNormalizedBatchesFromTransactions(txns);

    // Lend 2 units (worth ₹200) to 'Fahim'
    await consumeInventoryItem(
      'inv-soap-1',
      2,
      '2026-10-06',
      false,
      'Default',
      'Groceries',
      'lend',
      'Fahim',
      3,
      '14:00',
      'Lend to Fahim',
      batches[0]
    );

    txns = await getTransactions();
    balances = calculateBalances(txns);
    const postLendCombined = balances.Stock + balances.Lend;

    assert.equal(postLendCombined, initialCombined, 'Stock + Lend total is preserved exactly (₹500)');
    assert.equal(balances.Stock, 300, 'Stock is ₹300');
    assert.equal(balances.Lend, 200, 'Lend is ₹200');

    // Verify zero expenses were booked
    const expenseTxns = txns.filter(t => (t.type || t['Income/Expense']) === 'Expense');
    assert.equal(expenseTxns.length, 0, 'No false expense transactions were created');
  });

  // 3. Physical inventory quantity and valuation decrease correctly when stock is lent
  await suite.test('3. Physical inventory quantity and valuation decrease correctly upon lending', async () => {
    const db = getDB();

    await addTransaction({
      id: 'txn-p-tide',
      date: '2026-10-10',
      time: '12:00',
      type: 'Transfer-Out',
      from_account: 'Bank Account',
      to_account: 'Stock',
      category: 'Stock',
      amount: 400,
      inr: 400,
      description: 'Tide Detergent stock available 1kg*4: 400: @400'
    });

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['inv-tide-1', 'Tide Detergent', 4, 'pcs', 100, 100, 'available', '2026-10-10']
    );

    let txns = await getTransactions();
    let batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches[0].remainingQty, 4);

    // Lend 3 packs
    await consumeInventoryItem(
      'inv-tide-1',
      3,
      '2026-10-11',
      false,
      'Default',
      'Groceries',
      'lend',
      'Neighbor',
      3,
      '15:00',
      'Lend to Neighbor',
      batches[0]
    );

    // 1. Verify in-memory normalized batches
    txns = await getTransactions();
    batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches[0].remainingQty, 1, 'Remaining batch quantity is 1');
    assert.equal(batches[0].consumedQty, 3, 'Consumed/lent batch quantity is 3');

    // 2. Verify physical inventory table row
    const invItems = await getInventoryItems();
    const tideItem = invItems.find(i => i.id === 'inv-tide-1');
    assert.equal(parseFloat(tideItem.qty), 1, 'Physical inventory table quantity decremented to 1');
    assert.equal(tideItem.status, 'available', 'Status remains available with 1 pack left');
  });

  // 4. Returning a lent item reverses the appropriate transfer and restores inventory
  await suite.test('4. Returning a lent item reverses transfer and restores inventory without duplicates', async () => {
    const db = getDB();

    await addTransaction({
      id: 'txn-p-almonds',
      date: '2026-10-12',
      time: '10:00',
      type: 'Transfer-Out',
      from_account: 'Cash',
      to_account: 'Stock',
      category: 'Stock',
      amount: 300,
      inr: 300,
      description: 'Almonds stock available 500g*3: 300: @300'
    });

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['inv-almonds-1', 'Almonds', 3, 'pcs', 100, 100, 'available', '2026-10-12']
    );

    let txns = await getTransactions();
    let batches = extractNormalizedBatchesFromTransactions(txns);

    // Lend 1 pack (₹100) to 'Rahman'
    await consumeInventoryItem(
      'inv-almonds-1',
      1,
      '2026-10-13',
      false,
      'Default',
      'Groceries',
      'lend',
      'Rahman',
      3,
      '12:00',
      'Lend to Rahman',
      batches[0]
    );

    let balances = calculateBalances(await getTransactions());
    assert.equal(balances.Stock, 200);
    assert.equal(balances.Lend, 100);

    // Rahman returns the physical item into Stock
    // Accounting action: Transfer-Out from Lend to Stock
    await addTransaction({
      id: 'txn-return-almonds',
      date: '2026-10-15',
      time: '16:00',
      type: 'Transfer-Out',
      from_account: 'Lend',
      to_account: 'Stock',
      category: 'Transfer',
      subcategory: '',
      amount: 100,
      inr: 100,
      note: 'From Rahman',
      description: 'Return of Almonds from Rahman'
    });

    // Physical inventory action: restore 1 pack to batch
    await restoreInventoryItem('inv-almonds-1', 1, 'pcs');

    txns = await getTransactions();
    balances = calculateBalances(txns);

    assert.equal(balances.Stock, 300, 'Stock balance restored to ₹300');
    assert.equal(balances.Lend, 0, 'Lend balance cleared back to ₹0');
    assert.equal(balances.Stock + balances.Lend, 300, 'Total asset value preserved at ₹300');

    const invItems = await getInventoryItems();
    const almondsItem = invItems.find(i => i.id === 'inv-almonds-1');
    assert.equal(parseFloat(almondsItem.qty), 3, 'Inventory table quantity restored to 3 packs');
  });

  // 5. Ordinary consumption reduces Stock and records the corresponding expense correctly
  await suite.test('5. Ordinary consumption creates an Expense against Stock without affecting Lend', async () => {
    const db = getDB();

    await addTransaction({
      id: 'txn-p-honey',
      date: '2026-10-18',
      time: '08:00',
      type: 'Transfer-Out',
      from_account: 'Bank Account',
      to_account: 'Stock',
      category: 'Stock',
      amount: 250,
      inr: 250,
      description: 'Honey 1L stock available 1L*1: 250: @250'
    });

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['inv-honey-1', 'Honey 1L', 1, 'pcs', 250, 250, 'available', '2026-10-18']
    );

    let txns = await getTransactions();
    let batches = extractNormalizedBatchesFromTransactions(txns);

    // Consume 1 pack for home
    await consumeInventoryItem(
      'inv-honey-1',
      1,
      '2026-10-19',
      false,
      'Groceries',
      'Food & Dining',
      'consume',
      '',
      3,
      '09:00',
      'Breakfast honey',
      batches[0]
    );

    txns = await getTransactions();
    const balances = calculateBalances(txns);

    assert.equal(balances.Stock, 0, 'Stock balance reduced by ₹250 to ₹0');
    assert.equal(balances.Lend, 0, 'Lend balance is completely unaffected (₹0)');

    const expenseTxn = txns.find(t => (t.type || t['Income/Expense']) === 'Expense');
    assert.ok(expenseTxn, 'Expense transaction created');
    assert.equal(expenseTxn.account || expenseTxn.Account, 'Stock', 'Account is Stock');
    assert.equal(expenseTxn.from_account || expenseTxn.FromAccount, 'Stock', 'from_account is Stock');
    assert.equal(expenseTxn.to_account || expenseTxn.ToAccount, '', 'to_account is empty');
    assert.equal(expenseTxn.category || expenseTxn.Category, 'Groceries', 'Category is Groceries');
    assert.equal(expenseTxn.subcategory || expenseTxn.Subcategory, 'Food & Dining', 'Subcategory is Food & Dining');
    assert.equal(parseFloat(expenseTxn.amount || expenseTxn.Amount), 250, 'Amount is ₹250');
  });

  // 6. Repeating an operation or retrying cannot post the same accounting movement twice
  await suite.test('6. Atomic execution and zero-stock validation prevent duplicate postings', async () => {
    const db = getDB();

    await addTransaction({
      id: 'txn-p-ghee',
      date: '2026-10-20',
      time: '10:00',
      type: 'Transfer-Out',
      from_account: 'Bank Account',
      to_account: 'Stock',
      category: 'Stock',
      amount: 600,
      inr: 600,
      description: 'Pure Ghee stock available 1kg*1: 600: @600'
    });

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['inv-ghee-1', 'Pure Ghee', 1, 'pcs', 600, 600, 'available', '2026-10-20']
    );

    let txns = await getTransactions();
    let batches = extractNormalizedBatchesFromTransactions(txns);

    // Consume entire quantity
    await consumeInventoryItem(
      'inv-ghee-1',
      1,
      '2026-10-21',
      false,
      'Default',
      'Groceries',
      'lend',
      'Uncle',
      3,
      '11:00',
      'Lend to Uncle',
      batches[0]
    );

    // Attempting to consume again from the same batch throws Insufficient total stock
    batches = extractNormalizedBatchesFromTransactions(await getTransactions());
    await assert.rejects(
      async () => {
        await consumeInventoryItem(
          'inv-ghee-1',
          1,
          '2026-10-21',
          false,
          'Default',
          'Groceries',
          'lend',
          'Uncle',
          3,
          '11:00',
          'Lend to Uncle duplicate attempt',
          batches[0]
        );
      },
      /Insufficient total stock/
    );

    const finalBalances = calculateBalances(await getTransactions());
    assert.equal(finalBalances.Stock, 0, 'Stock balance remains ₹0, not double-deducted to negative');
    assert.equal(finalBalances.Lend, 600, 'Lend balance remains ₹600, not double-credited');
  });

  // 7. Installment consumption follows scheduled parts and does not double-deduct Stock
  await suite.test('7. Installment consumption creates scheduled recurring parts without double-deducting', async () => {
    const db = getDB();

    await addTransaction({
      id: 'txn-p-cleaner',
      date: '2026-10-22',
      time: '10:00',
      type: 'Transfer-Out',
      from_account: 'Cash',
      to_account: 'Stock',
      category: 'Stock',
      amount: 90,
      inr: 90,
      description: 'Floor Cleaner stock available 1L*1: 90: @90'
    });

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['inv-cleaner-1', 'Floor Cleaner', 1, 'pcs', 90, 90, 'available', '2026-10-22']
    );

    let batches = extractNormalizedBatchesFromTransactions(await getTransactions());

    // Consume across 3 installment months (30 each)
    const res = await consumeInventoryItem(
      'inv-cleaner-1',
      1,
      '2026-10-22',
      false,
      'Cleaning',
      'Household',
      'instalment',
      '',
      3,
      '10:30',
      'Floor Cleaner 3-month use',
      batches[0]
    );

    assert.equal(res.totalAmount, 90, 'Total installment cost is ₹90');

    const txns = await getTransactions();
    const instTxns = txns.filter(t => (t.tags || t.Tags || '').includes('#instalment'));
    assert.equal(instTxns.length, 3, 'Created exactly 3 installment parts');

    const sumInstAmounts = instTxns.reduce((sum, t) => sum + parseFloat(t.amount || t.Amount), 0);
    assert.equal(sumInstAmounts, 90, 'Sum of all installment parts matches ₹90');

    // Physical batch quantity is decremented to 0
    const invItems = await getInventoryItems();
    const cleanerItem = invItems.find(i => i.id === 'inv-cleaner-1');
    assert.equal(parseFloat(cleanerItem.qty), 0, 'Physical inventory decremented to 0');
  });

  // 8. Returning money moves amount from Lend to Cash/Bank without restoring physical inventory
  await suite.test('8. Monetary repayment of lent stock transfers from Lend to Cash/Bank without restoring inventory', async () => {
    const db = getDB();

    await addTransaction({
      id: 'txn-p-rice',
      date: '2026-10-23',
      time: '11:00',
      type: 'Transfer-Out',
      from_account: 'Bank Account',
      to_account: 'Stock',
      category: 'Stock',
      amount: 200,
      inr: 200,
      description: 'Basmati Rice stock available 1kg*1: 200: @200'
    });

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['inv-rice-1', 'Basmati Rice', 1, 'pcs', 200, 200, 'available', '2026-10-23']
    );

    let batches = extractNormalizedBatchesFromTransactions(await getTransactions());

    // Lend 1 pack (₹200) to 'Kareem'
    await consumeInventoryItem(
      'inv-rice-1',
      1,
      '2026-10-23',
      false,
      'Default',
      'Groceries',
      'lend',
      'Kareem',
      3,
      '12:00',
      'Lend to Kareem',
      batches[0]
    );

    let balances = calculateBalances(await getTransactions());
    assert.equal(balances.Stock, 0, 'Stock balance is 0');
    assert.equal(balances.Lend, 200, 'Lend balance is 200');

    // Kareem repays in cash (₹200)
    await addTransaction({
      id: 'txn-repay-kareem',
      date: '2026-10-24',
      time: '15:00',
      type: 'Transfer-Out',
      from_account: 'Lend',
      to_account: 'Cash',
      category: 'Transfer',
      subcategory: '',
      amount: 200,
      inr: 200,
      note: 'From Kareem',
      description: 'Cash repayment from Kareem for Basmati Rice'
    });

    const postRepayTxns = await getTransactions();
    balances = calculateBalances(postRepayTxns);

    assert.equal(balances.Lend, 0, 'Lend balance cleared back to 0');
    assert.equal(balances.Stock, 0, 'Stock balance remains 0 (money was returned, not physical stock)');
    assert.equal(balances.Cash, 200, 'Cash balance increased by 200');

    // Physical inventory remains 0 because the goods were kept by the borrower
    const invItems = await getInventoryItems();
    const riceItem = invItems.find(i => i.id === 'inv-rice-1');
    assert.equal(parseFloat(riceItem.qty), 0, 'Physical inventory remains 0');
    assert.equal(riceItem.status, 'unavailable', 'Batch remains unavailable');
  });

  // 9. Lending note canonicalization and Debt Tracker recognition
  await suite.test('9. Lending note canonicalization and Debt Tracker recognition', async () => {
    const db = getDB();

    // Setup: Purchase 1 Test Item for ₹100 funded from HDFC Savings into Stock
    await addTransaction({
      id: 'txn-purchase-test-item',
      date: '2026-10-25',
      time: '10:00',
      type: 'Transfer-Out',
      from_account: 'HDFC Savings',
      to_account: 'Stock',
      category: 'Stock',
      subcategory: 'Purchase',
      amount: 100,
      inr: 100,
      note: 'Test Store',
      description: 'Purchased 1 pcs of Test Item from Test Store\n• 1 pcs @ ₹100.00/pcs [Stock Available] #batch:test_batch_1'
    });

    const invRow = {
      id: 'inv-test-item-1',
      name: 'Test Item',
      qty: 1,
      original_qty: 1,
      unit: 'pcs',
      price: 100,
      discounted_price: 100,
      purchased_date: '2026-10-25',
      status: 'available',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await db.query(
      `INSERT INTO inventory (id, name, qty, original_qty, unit, price, discounted_price, purchased_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invRow.id, invRow.name, invRow.qty, invRow.original_qty, invRow.unit, invRow.price, invRow.discounted_price, invRow.purchased_date, invRow.status, invRow.created_at, invRow.updated_at]
    );

    let txns = await getTransactions();
    let batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].remainingQty, 1);

    // Validation 1: Missing / whitespace person name MUST be rejected
    await assert.rejects(
      async () => {
        await consumeInventoryItem(
          'inv-test-item-1',
          1,
          '2026-10-25',
          false,
          'Default',
          'Groceries',
          'lend',
          '',
          3,
          '11:00',
          '',
          batches[0]
        );
      },
      /Please enter a valid person name for lending/i,
      'Rejects lending when person name is empty'
    );

    await assert.rejects(
      async () => {
        await consumeInventoryItem(
          'inv-test-item-1',
          1,
          '2026-10-25',
          false,
          'Default',
          'Groceries',
          'lend',
          '   ',
          3,
          '11:00',
          'bare note without person',
          batches[0]
        );
      },
      /Please enter a valid person name for lending/i,
      'Rejects lending when person name is only whitespace'
    );

    // Case A: Bare person name with empty optional Note ('Test Person', '')
    await consumeInventoryItem(
      'inv-test-item-1',
      1,
      '2026-10-25',
      false,
      'Default',
      'Groceries',
      'lend',
      'Test Person',
      3,
      '11:00',
      '',
      batches[0]
    );

    txns = await getTransactions();
    let balances = calculateBalances(txns);

    // Verify balances: Stock = ₹0, Lend = ₹100, HDFC Savings = -₹100
    assert.equal(balances.Stock, 0, 'Stock balance is 0 after lending');
    assert.equal(balances.Lend, 100, 'Lend balance is 100 after lending');

    // Confirm no expense was created
    const expenses = txns.filter(t => (t.type || t['Income/Expense']) === 'Expense');
    assert.equal(expenses.length, 0, 'No expense transaction is created');

    // Verify canonical note on the generated transaction
    const lendTxn = txns.find(t => (t.tags || t.Tags || '').includes('#lent'));
    assert.ok(lendTxn, 'Lending transaction exists');
    assert.equal(lendTxn.note || lendTxn.Note, 'to Test Person', 'Note is canonically formatted as "to Test Person"');
    assert.equal(lendTxn.to_account || lendTxn.ToAccount, 'Lend');
    assert.equal(lendTxn.from_account || lendTxn.FromAccount, 'Stock');

    // Verify Debt Tracker recognizes the pending receivable
    let debt = calculateDebtLedgers(txns);
    assert.equal(debt.totalReceivable, 100, 'Debt Tracker Total to Receive is ₹100');
    assert.equal(debt.personLedgers.length, 1, 'Debt Tracker has exactly 1 person');
    assert.equal(debt.personLedgers[0].name, 'Test Person', 'Counterparty is Test Person');
    assert.equal(debt.personLedgers[0].lent, 100, 'Lent amount is 100');
    assert.equal(debt.personLedgers[0].netBalance, 100, 'Net balance is 100 pending');

    // Case B: Person name already contains recognized prefix ('to Test Person' / 'Lend to: Test Person')
    // Reset DB for isolated sub-test
    await db.query('DELETE FROM transactions');
    await db.query('DELETE FROM inventory');

    await addTransaction({
      id: 'txn-purchase-prefix-test',
      date: '2026-10-25',
      time: '10:00',
      type: 'Transfer-Out',
      from_account: 'HDFC Savings',
      to_account: 'Stock',
      category: 'Stock',
      subcategory: 'Purchase',
      amount: 100,
      inr: 100,
      note: 'Test Store',
      description: 'Purchased 1 pcs\n• 1 pcs @ ₹100.00/pcs [Stock Available] #batch:test_batch_prefix'
    });
    await db.query(
      `INSERT INTO inventory (id, name, qty, original_qty, unit, price, discounted_price, purchased_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['inv-prefix-1', 'Prefix Item', 1, 1, 'pcs', 100, 100, '2026-10-25', 'available', new Date().toISOString(), new Date().toISOString()]
    );

    batches = extractNormalizedBatchesFromTransactions(await getTransactions());
    await consumeInventoryItem(
      'inv-prefix-1',
      1,
      '2026-10-25',
      false,
      'Default',
      'Groceries',
      'lend',
      'Lend to: Test Person',
      3,
      '11:00',
      'Test Person', // User note matches person name: must NOT be duplicated into description
      batches[0]
    );

    txns = await getTransactions();
    const prefixLendTxn = txns.find(t => (t.tags || t.Tags || '').includes('#lent'));
    assert.equal(prefixLendTxn.note, 'to Test Person', 'Accidental prefix is normalized without duplicating "to"');
    assert.ok(!prefixLendTxn.description.includes('- Test Person'), 'Person name in user note is not duplicated into description');

    debt = calculateDebtLedgers(txns);
    assert.equal(debt.totalReceivable, 100, 'Debt Tracker recognizes receivable despite input prefix');
    assert.equal(debt.personLedgers[0].name, 'Test Person');

    // Case C: Separate memo entered in optional Note ('for groceries')
    await db.query('DELETE FROM transactions');
    await db.query('DELETE FROM inventory');

    await addTransaction({
      id: 'txn-purchase-memo-test',
      date: '2026-10-25',
      time: '10:00',
      type: 'Transfer-Out',
      from_account: 'HDFC Savings',
      to_account: 'Stock',
      category: 'Stock',
      subcategory: 'Purchase',
      amount: 100,
      inr: 100,
      note: 'Test Store',
      description: 'Purchased 1 pcs\n• 1 pcs @ ₹100.00/pcs [Stock Available] #batch:test_batch_memo'
    });
    await db.query(
      `INSERT INTO inventory (id, name, qty, original_qty, unit, price, discounted_price, purchased_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['inv-memo-1', 'Memo Item', 1, 1, 'pcs', 100, 100, '2026-10-25', 'available', new Date().toISOString(), new Date().toISOString()]
    );

    batches = extractNormalizedBatchesFromTransactions(await getTransactions());
    await consumeInventoryItem(
      'inv-memo-1',
      1,
      '2026-10-25',
      false,
      'Default',
      'Groceries',
      'lend',
      'Test Person',
      3,
      '11:00',
      'for groceries', // Genuine user memo: preserved in description
      batches[0]
    );

    txns = await getTransactions();
    const memoLendTxn = txns.find(t => (t.tags || t.Tags || '').includes('#lent'));
    assert.equal(memoLendTxn.note, 'to Test Person', 'Note remains strictly "to Test Person"');
    assert.ok(memoLendTxn.description.includes('- for groceries'), 'Extra user memo is preserved in description');

    debt = calculateDebtLedgers(txns);
    assert.equal(debt.totalReceivable, 100, 'Debt Tracker parses counterparty cleanly');
    assert.equal(debt.personLedgers[0].name, 'Test Person');

    // Case D: Monetary repayment settles the Debt Tracker entry back to ₹0
    await addTransaction({
      id: 'txn-repay-test-person',
      date: '2026-10-26',
      time: '12:00',
      type: 'Transfer-Out',
      from_account: 'Lend',
      to_account: 'HDFC Savings',
      category: 'Transfer',
      subcategory: '',
      amount: 100,
      inr: 100,
      note: 'From Test Person',
      description: 'Repayment for lent stock'
    });

    txns = await getTransactions();
    balances = calculateBalances(txns);
    assert.equal(balances.Stock, 0, 'Stock balance is 0');
    assert.equal(balances.Lend, 0, 'Lend balance cleared back to 0');
    assert.equal(balances['HDFC Savings'], 0, 'HDFC Savings restored back to 0');

    debt = calculateDebtLedgers(txns);
    assert.equal(debt.totalReceivable, 0, 'Debt Tracker total receivable cleared to 0 after repayment');
    assert.equal(debt.personLedgers[0].netBalance, 0, 'Test Person balance settled to 0');

    // Case E: Historical note compatibility check (e.g. legacy 'Lend to Test Person')
    const legacyTxns = [
      {
        Account: 'Stock', FromAccount: 'Stock', ToAccount: 'Lend',
        Category: 'Transfer', 'Income/Expense': 'Transfer-Out',
        Note: 'Lend to Legacy Person', INR: 150, Amount: '150'
      }
    ];
    const legacyDebt = calculateDebtLedgers(legacyTxns);
    assert.equal(legacyDebt.totalReceivable, 150, 'Historical "Lend to <Person>" format is fully recognized');
    assert.equal(legacyDebt.personLedgers[0].name, 'Legacy Person');
  });

  // 10. Regression coverage: store header, legacy ID, multiple same-name batches, and deletion restoration
  await suite.test('10. Regression coverage: store header, no-header, legacy ID, multiple batches, and deletion restoration', async () => {
    const db = getDB();

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario A: Purchase with a store header -> lend -> delete lending transaction -> inventory restored -> lend again successfully
    // ──────────────────────────────────────────────────────────────────────────
    await db.query('DELETE FROM transactions');
    await db.query('DELETE FROM inventory');

    await addInventoryPurchase({
      fromAccount: 'HDFC Savings',
      date: '2026-10-25',
      time: '10:00',
      note: 'in stock',
      items: [
        {
          name: 'Test Item',
          price: 100,
          discounted_price: 100,
          original_qty: 1,
          qty: 1,
          pack_qty: 1,
          sub_qty: 1,
          sub_unit: 'pcs',
          notes: 'Test Store'
        }
      ]
    });

    let invItems = await getInventoryItems();
    assert.equal(invItems.length, 1);
    assert.match(invItems[0].id, /^2026-10-25_.+_2$/, 'Batch ID in DB reflects line index 2 due to store header offset');

    let txns = await getTransactions();
    let batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].batchId, invItems[0].id, 'Normalized batch ID from transactions matches DB inventory row ID exactly');
    assert.equal(batches[0].remainingQty, 1);

    // Lend to Test Person
    await consumeInventoryItem(
      batches[0].batchId,
      1,
      '2026-10-25',
      false,
      'Default',
      'Groceries',
      'lend',
      'Test Person',
      3,
      '11:00',
      '',
      batches[0]
    );

    invItems = await getInventoryItems();
    assert.equal(invItems[0].qty, 0, 'Inventory row qty is 0 after lending');
    assert.equal(invItems[0].status, 'unavailable');

    txns = await getTransactions();
    const lendTxn = txns.find(t => (t.tags || t.Tags || '').includes('#lent'));
    assert.ok(lendTxn, 'Lending transaction created');
    assert.equal(lendTxn.note, 'to Test Person');
    assert.equal(lendTxn.type || lendTxn['Income/Expense'], 'Transfer-Out');
    assert.equal(lendTxn.from_account || lendTxn.FromAccount, 'Stock');
    assert.equal(lendTxn.to_account || lendTxn.ToAccount, 'Lend');

    let debt = calculateDebtLedgers(txns);
    assert.equal(debt.totalReceivable, 100);
    assert.equal(debt.personLedgers[0].name, 'Test Person');

    let balances = calculateBalances(txns);
    assert.equal(balances.Stock, 0);
    assert.equal(balances.Lend, 100);

    // Delete the lending transaction
    await deleteTransaction(lendTxn.id);

    invItems = await getInventoryItems();
    assert.equal(invItems[0].qty, 1, 'Inventory row qty restored back to 1 after deleting lending transaction');
    assert.equal(invItems[0].status, 'available');

    txns = await getTransactions();
    batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches[0].remainingQty, 1, 'Dynamic batches show 1 available');

    balances = calculateBalances(txns);
    assert.equal(balances.Stock, 100, 'Stock account balance restored to ₹100');
    assert.equal(balances.Lend, 0, 'Lend account balance reset to ₹0');

    debt = calculateDebtLedgers(txns);
    assert.equal(debt.totalReceivable, 0, 'Debt Tracker receivable cleared');

    // Lend again to Test Man successfully!
    await consumeInventoryItem(
      batches[0].batchId,
      1,
      '2026-10-25',
      false,
      'Default',
      'Groceries',
      'lend',
      'Test Man',
      3,
      '12:00',
      '',
      batches[0]
    );

    invItems = await getInventoryItems();
    assert.equal(invItems[0].qty, 0, 'Lent again successfully: inventory row qty is now 0');
    txns = await getTransactions();
    const secondLendTxn = txns.find(t => (t.tags || t.Tags || '').includes('#lent') && t.note === 'to Test Man');
    assert.ok(secondLendTxn);
    assert.equal(secondLendTxn.note, 'to Test Man');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario B: Purchase without a store header
    // ──────────────────────────────────────────────────────────────────────────
    await db.query('DELETE FROM transactions');
    await db.query('DELETE FROM inventory');

    await addInventoryPurchase({
      fromAccount: 'HDFC Savings',
      date: '2026-10-25',
      time: '10:00',
      note: 'in stock',
      items: [
        {
          name: 'No Header Item',
          price: 50,
          discounted_price: 50,
          original_qty: 1,
          qty: 1,
          pack_qty: 1,
          sub_qty: 1,
          sub_unit: 'pcs',
          notes: '' // No store header
        }
      ]
    });

    invItems = await getInventoryItems();
    assert.equal(invItems.length, 1);
    assert.match(invItems[0].id, /^2026-10-25_.+_0$/, 'Batch ID in DB reflects line index 0 when no store header');

    txns = await getTransactions();
    batches = extractNormalizedBatchesFromTransactions(txns);
    assert.equal(batches[0].batchId, invItems[0].id, 'Batch ID matches DB id at line 0');

    await consumeInventoryItem(
      batches[0].batchId,
      1,
      '2026-10-25',
      false,
      'Default',
      'Groceries',
      'lend',
      'Friend A',
      3,
      '11:00',
      '',
      batches[0]
    );

    invItems = await getInventoryItems();
    assert.equal(invItems[0].qty, 0);

    txns = await getTransactions();
    const noHeaderLendTxn = txns.find(t => (t.tags || t.Tags || '').includes('#lent'));
    await deleteTransaction(noHeaderLendTxn.id);

    invItems = await getInventoryItems();
    assert.equal(invItems[0].qty, 1, 'Restored successfully for purchase without store header');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario C: Multiple batches with the same item name (ambiguity prevention)
    // ──────────────────────────────────────────────────────────────────────────
    await db.query('DELETE FROM transactions');
    await db.query('DELETE FROM inventory');

    // Insert two distinct batches of "Soap"
    await db.query(
      `INSERT INTO inventory (id, name, qty, original_qty, unit, price, discounted_price, purchased_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['batch-soap-1', 'Soap', 1, 1, 'pcs', 30, 30, '2026-10-20', 'available', new Date().toISOString(), new Date().toISOString()]
    );
    await db.query(
      `INSERT INTO inventory (id, name, qty, original_qty, unit, price, discounted_price, purchased_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['batch-soap-2', 'Soap', 1, 1, 'pcs', 40, 40, '2026-10-21', 'available', new Date().toISOString(), new Date().toISOString()]
    );

    // Consume specifically from batch-soap-2
    await db.query('UPDATE inventory SET qty = 0, status = "unavailable" WHERE id = ?', ['batch-soap-2']);

    // Add a lending transaction referencing batch-soap-2
    const soapLendTxn = {
      id: 'txn-soap-lend-test',
      date: '2026-10-25',
      time: '12:00',
      type: 'Transfer-Out',
      from_account: 'Stock',
      to_account: 'Lend',
      category: 'Transfer',
      subcategory: '',
      amount: 40,
      inr: 40,
      note: 'to Neighbor',
      description: 'Lent 1 pcs of Soap (bought on 21 Oct 2026)',
      tags: '#stock_ref_batch-soap-2:1 #lent'
    };
    await addTransaction(soapLendTxn);

    // Deleting this transaction must restore batch-soap-2 and NOT touch batch-soap-1
    await deleteTransaction(soapLendTxn.id);
    let soap1 = (await db.query('SELECT * FROM inventory WHERE id = ?', ['batch-soap-1'])).values[0];
    let soap2 = (await db.query('SELECT * FROM inventory WHERE id = ?', ['batch-soap-2'])).values[0];
    assert.equal(soap1.qty, 1, 'Batch 1 quantity remains unchanged');
    assert.equal(soap2.qty, 1, 'Batch 2 quantity restored to 1');

    // Ambiguity safety check: If a transaction has a non-existent ref ID and description is ambiguous
    // because multiple batches exist with name "Soap", deleteTransaction must refuse to restore arbitrary stock!
    const ambiguousTxn = {
      id: 'txn-ambiguous-soap',
      date: '2026-10-25',
      time: '13:00',
      type: 'Transfer-Out',
      from_account: 'Stock',
      to_account: 'Lend',
      amount: 30,
      inr: 30,
      note: 'to Someone',
      description: 'Lent 1 pcs of Soap',
      tags: '#stock_ref_unknown-nonexistent-ref:1 #lent'
    };
    await addTransaction(ambiguousTxn);
    await deleteTransaction(ambiguousTxn.id);

    soap1 = (await db.query('SELECT * FROM inventory WHERE id = ?', ['batch-soap-1'])).values[0];
    soap2 = (await db.query('SELECT * FROM inventory WHERE id = ?', ['batch-soap-2'])).values[0];
    assert.equal(soap1.qty, 1, 'Batch 1 was NOT inflated');
    assert.equal(soap2.qty, 1, 'Batch 2 was NOT inflated');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario D: Legacy batch IDs (index offset compatibility and legacy map)
    // ──────────────────────────────────────────────────────────────────────────
    await db.query('DELETE FROM transactions');
    await db.query('DELETE FROM inventory');

    // D1: Inventory row has older _0 index, but lending tag references _2 (offset mismatch)
    const legacyTxnId = '98e275ea-49da-4234-ab95-ccc78912f85b';
    await db.query(
      `INSERT INTO inventory (id, name, qty, original_qty, unit, price, discounted_price, purchased_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`2026-10-25_${legacyTxnId}_0`, 'Legacy Oil', 0, 1, 'pcs', 100, 100, '2026-10-25', 'unavailable', new Date().toISOString(), new Date().toISOString()]
    );

    const legacyLendTxn = {
      id: 'txn-legacy-offset-test',
      date: '2026-10-25',
      time: '14:00',
      type: 'Transfer-Out',
      from_account: 'Stock',
      to_account: 'Lend',
      amount: 100,
      inr: 100,
      note: 'to Relative',
      description: 'Lent 1 pcs of Legacy Oil (1 pcs (bought on 25 Oct 2026 from Store))',
      tags: `#stock_ref_2026-10-25_${legacyTxnId}_2:1 #lent`
    };
    await addTransaction(legacyLendTxn);

    // Deleting should find 2026-10-25_legacyTxnId_0 via structured fallback and restore it
    await deleteTransaction(legacyLendTxn.id);
    let legacyItem = (await db.query('SELECT * FROM inventory WHERE id = ?', [`2026-10-25_${legacyTxnId}_0`])).values[0];
    assert.equal(legacyItem.qty, 1, 'Legacy offset inventory row restored successfully to 1');
    assert.equal(legacyItem.status, 'available');

    // D2: Historical legacy UUID mapped via LEGACY_HISTORICAL_REF_MAP
    // '9ba4ff10-0847-40dd-9398-d5903ba598ec' -> '2026-04-28_98e275ea-49da-4234-ab95-ccc78912f85b_4'
    const canonicalLegacyId = '2026-04-28_98e275ea-49da-4234-ab95-ccc78912f85b_4';
    await db.query(
      `INSERT INTO inventory (id, name, qty, original_qty, unit, price, discounted_price, purchased_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [canonicalLegacyId, 'Santoor Soap', 0, 1, 'pcs', 45, 45, '2026-04-28', 'unavailable', new Date().toISOString(), new Date().toISOString()]
    );

    const uuidLendTxn = {
      id: 'txn-uuid-map-test',
      date: '2026-10-25',
      time: '15:00',
      type: 'Transfer-Out',
      from_account: 'Stock',
      to_account: 'Lend',
      amount: 45,
      inr: 45,
      note: 'to Cousin',
      description: 'Lent 1 pcs of Santoor Soap',
      tags: '#stock_ref_9ba4ff10-0847-40dd-9398-d5903ba598ec:1 #lent'
    };
    await addTransaction(uuidLendTxn);
    await deleteTransaction(uuidLendTxn.id);

    const santoorItem = (await db.query('SELECT * FROM inventory WHERE id = ?', [canonicalLegacyId])).values[0];
    assert.equal(santoorItem.qty, 1, 'Legacy UUID mapped and restored canonical batch ID correctly');
    assert.equal(santoorItem.status, 'available');

    // ──────────────────────────────────────────────────────────────────────────
    // Scenario E: Repeated deletion and prevention of double restoration
    // ──────────────────────────────────────────────────────────────────────────
    // Deleting uuidLendTxn a SECOND time must NOT restore another 1 unit to Santoor Soap
    await deleteTransaction(uuidLendTxn.id);
    const santoorItemAfterRepeated = (await db.query('SELECT * FROM inventory WHERE id = ?', [canonicalLegacyId])).values[0];
    assert.equal(santoorItemAfterRepeated.qty, 1, 'Repeated deletion did NOT duplicate stock; qty remains 1');
  });
});
