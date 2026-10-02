/**
 * atomicMutation.js — Unified Transaction-Aware Atomic Mutation Layer
 * 
 * Guarantees that Entity Mutations, Sequence Allocations (sync_local_state),
 * Delta Queue Events (sync_delta_queue), and Tombstones (sync_tombstones)
 * commit or roll back together in exactly ONE atomic database transaction.
 */

import { Capacitor } from '@capacitor/core';
import { getDB, getRawIDB, openIDBInstance } from './db.js';
import { createDeltaEvent, DELTA_STATUS, DELTA_OPERATION } from './deltaQueue.js';
import { toCanonicalJson, computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import { v4 as uuid } from 'uuid';
import { scheduleSync, SYNC_TRIGGER } from '../services/deltaSyncCoordinator.js';

const MAX_PRECONDITION_RETRIES = 3;

/**
 * Executes a single atomic mutation with optimistic precondition check and auto-retry.
 */
export async function executeAtomicMutation(options) {
  const storeName = options.storeName;
  const entityId = options.entityId || options.id || options.ID || options.entityData?.id || options.entity?.id;
  const operation = options.operation;
  const entityData = options.entityData !== undefined ? options.entityData : (options.entity !== undefined ? options.entity : null);
  const tombstoneType = options.tombstoneType || null;
  const bundleInfo = options.bundleInfo || null;
  const parentEventId = options.parentEventId || null;
  const buildEntityFn = options.buildEntityFn || null;
  const suppressDeltaQueue = !!options.suppressDeltaQueue;

  let attempt = 0;
  while (attempt < MAX_PRECONDITION_RETRIES) {
    attempt++;
    try {
      return await _executeSingleMutationAttempt({
        storeName,
        entityId,
        operation,
        entityData,
        tombstoneType,
        bundleInfo,
        parentEventId,
        buildEntityFn,
        suppressDeltaQueue
      });
    } catch (err) {
      if (err.message === 'PRECONDITION_FAILED' && attempt < MAX_PRECONDITION_RETRIES) {
        console.warn(`[AtomicMutation] Precondition failed for ${storeName}/${entityId}, retrying (attempt ${attempt + 1})...`);
        continue;
      }
      throw err;
    }
  }
}

async function _executeSingleMutationAttempt({
  storeName,
  entityId,
  operation,
  entityData,
  tombstoneType,
  bundleInfo,
  parentEventId,
  buildEntityFn,
  suppressDeltaQueue = false
}) {
  const db = getDB();

  // 1. Stage 1: Async Pre-computation outside DB transaction
  let preExistingEntity = null;
  if (operation === DELTA_OPERATION.UPDATE || operation === DELTA_OPERATION.DELETE) {
    const res = await db.query(`SELECT * FROM ${storeName} WHERE id = ?`, [entityId]);
    preExistingEntity = res.values?.[0] || null;
    if (!preExistingEntity && operation === DELTA_OPERATION.UPDATE) {
      // If updating a non-existent entity, fallback to INSERT or empty
      preExistingEntity = null;
    }
  }

  let finalEntity = entityData;
  if (buildEntityFn && typeof buildEntityFn === 'function') {
    finalEntity = await buildEntityFn(preExistingEntity);
  }

  const baseChecksum = preExistingEntity ? await computeCanonicalSha256(preExistingEntity) : null;
  const newChecksum = (operation !== DELTA_OPERATION.DELETE && finalEntity)
    ? await computeCanonicalSha256(finalEntity)
    : null;

  const isWeb = Capacitor.getPlatform() === 'web';

  if (isWeb) {
    return await _executeAtomicIDB({
      operations: [{
        storeName,
        id: entityId,
        operation,
        entity: finalEntity,
        expectedBaseEntity: preExistingEntity,
        base_checksum: baseChecksum,
        new_checksum: newChecksum,
        tombstoneType,
        bundle_id: bundleInfo?.bundle_id || null,
        bundle_index: bundleInfo?.bundle_index || 0,
        bundle_total: bundleInfo?.bundle_total || 1,
        bundle_checksum: bundleInfo?.bundle_checksum || null,
        parent_event_id: parentEventId || null
      }],
      suppressDeltaQueue
    });
  } else {
    return await _executeAtomicSQLite({
      operations: [{
        storeName,
        id: entityId,
        operation,
        entity: finalEntity,
        expectedBaseEntity: preExistingEntity,
        base_checksum: baseChecksum,
        new_checksum: newChecksum,
        tombstoneType,
        bundle_id: bundleInfo?.bundle_id || null,
        bundle_index: bundleInfo?.bundle_index || 0,
        bundle_total: bundleInfo?.bundle_total || 1,
        bundle_checksum: bundleInfo?.bundle_checksum || null,
        parent_event_id: parentEventId || null
      }],
      suppressDeltaQueue
    });
  }
}

/**
 * Executes an atomic batch of operations in exactly ONE transaction.
 */
export async function executeAtomicBatch({
  operations = [], // Array of { storeName, id, operation, entity, expectedBaseEntity, tombstoneType, bundleInfo }
  bundleId = null,
  suppressDeltaQueue = false
}) {
  if (!operations || operations.length === 0) return [];

  // Compute checksums for all operations asynchronously
  const preparedOps = [];
  const totalInBundle = bundleId ? operations.length : 1;

  const db = getDB();
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    let baseEntity = op.expectedBaseEntity || null;
    if (!baseEntity && !op.base_checksum && (op.operation === DELTA_OPERATION.DELETE || op.operation === DELTA_OPERATION.UPDATE)) {
      try {
        const res = await db.query(`SELECT * FROM ${op.storeName} WHERE id = ?`, [op.id]);
        baseEntity = res.values?.[0] || null;
      } catch {}
    }
    const baseChecksum = baseEntity
      ? await computeCanonicalSha256(baseEntity)
      : (op.base_checksum || null);
    const newChecksum = (op.operation !== DELTA_OPERATION.DELETE && op.entity)
      ? await computeCanonicalSha256(op.entity)
      : null;

    preparedOps.push({
      ...op,
      expectedBaseEntity: baseEntity,
      base_checksum: baseChecksum,
      new_checksum: newChecksum,
      bundle_id: op.bundle_id || bundleId || null,
      bundle_index: op.bundle_index !== undefined ? op.bundle_index : (bundleId ? i : 0),
      bundle_total: op.bundle_total !== undefined ? op.bundle_total : totalInBundle,
      bundle_checksum: op.bundle_checksum || null
    });
  }

  const isWeb = Capacitor.getPlatform() === 'web';
  if (isWeb) {
    return await _executeAtomicIDB({ operations: preparedOps, suppressDeltaQueue });
  } else {
    return await _executeAtomicSQLite({ operations: preparedOps, suppressDeltaQueue });
  }
}

