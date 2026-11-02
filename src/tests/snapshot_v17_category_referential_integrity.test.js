/**
 * snapshot_v17_category_referential_integrity.test.js
 *
 * Regression Suite for Snapshot v17 Referential Integrity:
 * 1. Transaction referencing Cash destination account passes verification.
 * 2. Transaction referencing a legacy category ID / case variation passes verification.
 * 3. Category import and transaction import ordering.
 * 4. Post-snapshot delta containing a transaction referencing Cash.
 * 5. Missing genuinely invalid category causes referential integrity failure and safe rollback.
 * 6. Repeated import remains idempotent.
 * 7. Custom category IDs remain unchanged.
 * 8. Brokerage canonicalization tests continue to pass.
 */

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initDB,
  closeDB
} from '../database/db.js';
import {
  populateLocalEntitiesBootstrap,
  applyLocalEntityInsertOrUpdate
} from '../services/cloudSyncEngine.js';
import {
  verifyReconciledDataIntegrity
} from '../services/snapshotDeviceImport.js';

test('FinMan Phase 15 — Snapshot v17 Category Referential Integrity & Regression Suite', async (t) => {
  let db;

  t.beforeEach(async () => {
    closeDB();
    db = await initDB();
    await db.run('DELETE FROM brokerages;').catch(() => {});
    await db.run('DELETE FROM transactions;').catch(() => {});
    await db.run('DELETE FROM investment_transactions;').catch(() => {});
    await db.run('DELETE FROM accounts;').catch(() => {});
    await db.run('DELETE FROM categories;').catch(() => {});
    await db.run('DELETE FROM subcategories;').catch(() => {});
    await db.run('DELETE FROM sub_accounts;').catch(() => {});
    await db.run('DELETE FROM settings;').catch(() => {});
  });

  t.afterEach(async () => {
    closeDB();
  });

  // 1. Transaction referencing Cash when Cash exists as an account in the snapshot
  await t.test('1. Transfer transaction referencing Cash destination account passes referential integrity', async () => {
    const entities = {
      accounts: [
        { id: 'acct_hdfc', name: 'HDFC', group_name: 'Bank Accounts' },
        { id: 'acct_cash', name: 'Cash', group_name: 'Cash' }
      ],
      categories: [
        { id: 'cat_groceries', name: 'Groceries', type: 'Expense' }
      ],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [
        {
          id: '0001a991-3247-4e2f-b789-87fac4ad7104',
          date: '21/12/2022',
          time: '10:30',
          account: 'HDFC',
          from_account: 'HDFC',
          to_account: 'Cash',
          category: 'Cash',
          inr: 15000,
          amount: '15000',
          currency: 'INR',
          type: 'Transfer-Out',
          note: 'to hand'
        }
      ],
      investment_transactions: []
    };

    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    const result = await verifyReconciledDataIntegrity(db, {
      snapshot_id: 'snap_v17_test_cash',
      cloud_version: 17,
      entities
    });

    assert.ok(result.verified, 'Reconciliation verification must succeed');
    assert.equal(result.actualCounts.transactions, 1);
  });

  // 2. Transaction referencing a legacy category ID / case variation that needs mapping
  await t.test('2. Transaction referencing a legacy category ID or case variation passes verification', async () => {
    const entities = {
      accounts: [
        { id: 'acct_sbi', name: 'SBI', group_name: 'Bank Accounts' }
      ],
      categories: [
        { id: 'cat_uuid_food_dining_999', name: 'Food & Dining', type: 'Expense' }
      ],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [
        // References by ID
        {
          id: 'tx_by_id',
          date: '22/10/2026',
          time: '12:00',
          account: 'SBI',
          category: 'cat_uuid_food_dining_999',
          inr: 250,
          amount: '250',
          type: 'Expense'
        },
        // References by lower-cased name
        {
          id: 'tx_by_lower_name',
          date: '23/10/2026',
          time: '14:00',
          account: 'SBI',
          category: 'food & dining',
          inr: 150,
          amount: '150',
          type: 'Expense'
        }
      ],
      investment_transactions: []
    };

    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    const result = await verifyReconciledDataIntegrity(db, {
      snapshot_id: 'snap_v17_legacy_cat',
      cloud_version: 17,
      entities
    });

    assert.ok(result.verified);
    assert.equal(result.actualCounts.transactions, 2);
  });

  // 3. Category import and transaction import ordering
  await t.test('3. Category import and transaction import ordering populates and verifies correctly', async () => {
    const entities = {
      accounts: [
        { id: 'acct_axis', name: 'Axis', group_name: 'Bank Accounts' }
      ],
      categories: [
        { id: 'cat_bills', name: 'Bills', type: 'Expense' },
        { id: 'cat_salary', name: 'Salary', type: 'Income' }
      ],
      subcategories: [
        { id: 'sub_elec', name: 'Electricity', category_id: 'cat_bills' }
      ],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [
        {
          id: 'tx_salary',
          date: '01/10/2026',
          account: 'Axis',
          category: 'Salary',
          inr: 75000,
          type: 'Income'
        },
        {
          id: 'tx_bills',
          date: '05/10/2026',
          account: 'Axis',
          category: 'Bills',
          subcategory: 'Electricity',
          inr: 3200,
          type: 'Expense'
        }
      ],
      investment_transactions: []
    };

    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    // Verify ordering did not leave orphan references
    const result = await verifyReconciledDataIntegrity(db, {
      snapshot_id: 'snap_v17_order',
      cloud_version: 17,
      entities
    });

    assert.ok(result.verified);
    assert.equal(result.actualCounts.categories, 2);
    assert.equal(result.actualCounts.subcategories, 1);
    assert.equal(result.actualCounts.transactions, 2);
  });

  // 4. Post-snapshot delta containing a transaction referencing Cash
  await t.test('4. Post-snapshot delta containing a transaction referencing Cash applies cleanly', async () => {
    const baseEntities = {
      accounts: [
        { id: 'acct_hdfc', name: 'HDFC', group_name: 'Bank Accounts' },
        { id: 'acct_cash', name: 'Cash', group_name: 'Cash' }
      ],
      categories: [
        { id: 'cat_shopping', name: 'Shopping', type: 'Expense' }
      ],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [],
      investment_transactions: []
    };

    await populateLocalEntitiesBootstrap(db, baseEntities, { allowRecoveryReplacement: true });

    // Inbound delta transaction referencing Cash
    const deltaTxn = {
      id: 'tx_delta_cash_recon',
      date: '25/10/2026',
      time: '16:00',
      account: 'HDFC',
      from_account: 'HDFC',
      to_account: 'Cash',
      category: 'Cash',
      inr: 5000,
      amount: '5000',
      currency: 'INR',
      type: 'Transfer-Out',
      note: 'ATM withdrawal'
    };

    await applyLocalEntityInsertOrUpdate(db, deltaTxn, 'transactions');

    const expectedEntities = {
      ...baseEntities,
      transactions: [deltaTxn]
    };

    const result = await verifyReconciledDataIntegrity(db, {
      snapshot_id: 'snap_v17_delta',
      cloud_version: 17,
      entities: expectedEntities
    });

    assert.ok(result.verified);
    assert.equal(result.actualCounts.transactions, 1);
  });

  // 5. Missing genuinely invalid category still causing a safe rollback
  await t.test('5. Missing genuinely invalid category causes a safe verification error', async () => {
    const entities = {
      accounts: [
        { id: 'acct_hdfc', name: 'HDFC', group_name: 'Bank Accounts' }
      ],
      categories: [
        { id: 'cat_food', name: 'Food', type: 'Expense' }
      ],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [
        {
          id: 'tx_bogus_cat',
          date: '20/10/2026',
          account: 'HDFC',
          category: 'BogusNonExistentCategoryXYZ',
          inr: 500,
          type: 'Expense'
        }
      ],
      investment_transactions: []
    };

    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    await assert.rejects(
      async () => {
        await verifyReconciledDataIntegrity(db, {
          snapshot_id: 'snap_v17_invalid_cat',
          cloud_version: 17,
          entities
        });
      },
      (err) => {
        assert.ok(err.message.includes("references non-existent category 'BogusNonExistentCategoryXYZ'"));
        return true;
      }
    );
  });

  // Test A: Transfer-Out references a nonexistent account in category and to_account. It must fail.
  await t.test('Test A: Transfer-Out referencing nonexistent destination account in category and to_account fails validation', async () => {
    const entities = {
      accounts: [
        { id: 'acct_hdfc', name: 'HDFC', group_name: 'Bank Accounts' }
      ],
      categories: [
        { id: 'cat_groceries', name: 'Groceries', type: 'Expense' }
      ],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [
        {
          id: 'tx_xfer_nonexistent_dest',
          date: '25/10/2026',
          account: 'HDFC',
          from_account: 'HDFC',
          to_account: 'NonExistentBank999',
          category: 'NonExistentBank999',
          inr: 5000,
          type: 'Transfer-Out'
        }
      ],
      investment_transactions: []
    };

    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    await assert.rejects(
      async () => {
        await verifyReconciledDataIntegrity(db, {
          snapshot_id: 'snap_v17_test_a',
          cloud_version: 17,
          entities
        });
      },
      (err) => {
        assert.ok(
          err.message.includes("references non-existent to_account 'NonExistentBank999'") ||
          err.message.includes("references non-existent destination account or category 'NonExistentBank999'")
        );
        return true;
      }
    );
  });

  // Test A2: Transfer-Out with valid to_account (Cash) but nonexistent category. Must specifically fail category validation.
  await t.test('Test A2: Transfer-Out with valid to_account (Cash) but invalid category specifically fails transfer category check', async () => {
    const entities = {
      accounts: [
        { id: 'acct_hdfc', name: 'HDFC', group_name: 'Bank Accounts' },
        { id: 'acct_cash', name: 'Cash', group_name: 'Cash' }
      ],
      categories: [
        { id: 'cat_groceries', name: 'Groceries', type: 'Expense' }
      ],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [
        {
          id: 'tx_xfer_invalid_category_only',
          date: '25/10/2026',
          account: 'HDFC',
          from_account: 'HDFC',
          to_account: 'Cash', // valid existing account!
          category: 'NonExistentBank999', // invalid transfer category!
          inr: 5000,
          type: 'Transfer-Out'
        }
      ],
      investment_transactions: []
    };

    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    await assert.rejects(
      async () => {
        await verifyReconciledDataIntegrity(db, {
          snapshot_id: 'snap_v17_test_a2',
          cloud_version: 17,
          entities
        });
      },
      (err) => {
        // Must specifically fail on destination account or category check, NOT to_account
        assert.ok(
          err.message.includes("references non-existent destination account or category 'NonExistentBank999'"),
          `Expected destination account/category error, got: ${err.message}`
        );
        assert.ok(
          !err.message.includes("references non-existent to_account"),
          `Should not fail on to_account, got: ${err.message}`
        );
        return true;
      }
    );
  });

  // Test B: An Expense references an account name such as Cash as its category, but no matching expense category exists. It must fail.
  await t.test('Test B: Expense transaction referencing account Cash as category fails when no Cash category exists', async () => {
    const entities = {
      accounts: [
        { id: 'acct_hdfc', name: 'HDFC', group_name: 'Bank Accounts' },
        { id: 'acct_cash', name: 'Cash', group_name: 'Cash' }
      ],
      categories: [
        { id: 'cat_groceries', name: 'Groceries', type: 'Expense' }
      ],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [
        {
          id: 'tx_expense_referencing_account_name',
          date: '25/10/2026',
          account: 'HDFC',
          category: 'Cash', // referencing account 'Cash' on an Expense!
          inr: 1200,
          type: 'Expense'
        }
      ],
      investment_transactions: []
    };

    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    await assert.rejects(
      async () => {
        await verifyReconciledDataIntegrity(db, {
          snapshot_id: 'snap_v17_test_b',
          cloud_version: 17,
          entities
        });
      },
      (err) => {
        assert.ok(err.message.includes("references non-existent category 'Cash'"));
        return true;
      }
    );
  });

  // 6. Repeated import remaining idempotent
  await t.test('6. Repeated snapshot import is strictly idempotent and retains referential integrity', async () => {
    const entities = {
      accounts: [
        { id: 'acct_canara', name: 'Canara', group_name: 'Bank Accounts' },
        { id: 'acct_cash', name: 'Cash', group_name: 'Cash' }
      ],
      categories: [
        { id: 'cat_health', name: 'Health', type: 'Expense' }
      ],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [
        {
          id: 'tx_xfer_canara_cash',
          date: '10/10/2026',
          account: 'Canara',
          from_account: 'Canara',
          to_account: 'Cash',
          category: 'Cash',
          inr: 2000,
          type: 'Transfer-Out'
        }
      ],
      investment_transactions: []
    };

    // First import
    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });
    let res = await verifyReconciledDataIntegrity(db, {
      snapshot_id: 'snap_v17_idempotent',
      cloud_version: 17,
      entities
    });
    assert.ok(res.verified);

    // Second import (idempotent repeat)
    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });
    res = await verifyReconciledDataIntegrity(db, {
      snapshot_id: 'snap_v17_idempotent',
      cloud_version: 17,
      entities
    });
    assert.ok(res.verified);
    assert.equal(res.actualCounts.transactions, 1);
  });

  // 7. Custom category IDs remaining unchanged
  await t.test('7. Custom category IDs and names remain completely unchanged', async () => {
    const customCatId = 'custom_cat_uuid_777888';
    const entities = {
      accounts: [
        { id: 'acct_sbi', name: 'SBI', group_name: 'Bank Accounts' }
      ],
      categories: [
        { id: customCatId, name: 'Special Hobby Project', type: 'Expense', sort_order: 99 }
      ],
      subcategories: [
        { id: 'sub_custom_1', name: 'Woodworking', category_id: customCatId, sort_order: 1 }
      ],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [],
      transactions: [
        {
          id: 'tx_custom_cat',
          date: '02/11/2026',
          account: 'SBI',
          category: 'Special Hobby Project',
          subcategory: 'Woodworking',
          inr: 1200,
          type: 'Expense'
        }
      ],
      investment_transactions: []
    };

    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    const qRes = await db.query('SELECT * FROM categories WHERE id = ?;', [customCatId]);
    assert.equal(qRes.values?.length, 1);
    assert.equal(qRes.values[0].id, customCatId);
    assert.equal(qRes.values[0].name, 'Special Hobby Project');

    const result = await verifyReconciledDataIntegrity(db, {
      snapshot_id: 'snap_v17_custom_cat',
      cloud_version: 17,
      entities
    });
    assert.ok(result.verified);
  });

  // 8. Brokerage canonicalization tests continuing to pass alongside category integrity
  await t.test('8. Brokerage canonicalization and category referential integrity work together seamlessly', async () => {
    const entities = {
      accounts: [
        { id: 'acct_hdfc', name: 'HDFC', group_name: 'Bank Accounts' },
        { id: 'acct_cash', name: 'Cash', group_name: 'Cash' }
      ],
      categories: [
        { id: 'cat_inv_chg', name: 'Investment Charges', type: 'Expense' }
      ],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [
        { id: 'uuid-1', name: 'Zerodha', bank_account: 'HDFC' },
        { id: 'uuid-2', name: 'Zerodha', bank_account: 'HDFC' },
        { id: 'uuid-3', name: 'Groww', bank_account: 'Canara' }
      ],
      transactions: [
        {
          id: 'tx_xfer_to_cash',
          date: '01/11/2026',
          account: 'HDFC',
          from_account: 'HDFC',
          to_account: 'Cash',
          category: 'Cash',
          inr: 1000,
          type: 'Transfer-Out'
        }
      ],
      investment_transactions: [
        {
          id: 'inv_charge_1',
          date: '01/11/2026',
          account: 'HDFC',
          category: 'Investment Charges',
          investment_account: 'Investment Charges',
          brokerage: 'Zerodha',
          inr: 20,
          type: 'Expense'
        }
      ]
    };

    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    const result = await verifyReconciledDataIntegrity(db, {
      snapshot_id: 'snap_v17_combined',
      cloud_version: 17,
      entities,
      _expectedBrokerageNames: ['zerodha', 'groww']
    });

    assert.ok(result.verified);
    assert.equal(result.actualCounts.transactions, 1);
    assert.equal(result.actualCounts.investment_transactions, 1);
    assert.equal(result.actualCounts.brokerages, 2);
  });
});

