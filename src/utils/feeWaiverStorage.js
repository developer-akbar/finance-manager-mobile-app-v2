/**
 * feeWaiverStorage.js — Persistent Storage & Synchronization Helpers for Credit Card Fee Waivers
 *
 * Implements persistent configuration management, finalized cycle history,
 * and 3-way multi-device merge safety without modifying SQLite/IndexedDB table schemas.
 */

import { getSetting, setSetting } from '../database/settings.js';
import { FEE_STRUCTURE, PERIOD_TYPE } from './feeWaiverEngine.js';

export const SETTING_KEYS = Object.freeze({
  CONFIGS: 'cc_fee_waiver_configs',
  HISTORY: 'cc_fee_waiver_history',
  OVERRIDES: 'cc_fee_waiver_overrides',
});

/**
 * Loads all card fee waiver configurations from settings.
 * Keyed strictly by persistent account ID (cardId).
 *
 * @returns {Promise<Object>} Map of { [cardId]: config }
 */
export async function getFeeWaiverConfigs() {
  try {
    const raw = await getSetting(SETTING_KEYS.CONFIGS, '{}');
    if (!raw) return {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('Error reading cc_fee_waiver_configs:', err);
    return {};
  }
}

/**
 * Gets fee waiver configuration for a specific card by its persistent account ID.
 *
 * @param {string} cardId - Persistent account ID.
 * @returns {Promise<Object|null>} Card configuration or null if not configured.
 */
export async function getFeeWaiverConfigForCard(cardId) {
  if (!cardId) return null;
  const configs = await getFeeWaiverConfigs();
  return configs[String(cardId).trim()] || null;
}

/**
 * Saves or updates fee waiver configuration for a card.
 * Enforces validation, non-prorated full first-year threshold, and persistent card ID keying.
 *
 * @param {string} cardId - Persistent account ID.
 * @param {Object} configData - Configuration payload.
 * @returns {Promise<Object>} The saved configuration object.
 */
export async function saveFeeWaiverConfig(cardId, configData) {
  if (!cardId) throw new Error('Persistent card ID is required to save fee waiver configuration');
  const cleanId = String(cardId).trim();
  const configs = await getFeeWaiverConfigs();

  const existing = configs[cleanId] || {};
  const feeStructure = configData.feeStructure || existing.feeStructure || FEE_STRUCTURE.THRESHOLD_WAIVER;

  const updatedConfig = {
    cardId: cleanId,
    feeStructure,
    annualFee: Math.max(0, Number(configData.annualFee ?? existing.annualFee) || 0),
    spendThreshold: Math.max(0, Number(configData.spendThreshold ?? existing.spendThreshold) || 0),
    periodType: configData.periodType || existing.periodType || PERIOD_TYPE.ANNIVERSARY,
    issuanceDate: configData.issuanceDate ?? existing.issuanceDate ?? null,
    customStartDate: configData.customStartDate ?? existing.customStartDate ?? null,
    customEndDate: configData.customEndDate ?? existing.customEndDate ?? null,
    updatedAt: new Date().toISOString(),
  };

  configs[cleanId] = updatedConfig;
  await setSetting(SETTING_KEYS.CONFIGS, JSON.stringify(configs));
  return updatedConfig;
}

/**
 * Deletes fee waiver configuration for a card.
 *
 * @param {string} cardId - Persistent account ID.
 * @returns {Promise<boolean>} True if deleted, false if not found.
 */
export async function deleteFeeWaiverConfig(cardId) {
  if (!cardId) return false;
  const cleanId = String(cardId).trim();
  const configs = await getFeeWaiverConfigs();
  if (!configs[cleanId]) return false;

  delete configs[cleanId];
  await setSetting(SETTING_KEYS.CONFIGS, JSON.stringify(configs));
  return true;
}

/**
 * Loads finalized historical cycles from settings.
 *
 * @returns {Promise<Array>} List of finalized cycle history records.
 */
export async function getFeeWaiverHistory() {
  try {
    const raw = await getSetting(SETTING_KEYS.HISTORY, '[]');
    if (!raw) return [];
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Error reading cc_fee_waiver_history:', err);
    return [];
  }
}

/**
 * Gets finalized cycle history for a specific card ID.
 *
 * @param {string} cardId - Persistent account ID.
 * @returns {Promise<Array>} List of finalized cycle history records for card.
 */
export async function getFeeWaiverHistoryForCard(cardId) {
  if (!cardId) return [];
  const history = await getFeeWaiverHistory();
  const cleanId = String(cardId).trim();
  return history.filter(h => String(h.cardId).trim() === cleanId);
}

/**
 * Persists a finalized cycle outcome or bank confirmation.
 * Does not overwrite live calculation state.
 *
 * @param {Object} outcome - Finalized cycle outcome.
 * @returns {Promise<Object>} The persisted record.
 */
export async function saveFeeWaiverCycleOutcome(outcome) {
  if (!outcome || !outcome.cardId) {
    throw new Error('Valid cycle outcome with cardId is required');
  }

  const cleanCardId = String(outcome.cardId).trim();
  const history = await getFeeWaiverHistory();

  const cycleId = outcome.cycleId || `${cleanCardId}_${outcome.periodStart || ''}_${outcome.periodEnd || ''}`;
  const record = {
    ...outcome,
    id: cycleId,
    cardId: cleanCardId,
    updatedAt: new Date().toISOString(),
  };

  const existingIdx = history.findIndex(h => h.id === cycleId);
  if (existingIdx >= 0) {
    history[existingIdx] = { ...history[existingIdx], ...record };
  } else {
    history.push(record);
  }

  await setSetting(SETTING_KEYS.HISTORY, JSON.stringify(history));
  return record;
}

/**
 * 3-Way Dictionary Merger for Card Configurations.
 * Merges independent card edits from multiple devices without overwriting each other.
 *
 * @param {Object} options - { baseRaw, localRaw, cloudRaw }
 * @returns {Object} Merged configurations map { [cardId]: config }
 */
export function mergeCardConfigs3Way({ baseRaw, localRaw, cloudRaw }) {
  const parseObj = (r) => {
    try {
      const o = typeof r === 'string' ? JSON.parse(r) : r;
      return typeof o === 'object' && o !== null && !Array.isArray(o) ? o : {};
    } catch { return {}; }
  };

  const base = parseObj(baseRaw);
  const local = parseObj(localRaw);
  const cloud = parseObj(cloudRaw);

  const allCardIds = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(cloud)]);
  const merged = {};

  for (const cardId of allCardIds) {
    const b = base[cardId];
    const l = local[cardId];
    const c = cloud[cardId];

    const lChanged = JSON.stringify(l) !== JSON.stringify(b);
    const cChanged = JSON.stringify(c) !== JSON.stringify(b);

    if (!lChanged && !cChanged) {
      if (b) merged[cardId] = b;
    } else if (lChanged && !cChanged) {
      if (l) merged[cardId] = l;
    } else if (!lChanged && cChanged) {
      if (c) merged[cardId] = c;
    } else {
      // Both changed: compare updatedAt (LWW per card)
      const lTime = l?.updatedAt ? new Date(l.updatedAt).getTime() : 0;
      const cTime = c?.updatedAt ? new Date(c.updatedAt).getTime() : 0;
      merged[cardId] = lTime >= cTime ? l : c;
    }
  }

  return merged;
}

