/**
 * FinMan EMI Calculator Storage Engine
 *
 * Provides persistent management for saved EMI calculations:
 * - Load, save, update, and delete saved calculations
 * - Authoritative input persistence: calculations are recalculated dynamically using the EMI engine
 * - Dual persistence: FinMan SQLite/IndexedDB settings table with localStorage fallback
 * - Case-insensitive trimmed duplicate name prevention
 * - Full audit timestamps (createdAt, updatedAt) and versioning
 */

import { getSetting, setSetting } from '../database/settings.js';
import { calculateReducingBalanceEmi } from './emiCalculator.js';

export const SETTINGS_KEY_SAVED_EMI = 'finman_saved_emi_calculations';
export const EMI_CALCULATION_VERSION = 1;

/**
 * Generate a unique ID for a saved calculation.
 *
 * @returns {string}
 */
export function generateEmiId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try {
      return crypto.randomUUID();
    } catch {
      // Fallback below
    }
  }
  return `emi_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Formats a saved timestamp in readable format: "Saved on 22 Nov 2026, 03:45 PM".
 *
 * @param {string|Date} timestamp
 * @returns {string}
 */
export function formatSavedDate(timestamp) {
  if (!timestamp) return '';
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return String(timestamp);
    const datePart = d.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    const timePart = d.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).toUpperCase();
    return `Saved on ${datePart}, ${timePart}`;
  } catch {
    return String(timestamp);
  }
}

/**
 * Reads raw records from storage.
 *
 * @returns {Promise<Array>}
 */
async function getRawRecords() {
  let raw = null;

  // 1. Try DB settings table
  try {
    raw = await getSetting(SETTINGS_KEY_SAVED_EMI, null);
  } catch {
    raw = null;
  }

  // 2. Fallback to localStorage if DB returned null or is unavailable
  if (!raw && typeof localStorage !== 'undefined') {
    try {
      raw = localStorage.getItem(SETTINGS_KEY_SAVED_EMI);
    } catch {
      raw = null;
    }
  }

  if (!raw) return [];

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Persists raw records to both DB settings and localStorage.
 *
 * @param {Array} records
 * @returns {Promise<boolean>}
 */
async function persistRecords(records) {
  const jsonStr = JSON.stringify(records);

  // 1. Persist to localStorage for synchronous availability & offline/fast read
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(SETTINGS_KEY_SAVED_EMI, jsonStr);
    } catch (err) {
      console.warn('[emiStorage] localStorage write failed:', err);
    }
  }

  // 2. Persist to DB settings table (local-only, non-synced setting)
  try {
    await setSetting(SETTINGS_KEY_SAVED_EMI, jsonStr, { suppressDeltaQueue: true });
    return true;
  } catch (err) {
    console.warn('[emiStorage] DB setSetting failed:', err);
    // Return true if localStorage succeeded
    return typeof localStorage !== 'undefined';
  }
}

/**
 * Normalizes a saved record and dynamically re-computes its summary & schedule
 * using the current calculation engine so calculations are never stale.
 *
 * @param {Object} record
 * @returns {Object}
 */
export function normalizeSavedRecord(record) {
  if (!record || typeof record !== 'object') return null;

  const inputs = record.inputs || {};
  const calculation = calculateReducingBalanceEmi({
    principal: inputs.principal,
    annualRate: inputs.annualRate,
    tenure: inputs.tenure,
    tenureType: inputs.tenureType,
    startDate: inputs.startDate,
    includeGstOnInterest: inputs.includeGstOnInterest,
    gstRateInterest: inputs.gstRateInterest,
    processingFee: inputs.processingFee,
    gstRateProcessingFee: inputs.gstRateProcessingFee,
  });

  return {
    id: record.id || generateEmiId(),
    name: String(record.name || 'Untitled Calculation').trim(),
    inputs: {
      principal: inputs.principal ?? '',
      annualRate: inputs.annualRate ?? '',
      tenure: inputs.tenure ?? '',
      tenureType: inputs.tenureType || 'months',
      startDate: inputs.startDate || '',
      includeGstOnInterest: inputs.includeGstOnInterest ?? true,
      gstRateInterest: inputs.gstRateInterest ?? 18,
      processingFee: inputs.processingFee ?? 299,
      gstRateProcessingFee: inputs.gstRateProcessingFee ?? 18,
    },
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
    calculationVersion: record.calculationVersion || EMI_CALCULATION_VERSION,
    // Dynamically computed metrics for display
    calculation,
    summary: calculation.summary,
    schedule: calculation.schedule,
    totals: calculation.totals,
  };
}

/**
 * Load all saved EMI calculations sorted by most recently saved/updated first.
 *
 * @returns {Promise<Array>}
 */
export async function loadSavedEmiCalculations() {
  try {
    const rawList = await getRawRecords();
    const normalized = rawList
      .map(normalizeSavedRecord)
      .filter(Boolean)
      .sort((a, b) => {
        const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return timeB - timeA;
      });
    return normalized;
  } catch (err) {
    console.error('[emiStorage] Failed to load saved calculations:', err);
    return [];
  }
}

/**
 * Validates a calculation name and checks for duplicates.
 *
 * @param {string} name - Proposed name
 * @param {Array} existingRecords - Current list of records
 * @param {string} [excludeId] - ID to exclude (when editing)
 * @returns {{ isValid: boolean, error?: string, trimmedName: string }}
 */
export function validateCalculationName(name, existingRecords = [], excludeId = null) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';

  if (!trimmedName) {
    return {
      isValid: false,
      error: 'Calculation name is required.',
      trimmedName: '',
    };
  }

  const lowerName = trimmedName.toLowerCase();
  const duplicate = existingRecords.find(r => {
    if (excludeId && r.id === excludeId) return false;
    return (r.name || '').trim().toLowerCase() === lowerName;
  });

  if (duplicate) {
    return {
      isValid: false,
      error: `A calculation named "${trimmedName}" already exists. Please choose a different name.`,
      trimmedName,
    };
  }

  return {
    isValid: true,
    trimmedName,
  };
}

/**
 * Saves a new EMI calculation.
 *
 * @param {Object} params
 * @param {string} params.name - User-specified name
 * @param {Object} params.inputs - Original input fields
 * @returns {Promise<{ success: boolean, record?: Object, error?: string }>}
 */
export async function saveEmiCalculation({ name, inputs }) {
  try {
    const records = await getRawRecords();
    const validation = validateCalculationName(name, records);

    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const newRecord = {
      id: generateEmiId(),
      name: validation.trimmedName,
      inputs: {
        principal: inputs?.principal ?? '',
        annualRate: inputs?.annualRate ?? '',
        tenure: inputs?.tenure ?? '',
        tenureType: inputs?.tenureType || 'months',
        startDate: inputs?.startDate || '',
        includeGstOnInterest: inputs?.includeGstOnInterest ?? true,
        gstRateInterest: inputs?.gstRateInterest ?? 18,
        processingFee: inputs?.processingFee ?? 299,
        gstRateProcessingFee: inputs?.gstRateProcessingFee ?? 18,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      calculationVersion: EMI_CALCULATION_VERSION,
    };

    records.unshift(newRecord);
    await persistRecords(records);

    return {
      success: true,
      record: normalizeSavedRecord(newRecord),
    };
  } catch (err) {
    console.error('[emiStorage] Save failed:', err);
    return {
      success: false,
      error: err?.message || 'Failed to save calculation.',
    };
  }
}

/**
 * Updates an existing saved EMI calculation (Save Changes).
 *
 * @param {string} id - Record ID to update
 * @param {Object} params
 * @param {string} [params.name] - New name
 * @param {Object} [params.inputs] - Updated input fields
 * @returns {Promise<{ success: boolean, record?: Object, error?: string }>}
 */
export async function updateSavedEmiCalculation(id, { name, inputs }) {
  if (!id) return { success: false, error: 'Record ID is required.' };

  try {
    const records = await getRawRecords();
    const idx = records.findIndex(r => r.id === id);

    if (idx === -1) {
      return { success: false, error: 'Saved calculation not found.' };
    }

    const currentRecord = records[idx];
    const proposedName = name !== undefined ? name : currentRecord.name;
    const validation = validateCalculationName(proposedName, records, id);

    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    const updatedRecord = {
      ...currentRecord,
      name: validation.trimmedName,
      inputs: inputs ? {
        principal: inputs.principal ?? currentRecord.inputs.principal,
        annualRate: inputs.annualRate ?? currentRecord.inputs.annualRate,
        tenure: inputs.tenure ?? currentRecord.inputs.tenure,
        tenureType: inputs.tenureType || currentRecord.inputs.tenureType || 'months',
        startDate: inputs.startDate || currentRecord.inputs.startDate || '',
        includeGstOnInterest: inputs.includeGstOnInterest ?? currentRecord.inputs.includeGstOnInterest ?? true,
        gstRateInterest: inputs.gstRateInterest ?? currentRecord.inputs.gstRateInterest ?? 18,
        processingFee: inputs.processingFee ?? currentRecord.inputs.processingFee ?? 299,
        gstRateProcessingFee: inputs.gstRateProcessingFee ?? currentRecord.inputs.gstRateProcessingFee ?? 18,
      } : currentRecord.inputs,
      updatedAt: new Date().toISOString(),
    };

    records[idx] = updatedRecord;
    await persistRecords(records);

    return {
      success: true,
      record: normalizeSavedRecord(updatedRecord),
    };
  } catch (err) {
    console.error('[emiStorage] Update failed:', err);
    return {
      success: false,
      error: err?.message || 'Failed to update calculation.',
    };
  }
}

/**
 * Deletes a saved EMI calculation by ID.
 *
 * @param {string} id - Record ID to delete
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function deleteSavedEmiCalculation(id) {
  if (!id) return { success: false, error: 'Record ID is required.' };

  try {
    const records = await getRawRecords();
    const filtered = records.filter(r => r.id !== id);

    if (filtered.length === records.length) {
      return { success: false, error: 'Record not found.' };
    }

    await persistRecords(filtered);
    return { success: true };
  } catch (err) {
    console.error('[emiStorage] Delete failed:', err);
    return {
      success: false,
      error: err?.message || 'Failed to delete calculation.',
    };
  }
}

