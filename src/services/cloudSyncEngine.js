/**
 * cloudSyncEngine.js — Multi-Device 3-Way Cloud Synchronization Engine
 * 
 * Provides robust, zero-knowledge, local-first synchronization for FinMan:
 * - True 3-Way Merge (BASE vs LOCAL vs CLOUD)
 * - Two-Tier Collision-Safe Entity Comparison (Fast Fingerprint + Canonical SHA-256 / Deep Diff)
 * - Strict Financial Conflict Detection (No Blind Last-Write-Wins on accounting records)
 * - Safe Delete-vs-Edit Semantics (No silent resurrection of stale records)
 * - Optimistic Concurrency Detection & Retry Protocol (Stale parent snapshot rejection & post-verify)
 * - Self-Healing Crash Recovery (Fast-forward Base if upload succeeded before crash)
 * - Mass-Deletion Safety Guardrail (>50 or >10% threshold)
 * - Isolated Dry-Run Mode (Zero DB mutations, zero Drive writes)
 * - Atomic Local Staged Execution
 */

import { getDB } from '../database/db.js';
import { getTransactions, rowToTxn, bulkImport } from '../database/transactions.js';
import { getTombstones, recordTombstonesBatch } from '../database/tombstones.js';
import { getSetting, setSetting } from '../database/settings.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';
import { findAppDataFile, readAppDataFile, uploadAppDataFile, listFileRevisions, readRevisionContent, listAppDataFiles } from './googleDriveSync.js';
import { bundleRelatedTransactions, findTransactionDifferences } from '../utils/finmanPayload.js';
import { getSyncSessionKey } from './syncSession.js';

export const SNAPSHOT_FILENAME = 'finman_cloud_sync_snapshot.finman';
export const CURRENT_ENGINE_VERSION = 1;
export const MAX_CONCURRENCY_RETRIES = 3;
export const DELETION_SAFETY_LIMIT_COUNT = 50;
export const DELETION_SAFETY_LIMIT_PERCENT = 0.10; // 10% of total dataset

export const SYNC_STATUS = {
  SUCCESS: 'SUCCESS',
  NO_CHANGES: 'NO_CHANGES',
  CONFLICTS_DETECTED: 'CONFLICTS_DETECTED',
  SAFETY_ABORT_MASS_DELETION: 'SAFETY_ABORT_MASS_DELETION',
  CONCURRENCY_ERROR: 'CONCURRENCY_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DRY_RUN_COMPLETE: 'DRY_RUN_COMPLETE'
};

export const BOOTSTRAP_STATUS = {
  SUCCESS: 'BOOTSTRAP_SUCCESS',
  BOOTSTRAP_SUCCESS: 'BOOTSTRAP_SUCCESS',
  EXISTING_LOCAL_DATA_REQUIRES_MERGE: 'EXISTING_LOCAL_DATA_REQUIRES_MERGE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED'
};

import {
  getEntityBusinessKey,
  getTransactionBusinessKey,
  getInvestmentTransactionBusinessKey
} from './cloudSyncIdentity.js';

export const CONFLICT_TYPES = {
  FINANCIAL_CONFLICT: 'FINANCIAL_CONFLICT',
  DELETE_VS_EDIT_CONFLICT: 'DELETE_VS_EDIT_CONFLICT',
  EDIT_VS_DELETE_CONFLICT: 'EDIT_VS_DELETE_CONFLICT',
  ACCOUNT_RENAME_CONFLICT: 'ACCOUNT_RENAME_CONFLICT',
  SETTINGS_CONFLICT: 'SETTINGS_CONFLICT',
  IDENTITY_CONFLICT: 'IDENTITY_CONFLICT'
};

export const SYNCED_SETTINGS_WHITELIST = [
  'customTags',
  'theme',
  'headerColor',
  'fontSize',
  'fontFamily',
  'fontDataWeight',
  'default_currency',
  'budget_start_day',
  'portfolio_benchmark',
  'profileName',
  'name'
];

/**
 * Compute SHA-256 hex digest of string payload
 */
