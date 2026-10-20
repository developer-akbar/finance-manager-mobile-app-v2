/**
 * connected_devices_manifest_discovery.test.js
 *
 * Unit and integration tests for Phase 1 Connected Devices:
 * 1. Read-only discovery of device manifests in Google Drive appDataFolder.
 * 2. Self and peer manifest discovery and distinction.
 * 3. Sorting (current device first, then descending by last update).
 * 4. Deduplication of multiple revisions for the same device ID.
 * 5. Accurate baseline compatibility classification (compatible v12, newer v13, incompatible v8).
 * 6. Graceful handling of empty vaults, auth failures, and unuploaded local devices.
 * 7. Legacy 'local_device' manifest exclusion.
 * 8. UI presentation audit of ConnectedDevicesCard and CloudSyncManager integration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listAllCloudDeviceManifests,
  createEmptyDeviceManifest,
  PEER_LINEAGE_STATUS,
  saveCloudDeviceNicknames,
  getCloudDeviceNicknames,
  ensureOwnDeviceManifestSynced
} from '../services/deviceManifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  async uploadFile({ name, content, modifiedTime }) {
    const id = `mock_drive_file_${this.nextId++}`;
    this.files.set(id, {
      id,
      name,
      content,
      modifiedTime: modifiedTime || new Date().toISOString(),
      size: typeof content === 'string' ? content.length : JSON.stringify(content).length,
      trashed: false
    });
    return { id, name };
  }
}

test('Connected Devices Phase 1: Authentication failure handling', async () => {
  // When no token and no drive client are provided, returns AUTH_REQUIRED
  const result = await listAllCloudDeviceManifests({
    accessToken: null,
    driveClient: null,
    localDeviceId: 'dev_test_local_01'
  });

  assert.equal(result.error, 'AUTH_REQUIRED');
  assert.equal(result.devices.length, 0);
  assert.equal(result.rawCount, 0);
});

test('Connected Devices Phase 1: Empty vault handling', async () => {
  const drive = new MockDriveStorage();

  const result = await listAllCloudDeviceManifests({
    driveClient: drive,
    localDeviceId: 'dev_local_empty_01',
    currentBaseSnapshotId: 'snap_v12_base',
    currentBaseCloudVersion: 12
  });

  assert.equal(result.error, null);
  assert.equal(result.rawCount, 0);
  // Local device is synthesized as unuploaded
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].deviceId, 'dev_local_empty_01');
  assert.equal(result.devices[0].isCurrentDevice, true);
  assert.equal(result.devices[0].notUploadedYet, true);
});

test('Connected Devices Phase 1: Discovers self and peers, sorting current device first', async () => {
  const drive = new MockDriveStorage();
  const currentDeviceId = 'dev_fa18ce0c9349'; // Device A
  const peerDeviceId = 'dev_a30fb118cec0';    // Device D

  // Seed Device A manifest
  const manifestA = createEmptyDeviceManifest({
    deviceId: currentDeviceId,
    deviceName: 'FinMan Desktop A',
    baseSnapshotId: 'snap_1792067106302_gdxzub',
    baseCloudVersion: 12,
    manifestRevision: 2
  });
  manifestA.last_sequence = 36;
  manifestA.updated_at = '2026-10-17T17:08:30.875Z';
  await drive.uploadFile({
    name: `manifest_${currentDeviceId}.json`,
    content: JSON.stringify(manifestA),
    modifiedTime: '2026-10-17T17:08:31.000Z'
  });

  // Seed Device D manifest (with a later timestamp to test that current device still sorts first)
  const manifestD = createEmptyDeviceManifest({
    deviceId: peerDeviceId,
    deviceName: 'FinMan Android D',
    baseSnapshotId: 'snap_1792067106302_gdxzub',
    baseCloudVersion: 12,
    manifestRevision: 1
  });
  manifestD.last_sequence = 34;
  manifestD.updated_at = '2026-10-17T17:13:44.880Z';
  await drive.uploadFile({
    name: `manifest_${peerDeviceId}.json`,
    content: JSON.stringify(manifestD),
    modifiedTime: '2026-10-17T17:13:45.000Z'
  });

  const result = await listAllCloudDeviceManifests({
    driveClient: drive,
    localDeviceId: currentDeviceId,
    currentBaseSnapshotId: 'snap_1792067106302_gdxzub',
    currentBaseCloudVersion: 12
  });

  assert.equal(result.error, null);
  assert.equal(result.rawCount, 2);
  assert.equal(result.devices.length, 2);

  // 1. Current device is first
  const first = result.devices[0];
  assert.equal(first.deviceId, currentDeviceId);
  assert.equal(first.isCurrentDevice, true);
  assert.equal(first.notUploadedYet, false);
  assert.equal(first.deviceName, 'FinMan Desktop A');
  assert.equal(first.baseCloudVersion, 12);
  assert.equal(first.lastSequence, 36);
  assert.equal(first.lineageStatus, PEER_LINEAGE_STATUS.COMPATIBLE);

  // 2. Peer device is second
  const second = result.devices[1];
  assert.equal(second.deviceId, peerDeviceId);
  assert.equal(second.isCurrentDevice, false);
  assert.equal(second.deviceName, 'FinMan Android D');
  assert.equal(second.deviceType, 'Android Device');
  assert.equal(second.baseCloudVersion, 12);
  assert.equal(second.lastSequence, 34);
  assert.equal(second.lineageStatus, PEER_LINEAGE_STATUS.COMPATIBLE);
});

test('Connected Devices Phase 1: Deduplication of duplicate device manifests', async () => {
  const drive = new MockDriveStorage();
  const deviceId = 'dev_dup_test_01';

  // Seed older revision 1
  const olderManifest = createEmptyDeviceManifest({
    deviceId,
    deviceName: 'Duplicate Device Rev 1',
    baseSnapshotId: 'snap_v12',
    baseCloudVersion: 12,
    manifestRevision: 1
  });
  olderManifest.last_sequence = 5;
  olderManifest.updated_at = '2026-10-17T10:00:00.000Z';
  await drive.uploadFile({
    name: `manifest_${deviceId}.json`,
    content: JSON.stringify(olderManifest)
  });

  // Seed newer revision 3 for same deviceId
  const newerManifest = createEmptyDeviceManifest({
    deviceId,
    deviceName: 'Duplicate Device Rev 3',
    baseSnapshotId: 'snap_v12',
    baseCloudVersion: 12,
    manifestRevision: 3
  });
  newerManifest.last_sequence = 15;
  newerManifest.updated_at = '2026-10-17T12:00:00.000Z';
  await drive.uploadFile({
    name: `manifest_${deviceId}.json`,
    content: JSON.stringify(newerManifest)
  });

  const result = await listAllCloudDeviceManifests({
    driveClient: drive,
    localDeviceId: 'dev_other_local',
    currentBaseSnapshotId: 'snap_v12',
    currentBaseCloudVersion: 12
  });

  // Should deduplicate to 1 entry for dev_dup_test_01 (plus the unuploaded local device)
  const peer = result.devices.find(d => d.deviceId === deviceId);
  assert.ok(peer, 'Deduplicated device must exist');
  assert.equal(peer.manifestRevision, 3);
  assert.equal(peer.lastSequence, 15);
  assert.equal(peer.deviceName, 'Duplicate Device Rev 3');
});

test('Connected Devices Phase 1: Compatibility derivation (Compatible, Newer, Incompatible, Blocked)', async () => {
  const drive = new MockDriveStorage();
  const currentBaseline = 'snap_v12_baseline';

  // 1. Compatible Peer (same baseline)
  const compPeer = createEmptyDeviceManifest({
    deviceId: 'dev_comp_01',
    deviceName: 'Compatible Peer',
    baseSnapshotId: currentBaseline,
    baseCloudVersion: 12
  });
  await drive.uploadFile({ name: 'manifest_dev_comp_01.json', content: JSON.stringify(compPeer) });

  // 2. Newer Peer (v13 descendant)
  const newerPeer = createEmptyDeviceManifest({
    deviceId: 'dev_newer_01',
    deviceName: 'Newer Peer',
    baseSnapshotId: 'snap_v13_descendant',
    baseCloudVersion: 13
  });
  await drive.uploadFile({ name: 'manifest_dev_newer_01.json', content: JSON.stringify(newerPeer) });

  // 3. Incompatible Peer (v8 older retired baseline)
  const incompPeer = createEmptyDeviceManifest({
    deviceId: 'dev_incomp_01',
    deviceName: 'Old v8 Peer',
    baseSnapshotId: 'snap_v8_old',
    baseCloudVersion: 8
  });
  await drive.uploadFile({ name: 'manifest_dev_incomp_01.json', content: JSON.stringify(incompPeer) });

  // 4. Blocked Lifecycle Peer
  const blockedPeer = createEmptyDeviceManifest({
    deviceId: 'dev_blocked_01',
    deviceName: 'Blocked Peer',
    baseSnapshotId: currentBaseline,
    baseCloudVersion: 12,
    device_lifecycle_state: 'BLOCKED'
  });
  blockedPeer.lifecycle_state = 'BLOCKED';
  await drive.uploadFile({ name: 'manifest_dev_blocked_01.json', content: JSON.stringify(blockedPeer) });

  const result = await listAllCloudDeviceManifests({
    driveClient: drive,
    localDeviceId: 'dev_comp_01', // Local is dev_comp_01
    currentBaseSnapshotId: currentBaseline,
    currentBaseCloudVersion: 12
  });

  const devMap = new Map(result.devices.map(d => [d.deviceId, d]));

  assert.equal(devMap.get('dev_comp_01').lineageStatus, PEER_LINEAGE_STATUS.COMPATIBLE);
  assert.equal(devMap.get('dev_comp_01').isCurrentDevice, true);

  assert.equal(devMap.get('dev_newer_01').lineageStatus, PEER_LINEAGE_STATUS.RECOVERABLE_NEWER);
  assert.ok(devMap.get('dev_newer_01').lineageReason.includes('NEWER_SNAPSHOT_BASELINE'));

  assert.equal(devMap.get('dev_incomp_01').lineageStatus, PEER_LINEAGE_STATUS.INCOMPATIBLE_BLOCKED);
  assert.ok(devMap.get('dev_incomp_01').lineageReason.includes('INCOMPATIBLE_SNAPSHOT_BASELINE'));

  assert.equal(devMap.get('dev_blocked_01').lineageStatus, PEER_LINEAGE_STATUS.INCOMPATIBLE_BLOCKED);
  assert.equal(devMap.get('dev_blocked_01').lifecycleState, 'BLOCKED');
});

test('Connected Devices Phase 1: Excludes legacy local_device and non-manifest files', async () => {
  const drive = new MockDriveStorage();

  // Legacy local_device manifest
  await drive.uploadFile({
    name: 'manifest_dev_local_device.json',
    content: JSON.stringify({ device_id: 'local_device', base_cloud_version: 8 })
  });

  // Non-manifest file
  await drive.uploadFile({
    name: 'financial_snapshot.json',
    content: JSON.stringify({ version: 12 })
  });

  // Valid peer manifest
  const validPeer = createEmptyDeviceManifest({
    deviceId: 'dev_valid_99',
    baseSnapshotId: 'snap_v12',
    baseCloudVersion: 12
  });
  await drive.uploadFile({
    name: 'manifest_dev_valid_99.json',
    content: JSON.stringify(validPeer)
  });

  const result = await listAllCloudDeviceManifests({
    driveClient: drive,
    localDeviceId: 'dev_my_phone_11',
    currentBaseSnapshotId: 'snap_v12',
    currentBaseCloudVersion: 12
  });

  assert.ok(!result.devices.some(d => d.deviceId === 'local_device'), 'local_device must never be included');
  assert.ok(result.devices.some(d => d.deviceId === 'dev_valid_99'), 'dev_valid_99 must be included');
  assert.ok(result.devices.some(d => d.deviceId === 'dev_my_phone_11'), 'local synthetic device must be included');
});

test('Connected Devices Phase 1 UI: Source audit confirms ConnectedDevicesCard requirements', () => {
  const cardPath = path.resolve(__dirname, '../components/Settings/ConnectedDevicesCard.jsx');
  const source = fs.readFileSync(cardPath, 'utf8');

  // 1. Header and Refresh action
  assert.ok(source.includes('📱 Connected Devices'), 'Card header must be 📱 Connected Devices');
  assert.ok(source.includes('Refresh'), 'Manual Refresh action must be present');
  assert.ok(source.includes('fetchDevices'), 'Refresh triggers fetchDevices');

  // 2. Truthful presence disclaimer (no false online heartbeat)
  assert.ok(
    source.includes('Timestamps indicate when each device last updated its manifest file, not real-time network connection'),
    'Must explicitly state timestamps reflect manifest updates, not live socket presence'
  );

  // 3. Current device marker & ID copy support
  assert.ok(source.includes('📍 This Device'), 'Current device marker must be 📍 This Device');
  assert.ok(source.includes('handleCopy'), 'Copy handler must be present');
  assert.ok(source.includes('Copied'), 'Copy feedback must be present');
  assert.ok(source.includes('execCommand'), 'Must have document.execCommand fallback');

  // 4. Metadata fields
  assert.ok(source.includes('Sequence Watermark:'), 'Sequence watermark must be displayed');
  assert.ok(source.includes('Baseline Snapshot:'), 'Baseline snapshot must be displayed');
  assert.ok(source.includes('Manifest Updated:'), 'Manifest Updated timestamp must be clearly distinguished');
  assert.ok(source.includes('Last Local Full Sync:'), 'Last Local Full Sync must be clearly distinguished');
  assert.ok(source.includes('Current Environment:'), 'Current environment label must be distinct');

  // 5. Incompatible baseline warnings
  assert.ok(source.includes('Incompatible Snapshot Baseline'), 'Must display Incompatible Snapshot Baseline warning');
  assert.ok(source.includes('Newer Snapshot Baseline Available'), 'Must display Newer Snapshot Baseline Available notice');
});

test('Connected Devices Phase 1 UI: CloudSyncManager mounts ConnectedDevicesCard before Sync Conflicts', () => {
  const managerPath = path.resolve(__dirname, '../components/Settings/CloudSyncManager.jsx');
  const source = fs.readFileSync(managerPath, 'utf8');

  assert.ok(source.includes("import ConnectedDevicesCard from './ConnectedDevicesCard.jsx';"), 'CloudSyncManager must import ConnectedDevicesCard');
  assert.ok(source.includes('<ConnectedDevicesCard'), 'CloudSyncManager must render ConnectedDevicesCard');

  const cardPos = source.indexOf('<ConnectedDevicesCard');
  const conflictPos = source.indexOf('id="sync-conflicts-section"');
  assert.ok(cardPos > 0 && conflictPos > 0 && cardPos < conflictPos, 'ConnectedDevicesCard must appear before Sync Conflicts section');
});

test('Connected Devices Phase 1: Pagination support in manifest listing', async () => {
  // Test that listPeerManifests supports multi-page responses
  const manifestSource = fs.readFileSync(path.resolve(__dirname, '../services/deviceManifest.js'), 'utf8');
  assert.ok(manifestSource.includes('nextPageToken'), 'listPeerManifests must check nextPageToken for pagination');
  assert.ok(manifestSource.includes('do {') && manifestSource.includes('} while (pageToken);'), 'Must loop over pageToken');
});

test('Connected Devices: Shared cloud device nicknames persistence & discovery', async () => {
  const drive = new MockDriveStorage();

  // 1. Upload two device manifests with default names
  const dev1 = createEmptyDeviceManifest({
    deviceId: 'dev_browser_fa18ce',
    deviceName: 'FinMan Device',
    baseSnapshotId: 'snap_v14',
    baseCloudVersion: 14
  });
  const dev2 = createEmptyDeviceManifest({
    deviceId: 'dev_android_c7e454',
    deviceName: 'FinMan Device',
    baseSnapshotId: 'snap_v14',
    baseCloudVersion: 14
  });

  await drive.uploadFile({
    name: 'manifest_dev_browser_fa18ce.json',
    content: JSON.stringify(dev1)
  });
  await drive.uploadFile({
    name: 'manifest_dev_android_c7e454.json',
    content: JSON.stringify(dev2)
  });

  // 2. Save nicknames to Drive (as done when user edits names on browser)
  const nicknames = {
    dev_browser_fa18ce: 'My Primary Browser',
    dev_android_c7e454: 'Akbar Pixel Android'
  };
  const saveSuccess = await saveCloudDeviceNicknames(nicknames, { driveClient: drive });
  assert.equal(saveSuccess, true, 'saveCloudDeviceNicknames must succeed');

  // 3. Verify getCloudDeviceNicknames retrieves them
  const retrieved = await getCloudDeviceNicknames({ driveClient: drive });
  assert.deepEqual(retrieved, nicknames, 'Retrieved nicknames must match saved nicknames');

  // 4. Discover devices via listAllCloudDeviceManifests on Android device perspective
  const res = await listAllCloudDeviceManifests({
    driveClient: drive,
    localDeviceId: 'dev_android_c7e454',
    currentBaseSnapshotId: 'snap_v14',
    currentBaseCloudVersion: 14
  });

  assert.equal(res.devices.length, 2);
  const browserDev = res.devices.find(d => d.deviceId === 'dev_browser_fa18ce');
  const androidDev = res.devices.find(d => d.deviceId === 'dev_android_c7e454');

  assert.ok(browserDev, 'Browser device must be discovered');
  assert.ok(androidDev, 'Android device must be discovered');
  assert.equal(browserDev.deviceName, 'My Primary Browser', 'Browser nickname must propagate from Drive');
  assert.equal(androidDev.deviceName, 'Akbar Pixel Android', 'Android nickname must propagate from Drive');
  assert.equal(browserDev.lineageStatus, PEER_LINEAGE_STATUS.COMPATIBLE, 'Both devices on v14 must be COMPATIBLE');
  assert.equal(androidDev.isCurrentDevice, true, 'Android device must be current device');
});
