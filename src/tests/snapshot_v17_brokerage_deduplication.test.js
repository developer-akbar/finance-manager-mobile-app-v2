/**
 * snapshot_v17_brokerage_deduplication.test.js
 *
 * Mandatory Regression Test Suite for Snapshot v17 Brokerage Duplication Fix:
 * Scenario A: Importing 32 duplicate brokerage records results in exactly two canonical records on Android SQLite.
 * Scenario B: Importing the same snapshot results in exactly two canonical records in browser IndexedDB.
 * Scenario C: Existing random UUID records migrate idempotently to canonical identities.
 * Scenario D: Replaying old brokerage delta events cannot recreate duplicate records.
 * Scenario E: Conflicting metadata causes a safe, descriptive failure.
 * Scenario F: Missing Groww identity fails integrity validation.
 * Scenario G: Unexpected brokerage identity fails integrity validation.
 * Scenario H: Repeated snapshot imports do not create additional brokerage records.
 * Scenario I: Existing transaction and investment transaction counts and values remain unchanged.
 * Scenario J: Connected Devices does not display a remote upgrade action on peer device cards.
 */

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initDB,
  closeDB,
  getCanonicalBrokerageId,
  migrateExistingBrokerages
} from '../database/db.js';
import {
  populateLocalEntitiesBootstrap,
  applyLocalEntityInsertOrUpdate,
  createCanonicalSnapshotPayload,
  getManifestEntityKey,
  canonicalizeEntity
} from '../services/cloudSyncEngine.js';
import {
  verifyReconciledDataIntegrity
} from '../services/snapshotDeviceImport.js';

// Helper to generate 32 duplicate brokerage fixtures matching Snapshot v17
function create32DuplicateBrokeragesFixture() {
  const brokerages = [];
  for (let i = 1; i <= 16; i++) {
    brokerages.push({
      id: `uuid-zerodha-${i.toString().padStart(3, '0')}`,
      name: 'Zerodha',
      bank_account: 'HDFC',
      owner: 'Akbar'
    });
  }
  for (let i = 1; i <= 16; i++) {
    brokerages.push({
      id: `uuid-groww-${i.toString().padStart(3, '0')}`,
      name: 'Groww',
      bank_account: 'Canara',
      owner: 'Fareeda'
    });
  }
  return brokerages;
}

