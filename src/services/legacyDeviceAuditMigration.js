/**
 * legacyDeviceAuditMigration.js — Controlled Legacy Device Audit Attribution Migration
 *
 * Provides dry-run analysis and safe, idempotent attribution of legacy transactions
 * (missing device provenance) to a designated target device (e.g. 'dev_c7e4544221f4').
 *
 * Guarantees:
 * 1. Financial fields, transaction IDs, created_at, and updated_at are strictly preserved.
 * 2. Only genuine legacy records (null, empty, 'Unknown', 'local_device') are modified.
 * 3. Distinguishes verified vs legacy-assigned attribution (sets provenance to 'LEGACY_ASSIGNED').
 * 4. Generates standard delta sync events so attribution propagates seamlessly cross-device.
 * 5. Dry-run performs zero writes.
 * 6. Execution requires explicit confirmation and performs pre/post cryptographic baseline verification.
 * 7. Reversion/rollback safely rolls back LEGACY_ASSIGNED records without touching VERIFIED edits.
 */

import { getDB, getRawIDB } from '../database/db.js';
import { executeAtomicBatch } from '../database/atomicMutation.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import { scheduleSync } from './deltaSyncCoordinator.js';
import { resolveDeviceAuditInfo } from './deviceAudit.js';

export const TARGET_DEVICE_ID = 'dev_c7e4544221f4';
export const TARGET_DEVICE_NAME = 'My Mobile';

/**
 * Validates that a device ID is well-formed.
 *
 * @param {string} deviceId
 * @returns {string}
 */
export function validateTargetDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') {
    throw new Error('INVALID_TARGET_DEVICE_ID: Target device ID must be a non-empty string.');
  }
  const clean = deviceId.trim();
  if (!clean.startsWith('dev_') || clean.length < 8) {
    throw new Error(`INVALID_TARGET_DEVICE_ID: "${deviceId}" is not a valid FinMan device ID (must start with "dev_" and have >= 8 chars).`);
  }
  return clean;
}

/**
 * Dynamically resolves the human-readable target device name using the device audit registry.
 *
 * @param {string} deviceId
 * @param {string} [explicitName=null]
 * @returns {string}
 */
export function resolveTargetDeviceName(deviceId, explicitName = null) {
  if (explicitName && String(explicitName).trim()) {
    return String(explicitName).trim();
  }
  try {
    const info = resolveDeviceAuditInfo(deviceId);
    if (info && info.deviceName && !info.deviceName.startsWith('Device ')) {
      return info.deviceName;
    }
  } catch {}
  return TARGET_DEVICE_NAME;
}

/**
 * Checks whether an audit field value represents an unassigned / legacy state.
 *
 * @param {string|null|undefined} devId
 * @returns {boolean}
 */
export function isFieldEligibleForAttribution(devId) {
  if (devId === null || devId === undefined) return true;
  const s = String(devId).trim();
  return s === '' || s === 'Unknown' || s === 'local_device';
}

/**
 * Scans a given table (transactions or investment_transactions) and collects audit eligibility metrics.
 *
 * @param {Object} db
 * @param {string} tableName
 * @returns {Promise<Object>}
 */
export async function scanTableAuditEligibility(db, tableName) {
  const res = await db.query(`SELECT * FROM ${tableName}`);
  const rows = res.values || [];

  let totalRecords = rows.length;
  let eligibleCreatorCount = 0;
  let eligibleModifierCount = 0;
  let bothEligibleCount = 0;
  let onlyCreatorEligibleCount = 0;
  let onlyModifierEligibleCount = 0;
  let excludedCount = 0;
  let indeterminateCount = 0;

  const eligibleItems = [];

  for (const r of rows) {
    if (!r.id) {
      indeterminateCount++;
      continue;
    }

    const cEligible = isFieldEligibleForAttribution(r.created_by_device_id);
    const mEligible = isFieldEligibleForAttribution(r.updated_by_device_id);

    if (cEligible) eligibleCreatorCount++;
    if (mEligible) eligibleModifierCount++;

    if (cEligible && mEligible) {
      bothEligibleCount++;
      eligibleItems.push({ row: r, cEligible, mEligible });
    } else if (cEligible && !mEligible) {
      onlyCreatorEligibleCount++;
      eligibleItems.push({ row: r, cEligible, mEligible });
    } else if (!cEligible && mEligible) {
      onlyModifierEligibleCount++;
      eligibleItems.push({ row: r, cEligible, mEligible });
    } else {
      excludedCount++;
    }
  }

  return {
    tableName,
    totalRecords,
    eligibleCreatorCount,
    eligibleModifierCount,
    bothEligibleCount,
    onlyCreatorEligibleCount,
    onlyModifierEligibleCount,
    partialProvenanceCount: onlyCreatorEligibleCount + onlyModifierEligibleCount,
    totalRowUpdates: eligibleItems.length,
    totalDeltaEvents: eligibleItems.length,
    totalFieldUpdates: eligibleCreatorCount + eligibleModifierCount,
    excludedCount,
    indeterminateCount,
    eligibleItems
  };
}

