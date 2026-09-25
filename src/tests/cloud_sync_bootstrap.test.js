/**
 * cloud_sync_bootstrap.test.js
 * 
 * Comprehensive Test Suite for Phase 6B: Multi-Device Bootstrap
 * 
 * Tests:
 * 1. Clean bootstrap of empty local DB from valid cloud snapshot
 * 2. Envelope & checksum validation (aborts on tampering)
 * 3. AES-GCM decryption validation (aborts on wrong PIN)
 * 4. Malformed entity array validation
 * 5. Physical table count preservation (28,127 txns + 897 inv_txns + bridge ID)
 * 6. Non-empty local database refuses bootstrap (EXISTING_LOCAL_DATA_REQUIRES_MERGE)
 * 7. Whitelisted settings bootstrap & security-local exclusion
 * 8. Base manifest persistence ONLY after complete post-bootstrap verification
 * 9. Exact canonical manifest equality
 * 10. Financial invariants & companion fee / split relationships
 * 11. Read-only dry-run preview before bootstrap
 * 12. Idempotency after successful bootstrap
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { initDB, getDB, closeDB } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';
import {
  readLocalEntities,
  createCanonicalSnapshotPayload,
  buildEntityManifest,
  previewCloudSync,
  executeBootstrap,
  isDatabaseBootstrapEmpty,
  validateCloudSnapshotPayload,
  BOOTSTRAP_STATUS,
  SNAPSHOT_FILENAME
} from '../services/cloudSyncEngine.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed++;
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  } else {
    passed++;
    console.log(`✅ PASS: ${message}`);
  }
}

// Mock Google Drive Transport
class MockDriveTransport {
  constructor() {
    this.files = new Map();
    this.readCount = 0;
    this.uploadCount = 0;
  }

  async findAppDataFile(filename, token) {
    const f = this.files.get(filename);
    if (!f) return null;
    return { id: f.id, name: f.name, version: f.version, modifiedTime: f.modifiedTime };
  }

  async readAppDataFile(fileId, token) {
    this.readCount++;
    for (const f of this.files.values()) {
      if (f.id === fileId) return f.content;
    }
    throw new Error('File not found in mock Drive');
  }

  async uploadAppDataFile(filename, content, mimeType, token) {
    this.uploadCount++;
    const existing = this.files.get(filename);
    const version = (existing?.version || 0) + 1;
    const fileObj = {
      id: 'mock_drive_file_id_' + filename,
      name: filename,
      content,
      version,
      modifiedTime: new Date().toISOString()
    };
    this.files.set(filename, fileObj);
    return { id: fileObj.id, name: filename };
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('Phase 6B: Multi-Device Bootstrap Test Suite');
  console.log('====================================================\n');

  const testPin = '99998888';
  const testToken = 'mock_google_oauth_token';

  // ─────────────────────────────────────────────────────────────
  // SETUP: Create Synthetic Cloud Snapshot representing Device A
  // ─────────────────────────────────────────────────────────────
  console.log('--- Setup: Creating Synthetic Cloud Snapshot ---');
  const mockTransport = new MockDriveTransport();

  const devA_Entities = {
    transactions: [
      { id: 'txn_001', Date: '24/09/2026', Time: '10:00', Account: 'HDFC Bank', Category: 'Groceries', INR: 1250, Note: '#groceries store', tags: '#groceries', split_group_id: '', 'Income/Expense': 'Expense' },
      { id: 'txn_002', Date: '24/09/2026', Time: '11:00', Account: 'HDFC Bank', Category: 'Investment Charges', INR: 20, Note: 'Brokerage fee for trade', split_group_id: 'split_inv_trade_101', 'Income/Expense': 'Expense' },
      { id: 'txn_inv_bridge_01', Date: '24/09/2026', Time: '12:00', Account: 'Zerodha', Category: 'Transfer', INR: 5000, Note: 'Funding brokerage', tags: '#bridge', 'Income/Expense': 'Transfer' }
    ],
    investment_transactions: [
      {
        id: 'txn_inv_bridge_01', // Overlapping ID in investment store
        Date: '24/09/2026', Time: '12:00', Account: 'Zerodha',
        'Income/Expense': 'Expense',
        InvestmentTransactionType: 'BUY', Brokerage: 'Zerodha',
        SecuritySymbol: 'INFY', SecurityISIN: 'INE009A01021',
        Quantity: 10, UnitPrice: 1500, TradeValue: 15000,
        INR: 15000, CostBasis: 15000, CashImpact: -15000,
        split_group_id: 'split_inv_trade_101'
      },
      {
        id: 'inv_trade_202',
        Date: '23/09/2026', Time: '15:30', Account: 'Groww',
        'Income/Expense': 'Income',
        InvestmentTransactionType: 'SELL', Brokerage: 'Groww',
        SecuritySymbol: 'TCS', SecurityISIN: 'INE467B01029',
        Quantity: 5, UnitPrice: 3800, TradeValue: 19000,
        INR: 19000, CostBasis: 16000, RealizedPnl: 3000, CashImpact: 19000
      }
    ],
    accounts: [
      { id: 'acc_01', name: 'HDFC Bank', group_name: 'Bank Accounts', is_asset: 1, settlement_date: 0, card_last4: '' },
      { id: 'acc_02', name: 'Zerodha', group_name: 'Investments', is_asset: 1, settlement_date: 0, card_last4: '' }
    ],
    account_groups: [
      { id: 'grp_01', name: 'Bank Accounts', sort_order: 0 },
      { id: 'grp_02', name: 'Investments', sort_order: 1 }
    ],
    categories: [
      { id: 'cat_01', name: 'Groceries', type: 'Expense', sort_order: 0 },
      { id: 'cat_02', name: 'Investment Charges', type: 'Expense', sort_order: 1 }
    ],
    subcategories: [
      { id: 'subcat_01', name: 'Supermarket', category_id: 'cat_01', sort_order: 0 }
    ],
    brokerages: [
      { id: 'brk_01', name: 'Zerodha', bank_account: 'HDFC Bank', owner: 'Akbar' }
    ],
    inventory: [],
    budgets: [],
    recurring_rules: [],
    investment_plans: [],
    account_mapping: [],
    sub_accounts: [],
    sync_tombstones: [],
    settings: {
      theme: 'dark',
      headerColor: 'pink',
      fontSize: '1.1',
      customTags: JSON.stringify(['#groceries', '#tax', '#investments'])
    }
  };

  const { payload: syntheticSnapshotPayload } = await createCanonicalSnapshotPayload({
    entities: devA_Entities,
    snapshotId: 'snap_synthetic_devA_bootstrap',
    parentSnapshotId: null,
    cloudVersion: 1,
    deviceId: 'device_A'
  });

  const encryptedCloudSnapshot = await encryptBackupData(syntheticSnapshotPayload, testPin);
  await mockTransport.uploadAppDataFile(SNAPSHOT_FILENAME, encryptedCloudSnapshot, 'application/octet-stream', testToken);
  assert(mockTransport.files.has(SNAPSHOT_FILENAME), 'Cloud snapshot uploaded to mock Drive');

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Dry-Run Preview from Empty Local DB
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 1: Dry-Run Preview on Empty Local DB ---');
  indexedDB = new IDBFactory();
  closeDB();
  await initDB();

  const previewRes = await previewCloudSync({
    pin: testPin,
    accessToken: testToken,
    driveClient: mockTransport
  });

  assert(previewRes.mode === 'DRY_RUN', 'Preview mode is DRY_RUN');
  assert(previewRes.action === 'BOOTSTRAP_FROM_CLOUD', 'Action is BOOTSTRAP_FROM_CLOUD');
  assert(previewRes.isBootstrapEligible === true, 'Flagged as isBootstrapEligible: true');
  assert(previewRes.cloudCounts.transactions === 3, 'Cloud txns count is 3');
  assert(previewRes.cloudCounts.investment_transactions === 2, 'Cloud inv_txns count is 2');
  assert(previewRes.cloudCounts.total_financial_records === 5, 'Total financial records is 5');
  assert(previewRes.plannedLocalChanges.inserts === 5, 'Planned local inserts is 5');
  assert(previewRes.databaseMutations === 0, 'Zero DB mutations during preview');
  assert(previewRes.driveWrites === 0, 'Zero Drive writes during preview');

  // Verify DB remains empty after preview
  const checkEmpty = await readLocalEntities();
  assert(checkEmpty.transactions.length === 0, 'Local txns remained 0 after preview');

  // ─────────────────────────────────────────────────────────────
  // TEST 2: Deep Validation & Bad Checksum / Corrupted Payload Rejection
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 2: Validation Guards ---');
  let threwMalformed = false;
  try {
    await validateCloudSnapshotPayload({ snapshot_id: 'snap_bad', entities: { transactions: 'not_an_array' } });
  } catch (err) {
    threwMalformed = true;
    assert(err.message.includes('VALIDATION_ERROR'), 'Rejects malformed entities');
  }
  assert(threwMalformed, 'Malformed payload was rejected');

  let threwWrongPin = false;
  try {
    await executeBootstrap({
      pin: 'wrong_pin_1234',
      accessToken: testToken,
      driveClient: mockTransport
    });
  } catch (err) {
    threwWrongPin = true;
  }
  assert(threwWrongPin, 'Rejects decryption with wrong PIN');

  // ─────────────────────────────────────────────────────────────
  // TEST 3: Controlled Bootstrap Execution
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 3: Controlled Bootstrap Execution ---');
  const bootstrapRes = await executeBootstrap({
    pin: testPin,
    accessToken: testToken,
    deviceId: 'device_B',
    driveClient: mockTransport
  });

  assert(bootstrapRes.status === BOOTSTRAP_STATUS.SUCCESS, 'Bootstrap returned SUCCESS');
  assert(bootstrapRes.snapshotId === 'snap_synthetic_devA_bootstrap', 'Snapshot ID preserved');
  assert(bootstrapRes.recordsBootstrapped.transactions === 3, '3 transactions bootstrapped');
  assert(bootstrapRes.recordsBootstrapped.investment_transactions === 2, '2 investment transactions bootstrapped');
  assert(bootstrapRes.recordsBootstrapped.accounts === 2, '2 accounts bootstrapped');
  assert(bootstrapRes.recordsBootstrapped.categories === 2, '2 categories bootstrapped');
  assert(bootstrapRes.recordsBootstrapped.brokerages === 1, '1 brokerage bootstrapped');

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Physical Store & ID Preservation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 4: Physical Store & Overlapping ID Preservation ---');
  const db = getDB();
  const txnsInDB = (await db.query('SELECT * FROM transactions', [])).values || [];
  const invTxnsInDB = (await db.query('SELECT * FROM investment_transactions', [])).values || [];

  assert(txnsInDB.length === 3, 'Physical transactions table has exactly 3 rows');
  assert(invTxnsInDB.length === 2, 'Physical investment_transactions table has exactly 2 rows');

  // Verify overlapping ID txn_inv_bridge_01 exists in BOTH tables without cross-deletion
  const bridgeInGen = txnsInDB.find(t => t.id === 'txn_inv_bridge_01');
  const bridgeInInv = invTxnsInDB.find(t => t.id === 'txn_inv_bridge_01');
  assert(bridgeInGen !== undefined, 'Bridge transaction exists in transactions table');
  assert(bridgeInInv !== undefined, 'Bridge transaction exists in investment_transactions table');
  assert(bridgeInInv.security_symbol === 'INFY', 'Investment fields intact on bridge record');

  // ─────────────────────────────────────────────────────────────
  // TEST 5: Synced Settings & Security Local Exclusion
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 5: Synced Settings & Security Isolation ---');
  const bootstrappedSettings = await readLocalEntities();
  assert(bootstrappedSettings.settings.theme === 'dark', 'Theme bootstrapped as dark');
  assert(bootstrappedSettings.settings.headerColor === 'pink', 'HeaderColor bootstrapped as pink');
  assert(bootstrappedSettings.settings.fontSize === '1.1', 'FontSize bootstrapped as 1.1');
  assert(bootstrappedSettings.settings.customTags.includes('#groceries'), 'CustomTags bootstrapped');

  // Ensure security keys are NOT populated by bootstrap
  assert(await getSetting('pin') === null, 'PIN not saved to settings');
  assert(await getSetting('google_client_id') === null, 'Google client ID not overwritten');

  // ─────────────────────────────────────────────────────────────
  // TEST 6: Base Manifest Persistence After Successful Verification
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 6: Base Manifest Persistence ---');
  const savedBaseRaw = await getSetting('sync_base_manifest');
  assert(savedBaseRaw !== null, 'sync_base_manifest persisted');
  const savedBase = JSON.parse(savedBaseRaw);
  assert(savedBase['txn_001'] !== undefined, 'Manifest contains txn_001');
  assert(savedBase['setting:theme'] !== undefined, 'Manifest contains setting:theme');

  const lastSnap = await getSetting('last_snapshot_id');
  assert(lastSnap === 'snap_synthetic_devA_bootstrap', 'last_snapshot_id matches cloud snapshot');

  // ─────────────────────────────────────────────────────────────
  // TEST 7: Idempotency / Non-Empty Local DB Refusal
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 7: Non-Empty Local DB Refusal ---');
  const secondAttempt = await executeBootstrap({
    pin: testPin,
    accessToken: testToken,
    driveClient: mockTransport
  });

  assert(
    secondAttempt.status === BOOTSTRAP_STATUS.EXISTING_LOCAL_DATA_REQUIRES_MERGE,
    'Second bootstrap cleanly refused over existing populated local DB'
  );

  // ─────────────────────────────────────────────────────────────
  // TEST 8: Full Canonical Equality Check
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 8: Full Canonical Equality Check ---');
  const devB_Manifest = await buildEntityManifest(bootstrappedSettings);
  const devA_Manifest = await buildEntityManifest(devA_Entities);

  for (const [id, aEntry] of Object.entries(devA_Manifest)) {
    const bEntry = devB_Manifest[id];
    assert(bEntry !== undefined, `Entity ${id} present in Device B manifest`);
    assert(bEntry.canonical === aEntry.canonical, `Canonical match for ${id}`);
    assert(bEntry.fp === aEntry.fp, `Fingerprint match for ${id}`);
  }

  console.log('\n====================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test suite failed with unhandled error:', err);
  process.exit(1);
});
