import 'fake-indexeddb/auto';
import assert from 'assert';
import {
  previewCloudSync,
  reconcile3Way,
  CONFLICT_TYPES,
  canonicalizeEntity,
  SNAPSHOT_FILENAME
} from '../services/cloudSyncEngine.js';
import { rowToTxn } from '../database/transactions.js';
import { unlockSyncSession, lockSyncSession } from '../services/syncSession.js';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import { setSetting, getSetting } from '../database/settings.js';

class MockDriveTransport {
  constructor() {
    this.files = new Map();
  }

  async findAppDataFile(name, accessToken) {
    for (const [id, f] of this.files.entries()) {
      if (f.name === name) return { id, name: f.name, version: f.version };
    }
    return null;
  }

  async readAppDataFile(fileId, accessToken) {
    const f = this.files.get(fileId);
    if (!f) throw new Error('File not found in mock drive');
    return f.content;
  }

  async uploadAppDataFile(name, content, mimeType, accessToken) {
    const id = `mock_drive_file_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    this.files.set(id, { name, content, version: 1 });
    return { id, name };
  }
}

async function runPhase6C2Tests() {
  console.log('================================================================');
  console.log('PHASE 6C.2: PREVIEW SYNC IDENTITY INTEGRATION TEST SUITE');
  console.log('================================================================\n');

  const testPin = '9999';
  const testToken = 'mock_oauth_token';

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1: End-to-End Preview Sync with Full 1,549 + 67 Historical Identity Match
  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 1: Full Scale Dry-Run Preview with Base Manifest & Historical IDs ---');

  // Build local entities and cloud snapshot payload
  const localTxns = [];
  const cloudTxns = [];
  const baseManifest = {};

  // 26,554 Common Exact-ID
  for (let i = 0; i < 26554; i++) {
    const id = `txn_comm_${i}`;
    const raw = {
      id,
      date: '15/05/2024',
      amount: '500',
      inr: 500,
      type: 'Expense',
      account: 'HDFC Savings',
      category: 'Food',
      description: `Common Txn ${i}`,
      note: ''
    };
    const item = rowToTxn(raw);
    localTxns.push(item);
    cloudTxns.push(item);
    baseManifest[id] = { type: 'transactions', canonical: canonicalizeEntity(item, 'transactions') };
  }

  // 1,549 Historical Transactions with Disjoint IDs
  for (let i = 0; i < 1549; i++) {
    const localId = `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`;
    const cloudId = `txn_${1704067200000 + i * 86400000}_${String(i).padStart(6, '0')}`;
    const date = `01/${String((i % 12) + 1).padStart(2, '0')}/2023`;
    const amt = String(500 + i);

    const localRaw = {
      id: localId,
      date,
      amount: amt,
      inr: amt,
      type: 'Expense',
      account: 'HDFC Savings',
      category: 'Shopping',
      description: `Historical Txn ${i}`,
      note: ''
    };
    const cloudRaw = {
      id: cloudId,
      date,
      amount: amt,
      inr: amt,
      type: 'Expense',
      account: 'HDFC Savings',
      category: 'Shopping',
      description: `Historical Txn ${i}`,
      note: ''
    };
    const localItem = rowToTxn(localRaw);
    const cloudItem = rowToTxn(cloudRaw);

    localTxns.push(localItem);
    cloudTxns.push(cloudItem);

    // Device A's base manifest might contain the localId
    baseManifest[localId] = { type: 'transactions', canonical: canonicalizeEntity(localItem, 'transactions') };
  }

  // 24 Genuine Local-Only New Transactions
  for (let i = 0; i < 24; i++) {
    localTxns.push(rowToTxn({
      id: `txn_loc_new_${i}`,
      date: '25/09/2026',
      amount: '150',
      inr: 150,
      type: 'Expense',
      account: 'Cash',
      category: 'Food',
      description: `Recent purchase ${i}`,
      note: ''
    }));
  }

  // 830 Common Exact-ID Investment Transactions
  const localInvTxns = [];
  const cloudInvTxns = [];
  for (let i = 0; i < 830; i++) {
    const id = `inv_comm_${i}`;
    const raw = {
      id,
      date: '10/06/2024',
      security_symbol: `STOCK_${i % 50}`,
      quantity: 10,
      unit_price: 100,
      trade_value: 1000,
      cost_basis: 1000,
      investment_transaction_type: 'BUY',
      source: 'zerodha',
      brokerage: 'Zerodha'
    };
    const item = rowToTxn(raw);
    localInvTxns.push(item);
    cloudInvTxns.push(item);
    baseManifest[id] = { type: 'investment_transactions', canonical: canonicalizeEntity(item, 'investment_transactions') };
  }

  // 67 Historical Investment Transactions
  for (let i = 0; i < 67; i++) {
    const localId = `inv-uuid-${String(i).padStart(8, '0')}`;
    const cloudId = `inv_hist_trade_${String(i).padStart(6, '0')}`;
    const date = `15/${String((i % 12) + 1).padStart(2, '0')}/2023`;
    const localRaw = {
      id: localId,
      date,
      security_symbol: `MF_${i}`,
      quantity: 100,
      unit_price: 20,
      trade_value: 2000,
      cost_basis: 2000,
      investment_transaction_type: 'BUY',
      source: 'etmoney',
      brokerage: 'ETMoney'
    };
    const cloudRaw = {
      id: cloudId,
      date,
      security_symbol: `MF_${i}`,
      quantity: 100,
      unit_price: 20,
      trade_value: 2000,
      cost_basis: 2000,
      investment_transaction_type: 'BUY',
      source: 'etmoney',
      brokerage: 'ETMoney'
    };
    const localItem = rowToTxn(localRaw);
    const cloudItem = rowToTxn(cloudRaw);

    localInvTxns.push(localItem);
    cloudInvTxns.push(cloudItem);
    baseManifest[localId] = { type: 'investment_transactions', canonical: canonicalizeEntity(localItem, 'investment_transactions') };
  }

  // 113 Legitimate Updates on Cloud side
  for (let i = 0; i < 113; i++) {
    cloudTxns[i] = {
      ...cloudTxns[i],
      Description: `${cloudTxns[i].Description} (Updated from cloud)`
    };
  }

  // Settings Conflict (fontSize: local 1.1 vs cloud 1.3)
  baseManifest['setting:fontSize'] = { type: 'setting', canonical: 'fontSize:1.0' };
  const localSettings = { fontSize: '1.1', theme: 'dark' };
  const cloudSettings = { fontSize: '1.3', theme: 'dark' };

  // Inspect canonical strings
  const testLocalCanonical = canonicalizeEntity(localTxns[0], 'transactions');
  const testCloudCanonical = canonicalizeEntity(cloudTxns[0], 'transactions');
  const testBaseCanonical = baseManifest['txn_comm_0']?.canonical;
  console.log('Local Canonical:', testLocalCanonical);
  console.log('Cloud Canonical:', testCloudCanonical);
  console.log('Base  Canonical:', testBaseCanonical);
  console.log('Local === Base ?', testLocalCanonical === testBaseCanonical);
  console.log('Cloud === Base ?', testCloudCanonical === testBaseCanonical);
  const mockDb = {
    query: async (sql, params = []) => {
      if (sql.includes('FROM transactions')) {
        return {
          values: localTxns.map(t => ({
            id: t.id,
            date: t.Date,
            amount: t.Amount,
            inr: t.INR,
            type: t.type || t['Income/Expense'],
            account: t.Account,
            category: t.Category,
            description: t.Description,
            note: t.Note || ''
          }))
        };
      }
      if (sql.includes('FROM investment_transactions')) {
        return {
          values: localInvTxns.map(t => ({
            id: t.id,
            date: t.Date,
            security_symbol: t.SecuritySymbol,
            quantity: t.Quantity,
            unit_price: t.UnitPrice,
            trade_value: t.TradeValue,
            cost_basis: t.CostBasis || t.TradeValue,
            investment_transaction_type: t.InvestmentTransactionType,
            source: t.Source || '',
            brokerage: t.Brokerage || ''
          }))
        };
      }
      if (sql.includes('FROM settings')) {
        const rows = [
          { key: 'fontSize', value: localSettings.fontSize },
          { key: 'theme', value: localSettings.theme },
          { key: 'sync_base_manifest', value: JSON.stringify(baseManifest) }
        ];
        if (sql.includes('WHERE key=?') && params.length > 0) {
          return { values: rows.filter(r => r.key === params[0]) };
        }
        return { values: rows };
      }
      return { values: [] };
    }
  };

  const cloudPayload = {
    schema_version: 13,
    snapshot_id: 'snap_1790234303785_wiv4d1',
    cloud_version: 2,
    device_id: 'device_b',
    created_at: new Date().toISOString(),
    entities: {
      transactions: cloudTxns,
      investment_transactions: cloudInvTxns,
      settings: cloudSettings
    }
  };

  const mockDrive = new MockDriveTransport();
  const encryptedSnapshot = await encryptBackupData(cloudPayload, testPin);
  await mockDrive.uploadAppDataFile(SNAPSHOT_FILENAME, encryptedSnapshot, 'application/octet-stream', testToken);

  // Unlock session
  await unlockSyncSession(testPin);

  // Execute previewCloudSync
  const preview = await previewCloudSync({
    accessToken: testToken,
    dbInstance: mockDb,
    driveClient: mockDrive
  });

  console.log('\n--- PREVIEW SYNC OUTPUT SUMMARY ---');
  console.log('Action:', preview.action);
  console.log('Safety Status:', preview.safetyStatus);
  console.log('Planned Local Changes:', preview.plannedLocalChanges);
  console.log('Planned Cloud Changes:', preview.plannedCloudChanges);
  console.log('Conflicts Detected:', preview.conflicts.length);
  console.log('Diagnostic Time:', preview.diagnostics.totalMs, 'ms');

  // Strict Assertions
  assert.strictEqual(preview.plannedLocalChanges.inserts, 0, 'Planned Local Inserts must be exactly 0');
  assert.strictEqual(preview.plannedLocalChanges.updates, 113, 'Planned Local Updates must be 113 legitimate updates');
  assert.strictEqual(preview.plannedLocalChanges.deletes, 0, 'Planned Local Deletes must be 0');

  assert.strictEqual(preview.plannedCloudChanges.inserts, 24, 'Planned Cloud Inserts must be exactly 24 genuine new transactions');
  assert.strictEqual(preview.plannedCloudChanges.updates, 0, 'Planned Cloud Updates must be 0');
  assert.strictEqual(preview.plannedCloudChanges.deletes, 0, 'Planned Cloud Deletes must be 0');

  assert.strictEqual(preview.conflicts.length, 1, 'Exactly 1 conflict for fontSize setting');
  assert.strictEqual(preview.conflicts[0].type, CONFLICT_TYPES.SETTINGS_CONFLICT, 'Conflict is SETTINGS_CONFLICT');
  assert.strictEqual(preview.conflicts[0].entityId, 'setting:fontSize', 'Conflict is setting:fontSize');

  assert.strictEqual(preview.databaseMutations, 0, 'Preview produces zero DB mutations');
  assert.strictEqual(preview.driveWrites, 0, 'Preview produces zero Drive writes');

  console.log('✅ PASS: TEST 1: Full scale dry-run preview with base manifest and historical IDs produces 0 duplicate inserts');

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2: Canonical Reconcile3Way vs Preview Sync Invariant
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 2: Preview Counts Match Direct reconcile3Way Counts ---');

  const directPlan = await reconcile3Way({
    baseManifest,
    localEntities: {
      transactions: localTxns,
      investment_transactions: localInvTxns,
      settings: localSettings
    },
    cloudEntities: {
      transactions: cloudTxns,
      investment_transactions: cloudInvTxns,
      settings: cloudSettings
    }
  });

  assert.strictEqual(preview.plannedLocalChanges.inserts, directPlan.plannedLocalInserts.length, 'Local inserts match');
  assert.strictEqual(preview.plannedCloudChanges.inserts, directPlan.plannedCloudInserts.length, 'Cloud inserts match');
  assert.strictEqual(directPlan.duplicateInsertsPrevented, 1549 + 67, '1,616 duplicate inserts prevented');

  console.log('✅ PASS: TEST 2: Direct reconcile3Way and previewCloudSync produce 100% identical insert counts');

  console.log('\n================================================================');
  console.log('PHASE 6C.2 TEST SUITE: ALL TESTS PASSED (100%)');
  console.log('================================================================\n');
}

runPhase6C2Tests().catch(err => {
  console.error('Phase 6C.2 Test Failure:', err);
  process.exit(1);
});