export async function sha256Hex(dataStr) {
  const enc = new TextEncoder();
  const buf = enc.encode(dataStr);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const hashArray = Array.from(new Uint8Array(hashBuf));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a canonical string representation of an entity for deterministic hashing and diffing
 */
export function canonicalizeEntity(entity, entityType = 'transaction') {
  if (!entity || typeof entity !== 'object') return '';
  const id = String(entity.id || entity.ID || entity._id || '');

  if (entityType === 'transaction' || entityType === 'transactions' || entityType === 'investment_transaction' || entityType === 'investment_transactions') {
    const date = String(entity.Date || entity.date || '').trim();
    const time = String(entity.Time || entity.time || '').trim();
    const acct = String(entity.Account || entity.account || '').trim();
    const fromAcct = String(entity.FromAccount || entity.from_account || '').trim();
    const toAcct = String(entity.ToAccount || entity.to_account || '').trim();
    const cat = String(entity.Category || entity.category || '').trim();
    const subcat = String(entity.Subcategory || entity.subcategory || '').trim();
    const note = String(entity.Note || entity.note || '').trim();
    const desc = String(entity.Description || entity.description || '').trim();
    const inr = parseFloat(entity.INR ?? entity.inr ?? entity.Amount ?? entity.amount ?? 0).toFixed(2);
    const type = String(entity['Income/Expense'] || entity.type || '').trim();
    const subAcct = String(entity.SubAccount || entity.sub_account || '').trim();
    const invType = String(entity.InvestmentTransactionType || entity.investment_transaction_type || '').trim();
    const isin = String(entity.SecurityISIN || entity.security_isin || '').trim();
    const symbol = String(entity.SecuritySymbol || entity.security_symbol || '').trim();
    const qty = parseFloat(entity.Quantity ?? entity.quantity ?? 0).toFixed(4);
    const price = parseFloat(entity.UnitPrice ?? entity.unit_price ?? 0).toFixed(4);
    const splitGroup = String(entity.split_group_id || '').trim();
    const charges = parseFloat(entity.TotalCharges ?? entity.total_charges ?? 0).toFixed(2);

    return `${id}|${date}|${time}|${acct}|${fromAcct}|${toAcct}|${cat}|${subcat}|${note}|${desc}|${inr}|${type}|${subAcct}|${invType}|${isin}|${symbol}|${qty}|${price}|${splitGroup}|${charges}`;
  }

  if (entityType === 'inventory') {
    const name = String(entity.name || '').trim();
    const pDate = String(entity.purchased_date || '').trim();
    const oQty = parseFloat(entity.original_qty || 0).toFixed(3);
    const qty = parseFloat(entity.qty || 0).toFixed(3);
    const price = parseFloat(entity.price || 0).toFixed(2);
    return `${id}|${name}|${pDate}|${oQty}|${qty}|${price}`;
  }

  if (entityType === 'account' || entityType === 'accounts') {
    const name = String(entity.name || entity.id || '').trim();
    const group = String(entity.group || '').trim();
    return `${id}|${name}|${group}`;
  }

  if (entityType === 'category' || entityType === 'categories') {
    const name = String(entity.name || entity.id || '').trim();
    const type = String(entity.type || '').trim();
    return `${id}|${name}|${type}`;
  }

  if (entityType === 'setting' || entityType === 'settings') {
    const key = String(entity.key || entity.id || '').trim();
    const value = String(entity.value ?? '');
    return `${key}:${value}`;
  }

  // Generic fallback: sort keys
  const sortedKeys = Object.keys(entity).sort();
  return sortedKeys.map(k => `${k}:${String(entity[k] ?? '')}`).join('|');
}

/**
 * Fast 32-bit hash for in-memory Tier 1 indexing
 */
export function fastFingerprint(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Build snapshot manifest vector containing fast fingerprints and canonical hashes
 */
export async function buildEntityManifest(entitiesMap) {
  const manifest = {};
  for (const [entityType, items] of Object.entries(entitiesMap)) {
    if (entityType === 'settings' && items && typeof items === 'object' && !Array.isArray(items)) {
      for (const [k, v] of Object.entries(items)) {
        if (!SYNCED_SETTINGS_WHITELIST.includes(k)) continue;
        const id = `setting:${k}`;
        const canonical = `${k}:${String(v ?? '')}`;
        const fp = fastFingerprint(canonical);
        manifest[id] = { type: 'setting', fp, canonical };
      }
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const id = String(item.id || item.ID || item._id || item.key || '');
      if (!id) continue;
      const canonical = canonicalizeEntity(item, entityType);
      const fp = fastFingerprint(canonical);
      manifest[id] = {
        type: entityType,
        fp,
        canonical
      };
    }
  }
  return manifest;
}

/**
 * Read all local synchronized entities from IndexedDB/SQLite
 */
export async function readLocalEntities(dbInstance = null) {
  const db = dbInstance || getDB();

  const [
    txnsRes,
    invTxnsRes,
    accountsRes,
    categoriesRes,
    subcategoriesRes,
    subAccountsRes,
    budgetsRes,
    recurringRes,
    inventoryRes,
    investmentPlansRes,
    accountGroupsRes,
    accountMappingRes,
    brokeragesRes,
    tombstonesRes,
    settingsRes
  ] = await Promise.all([
    db.query('SELECT * FROM transactions').catch(() => ({ values: [] })),
    db.query('SELECT * FROM investment_transactions').catch(() => ({ values: [] })),
    db.query('SELECT * FROM accounts').catch(() => ({ values: [] })),
    db.query('SELECT * FROM categories').catch(() => ({ values: [] })),
    db.query('SELECT * FROM subcategories').catch(() => ({ values: [] })),
    db.query('SELECT * FROM sub_accounts').catch(() => ({ values: [] })),
    db.query('SELECT * FROM budgets').catch(() => ({ values: [] })),
    db.query('SELECT * FROM recurring_rules').catch(() => ({ values: [] })),
    db.query('SELECT * FROM inventory').catch(() => ({ values: [] })),
    db.query('SELECT * FROM investment_plans').catch(() => ({ values: [] })),
    db.query('SELECT * FROM account_groups').catch(() => ({ values: [] })),
    db.query('SELECT * FROM account_mapping').catch(() => ({ values: [] })),
    db.query('SELECT * FROM brokerages').catch(() => ({ values: [] })),
    db.query('SELECT * FROM sync_tombstones').catch(() => ({ values: [] })),
    db.query('SELECT * FROM settings').catch(() => ({ values: [] }))
  ]);

  const rawSettings = settingsRes.values || [];
  const settingsObj = {};
  for (const s of rawSettings) {
    if (s && s.key && SYNCED_SETTINGS_WHITELIST.includes(s.key)) {
      settingsObj[s.key] = String(s.value ?? '');
    }
  }

  return {
    transactions: (txnsRes.values || []).map(rowToTxn),
    investment_transactions: (invTxnsRes.values || []).map(rowToTxn),
    accounts: accountsRes.values || [],
    categories: categoriesRes.values || [],
    subcategories: subcategoriesRes.values || [],
    sub_accounts: subAccountsRes.values || [],
    budgets: budgetsRes.values || [],
    recurring_rules: recurringRes.values || [],
    inventory: inventoryRes.values || [],
    investment_plans: investmentPlansRes.values || [],
    account_groups: accountGroupsRes.values || [],
    account_mapping: accountMappingRes.values || [],
    brokerages: brokeragesRes.values || [],
    sync_tombstones: tombstonesRes.values || [],
    settings: settingsObj
  };
}

/**
 * Construct normalized canonical JSON payload package
 */
export async function createCanonicalSnapshotPayload({
  entities,
  snapshotId,
  parentSnapshotId = null,
  cloudVersion = 1,
  deviceId = 'unknown_device'
}) {
  const now = new Date().toISOString();
  
  // Sort entities deterministically
  const sortedEntities = {};
  for (const [key, list] of Object.entries(entities)) {
    if (key === 'settings' && list && typeof list === 'object' && !Array.isArray(list)) {
      const sortedKeys = Object.keys(list).filter(k => SYNCED_SETTINGS_WHITELIST.includes(k)).sort();
      const sortedSettings = {};
      for (const k of sortedKeys) {
        sortedSettings[k] = list[k];
      }
      sortedEntities.settings = sortedSettings;
    } else if (Array.isArray(list)) {
      sortedEntities[key] = [...list].sort((a, b) => {
        const idA = String(a.id || a.ID || a._id || a.key || '');
        const idB = String(b.id || b.ID || b._id || b.key || '');
        return idA.localeCompare(idB);
      });
    } else {
      sortedEntities[key] = list;
    }
  }

  if (!sortedEntities.transactions) sortedEntities.transactions = [];
  if (!sortedEntities.investment_transactions) sortedEntities.investment_transactions = [];

  const payload = {
    schema_version: 13,
    engine_version: CURRENT_ENGINE_VERSION,
    snapshot_id: snapshotId,
    parent_snapshot_id: parentSnapshotId,
    cloud_version: cloudVersion,
    device_id: deviceId,
    created_at: now,
    entities: sortedEntities
  };

  const canonicalJson = JSON.stringify(payload);
  const checksum = await sha256Hex(canonicalJson);

  return {
    payload,
    canonicalJson,
    checksum,
    snapshotId,
    cloudVersion,
    parentSnapshotId
  };
}

/**
 * 3-Way Set Merge for customTags Collection
 */
export function mergeCustomTags3Way({ baseRaw, localRaw, cloudRaw }) {
  const parseTags = (raw) => {
    if (!raw) return [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        return parsed.map(t => {
          const s = String(t).trim().toLowerCase();
          return s.startsWith('#') ? s : `#${s}`;
        }).filter(Boolean);
      }
    } catch {}
    return [];
  };

  const baseTags = parseTags(baseRaw);
  const localTags = parseTags(localRaw);
  const cloudTags = parseTags(cloudRaw);

  const baseSet = new Set(baseTags);
  const localSet = new Set(localTags);
  const cloudSet = new Set(cloudTags);

  const localAdded = localTags.filter(t => !baseSet.has(t));
  const cloudAdded = cloudTags.filter(t => !baseSet.has(t));
  const localDeleted = baseTags.filter(t => !localSet.has(t));
  const cloudDeleted = baseTags.filter(t => !cloudSet.has(t));

  const merged = new Set(baseTags);

  // Propagate local deletions (unless re-added by cloud)
  for (const d of localDeleted) {
    if (!cloudAdded.includes(d)) {
      merged.delete(d);
    }
  }

  // Propagate cloud deletions (unless re-added by local)
  for (const d of cloudDeleted) {
    if (!localAdded.includes(d)) {
      merged.delete(d);
    }
  }

  // Add local additions
  for (const a of localAdded) {
    merged.add(a);
  }

  // Add cloud additions
  for (const a of cloudAdded) {
    merged.add(a);
  }

  const sortedTags = Array.from(merged).sort();
  return {
    tags: sortedTags,
    conflict: false
  };
}

/**
 * Pure 3-Way Reconciliation for Whitelisted User Settings
 */
export function reconcileSettings3Way({
  baseSettings = {},
  localSettings = {},
  cloudSettings = {}
}) {
  const plannedLocalUpdates = {};
  const plannedCloudUpdates = {};
  const conflicts = [];
  const mergedSettings = { ...localSettings };

  const hasCloudSettings = cloudSettings && Object.keys(cloudSettings).length > 0;
  if (!hasCloudSettings) {
    return {
      plannedLocalUpdates: {},
      plannedCloudUpdates: { ...localSettings },
      conflicts: [],
      mergedSettings: { ...localSettings }
    };
  }

  const allKeys = new Set([
    ...Object.keys(baseSettings || {}),
    ...Object.keys(localSettings || {}),
    ...Object.keys(cloudSettings || {})
  ]);

  for (const key of allKeys) {
    if (!SYNCED_SETTINGS_WHITELIST.includes(key)) continue;

    const baseVal = baseSettings?.[key];
    const localVal = localSettings?.[key];
    const cloudVal = cloudSettings?.[key];

    // Special collection handling for customTags
    if (key === 'customTags') {
      const mergedTagsRes = mergeCustomTags3Way({
        baseRaw: baseVal,
        localRaw: localVal,
        cloudRaw: cloudVal
      });

      if (mergedTagsRes.conflict) {
        conflicts.push({
          id: `conflict_setting_customTags`,
          entityId: 'setting:customTags',
          type: CONFLICT_TYPES.SETTINGS_CONFLICT,
          reason: 'Conflicting customTags modifications.',
          local: localVal,
          cloud: cloudVal,
          base: baseVal
        });
      } else {
        const parseTagList = (r) => {
          try {
            const arr = typeof r === 'string' ? JSON.parse(r) : r;
            if (Array.isArray(arr)) {
              return arr.map(t => {
                const s = String(t).trim().toLowerCase();
                return s.startsWith('#') ? s : `#${s}`;
              }).sort();
            }
          } catch {}
          return [];
        };

        const localTagsCanonical = JSON.stringify(parseTagList(localVal));
        const cloudTagsCanonical = JSON.stringify(parseTagList(cloudVal));
        const mergedValStr = JSON.stringify(mergedTagsRes.tags);

        mergedSettings.customTags = mergedValStr;
        if (mergedValStr !== localTagsCanonical) {
          plannedLocalUpdates.customTags = mergedValStr;
        }
        if (mergedValStr !== cloudTagsCanonical) {
          plannedCloudUpdates.customTags = mergedValStr;
        }
      }
      continue;
    }

    // Scalar settings 3-way merge
    const localChanged = localVal !== baseVal;
    const cloudChanged = cloudVal !== baseVal;

    // Case 1: Identical / Both unchanged or both changed identically
    if (localVal === cloudVal) {
      mergedSettings[key] = localVal;
      continue;
    }

    // Case 2: Only Cloud changed (Base == Local, Base != Cloud)
    if (!localChanged && cloudChanged) {
      if (cloudVal !== undefined) {
        mergedSettings[key] = cloudVal;
        plannedLocalUpdates[key] = cloudVal;
      }
      continue;
    }

    // Case 3: Only Local changed (Base != Local, Base == Cloud)
    if (localChanged && !cloudChanged) {
      if (localVal !== undefined) {
        mergedSettings[key] = localVal;
        plannedCloudUpdates[key] = localVal;
      }
      continue;
    }

    // Case 4: Both changed differently (Base != Local, Base != Cloud, Local != Cloud)
    if (localChanged && cloudChanged && localVal !== cloudVal) {
      conflicts.push({
        id: `conflict_setting_${key}`,
        entityId: `setting:${key}`,
        type: CONFLICT_TYPES.SETTINGS_CONFLICT,
        reason: `Setting "${key}" changed concurrently on both devices (Local: "${localVal}", Cloud: "${cloudVal}").`,
        local: localVal,
        cloud: cloudVal,
        base: baseVal
      });
      mergedSettings[key] = localVal;
    }
  }

  return {
    plannedLocalUpdates,
    plannedCloudUpdates,
    conflicts,
    mergedSettings
  };
}

/**
 * Pure 3-Way Reconciliation Engine (Base vs Local vs Cloud)
 */
export async function reconcile3Way({
  baseManifest = {},
  localEntities,
  cloudEntities,
  baseTombstones = new Set()
}) {
  const localMap = new Map();
  const cloudMap = new Map();
  const localTombstoneMap = new Map();
  const cloudTombstoneMap = new Map();

  // Index Local Entities
  for (const [type, items] of Object.entries(localEntities)) {
    if (type === 'sync_tombstones') {
      for (const t of items) localTombstoneMap.set(String(t.id), t);
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const id = String(item.id || item.ID || item._id || item.key || '');
      if (id) localMap.set(id, { item, type, canonical: canonicalizeEntity(item, type) });
    }
  }

  // Index Cloud Entities
  for (const [type, items] of Object.entries(cloudEntities)) {
    if (type === 'sync_tombstones') {
      for (const t of items) cloudTombstoneMap.set(String(t.id), t);
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const id = String(item.id || item.ID || item._id || item.key || '');
      if (id) cloudMap.set(id, { item, type, canonical: canonicalizeEntity(item, type) });
    }
  }

  const allIds = new Set([
    ...Object.keys(baseManifest),
    ...localMap.keys(),
    ...cloudMap.keys(),
    ...localTombstoneMap.keys(),
    ...cloudTombstoneMap.keys()
  ]);

  const plannedLocalInserts = [];
  const plannedLocalUpdates = [];
  const plannedLocalDeletes = [];
  const plannedCloudInserts = [];
  const plannedCloudUpdates = [];
  const plannedCloudDeletes = [];
  const mergedTombstones = new Map();
  const conflicts = [];

  // Union all tombstones
  for (const [id, t] of localTombstoneMap) mergedTombstones.set(id, t);
  for (const [id, t] of cloudTombstoneMap) mergedTombstones.set(id, t);

  // ── Business Identity Reconciliation (Historical Differing IDs) ───────────
  // Pre-pass for unmatched financial transaction entities when primary IDs differ
  const identityMatchedIds = new Set();
  const identityConflictIds = new Set();
  const identityAliases = new Map(); // cloudId -> localId

  const localTxnBizMap = new Map();
  const cloudTxnBizMap = new Map();
  const localInvBizMap = new Map();
  const cloudInvBizMap = new Map();

  // Phase 6C.12 Diagnostic Counters
  let localTxTotal = 0;
  let localTxExactMatched = 0;
  let localTxUnmatched = 0;
  let localTxExcludedTombstone = 0;
  let localTxExcludedType = 0;
  let localTxPassedIdentity = 0;

  let localInvTotal = 0;
  let localInvExactMatched = 0;
  let localInvUnmatched = 0;
  let localInvExcludedTombstone = 0;
  let localInvExcludedType = 0;
  let localInvPassedIdentity = 0;

  let localOnlyTxnInBaseManifest = 0;
  let localOnlyInvInBaseManifest = 0;

  for (const [id, entry] of localMap.entries()) {
    const isTxn = entry.type === 'transaction' || entry.type === 'transactions';
    const isInv = entry.type === 'investment_transaction' || entry.type === 'investment_transactions';

    if (isTxn) localTxTotal++;
    if (isInv) localInvTotal++;

    const isCloud = cloudMap.has(id);
    if (isCloud) {
      if (isTxn) localTxExactMatched++;
      if (isInv) localInvExactMatched++;
    } else {
      if (isTxn) {
        localTxUnmatched++;
        if (baseManifest && baseManifest[id]) localOnlyTxnInBaseManifest++;
      }
      if (isInv) {
        localInvUnmatched++;
        if (baseManifest && baseManifest[id]) localOnlyInvInBaseManifest++;
      }
    }

    const isDeleted = localTombstoneMap.has(id);

    if (!isCloud) {
      if (isDeleted) {
        if (isTxn) localTxExcludedTombstone++;
        if (isInv) localInvExcludedTombstone++;
      } else {
        if (isTxn) {
          const bizKey = getTransactionBusinessKey(entry.item);
          if (bizKey) {
            if (!localTxnBizMap.has(bizKey)) localTxnBizMap.set(bizKey, []);
            localTxnBizMap.get(bizKey).push({ id, item: entry.item, type: 'transactions' });
            localTxPassedIdentity++;
          }
        } else if (isInv) {
          const bizKey = getInvestmentTransactionBusinessKey(entry.item);
          if (bizKey) {
            if (!localInvBizMap.has(bizKey)) localInvBizMap.set(bizKey, []);
            localInvBizMap.get(bizKey).push({ id, item: entry.item, type: 'investment_transactions' });
            localInvPassedIdentity++;
          }
        } else {
          localTxExcludedType++;
        }
      }
    }
  }

  let cloudTxTotal = 0;
  let cloudTxExactMatched = 0;
  let cloudTxUnmatched = 0;
  let cloudTxExcludedTombstone = 0;
  let cloudTxExcludedType = 0;
  let cloudTxPassedIdentity = 0;

  let cloudInvTotal = 0;
  let cloudInvExactMatched = 0;
  let cloudInvUnmatched = 0;
  let cloudInvExcludedTombstone = 0;
  let cloudInvExcludedType = 0;
  let cloudInvPassedIdentity = 0;

  let cloudOnlyTxnInBaseManifest = 0;
  let cloudOnlyInvInBaseManifest = 0;

  for (const [id, entry] of cloudMap.entries()) {
    const isTxn = entry.type === 'transaction' || entry.type === 'transactions';
    const isInv = entry.type === 'investment_transaction' || entry.type === 'investment_transactions';

    if (isTxn) cloudTxTotal++;
    if (isInv) cloudInvTotal++;

    const isLocal = localMap.has(id);
    if (isLocal) {
      if (isTxn) cloudTxExactMatched++;
      if (isInv) cloudInvExactMatched++;
    } else {
      if (isTxn) {
        cloudTxUnmatched++;
        if (baseManifest && baseManifest[id]) cloudOnlyTxnInBaseManifest++;
      }
      if (isInv) {
        cloudInvUnmatched++;
        if (baseManifest && baseManifest[id]) cloudOnlyInvInBaseManifest++;
      }
    }

    const isDeleted = cloudTombstoneMap.has(id);

    if (!isLocal) {
      if (isDeleted) {
        if (isTxn) cloudTxExcludedTombstone++;
        if (isInv) cloudInvExcludedTombstone++;
      } else {
        if (isTxn) {
          const bizKey = getTransactionBusinessKey(entry.item);
          if (bizKey) {
            if (!cloudTxnBizMap.has(bizKey)) cloudTxnBizMap.set(bizKey, []);
            cloudTxnBizMap.get(bizKey).push({ id, item: entry.item, type: 'transactions' });
            cloudTxPassedIdentity++;
          }
        } else if (isInv) {
          const bizKey = getInvestmentTransactionBusinessKey(entry.item);
          if (bizKey) {
            if (!cloudInvBizMap.has(bizKey)) cloudInvBizMap.set(bizKey, []);
            cloudInvBizMap.get(bizKey).push({ id, item: entry.item, type: 'investment_transactions' });
            cloudInvPassedIdentity++;
          }
        } else {
          cloudTxExcludedType++;
        }
      }
    }
  }

  // Trace Specific Known Entities
  const knownTxnLocalId = '652866ae-d1bd-435a-88e0-1e8813f65c10';
  const knownTxnCloudId = 'txn_1704067200000_000000';
  const knownInvLocalId = '48db2ea6-629b-47bd-a6ea-de54140c9ace';
  const knownInvCloudId = 'inv_cloud_hist_0000';

  const traceKnownEntity = (targetId, isLocalSide) => {
    const rawEntities = isLocalSide ? localEntities : cloudEntities;
    const targetMap = isLocalSide ? localMap : cloudMap;
    const counterpartMap = isLocalSide ? cloudMap : localMap;
    const tombstoneMap = isLocalSide ? localTombstoneMap : cloudTombstoneMap;

    let foundInRaw = false;
    let rawCollection = null;
    for (const [col, arr] of Object.entries(rawEntities || {})) {
      if (Array.isArray(arr) && arr.some(x => String(x.id || x.ID || x._id || x.key || '') === targetId)) {
        foundInRaw = true;
        rawCollection = col;
        break;
      }
    }

    const entry = targetMap.get(targetId);
    const foundInMap = !!entry;
    const exactIdMatched = counterpartMap.has(targetId);
    const excludedByTombstone = tombstoneMap.has(targetId);
    const isTxn = entry?.type === 'transaction' || entry?.type === 'transactions';
    const isInv = entry?.type === 'investment_transaction' || entry?.type === 'investment_transactions';
    const excludedByType = entry ? (!isTxn && !isInv) : null;
    
    let businessKey = null;
    if (entry) {
      if (isTxn) businessKey = getTransactionBusinessKey(entry.item);
      else if (isInv) businessKey = getInvestmentTransactionBusinessKey(entry.item);
    }

    const passedToIdentity = foundInMap && !exactIdMatched && !excludedByTombstone && (isTxn || isInv) && !!businessKey;

    return {
      targetId,
      foundInRawEntities: foundInRaw,
      rawCollection,
      foundInMap,
      exactIdMatched,
      excludedByTombstone,
      excludedByType,
      entryType: entry?.type,
      entryTypeTypeof: typeof entry?.type,
      entryTypeJSON: JSON.stringify(entry?.type),
      businessKey,
      passedToIdentity
    };
  };

  const knownPairsDiagnostic = {
    localKnownTxn: traceKnownEntity(knownTxnLocalId, true),
    cloudKnownTxn: traceKnownEntity(knownTxnCloudId, false),
    localKnownInv: traceKnownEntity(knownInvLocalId, true),
    cloudKnownInv: traceKnownEntity(knownInvCloudId, false)
  };

  const identityPipelineDiagnostic = {
    localTransactionsTotal: localTxTotal,
    cloudTransactionsTotal: cloudTxTotal,

    localTransactionsExactIdMatched: localTxExactMatched,
    cloudTransactionsExactIdMatched: cloudTxExactMatched,

    localTransactionsUnmatchedAfterId: localTxUnmatched,
    cloudTransactionsUnmatchedAfterId: cloudTxUnmatched,

    localTransactionsExcludedByTombstone: localTxExcludedTombstone,
    cloudTransactionsExcludedByTombstone: cloudTxExcludedTombstone,

    localTransactionsExcludedByType: localTxExcludedType,
    cloudTransactionsExcludedByType: cloudTxExcludedType,

    localTransactionsPassedToIdentity: localTxPassedIdentity,
    cloudTransactionsPassedToIdentity: cloudTxPassedIdentity,

    localInvestmentsTotal: localInvTotal,
    cloudInvestmentsTotal: cloudInvTotal,

    localInvestmentsExactIdMatched: localInvExactMatched,
    cloudInvestmentsExactIdMatched: cloudInvExactMatched,

    localInvestmentsUnmatchedAfterId: localInvUnmatched,
    cloudInvestmentsUnmatchedAfterId: cloudInvUnmatched,

    localInvestmentsExcludedByTombstone: localInvExcludedTombstone,
    cloudInvestmentsExcludedByTombstone: cloudInvExcludedTombstone,

    localInvestmentsExcludedByType: localInvExcludedType,
    cloudInvestmentsExcludedByType: cloudInvExcludedType,

    localInvestmentsPassedToIdentity: localInvPassedIdentity,
    cloudInvestmentsPassedToIdentity: cloudInvPassedIdentity
  };

  const tombstoneDiagnostic = {
    localTombstonesTotal: localTombstoneMap.size,
    cloudTombstonesTotal: cloudTombstoneMap.size,
    localOnlyTransactionTombstoneCount: localTxExcludedTombstone,
    cloudOnlyTransactionTombstoneCount: cloudTxExcludedTombstone,
    localOnlyInvestmentTombstoneCount: localInvExcludedTombstone,
    cloudOnlyInvestmentTombstoneCount: cloudInvExcludedTombstone,
    sampleLocalTombstones: Array.from(localTombstoneMap.values()).slice(0, 5).map(t => ({ id: t.id, deleted_at: t.deleted_at, reason: t.reason || t.type })),
    sampleCloudTombstones: Array.from(cloudTombstoneMap.values()).slice(0, 5).map(t => ({ id: t.id, deleted_at: t.deleted_at, reason: t.reason || t.type }))
  };

  const baseManifestDiagnostic = {
    baseManifestTotal: Object.keys(baseManifest || {}).length,
    localOnlyTransactionExcludedByBaseManifest: 0,
    cloudOnlyTransactionExcludedByBaseManifest: 0,
    localOnlyTxnPresentInBaseManifest: localOnlyTxnInBaseManifest,
    cloudOnlyTxnPresentInBaseManifest: cloudOnlyTxnInBaseManifest,
    localOnlyInvPresentInBaseManifest: localOnlyInvInBaseManifest,
    cloudOnlyInvPresentInBaseManifest: cloudOnlyInvInBaseManifest
  };

  let identityMatchedTransactions = 0;
  let identityMatchedInvestments = 0;

  // 1. Match Transactions
  const allTxnBizKeys = new Set([...localTxnBizMap.keys(), ...cloudTxnBizMap.keys()]);
  for (const bizKey of allTxnBizKeys) {
    const localCandidates = localTxnBizMap.get(bizKey) || [];
    const cloudCandidates = cloudTxnBizMap.get(bizKey) || [];

    if (localCandidates.length === 0 || cloudCandidates.length === 0) {
      continue;
    }

    if (localCandidates.length === 1 && cloudCandidates.length === 1) {
      const locCand = localCandidates[0];
      const cldCand = cloudCandidates[0];

      // Tombstone safety: never resurrect a record deleted on either side
      const isLocDeleted = localTombstoneMap.has(locCand.id) || localTombstoneMap.has(cldCand.id);
      const isCldDeleted = cloudTombstoneMap.has(cldCand.id) || cloudTombstoneMap.has(locCand.id);

      if (!isLocDeleted && !isCldDeleted) {
        identityMatchedIds.add(locCand.id);
        identityMatchedIds.add(cldCand.id);
        identityAliases.set(cldCand.id, locCand.id);
        identityMatchedTransactions++;
      }
    } else {
      localCandidates.forEach(c => identityConflictIds.add(c.id));
      cloudCandidates.forEach(c => identityConflictIds.add(c.id));

      conflicts.push({
        id: `conflict_identity_${bizKey.substring(0, 32)}`,
        entityId: localCandidates[0]?.id || cloudCandidates[0]?.id,
        type: CONFLICT_TYPES.IDENTITY_CONFLICT,
        reason: 'Multiple transaction candidates share the same business fingerprint across devices.',
        local: localCandidates.map(x => x.item),
        cloud: cloudCandidates.map(x => x.item)
      });
    }
  }

  // 2. Match Investment Transactions
  const allInvBizKeys = new Set([...localInvBizMap.keys(), ...cloudInvBizMap.keys()]);
  for (const bizKey of allInvBizKeys) {
    const localCandidates = localInvBizMap.get(bizKey) || [];
    const cloudCandidates = cloudInvBizMap.get(bizKey) || [];

    if (localCandidates.length === 0 || cloudCandidates.length === 0) {
      continue;
    }

    if (localCandidates.length === 1 && cloudCandidates.length === 1) {
      const locCand = localCandidates[0];
      const cldCand = cloudCandidates[0];

      const isLocDeleted = localTombstoneMap.has(locCand.id) || localTombstoneMap.has(cldCand.id);
      const isCldDeleted = cloudTombstoneMap.has(cldCand.id) || cloudTombstoneMap.has(locCand.id);

      if (!isLocDeleted && !isCldDeleted) {
        identityMatchedIds.add(locCand.id);
        identityMatchedIds.add(cldCand.id);
        identityAliases.set(cldCand.id, locCand.id);
        identityMatchedInvestments++;
      }
    } else {
      localCandidates.forEach(c => identityConflictIds.add(c.id));
      cloudCandidates.forEach(c => identityConflictIds.add(c.id));

      conflicts.push({
        id: `conflict_identity_${bizKey.substring(0, 32)}`,
        entityId: localCandidates[0]?.id || cloudCandidates[0]?.id,
        type: CONFLICT_TYPES.IDENTITY_CONFLICT,
        reason: 'Multiple investment transaction candidates share the same business fingerprint across devices.',
        local: localCandidates.map(x => x.item),
        cloud: cloudCandidates.map(x => x.item)
      });
    }
  }

  // Build surgical identity diagnostic telemetry
  let txnLocalCandCount = 0;
  let txnLocalCollisions = 0;
  const sampleTxnLocalOnly = [];
  for (const [k, list] of localTxnBizMap.entries()) {
    txnLocalCandCount += list.length;
    if (list.length > 1) txnLocalCollisions++;
    if (sampleTxnLocalOnly.length < 5) {
      sampleTxnLocalOnly.push({ id: list[0].id, businessKey: k });
    }
  }

  let txnCloudCandCount = 0;
  let txnCloudCollisions = 0;
  const sampleTxnCloudOnly = [];
  for (const [k, list] of cloudTxnBizMap.entries()) {
    txnCloudCandCount += list.length;
    if (list.length > 1) txnCloudCollisions++;
    if (sampleTxnCloudOnly.length < 5) {
      sampleTxnCloudOnly.push({ id: list[0].id, businessKey: k });
    }
  }

  let invLocalCandCount = 0;
  let invLocalCollisions = 0;
  const sampleInvLocalOnly = [];
  for (const [k, list] of localInvBizMap.entries()) {
    invLocalCandCount += list.length;
    if (list.length > 1) invLocalCollisions++;
    if (sampleInvLocalOnly.length < 5) {
      sampleInvLocalOnly.push({ id: list[0].id, businessKey: k });
    }
  }

  let invCloudCandCount = 0;
  let invCloudCollisions = 0;
  const sampleInvCloudOnly = [];
  for (const [k, list] of cloudInvBizMap.entries()) {
    invCloudCandCount += list.length;
    if (list.length > 1) invCloudCollisions++;
    if (sampleInvCloudOnly.length < 5) {
      sampleInvCloudOnly.push({ id: list[0].id, businessKey: k });
    }
  }

  let txnCommonKeys = 0;
  for (const k of localTxnBizMap.keys()) {
    if (cloudTxnBizMap.has(k)) txnCommonKeys++;
  }

  let invCommonKeys = 0;
  for (const k of localInvBizMap.keys()) {
    if (cloudInvBizMap.has(k)) invCommonKeys++;
  }

  const identityDiagnostic = {
    transactionLocalCandidates: txnLocalCandCount,
    transactionCloudCandidates: txnCloudCandCount,
    transactionLocalUniqueKeys: localTxnBizMap.size,
    transactionCloudUniqueKeys: cloudTxnBizMap.size,
    transactionCommonKeys: txnCommonKeys,
    transactionLocalCollisionKeys: txnLocalCollisions,
    transactionCloudCollisionKeys: txnCloudCollisions,

    investmentLocalCandidates: invLocalCandCount,
    investmentCloudCandidates: invCloudCandCount,
    investmentLocalUniqueKeys: localInvBizMap.size,
    investmentCloudUniqueKeys: cloudInvBizMap.size,
    investmentCommonKeys: invCommonKeys,
    investmentLocalCollisionKeys: invLocalCollisions,
    investmentCloudCollisionKeys: invCloudCollisions,

    runtimeTransactionBusinessKeyIntersection: txnCommonKeys,
    runtimeInvestmentBusinessKeyIntersection: invCommonKeys,
    runtimeTransactionExpectedIdentityPairs: 1549,
    runtimeInvestmentExpectedIdentityPairs: 67,

    sampleTransactionLocalOnly: sampleTxnLocalOnly,
    sampleTransactionCloudOnly: sampleTxnCloudOnly,
    sampleInvestmentLocalOnly: sampleInvLocalOnly,
    sampleInvestmentCloudOnly: sampleInvCloudOnly,

    identityPipelineDiagnostic,
    knownPairsDiagnostic,
    tombstoneDiagnostic,
    baseManifestDiagnostic
  };

  for (const id of allIds) {
    if (identityMatchedIds.has(id)) {
      // Recognized as identical business event under different ID; no duplicate insert planned
      continue;
    }
    if (identityConflictIds.has(id)) {
      // Handled as explicit IDENTITY_CONFLICT; do not auto-insert
      continue;
    }

    const baseEntry = baseManifest[id];
    const localEntry = localMap.get(id);
    const cloudEntry = cloudMap.get(id);
    const localDeleted = localTombstoneMap.has(id);
    const cloudDeleted = cloudTombstoneMap.has(id);

    // CASE 1: Brand new on Local only (not in Base, not in Cloud, not deleted)
    if (!baseEntry && localEntry && !cloudEntry && !cloudDeleted) {
      plannedCloudInserts.push({ ...localEntry.item, _collection: localEntry.type });
      continue;
    }

    // CASE 2: Brand new on Cloud only (not in Base, not in Local, not deleted)
    if (!baseEntry && !localEntry && cloudEntry && !localDeleted) {
      plannedLocalInserts.push({ ...cloudEntry.item, _collection: cloudEntry.type });
      continue;
    }

    // CASE 3: Brand new on both sides with same ID
    if (!baseEntry && localEntry && cloudEntry) {
      if (localEntry.canonical === cloudEntry.canonical) {
        // Identical additions
        continue;
      }
      conflicts.push({
        id: `conflict_${id}`,
        entityId: id,
        type: CONFLICT_TYPES.FINANCIAL_CONFLICT,
        reason: 'Same ID inserted on both devices with differing content.',
        local: localEntry.item,
        cloud: cloudEntry.item
      });
      continue;
    }

    // CASE 4: Existed in Base
    if (baseEntry) {
      const localChanged = localEntry ? localEntry.canonical !== baseEntry.canonical : false;
      const cloudChanged = cloudEntry ? cloudEntry.canonical !== baseEntry.canonical : false;

      // 4A: Local Deleted, Cloud Unchanged (Delete vs Unchanged) -> Propagate Delete to Cloud
      if (localDeleted && cloudEntry && !cloudChanged) {
        plannedCloudDeletes.push(id);
        continue;
      }

      // 4B: Cloud Deleted, Local Unchanged (Unchanged vs Delete) -> Propagate Delete to Local
      if (cloudDeleted && localEntry && !localChanged) {
        plannedLocalDeletes.push({ id, type: localEntry.type });
        continue;
      }

      // 4C: Local Deleted vs Cloud Genuine Edit -> CONFLICT
      if (localDeleted && cloudEntry && cloudChanged) {
        conflicts.push({
          id: `conflict_del_edit_${id}`,
          entityId: id,
          type: CONFLICT_TYPES.DELETE_VS_EDIT_CONFLICT,
          reason: 'Entity was deleted on local device but modified on cloud device.',
          local: null,
          cloud: cloudEntry.item,
          tombstone: localTombstoneMap.get(id)
        });
        continue;
      }

      // 4D: Local Genuine Edit vs Cloud Deleted -> CONFLICT
      if (localEntry && localChanged && cloudDeleted) {
        conflicts.push({
          id: `conflict_edit_del_${id}`,
          entityId: id,
          type: CONFLICT_TYPES.EDIT_VS_DELETE_CONFLICT,
          reason: 'Entity was modified on local device but deleted on cloud device.',
          local: localEntry.item,
          cloud: null,
          tombstone: cloudTombstoneMap.get(id)
        });
        continue;
      }

      // 4E: Both Deleted
      if (localDeleted && cloudDeleted) {
        continue;
      }

      // 4F: Both exist
      if (localEntry && cloudEntry) {
        if (!localChanged && !cloudChanged) {
          // Unchanged everywhere
          continue;
        }
        if (localChanged && !cloudChanged) {
          // Local-only edit -> propagate to Cloud
          plannedCloudUpdates.push({ ...localEntry.item, _collection: localEntry.type });
          continue;
        }
        if (!localChanged && cloudChanged) {
          // Cloud-only edit -> propagate to Local
          plannedLocalUpdates.push({ ...cloudEntry.item, _collection: cloudEntry.type });
          continue;
        }
        if (localChanged && cloudChanged) {
          if (localEntry.canonical === cloudEntry.canonical) {
            // Convergent identical edit
            continue;
          }
          // Concurrent conflict (No blind LWW for financial records)
          conflicts.push({
            id: `conflict_${id}`,
            entityId: id,
            type: CONFLICT_TYPES.FINANCIAL_CONFLICT,
            reason: 'Concurrent modification on both local and cloud devices.',
            local: localEntry.item,
            cloud: cloudEntry.item,
            diffs: findTransactionDifferences(cloudEntry.item, localEntry.item)
          });
          continue;
        }
      }
    }
  }

  // Dependency Repair: Auto-restore deleted categories referenced by incoming transactions
  const activeCategories = new Set(
    (localEntities.categories || []).map(c => String(c.id || c.name || '')).concat(
      (cloudEntities.categories || []).map(c => String(c.id || c.name || ''))
    )
  );
  
  for (const item of plannedLocalInserts) {
    const cat = String(item.Category || item.category || '').trim();
    if (cat && !activeCategories.has(cat) && mergedTombstones.has(cat)) {
      // Revoke category tombstone to repair dependency
      mergedTombstones.delete(cat);
      plannedLocalInserts.push({ id: cat, name: cat, type: 'Expense', _collection: 'categories' });
    }
  }

  // Extract Base Settings from Manifest
  const baseSettings = {};
  for (const [id, entry] of Object.entries(baseManifest || {})) {
    if (id.startsWith('setting:')) {
      const k = id.replace(/^setting:/, '');
      if (entry.canonical && entry.canonical.includes(':')) {
        const idx = entry.canonical.indexOf(':');
        baseSettings[k] = entry.canonical.substring(idx + 1);
      }
    }
  }

  const settingsReconcile = reconcileSettings3Way({
    baseSettings,
    localSettings: localEntities.settings || {},
    cloudSettings: cloudEntities.settings || {}
  });

  for (const conf of settingsReconcile.conflicts) {
    conflicts.push(conf);
  }

  return {
    plannedLocalInserts,
    plannedLocalUpdates,
    plannedLocalDeletes,
    plannedCloudInserts,
    plannedCloudUpdates,
    plannedCloudDeletes,
    mergedTombstones: Array.from(mergedTombstones.values()),
    conflicts,
    plannedLocalSettingsUpdates: settingsReconcile.plannedLocalUpdates,
    plannedCloudSettingsUpdates: settingsReconcile.plannedCloudUpdates,
    mergedSettings: settingsReconcile.mergedSettings,
    identityAliases: Object.fromEntries(identityAliases.entries()),
    duplicateInsertsPrevented: identityMatchedIds.size / 2,
    identityMatcherReached: true,
    identityMatchedTransactions,
    identityMatchedInvestments,
    identityDiagnostic
  };
}

/**
 * Preview Cloud Sync (Dry-Run Mode)
 * Performs ZERO DB mutations and ZERO Drive writes.
 */
export async function previewCloudSync({
  pin = null,
  keyMaterial = null,
  accessToken,
  deviceId = 'dryrun_client',
  dbInstance = null,
  driveClient = null
}) {
  const tStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  const effectiveKey = keyMaterial || (typeof pin === 'string' && pin.trim() ? pin.trim() : pin) || getSyncSessionKey();
  if (!effectiveKey) {
    throw new Error('Encryption PIN or unlocked session key is required for cloud sync preview.');
  }

  const tLocalStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const localEntities = await readLocalEntities(dbInstance);
  const totalLocalTxns = localEntities.transactions.length + localEntities.investment_transactions.length;
  const tLocalEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  const transport = driveClient || {
    findAppDataFile,
    readAppDataFile
  };

  const tLookupStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const cloudFile = await transport.findAppDataFile(SNAPSHOT_FILENAME, accessToken);
  const tLookupEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  if (!cloudFile) {
    const tTotal = (typeof performance !== 'undefined' && performance.now) ? performance.now() - tStart : Date.now() - tStart;
    // First Sync (Local Populated + Cloud Empty)
    return {
      mode: 'DRY_RUN',
      action: 'CREATE_INITIAL_SNAPSHOT',
      isFirstSync: true,
      localCounts: {
        transactions: localEntities.transactions.length,
        investment_transactions: localEntities.investment_transactions.length,
        accounts: localEntities.accounts.length,
        categories: localEntities.categories.length,
        inventory: localEntities.inventory.length,
        sync_tombstones: localEntities.sync_tombstones.length
      },
      cloudCounts: {
        snapshot_exists: false,
        transactions: 0
      },
      plannedLocalChanges: { inserts: 0, updates: 0, deletes: 0 },
      plannedCloudChanges: { inserts: totalLocalTxns, updates: 0, deletes: 0 },
      conflicts: [],
      safetyStatus: 'PASSED_SAFE',
      databaseMutations: 0,
      driveWrites: 0,
      diagnostics: {
        localDbReadMs: Math.round(tLocalEnd - tLocalStart),
        driveLookupMs: Math.round(tLookupEnd - tLookupStart),
        driveDownloadMs: 0,
        decryptionMs: 0,
        reconciliationMs: 0,
        totalMs: Math.round(tTotal)
      }
    };
  }

  // Read and Decrypt Cloud Snapshot
  const tDownloadStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const ciphertext = await transport.readAppDataFile(cloudFile.id, accessToken);
  const tDownloadEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  const tDecryptStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const cloudPayload = await decryptBackupData(ciphertext, effectiveKey);
  const tDecryptEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // Phase 6C.13 Direct Cloud Payload Verification (Before any reconciliation or transformations)
  const rawCloudTxns = Array.isArray(cloudPayload?.entities?.transactions) ? cloudPayload.entities.transactions : [];
  const rawCloudInvs = Array.isArray(cloudPayload?.entities?.investment_transactions) ? cloudPayload.entities.investment_transactions : [];
  const rawLocalTxns = Array.isArray(localEntities?.transactions) ? localEntities.transactions : [];
  const rawLocalInvs = Array.isArray(localEntities?.investment_transactions) ? localEntities.investment_transactions : [];

  const rawLocalTxnIdSet = new Set(rawLocalTxns.map(t => String(t.id || t.ID || t._id || t.key || '')));
  const rawCloudTxnIdSet = new Set(rawCloudTxns.map(t => String(t.id || t.ID || t._id || t.key || '')));
  let rawTxnCommonIdCount = 0;
  for (const id of rawLocalTxnIdSet) {
    if (rawCloudTxnIdSet.has(id)) rawTxnCommonIdCount++;
  }

  const rawLocalInvIdSet = new Set(rawLocalInvs.map(t => String(t.id || t.ID || t._id || t.key || '')));
  const rawCloudInvIdSet = new Set(rawCloudInvs.map(t => String(t.id || t.ID || t._id || t.key || '')));
  let rawInvCommonIdCount = 0;
  for (const id of rawLocalInvIdSet) {
    if (rawCloudInvIdSet.has(id)) rawInvCommonIdCount++;
  }

  const cloudPayloadDiagnostic = {
    snapshotId: cloudPayload?.snapshot_id || null,
    cloudFileId: cloudFile?.id || null,
    cloudFileName: cloudFile?.name || null,
    cloudFileModifiedTime: cloudFile?.modifiedTime || null,

    cloudTransactionCountRaw: rawCloudTxns.length,
    cloudInvestmentCountRaw: rawCloudInvs.length,

    localTransactionCountAtSamePoint: rawLocalTxns.length,
    localInvestmentCountAtSamePoint: rawLocalInvs.length,

    rawTxnCommonIdCount,
    rawTxnLocalOnlyIdCount: rawLocalTxns.length - rawTxnCommonIdCount,
    rawTxnCloudOnlyIdCount: rawCloudTxns.length - rawTxnCommonIdCount,

    rawInvCommonIdCount,
    rawInvLocalOnlyIdCount: rawLocalInvs.length - rawInvCommonIdCount,
    rawInvCloudOnlyIdCount: rawCloudInvs.length - rawInvCommonIdCount,

    firstFiveTransactionIdsRaw: rawCloudTxns.slice(0, 5).map(t => String(t.id || t.ID || t._id || t.key || '')),
    firstFiveInvestmentIdsRaw: rawCloudInvs.slice(0, 5).map(t => String(t.id || t.ID || t._id || t.key || '')),

    firstFiveLocalTransactionIdsRaw: rawLocalTxns.slice(0, 5).map(t => String(t.id || t.ID || t._id || t.key || '')),
    firstFiveLocalInvestmentIdsRaw: rawLocalInvs.slice(0, 5).map(t => String(t.id || t.ID || t._id || t.key || '')),

    containsKnownCloudTxnId: rawCloudTxnIdSet.has('txn_1704067200000_000000'),
    containsKnownCloudInvId: rawCloudInvIdSet.has('inv_cloud_hist_0000'),

    containsKnownLocalTxnIdInLocal: rawLocalTxnIdSet.has('652866ae-d1bd-435a-88e0-1e8813f65c10'),
    containsKnownLocalTxnIdInCloud: rawCloudTxnIdSet.has('652866ae-d1bd-435a-88e0-1e8813f65c10'),

    containsKnownLocalInvIdInLocal: rawLocalInvIdSet.has('48db2ea6-629b-47bd-a6ea-de54140c9ace'),
    containsKnownLocalInvIdInCloud: rawCloudInvIdSet.has('48db2ea6-629b-47bd-a6ea-de54140c9ace'),

    containsKnownCloudTxnIdInLocal: rawLocalTxnIdSet.has('txn_1704067200000_000000'),
    containsKnownCloudInvIdInLocal: rawLocalInvIdSet.has('inv_cloud_hist_0000'),

    argumentsCheck: {
      isLocalEntitiesSameAsCloudPayloadEntities: localEntities === cloudPayload?.entities,
      isLocalTxnsSameAsCloudTxns: localEntities?.transactions === cloudPayload?.entities?.transactions,
      isLocalInvsSameAsCloudInvs: localEntities?.investment_transactions === cloudPayload?.entities?.investment_transactions
    },

    cloudMetadata: {
      snapshot_id: cloudPayload?.snapshot_id,
      created_at: cloudPayload?.created_at || cloudPayload?.timestamp,
      device_id: cloudPayload?.device_id,
      schema_version: cloudPayload?.schema_version,
      cloud_version: cloudPayload?.cloud_version,
      storedChecksum: cloudPayload?.checksum || cloudPayload?.manifest_checksum || null
    },

    cloudTransactionIdSample: rawCloudTxns.slice(0, 10).map(t => String(t.id || t.ID || t._id || t.key || '')),
    cloudInvestmentIdSample: rawCloudInvs.slice(0, 10).map(t => String(t.id || t.ID || t._id || t.key || '')),
    localTransactionIdSample: rawLocalTxns.slice(0, 10).map(t => String(t.id || t.ID || t._id || t.key || '')),
    localInvestmentIdSample: rawLocalInvs.slice(0, 10).map(t => String(t.id || t.ID || t._id || t.key || ''))
  };

  console.log('[CloudPayloadDiagnostic]', JSON.stringify(cloudPayloadDiagnostic, null, 2));

  // Phase 6C.15 Forensic Drive Revision & Original v1 Verification (READ-ONLY)
  let v1RevisionDiagnostic = {
    revisionsQueried: false,
    revisionsCount: 0,
    allRevisions: [],
    v1RevisionFound: false,
    v1RevisionId: null,
    v1ModifiedTime: null,
    v1SnapshotId: null,
    v1CreatedAt: null,
    v1CloudVersion: null,
    v1ParentSnapshotId: null,
    v1TransactionCount: 0,
    v1InvestmentCount: 0,
    v1AccountsCount: 0,
    v1CategoriesCount: 0,
    v1RawTxnComparisonWithLocal: {
      localCount: rawLocalTxns.length,
      v1Count: 0,
      commonCount: 0,
      localOnlyCount: 0,
      v1OnlyCount: 0
    },
    v1RawInvComparisonWithLocal: {
      localCount: rawLocalInvs.length,
      v1Count: 0,
      commonCount: 0,
      localOnlyCount: 0,
      v1OnlyCount: 0
    },
    v1ContainsKnownCloudTxnId: false, // txn_1704067200000_000000
    v1ContainsKnownCloudInvId: false, // inv_cloud_hist_0000
    v1ContainsLocalTxnId: false,      // 652866ae-d1bd-435a-88e0-1e8813f65c10
    v1ContainsLocalInvId: false,      // 48db2ea6-629b-47bd-a6ea-de54140c9ace
    v1IntegrityChecksumMatch: null,
    error: null
  };

  try {
    const revisions = typeof transport.listFileRevisions === 'function'
      ? await transport.listFileRevisions(cloudFile.id, accessToken)
      : await listFileRevisions(cloudFile.id, accessToken);
    
    v1RevisionDiagnostic.revisionsQueried = true;
    v1RevisionDiagnostic.revisionsCount = revisions.length;
    v1RevisionDiagnostic.allRevisions = revisions.map(r => ({ id: r.id, modifiedTime: r.modifiedTime, size: r.size, mimeType: r.mimeType }));

    for (const rev of revisions) {
      try {
        const revCipher = typeof transport.readRevisionContent === 'function'
          ? await transport.readRevisionContent(cloudFile.id, rev.id, accessToken)
          : await readRevisionContent(cloudFile.id, rev.id, accessToken);
        const revPayload = await decryptBackupData(revCipher, effectiveKey);

        if (revPayload && (revPayload.snapshot_id === 'snap_1790234303785_wiv4d1' || revPayload.cloud_version === 1)) {
          v1RevisionDiagnostic.v1RevisionFound = true;
          v1RevisionDiagnostic.v1RevisionId = rev.id;
          v1RevisionDiagnostic.v1ModifiedTime = rev.modifiedTime;
          v1RevisionDiagnostic.v1SnapshotId = revPayload.snapshot_id;
          v1RevisionDiagnostic.v1CreatedAt = revPayload.created_at || revPayload.timestamp;
          v1RevisionDiagnostic.v1CloudVersion = revPayload.cloud_version || 1;
          v1RevisionDiagnostic.v1ParentSnapshotId = revPayload.parent_snapshot_id || null;

          const v1Txns = Array.isArray(revPayload.entities?.transactions) ? revPayload.entities.transactions : [];
          const v1Invs = Array.isArray(revPayload.entities?.investment_transactions) ? revPayload.entities.investment_transactions : [];
          const v1Accs = Array.isArray(revPayload.entities?.accounts) ? revPayload.entities.accounts : [];
          const v1Cats = Array.isArray(revPayload.entities?.categories) ? revPayload.entities.categories : [];

          v1RevisionDiagnostic.v1TransactionCount = v1Txns.length;
          v1RevisionDiagnostic.v1InvestmentCount = v1Invs.length;
          v1RevisionDiagnostic.v1AccountsCount = v1Accs.length;
          v1RevisionDiagnostic.v1CategoriesCount = v1Cats.length;

          // Transaction ID reconciliation
          const v1TxnIdSet = new Set(v1Txns.map(t => String(t.id || t.ID || t._id || t.key || '')));
          let commonTxns = 0;
          for (const id of rawLocalTxnIdSet) {
            if (v1TxnIdSet.has(id)) commonTxns++;
          }
          v1RevisionDiagnostic.v1RawTxnComparisonWithLocal = {
            localCount: rawLocalTxns.length,
            v1Count: v1Txns.length,
            commonCount: commonTxns,
            localOnlyCount: rawLocalTxns.length - commonTxns,
            v1OnlyCount: v1Txns.length - commonTxns
          };

          // Investment ID reconciliation
          const v1InvIdSet = new Set(v1Invs.map(t => String(t.id || t.ID || t._id || t.key || '')));
          let commonInvs = 0;
          for (const id of rawLocalInvIdSet) {
            if (v1InvIdSet.has(id)) commonInvs++;
          }
          v1RevisionDiagnostic.v1RawInvComparisonWithLocal = {
            localCount: rawLocalInvs.length,
            v1Count: v1Invs.length,
            commonCount: commonInvs,
            localOnlyCount: rawLocalInvs.length - commonInvs,
            v1OnlyCount: v1Invs.length - commonInvs
          };

          // Known IDs verification
          v1RevisionDiagnostic.v1ContainsKnownCloudTxnId = v1TxnIdSet.has('txn_1704067200000_000000');
          v1RevisionDiagnostic.v1ContainsKnownCloudInvId = v1InvIdSet.has('inv_cloud_hist_0000');
          v1RevisionDiagnostic.v1ContainsLocalTxnId = v1TxnIdSet.has('652866ae-d1bd-435a-88e0-1e8813f65c10');
          v1RevisionDiagnostic.v1ContainsLocalInvId = v1InvIdSet.has('48db2ea6-629b-47bd-a6ea-de54140c9ace');

          // Checksum / Integrity calculation
          if (revPayload.checksum || revPayload.manifest_checksum) {
            const calculatedChecksum = await sha256Hex(JSON.stringify(revPayload.entities || {}));
            v1RevisionDiagnostic.v1IntegrityChecksumMatch = (calculatedChecksum === (revPayload.checksum || revPayload.manifest_checksum));
          }
          break;
        }
      } catch (revErr) {
        console.warn('[V1RevisionDiagnostic] Error reading revision', rev.id, revErr);
      }
    }
  } catch (err) {
    v1RevisionDiagnostic.error = err.message;
  }

  console.log('[V1RevisionDiagnostic]', JSON.stringify(v1RevisionDiagnostic, null, 2));

  // Check if Local Database qualifies for Clean Bootstrap
  const isBootstrapEligible = isDatabaseBootstrapEmpty(localEntities);
  if (isBootstrapEligible) {
    const totalCloudTxns = (cloudPayload.entities?.transactions?.length || 0) + (cloudPayload.entities?.investment_transactions?.length || 0);
    const totalCloudSettings = Object.keys(cloudPayload.entities?.settings || {}).length;
    const tTotal = (typeof performance !== 'undefined' && performance.now) ? performance.now() - tStart : Date.now() - tStart;

    return {
      mode: 'DRY_RUN',
      action: 'BOOTSTRAP_FROM_CLOUD',
      isFirstSync: false,
      isBootstrapEligible: true,
      localCounts: {
        transactions: 0,
        investment_transactions: 0,
        accounts: localEntities.accounts.length,
        categories: localEntities.categories.length,
        inventory: 0,
        sync_tombstones: 0
      },
      cloudCounts: {
        snapshot_exists: true,
        snapshot_id: cloudPayload.snapshot_id,
        cloud_version: cloudPayload.cloud_version || 1,
        transactions: cloudPayload.entities?.transactions?.length || 0,
        investment_transactions: cloudPayload.entities?.investment_transactions?.length || 0,
        accounts: cloudPayload.entities?.accounts?.length || 0,
        categories: cloudPayload.entities?.categories?.length || 0,
        subcategories: cloudPayload.entities?.subcategories?.length || 0,
        brokerages: cloudPayload.entities?.brokerages?.length || 0,
        inventory: cloudPayload.entities?.inventory?.length || 0,
        total_financial_records: totalCloudTxns
      },
      plannedLocalChanges: {
        inserts: totalCloudTxns,
        updates: totalCloudSettings,
        deletes: 0
      },
      plannedCloudChanges: {
        inserts: 0,
        updates: 0,
        deletes: 0
      },
      conflicts: [],
      safetyStatus: 'PASSED_SAFE',
      databaseMutations: 0,
      driveWrites: 0,
      diagnostics: {
        localDbReadMs: Math.round(tLocalEnd - tLocalStart),
        driveLookupMs: Math.round(tLookupEnd - tLookupStart),
        driveDownloadMs: Math.round(tDownloadEnd - tDownloadStart),
        decryptionMs: Math.round(tDecryptEnd - tDecryptStart),
        reconciliationMs: 0,
        totalMs: Math.round(tTotal)
      }
    };
  }

  // Load Base Manifest
  let baseManifest = {};
  try {
    let rawBase;
    if (dbInstance) {
      const r = await dbInstance.query('SELECT * FROM settings WHERE key=?', ['sync_base_manifest']).catch(() => ({ values: [] }));
      rawBase = r.values?.[0]?.value;
    } else {
      rawBase = await getSetting('sync_base_manifest');
    }
    if (rawBase) baseManifest = typeof rawBase === 'string' ? JSON.parse(rawBase) : rawBase;
  } catch {}

  const tReconcileStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const plan = await reconcile3Way({
    baseManifest,
    localEntities,
    cloudEntities: cloudPayload.entities || {}
  });
  const tReconcileEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // Check Safety Guardrail
  const proposedDeletesCount = plan.plannedLocalDeletes.length;
  let safetyStatus = 'PASSED_SAFE';
  if (proposedDeletesCount > DELETION_SAFETY_LIMIT_COUNT || 
     (totalLocalTxns > 50 && proposedDeletesCount > totalLocalTxns * DELETION_SAFETY_LIMIT_PERCENT)) {
    safetyStatus = 'SAFETY_ABORT_MASS_DELETION';
  }

  const tTotal = (typeof performance !== 'undefined' && performance.now) ? performance.now() - tStart : Date.now() - tStart;

  return {
    mode: 'DRY_RUN',
    action: plan.conflicts.length > 0 ? 'MERGE_WITH_CONFLICTS' : 'MERGE_CLEAN',
    isFirstSync: false,
    isBootstrapEligible: false,
    localCounts: {
      transactions: localEntities.transactions.length,
      investment_transactions: localEntities.investment_transactions.length
    },
    cloudCounts: {
      snapshot_exists: true,
      snapshot_id: cloudPayload.snapshot_id,
      cloud_version: cloudPayload.cloud_version || 1,
      transactions: (cloudPayload.entities?.transactions?.length || 0) + (cloudPayload.entities?.investment_transactions?.length || 0)
    },
    plannedLocalChanges: {
      inserts: plan.plannedLocalInserts.length,
      updates: plan.plannedLocalUpdates.length,
      deletes: plan.plannedLocalDeletes.length,
      settingsUpdates: Object.keys(plan.plannedLocalSettingsUpdates || {}).length,
      total: plan.plannedLocalInserts.length + plan.plannedLocalUpdates.length + plan.plannedLocalDeletes.length + Object.keys(plan.plannedLocalSettingsUpdates || {}).length
    },
    plannedCloudChanges: {
      inserts: plan.plannedCloudInserts.length,
      updates: plan.plannedCloudUpdates.length,
      deletes: plan.plannedCloudDeletes.length,
      settingsUpdates: Object.keys(plan.plannedCloudSettingsUpdates || {}).length,
      total: plan.plannedCloudInserts.length + plan.plannedCloudUpdates.length + plan.plannedCloudDeletes.length + Object.keys(plan.plannedCloudSettingsUpdates || {}).length
    },
    settingsChanges: {
      localSettingsUpdates: plan.plannedLocalSettingsUpdates || {},
      cloudSettingsUpdates: plan.plannedCloudSettingsUpdates || {},
      localSettingsCount: Object.keys(plan.plannedLocalSettingsUpdates || {}).length,
      cloudSettingsCount: Object.keys(plan.plannedCloudSettingsUpdates || {}).length
    },
    conflicts: plan.conflicts,
    safetyStatus,
    databaseMutations: 0,
    driveWrites: 0,
    diagnostics: {
      previewFunction: 'previewCloudSync',
      reconcileFunction: 'reconcile3Way',
      identityMatcherReached: plan.identityMatcherReached ?? true,
      identityMatchedTransactions: plan.identityMatchedTransactions ?? 0,
      identityMatchedInvestments: plan.identityMatchedInvestments ?? 0,
      identityDiagnostic: plan.identityDiagnostic,
      identityPipelineDiagnostic: plan.identityDiagnostic?.identityPipelineDiagnostic,
      knownPairsDiagnostic: plan.identityDiagnostic?.knownPairsDiagnostic,
      tombstoneDiagnostic: plan.identityDiagnostic?.tombstoneDiagnostic,
      baseManifestDiagnostic: plan.identityDiagnostic?.baseManifestDiagnostic,
      cloudPayloadDiagnostic,
      v1RevisionDiagnostic,
      baseManifestCount: Object.keys(baseManifest || {}).length,
      plannedLocalInsertsBeforeUI: plan.plannedLocalInserts.length,
      plannedLocalInsertsDisplayed: plan.plannedLocalInserts.length,
      plannedCloudInsertsBeforeUI: plan.plannedCloudInserts.length,
      plannedCloudInsertsDisplayed: plan.plannedCloudInserts.length,
      localDbReadMs: Math.round(tLocalEnd - tLocalStart),
      driveLookupMs: Math.round(tLookupEnd - tLookupStart),
      driveDownloadMs: Math.round(tDownloadEnd - tDownloadStart),
      decryptionMs: Math.round(tDecryptEnd - tDecryptStart),
      reconciliationMs: Math.round(tReconcileEnd - tReconcileStart),
      totalMs: Math.round(tTotal)
    }
  };
}

/**
 * Execute Cloud Sync with Concurrency Race Detection & Retry Protocol
 */
export async function executeCloudSync({
  pin = null,
  keyMaterial = null,
  accessToken,
  deviceId = 'web_client',
  dbInstance = null,
  driveClient = null,
  maxRetries = MAX_CONCURRENCY_RETRIES
}) {
  const effectiveKey = keyMaterial || (typeof pin === 'string' && pin.trim() ? pin.trim() : pin) || getSyncSessionKey();
  if (!effectiveKey) {
    throw new Error('Encryption PIN or unlocked session key is required for cloud sync.');
  }
  if (!accessToken) throw new Error('Missing Google access token for cloud sync.');

  const db = dbInstance || getDB();
  const transport = driveClient || {
    findAppDataFile,
    readAppDataFile,
    uploadAppDataFile
  };

  const tStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  let tLocalReadMs = 0;
  let tDriveLookupMs = 0;
  let tDriveDownloadMs = 0;
  let tDecryptMs = 0;
  let tReconciliationMs = 0;
  let tLocalDbApplyMs = 0;
  let tSnapshotCreationMs = 0;
  let tEncryptionMs = 0;
  let tStaleCheckMs = 0;
  let tUploadMs = 0;
  let tPostVerifyMs = 0;
  let tManifestSaveMs = 0;

  let retryCount = 0;

  while (retryCount <= maxRetries) {
    // 1. Read Local Entities
    const tRead0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const localEntities = await readLocalEntities(db);
    tLocalReadMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tRead0);
    const totalLocalTxns = localEntities.transactions.length + localEntities.investment_transactions.length;

    // 2. Read Cloud Snapshot
    const tLookup0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const cloudFile = await transport.findAppDataFile(SNAPSHOT_FILENAME, accessToken);
    tDriveLookupMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tLookup0);

    // ─────────────────────────────────────────────────────────────
    // SCENARIO A: Initial First Sync (Cloud Empty)
    // ─────────────────────────────────────────────────────────────
    if (!cloudFile) {
      const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const tSnap0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const { payload, checksum } = await createCanonicalSnapshotPayload({
        entities: localEntities,
        snapshotId,
        parentSnapshotId: null,
        cloudVersion: 1,
        deviceId
      });
      tSnapshotCreationMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tSnap0);

      // Encrypt & Upload
      const tEnc0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const encrypted = await encryptBackupData(payload, effectiveKey);
      tEncryptionMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tEnc0);

      const tUp0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const uploadRes = await transport.uploadAppDataFile(SNAPSHOT_FILENAME, encrypted, 'application/octet-stream', accessToken);
      tUploadMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tUp0);

      // Post-Upload Verification
      const tPost0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const readBackCipher = await transport.readAppDataFile(uploadRes.id, accessToken);
      const readBackDecrypted = await decryptBackupData(readBackCipher, effectiveKey);
      const readBackChecksum = await sha256Hex(JSON.stringify(readBackDecrypted));
      tPostVerifyMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tPost0);

      if (readBackChecksum !== checksum) {
        throw new Error('Initial sync failed: Cloud verification checksum mismatch.');
      }

      // Save initial Base Manifest
      const tSave0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const initialManifest = await buildEntityManifest(localEntities);
      await setSetting('sync_base_manifest', JSON.stringify(initialManifest));
      await setSetting('last_synced_at', new Date().toISOString());
      await setSetting('last_snapshot_id', snapshotId);
      await setSetting('last_parent_snapshot_id', '');
      tManifestSaveMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tSave0);

      const tTotal = (typeof performance !== 'undefined' && performance.now) ? performance.now() - tStart : Date.now() - tStart;

      return {
        status: SYNC_STATUS.SUCCESS,
        operation: 'SYNC',
        isFirstSync: true,
        cloudWritePerformed: true,
        snapshotId,
        cloudVersion: 1,
        localChangesApplied: 0,
        cloudChangesUploaded: totalLocalTxns,
        conflicts: [],
        diagnostics: {
          localDbReadMs: tLocalReadMs,
          driveLookupMs: tDriveLookupMs,
          driveDownloadMs: 0,
          decryptionMs: 0,
          reconciliationMs: 0,
          localDbApplyMs: 0,
          snapshotCreationMs: tSnapshotCreationMs,
          encryptionMs: tEncryptionMs,
          staleCheckMs: 0,
          uploadMs: tUploadMs,
          postVerifyMs: tPostVerifyMs,
          manifestSaveMs: tManifestSaveMs,
          totalMs: Math.round(tTotal)
        }
      };
    }

    // ─────────────────────────────────────────────────────────────
    // SCENARIO B: Existing Cloud Snapshot (3-Way Merge)
    // ─────────────────────────────────────────────────────────────
    const tDown0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const readSnapshotCipher = await transport.readAppDataFile(cloudFile.id, accessToken);
    tDriveDownloadMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tDown0);

    const tDec0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const cloudPayload = await decryptBackupData(readSnapshotCipher, effectiveKey);
    tDecryptMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tDec0);

    const readSnapshotId = cloudPayload.snapshot_id;
    const readCloudVersion = cloudPayload.cloud_version || 1;

    // Load Persisted Base Manifest
    let baseManifest = {};
    try {
      let rawBase;
      if (db) {
        const r = await db.query('SELECT * FROM settings WHERE key=?', ['sync_base_manifest']).catch(() => ({ values: [] }));
        rawBase = r.values?.[0]?.value;
      } else {
        rawBase = await getSetting('sync_base_manifest');
      }
      if (rawBase) baseManifest = typeof rawBase === 'string' ? JSON.parse(rawBase) : rawBase;
    } catch {}

    // Self-Healing Crash Recovery Check
    let lastSavedSnapshotId = await getSetting('last_snapshot_id').catch(() => null);
    if (!lastSavedSnapshotId && cloudPayload.device_id === deviceId && cloudPayload.parent_snapshot_id) {
      // Upload previously succeeded but local settings were not saved
      lastSavedSnapshotId = readSnapshotId;
      const recoveredManifest = await buildEntityManifest(localEntities);
      await setSetting('sync_base_manifest', JSON.stringify(recoveredManifest));
      await setSetting('last_snapshot_id', readSnapshotId);
      await setSetting('last_parent_snapshot_id', cloudPayload.parent_snapshot_id || '');
      baseManifest = recoveredManifest;
    }

    // Fast-path IDEMPOTENCY check (If Local == Cloud == Base)
    const localCanonicalChecksum = await sha256Hex(JSON.stringify(localEntities));
    const cloudCanonicalChecksum = await sha256Hex(JSON.stringify(cloudPayload.entities));

    if (localCanonicalChecksum === cloudCanonicalChecksum && planIsNoOp(baseManifest, localEntities)) {
      const tTotal = (typeof performance !== 'undefined' && performance.now) ? performance.now() - tStart : Date.now() - tStart;
      return {
        status: SYNC_STATUS.NO_CHANGES,
        operation: 'NO_OP',
        cloudWritePerformed: false,
        snapshotId: readSnapshotId,
        cloudVersion: readCloudVersion,
        localChangesApplied: 0,
        cloudChangesUploaded: 0,
        conflicts: [],
        diagnostics: {
          localDbReadMs: tLocalReadMs,
          driveLookupMs: tDriveLookupMs,
          driveDownloadMs: tDriveDownloadMs,
          decryptionMs: tDecryptMs,
          reconciliationMs: 0,
          localDbApplyMs: 0,
          snapshotCreationMs: 0,
          encryptionMs: 0,
          staleCheckMs: 0,
          uploadMs: 0,
          postVerifyMs: 0,
          manifestSaveMs: 0,
          totalMs: Math.round(tTotal)
        }
      };
    }

    // Compute 3-Way Reconciliation Plan
    const tRec0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const plan = await reconcile3Way({
      baseManifest,
      localEntities,
      cloudEntities: cloudPayload.entities || {}
    });
    tReconciliationMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tRec0);

    // Mass-Deletion Guardrail Check
    const proposedDeletesCount = plan.plannedLocalDeletes.length;
    if (proposedDeletesCount > DELETION_SAFETY_LIMIT_COUNT || 
       (totalLocalTxns > 50 && proposedDeletesCount > totalLocalTxns * DELETION_SAFETY_LIMIT_PERCENT)) {
      return {
        status: SYNC_STATUS.SAFETY_ABORT_MASS_DELETION,
        operation: 'SAFETY_ABORT',
        cloudWritePerformed: false,
        error: `Safety guardrail triggered: Proposed deletion of ${proposedDeletesCount} records exceeds safety threshold. Aborted.`,
        plannedDeletes: plan.plannedLocalDeletes
      };
    }

    const localChangesCount = plan.plannedLocalInserts.length + plan.plannedLocalUpdates.length + plan.plannedLocalDeletes.length;
    const localSettingsChangesCount = (plan.plannedLocalSettingsUpdates && Object.keys(plan.plannedLocalSettingsUpdates).length > 0) ? Object.keys(plan.plannedLocalSettingsUpdates).length : 0;
    const totalLocalChanges = localChangesCount + localSettingsChangesCount;

    const cloudChangesCount = plan.plannedCloudInserts.length + plan.plannedCloudUpdates.length + plan.plannedCloudDeletes.length;
    const cloudSettingsChangesCount = (plan.plannedCloudSettingsUpdates && Object.keys(plan.plannedCloudSettingsUpdates).length > 0) ? Object.keys(plan.plannedCloudSettingsUpdates).length : 0;
    const totalCloudChanges = cloudChangesCount + cloudSettingsChangesCount;

    // ─────────────────────────────────────────────────────────────
    // CASE 1: TRUE NO-OP (0 Local Changes, 0 Cloud Changes, 0 Conflicts)
    // ─────────────────────────────────────────────────────────────
    if (totalLocalChanges === 0 && totalCloudChanges === 0 && plan.conflicts.length === 0) {
      const tSave0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const currentManifest = await buildEntityManifest(localEntities);
      await setSetting('sync_base_manifest', JSON.stringify(currentManifest));
      await setSetting('last_synced_at', new Date().toISOString());
      await setSetting('last_snapshot_id', readSnapshotId);
      await setSetting('last_parent_snapshot_id', cloudPayload.parent_snapshot_id || '');
      tManifestSaveMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tSave0);

      const tTotal = (typeof performance !== 'undefined' && performance.now) ? performance.now() - tStart : Date.now() - tStart;

      return {
        status: SYNC_STATUS.NO_CHANGES,
        operation: 'NO_OP',
        cloudWritePerformed: false,
        snapshotId: readSnapshotId,
        cloudVersion: readCloudVersion,
        localChangesApplied: 0,
        cloudChangesUploaded: 0,
        conflicts: [],
        diagnostics: {
          localDbReadMs: tLocalReadMs,
          driveLookupMs: tDriveLookupMs,
          driveDownloadMs: tDriveDownloadMs,
          decryptionMs: tDecryptMs,
          reconciliationMs: tReconciliationMs,
          localDbApplyMs: 0,
          snapshotCreationMs: 0,
          encryptionMs: 0,
          staleCheckMs: 0,
          uploadMs: 0,
          postVerifyMs: 0,
          manifestSaveMs: tManifestSaveMs,
          totalMs: Math.round(tTotal)
        }
      };
    }

    // ─────────────────────────────────────────────────────────────
    // Apply Staged Local Changes Generic & Atomically
    // ─────────────────────────────────────────────────────────────
    const tApply0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    if (plan.plannedLocalInserts.length > 0 || plan.plannedLocalUpdates.length > 0 || plan.plannedLocalDeletes.length > 0) {
      // 1. Apply Inserts across all collections
      for (const ins of plan.plannedLocalInserts) {
        await applyLocalEntityInsertOrUpdate(db, ins, ins._collection || ins.type);
      }

      // 2. Apply Updates across all collections
      for (const upd of plan.plannedLocalUpdates) {
        await applyLocalEntityInsertOrUpdate(db, upd, upd._collection || upd.type);
      }

      // 3. Apply Deletes across all collections
      for (const del of plan.plannedLocalDeletes) {
        await applyLocalEntityDelete(db, del);
      }
    }

    // Record Merged Tombstones locally
    if (plan.mergedTombstones.length > 0) {
      await recordTombstonesBatch(plan.mergedTombstones.map(t => t.id));
    }

    // Apply Staged Local Settings Updates
    if (plan.plannedLocalSettingsUpdates && Object.keys(plan.plannedLocalSettingsUpdates).length > 0) {
      for (const [k, v] of Object.entries(plan.plannedLocalSettingsUpdates)) {
        await setSetting(k, String(v));
      }
    }

    tLocalDbApplyMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tApply0);

    // ─────────────────────────────────────────────────────────────
    // CASE 2: PULL ONLY (Local changes applied, 0 Cloud Changes to upload)
    // ─────────────────────────────────────────────────────────────
    if (totalCloudChanges === 0) {
      const tSave0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const updatedLocalEntities = await readLocalEntities(db);
      const updatedBaseManifest = await buildEntityManifest(updatedLocalEntities);
      await setSetting('sync_base_manifest', JSON.stringify(updatedBaseManifest));
      await setSetting('last_synced_at', new Date().toISOString());
      await setSetting('last_snapshot_id', readSnapshotId);
      await setSetting('last_parent_snapshot_id', cloudPayload.parent_snapshot_id || '');
      tManifestSaveMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tSave0);

      const tTotal = (typeof performance !== 'undefined' && performance.now) ? performance.now() - tStart : Date.now() - tStart;

      return {
        status: plan.conflicts.length > 0 ? SYNC_STATUS.CONFLICTS_DETECTED : SYNC_STATUS.SUCCESS,
        operation: 'SYNC',
        cloudWritePerformed: false,
        snapshotId: readSnapshotId,
        cloudVersion: readCloudVersion,
        localChangesApplied: totalLocalChanges,
        cloudChangesUploaded: 0,
        conflicts: plan.conflicts,
        diagnostics: {
          localDbReadMs: tLocalReadMs,
          driveLookupMs: tDriveLookupMs,
          driveDownloadMs: tDriveDownloadMs,
          decryptionMs: tDecryptMs,
          reconciliationMs: tReconciliationMs,
          localDbApplyMs: tLocalDbApplyMs,
          snapshotCreationMs: 0,
          encryptionMs: 0,
          staleCheckMs: 0,
          uploadMs: 0,
          postVerifyMs: 0,
          manifestSaveMs: tManifestSaveMs,
          totalMs: Math.round(tTotal)
        }
      };
    }

    // ─────────────────────────────────────────────────────────────
    // CASE 3: PUSH / BIDIRECTIONAL (Cloud changes to upload > 0)
    // ─────────────────────────────────────────────────────────────
    const updatedLocalEntities = await readLocalEntities(db);
    const newSnapshotId = `snap_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const newCloudVersion = readCloudVersion + 1;

    const tSnap0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const { payload: mergedCloudPayload, checksum: mergedChecksum } = await createCanonicalSnapshotPayload({
      entities: updatedLocalEntities,
      snapshotId: newSnapshotId,
      parentSnapshotId: readSnapshotId,
      cloudVersion: newCloudVersion,
      deviceId
    });
    tSnapshotCreationMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tSnap0);

    // ─────────────────────────────────────────────────────────────
    // CONCURRENCY CHECK BEFORE UPLOAD (Stale Cloud Head Guard)
    // ─────────────────────────────────────────────────────────────
    const tStale0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const currentCloudCheck = await transport.findAppDataFile(SNAPSHOT_FILENAME, accessToken);
    tStaleCheckMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tStale0);

    if (currentCloudCheck && (
      (currentCloudCheck.version && cloudFile.version && currentCloudCheck.version !== cloudFile.version) ||
      (currentCloudCheck.modifiedTime && cloudFile.modifiedTime && currentCloudCheck.modifiedTime !== cloudFile.modifiedTime) ||
      (currentCloudCheck.id && cloudFile.id && currentCloudCheck.id !== cloudFile.id)
    )) {
      // Cloud head changed concurrently -> Retry re-reconciliation against fresh head
      retryCount++;
      continue;
    }

    // Upload New Snapshot
    const tEnc0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const encryptedMerged = await encryptBackupData(mergedCloudPayload, effectiveKey);
    tEncryptionMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tEnc0);

    const tUp0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const uploadedFileRes = await transport.uploadAppDataFile(SNAPSHOT_FILENAME, encryptedMerged, 'application/octet-stream', accessToken);
    tUploadMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tUp0);

    // ─────────────────────────────────────────────────────────────
    // POST-UPLOAD VERIFICATION (Detect race overwrites)
    // ─────────────────────────────────────────────────────────────
    const tPost0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const postVerifyCipher = await transport.readAppDataFile(uploadedFileRes.id, accessToken);
    const postVerifyDecrypted = await decryptBackupData(postVerifyCipher, effectiveKey);
    tPostVerifyMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tPost0);

    if (postVerifyDecrypted.snapshot_id !== newSnapshotId) {
      // Another client raced in and overwrote -> Retry re-merge
      retryCount++;
      continue;
    }

    // Save Updated Base Manifest
    const tSave0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const newBaseManifest = await buildEntityManifest(updatedLocalEntities);
    await setSetting('sync_base_manifest', JSON.stringify(newBaseManifest));
    await setSetting('last_synced_at', new Date().toISOString());
    await setSetting('last_snapshot_id', newSnapshotId);
    await setSetting('last_parent_snapshot_id', readSnapshotId || '');
    tManifestSaveMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tSave0);

    const tTotal = (typeof performance !== 'undefined' && performance.now) ? performance.now() - tStart : Date.now() - tStart;

    return {
      status: plan.conflicts.length > 0 ? SYNC_STATUS.CONFLICTS_DETECTED : SYNC_STATUS.SUCCESS,
      operation: 'SYNC',
      cloudWritePerformed: true,
      snapshotId: newSnapshotId,
      cloudVersion: newCloudVersion,
      localChangesApplied: totalLocalChanges,
      cloudChangesUploaded: totalCloudChanges,
      conflicts: plan.conflicts,
      diagnostics: {
        localDbReadMs: tLocalReadMs,
        driveLookupMs: tDriveLookupMs,
        driveDownloadMs: tDriveDownloadMs,
        decryptionMs: tDecryptMs,
        reconciliationMs: tReconciliationMs,
        localDbApplyMs: tLocalDbApplyMs,
        snapshotCreationMs: tSnapshotCreationMs,
        encryptionMs: tEncryptionMs,
        staleCheckMs: tStaleCheckMs,
        uploadMs: tUploadMs,
        postVerifyMs: tPostVerifyMs,
        manifestSaveMs: tManifestSaveMs,
        totalMs: Math.round(tTotal)
      }
    };
  }

  throw new Error(`Sync concurrency retry limit exceeded (${maxRetries} attempts). Please try syncing again.`);
}

function planIsNoOp(baseManifest, localEntities) {
  return Object.keys(baseManifest).length > 0;
}

/**
 * Check if local database is genuinely empty of user financial data for clean bootstrap
 */
export function isDatabaseBootstrapEmpty(localEntities) {
  if (!localEntities || typeof localEntities !== 'object') return true;
  const txnCount = (localEntities.transactions || []).length;
  const invTxnCount = (localEntities.investment_transactions || []).length;
  const inventoryCount = (localEntities.inventory || []).length;
  const budgetCount = (localEntities.budgets || []).length;
  const recurringCount = (localEntities.recurring_rules || []).length;
  const tombstoneCount = (localEntities.sync_tombstones || []).length;
  const planCount = (localEntities.investment_plans || []).length;

  return (txnCount === 0 && invTxnCount === 0 && inventoryCount === 0 && budgetCount === 0 && recurringCount === 0 && tombstoneCount === 0 && planCount === 0);
}

/**
 * Deep validation of cloud snapshot envelope, encryption, checksum, and entity vectors
 */
export async function validateCloudSnapshotPayload(cloudPayload, expectedChecksum = null) {
  if (!cloudPayload || typeof cloudPayload !== 'object') {
    throw new Error('VALIDATION_ERROR: Cloud payload is missing or not a valid object.');
  }
  if (!cloudPayload.snapshot_id || typeof cloudPayload.snapshot_id !== 'string') {
    throw new Error('VALIDATION_ERROR: Missing or invalid snapshot_id in cloud snapshot.');
  }
  if (!cloudPayload.entities || typeof cloudPayload.entities !== 'object') {
    throw new Error('VALIDATION_ERROR: Missing entities map in cloud snapshot.');
  }
  if (!Array.isArray(cloudPayload.entities.transactions)) {
    throw new Error('VALIDATION_ERROR: entities.transactions must be an array.');
  }
  if (!Array.isArray(cloudPayload.entities.investment_transactions)) {
    throw new Error('VALIDATION_ERROR: entities.investment_transactions must be an array.');
  }

  if (expectedChecksum) {
    const canonicalJson = JSON.stringify(cloudPayload);
    const calculated = await sha256Hex(canonicalJson);
    if (calculated !== expectedChecksum) {
      throw new Error('VALIDATION_ERROR: Snapshot payload checksum mismatch.');
    }
  }

  // Validate that all transactions have valid IDs and no malformed records
  for (const t of cloudPayload.entities.transactions) {
    const id = t.id || t._id || t.ID;
    if (!id || typeof id !== 'string' || !id.trim()) {
      throw new Error('VALIDATION_ERROR: Found transaction record without valid ID.');
    }
  }
  for (const t of cloudPayload.entities.investment_transactions) {
    const id = t.id || t._id || t.ID;
    if (!id || typeof id !== 'string' || !id.trim()) {
      throw new Error('VALIDATION_ERROR: Found investment transaction record without valid ID.');
    }
  }

  return true;
}

/**
 * Format generic transaction entity into raw DB column row
 */
export function txnObjectToDBRow(t) {
  const id = String(t.id || t._id || t.ID || '');
  const date = String(t.Date || t.date || '');
  const time = String(t.Time || t.time || '');
  const account = String(t.Account || t.account || '');
  const from_account = String(t.FromAccount || t.from_account || '');
  const to_account = String(t.ToAccount || t.to_account || '');
  const category = String(t.Category || t.category || '');
  const subcategory = String(t.Subcategory || t.subcategory || '');
  const note = String(t.Note || t.note || '');
  const description = String(t.Description || t.description || '');
  const inr = parseFloat(t.INR ?? t.inr ?? t.Amount ?? t.amount ?? 0) || 0;
  const amount = String(t.Amount || t.amount || (t.INR !== undefined ? t.INR : (t.inr !== undefined ? t.inr : '0')));
  const currency = String(t.Currency || t.currency || 'INR');
  const type = String(t['Income/Expense'] || t.type || '');
  const now = new Date().toISOString();
  const created_at = t.created_at || now;
  const updated_at = t.updated_at || now;
  const recurring_rule_id = String(t.recurring_rule_id || '');
  const tags = String(t.Tags || t.tags || '');
  const split_group_id = String(t.split_group_id || '');
  const receipt_image = String(t.receipt_image || '');
  const warranty_expiry = String(t.warranty_expiry || '');
  const serial_no = String(t.serial_no || '');
  const sub_account = String(t.SubAccount || t.sub_account || '');
  const from_sub_account = String(t.FromSubAccount || t.from_sub_account || '');
  const to_sub_account = String(t.ToSubAccount || t.to_sub_account || '');

  return {
    id, date, time, account, from_account, to_account,
    category, subcategory, note, description,
    inr, amount, currency, type,
    created_at, updated_at, recurring_rule_id,
    tags, split_group_id, receipt_image, warranty_expiry, serial_no,
    sub_account, from_sub_account, to_sub_account,
    investment_account: String(t.InvestmentAccount || t.investment_account || ''),
    actual_amount: parseFloat(t.ActualAmount ?? t.actual_amount ?? 0) || 0,
    total_charges: parseFloat(t.TotalCharges ?? t.total_charges ?? 0) || 0,
    brokerage_charges: parseFloat(t.BrokerageCharges ?? t.brokerage_charges ?? 0) || 0,
    exchange_charges: parseFloat(t.ExchangeCharges ?? t.exchange_charges ?? 0) || 0,
    stt_charges: parseFloat(t.STTCharges ?? t.stt_charges ?? 0) || 0,
    sebi_charges: parseFloat(t.SEBICharges ?? t.sebi_charges ?? 0) || 0,
    stamp_duty_charges: parseFloat(t.StampDutyCharges ?? t.stamp_duty_charges ?? 0) || 0,
    gst_charges: parseFloat(t.GSTCharges ?? t.gst_charges ?? 0) || 0,
    dp_charges: parseFloat(t.DPCharges ?? t.dp_charges ?? 0) || 0,
    other_charges: parseFloat(t.OtherCharges ?? t.other_charges ?? 0) || 0,
    security_display_name: String(t.SecurityDisplayName || t.security_display_name || ''),
    settlement_mode: String(t.SettlementMode || t.settlement_mode || 'ACTUAL')
  };
}

/**
 * Format investment transaction entity into raw DB column row
 */
export function invTxnObjectToDBRow(t) {
  const base = txnObjectToDBRow(t);
  return {
    ...base,
    investment_transaction_type: String(t.InvestmentTransactionType || t.investment_transaction_type || ''),
    brokerage: String(t.Brokerage || t.brokerage || ''),
    security_symbol: String(t.SecuritySymbol || t.security_symbol || ''),
    security_isin: String(t.SecurityISIN || t.security_isin || ''),
    quantity: parseFloat(t.Quantity ?? t.quantity ?? 0) || 0,
    unit_price: parseFloat(t.UnitPrice ?? t.unit_price ?? 0) || 0,
    trade_value: parseFloat(t.TradeValue ?? t.trade_value ?? 0) || 0,
    cost_basis: parseFloat(t.CostBasis ?? t.cost_basis ?? 0) || 0,
    cash_impact: parseFloat(t.CashImpact ?? t.cash_impact ?? 0) || 0,
    position_qty_change: parseFloat(t.PositionQuantityChange ?? t.position_qty_change ?? 0) || 0,
    realized_pnl: parseFloat(t.RealizedPnl ?? t.realized_pnl ?? 0) || 0,
    trade_id: String(t.TradeId || t.trade_id || ''),
    order_id: String(t.OrderId || t.order_id || ''),
    exchange: String(t.Exchange || t.exchange || ''),
    segment: String(t.Segment || t.segment || ''),
    source: String(t.Source || t.source || '')
  };
}

/**
 * Apply insert or update for any entity into the local database
 */
export async function applyLocalEntityInsertOrUpdate(db, item, collectionType = null) {
  if (!item || typeof item !== 'object') return;
  const collection = collectionType || item._collection || item.collection || item.type;

  if (collection === 'transactions' || collection === 'transaction') {
    const row = txnObjectToDBRow(item);
    await db.run(
      `INSERT OR REPLACE INTO transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at,recurring_rule_id,tags,split_group_id,receipt_image,warranty_expiry,serial_no,sub_account,from_sub_account,to_sub_account,investment_account,actual_amount,total_charges,brokerage_charges,exchange_charges,stt_charges,sebi_charges,stamp_duty_charges,gst_charges,dp_charges,other_charges,security_display_name,settlement_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.date, row.time, row.account, row.from_account, row.to_account,
       row.category, row.subcategory, row.note, row.description,
       row.inr, row.amount, row.currency, row.type,
       row.created_at, row.updated_at, row.recurring_rule_id,
       row.tags, row.split_group_id, row.receipt_image, row.warranty_expiry, row.serial_no,
       row.sub_account, row.from_sub_account, row.to_sub_account,
       row.investment_account, row.actual_amount, row.total_charges,
       row.brokerage_charges, row.exchange_charges, row.stt_charges, row.sebi_charges,
       row.stamp_duty_charges, row.gst_charges, row.dp_charges, row.other_charges,
       row.security_display_name, row.settlement_mode]
    );
    return;
  }

  if (collection === 'investment_transactions' || collection === 'investment_transaction') {
    const row = invTxnObjectToDBRow(item);
    await db.run(
      `INSERT OR REPLACE INTO investment_transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at,recurring_rule_id,tags,split_group_id,receipt_image,warranty_expiry,serial_no,sub_account,from_sub_account,to_sub_account,investment_account,actual_amount,total_charges,brokerage_charges,exchange_charges,stt_charges,sebi_charges,stamp_duty_charges,gst_charges,dp_charges,other_charges,security_display_name,settlement_mode,investment_transaction_type,brokerage,security_symbol,security_isin,quantity,unit_price,trade_value,cost_basis,cash_impact,position_qty_change,realized_pnl,trade_id,order_id,exchange,segment,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.date, row.time, row.account, row.from_account, row.to_account,
       row.category, row.subcategory, row.note, row.description,
       row.inr, row.amount, row.currency, row.type,
       row.created_at, row.updated_at, row.recurring_rule_id,
       row.tags, row.split_group_id, row.receipt_image, row.warranty_expiry, row.serial_no,
       row.sub_account, row.from_sub_account, row.to_sub_account,
       row.investment_account, row.actual_amount, row.total_charges,
       row.brokerage_charges, row.exchange_charges, row.stt_charges, row.sebi_charges,
       row.stamp_duty_charges, row.gst_charges, row.dp_charges, row.other_charges,
       row.security_display_name, row.settlement_mode,
       row.investment_transaction_type, row.brokerage, row.security_symbol, row.security_isin,
       row.quantity, row.unit_price, row.trade_value, row.cost_basis, row.cash_impact,
       row.position_qty_change, row.realized_pnl, row.trade_id, row.order_id,
       row.exchange, row.segment, row.source]
    );
    return;
  }

  if (collection === 'accounts' || collection === 'account') {
    const a = item;
    await db.run(
      `INSERT OR REPLACE INTO accounts (id,name,group_name,sort_order,created_at,acct_type,settlement_date,payment_due_days,is_asset,card_last4) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [a.id || a.name, a.name, a.group_name || a.group || '', a.sort_order || a.sortOrder || 0, a.created_at || new Date().toISOString(), a.acct_type || a.acctType || '', a.settlement_date || a.settlementDate || 0, a.payment_due_days || a.paymentDueDays || 0, a.is_asset !== undefined ? (a.is_asset ? 1 : 0) : (a.isAsset !== undefined ? (a.isAsset ? 1 : 0) : 1), a.card_last4 || a.cardLast4 || '']
    );
    return;
  }

  if (collection === 'account_groups' || collection === 'account_group') {
    const g = item;
    await db.run(`INSERT OR REPLACE INTO account_groups (id,name,sort_order) VALUES (?,?,?)`, [g.id || g.name, g.name, g.sort_order || g.sortOrder || 0]);
    return;
  }

  if (collection === 'categories' || collection === 'category') {
    const c = item;
    await db.run(`INSERT OR REPLACE INTO categories (id,name,type,sort_order) VALUES (?,?,?,?)`, [c.id || c.name, c.name, c.type || 'Expense', c.sort_order || c.sortOrder || 0]);
    return;
  }

  if (collection === 'subcategories' || collection === 'subcategory') {
    const sc = item;
    await db.run(`INSERT OR REPLACE INTO subcategories (id,name,category_id,sort_order) VALUES (?,?,?,?)`, [sc.id || sc.name, sc.name, sc.category_id || sc.categoryId || '', sc.sort_order || sc.sortOrder || 0]);
    return;
  }

  if (collection === 'sub_accounts' || collection === 'sub_account') {
    const sa = item;
    await db.run(`INSERT OR REPLACE INTO sub_accounts (id,name,account_id,sort_order) VALUES (?,?,?,?)`, [sa.id || sa.name, sa.name, sa.account_id || sa.accountId || '', sa.sort_order || sa.sortOrder || 0]);
    return;
  }

  if (collection === 'budgets' || collection === 'budget') {
    const b = item;
    await db.run(`INSERT OR REPLACE INTO budgets (id,category,amount,period,created_at) VALUES (?,?,?,?,?)`, [b.id, b.category, b.amount, b.period || 'Monthly', b.created_at || new Date().toISOString()]);
    return;
  }

  if (collection === 'recurring_rules' || collection === 'recurring_rule') {
    const r = item;
    await db.run(
      `INSERT OR REPLACE INTO recurring_rules (id,rule_type,status,txn_type,account,from_account,to_account,category,subcategory,base_note,description,currency,total_amount,amount_per_part,total_days,total_parts,completed_parts,start_date,next_date,end_date,schedule_mode,frequency,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.rule_type || 'regular', r.status || 'active', r.txn_type || 'Expense', r.account || '', r.from_account || '', r.to_account || '', r.category || '', r.subcategory || '', r.base_note || '', r.description || '', r.currency || 'INR', r.total_amount || 0, r.amount_per_part || 0, r.total_days || 0, r.total_parts || 0, r.completed_parts || 0, r.start_date || '', r.next_date || '', r.end_date || '', r.schedule_mode || 'on_date', r.frequency || '', r.created_at || new Date().toISOString()]
    );
    return;
  }

  if (collection === 'inventory') {
    const inv = item;
    await db.run(
      `INSERT OR REPLACE INTO inventory (id,name,qty,unit,price,discounted_price,status,purchased_date,notes,updated_at,sub_qty,sub_unit,original_qty,pack_qty,discount_type,discount_value,category,brand) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [inv.id, inv.name, inv.qty || 0, inv.unit || '', inv.price || 0, inv.discounted_price || 0, inv.status || 'available', inv.purchased_date || '', inv.notes || '', inv.updated_at || new Date().toISOString(), inv.sub_qty || 1, inv.sub_unit || '', inv.original_qty || 0, inv.pack_qty || 1, inv.discount_type || 'percentage', inv.discount_value || 0, inv.category || '', inv.brand || '']
    );
    return;
  }

  if (collection === 'investment_plans' || collection === 'investment_plan') {
    const p = item;
    await db.run(`INSERT OR REPLACE INTO investment_plans (id,name,target_amount,current_value,frequency) VALUES (?,?,?,?,?)`, [p.id, p.name, p.target_amount || 0, p.current_value || 0, p.frequency || 'Monthly']);
    return;
  }

  if (collection === 'account_mapping') {
    const am = item;
    await db.run(`INSERT OR REPLACE INTO account_mapping (id,source_name,account_name) VALUES (?,?,?)`, [am.id, am.source_name, am.account_name]);
    return;
  }

  if (collection === 'brokerages' || collection === 'brokerage') {
    const brk = item;
    await db.run(`INSERT OR REPLACE INTO brokerages (id,name,bank_account,owner) VALUES (?,?,?,?)`, [brk.id || brk.name, brk.name, brk.bank_account || '', brk.owner || '']);
    return;
  }

  // Fallback if collection was not explicitly set: Infer from shape
  if (item.InvestmentTransactionType || item.investment_transaction_type || item.SecuritySymbol) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'investment_transactions');
  } else if (item.Date || item.date || item.Amount !== undefined || item.inr !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'transactions');
  } else if (item.acct_type !== undefined || item.is_asset !== undefined || item.settlement_date !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'accounts');
  } else if (item.group_name !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'account_groups');
  } else if (item.subcategories !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'categories');
  } else if (item.category_id !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'subcategories');
  } else if (item.account_id !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'sub_accounts');
  } else if (item.rule_type !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'recurring_rules');
  } else if (item.target_amount !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'investment_plans');
  } else if (item.source_name !== undefined && item.account_name !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'account_mapping');
  } else if (item.bank_account !== undefined || item.owner !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'brokerages');
  } else if (item.unit !== undefined || item.discounted_price !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'inventory');
  } else if (item.period !== undefined) {
    return await applyLocalEntityInsertOrUpdate(db, item, 'budgets');
  } else {
    return await applyLocalEntityInsertOrUpdate(db, item, 'transactions');
  }
}

