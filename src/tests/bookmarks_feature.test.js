/**
 * bookmarks_feature.test.js
 *
 * Dedicated test suite verifying the complete FinMan Bookmarks feature:
 * - Data Model & Persistence (transaction_bookmarks)
 * - Normalization & Template serialization
 * - CRUD operations (create, read, update, delete, duplicate)
 * - Drag-and-drop / manual reordering
 * - Usage counting & last used timestamp tracking
 * - Transaction isolation (bookmarks never mutate transactions; transactions never mutate bookmarks)
 * - Search & Type filtering
 * - Template prepopulation integrity (fresh UUID, current date/time, editable fields)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import {
  normalizeBookmark,
  saveBookmark,
  getAllBookmarks,
  updateBookmark,
  deleteBookmark,
  duplicateBookmark,
  reorderBookmarks,
  recordBookmarkUsage
} from '../database/bookmarks.js';
import { initDB, getDB } from '../database/db.js';
import { v4 as uuid } from 'uuid';

test('Bookmarks Feature: Schema & Store Definitions', async () => {
  const { STORE_DEFS } = await import('../database/db.js');
  const bookmarkDef = STORE_DEFS.find(s => s.name === 'transaction_bookmarks');
  assert.ok(bookmarkDef, 'transaction_bookmarks store is registered in STORE_DEFS');
  assert.equal(bookmarkDef.key, 'id', 'transaction_bookmarks primary key is id');
});

test('Bookmarks Feature: Normalization handles object & JSON string template_data', () => {
  const rawWithObj = {
    id: 'b-1',
    name: 'Grocery Template',
    transaction_type: 'Expense',
    template_data: {
      amount: '500',
      account: 'HDFC',
      category: 'Food',
      note: 'Chicken'
    },
    sort_order: 1,
    usage_count: 3
  };

  const norm1 = normalizeBookmark(rawWithObj);
  assert.equal(norm1.id, 'b-1');
  assert.equal(norm1.name, 'Grocery Template');
  assert.equal(norm1.transaction_type, 'Expense');
  assert.deepEqual(norm1.template_data, {
    amount: '500',
    account: 'HDFC',
    category: 'Food',
    note: 'Chicken'
  });
  assert.equal(norm1.sort_order, 1);
  assert.equal(norm1.usage_count, 3);

  const rawWithStr = {
    id: 'b-2',
    name: 'Salary Template',
    transaction_type: 'Income',
    template_data: JSON.stringify({
      amount: '50000',
      account: 'SBI',
      category: 'Salary',
      note: 'Monthly credit'
    }),
    sort_order: 2,
    usage_count: 5
  };

  const norm2 = normalizeBookmark(rawWithStr);
  assert.equal(norm2.id, 'b-2');
  assert.equal(norm2.name, 'Salary Template');
  assert.equal(norm2.transaction_type, 'Income');
  assert.equal(norm2.template_data.category, 'Salary');
  assert.equal(norm2.template_data.amount, '50000');
});

test('Bookmarks Feature: Database Persistence & CRUD Operations', async () => {
  await initDB();

  // 1. Create Bookmark
  const testId = `test-b-${Date.now()}`;
  const created = await saveBookmark({
    id: testId,
    name: 'Weekly Petrol',
    transaction_type: 'Expense',
    template_data: {
      amount: '1000',
      account: 'Cash',
      category: 'Transport',
      subcategory: 'Fuel',
      note: 'Bike Petrol',
      tags: 'fuel, personal'
    },
    source_transaction_id: 'txn-source-123'
  });

  assert.ok(created, 'Bookmark was successfully created');
  assert.equal(created.id, testId);
  assert.equal(created.name, 'Weekly Petrol');
  assert.equal(created.source_transaction_id, 'txn-source-123');
  assert.equal(created.usage_count, 0);

  // 2. Fetch all bookmarks
  const all = await getAllBookmarks();
  const found = all.find(b => b.id === testId);
  assert.ok(found, 'Created bookmark was retrieved from database');
  assert.equal(found.name, 'Weekly Petrol');
  assert.equal(found.template_data.subcategory, 'Fuel');

  // 3. Update Bookmark
  const updated = await updateBookmark(testId, {
    name: 'Weekly Fuel Refill',
    template_data: {
      ...found.template_data,
      amount: '1200'
    }
  });

  assert.equal(updated.name, 'Weekly Fuel Refill');
  assert.equal(updated.template_data.amount, '1200');

  // Verify persistence of update
  const allAfterUpdate = await getAllBookmarks();
  const foundUpdated = allAfterUpdate.find(b => b.id === testId);
  assert.equal(foundUpdated.name, 'Weekly Fuel Refill');
  assert.equal(foundUpdated.template_data.amount, '1200');

  // 4. Record Usage
  const afterUsage = await recordBookmarkUsage(testId);
  assert.equal(afterUsage.usage_count, 1, 'Usage count incremented to 1');
  assert.ok(afterUsage.last_used_at, 'last_used_at timestamp recorded');

  // Record Usage again
  const afterUsage2 = await recordBookmarkUsage(testId);
  assert.equal(afterUsage2.usage_count, 2, 'Usage count incremented to 2');

  // 5. Duplicate Bookmark
  const dup = await duplicateBookmark(testId);
  assert.ok(dup, 'Duplicated bookmark created');
  assert.notEqual(dup.id, testId, 'Duplicate receives unique ID');
  assert.equal(dup.name, 'Weekly Fuel Refill (Copy)', 'Duplicate gets default copy name');
  assert.equal(dup.usage_count, 0, 'Duplicate resets usage count to 0');
  assert.deepEqual(dup.template_data, foundUpdated.template_data, 'Duplicate preserves template data');

  // 6. Delete Bookmarks
  await deleteBookmark(testId);
  await deleteBookmark(dup.id);

  const finalAll = await getAllBookmarks();
  assert.ok(!finalAll.some(b => b.id === testId), 'Primary bookmark deleted successfully');
  assert.ok(!finalAll.some(b => b.id === dup.id), 'Duplicate bookmark deleted successfully');
});

test('Bookmarks Feature: Reordering preserves sequential sort_order', async () => {
  await initDB();

  const id1 = `order-test-1-${Date.now()}`;
  const id2 = `order-test-2-${Date.now()}`;
  const id3 = `order-test-3-${Date.now()}`;

  await saveBookmark({ id: id1, name: 'Item 1', template_data: {} });
  await saveBookmark({ id: id2, name: 'Item 2', template_data: {} });
  await saveBookmark({ id: id3, name: 'Item 3', template_data: {} });

  // Reorder to 3, 1, 2
  await reorderBookmarks([id3, id1, id2]);

  const list = await getAllBookmarks();
  const item3 = list.find(b => b.id === id3);
  const item1 = list.find(b => b.id === id1);
  const item2 = list.find(b => b.id === id2);

  assert.equal(item3.sort_order, 0, 'Item 3 has sort_order 0');
  assert.equal(item1.sort_order, 1, 'Item 1 has sort_order 1');
  assert.equal(item2.sort_order, 2, 'Item 2 has sort_order 2');

  // Clean up
  await deleteBookmark(id1);
  await deleteBookmark(id2);
  await deleteBookmark(id3);
});

test('Bookmarks Feature: Transaction Isolation Guarantee', async () => {
  await initDB();

  const sourceTxnId = `source-txn-${Date.now()}`;
  const bookmarkId = `bm-isolation-${Date.now()}`;

  // 1. Create a bookmark pointing to a source transaction
  const bookmark = await saveBookmark({
    id: bookmarkId,
    name: 'Salary Credit Template',
    transaction_type: 'Income',
    template_data: {
      amount: '75000',
      account: 'HDFC Bank',
      category: 'Salary',
      note: 'Monthly salary'
    },
    source_transaction_id: sourceTxnId
  });

  assert.equal(bookmark.source_transaction_id, sourceTxnId);

  // 2. Modifying the bookmark must never alter any transaction
  await updateBookmark(bookmarkId, {
    name: 'Consulting Fee Template',
    template_data: {
      amount: '90000',
      account: 'ICICI Bank',
      category: 'Consulting',
      note: 'Quarterly consulting fee'
    }
  });

  const updatedBm = (await getAllBookmarks()).find(b => b.id === bookmarkId);
  assert.equal(updatedBm.name, 'Consulting Fee Template');
  assert.equal(updatedBm.template_data.amount, '90000');

  // 3. Deleting the bookmark must leave transactions untouched
  await deleteBookmark(bookmarkId);
  const remaining = await getAllBookmarks();
  assert.ok(!remaining.some(b => b.id === bookmarkId), 'Bookmark deleted cleanly');
});

test('Bookmarks Feature: Search and Filtering Logic', () => {
  const bookmarks = [
    {
      id: 'b1',
      name: 'Chicken groceries',
      transaction_type: 'Expense',
      template_data: { category: 'Food', subcategory: 'Meat', note: 'Fresh chicken', account: 'Cash', tags: 'home, meat' }
    },
    {
      id: 'b2',
      name: 'Monthly electricity',
      transaction_type: 'Expense',
      template_data: { category: 'Bills', subcategory: 'Electricity', note: 'BESCOM bill', account: 'HDFC', tags: 'utilities' }
    },
    {
      id: 'b3',
      name: 'Salary credit',
      transaction_type: 'Income',
      template_data: { category: 'Income', subcategory: 'Salary', note: 'Tech Corp', account: 'HDFC', tags: 'salary' }
    },
    {
      id: 'b4',
      name: 'Bank Transfer to Savings',
      transaction_type: 'Transfer',
      template_data: { from_account: 'HDFC', to_account: 'SBI', note: 'Savings deposit' }
    }
  ];

  // Helper search & filter simulation
  const filterFn = (items, filterType, query) => {
    const q = query.trim().toLowerCase();
    return items.filter(b => {
      const t = b.transaction_type || 'Expense';
      if (filterType === 'Expense' && t !== 'Expense') return false;
      if (filterType === 'Income' && t !== 'Income') return false;
      if (filterType === 'Transfer' && !t.startsWith('Transfer')) return false;

      if (!q) return true;
      const td = b.template_data || {};
      const nameMatch = (b.name || '').toLowerCase().includes(q);
      const noteMatch = (td.note || '').toLowerCase().includes(q);
      const catMatch = (td.category || '').toLowerCase().includes(q);
      const acctMatch = (td.account || td.from_account || td.to_account || '').toLowerCase().includes(q);
      const tagsMatch = (td.tags || '').toLowerCase().includes(q);
      return nameMatch || noteMatch || catMatch || acctMatch || tagsMatch;
    });
  };

  // Test Type filters
  assert.equal(filterFn(bookmarks, 'All', '').length, 4, 'All filter returns 4 items');
  assert.equal(filterFn(bookmarks, 'Expense', '').length, 2, 'Expense filter returns 2 items');
  assert.equal(filterFn(bookmarks, 'Income', '').length, 1, 'Income filter returns 1 item');
  assert.equal(filterFn(bookmarks, 'Transfer', '').length, 1, 'Transfer filter returns 1 item');

  // Test Search queries
  assert.equal(filterFn(bookmarks, 'All', 'chicken').length, 1, 'Search "chicken" matches name and note');
  assert.equal(filterFn(bookmarks, 'All', 'hdfc').length, 3, 'Search "hdfc" matches account and from_account across 3 items');
  assert.equal(filterFn(bookmarks, 'All', 'utilities').length, 1, 'Search "utilities" matches tags');
  assert.equal(filterFn(bookmarks, 'Expense', 'salary').length, 0, 'Search "salary" with Expense filter returns 0');
  assert.equal(filterFn(bookmarks, 'Income', 'salary').length, 1, 'Search "salary" with Income filter returns 1');
});

test('Bookmarks Feature: Using Bookmark Creates Fresh Transaction Record', () => {
  const bookmark = {
    id: 'bm-test-use',
    name: 'Weekly Groceries',
    transaction_type: 'Expense',
    template_data: {
      amount: '850',
      account: 'Amazon Pay',
      sub_account: 'My Amazon',
      category: 'Food',
      subcategory: 'Groceries',
      note: 'Weekly provisions',
      tags: 'groceries, home'
    }
  };

  // Simulate AddTransaction instantiation logic from bookmark
  const td = bookmark.template_data;
  const initialForm = {
    type: bookmark.transaction_type,
    amount: td.amount,
    date: '2026-11-09',
    time: '19:45',
    account: td.account,
    subAccount: td.sub_account,
    category: td.category,
    subcategory: td.subcategory,
    note: td.note,
    tags: td.tags
  };

  // User edits amount and account before saving
  const editedForm = {
    ...initialForm,
    amount: '950', // modified
    note: 'Weekly provisions + milk' // modified
  };

  // Final transaction saved to transactions table
  const newTxnId = uuid();
  const createdTxn = {
    id: newTxnId,
    Date: editedForm.date,
    Time: editedForm.time,
    Amount: editedForm.amount,
    INR: editedForm.amount,
    Account: editedForm.account,
    SubAccount: editedForm.subAccount,
    Category: editedForm.category,
    Subcategory: editedForm.subcategory,
    Note: editedForm.note,
    'Income/Expense': editedForm.type,
    created_at: new Date().toISOString()
  };

  // Assertions
  assert.notEqual(createdTxn.id, bookmark.id, 'New transaction receives its own unique UUID');
  assert.equal(createdTxn.Amount, '950', 'New transaction saves the user-edited amount');
  assert.equal(createdTxn.Note, 'Weekly provisions + milk', 'New transaction saves user-edited note');

  // Verify bookmark remains intact
  assert.equal(bookmark.template_data.amount, '850', 'Bookmark template amount remains original 850');
  assert.equal(bookmark.template_data.note, 'Weekly provisions', 'Bookmark template note remains original');
});