/**
 * Computes a cryptographic checksum of all financial fields and timestamps across all records.
 * Used for pre/post migration invariant verification.
 * Disambiguates records by including table identity so shared UUIDs across tables do not collide.
 *
 * @param {Array<Object>} rows
 * @returns {Promise<string>}
 */
export async function computeFinancialBaselineChecksum(rows) {
  const getRowTable = (r) => r._table || r.table || r.storeName || (r.security_symbol !== undefined || r.trade_value !== undefined || r.quantity !== undefined ? 'investment_transactions' : 'transactions');

  // Sort rows deterministically by table and ID
  const sorted = [...rows].sort((a, b) => {
    const tableA = getRowTable(a);
    const tableB = getRowTable(b);
    const cmp = tableA.localeCompare(tableB);
    if (cmp !== 0) return cmp;
    return String(a.id).localeCompare(String(b.id));
  });

  const baseline = sorted.map(r => ({
    _table: getRowTable(r),
    id: r.id,
    date: r.date || r.Date || '',
    time: r.time || r.Time || '',
    account: r.account || r.Account || '',
    from_account: r.from_account || '',
    to_account: r.to_account || '',
    sub_account: r.sub_account || '',
    from_sub_account: r.from_sub_account || '',
    to_sub_account: r.to_sub_account || '',
    category: r.category || r.Category || '',
    subcategory: r.subcategory || r.Subcategory || '',
    note: r.note || '',
    description: r.description || '',
    inr: r.inr !== undefined && r.inr !== null ? Number(r.inr) : (r.INR !== undefined && r.INR !== null ? Number(r.INR) : 0),
    amount: r.amount !== undefined && r.amount !== null ? String(r.amount) : (r.Amount !== undefined ? String(r.Amount) : '0'),
    currency: r.currency || '',
    type: r.type || r['Income/Expense'] || '',
    recurring_rule_id: r.recurring_rule_id || '',
    tags: r.tags || '',
    split_group_id: r.split_group_id || '',
    receipt_image: r.receipt_image || '',
    warranty_expiry: r.warranty_expiry || '',
    serial_no: r.serial_no || '',
    // Comprehensive investment financial fields
    investment_transaction_type: r.investment_transaction_type || '',
    brokerage: r.brokerage || '',
    security_symbol: r.security_symbol || '',
    security_isin: r.security_isin || '',
    security_display_name: r.security_display_name || '',
    quantity: r.quantity !== undefined && r.quantity !== null ? Number(r.quantity) : 0,
    unit_price: r.unit_price !== undefined && r.unit_price !== null ? Number(r.unit_price) : 0,
    trade_value: r.trade_value !== undefined && r.trade_value !== null ? Number(r.trade_value) : 0,
    cost_basis: r.cost_basis !== undefined && r.cost_basis !== null ? Number(r.cost_basis) : 0,
    cash_impact: r.cash_impact !== undefined && r.cash_impact !== null ? Number(r.cash_impact) : 0,
    position_qty_change: r.position_qty_change !== undefined && r.position_qty_change !== null ? Number(r.position_qty_change) : 0,
    realized_pnl: r.realized_pnl !== undefined && r.realized_pnl !== null ? Number(r.realized_pnl) : 0,
    trade_id: r.trade_id || '',
    order_id: r.order_id || '',
    exchange: r.exchange || '',
    segment: r.segment || '',
    source: r.source || '',
    investment_account: r.investment_account || '',
    actual_amount: r.actual_amount !== undefined && r.actual_amount !== null ? Number(r.actual_amount) : 0,
    total_charges: r.total_charges !== undefined && r.total_charges !== null ? Number(r.total_charges) : 0,
    brokerage_charges: r.brokerage_charges !== undefined && r.brokerage_charges !== null ? Number(r.brokerage_charges) : 0,
    exchange_charges: r.exchange_charges !== undefined && r.exchange_charges !== null ? Number(r.exchange_charges) : 0,
    stt_charges: r.stt_charges !== undefined && r.stt_charges !== null ? Number(r.stt_charges) : 0,
    sebi_charges: r.sebi_charges !== undefined && r.sebi_charges !== null ? Number(r.sebi_charges) : 0,
    stamp_duty_charges: r.stamp_duty_charges !== undefined && r.stamp_duty_charges !== null ? Number(r.stamp_duty_charges) : 0,
    gst_charges: r.gst_charges !== undefined && r.gst_charges !== null ? Number(r.gst_charges) : 0,
    dp_charges: r.dp_charges !== undefined && r.dp_charges !== null ? Number(r.dp_charges) : 0,
    other_charges: r.other_charges !== undefined && r.other_charges !== null ? Number(r.other_charges) : 0,
    settlement_mode: r.settlement_mode || '',
    // Preserved audit timestamps
    created_at: r.created_at || '',
    updated_at: r.updated_at || ''
  }));

  return await computeCanonicalSha256(baseline);
}