test('FinMan Phase 14 — Snapshot v17 Brokerage Deduplication & Regression Suite', async (t) => {
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
    await db.run('DELETE FROM settings;').catch(() => {});
  });

  t.afterEach(async () => {
    closeDB();
  });

  await t.test('Scenario A: Importing 32 duplicate brokerage records results in exactly two canonical records (Simulated SQLite ATTACH Promotion)', async () => {
    // Staging entities with 32 duplicates
    const stagingEntities = {
      transactions: [],
      investment_transactions: [],
      accounts: [],
      categories: [],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: create32DuplicateBrokeragesFixture()
    };

    assert.equal(stagingEntities.brokerages.length, 32);

    // Promote staging snapshot
    const promoteResult = await db.promoteStagingSnapshot({ entities: stagingEntities });
    assert.ok(promoteResult.success);

    // Verify main database has exactly 2 records
    const res = await db.query('SELECT * FROM brokerages ORDER BY id ASC;');
    const rows = res.values || [];
    assert.equal(rows.length, 2, 'Must contain exactly 2 canonical brokerage rows');

    const zerodha = rows.find(r => r.id === 'brk_zerodha');
    assert.ok(zerodha, 'brk_zerodha must exist');
    assert.equal(zerodha.name, 'Zerodha');
    assert.equal(zerodha.bank_account, 'HDFC');
    assert.equal(zerodha.owner, 'Akbar');

    const groww = rows.find(r => r.id === 'brk_groww');
    assert.ok(groww, 'brk_groww must exist');
    assert.equal(groww.name, 'Groww');
    assert.equal(groww.bank_account, 'Canara');
    assert.equal(groww.owner, 'Fareeda');

    // Run integrity check
    const verifyRes = await verifyReconciledDataIntegrity(db, {
      entities: stagingEntities,
      _expectedBrokerageNames: ['zerodha', 'groww']
    });
    assert.ok(verifyRes);
    assert.equal(verifyRes.actualCounts.brokerages, 2);
  });

  await t.test('Scenario B: Importing the same snapshot results in exactly two canonical records in browser IndexedDB', async () => {
    const raw32 = create32DuplicateBrokeragesFixture();
    const entities = {
      transactions: [],
      investment_transactions: [],
      accounts: [],
      categories: [],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: raw32
    };

    // Populate using bootstrap engine
    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });

    const res = await db.query('SELECT * FROM brokerages ORDER BY id ASC;');
    const rows = res.values || [];
    assert.equal(rows.length, 2, 'IndexedDB must contain exactly 2 deduplicated records');
    assert.deepEqual(
      rows.map(r => ({ id: r.id, name: r.name, bank: r.bank_account, owner: r.owner })),
      [
        { id: 'brk_groww', name: 'Groww', bank: 'Canara', owner: 'Fareeda' },
        { id: 'brk_zerodha', name: 'Zerodha', bank: 'HDFC', owner: 'Akbar' }
      ]
    );

    const verifyRes = await verifyReconciledDataIntegrity(db, { entities });
    assert.ok(verifyRes);
    assert.equal(verifyRes.actualCounts.brokerages, 2);
  });

  await t.test('Scenario C: Existing random UUID records migrate idempotently to canonical identities', async () => {
    // Seed database with legacy random UUIDs
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'f8ed06d9-1fa0-4a11-82f5-fa1899d7380e',
      'Zerodha',
      'HDFC',
      'Akbar'
    ]);
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'duplicate-uuid-zerodha',
      'Zerodha',
      'HDFC',
      'Akbar'
    ]);
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'f5278759-f4bc-4eb9-9e49-142aaefe26cf',
      'Groww',
      'Canara',
      'Fareeda'
    ]);

    const initial = await db.query('SELECT * FROM brokerages;');
    assert.equal(initial.values.length, 3);

    // Run migration
    await migrateExistingBrokerages(db);

    const postMigrate = await db.query('SELECT * FROM brokerages ORDER BY id ASC;');
    const rows = postMigrate.values || [];
    assert.equal(rows.length, 2, 'Legacy random UUIDs must collapse to 2 canonical rows');
    assert.equal(rows[0].id, 'brk_groww');
    assert.equal(rows[1].id, 'brk_zerodha');

    // Run migration again to prove idempotency
    await migrateExistingBrokerages(db);
    const postIdempotent = await db.query('SELECT * FROM brokerages ORDER BY id ASC;');
    assert.equal(postIdempotent.values.length, 2);
    assert.equal(postIdempotent.values[0].id, 'brk_groww');
    assert.equal(postIdempotent.values[1].id, 'brk_zerodha');
  });

  await t.test('Scenario D: Replaying old brokerage delta events cannot recreate duplicate records', async () => {
    // Current database has canonical records
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'brk_zerodha',
      'Zerodha',
      'HDFC',
      'Akbar'
    ]);
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'brk_groww',
      'Groww',
      'Canara',
      'Fareeda'
    ]);

    // Replay old delta event carrying an old random UUID
    const oldDeltaItem = {
      id: 'legacy-uuid-from-2025-zerodha',
      name: 'Zerodha',
      bank_account: 'HDFC',
      owner: 'Akbar'
    };

    await applyLocalEntityInsertOrUpdate(db, oldDeltaItem, 'brokerages');

    const res = await db.query('SELECT * FROM brokerages ORDER BY id ASC;');
    const rows = res.values || [];
    assert.equal(rows.length, 2, 'Replaying old delta event must not create a duplicate row');
    assert.equal(rows.find(r => r.name === 'Zerodha')?.id, 'brk_zerodha');
    assert.equal(rows.find(r => r.id === 'legacy-uuid-from-2025-zerodha'), undefined);
  });

  await t.test('Scenario E: Conflicting metadata causes a safe, descriptive failure', async () => {
    // Incompatible bank_account on Zerodha
    const conflictingEntities = {
      transactions: [],
      investment_transactions: [],
      accounts: [],
      categories: [],
      subcategories: [],
      brokerages: [
        { id: 'b1', name: 'Zerodha', bank_account: 'HDFC', owner: 'Akbar' },
        { id: 'b2', name: 'Zerodha', bank_account: 'State Bank of India', owner: 'Akbar' }
      ]
    };

    await assert.rejects(
      async () => {
        await populateLocalEntitiesBootstrap(db, conflictingEntities);
      },
      (err) => {
        assert.ok(err.message.includes('Conflicting bank_account for brokerage "Zerodha"'));
        return true;
      },
      'Conflicting bank account metadata must fail closed'
    );

    // Incompatible owner on Groww in delta sync
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'brk_groww',
      'Groww',
      'Canara',
      'Fareeda'
    ]);

    await assert.rejects(
      async () => {
        await applyLocalEntityInsertOrUpdate(
          db,
          { id: 'b_conflict', name: 'Groww', bank_account: 'Canara', owner: 'SomeoneElse' },
          'brokerages'
        );
      },
      (err) => {
        assert.ok(err.message.includes('Conflicting owner for brokerage "Groww"'));
        return true;
      },
      'Conflicting owner metadata in delta sync must fail closed'
    );
  });

  await t.test('Scenario F: Missing Groww identity fails integrity validation', async () => {
    // Database only has Zerodha
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'brk_zerodha',
      'Zerodha',
      'HDFC',
      'Akbar'
    ]);

    const cloudPayload = {
      entities: {
        transactions: [],
        investment_transactions: [],
        accounts: [],
        categories: [],
        subcategories: [],
        brokerages: [
          { id: 'b1', name: 'Zerodha' },
          { id: 'b2', name: 'Groww' }
        ]
      }
    };

    await assert.rejects(
      async () => {
        await verifyReconciledDataIntegrity(db, cloudPayload);
      },
      (err) => {
        assert.ok(
          err.message.includes('missing expected brokerage identity "groww"') ||
          err.message.includes('count mismatch for brokerages')
        );
        return true;
      },
      'Missing Groww identity must fail closed'
    );
  });

  await t.test('Scenario G: Unexpected brokerage identity fails integrity validation', async () => {
    // Database has Zerodha, Groww, plus an unexpected AngelOne
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'brk_zerodha',
      'Zerodha',
      'HDFC',
      'Akbar'
    ]);
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'brk_groww',
      'Groww',
      'Canara',
      'Fareeda'
    ]);
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'brk_angelone',
      'AngelOne',
      'ICICI',
      'Akbar'
    ]);

    // Snapshot only expected Zerodha and Groww
    const cloudPayload = {
      entities: {
        transactions: [],
        investment_transactions: [],
        accounts: [],
        categories: [],
        subcategories: [],
        brokerages: [
          { id: 'b1', name: 'Zerodha' },
          { id: 'b2', name: 'Groww' }
        ]
      }
    };

    await assert.rejects(
      async () => {
        await verifyReconciledDataIntegrity(db, cloudPayload);
      },
      (err) => {
        assert.ok(
          err.message.includes('unexpected brokerage identity "angelone"') ||
          err.message.includes('count mismatch for brokerages')
        );
        return true;
      },
      'Unexpected brokerage identity must fail closed'
    );
  });

  await t.test('Scenario H: Repeated snapshot imports do not create additional brokerage records', async () => {
    const raw32 = create32DuplicateBrokeragesFixture();
    const entities = {
      transactions: [],
      investment_transactions: [],
      accounts: [],
      categories: [],
      subcategories: [],
      brokerages: raw32
    };

    // Pass 1
    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });
    let res = await db.query('SELECT count(*) as count FROM brokerages;');
    assert.equal(res.values[0].count, 2);

    // Pass 2
    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });
    res = await db.query('SELECT count(*) as count FROM brokerages;');
    assert.equal(res.values[0].count, 2);

    // Pass 3
    await populateLocalEntitiesBootstrap(db, entities, { allowRecoveryReplacement: true });
    res = await db.query('SELECT count(*) as count FROM brokerages;');
    assert.equal(res.values[0].count, 2);
  });

  await t.test('Scenario I: Existing transaction and investment transaction counts and values remain unchanged', async () => {
    const existingTx = [
      { id: 'tx_101', date: '30/10/2026', amount: '5000', inr: 5000, type: 'Expense', description: 'Grocery shopping', account: 'Cash' }
    ];
    const existingInv = [
      { id: 'inv_201', date: '30/10/2026', amount: '10000', inr: 10000, type: 'BUY', brokerage: 'Zerodha', security_symbol: 'INFY', quantity: 7, unit_price: 1428.57, account: 'HDFC' },
      { id: 'inv_202', date: '31/10/2026', amount: '25000', inr: 25000, type: 'BUY', brokerage: 'Groww', security_symbol: 'TCS', quantity: 8, unit_price: 3125.00, account: 'Canara' }
    ];

    // Seed transactions and investment transactions into live DB
    await db.run(
      `INSERT INTO transactions (id, date, amount, type, description, account) VALUES (?, ?, ?, ?, ?, ?)`,
      ['tx_101', '30/10/2026', '5000', 'Expense', 'Grocery shopping', 'Cash']
    );
    await db.run(
      `INSERT INTO investment_transactions (id, date, amount, type, brokerage, security_symbol, quantity, unit_price, inr, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['inv_201', '30/10/2026', '10000', 'BUY', 'Zerodha', 'INFY', 7, 1428.57, 10000, 'HDFC']
    );
    await db.run(
      `INSERT INTO investment_transactions (id, date, amount, type, brokerage, security_symbol, quantity, unit_price, inr, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['inv_202', '31/10/2026', '25000', 'BUY', 'Groww', 'TCS', 8, 3125.00, 25000, 'Canara']
    );

    // 1. Run migration for brokerages on live DB
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'uuid-old-z', 'Zerodha', 'HDFC', 'Akbar'
    ]);
    await db.run('INSERT INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)', [
      'uuid-old-g', 'Groww', 'Canara', 'Fareeda'
    ]);

    await migrateExistingBrokerages(db);

    // Verify transactions are 100% untouched
    let txRes = await db.query('SELECT * FROM transactions;');
    assert.equal(txRes.values.length, 1);
    assert.equal(txRes.values[0].id, 'tx_101');
    assert.equal(txRes.values[0].amount, '5000');

    let invRes = await db.query('SELECT * FROM investment_transactions ORDER BY id ASC;');
    assert.equal(invRes.values.length, 2);
    assert.equal(invRes.values[0].id, 'inv_201');
    assert.equal(invRes.values[0].brokerage, 'Zerodha');
    assert.equal(invRes.values[1].id, 'inv_202');
    assert.equal(invRes.values[1].brokerage, 'Groww');

    // 2. Perform snapshot import with 32 duplicate brokerages + the transactions
    const raw32 = create32DuplicateBrokeragesFixture();
    await populateLocalEntitiesBootstrap(db, {
      transactions: existingTx,
      investment_transactions: existingInv,
      brokerages: raw32
    }, { allowRecoveryReplacement: true });

    // Verify transactions and investment transactions counts and values are intact
    txRes = await db.query('SELECT * FROM transactions;');
    assert.equal(txRes.values.length, 1);
    assert.equal(txRes.values[0].id, 'tx_101');
    assert.equal(txRes.values[0].amount, '5000');

    invRes = await db.query('SELECT * FROM investment_transactions ORDER BY id ASC;');
    assert.equal(invRes.values.length, 2);
    assert.equal(invRes.values[0].id, 'inv_201');
    assert.equal(invRes.values[0].brokerage, 'Zerodha');
    assert.equal(invRes.values[1].id, 'inv_202');
    assert.equal(invRes.values[1].brokerage, 'Groww');

    // Verify brokerages collapsed to 2
    const brokRes = await db.query('SELECT * FROM brokerages ORDER BY id ASC;');
    assert.equal(brokRes.values.length, 2);
  });

  await t.test('Scenario J: Connected Devices UI logic does not permit remote upgrade on peer device cards', async () => {
    // Read ConnectedDevicesCard source code to ensure structural compliance
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const fileContent = readFileSync(resolve('src/components/Settings/ConnectedDevicesCard.jsx'), 'utf-8');

    // Assert upgrade button is only guarded by isCurrent
    assert.ok(
      fileContent.includes('isCurrent && isCurrentUpgradeAvailable'),
      'Upgrade action must be conditioned strictly on isCurrent device'
    );

    // Assert upgrade button text says "Upgrade This Device to Snapshot"
    assert.ok(
      fileContent.includes('Upgrade This Device to Snapshot'),
      'Upgrade button must explicitly state "Upgrade This Device"'
    );

    // Assert peer card displays informational message about updating on that device
    assert.ok(
      fileContent.includes('To update this device, open FinMan on'),
      'Peer card must instruct the user to open FinMan on that physical device'
    );

    // Assert peer card has NO upgrade button
    const peerSection = fileContent.substring(fileContent.indexOf('{/* Informational notice & stale removal for peer devices on older baseline */}'));
    assert.ok(
      !peerSection.includes('handleStartUpgrade'),
      'Peer device card section must not contain any upgrade handler or button'
    );
  });
});
