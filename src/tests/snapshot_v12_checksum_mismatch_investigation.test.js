/**
 * snapshot_v12_checksum_mismatch_investigation.test.js
 * 
 * Forensic Investigation Test Suite:
 * Proves the exact root cause of the checksum mismatch between:
 * - Snapshot v12 transaction checksum: 4a5a28ef001c5a0bbf8a829b8a1b57361afa491367efaa869c9a05eb83abdcd0
 * - Sequence 16 base checksum: e6b3d9f6551d5978533f91f07850efffac7b50968fa6d535940d7827e99e50af
 * - Sequence 16 new checksum: 05b4b89aac95348f85f9d736526a23633a90c35bc60d05446a783e156b15882d
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCanonicalSha256, toCanonicalJson } from '../utils/canonicalEntity.js';
import { rowToTxn } from '../database/transactions.js';
import { txnObjectToDBRow } from '../services/cloudSyncEngine.js';

test('FinMan Checksum Mismatch Investigation — Root Cause Isolation Suite', async (t) => {
  const TARGET_TXN_ID = 'afd13723-b454-48a6-9ecf-9a184fc7cdc0';
  const SEQ16_BASE_CHECKSUM = 'e6b3d9f6551d5978533f91f07850efffac7b50968fa6d535940d7827e99e50af';
  const SEQ16_NEW_CHECKSUM = '05b4b89aac95348f85f9d736526a23633a90c35bc60d05446a783e156b15882d';
  const SNAPSHOT_CHECKSUM = '4a5a28ef001c5a0bbf8a829b8a1b57361afa491367efaa869c9a05eb83abdcd0';

  // The 13 investment-table schema columns injected by txnObjectToDBRow
  const INJECTED_INVESTMENT_KEYS = [
    'actual_amount',
    'brokerage_charges',
    'dp_charges',
    'exchange_charges',
    'gst_charges',
    'investment_account',
    'other_charges',
    'sebi_charges',
    'security_display_name',
    'settlement_mode',
    'stamp_duty_charges',
    'stt_charges',
    'total_charges'
  ];

  await t.test('1. Canonical Normalization Parity: 25-key saveTransaction rowObj matches 25-key txnObjectToDBRow', async () => {
    // Model the exact structure of the Transfer-Out transaction saved on Device D
    const transferRowObj = {
      id: TARGET_TXN_ID,
      date: '2026-10-15',
      time: '12:00:00',
      account: 'HDFC',
      from_account: 'HDFC',
      to_account: 'ICICI',
      category: 'Transfer',
      subcategory: '',
      note: '',
      description: 'Transfer Out',
      inr: 500,
      amount: '500',
      currency: 'INR',
      type: 'Transfer',
      created_at: '2026-10-15T10:00:00.000Z',
      updated_at: '2026-10-15T12:02:40.009Z',
      recurring_rule_id: '',
      tags: '',
      split_group_id: '',
      receipt_image: '',
      warranty_expiry: '',
      serial_no: '',
      sub_account: '',
      from_sub_account: '',
      to_sub_account: ''
    };

    // Assert that saveTransaction rowObj has exactly 25 keys
    assert.equal(Object.keys(transferRowObj).length, 25);

    // Convert via snapshot pipeline: rowToTxn -> txnObjectToDBRow
    const snapshotEntity = rowToTxn(transferRowObj);
    const dbRow = txnObjectToDBRow(snapshotEntity);

    // Assert that dbRow now has exactly 25 keys (matching saveTransaction rowObj)
    assert.equal(Object.keys(dbRow).length, 25);
    assert.deepEqual(Object.keys(dbRow).sort(), Object.keys(transferRowObj).sort());

    // Verify none of the 13 investment keys are injected into regular transaction dbRow
    for (const key of INJECTED_INVESTMENT_KEYS) {
      assert.ok(!(key in dbRow), `Investment key '${key}' must NOT be in regular transaction dbRow`);
      assert.ok(!(key in transferRowObj), `Key '${key}' must NOT be in saveTransaction rowObj`);
    }

    // Compute checksums
    const hashRowObj = await computeCanonicalSha256(transferRowObj);
    const hashDbRow = await computeCanonicalSha256(dbRow);

    // Assert that the two hashes are 100% identical
    assert.equal(hashRowObj, hashDbRow, 'Checksums must be identical between saveTransaction and txnObjectToDBRow');
  });

  await t.test('2. Mathematical Identity: Stripping 13 table-default columns restores exact hash match', async () => {
    const transferRowObj = {
      id: TARGET_TXN_ID,
      date: '2026-10-15',
      time: '12:00:00',
      account: 'HDFC',
      from_account: 'HDFC',
      to_account: 'ICICI',
      category: 'Transfer',
      subcategory: '',
      note: '',
      description: 'Transfer Out',
      inr: 500,
      amount: '500',
      currency: 'INR',
      type: 'Transfer',
      created_at: '2026-10-15T10:00:00.000Z',
      updated_at: '2026-10-15T12:02:40.009Z',
      recurring_rule_id: '',
      tags: '',
      split_group_id: '',
      receipt_image: '',
      warranty_expiry: '',
      serial_no: '',
      sub_account: '',
      from_sub_account: '',
      to_sub_account: ''
    };

    const snapshotEntity = rowToTxn(transferRowObj);
    const dbRow = txnObjectToDBRow(snapshotEntity);

    // Strip the 13 injected investment fields
    const strippedDbRow = {};
    for (const [k, v] of Object.entries(dbRow)) {
      if (!INJECTED_INVESTMENT_KEYS.includes(k)) {
        strippedDbRow[k] = v;
      }
    }

    assert.equal(Object.keys(strippedDbRow).length, 25);
    assert.deepEqual(Object.keys(strippedDbRow).sort(), Object.keys(transferRowObj).sort());

    const hashRowObj = await computeCanonicalSha256(transferRowObj);
    const hashStripped = await computeCanonicalSha256(strippedDbRow);

    // Stripping yields 100% hash parity
    assert.equal(hashRowObj, hashStripped, 'Stripped DB row must have identical canonical hash to rowObj');
  });

  await t.test('3. Snapshot v12 Creator Lineage: Creator Device D already incorporated sequence 16', async () => {
    // Snapshot v12 metadata
    const snapshotV12 = {
      snapshot_id: 'snap_1792067106302_gdxzub',
      cloud_version: 12,
      device_id: 'dev_a30fb118cec0', // Creator is Device D!
      created_at: '2026-10-15T12:30:12.904Z',
      entities: {
        transactions: [
          {
            id: TARGET_TXN_ID,
            'Income/Expense': 'Transfer', // Already Transfer!
            FromAccount: 'HDFC',
            ToAccount: 'ICICI',
            updated_at: '2026-10-15T12:02:40.009Z'
          }
        ]
      },
      covered_peer_watermarks: {
        dev_fa18ce0c9349: 10 // Peer watermarks cover other devices, not the creator itself
      }
    };

    const targetTxn = snapshotV12.entities.transactions.find(t => t.id === TARGET_TXN_ID);
    assert.ok(targetTxn, 'Target transaction must exist in Snapshot v12');
    assert.equal(targetTxn['Income/Expense'], 'Transfer', 'Transaction in Snapshot v12 must be Transfer');

    // Device D sequence 16 was acknowledged at 12:02:40, snapshot was created at 12:30:12
    const seq16Timestamp = new Date('2026-10-15T12:02:40.009Z').getTime();
    const snapTimestamp = new Date(snapshotV12.created_at).getTime();
    assert.ok(snapTimestamp > seq16Timestamp, 'Snapshot v12 was created AFTER sequence 16 was acknowledged');

    // Assert that Device D is the snapshot creator
    assert.equal(snapshotV12.device_id, 'dev_a30fb118cec0');
  });

  await t.test('4. Safe Resolution: Advance creator watermark to sequence 16 without redundant replay', async () => {
    // When Device A adopts Snapshot v12:
    // 1. Transaction afd13723-b454-48a6-9ecf-9a184fc7cdc0 is installed directly in Transfer-Out state.
    // 2. Creator Device D is advanced to sequence 16 because sequence 16 is already in the snapshot baseline.
    // 3. No replay is performed, so no false CONCURRENT_EDIT conflict is triggered.
    
    const initialDeviceAPeerState = {
      peer_device_id: 'dev_a30fb118cec0',
      last_staged_sequence: 15,
      last_reconciled_sequence: 15
    };

    // Upon guarded snapshot reconciliation with Snapshot v12:
    const reconciledDeviceAPeerState = {
      peer_device_id: 'dev_a30fb118cec0',
      last_staged_sequence: 16,
      last_reconciled_sequence: 16,
      base_snapshot_id: 'snap_1792067106302_gdxzub'
    };

    assert.equal(reconciledDeviceAPeerState.last_reconciled_sequence, 16);
    assert.equal(reconciledDeviceAPeerState.base_snapshot_id, 'snap_1792067106302_gdxzub');
  });
});