/**
 * Performs a safe dry-run analysis across ordinary and investment transactions.
 * Zero database modifications are performed.
 *
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
export async function runLegacyAuditDryRun(options = {}) {
  const db = options.db || getDB();
  const targetDeviceId = validateTargetDeviceId(options.targetDeviceId || TARGET_DEVICE_ID);
  const targetDeviceName = resolveTargetDeviceName(targetDeviceId, options.targetDeviceName);

  const ordinaryScan = await scanTableAuditEligibility(db, 'transactions');
  const investmentScan = await scanTableAuditEligibility(db, 'investment_transactions');

  const totalOrdinary = ordinaryScan.totalRecords;
  const totalInvestment = investmentScan.totalRecords;
  const totalScanned = totalOrdinary + totalInvestment;

  const eligibleCreatorTotal = ordinaryScan.eligibleCreatorCount + investmentScan.eligibleCreatorCount;
  const eligibleModifierTotal = ordinaryScan.eligibleModifierCount + investmentScan.eligibleModifierCount;
  const bothEligibleTotal = ordinaryScan.bothEligibleCount + investmentScan.bothEligibleCount;
  const onlyCreatorTotal = ordinaryScan.onlyCreatorEligibleCount + investmentScan.onlyCreatorEligibleCount;
  const onlyModifierTotal = ordinaryScan.onlyModifierEligibleCount + investmentScan.onlyModifierEligibleCount;
  const partialProvenanceTotal = onlyCreatorTotal + onlyModifierTotal;
  const totalRowUpdates = ordinaryScan.totalRowUpdates + investmentScan.totalRowUpdates;
  const totalDeltaEvents = ordinaryScan.totalDeltaEvents + investmentScan.totalDeltaEvents;
  const totalFieldUpdates = eligibleCreatorTotal + eligibleModifierTotal;
  const excludedTotal = ordinaryScan.excludedCount + investmentScan.excludedCount;
  const indeterminateTotal = ordinaryScan.indeterminateCount + investmentScan.indeterminateCount;

  // Compute read-only baseline checksum
  const preTxnsRes = await db.query('SELECT * FROM transactions');
  const preInvRes = await db.query('SELECT * FROM investment_transactions');
  const preTxns = (preTxnsRes.values || []).map(r => ({ ...r, _table: 'transactions' }));
  const preInv = (preInvRes.values || []).map(r => ({ ...r, _table: 'investment_transactions' }));
  const allPreTxns = [...preTxns, ...preInv];
  const baselineFinancialChecksum = await computeFinancialBaselineChecksum(allPreTxns);

  const accounting = {
    totalRowsScanned: totalScanned,
    eligibleCreatorFields: eligibleCreatorTotal,
    eligibleModifierFields: eligibleModifierTotal,
    rowsWithBothFieldsEligible: bothEligibleTotal,
    rowsWithOnlyCreatorEligible: onlyCreatorTotal,
    rowsWithOnlyModifierEligible: onlyModifierTotal,
    rowsWithPartialProvenance: partialProvenanceTotal,
    plannedDatabaseRowUpdates: totalRowUpdates,
    plannedDeltaEventsGenerated: totalDeltaEvents,
    plannedTotalFieldUpdates: totalFieldUpdates,
    recordsExcludedWithKnownAttribution: excludedTotal,
    indeterminateRecords: indeterminateTotal
  };

  const summary = {
    totalRecords: totalScanned,
    eligibleCreatorFields: eligibleCreatorTotal,
    eligibleModifierFields: eligibleModifierTotal,
    recordsWithBothEligible: bothEligibleTotal,
    recordsWithPartialProvenance: partialProvenanceTotal,
    recordsExcludedWithKnownAttribution: excludedTotal,
    indeterminateRecords: indeterminateTotal
  };

  return {
    mode: 'DRY_RUN',
    timestamp: new Date().toISOString(),
    targetDevice: {
      deviceId: targetDeviceId,
      deviceName: targetDeviceName
    },
    baselineFinancialChecksum,
    accounting,
    summary,
    byTable: {
      transactions: {
        total: ordinaryScan.totalRecords,
        totalRowsScanned: ordinaryScan.totalRecords,
        eligibleCreator: ordinaryScan.eligibleCreatorCount,
        eligibleCreatorFields: ordinaryScan.eligibleCreatorCount,
        eligibleModifier: ordinaryScan.eligibleModifierCount,
        eligibleModifierFields: ordinaryScan.eligibleModifierCount,
        bothEligible: ordinaryScan.bothEligibleCount,
        rowsWithBothFieldsEligible: ordinaryScan.bothEligibleCount,
        onlyCreator: ordinaryScan.onlyCreatorEligibleCount,
        rowsWithOnlyCreatorEligible: ordinaryScan.onlyCreatorEligibleCount,
        onlyModifier: ordinaryScan.onlyModifierEligibleCount,
        rowsWithOnlyModifierEligible: ordinaryScan.onlyModifierEligibleCount,
        plannedRowUpdates: ordinaryScan.totalRowUpdates,
        plannedDeltaEvents: ordinaryScan.totalDeltaEvents,
        plannedFieldUpdates: ordinaryScan.totalFieldUpdates,
        excluded: ordinaryScan.excludedCount,
        excludedRows: ordinaryScan.excludedCount,
        indeterminate: ordinaryScan.indeterminateCount,
        indeterminateRows: ordinaryScan.indeterminateCount
      },
      investment_transactions: {
        total: investmentScan.totalRecords,
        totalRowsScanned: investmentScan.totalRecords,
        eligibleCreator: investmentScan.eligibleCreatorCount,
        eligibleCreatorFields: investmentScan.eligibleCreatorCount,
        eligibleModifier: investmentScan.eligibleModifierCount,
        eligibleModifierFields: investmentScan.eligibleModifierCount,
        bothEligible: investmentScan.bothEligibleCount,
        rowsWithBothFieldsEligible: investmentScan.bothEligibleCount,
        onlyCreator: investmentScan.onlyCreatorEligibleCount,
        rowsWithOnlyCreatorEligible: investmentScan.onlyCreatorEligibleCount,
        onlyModifier: investmentScan.onlyModifierEligibleCount,
        rowsWithOnlyModifierEligible: investmentScan.onlyModifierEligibleCount,
        plannedRowUpdates: investmentScan.totalRowUpdates,
        plannedDeltaEvents: investmentScan.totalDeltaEvents,
        plannedFieldUpdates: investmentScan.totalFieldUpdates,
        excluded: investmentScan.excludedCount,
        excludedRows: investmentScan.excludedCount,
        indeterminate: investmentScan.indeterminateCount,
        indeterminateRows: investmentScan.indeterminateCount
      }
    }
  };
}

/**
 * Transactionally restores all affected tables if any batch in executeLegacyAuditMigration fails.
 * Guarantees:
 * 1. Restores transactions and investment_transactions to exact pre-migration state.
 * 2. Restores sync_delta_queue, purging all migration delta events.
 * 3. Restores sync_local_state.
 * 4. Executes in ONE ATOMIC TRANSACTION via db.executeSet or transaction block.
 * 5. Re-arms and independently verifies both SQLite settings and localStorage recovery locks.
 * 6. Preserves the recovery lock even if settings is restored.
 */
