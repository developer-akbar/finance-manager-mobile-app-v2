/**
 * tombstones.js — Persistent Deletion Markers for Cross-Device Synchronization
 * 
 * Tracks deleted entities (transactions, inventory items, accounts, categories)
 * so deletions propagate faithfully across devices instead of resurrecting deleted records.
 */

import { getDB } from './db.js';

export const recordTombstone = async (id, entityType = 'transaction') => {
  if (!id) return;
  try {
    const db = getDB();
    const now = new Date().toISOString();
    await db.run(
      'INSERT OR REPLACE INTO sync_tombstones (id, entity_type, deleted_at) VALUES (?, ?, ?)',
      [String(id), String(entityType), now]
    );
  } catch (err) {
    console.warn('Failed to record tombstone:', err);
  }
};

export const recordTombstonesBatch = async (ids, entityType = 'transaction') => {
  if (!Array.isArray(ids) || ids.length === 0) return;
  try {
    const db = getDB();
    const now = new Date().toISOString();
    for (const id of ids) {
      if (id) {
        await db.run(
          'INSERT OR REPLACE INTO sync_tombstones (id, entity_type, deleted_at) VALUES (?, ?, ?)',
          [String(id), String(entityType), now]
        );
      }
    }
  } catch (err) {
    console.warn('Failed to record batch tombstones:', err);
  }
};

export const getTombstones = async () => {
  try {
    const db = getDB();
    const res = await db.query('SELECT * FROM sync_tombstones');
    return res.values || [];
  } catch (err) {
    console.warn('Failed to fetch tombstones:', err);
    return [];
  }
};

export const getTombstoneIds = async (entityType = null) => {
  try {
    const db = getDB();
    let sql = 'SELECT id FROM sync_tombstones';
    const params = [];
    if (entityType) {
      sql += ' WHERE entity_type = ?';
      params.push(entityType);
    }
    const res = await db.query(sql, params);
    return new Set((res.values || []).map(r => r.id));
  } catch (err) {
    console.warn('Failed to fetch tombstone IDs:', err);
    return new Set();
  }
};

export const pruneOldTombstones = async (maxAgeDays = 90) => {
  try {
    const db = getDB();
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    await db.run('DELETE FROM sync_tombstones WHERE deleted_at < ?', [cutoff]);
  } catch (err) {
    console.warn('Failed to prune old tombstones:', err);
  }
};
