/**
 * deltaQueue.js — Local Sync Delta Queue & Durable Sequence State
 * 
 * Manages local mutation events in `sync_delta_queue` and persistent
 * device sequence allocation state in `sync_local_state`.
 */

import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export const DELTA_STATUS = Object.freeze({
  PENDING: 'PENDING',
  IN_FLIGHT: 'IN_FLIGHT',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  REBASED_RETIRED: 'REBASED_RETIRED'
});

export const DELTA_OPERATION = Object.freeze({
  INSERT: 'INSERT',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE'
});

/**
 * Creates a validated DeltaEvent object matching the Phase 7.0.4 specification.
 */
export function createDeltaEvent({
  event_id = uuid(),
  device_id,
  sequence,
  timestamp = new Date().toISOString(),
  collection,
  entity_id,
  operation,
  base_checksum = null,
  new_checksum = null,
  tombstone_generation = 0,
  payload = null,
  status = DELTA_STATUS.PENDING,
  bundle_id = null,
  bundle_index = 0,
  bundle_total = 1,
  bundle_checksum = null,
  parent_event_id = null
}) {
  if (!device_id) throw new Error('DeltaEvent requires a valid device_id');
  if (typeof sequence !== 'number' || sequence < 1) {
    throw new Error(`DeltaEvent requires a positive numeric sequence, got: ${sequence}`);
  }
  if (!collection) throw new Error('DeltaEvent requires a target collection');
  if (!entity_id) throw new Error('DeltaEvent requires an entity_id');
  if (!operation || !['INSERT', 'UPDATE', 'DELETE'].includes(operation)) {
    throw new Error(`Invalid DeltaEvent operation: ${operation}`);
  }

  return {
    event_id: String(event_id),
    device_id: String(device_id),
    sequence: Number(sequence),
    timestamp: String(timestamp),
    collection: String(collection),
    entity_id: String(entity_id),
    operation: String(operation),
    base_checksum: base_checksum ? String(base_checksum) : null,
    new_checksum: new_checksum ? String(new_checksum) : null,
    tombstone_generation: Number(tombstone_generation) || 0,
    payload: payload !== null && typeof payload === 'object' ? payload : null,
    status: String(status),
    bundle_id: bundle_id ? String(bundle_id) : null,
    bundle_index: Number(bundle_index) || 0,
    bundle_total: Number(bundle_total) || 1,
    bundle_checksum: bundle_checksum ? String(bundle_checksum) : null,
    parent_event_id: parent_event_id ? String(parent_event_id) : null
  };
}

/**
 * Initializes or reads the persistent device sync state in `sync_local_state`.
 */
export async function initLocalSyncState(deviceId = null, baseSnapshotId = null, baseCloudVersion = null, lifecycleState = null) {
  const db = getDB();
  const existing = await getLocalSyncState();
  if (existing) {
    return existing;
  }

  const generatedDeviceId = deviceId || `dev_${uuid().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();
  const initialState = {
    key: 'device_state',
    device_id: generatedDeviceId,
    base_snapshot_id: baseSnapshotId || null,
    base_cloud_version: baseCloudVersion || null,
    lifecycle_state: lifecycleState || (baseSnapshotId ? 'ACTIVE' : null),
    last_allocated_sequence: 0,
    last_pushed_sequence: 0,
    updated_at: now
  };

  await db.run(
    'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, lifecycle_state, last_allocated_sequence, last_pushed_sequence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [initialState.key, initialState.device_id, initialState.base_snapshot_id, initialState.base_cloud_version, initialState.lifecycle_state, initialState.last_allocated_sequence, initialState.last_pushed_sequence, initialState.updated_at]
  );

  return initialState;
}

/**
 * Retrieves current local device sync state from database.
 */
export async function getLocalSyncState() {
  const db = getDB();
  try {
    const res = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
    const row = res.values?.[0];
    if (!row) return null;
    return {
      key: row.key,
      device_id: row.device_id,
      base_snapshot_id: row.base_snapshot_id || null,
      base_cloud_version: row.base_cloud_version || null,
      lifecycle_state: row.lifecycle_state || null,
      last_allocated_sequence: Number(row.last_allocated_sequence) || 0,
      last_pushed_sequence: Number(row.last_pushed_sequence) || 0,
      updated_at: row.updated_at
    };
  } catch (err) {
    console.warn('Failed to query sync_local_state:', err);
    return null;
  }
}

/**
 * Queries pending delta events up to an optional sequence watermark.
 */
export async function getPendingDeltaEvents(maxSequence = null) {
  const db = getDB();
  try {
    let sql = `SELECT * FROM sync_delta_queue WHERE status = ?`;
    const params = [DELTA_STATUS.PENDING];
    if (typeof maxSequence === 'number') {
      sql += ` AND sequence <= ?`;
      params.push(maxSequence);
    }
    sql += ` ORDER BY sequence ASC`;
    const res = await db.query(sql, params);
    return (res.values || []).map(r => ({
      ...r,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload || 'null') : r.payload
    }));
  } catch (err) {
    console.warn('Failed to fetch pending delta events:', err);
    return [];
  }
}

/**
 * Returns summary statistics of the local delta queue.
 */
export async function getDeltaQueueStats() {
  const db = getDB();
  try {
    const res = await db.query('SELECT * FROM sync_delta_queue');
    const rows = res.values || [];
    const pending = rows.filter(r => r.status === DELTA_STATUS.PENDING).length;
    const inFlight = rows.filter(r => r.status === DELTA_STATUS.IN_FLIGHT).length;
    const acknowledged = rows.filter(r => r.status === DELTA_STATUS.ACKNOWLEDGED).length;
    const retired = rows.filter(r => r.status === DELTA_STATUS.REBASED_RETIRED).length;
    const maxSeq = rows.reduce((max, r) => Math.max(max, Number(r.sequence) || 0), 0);

    return {
      totalEvents: rows.length,
      pendingCount: pending,
      inFlightCount: inFlight,
      acknowledgedCount: acknowledged,
      retiredCount: retired,
      maxSequence: maxSeq
    };
  } catch (err) {
    return {
      totalEvents: 0,
      pendingCount: 0,
      inFlightCount: 0,
      acknowledgedCount: 0,
      retiredCount: 0,
      maxSequence: 0
    };
  }
}