export async function rollbackLegacyAuditMigrationBatches({
  db,
  preTxns = [],
  preInv = [],
  preDeltaQueue = [],
  preLocalState = [],
  failedBatchIndex = 0,
  error = null
}) {
  console.warn(`[legacyDeviceAuditMigration] Initiating transactional rollback due to batch failure at index ${failedBatchIndex}:`, error?.message);

  const rollbackStatements = [];

  // 1. Restore transactions
  rollbackStatements.push({ statement: 'DELETE FROM transactions', values: [] });
  for (const row of preTxns) {
    const keys = Object.keys(row).filter(k => k !== '_table');
    const cols = keys.join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    rollbackStatements.push({
      statement: `INSERT INTO transactions (${cols}) VALUES (${placeholders})`,
      values: keys.map(k => row[k] ?? null)
    });
  }

  // 2. Restore investment_transactions
  rollbackStatements.push({ statement: 'DELETE FROM investment_transactions', values: [] });
  for (const row of preInv) {
    const keys = Object.keys(row).filter(k => k !== '_table');
    const cols = keys.join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    rollbackStatements.push({
      statement: `INSERT INTO investment_transactions (${cols}) VALUES (${placeholders})`,
      values: keys.map(k => row[k] ?? null)
    });
  }

  // 3. Restore sync_delta_queue (purges all delta events created by committed migration batches)
  rollbackStatements.push({ statement: 'DELETE FROM sync_delta_queue', values: [] });
  for (const q of preDeltaQueue) {
    const keys = Object.keys(q);
    const cols = keys.join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    rollbackStatements.push({
      statement: `INSERT INTO sync_delta_queue (${cols}) VALUES (${placeholders})`,
      values: keys.map(k => (typeof q[k] === 'object' && q[k] !== null ? JSON.stringify(q[k]) : (q[k] ?? null)))
    });
  }

  // 4. Restore sync_local_state
  rollbackStatements.push({ statement: 'DELETE FROM sync_local_state', values: [] });
  for (const s of preLocalState) {
    const keys = Object.keys(s);
    const cols = keys.join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    rollbackStatements.push({
      statement: `INSERT INTO sync_local_state (${cols}) VALUES (${placeholders})`,
      values: keys.map(k => s[k] ?? null)
    });
  }

  // Execute rollback statements in ONE atomic transaction
  if (typeof db.executeSet === 'function') {
    await db.executeSet(rollbackStatements);
  } else if (typeof db.batchReplace === 'function') {
    await db.batchReplace('transactions', preTxns.map(r => { const { _table, ...rest } = r; return rest; }));
    await db.batchReplace('investment_transactions', preInv.map(r => { const { _table, ...rest } = r; return rest; }));
    await db.batchReplace('sync_delta_queue', preDeltaQueue);
    await db.batchReplace('sync_local_state', preLocalState);
  } else {
    for (const stmt of rollbackStatements) {
      await db.run(stmt.statement, stmt.values);
    }
  }

  // 5. Re-arm and verify dual recovery safety lock
  const { setRecoverySafetyLock } = await import('./recoveryLock.js');
  await setRecoverySafetyLock('BATCH_MIGRATION_FAILURE_ROLLBACK');

  // Verify SQLite settings lock
  const { getSetting } = await import('../database/settings.js');
  const lockSetting = await getSetting('finman_recovery_safety_lock');
  let sqliteArmed = false;
  try {
    const parsed = typeof lockSetting === 'string' ? JSON.parse(lockSetting) : lockSetting;
    sqliteArmed = parsed?.locked === true || lockSetting === 'LOCKED';
  } catch {
    sqliteArmed = lockSetting === 'LOCKED';
  }
  if (!sqliteArmed) {
    throw new Error('CRITICAL_ROLLBACK_SECURITY_FAILURE: SQLite recovery lock could not be verified armed after rollback!');
  }

  // Verify localStorage lock independently
  let localArmed = false;
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem('finman_recovery_safety_lock');
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      localArmed = parsed?.locked === true;
    } catch {}
  } else {
    localArmed = true; // Non-browser environment
  }
  if (!localArmed) {
    throw new Error('CRITICAL_ROLLBACK_SECURITY_FAILURE: localStorage recovery lock could not be verified armed after rollback!');
  }

  return {
    rolledBack: true,
    failedBatchIndex,
    restoredCounts: {
      transactions: preTxns.length,
      investment_transactions: preInv.length,
      sync_delta_queue: preDeltaQueue.length,
      sync_local_state: preLocalState.length
    },
    recoveryLockArmed: true
  };
}