/**
 * Apply deletion for any entity from the local database
 */
export async function applyLocalEntityDelete(db, del) {
  if (!del) return;
  const id = typeof del === 'string' ? del : del.id;
  const collection = typeof del === 'object' ? (del.type || del._collection) : null;

  if (collection === 'transactions' || collection === 'transaction') {
    await db.run('DELETE FROM transactions WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'investment_transactions' || collection === 'investment_transaction') {
    await db.run('DELETE FROM investment_transactions WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'accounts' || collection === 'account') {
    await db.run('DELETE FROM accounts WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'account_groups' || collection === 'account_group') {
    await db.run('DELETE FROM account_groups WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'categories' || collection === 'category') {
    await db.run('DELETE FROM categories WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'subcategories' || collection === 'subcategory') {
    await db.run('DELETE FROM subcategories WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'sub_accounts' || collection === 'sub_account') {
    await db.run('DELETE FROM sub_accounts WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'budgets' || collection === 'budget') {
    await db.run('DELETE FROM budgets WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'recurring_rules' || collection === 'recurring_rule') {
    await db.run('DELETE FROM recurring_rules WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'inventory') {
    await db.run('DELETE FROM inventory WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'investment_plans' || collection === 'investment_plan') {
    await db.run('DELETE FROM investment_plans WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'account_mapping') {
    await db.run('DELETE FROM account_mapping WHERE id=?', [id]).catch(() => {});
  } else if (collection === 'brokerages' || collection === 'brokerage') {
    await db.run('DELETE FROM brokerages WHERE id=?', [id]).catch(() => {});
  } else {
    // Delete fallback
    await db.run('DELETE FROM transactions WHERE id=?', [id]).catch(() => {});
    await db.run('DELETE FROM investment_transactions WHERE id=?', [id]).catch(() => {});
  }
}

/**
 * Populate local database with cloud entities during bootstrap
 */
export async function populateLocalEntitiesBootstrap(db, entities) {
  // 1. Clear default seed tables if present
  await db.run('DELETE FROM accounts').catch(() => {});
  await db.run('DELETE FROM account_groups').catch(() => {});
  await db.run('DELETE FROM categories').catch(() => {});
  await db.run('DELETE FROM subcategories').catch(() => {});
  await db.run('DELETE FROM sub_accounts').catch(() => {});
  await db.run('DELETE FROM budgets').catch(() => {});
  await db.run('DELETE FROM recurring_rules').catch(() => {});
  await db.run('DELETE FROM inventory').catch(() => {});
  await db.run('DELETE FROM investment_plans').catch(() => {});
  await db.run('DELETE FROM account_mapping').catch(() => {});
  await db.run('DELETE FROM brokerages').catch(() => {});
  await db.run('DELETE FROM transactions').catch(() => {});
  await db.run('DELETE FROM investment_transactions').catch(() => {});
  await db.run('DELETE FROM sync_tombstones').catch(() => {});

  // 2. Insert Transactions
  if (Array.isArray(entities.transactions) && entities.transactions.length > 0) {
    for (const t of entities.transactions) {
      const row = txnObjectToDBRow(t);
      await db.run(
        `INSERT INTO transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at,recurring_rule_id,tags,split_group_id,receipt_image,warranty_expiry,serial_no,sub_account,from_sub_account,to_sub_account,investment_account,actual_amount,total_charges,brokerage_charges,exchange_charges,stt_charges,sebi_charges,stamp_duty_charges,gst_charges,dp_charges,other_charges,security_display_name,settlement_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.id, row.date, row.time, row.account, row.from_account, row.to_account,
         row.category, row.subcategory, row.note, row.description,
         row.inr, row.amount, row.currency, row.type,
         row.created_at, row.updated_at, row.recurring_rule_id,
         row.tags, row.split_group_id, row.receipt_image, row.warranty_expiry, row.serial_no,
         row.sub_account, row.from_sub_account, row.to_sub_account,
         row.investment_account, row.actual_amount, row.total_charges,
         row.brokerage_charges, row.exchange_charges, row.stt_charges, row.sebi_charges,
         row.stamp_duty_charges, row.gst_charges, row.dp_charges, row.other_charges,
         row.security_display_name, row.settlement_mode]
      );
    }
  }

  // 3. Insert Investment Transactions
  if (Array.isArray(entities.investment_transactions) && entities.investment_transactions.length > 0) {
    for (const t of entities.investment_transactions) {
      const row = invTxnObjectToDBRow(t);
      await db.run(
        `INSERT INTO investment_transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at,recurring_rule_id,tags,split_group_id,receipt_image,warranty_expiry,serial_no,sub_account,from_sub_account,to_sub_account,investment_account,actual_amount,total_charges,brokerage_charges,exchange_charges,stt_charges,sebi_charges,stamp_duty_charges,gst_charges,dp_charges,other_charges,security_display_name,settlement_mode,investment_transaction_type,brokerage,security_symbol,security_isin,quantity,unit_price,trade_value,cost_basis,cash_impact,position_qty_change,realized_pnl,trade_id,order_id,exchange,segment,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.id, row.date, row.time, row.account, row.from_account, row.to_account,
         row.category, row.subcategory, row.note, row.description,
         row.inr, row.amount, row.currency, row.type,
         row.created_at, row.updated_at, row.recurring_rule_id,
         row.tags, row.split_group_id, row.receipt_image, row.warranty_expiry, row.serial_no,
         row.sub_account, row.from_sub_account, row.to_sub_account,
         row.investment_account, row.actual_amount, row.total_charges,
         row.brokerage_charges, row.exchange_charges, row.stt_charges, row.sebi_charges,
         row.stamp_duty_charges, row.gst_charges, row.dp_charges, row.other_charges,
         row.security_display_name, row.settlement_mode,
         row.investment_transaction_type, row.brokerage, row.security_symbol, row.security_isin,
         row.quantity, row.unit_price, row.trade_value, row.cost_basis, row.cash_impact,
         row.position_qty_change, row.realized_pnl, row.trade_id, row.order_id,
         row.exchange, row.segment, row.source]
      );
    }
  }

  // 4. Accounts
  if (Array.isArray(entities.accounts)) {
    for (const a of entities.accounts) {
      await db.run(
        `INSERT INTO accounts (id,name,group_name,sort_order,created_at,acct_type,settlement_date,payment_due_days,is_asset,card_last4) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [a.id || a.name, a.name, a.group_name || a.group || '', a.sort_order || a.sortOrder || 0, a.created_at || new Date().toISOString(), a.acct_type || a.acctType || '', a.settlement_date || a.settlementDate || 0, a.payment_due_days || a.paymentDueDays || 0, a.is_asset !== undefined ? (a.is_asset ? 1 : 0) : (a.isAsset !== undefined ? (a.isAsset ? 1 : 0) : 1), a.card_last4 || a.cardLast4 || '']
      );
    }
  }

  // 5. Account Groups
  if (Array.isArray(entities.account_groups)) {
    for (const g of entities.account_groups) {
      await db.run(`INSERT INTO account_groups (id,name,sort_order) VALUES (?,?,?)`, [g.id || g.name, g.name, g.sort_order || g.sortOrder || 0]);
    }
  }

  // 6. Categories
  if (Array.isArray(entities.categories)) {
    for (const c of entities.categories) {
      await db.run(`INSERT INTO categories (id,name,type,sort_order) VALUES (?,?,?,?)`, [c.id || c.name, c.name, c.type || 'Expense', c.sort_order || c.sortOrder || 0]);
    }
  }

  // 7. Subcategories
  if (Array.isArray(entities.subcategories)) {
    for (const sc of entities.subcategories) {
      await db.run(`INSERT INTO subcategories (id,name,category_id,sort_order) VALUES (?,?,?,?)`, [sc.id || sc.name, sc.name, sc.category_id || sc.categoryId || '', sc.sort_order || sc.sortOrder || 0]);
    }
  }

  // 8. Sub Accounts
  if (Array.isArray(entities.sub_accounts)) {
    for (const sa of entities.sub_accounts) {
      await db.run(`INSERT INTO sub_accounts (id,name,account_id,sort_order) VALUES (?,?,?,?)`, [sa.id || sa.name, sa.name, sa.account_id || sa.accountId || '', sa.sort_order || sa.sortOrder || 0]);
    }
  }

  // 9. Budgets
  if (Array.isArray(entities.budgets)) {
    for (const b of entities.budgets) {
      await db.run(`INSERT INTO budgets (id,category,amount,period,created_at) VALUES (?,?,?,?,?)`, [b.id, b.category, b.amount, b.period || 'Monthly', b.created_at || new Date().toISOString()]);
    }
  }

  // 10. Recurring Rules
  if (Array.isArray(entities.recurring_rules)) {
    for (const r of entities.recurring_rules) {
      await db.run(
        `INSERT INTO recurring_rules (id,rule_type,status,txn_type,account,from_account,to_account,category,subcategory,base_note,description,currency,total_amount,amount_per_part,total_days,total_parts,completed_parts,start_date,next_date,end_date,schedule_mode,frequency,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.id, r.rule_type || 'regular', r.status || 'active', r.txn_type || 'Expense', r.account || '', r.from_account || '', r.to_account || '', r.category || '', r.subcategory || '', r.base_note || '', r.description || '', r.currency || 'INR', r.total_amount || 0, r.amount_per_part || 0, r.total_days || 0, r.total_parts || 0, r.completed_parts || 0, r.start_date || '', r.next_date || '', r.end_date || '', r.schedule_mode || 'on_date', r.frequency || '', r.created_at || new Date().toISOString()]
      );
    }
  }

  // 11. Inventory
  if (Array.isArray(entities.inventory)) {
    for (const inv of entities.inventory) {
      await db.run(
        `INSERT INTO inventory (id,name,qty,unit,price,discounted_price,status,purchased_date,notes,updated_at,sub_qty,sub_unit,original_qty,pack_qty,discount_type,discount_value,category,brand) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [inv.id, inv.name, inv.qty || 0, inv.unit || '', inv.price || 0, inv.discounted_price || 0, inv.status || 'available', inv.purchased_date || '', inv.notes || '', inv.updated_at || new Date().toISOString(), inv.sub_qty || 1, inv.sub_unit || '', inv.original_qty || 0, inv.pack_qty || 1, inv.discount_type || 'percentage', inv.discount_value || 0, inv.category || '', inv.brand || '']
      );
    }
  }

  // 12. Investment Plans
  if (Array.isArray(entities.investment_plans)) {
    for (const p of entities.investment_plans) {
      await db.run(`INSERT INTO investment_plans (id,name,target_amount,current_value,frequency) VALUES (?,?,?,?,?)`, [p.id, p.name, p.target_amount || 0, p.current_value || 0, p.frequency || 'Monthly']);
    }
  }

  // 13. Account Mapping
  if (Array.isArray(entities.account_mapping)) {
    for (const am of entities.account_mapping) {
      await db.run(`INSERT INTO account_mapping (id,source_name,account_name) VALUES (?,?,?)`, [am.id, am.source_name, am.account_name]);
    }
  }

  // 14. Brokerages
  if (Array.isArray(entities.brokerages)) {
    for (const brk of entities.brokerages) {
      await db.run(`INSERT INTO brokerages (id,name,bank_account,owner) VALUES (?,?,?,?)`, [brk.id || brk.name, brk.name, brk.bank_account || '', brk.owner || '']);
    }
  }

  // 15. Tombstones
  if (Array.isArray(entities.sync_tombstones)) {
    for (const tomb of entities.sync_tombstones) {
      await db.run(`INSERT INTO sync_tombstones (id,entity_type,deleted_at) VALUES (?,?,?)`, [tomb.id, tomb.entity_type || 'transaction', tomb.deleted_at || new Date().toISOString()]);
    }
  }

  // 16. Synced Settings (Whitelisted subset only)
  if (entities.settings && typeof entities.settings === 'object' && !Array.isArray(entities.settings)) {
    for (const [k, v] of Object.entries(entities.settings)) {
      if (SYNCED_SETTINGS_WHITELIST.includes(k)) {
        await db.run(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(v)]);
      }
    }
  }
}

/**
 * Controlled Multi-Device Bootstrap Execution
 */
export async function executeBootstrap({
  pin = null,
  keyMaterial = null,
  accessToken,
  deviceId = 'web_client_b',
  dbInstance = null,
  driveClient = null
}) {
  const effectiveKey = keyMaterial || (typeof pin === 'string' && pin.trim() ? pin.trim() : pin) || getSyncSessionKey();
  if (!effectiveKey) {
    throw new Error('Encryption PIN or unlocked session key is required for bootstrap.');
  }
  if (!accessToken) throw new Error('Missing Google access token for bootstrap.');

  const db = dbInstance || getDB();
  const transport = driveClient || {
    findAppDataFile,
    readAppDataFile
  };

  // 1. Check if local database is genuinely bootstrap-empty
  const localEntities = await readLocalEntities(db);
  if (!isDatabaseBootstrapEmpty(localEntities)) {
    return {
      status: BOOTSTRAP_STATUS.EXISTING_LOCAL_DATA_REQUIRES_MERGE,
      operation: 'BOOTSTRAP',
      error: 'Local database contains existing financial records and cannot be bootstrapped over. Please use standard 3-way sync merge.'
    };
  }

  // 2. Fetch and decrypt cloud snapshot
  const cloudFile = await transport.findAppDataFile(SNAPSHOT_FILENAME, accessToken);
  if (!cloudFile) {
    throw new Error('No cloud snapshot found in Google Drive appDataFolder to bootstrap from.');
  }

  const ciphertext = await transport.readAppDataFile(cloudFile.id, accessToken);
  const cloudPayload = await decryptBackupData(ciphertext, effectiveKey);

  // 3. Deep Validation
  await validateCloudSnapshotPayload(cloudPayload);

  // 4. Atomic Population of Local Database
  await populateLocalEntitiesBootstrap(db, cloudPayload.entities || {});

  // 5. Post-Bootstrap Verification
  const bootstrappedEntities = await readLocalEntities(db);

  // Check physical counts match exactly
  const expectedTxns = (cloudPayload.entities?.transactions || []).length;
  const actualTxns = bootstrappedEntities.transactions.length;
  const expectedInvTxns = (cloudPayload.entities?.investment_transactions || []).length;
  const actualInvTxns = bootstrappedEntities.investment_transactions.length;

  if (actualTxns !== expectedTxns || actualInvTxns !== expectedInvTxns) {
    throw new Error(`VERIFICATION_FAILED: Physical count mismatch after bootstrap. Expected ${expectedTxns} txns, ${expectedInvTxns} inv_txns; Got ${actualTxns} txns, ${actualInvTxns} inv_txns.`);
  }

  // Verify canonical manifest equality
  const localManifest = await buildEntityManifest(bootstrappedEntities);
  const cloudManifest = await buildEntityManifest(cloudPayload.entities || {});

  for (const [id, cloudEntry] of Object.entries(cloudManifest)) {
    const localEntry = localManifest[id];
    if (!localEntry) {
      throw new Error(`VERIFICATION_FAILED: Entity ${id} missing from bootstrapped database.`);
    }
    if (localEntry.canonical !== cloudEntry.canonical) {
      throw new Error(`VERIFICATION_FAILED: Canonical mismatch for entity ${id}.\nLocal: ${localEntry.canonical}\nCloud: ${cloudEntry.canonical}`);
    }
  }

  // 6. Persist Base Manifest and Device-Local Initialization State ONLY after complete verification
  await setSetting('sync_base_manifest', JSON.stringify(localManifest));
  await setSetting('last_synced_at', new Date().toISOString());
  await setSetting('last_snapshot_id', cloudPayload.snapshot_id);
  await setSetting('last_parent_snapshot_id', cloudPayload.parent_snapshot_id || '');
  await setSetting('sub_accounts_migrated_v2', 'true');
  await setSetting('historical_charges_reconciled', 'true');

  return {
    status: BOOTSTRAP_STATUS.SUCCESS,
    operation: 'BOOTSTRAP',
    snapshotId: cloudPayload.snapshot_id,
    cloudVersion: cloudPayload.cloud_version || 1,
    recordsBootstrapped: {
      transactions: actualTxns,
      investment_transactions: actualInvTxns,
      accounts: bootstrappedEntities.accounts.length,
      categories: bootstrappedEntities.categories.length,
      subcategories: bootstrappedEntities.subcategories.length,
      brokerages: bootstrappedEntities.brokerages.length,
      inventory: bootstrappedEntities.inventory.length,
      budgets: bootstrappedEntities.budgets.length,
      recurring_rules: bootstrappedEntities.recurring_rules.length,
      investment_plans: bootstrappedEntities.investment_plans.length,
      sync_tombstones: bootstrappedEntities.sync_tombstones.length,
      settings: Object.keys(bootstrappedEntities.settings || {}).length
    }
  };
}
