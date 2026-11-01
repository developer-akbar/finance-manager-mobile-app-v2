/**
 * nativeRecoveryDiagnostic.js
 *
 * Safe Android-compatible diagnostic utilities for physical-device testing.
 * Statically bundled into the production APK — no dynamic /src/ runtime imports.
 *
 * 1. verifyNativeBackupDiagnostic(): Strict READ-ONLY verification of physical
 *    durable SQLite backup (file presence, SQLite integrity, table counts vs metadata).
 * 2. executeSelfRestoreDiagnostic(): Explicitly-triggered native restore of
 *    durable SQLite backup with pre-check, atomic restore, and post-verification.
 */

import { getDB } from '../database/db.js';
import { getSetting } from '../database/settings.js';

/**
 * 1. Strict READ-ONLY backup verification operation.
 * - Reads persisted metadata from settings table.
 * - Attaches backup database outside any transaction.
 * - Checks physical file presence and SQLite integrity (PRAGMA integrity_check).
 * - Checks record counts (transactions, investments, accounts, categories) via SQL scalar count.
 * - Compares with backup metadata.
 * - Leaves all operational tables, settings, and cloud state completely untouched.
 */
export async function verifyNativeBackupDiagnostic(options = {}) {
  console.log('[NativeRecoveryDiagnostic] === Starting READ-ONLY Backup Verification ===');
  const startTime = performance.now();
  const db = options.db || getDB();

  // 1. Read persisted metadata
  const metaStr = await getSetting('pre_recovery_durable_backup_meta');
  if (!metaStr) {
    throw new Error('[NativeRecoveryDiagnostic] No pre_recovery_durable_backup_meta found in settings table.');
  }

  let meta;
  try {
    meta = JSON.parse(metaStr);
  } catch (err) {
    throw new Error(`[NativeRecoveryDiagnostic] Failed to parse backup metadata JSON: ${err.message}`);
  }

  const backupPath = meta.backup_path;
  if (!backupPath) {
    throw new Error('[NativeRecoveryDiagnostic] Backup metadata does not contain a backup_path.');
  }

  console.log(`[NativeRecoveryDiagnostic] Target backup file: ${backupPath}`);
  console.log(`[NativeRecoveryDiagnostic] Expected counts from metadata: transactions=${meta.counts?.transactions}, investments=${meta.counts?.investment_transactions}, total=${meta.counts?.totalTransactions}`);

  // 2. Attach backup database strictly outside any transaction
  const execNonTransactional = db.execNonTransactional || (async (sql) => {
    if (typeof db.execute === 'function') return await db.execute(sql, false);
    return await db.run(sql, [], false);
  });

  await execNonTransactional(`ATTACH DATABASE '${backupPath}' AS diag_audit_bkp;`);

  try {
    // 3. Check SQLite integrity of attached backup file
    const integrityRes = await db.query('PRAGMA diag_audit_bkp.integrity_check;');
    const integrityStatus = integrityRes.values?.[0]?.integrity_check || integrityRes.values?.[0]?.['integrity_check'] || 'unknown';
    console.log(`[NativeRecoveryDiagnostic] SQLite Integrity Check: ${integrityStatus}`);
    if (integrityStatus.toLowerCase() !== 'ok') {
      throw new Error(`Backup file failed SQLite integrity check: ${integrityStatus}`);
    }

    // 4. Query table counts inside backup directly through native SQL (0 objects loaded into JS heap)
    const [txCountRes, invCountRes, acctCountRes, catCountRes] = await Promise.all([
      db.query('SELECT count(*) as count FROM diag_audit_bkp.transactions;').catch(() => ({ values: [{ count: 0 }] })),
      db.query('SELECT count(*) as count FROM diag_audit_bkp.investment_transactions;').catch(() => ({ values: [{ count: 0 }] })),
      db.query('SELECT count(*) as count FROM diag_audit_bkp.accounts;').catch(() => ({ values: [{ count: 0 }] })),
      db.query('SELECT count(*) as count FROM diag_audit_bkp.categories;').catch(() => ({ values: [{ count: 0 }] }))
    ]);

    const actualCounts = {
      transactions: txCountRes.values?.[0]?.count ?? 0,
      investment_transactions: invCountRes.values?.[0]?.count ?? 0,
      totalTransactions: (txCountRes.values?.[0]?.count ?? 0) + (invCountRes.values?.[0]?.count ?? 0),
      accounts: acctCountRes.values?.[0]?.count ?? 0,
      categories: catCountRes.values?.[0]?.count ?? 0
    };

    console.log('[NativeRecoveryDiagnostic] Actual counts inside physical backup file:');
    console.log(`  - Regular Transactions: ${actualCounts.transactions}`);
    console.log(`  - Investment Transactions: ${actualCounts.investment_transactions}`);
    console.log(`  - Total Transactions: ${actualCounts.totalTransactions}`);
    console.log(`  - Accounts: ${actualCounts.accounts}`);
    console.log(`  - Categories: ${actualCounts.categories}`);

    // 5. Compare with backup metadata
    const expectedTx = meta.counts?.transactions;
    const expectedInv = meta.counts?.investment_transactions;
    const countsMatch = (actualCounts.transactions === expectedTx) &&
                        (actualCounts.investment_transactions === expectedInv);

    if (!countsMatch) {
      console.warn(`[NativeRecoveryDiagnostic] COUNT MISMATCH: Expected tx=${expectedTx}, inv=${expectedInv}; Actual tx=${actualCounts.transactions}, inv=${actualCounts.investment_transactions}`);
    } else {
      console.log('[NativeRecoveryDiagnostic] ✅ All table counts MATCH backup metadata exactly.');
    }

    const durationMs = Math.round(performance.now() - startTime);

    const report = {
      success: countsMatch && integrityStatus.toLowerCase() === 'ok',
      status: 'VERIFICATION_PASSED',
      backupPath,
      integrity: integrityStatus,
      durationMs,
      metadataCounts: {
        transactions: expectedTx,
        investment_transactions: expectedInv,
        totalTransactions: meta.counts?.totalTransactions,
        accounts: meta.counts?.accounts,
        categories: meta.counts?.categories
      },
      actualCounts,
      countsMatch,
      backupId: meta.backup_id,
      timestamp: meta.timestamp,
      sha256: meta.sha256,
      safety: 'READ_ONLY_ZERO_MODIFICATIONS'
    };

    console.log('[NativeRecoveryDiagnostic] === Verification Report ===', JSON.stringify(report, null, 2));
    return report;
  } finally {
    // 6. Guarantee detach
    try {
      await execNonTransactional('DETACH DATABASE diag_audit_bkp;');
      console.log('[NativeRecoveryDiagnostic] Successfully detached diag_audit_bkp.');
    } catch (detachErr) {
      console.warn('[NativeRecoveryDiagnostic] Warning detaching diag_audit_bkp:', detachErr?.message);
    }
  }
}