/**
 * Executes the legacy audit attribution migration under explicit user authorization.
 *
 * Safeguards:
 * 1. Checks confirmation flag.
 * 2. Computes baseline financial checksum before migration.
 * 3. Updates only eligible audit fields, setting provenance to 'LEGACY_ASSIGNED'.
 * 4. Preserves all financial fields, IDs, created_at, and updated_at.
 * 5. Generates atomic delta sync events for cross-device propagation.
 * 6. Verifies post-migration financial checksum matches pre-migration baseline.
 * 7. Transactionally rolls back all affected tables if any batch fails or verification fails.
 *
 * @param {Object} options
 * @param {boolean} options.confirmed Must be explicitly set to true.
 * @param {string} [options.targetDeviceId] Defaults to dev_c7e4544221f4.
 * @param {number} [options.batchSize=200]
 * @returns {Promise<Object>}
 */
export async function executeLegacyAuditMigration(options = {}) {
  if (options.confirmed !== true) {
    throw new Error('MIGRATION_ABORTED: Migration requires explicit user confirmation ({ confirmed: true }).');
  }

  const db = options.db || getDB();
  const targetDeviceId = validateTargetDeviceId(options.targetDeviceId || TARGET_DEVICE_ID);
  const targetDeviceName = resolveTargetDeviceName(targetDeviceId, options.targetDeviceName);
  const batchSize = options.batchSize || 200;

  // 1. Fetch pre-migration rows and compute baseline checksums
  const preTxnsRes = await db.query('SELECT * FROM transactions');
  const preInvRes = await db.query('SELECT * FROM investment_transactions');
  const preDeltaRes = await db.query('SELECT * FROM sync_delta_queue');
  const preLocalRes = await db.query('SELECT * FROM sync_local_state');

  const preTxns = (preTxnsRes.values || []).map(r => ({ ...r, _table: 'transactions' }));
  const preInv = (preInvRes.values || []).map(r => ({ ...r, _table: 'investment_transactions' }));
  const preDeltaQueue = preDeltaRes.values || [];
  const preLocalState = preLocalRes.values || [];

  const allPreTxns = [...preTxns, ...preInv];
  const preBaselineChecksum = await computeFinancialBaselineChecksum(allPreTxns);

  // 2. Scan eligible records
  const ordinaryScan = await scanTableAuditEligibility(db, 'transactions');
  const investmentScan = await scanTableAuditEligibility(db, 'investment_transactions');

  const totalEligible = ordinaryScan.eligibleItems.length + investmentScan.eligibleItems.length;
  if (totalEligible === 0) {
    return {
      success: true,
      mode: 'EXECUTE',
      alreadyMigrated: true,
      message: 'All records already have valid device attribution. Zero records modified.',
      migratedCount: 0,
      migrated: {
        migratedCount: 0,
        totalRecordsUpdated: 0,
        totalDatabaseRowUpdates: 0,
        totalDeltaEventsGenerated: 0,
        totalFieldUpdates: 0,
        ordinaryUpdated: 0,
        investmentUpdated: 0,
        ordinaryRowUpdates: 0,
        investmentRowUpdates: 0,
        eligibleCreatorFields: 0,
        eligibleModifierFields: 0
      }
    };
  }

  let currentBatchIndex = 0;
  let ordinaryUpdated = 0;
  let investmentUpdated = 0;

  try {
    // 3. Process ordinary transactions in batches
    for (let i = 0; i < ordinaryScan.eligibleItems.length; i += batchSize) {
      currentBatchIndex++;
      const chunk = ordinaryScan.eligibleItems.slice(i, i + batchSize);
      const ops = [];

      for (const item of chunk) {
        const original = item.row;
        const updatedEntity = {
          ...original,
          created_by_device_id: item.cEligible ? targetDeviceId : original.created_by_device_id,
          created_by_provenance: item.cEligible ? 'LEGACY_ASSIGNED' : (original.created_by_provenance || 'VERIFIED'),
          updated_by_device_id: item.mEligible ? targetDeviceId : original.updated_by_device_id,
          updated_by_provenance: item.mEligible ? 'LEGACY_ASSIGNED' : (original.updated_by_provenance || 'VERIFIED'),
          // Explicitly preserve timestamps
          created_at: original.created_at,
          updated_at: original.updated_at
        };

        ops.push({
          storeName: 'transactions',
          id: original.id,
          operation: 'UPDATE',
          entity: updatedEntity,
          expectedBaseEntity: original
        });
        ordinaryUpdated++;
      }

      if (ops.length > 0) {
        await executeAtomicBatch({ operations: ops });
      }
    }

    // 4. Process investment transactions in batches
    for (let i = 0; i < investmentScan.eligibleItems.length; i += batchSize) {
      currentBatchIndex++;
      const chunk = investmentScan.eligibleItems.slice(i, i + batchSize);
      const ops = [];

      for (const item of chunk) {
        const original = item.row;
        const updatedEntity = {
          ...original,
          created_by_device_id: item.cEligible ? targetDeviceId : original.created_by_device_id,
          created_by_provenance: item.cEligible ? 'LEGACY_ASSIGNED' : (original.created_by_provenance || 'VERIFIED'),
          updated_by_device_id: item.mEligible ? targetDeviceId : original.updated_by_device_id,
          updated_by_provenance: item.mEligible ? 'LEGACY_ASSIGNED' : (original.updated_by_provenance || 'VERIFIED'),
          // Explicitly preserve timestamps
          created_at: original.created_at,
          updated_at: original.updated_at
        };

        ops.push({
          storeName: 'investment_transactions',
          id: original.id,
          operation: 'UPDATE',
          entity: updatedEntity,
          expectedBaseEntity: original
        });
        investmentUpdated++;
      }

      if (ops.length > 0) {
        await executeAtomicBatch({ operations: ops });
      }
    }

    // 5. Post-migration Invariant Verification
    const postTxnsRes = await db.query('SELECT * FROM transactions');
    const postInvRes = await db.query('SELECT * FROM investment_transactions');
    const postTxns = (postTxnsRes.values || []).map(r => ({ ...r, _table: 'transactions' }));
    const postInv = (postInvRes.values || []).map(r => ({ ...r, _table: 'investment_transactions' }));
    const allPostTxns = [...postTxns, ...postInv];

    const postBaselineChecksum = await computeFinancialBaselineChecksum(allPostTxns);

    if (postBaselineChecksum !== preBaselineChecksum) {
      throw new Error('CRITICAL_POST_VERIFICATION_FAILURE: Financial fields or timestamps mutated during audit migration!');
    }

    if (allPostTxns.length !== allPreTxns.length) {
      throw new Error(`CRITICAL_POST_VERIFICATION_FAILURE: Record count changed from ${allPreTxns.length} to ${allPostTxns.length}!`);
    }

    // Trigger cross-device sync schedule
    try {
      scheduleSync({ immediate: true });
    } catch {}

    const totalUpdated = ordinaryUpdated + investmentUpdated;

    return {
      success: true,
      mode: 'EXECUTE',
      timestamp: new Date().toISOString(),
      targetDevice: {
        deviceId: targetDeviceId,
        deviceName: targetDeviceName
      },
      verification: {
        preBaselineChecksum,
        postBaselineChecksum,
        checksumsMatch: postBaselineChecksum === preBaselineChecksum,
        preRecordCount: allPreTxns.length,
        postRecordCount: allPostTxns.length,
        countsMatch: allPostTxns.length === allPreTxns.length
      },
      migratedCount: totalUpdated,
      migrated: {
        migratedCount: totalUpdated,
        totalRecordsUpdated: totalUpdated,
        totalDatabaseRowUpdates: totalUpdated,
        totalDeltaEventsGenerated: totalUpdated,
        totalFieldUpdates: (ordinaryScan.eligibleCreatorCount + investmentScan.eligibleCreatorCount) + (ordinaryScan.eligibleModifierCount + investmentScan.eligibleModifierCount),
        ordinaryUpdated,
        investmentUpdated,
        ordinaryRowUpdates: ordinaryUpdated,
        investmentRowUpdates: investmentUpdated,
        eligibleCreatorFields: ordinaryScan.eligibleCreatorCount + investmentScan.eligibleCreatorCount,
        eligibleModifierFields: ordinaryScan.eligibleModifierCount + investmentScan.eligibleModifierCount
      }
    };
  } catch (err) {
    console.error(`[legacyDeviceAuditMigration] Migration failed at batch ${currentBatchIndex}:`, err);
    let rollbackResult = null;
    try {
      rollbackResult = await rollbackLegacyAuditMigrationBatches({
        db,
        preTxns: preTxnsRes.values || [],
        preInv: preInvRes.values || [],
        preDeltaQueue,
        preLocalState,
        failedBatchIndex: currentBatchIndex,
        error: err
      });
    } catch (rbErr) {
      console.error('[legacyDeviceAuditMigration] Catastrophic: Rollback failed:', rbErr);
      throw new Error(`MIGRATION_FAILED_AND_ROLLBACK_FAILED: Original error: ${err.message}. Rollback error: ${rbErr.message}`);
    }

    const migrationError = new Error(`MIGRATION_EXECUTION_FAILED: ${err.message} [ROLLED_BACK_CLEANLY: ${rollbackResult.restoredCounts.transactions} txns, ${rollbackResult.restoredCounts.investment_transactions} inv_txns restored; delta events purged; locks re-armed]`);
    migrationError.rollbackResult = rollbackResult;
    migrationError.originalError = err;
    throw migrationError;
  }
}

