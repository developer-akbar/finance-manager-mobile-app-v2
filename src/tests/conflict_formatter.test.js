import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatConflictEntity,
  calculateEntityDiff,
  getFriendlyConflictType,
  getFriendlyCollection,
  formatINR,
  formatFriendlyDate,
  normalizeDateKey,
  formatTransactionType
} from '../utils/conflictFormatter.js';

test('conflictFormatter test suite', async (t) => {
  await t.test('1. Complete transaction formatting produces clean title and subtitle', () => {
    const conflict = {
      collection: 'transactions',
      conflict_type: 'CONCURRENT_EDIT',
      entity_id: '4d84b25e-04fa-4f9e-a035-eec1287c88a8',
      local_payload: {
        id: '4d84b25e-04fa-4f9e-a035-eec1287c88a8',
        type: 'expense',
        amount: 1250,
        date: '2026-09-27',
        category: 'Groceries',
        account: 'HDFC Bank',
        note: 'Supermarket weekly groceries'
      },
      remote_payload: {
        id: '4d84b25e-04fa-4f9e-a035-eec1287c88a8',
        type: 'expense',
        amount: 1450,
        date: '2026-09-27',
        category: 'Groceries',
        account: 'HDFC Bank',
        note: 'Supermarket weekly groceries & snacks'
      }
    };

    const formatted = formatConflictEntity(conflict);
    assert.equal(formatted.collectionLabel, 'Transaction');
    assert.equal(formatted.friendlyType, 'Simultaneous Edit');
    assert.equal(formatted.primaryTitle, 'Expense — Supermarket weekly groceries');
    assert.match(formatted.primarySubtitle, /₹1,250/);
    assert.match(formatted.primarySubtitle, /27 Sep 2026/);
    assert.match(formatted.primarySubtitle, /Groceries/);
    assert.equal(formatted.shortEntityId, '4d84b25e');
    assert.equal(formatted.peerDeviceLabel, 'Other Device');
  });

  await t.test('2. Transaction fallback when note is missing uses category or generic title', () => {
    const conflict = {
      collection: 'transactions',
      conflict_type: 'CONCURRENT_EDIT',
      entity_id: 'tx_no_note_1234',
      local_payload: {
        type: 'income',
        amount: 50000,
        category: 'Salary'
      },
      remote_payload: {
        type: 'income',
        amount: 50000,
        category: 'Salary'
      }
    };

    const formatted = formatConflictEntity(conflict);
    assert.equal(formatted.primaryTitle, 'Income — Salary');
    assert.match(formatted.primarySubtitle, /₹50,000/);
  });

  await t.test('3. Transaction fallback when note & category are missing', () => {
    const conflict = {
      collection: 'transactions',
      conflict_type: 'CONCURRENT_EDIT',
      entity_id: 'tx_minimal_1234',
      local_payload: {
        type: 'transfer',
        amount: 500
      },
      remote_payload: {}
    };

    const formatted = formatConflictEntity(conflict);
    assert.equal(formatted.primaryTitle, 'Transfer Transaction');
    assert.equal(formatted.primarySubtitle, '₹500');
  });

  await t.test('4. Missing optional fields handled safely without crashing', () => {
    const conflict = {
      collection: 'transactions',
      conflict_type: 'CONCURRENT_EDIT',
      entity_id: 'tx_empty_1234',
      local_payload: {},
      remote_payload: {}
    };

    const formatted = formatConflictEntity(conflict);
    assert.equal(formatted.primaryTitle, 'Untitled Transaction');
    assert.equal(formatted.primarySubtitle, '');
  });

  await t.test('5. Account formatting extracts name and balance accurately', () => {
    const conflict = {
      collection: 'accounts',
      conflict_type: 'CONCURRENT_EDIT',
      entity_id: 'acc_hdfc_123',
      local_payload: {
        name: 'HDFC Savings',
        type: 'Savings',
        balance: 45000
      },
      remote_payload: {
        name: 'HDFC Savings Account',
        type: 'Savings',
        balance: 50000
      }
    };

    const formatted = formatConflictEntity(conflict);
    assert.equal(formatted.collectionLabel, 'Account');
    assert.equal(formatted.primaryTitle, 'Account — HDFC Savings');
    assert.match(formatted.primarySubtitle, /Savings/);
    assert.match(formatted.primarySubtitle, /₹45,000/);
  });

  await t.test('6. Category formatting extracts category name and type', () => {
    const conflict = {
      collection: 'categories',
      conflict_type: 'CONCURRENT_EDIT',
      entity_id: 'cat_dining_123',
      local_payload: {
        name: 'Dining Out',
        type: 'Expense'
      },
      remote_payload: {
        name: 'Food & Dining',
        type: 'Expense'
      }
    };

    const formatted = formatConflictEntity(conflict);
    assert.equal(formatted.collectionLabel, 'Category');
    assert.equal(formatted.primaryTitle, 'Category — Dining Out');
    assert.equal(formatted.primarySubtitle, 'Expense');
  });

  await t.test('7. Generic entity fallback works for custom/unknown collections', () => {
    const conflict = {
      collection: 'budgets',
      conflict_type: 'CONCURRENT_EDIT',
      entity_id: 'budget_q4',
      local_payload: {
        title: 'Q4 Marketing Budget'
      },
      remote_payload: {}
    };

    const formatted = formatConflictEntity(conflict);
    assert.equal(formatted.collectionLabel, 'Budgets');
    assert.equal(formatted.primaryTitle, 'Budgets — Q4 Marketing Budget');
  });

  await t.test('8. Single changed field is identified in diff', () => {
    const local = {
      amount: 100,
      note: 'Coffee',
      date: '2026-09-27',
      category: 'Food'
    };
    const remote = {
      amount: 120,
      note: 'Coffee',
      date: '2026-09-27',
      category: 'Food'
    };

    const diff = calculateEntityDiff(local, remote, 'transactions');
    assert.equal(diff.hasChanges, true);
    assert.equal(diff.changedFields.length, 1);
    assert.equal(diff.changedFields[0].key, 'amount');
    assert.equal(diff.changedFields[0].localValue, '₹100');
    assert.equal(diff.changedFields[0].remoteValue, '₹120');
    assert.equal(diff.unchangedFields.length, 3);
  });

  await t.test('9. Multiple changed fields are categorized in diff', () => {
    const local = {
      amount: 1250,
      note: 'Grocery Store',
      category: 'Groceries'
    };
    const remote = {
      amount: 1450,
      note: 'Supermarket',
      category: 'Household'
    };

    const diff = calculateEntityDiff(local, remote, 'transactions');
    assert.equal(diff.changedFields.length, 3);
    const keys = diff.changedFields.map(f => f.key);
    assert.ok(keys.includes('amount'));
    assert.ok(keys.includes('note'));
    assert.ok(keys.includes('category'));
  });

  await t.test('10. Unchanged fields are preserved in unchanged list', () => {
    const local = {
      amount: 500,
      note: 'Stationery',
      category: 'Office',
      account: 'Cash'
    };
    const remote = {
      amount: 500,
      note: 'Stationery Items',
      category: 'Office',
      account: 'Cash'
    };

    const diff = calculateEntityDiff(local, remote, 'transactions');
    assert.equal(diff.changedFields.length, 1);
    assert.equal(diff.changedFields[0].key, 'note');
    assert.equal(diff.unchangedFields.length, 3);
    const unKeys = diff.unchangedFields.map(f => f.key);
    assert.ok(unKeys.includes('amount'));
    assert.ok(unKeys.includes('category'));
    assert.ok(unKeys.includes('account'));
  });

  await t.test('11. Numeric amount normalization avoids false positives', () => {
    const local = { amount: 1000.00 };
    const remote = { amount: 1000 };

    const diff = calculateEntityDiff(local, remote, 'transactions');
    assert.equal(diff.changedFields.length, 0);
    assert.equal(diff.unchangedFields.length, 1);
  });

  await t.test('12. Date normalization avoids false differences from date format variations', () => {
    const local = { date: '2026-09-27' };
    const remote = { date: '27/09/2026' };

    const diff = calculateEntityDiff(local, remote, 'transactions');
    assert.equal(diff.changedFields.length, 0);
    assert.equal(diff.unchangedFields.length, 1);
  });

  await t.test('13. Remote delete / local edit conflict is recognized in diff and formatter', () => {
    const conflict = {
      collection: 'transactions',
      conflict_type: 'REMOTE_DELETE_LOCAL_EDIT',
      entity_id: 'tx_del_123',
      local_payload: {
        type: 'expense',
        note: 'Taxi Ride',
        amount: 350
      },
      remote_payload: null
    };

    const formatted = formatConflictEntity(conflict);
    assert.equal(formatted.friendlyType, 'Deleted on Other Device');
    assert.equal(formatted.isRemoteDeleted, true);
    assert.equal(formatted.primaryTitle, 'Expense — Taxi Ride');

    const diff = calculateEntityDiff(conflict.local_payload, conflict.remote_payload, 'transactions');
    assert.equal(diff.isDeleteConflict, true);
    assert.equal(diff.hasChanges, true);
    assert.equal(diff.changedFields[0].key, 'status');
    assert.equal(diff.changedFields[0].localValue, 'Active on This Device');
    assert.equal(diff.changedFields[0].remoteValue, 'Deleted on Other Device');
  });

  await t.test('14. Unknown conflict type falls back safely', () => {
    assert.equal(getFriendlyConflictType('CUSTOM_FUTURE_TYPE'), 'Conflict Detected');
    assert.equal(getFriendlyConflictType(null), 'Conflict Detected');
    assert.equal(getFriendlyConflictType(undefined), 'Conflict Detected');

    const conflict = {
      collection: 'transactions',
      conflict_type: 'CUSTOM_FUTURE_TYPE',
      entity_id: 'tx_custom_123',
      local_payload: { note: 'Custom' }
    };
    const formatted = formatConflictEntity(conflict);
    assert.equal(formatted.friendlyType, 'Conflict Detected');
  });

  await t.test('15. Null and undefined payloads are completely safe without throwing', () => {
    assert.doesNotThrow(() => formatConflictEntity(null));
    assert.doesNotThrow(() => formatConflictEntity(undefined));
    assert.doesNotThrow(() => formatConflictEntity({}));
    assert.doesNotThrow(() => calculateEntityDiff(null, null));
    assert.doesNotThrow(() => calculateEntityDiff(undefined, undefined));

    const nullDiff = calculateEntityDiff(null, null);
    assert.equal(nullDiff.hasChanges, false);
    assert.equal(nullDiff.isDeleteConflict, true);
  });
});