/**
 * 3-Way Merger for Finalized History records.
 *
 * @param {Object} options - { baseRaw, localRaw, cloudRaw }
 * @returns {Array} Merged history records array
 */
export function mergeCardHistory3Way({ baseRaw, localRaw, cloudRaw }) {
  const parseArr = (r) => {
    try {
      const a = typeof r === 'string' ? JSON.parse(r) : r;
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  };

  const base = parseArr(baseRaw);
  const local = parseArr(localRaw);
  const cloud = parseArr(cloudRaw);

  const byId = (arr) => new Map(arr.map(item => [item.id || `${item.cardId}_${item.periodStart}_${item.periodEnd}`, item]));

  const baseMap = byId(base);
  const localMap = byId(local);
  const cloudMap = byId(cloud);

  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...cloudMap.keys()]);
  const merged = [];

  for (const id of allIds) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const c = cloudMap.get(id);

    const lChanged = JSON.stringify(l) !== JSON.stringify(b);
    const cChanged = JSON.stringify(c) !== JSON.stringify(b);

    if (!lChanged && !cChanged) {
      if (b) merged.push(b);
    } else if (lChanged && !cChanged) {
      if (l) merged.push(l);
    } else if (!lChanged && cChanged) {
      if (c) merged.push(c);
    } else {
      // LWW per cycle record
      const lTime = l?.updatedAt ? new Date(l.updatedAt).getTime() : 0;
      const cTime = c?.updatedAt ? new Date(c.updatedAt).getTime() : 0;
      const winner = lTime >= cTime ? l : c;
      if (winner) merged.push(winner);
    }
  }

  return merged;
}

