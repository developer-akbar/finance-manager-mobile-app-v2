/**
 * entityDiff.js — Granular Entity Diff Engine for Replace-All Operations
 * 
 * Computes deterministic INSERT, UPDATE, DELETE, and UNCHANGED operations
 * between pre-existing entity sets and incoming replacement sets using
 * Canonicalization v1 fingerprints.
 */

import { toCanonicalJson, computeCanonicalSha256 } from './canonicalEntity.js';

export async function computeEntityDiff(oldEntities = [], newEntities = [], idField = 'id') {
  const oldList = Array.isArray(oldEntities) ? oldEntities : [];
  const newList = Array.isArray(newEntities) ? newEntities : [];

  const oldMap = new Map();
  for (const item of oldList) {
    if (item && item[idField] !== undefined && item[idField] !== null) {
      oldMap.set(String(item[idField]), item);
    }
  }

  const newMap = new Map();
  for (const item of newList) {
    if (item && item[idField] !== undefined && item[idField] !== null) {
      newMap.set(String(item[idField]), item);
    }
  }

  const inserts = [];
  const updates = [];
  const deletes = [];
  const unchanged = [];
  const operations = [];

  // 1. Identify INSERTs, UPDATEs, and UNCHANGED
  for (const [id, newItem] of newMap.entries()) {
    if (!oldMap.has(id)) {
      const newChecksum = await computeCanonicalSha256(newItem);
      const op = {
        operation: 'INSERT',
        id,
        entity: newItem,
        base_checksum: null,
        new_checksum: newChecksum
      };
      inserts.push(op);
      operations.push(op);
    } else {
      const oldItem = oldMap.get(id);
      const oldCanonical = toCanonicalJson(oldItem);
      const newCanonical = toCanonicalJson(newItem);

      if (oldCanonical === newCanonical) {
        unchanged.push({ id, entity: newItem });
      } else {
        const baseChecksum = await computeCanonicalSha256(oldItem);
        const newChecksum = await computeCanonicalSha256(newItem);
        const op = {
          operation: 'UPDATE',
          id,
          entity: newItem,
          oldEntity: oldItem,
          base_checksum: baseChecksum,
          new_checksum: newChecksum
        };
        updates.push(op);
        operations.push(op);
      }
    }
  }

  // 2. Identify DELETEs
  for (const [id, oldItem] of oldMap.entries()) {
    if (!newMap.has(id)) {
      const baseChecksum = await computeCanonicalSha256(oldItem);
      const op = {
        operation: 'DELETE',
        id,
        entity: oldItem,
        base_checksum: baseChecksum,
        new_checksum: null
      };
      deletes.push(op);
      operations.push(op);
    }
  }

  return {
    inserts,
    updates,
    deletes,
    unchanged,
    operations,
    hasChanges: operations.length > 0
  };
}