/**
 * Native IndexedDB Atomic Multi-Store Transaction Executor
 */
async function _executeAtomicIDB({ operations, suppressDeltaQueue = false }) {
  const rawIdb = getRawIDB() || await openIDBInstance();
  const targetStores = new Set(suppressDeltaQueue ? [] : ['sync_delta_queue', 'sync_local_state', 'sync_tombstones']);

  for (const op of operations) {
    targetStores.add(op.storeName);
    if (op.tombstoneType && suppressDeltaQueue) {
      targetStores.add('sync_tombstones');
    }
  }

  return new Promise((resolve, reject) => {
    const storeNames = Array.from(targetStores);
    let tx;
    try {
      tx = rawIdb.transaction(storeNames, 'readwrite');
    } catch (err) {
      return reject(new Error(`Failed to create IDB transaction across stores [${storeNames.join(', ')}]: ${err.message}`));
    }

    if (suppressDeltaQueue) {
      try {
        const tombstoneStore = targetStores.has('sync_tombstones') ? tx.objectStore('sync_tombstones') : null;
        const now = new Date().toISOString();

        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          const currentStore = tx.objectStore(op.storeName);

          if (op.operation === DELTA_OPERATION.DELETE) {
            currentStore.delete(op.id);
            if (op.tombstoneType && tombstoneStore) {
              tombstoneStore.put({
                id: String(op.id),
                entity_type: String(op.tombstoneType),
                deleted_at: now
              });
            }
          } else if (op.entity) {
            currentStore.put(op.entity);
          }
        }

        tx.oncomplete = () => resolve([]);
        tx.onerror = (e) => reject(tx.error || e.target?.error || new Error('Transaction error'));
        tx.onabort = () => reject(new Error('Transaction aborted'));
      } catch (err) {
        try { tx.abort(); } catch {}
        reject(err);
      }
      return;
    }

    const stateStore = tx.objectStore('sync_local_state');
    const queueStore = tx.objectStore('sync_delta_queue');
    const tombstoneStore = tx.objectStore('sync_tombstones');

    const stateReq = stateStore.get('device_state');

    stateReq.onsuccess = () => {
      try {
        let state = stateReq.result;
        if (!state) {
          state = {
            key: 'device_state',
            device_id: `dev_${uuid().replace(/-/g, '').slice(0, 12)}`,
            last_allocated_sequence: 0,
            last_pushed_sequence: 0,
            updated_at: new Date().toISOString()
          };
        }

        const startSeq = state.last_allocated_sequence || 0;
        const emittedEvents = [];
        const now = new Date().toISOString();

        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          const currentStore = tx.objectStore(op.storeName);
          const seq = startSeq + i + 1;

          // Optimistic Precondition Validation inside transaction
          if (op.operation === DELTA_OPERATION.UPDATE || op.operation === DELTA_OPERATION.DELETE) {
            if (op.expectedBaseEntity) {
              const getReq = currentStore.get(op.id);
              getReq.onsuccess = () => {
                try {
                  const inDb = getReq.result;
                  const jsonInDb = toCanonicalJson(inDb);
                  const jsonExpected = toCanonicalJson(op.expectedBaseEntity);
                  if (jsonInDb !== jsonExpected) {
                    try { tx.abort(); } catch {}
                    return reject(new Error('PRECONDITION_FAILED'));
                  }
                } catch (e) {
                  try { tx.abort(); } catch {}
                  reject(e);
                }
              };
            }
          }

          // Entity Mutation
          if (op.operation === DELTA_OPERATION.DELETE) {
            currentStore.delete(op.id);
            if (op.tombstoneType) {
              tombstoneStore.put({
                id: String(op.id),
                entity_type: String(op.tombstoneType),
                deleted_at: now
              });
            }
          } else if (op.entity) {
            currentStore.put(op.entity);
          }

          // Delta Event
          const event = createDeltaEvent({
            event_id: op.event_id || uuid(),
            device_id: state.device_id,
            sequence: seq,
            timestamp: now,
            collection: op.storeName,
            entity_id: op.id,
            operation: op.operation,
            base_checksum: op.base_checksum,
            new_checksum: op.new_checksum,
            tombstone_generation: op.tombstone_generation || 0,
            payload: op.operation === DELTA_OPERATION.DELETE ? null : op.entity,
            status: DELTA_STATUS.PENDING,
            bundle_id: op.bundle_id || null,
            bundle_index: op.bundle_index || 0,
            bundle_total: op.bundle_total || 1,
            bundle_checksum: op.bundle_checksum || null,
            parent_event_id: op.parent_event_id || null
          });

          queueStore.put(event);
          emittedEvents.push(event);
        }

        // Update durable sequence state
        state.last_allocated_sequence = startSeq + operations.length;
        state.updated_at = now;
        stateStore.put(state);

        tx.oncomplete = () => {
          try {
            scheduleSync(SYNC_TRIGGER.MUTATION);
          } catch (e) {
            console.warn('[AtomicMutation] Failed to schedule sync on mutation:', e);
          }
          resolve(emittedEvents);
        };
      } catch (err) {
        try { tx.abort(); } catch {}
        reject(err);
      }
    };

    tx.onerror = (e) => reject(tx.error || e.target?.error || new Error('Transaction error'));
    tx.onabort = (e) => reject(new Error('Transaction aborted'));
  });
}

