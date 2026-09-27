/**
 * conflicts.js — Durable Sync Conflict Management
 * 
 * Provides persistence and query helpers for sync conflict records in `sync_conflicts`.
 */

import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export const CONFLICT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RESOLVED: 'RESOLVED',
  IGNORED: 'IGNORED'
});

export const CONFLICT_RESOLUTION = Object.freeze({
  KEEP_LOCAL: 'KEEP_LOCAL',
  ACCEPT_REMOTE: 'ACCEPT_REMOTE',
  CUSTOM_STATE: 'CUSTOM_STATE'
});

export const CONFLICT_TYPE = Object.freeze({
  CONCURRENT_EDIT: 'CONCURRENT_EDIT',
  CONCURRENT_DELETE: 'CONCURRENT_DELETE',
  REMOTE_DELETE_LOCAL_EDIT: 'REMOTE_DELETE_LOCAL_EDIT',
  LOCAL_DELETE_REMOTE_EDIT: 'LOCAL_DELETE_REMOTE_EDIT',
  CONCURRENT_RECREATE: 'CONCURRENT_RECREATE',
  STALE_RESURRECTION: 'STALE_RESURRECTION',
  SCHEMA_MISMATCH: 'SCHEMA_MISMATCH'
});

/**
 * Creates and formats a new conflict record structure.
 */
export function buildConflictRecord({
  conflict_id = uuid(),
  collection,
  entity_id,
  conflict_type,
  peer_device_id,
  event_id,
  package_id = null,
  base_checksum = null,
  local_checksum = null,
  remote_checksum = null,
  local_payload = null,
  remote_payload = null,
  status = CONFLICT_STATUS.PENDING,
  resolution = null,
  created_at = new Date().toISOString(),
  resolved_at = null
}) {
  if (!collection) throw new Error('Conflict record requires collection');
  if (!entity_id) throw new Error('Conflict record requires entity_id');
  if (!conflict_type) throw new Error('Conflict record requires conflict_type');
  if (!peer_device_id) throw new Error('Conflict record requires peer_device_id');
  if (!event_id) throw new Error('Conflict record requires event_id');

  return {
    conflict_id: String(conflict_id),
    collection: String(collection),
    entity_id: String(entity_id),
    conflict_type: String(conflict_type),
    peer_device_id: String(peer_device_id),
    event_id: String(event_id),
    package_id: package_id ? String(package_id) : null,
    base_checksum: base_checksum ? String(base_checksum) : null,
    local_checksum: local_checksum ? String(local_checksum) : null,
    remote_checksum: remote_checksum ? String(remote_checksum) : null,
    local_payload: local_payload !== null && typeof local_payload === 'object' ? local_payload : null,
    remote_payload: remote_payload !== null && typeof remote_payload === 'object' ? remote_payload : null,
    status: String(status),
    resolution: resolution ? String(resolution) : null,
    created_at: String(created_at),
    resolved_at: resolved_at ? String(resolved_at) : null
  };
}

/**
 * Persists a conflict record to the database.
 */
export async function saveConflictRecord(conflictRecord) {
  const db = getDB();
  const rec = buildConflictRecord(conflictRecord);
  await db.run(
    'INSERT OR REPLACE INTO sync_conflicts (conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, package_id, base_checksum, local_checksum, remote_checksum, local_payload, remote_payload, status, resolution, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      rec.conflict_id,
      rec.collection,
      rec.entity_id,
      rec.conflict_type,
      rec.peer_device_id,
      rec.event_id,
      rec.package_id,
      rec.base_checksum,
      rec.local_checksum,
      rec.remote_checksum,
      rec.local_payload ? JSON.stringify(rec.local_payload) : null,
      rec.remote_payload ? JSON.stringify(rec.remote_payload) : null,
      rec.status,
      rec.resolution,
      rec.created_at,
      rec.resolved_at
    ]
  );
  return rec;
}

/**
 * Retrieves a single conflict record by ID.
 */
export async function getConflict(conflictId) {
  const db = getDB();
  try {
    const res = await db.query('SELECT * FROM sync_conflicts WHERE conflict_id = ?', [conflictId]);
    const row = res.values?.[0];
    if (!row) return null;
    return {
      ...row,
      local_payload: typeof row.local_payload === 'string' ? JSON.parse(row.local_payload || 'null') : row.local_payload,
      remote_payload: typeof row.remote_payload === 'string' ? JSON.parse(row.remote_payload || 'null') : row.remote_payload
    };
  } catch (err) {
    console.warn('Failed to query sync_conflicts:', err);
    return null;
  }
}

/**
 * Queries pending conflicts.
 */
export async function getPendingConflicts() {
  const db = getDB();
  try {
    const res = await db.query('SELECT * FROM sync_conflicts WHERE status = ? ORDER BY created_at ASC', [CONFLICT_STATUS.PENDING]);
    return (res.values || []).map(row => ({
      ...row,
      local_payload: typeof row.local_payload === 'string' ? JSON.parse(row.local_payload || 'null') : row.local_payload,
      remote_payload: typeof row.remote_payload === 'string' ? JSON.parse(row.remote_payload || 'null') : row.remote_payload
    }));
  } catch (err) {
    console.warn('Failed to query pending conflicts:', err);
    return [];
  }
}

/**
 * Retrieves all conflict records for audit.
 */
export async function getAllConflicts() {
  const db = getDB();
  try {
    const res = await db.query('SELECT * FROM sync_conflicts ORDER BY created_at ASC');
    return (res.values || []).map(row => ({
      ...row,
      local_payload: typeof row.local_payload === 'string' ? JSON.parse(row.local_payload || 'null') : row.local_payload,
      remote_payload: typeof row.remote_payload === 'string' ? JSON.parse(row.remote_payload || 'null') : row.remote_payload
    }));
  } catch (err) {
    console.warn('Failed to query all conflicts:', err);
    return [];
  }
}