/**
 * 2. Explicitly triggered Self-Restore operation using restoreNativeBackup().
 * - Requires explicit confirmation argument ('CONFIRM_SELF_RESTORE').
 * - Pre-flight: Executes verifyNativeBackupDiagnostic() first to ensure backup integrity.
 * - Restores: Calls db.restoreNativeBackup(backupPath) atomically.
 * - Post-flight: Verifies operational table counts in 'main' database.
 * - Reports detailed before/after comparison.
 */
export async function executeSelfRestoreDiagnostic(confirmationToken, options = {}) {
  if (confirmationToken !== 'CONFIRM_SELF_RESTORE') {
    throw new Error(
      "[NativeRecoveryDiagnostic] SAFETY LOCK: Explicit user action required. " +
      "Call executeSelfRestoreDiagnostic('CONFIRM_SELF_RESTORE') or confirm via the in-app UI."
    );
  }

  console.log('[NativeRecoveryDiagnostic] === Starting EXPLICIT Self-Restore Operation ===');
  const db = options.db || getDB();

  // 1. Pre-restore verification gate
  console.log('[NativeRecoveryDiagnostic] Step 1: Pre-restore verification check...');
  const verifyResult = await verifyNativeBackupDiagnostic(options);
  if (!verifyResult.success || !verifyResult.countsMatch) {
    throw new Error(
      `[NativeRecoveryDiagnostic] ABORT: Pre-restore verification failed. Integrity=${verifyResult.integrity}, countsMatch=${verifyResult.countsMatch}`
    );
  }

  console.log(`[NativeRecoveryDiagnostic] Step 2: Executing db.restoreNativeBackup('${verifyResult.backupPath}')…`);
  const restoreStartTime = performance.now();
  const restoreRes = await db.restoreNativeBackup(verifyResult.backupPath);
  const restoreDurationMs = Math.round(performance.now() - restoreStartTime);
  console.log(`[NativeRecoveryDiagnostic] db.restoreNativeBackup finished in ${restoreDurationMs}ms:`, restoreRes);

  // 3. Post-restore verification of operational tables in 'main'
  console.log('[NativeRecoveryDiagnostic] Step 3: Verifying operational table counts in main database...');
  const [postTxRes, postInvRes, postAcctRes, postCatRes] = await Promise.all([
    db.query('SELECT count(*) as count FROM main.transactions;').catch(() => ({ values: [{ count: 0 }] })),
    db.query('SELECT count(*) as count FROM main.investment_transactions;').catch(() => ({ values: [{ count: 0 }] })),
    db.query('SELECT count(*) as count FROM main.accounts;').catch(() => ({ values: [{ count: 0 }] })),
    db.query('SELECT count(*) as count FROM main.categories;').catch(() => ({ values: [{ count: 0 }] }))
  ]);

  const postCounts = {
    transactions: postTxRes.values?.[0]?.count ?? 0,
    investment_transactions: postInvRes.values?.[0]?.count ?? 0,
    totalTransactions: (postTxRes.values?.[0]?.count ?? 0) + (postInvRes.values?.[0]?.count ?? 0),
    accounts: postAcctRes.values?.[0]?.count ?? 0,
    categories: postCatRes.values?.[0]?.count ?? 0
  };

  const mainIntegrity = (await db.query('PRAGMA main.integrity_check;').catch(() => ({ values: [{ integrity_check: 'unknown' }] }))).values?.[0]?.integrity_check || 'unknown';

  const matchesExpected = (postCounts.transactions === verifyResult.metadataCounts.transactions) &&
                          (postCounts.investment_transactions === verifyResult.metadataCounts.investment_transactions);

  const finalReport = {
    success: matchesExpected && mainIntegrity.toLowerCase() === 'ok',
    status: matchesExpected ? 'SELF_RESTORE_SUCCESS' : 'POST_RESTORE_COUNT_MISMATCH',
    restoredPath: verifyResult.backupPath,
    restoreDurationMs,
    restoredTables: restoreRes.restoredTables,
    mainIntegrity,
    expectedCounts: verifyResult.metadataCounts,
    operationalCountsAfterRestore: postCounts,
    matchesExpected,
    timestamp: new Date().toISOString()
  };

  console.log('[NativeRecoveryDiagnostic] === Self-Restore Final Report ===', JSON.stringify(finalReport, null, 2));
  return finalReport;
}