/**
 * Native SQLite Atomic Batch Transaction Executor
 */
async function _executeAtomicSQLite({ operations, suppressDeltaQueue = false }) {
  const db = getDB();
  const now = new Date().toISOString();

  if (suppressDeltaQueue) {
    const statements = [];
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op.operation === DELTA_OPERATION.DELETE) {
        statements.push({
          statement: `DELETE FROM ${op.storeName} WHERE id = ?`,
          values: [op.id]
        });
        if (op.tombstoneType) {
          statements.push({
            statement: 'INSERT OR REPLACE INTO sync_tombstones (id, entity_type, deleted_at) VALUES (?, ?, ?)',
            values: [String(op.id), String(op.tombstoneType), now]
          });
        }
      } else if (op.entity) {
        const keys = Object.keys(op.entity);
        const cols = keys.join(', ');
        const placeholders = keys.map(() => '?').join(', ');
        statements.push({
          statement: `INSERT OR REPLACE INTO ${op.storeName} (${cols}) VALUES (${placeholders})`,
          values: keys.map(k => op.entity[k] ?? null)
        });
      }
    }

    if (typeof db.executeSet === 'function') {
      await db.executeSet(statements);
    } else {
      for (const stmt of statements) {
        await db.run(stmt.statement, stmt.values);
      }
    }
    return [];
  }

  // Read current sequence state
  const stateRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
  let state = stateRes.values?.[0];
  if (!state) {
    state = {
      key: 'device_state',
      device_id: `dev_${uuid().replace(/-/g, '').slice(0, 12)}`,
      last_allocated_sequence: 0,
      last_pushed_sequence: 0,
      updated_at: now
    };
    await db.run(
      'INSERT OR IGNORE INTO sync_local_state (key, device_id, last_allocated_sequence, last_pushed_sequence, updated_at) VALUES (?, ?, ?, ?, ?)',
      [state.key, state.device_id, state.last_allocated_sequence, state.last_pushed_sequence, state.updated_at]
    );
  }

  const startSeq = Number(state.last_allocated_sequence) || 0;
  const statements = [];
  const emittedEvents = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const seq = startSeq + i + 1;

    if (op.operation === DELTA_OPERATION.DELETE) {
      statements.push({
        statement: `DELETE FROM ${op.storeName} WHERE id = ?`,
        values: [op.id]
      });
      if (op.tombstoneType) {
        statements.push({
          statement: 'INSERT OR REPLACE INTO sync_tombstones (id, entity_type, deleted_at) VALUES (?, ?, ?)',
          values: [String(op.id), String(op.tombstoneType), now]
        });
      }
    } else if (op.entity) {
      const keys = Object.keys(op.entity);
      const cols = keys.join(', ');
      const placeholders = keys.map(() => '?').join(', ');
      statements.push({
        statement: `INSERT OR REPLACE INTO ${op.storeName} (${cols}) VALUES (${placeholders})`,
        values: keys.map(k => op.entity[k] ?? null)
      });
    }

    const event = createDeltaEvent({
      event_id: op.event_id || uuid(),
      device_id: state.device_id,
      sequence: seq,
      timestamp: now,
      collection: op.storeName,
      entity_id: op.id,
      operation: op.operation,
      base_checksum: op.base_checksum,
      new_checksum: op.new_checksum,
      tombstone_generation: op.tombstone_generation || 0,
      payload: op.operation === DELTA_OPERATION.DELETE ? null : op.entity,
      status: DELTA_STATUS.PENDING,
      bundle_id: op.bundle_id || null,
      bundle_index: op.bundle_index || 0,
      bundle_total: op.bundle_total || 1,
      bundle_checksum: op.bundle_checksum || null,
      parent_event_id: op.parent_event_id || null
    });

    statements.push({
      statement: `INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, tombstone_generation, payload, status, bundle_id, bundle_index, bundle_total, bundle_checksum, parent_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        event.event_id, event.device_id, event.sequence, event.timestamp,
        event.collection, event.entity_id, event.operation,
        event.base_checksum, event.new_checksum, event.tombstone_generation,
        JSON.stringify(event.payload), event.status, event.bundle_id,
        event.bundle_index, event.bundle_total, event.bundle_checksum,
        event.parent_event_id
      ]
    });
    emittedEvents.push(event);
  }

  const endSeq = startSeq + operations.length;
  statements.push({
    statement: 'UPDATE sync_local_state SET last_allocated_sequence = ?, updated_at = ? WHERE key = ?',
    values: [endSeq, now, 'device_state']
  });

  if (typeof db.executeSet === 'function') {
    await db.executeSet(statements);
  } else {
    // Fallback runner
    for (const stmt of statements) {
      await db.run(stmt.statement, stmt.values);
    }
  }

  try {
    scheduleSync(SYNC_TRIGGER.MUTATION);
  } catch (e) {
    console.warn('[AtomicMutation] Failed to schedule sync on mutation:', e);
  }

  return emittedEvents;
}
