/**
 * bookmarks.js — Reusable Transaction Templates model and persistence
 *
 * A Bookmark is an independent transaction template. It is stored separately
 * from financial transactions. Creating a transaction from a bookmark creates a
 * fresh, standalone transaction record and never mutates the bookmark.
 */
import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';
import { executeAtomicMutation } from './atomicMutation.js';

export const applyBookmarksSchema = async (db) => {
  await db.execute(`CREATE TABLE IF NOT EXISTS transaction_bookmarks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transaction_type TEXT DEFAULT 'Expense',
    template_data TEXT NOT NULL,
    source_transaction_id TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    usage_count INTEGER DEFAULT 0,
    last_used_at TEXT DEFAULT '',
    created_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
  );`);
};

export const normalizeBookmark = (raw) => {
  if (!raw) return null;
  let tData = raw.template_data || raw.templateData;
  if (typeof tData === 'string') {
    try {
      tData = JSON.parse(tData);
    } catch {
      tData = {};
    }
  } else if (!tData || typeof tData !== 'object') {
    tData = {};
  }

  return {
    id: raw.id || raw.ID || uuid(),
    name: String(raw.name || 'Untitled Bookmark').trim(),
    transaction_type: raw.transaction_type || raw.transactionType || tData.type || 'Expense',
    template_data: tData,
    source_transaction_id: String(raw.source_transaction_id || raw.sourceTransactionId || '').trim(),
    sort_order: typeof raw.sort_order === 'number' ? raw.sort_order : (parseInt(raw.sort_order, 10) || 0),
    usage_count: typeof raw.usage_count === 'number' ? raw.usage_count : (parseInt(raw.usage_count, 10) || 0),
    last_used_at: raw.last_used_at || '',
    created_at: raw.created_at || '',
    updated_at: raw.updated_at || ''
  };
};

export const getAllBookmarks = async () => {
  try {
    const db = getDB();
    const r = await db.query('SELECT * FROM transaction_bookmarks ORDER BY sort_order ASC, created_at DESC');
    return (r.values || []).map(normalizeBookmark);
  } catch (err) {
    console.error('[Bookmarks] Failed to fetch bookmarks:', err);
    return [];
  }
};

export const saveBookmark = async (bookmark) => {
  const db = getDB();
  const now = new Date().toISOString();
  const id = bookmark.id || uuid();

  // Determine sort_order if not provided
  let sortOrder = bookmark.sort_order;
  if (typeof sortOrder !== 'number') {
    try {
      const maxRes = await db.query('SELECT MAX(sort_order) AS max_sort FROM transaction_bookmarks');
      const maxVal = maxRes.values?.[0]?.max_sort;
      sortOrder = typeof maxVal === 'number' ? maxVal + 1 : 0;
    } catch {
      sortOrder = 0;
    }
  }

  const templateObj = typeof bookmark.template_data === 'object' && bookmark.template_data !== null
    ? bookmark.template_data
    : (typeof bookmark.template_data === 'string' ? JSON.parse(bookmark.template_data || '{}') : {});

  const cleanBookmark = {
    id,
    name: (bookmark.name || 'Untitled Bookmark').trim(),
    transaction_type: bookmark.transaction_type || templateObj.type || 'Expense',
    template_data: JSON.stringify(templateObj),
    source_transaction_id: bookmark.source_transaction_id || '',
    sort_order: sortOrder,
    usage_count: bookmark.usage_count || 0,
    last_used_at: bookmark.last_used_at || '',
    created_at: bookmark.created_at || now,
    updated_at: now
  };

  const existingRes = await db.query('SELECT id FROM transaction_bookmarks WHERE id = ?', [id]);
  const isExisting = (existingRes.values || []).length > 0;

  await executeAtomicMutation({
    storeName: 'transaction_bookmarks',
    entityId: id,
    operation: isExisting ? 'UPDATE' : 'INSERT',
    entityData: cleanBookmark
  });

  return normalizeBookmark(cleanBookmark);
};

