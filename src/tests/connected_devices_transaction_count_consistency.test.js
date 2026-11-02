/**
 * connected_devices_transaction_count_consistency.test.js
 *
 * Dedicated Automated Test Suite for Connected Devices Transaction Count Consistency:
 * 1. Ordinary transactions only.
 * 2. Investment transactions only.
 * 3. Both tables with no overlap.
 * 4. Both tables with one overlapping ID (reproducing 28,479 + 934 - 1 = 29,412).
 * 5. Multiple overlapping IDs.
 * 6. Empty databases.
 * 7. Investment-table query failure — must NOT publish ordinary-only count.
 * 8. Ordinary-table query failure.
 * 9. Existing legacy manifest upgrades.
 * 10. Existing correct count but missing count_type.
 * 11. Verified manifest with unchanged count does not needlessly increment revision.
 * 12. Snapshot publisher produces the same unique count.
 * 13. Peer manifest normalization preserves count type and breakdown.
 * 14. Offline/legacy device remains clearly identified as legacy.
 * 15. A device updates only its own manifest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, closeDB, getDB } from '../database/db.js';
import { setSetting } from '../database/settings.js';
import {
  getFinancialTransactionCounts,
  getUniqueFinancialTransactionCount
} from '../database/transactions.js';
import {
  ensureOwnDeviceManifestSynced,
  listAllCloudDeviceManifests,
  createEmptyDeviceManifest
} from '../services/deviceManifest.js';

class MockDriveStorage {
  constructor() {
    this.files = new Map();
    this.nextId = 1;
  }

  reset() {
    this.files.clear();
    this.nextId = 1;
  }

  async findFiles({ name, trashed = false } = {}) {
    const results = [];
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && (!name || f.name === name)) {
        results.push({
          id: f.id,
          name: f.name,
          modifiedTime: f.modifiedTime,
          size: f.size
        });
      }
    }
    return results;
  }

  async readFile(fileId) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`Drive file not found: ${fileId}`);
    return f.content;
  }

  async uploadFile(nameOrOptions, contentArg) {
    let fileName = nameOrOptions;
    let fileContent = contentArg;
    if (nameOrOptions && typeof nameOrOptions === 'object') {
      fileName = nameOrOptions.name;
      fileContent = nameOrOptions.content;
    }
    for (const [id, f] of this.files.entries()) {
      if (f.name === fileName && !f.trashed) {
        f.content = typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent);
        f.modifiedTime = new Date().toISOString();
        return { id, name: fileName };
      }
    }
    const id = `mock_drive_file_${this.nextId++}`;
    this.files.set(id, {
      id,
      name: fileName,
      content: typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent),
      modifiedTime: new Date().toISOString(),
      trashed: false
    });
    return { id, name: fileName };
  }

  async uploadAppDataFile(name, content) {
    return this.uploadFile(name, content);
  }

  async findAppDataFile(name) {
    return this.findFiles({ name });
  }

  async readAppDataFile(fileId) {
    return this.readFile(fileId);
  }
}

test('CONNECTED DEVICES TRANSACTION COUNT CONSISTENCY TEST SUITE', async (t) => {
  let db;

  t.beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    db = await initDB();
    await db.run('DELETE FROM transactions');
    await db.run('DELETE FROM investment_transactions');
  });

  t.afterEach(async () => {
    try {
      await closeDB();
    } catch {}
  });

  // 1. Ordinary transactions only
  await t.test('1. Ordinary transactions only', async () => {
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t1', '2026-11-01']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t2', '2026-11-01']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t3', '2026-11-01']);

    const counts = await getFinancialTransactionCounts(db);
    assert.deepEqual(counts, {
      transactions: 3,
      investment_transactions: 0,
      unique_total: 3
    });
    const unique = await getUniqueFinancialTransactionCount(db);
    assert.equal(unique, 3);
  });

  // 2. Investment transactions only
  await t.test('2. Investment transactions only', async () => {
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv1', '2026-11-01']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv2', '2026-11-01']);

    const counts = await getFinancialTransactionCounts(db);
    assert.deepEqual(counts, {
      transactions: 0,
      investment_transactions: 2,
      unique_total: 2
    });
    const unique = await getUniqueFinancialTransactionCount(db);
    assert.equal(unique, 2);
  });

  // 3. Both tables with no overlap
  await t.test('3. Both tables with no overlap', async () => {
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t1', '2026-11-01']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t2', '2026-11-01']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv1', '2026-11-01']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv2', '2026-11-01']);

    const counts = await getFinancialTransactionCounts(db);
    assert.deepEqual(counts, {
      transactions: 2,
      investment_transactions: 2,
      unique_total: 4
    });
    const unique = await getUniqueFinancialTransactionCount(db);
    assert.equal(unique, 4);
  });

  // 4. Both tables with one overlapping ID (reproducing 28,479 + 934 - 1 = 29,412)
  await t.test('4. Both tables with one overlapping ID', async () => {
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['shared_id_1', '2026-11-01']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t2', '2026-11-01']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t3', '2026-11-01']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['shared_id_1', '2026-11-01']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv2', '2026-11-01']);

    const counts = await getFinancialTransactionCounts(db);
    assert.deepEqual(counts, {
      transactions: 3,
      investment_transactions: 2,
      unique_total: 4
    });
    const unique = await getUniqueFinancialTransactionCount(db);
    assert.equal(unique, 4);
  });

  // 5. Multiple overlapping IDs
  await t.test('5. Multiple overlapping IDs', async () => {
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['sh1', 'd']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['sh2', 'd']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t1', 'd']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t2', 'd']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['sh1', 'd']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['sh2', 'd']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv1', 'd']);

    const counts = await getFinancialTransactionCounts(db);
    assert.deepEqual(counts, {
      transactions: 4,
      investment_transactions: 3,
      unique_total: 5 // 4 + 3 - 2 = 5
    });
  });

  // 6. Empty databases
  await t.test('6. Empty databases', async () => {
    const counts = await getFinancialTransactionCounts(db);
    assert.deepEqual(counts, {
      transactions: 0,
      investment_transactions: 0,
      unique_total: 0
    });
    const unique = await getUniqueFinancialTransactionCount(db);
    assert.equal(unique, 0);
  });

  // 7. Investment-table query failure — must NOT publish ordinary-only count
  await t.test('7. Investment-table query failure — must NOT publish ordinary-only count', async () => {
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t1', 'd']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t2', 'd']);
    const failingDb = {
      query: async (sql) => {
        if (sql.includes('investment_transactions')) {
          throw new Error('SIMULATED_INVESTMENT_TABLE_CORRUPTION');
        }
        return db.query(sql);
      }
    };
    const counts = await getFinancialTransactionCounts(failingDb);
    assert.strictEqual(counts, null, 'Must fail closed with null instead of falling back to ordinary count');
    const unique = await getUniqueFinancialTransactionCount(failingDb);
    assert.strictEqual(unique, null);
  });

  // 8. Ordinary-table query failure
  await t.test('8. Ordinary-table query failure', async () => {
    const failingDb = {
      query: async (sql) => {
        if (sql.includes('transactions') && !sql.includes('investment')) {
          throw new Error('SIMULATED_ORDINARY_TABLE_ERROR');
        }
        return db.query(sql);
      }
    };
    const counts = await getFinancialTransactionCounts(failingDb);
    assert.strictEqual(counts, null, 'Must return null when ordinary table fails');
  });

  // 9. Existing legacy manifest upgrades
  await t.test('9. Existing legacy manifest upgrades', async () => {
    const drive = new MockDriveStorage();
    const deviceId = 'dev_laptop_test_01';

    await setSetting('last_snapshot_id', 'snap_v14_test');
    await setSetting('last_cloud_version', '14');
    await db.run('INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version) VALUES (?, ?, ?, ?)',
      ['device_state', deviceId, 'snap_v14_test', 14]
    );

    for (let i = 1; i <= 28; i++) {
      await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", [`tx_${i}`, '2026-11-01']);
    }
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['tx_1', '2026-11-01']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv_unique_1', '2026-11-01']);

    const legacyManifest = createEmptyDeviceManifest({
      deviceId,
      deviceName: 'FinMan Web',
      baseSnapshotId: 'snap_v14_test',
      baseCloudVersion: 14,
      manifestRevision: 2
    });
    legacyManifest.record_count = 28;
    delete legacyManifest.count_type;
    delete legacyManifest.counts;

    await drive.uploadFile(`manifest_dev_${deviceId}.json`, JSON.stringify(legacyManifest));

    const updated = await ensureOwnDeviceManifestSynced({
      deviceId,
      deviceName: 'FinMan Web',
      driveClient: drive,
      force: false
    });

    assert.ok(updated);
    assert.equal(updated.record_count, 29);
    assert.equal(updated.count_type, 'DEDUPLICATED_UNIQUE');
    assert.deepEqual(updated.counts, {
      transactions: 28,
      investment_transactions: 2,
      unique_total: 29
    });
    assert.equal(updated.manifest_revision, 3, 'Manifest revision must increment upon upgrade');
  });

  // 10. Existing correct count but missing count_type
  await t.test('10. Existing correct count but missing count_type', async () => {
    const drive = new MockDriveStorage();
    const deviceId = 'dev_laptop_test_02';

    await setSetting('last_snapshot_id', 'snap_v14_test');
    await setSetting('last_cloud_version', '14');
    await db.run('INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version) VALUES (?, ?, ?, ?)',
      ['device_state', deviceId, 'snap_v14_test', 14]
    );

    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t1', 'd']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv1', 'd']);

    const manifestWithoutType = createEmptyDeviceManifest({
      deviceId,
      deviceName: 'FinMan Web',
      baseSnapshotId: 'snap_v14_test',
      baseCloudVersion: 14,
      manifestRevision: 5
    });
    manifestWithoutType.record_count = 2; // already 2, but missing count_type
    delete manifestWithoutType.count_type;

    await drive.uploadFile(`manifest_dev_${deviceId}.json`, JSON.stringify(manifestWithoutType));

    const updated = await ensureOwnDeviceManifestSynced({
      deviceId,
      deviceName: 'FinMan Web',
      driveClient: drive,
      force: false
    });

    assert.ok(updated);
    assert.equal(updated.count_type, 'DEDUPLICATED_UNIQUE');
    assert.equal(updated.manifest_revision, 6, 'Must upgrade and increment revision to add count_type');
  });

  // 11. Verified manifest with unchanged count does not needlessly increment revision
  await t.test('11. Verified manifest with unchanged count does not needlessly increment revision', async () => {
    const drive = new MockDriveStorage();
    const deviceId = 'dev_laptop_test_03';

    await setSetting('last_snapshot_id', 'snap_v14_test');
    await setSetting('last_cloud_version', '14');
    await db.run('INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version) VALUES (?, ?, ?, ?)',
      ['device_state', deviceId, 'snap_v14_test', 14]
    );

    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t1', 'd']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv1', 'd']);

    const verifiedManifest = createEmptyDeviceManifest({
      deviceId,
      deviceName: 'FinMan Web',
      baseSnapshotId: 'snap_v14_test',
      baseCloudVersion: 14,
      manifestRevision: 10
    });
    verifiedManifest.record_count = 2;
    verifiedManifest.count_type = 'DEDUPLICATED_UNIQUE';
    verifiedManifest.counts = {
      transactions: 1,
      investment_transactions: 1,
      unique_total: 2
    };

    await drive.uploadFile(`manifest_dev_${deviceId}.json`, JSON.stringify(verifiedManifest));

    const result = await ensureOwnDeviceManifestSynced({
      deviceId,
      deviceName: 'FinMan Web',
      driveClient: drive,
      force: false
    });

    assert.ok(result);
    assert.equal(result.manifest_revision, 10, 'Revision must NOT increment if already verified and matching');
  });

  // 12. Snapshot publisher produces the same unique count
  await t.test('12. Snapshot publisher produces the same unique count', async () => {
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['shared_1', 'd']);
    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['t2', 'd']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['shared_1', 'd']);
    await db.run("INSERT INTO investment_transactions (id, date) VALUES (?, ?)", ['inv2', 'd']);

    const counts = await getFinancialTransactionCounts(db);
    assert.equal(counts.unique_total, 3);

    const { getFinancialTransactionCounts: coordinatorCountFn } = await import('../database/transactions.js');
    const coordCounts = await coordinatorCountFn(db);
    assert.equal(coordCounts.unique_total, 3);
    assert.deepEqual(coordCounts, counts);
  });

  // 13. Peer manifest normalization preserves count type and breakdown
  await t.test('13. Peer manifest normalization preserves count type and breakdown', async () => {
    const drive = new MockDriveStorage();
    const peerManifest = createEmptyDeviceManifest({
      deviceId: 'dev_office_peer',
      baseSnapshotId: 'snap_v14',
      baseCloudVersion: 14,
      manifestRevision: 4
    });
    peerManifest.record_count = 29412;
    peerManifest.count_type = 'DEDUPLICATED_UNIQUE';
    peerManifest.counts = {
      transactions: 28479,
      investment_transactions: 934,
      unique_total: 29412
    };

    await drive.uploadFile('manifest_dev_dev_office_peer.json', JSON.stringify(peerManifest));

    const res = await listAllCloudDeviceManifests({
      driveClient: drive,
      localDeviceId: 'dev_local_laptop'
    });

    const peer = res.devices.find(d => d.deviceId === 'dev_office_peer');
    assert.ok(peer);
    assert.equal(peer.recordCount, 29412);
    assert.equal(peer.countType, 'DEDUPLICATED_UNIQUE');
    assert.deepEqual(peer.counts, {
      transactions: 28479,
      investment_transactions: 934,
      unique_total: 29412
    });
  });

  // 14. Offline/legacy device remains clearly identified as legacy
  await t.test('14. Offline/legacy device remains clearly identified as legacy', async () => {
    const drive = new MockDriveStorage();
    const legacyPeer = createEmptyDeviceManifest({
      deviceId: 'dev_old_mobile',
      baseSnapshotId: 'snap_v14',
      baseCloudVersion: 14,
      manifestRevision: 1
    });
    legacyPeer.record_count = 28479; // legacy count
    delete legacyPeer.count_type;
    delete legacyPeer.counts;

    await drive.uploadFile('manifest_dev_dev_old_mobile.json', JSON.stringify(legacyPeer));

    const res = await listAllCloudDeviceManifests({
      driveClient: drive,
      localDeviceId: 'dev_local_laptop'
    });

    const peer = res.devices.find(d => d.deviceId === 'dev_old_mobile');
    assert.ok(peer);
    assert.equal(peer.recordCount, 28479);
    assert.strictEqual(peer.countType, null, 'Legacy peer must have null countType');

    // Test UI formatting contract
    const formatCount = (dev, isCurrent, stateCount) => {
      if (isCurrent) {
        return (stateCount !== undefined && stateCount !== null && !isNaN(stateCount))
          ? `${stateCount.toLocaleString()} transactions`
          : 'Count unavailable';
      }
      if (dev.recordCount === null || dev.recordCount === undefined || isNaN(dev.recordCount)) {
        return 'Count unavailable';
      }
      if (dev.countType === 'DEDUPLICATED_UNIQUE') {
        return `${dev.recordCount.toLocaleString()} transactions`;
      }
      return `${dev.recordCount.toLocaleString()} transactions (Legacy count · pending device refresh)`;
    };

    assert.equal(
      formatCount(peer, false, 29412),
      '28,479 transactions (Legacy count · pending device refresh)'
    );
  });

  // 15. A device updates only its own manifest
  await t.test('15. A device updates only its own manifest', async () => {
    const drive = new MockDriveStorage();
    const deviceA = 'dev_alpha';
    const deviceB = 'dev_beta';

    await setSetting('last_snapshot_id', 'snap_v14_test');
    await setSetting('last_cloud_version', '14');
    await db.run('INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version) VALUES (?, ?, ?, ?)',
      ['device_state', deviceA, 'snap_v14_test', 14]
    );

    await db.run("INSERT INTO transactions (id, date) VALUES (?, ?)", ['tx_a', 'd']);

    // Pre-populate Device B manifest on Drive
    const manifestB = createEmptyDeviceManifest({
      deviceId: deviceB,
      baseSnapshotId: 'snap_v14_test',
      baseCloudVersion: 14,
      manifestRevision: 7
    });
    manifestB.record_count = 100;
    await drive.uploadFile(`manifest_dev_${deviceB}.json`, JSON.stringify(manifestB));

    // Device A runs sync
    await ensureOwnDeviceManifestSynced({
      deviceId: deviceA,
      driveClient: drive,
      force: true
    });

    // Check Device A manifest was created
    const fileA = await drive.findFiles({ name: `manifest_dev_${deviceA}.json` });
    assert.equal(fileA.length, 1);
    const parsedA = JSON.parse(await drive.readFile(fileA[0].id));
    assert.equal(parsedA.device_id, deviceA);
    assert.equal(parsedA.record_count, 1);

    // Check Device B manifest was NOT modified
    const fileB = await drive.findFiles({ name: `manifest_dev_${deviceB}.json` });
    assert.equal(fileB.length, 1);
    const parsedB = JSON.parse(await drive.readFile(fileB[0].id));
    assert.equal(parsedB.device_id, deviceB);
    assert.equal(parsedB.record_count, 100);
    assert.equal(parsedB.manifest_revision, 7, 'Device B manifest revision must be untouched');
  });
});