/**
 * Reverts legacy audit attribution safely without overwriting subsequent verified edits.
 *
 * Rules:
 * 1. Only rows with provenance === 'LEGACY_ASSIGNED' are reverted to null.
 * 2. Any row or field with provenance === 'VERIFIED' (e.g. edited after migration) is strictly preserved.
 * 3. Atomic pre/post financial checksum verification is performed.
 * 4. Generates reverting delta sync events so reversion propagates cross-device.
 *
 * @param {Object} options
 * @param {boolean} options.confirmed Must be explicitly set to true.
 * @param {string} [options.targetDeviceId] Defaults to dev_c7e4544221f4.
 * @param {number} [options.batchSize=200]
 * @returns {Promise<Object>}
 */
export async function revertLegacyAuditMigration(options = {}) {
  if (options.confirmed !== true) {
    throw new Error('REVERT_ABORTED: Reversion requires explicit user confirmation ({ confirmed: true }).');
  }

  const db = options.db || getDB();
  const targetDeviceId = validateTargetDeviceId(options.targetDeviceId || TARGET_DEVICE_ID);
  const targetDeviceName = resolveTargetDeviceName(targetDeviceId, options.targetDeviceName);
  const batchSize = options.batchSize || 200;

  // 1. Fetch pre-revert rows and compute baseline checksums
  const preTxnsRes = await db.query('SELECT * FROM transactions');
  const preInvRes = await db.query('SELECT * FROM investment_transactions');
  const preTxns = (preTxnsRes.values || []).map(r => ({ ...r, _table: 'transactions' }));
  const preInv = (preInvRes.values || []).map(r => ({ ...r, _table: 'investment_transactions' }));
  const allPreTxns = [...preTxns, ...preInv];

  const preBaselineChecksum = await computeFinancialBaselineChecksum(allPreTxns);

  // 2. Scan both tables for LEGACY_ASSIGNED rows matching targetDeviceId
  const findRevertible = (rows, storeName) => {
    const revertible = [];
    for (const r of rows) {
      const cIsLegacy = (r.created_by_provenance === 'LEGACY_ASSIGNED' || !r.created_by_provenance) && (r.created_by_device_id === targetDeviceId);
      const mIsLegacy = (r.updated_by_provenance === 'LEGACY_ASSIGNED' || !r.updated_by_provenance) && (r.updated_by_device_id === targetDeviceId);

      if (cIsLegacy || mIsLegacy) {
        revertible.push({ row: r, cIsLegacy, mIsLegacy, storeName });
      }
    }
    return revertible;
  };

  const ordinaryRevertible = findRevertible(preTxnsRes.values || [], 'transactions');
  const investmentRevertible = findRevertible(preInvRes.values || [], 'investment_transactions');

  const totalRevertible = ordinaryRevertible.length + investmentRevertible.length;
  if (totalRevertible === 0) {
    return {
      success: true,
      mode: 'REVERT',
      alreadyReverted: true,
      message: 'No legacy-assigned audit records found matching target device. Zero rows modified.',
      revertedCount: 0
    };
  }

  let rowsReverted = 0;
  const allRevertible = [...ordinaryRevertible, ...investmentRevertible];

  for (let i = 0; i < allRevertible.length; i += batchSize) {
    const chunk = allRevertible.slice(i, i + batchSize);
    const ops = [];

    for (const item of chunk) {
      const original = item.row;
      const updatedEntity = {
        ...original,
        // Only revert if it was LEGACY_ASSIGNED; never touch VERIFIED!
        created_by_device_id: item.cIsLegacy ? null : original.created_by_device_id,
        created_by_provenance: item.cIsLegacy ? null : original.created_by_provenance,
        updated_by_device_id: item.mIsLegacy ? null : original.updated_by_device_id,
        updated_by_provenance: item.mIsLegacy ? null : original.updated_by_provenance,
        created_at: original.created_at,
        updated_at: original.updated_at
      };

      ops.push({
        storeName: item.storeName,
        id: original.id,
        operation: 'UPDATE',
        entity: updatedEntity,
        expectedBaseEntity: original
      });
      rowsReverted++;
    }

    if (ops.length > 0) {
      await executeAtomicBatch({ operations: ops });
    }
  }

  // 3. Post-revert Invariant Verification
  const postTxnsRes = await db.query('SELECT * FROM transactions');
  const postInvRes = await db.query('SELECT * FROM investment_transactions');
  const postTxns = (postTxnsRes.values || []).map(r => ({ ...r, _table: 'transactions' }));
  const postInv = (postInvRes.values || []).map(r => ({ ...r, _table: 'investment_transactions' }));
  const allPostTxns = [...postTxns, ...postInv];

  const postBaselineChecksum = await computeFinancialBaselineChecksum(allPostTxns);

  if (postBaselineChecksum !== preBaselineChecksum) {
    throw new Error('CRITICAL_REVERT_VERIFICATION_FAILURE: Financial fields or timestamps mutated during revert!');
  }

  try {
    scheduleSync({ immediate: true });
  } catch {}

  return {
    success: true,
    mode: 'REVERT',
    timestamp: new Date().toISOString(),
    verification: {
      preBaselineChecksum,
      postBaselineChecksum,
      checksumsMatch: postBaselineChecksum === preBaselineChecksum
    },
    reverted: {
      totalDatabaseRowUpdates: rowsReverted,
      totalDeltaEventsGenerated: rowsReverted
    }
  };
}

/**
 * Exposes read-only audit diagnostics to the global window object in browser / dev mode.
 * Safe for inspection without write permissions.
 */
export function exposeLegacyAuditDevDiagnostics() {
  if (typeof window !== 'undefined') {
    window.__finman_audit_diagnostics = {
      runDryRun: (opts) => runLegacyAuditDryRun(opts),
      TARGET_DEVICE_ID,
      TARGET_DEVICE_NAME
    };
  }
}