export const updateBookmark = async (id, updates) => {
  const db = getDB();
  const existingList = await db.query('SELECT * FROM transaction_bookmarks WHERE id = ?', [id]);
  const existing = existingList.values?.[0];
  if (!existing) throw new Error(`Bookmark not found: ${id}`);

  const normalized = normalizeBookmark(existing);
  const now = new Date().toISOString();

  let mergedTemplate = normalized.template_data;
  if (updates.template_data) {
    mergedTemplate = {
      ...mergedTemplate,
      ...(typeof updates.template_data === 'object' ? updates.template_data : JSON.parse(updates.template_data || '{}'))
    };
  }

  const cleanBookmark = {
    id,
    name: updates.name !== undefined ? updates.name.trim() : normalized.name,
    transaction_type: updates.transaction_type || updates.transactionType || normalized.transaction_type,
    template_data: JSON.stringify(mergedTemplate),
    source_transaction_id: updates.source_transaction_id !== undefined ? updates.source_transaction_id : normalized.source_transaction_id,
    sort_order: updates.sort_order !== undefined ? Number(updates.sort_order) : normalized.sort_order,
    usage_count: updates.usage_count !== undefined ? Number(updates.usage_count) : normalized.usage_count,
    last_used_at: updates.last_used_at !== undefined ? updates.last_used_at : normalized.last_used_at,
    created_at: normalized.created_at || now,
    updated_at: now
  };

  await executeAtomicMutation({
    storeName: 'transaction_bookmarks',
    entityId: id,
    operation: 'UPDATE',
    entityData: cleanBookmark
  });

  return normalizeBookmark(cleanBookmark);
};

export const deleteBookmark = async (id) => {
  await executeAtomicMutation({
    storeName: 'transaction_bookmarks',
    entityId: id,
    operation: 'DELETE',
    tombstoneType: 'transaction_bookmarks'
  });
  return true;
};

export const duplicateBookmark = async (id, customName = null) => {
  const db = getDB();
  const existingList = await db.query('SELECT * FROM transaction_bookmarks WHERE id = ?', [id]);
  const existing = existingList.values?.[0];
  if (!existing) throw new Error(`Bookmark not found: ${id}`);

  const normalized = normalizeBookmark(existing);
  const now = new Date().toISOString();
  const newId = uuid();
  const newName = customName || `${normalized.name} (Copy)`;

  let nextSort = normalized.sort_order + 1;
  try {
    const maxRes = await db.query('SELECT MAX(sort_order) AS max_sort FROM transaction_bookmarks');
    const maxVal = maxRes.values?.[0]?.max_sort;
    if (typeof maxVal === 'number') nextSort = maxVal + 1;
  } catch {}

  const duplicated = {
    id: newId,
    name: newName.trim(),
    transaction_type: normalized.transaction_type,
    template_data: JSON.stringify(normalized.template_data),
    source_transaction_id: normalized.source_transaction_id,
    sort_order: nextSort,
    usage_count: 0,
    last_used_at: '',
    created_at: now,
    updated_at: now
  };

  await executeAtomicMutation({
    storeName: 'transaction_bookmarks',
    entityId: newId,
    operation: 'INSERT',
    entityData: duplicated
  });

  return normalizeBookmark(duplicated);
};

export const reorderBookmarks = async (orderedIds) => {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;
  const db = getDB();
  const now = new Date().toISOString();

  for (let idx = 0; idx < orderedIds.length; idx++) {
    const id = orderedIds[idx];
    try {
      const res = await db.query('SELECT * FROM transaction_bookmarks WHERE id = ?', [id]);
      const row = res.values?.[0];
      if (row) {
        const updated = {
          ...row,
          sort_order: idx,
          updated_at: now
        };
        await executeAtomicMutation({
          storeName: 'transaction_bookmarks',
          entityId: id,
          operation: 'UPDATE',
          entityData: updated
        });
      }
    } catch (err) {
      console.warn(`[Bookmarks] Failed to update sort_order for ${id}:`, err);
    }
  }
};

export const recordBookmarkUsage = async (id) => {
  try {
    const db = getDB();
    const res = await db.query('SELECT * FROM transaction_bookmarks WHERE id = ?', [id]);
    const row = res.values?.[0];
    if (row) {
      const now = new Date().toISOString();
      const updated = {
        ...row,
        usage_count: (Number(row.usage_count) || 0) + 1,
        last_used_at: now,
        updated_at: now
      };
      await executeAtomicMutation({
        storeName: 'transaction_bookmarks',
        entityId: id,
        operation: 'UPDATE',
        entityData: updated
      });
      return normalizeBookmark(updated);
    }
  } catch (err) {
    console.warn(`[Bookmarks] Failed to record usage for ${id}:`, err);
  }
  return null;
};