/**
 * Loads all card fee waiver manual overrides from settings.
 * Keyed by cardId and txnId: { [cardId]: { [txnId]: { override: 'ELIGIBLE'|'EXCLUDED', updatedAt } } }
 *
 * @returns {Promise<Object>} Map of card overrides
 */
export async function getFeeWaiverOverrides() {
  try {
    const raw = await getSetting(SETTING_KEYS.OVERRIDES, '{}');
    if (!raw) return {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('Error reading cc_fee_waiver_overrides:', err);
    return {};
  }
}

/**
 * Gets fee waiver manual overrides for a specific card.
 *
 * @param {string} cardId - Persistent card account ID.
 * @returns {Promise<Object>} Map of { [txnId]: { override, updatedAt } }
 */
export async function getFeeWaiverOverridesForCard(cardId) {
  if (!cardId) return {};
  const cleanId = String(cardId).trim();
  const allOverrides = await getFeeWaiverOverrides();
  return allOverrides[cleanId] || {};
}

/**
 * Saves or resets a manual eligibility override for a transaction.
 *
 * @param {string} cardId - Persistent card account ID.
 * @param {string} txnId - Persistent transaction ID.
 * @param {string|null} override - 'ELIGIBLE' | 'EXCLUDED' | null (to reset)
 * @returns {Promise<Object>} Updated card overrides map.
 */
export async function saveFeeWaiverOverride(cardId, txnId, override) {
  if (!cardId || !txnId) throw new Error('cardId and txnId required for override');
  const cleanCardId = String(cardId).trim();
  const cleanTxnId = String(txnId).trim();

  const allOverrides = await getFeeWaiverOverrides();
  const cardOverrides = { ...(allOverrides[cleanCardId] || {}) };

  if (override === null || override === undefined || override === 'RESET' || override === '') {
    delete cardOverrides[cleanTxnId];
  } else {
    cardOverrides[cleanTxnId] = {
      override: String(override).toUpperCase(),
      updatedAt: new Date().toISOString(),
    };
  }

  allOverrides[cleanCardId] = cardOverrides;
  await setSetting(SETTING_KEYS.OVERRIDES, JSON.stringify(allOverrides));
  return cardOverrides;
}

/**
 * 3-Way Merger for Manual Overrides.
 * Merges overrides cleanly per card and per transaction using LWW.
 *
 * @param {Object} options - { baseRaw, localRaw, cloudRaw }
 * @returns {Object} Merged overrides dictionary
 */
export function mergeCardOverrides3Way({ baseRaw, localRaw, cloudRaw }) {
  const parseObj = (r) => {
    try {
      const o = typeof r === 'string' ? JSON.parse(r) : r;
      return typeof o === 'object' && o !== null && !Array.isArray(o) ? o : {};
    } catch { return {}; }
  };

  const base = parseObj(baseRaw);
  const local = parseObj(localRaw);
  const cloud = parseObj(cloudRaw);

  const allCardIds = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(cloud)]);
  const merged = {};

  for (const cardId of allCardIds) {
    const bCard = base[cardId] || {};
    const lCard = local[cardId] || {};
    const cCard = cloud[cardId] || {};

    const allTxnIds = new Set([...Object.keys(bCard), ...Object.keys(lCard), ...Object.keys(cCard)]);
    const mergedCard = {};

    for (const txnId of allTxnIds) {
      const b = bCard[txnId];
      const l = lCard[txnId];
      const c = cCard[txnId];

      const lChanged = JSON.stringify(l) !== JSON.stringify(b);
      const cChanged = JSON.stringify(c) !== JSON.stringify(b);

      if (!lChanged && !cChanged) {
        if (b) mergedCard[txnId] = b;
      } else if (lChanged && !cChanged) {
        if (l) mergedCard[txnId] = l;
      } else if (!lChanged && cChanged) {
        if (c) mergedCard[txnId] = c;
      } else {
        const lTime = l?.updatedAt ? new Date(l.updatedAt).getTime() : 0;
        const cTime = c?.updatedAt ? new Date(c.updatedAt).getTime() : 0;
        const winner = lTime >= cTime ? l : c;
        if (winner) mergedCard[txnId] = winner;
      }
    }
    if (Object.keys(mergedCard).length > 0) {
      merged[cardId] = mergedCard;
    }
  }

  return merged;
}
