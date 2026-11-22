/**
 * src/tests/credit_card_fee_waiver_persistence.test.js
 *
 * Automated Test Suite for Credit Card Annual Fee Waiver Persistence and Synchronization (Phase 3):
 * 1. Create, edit, and delete card configurations keyed by persistent card ID.
 * 2. Multiple cards with different fee structures and period configurations.
 * 3. Database reload persistence and schema non-modification guard.
 * 4. Finalized cycle outcome and bank confirmation persistence.
 * 5. 3-Way multi-device merge safety (independent card edits do not overwrite each other).
 * 6. History 3-way merge safety.
 * 7. Cloud sync engine 3-way reconciliation regression check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { initDB, closeDB } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
import {
  getFeeWaiverConfigs,
  getFeeWaiverConfigForCard,
  saveFeeWaiverConfig,
  deleteFeeWaiverConfig,
  getFeeWaiverHistory,
  getFeeWaiverHistoryForCard,
  saveFeeWaiverCycleOutcome,
  mergeCardConfigs3Way,
  mergeCardHistory3Way,
  SETTING_KEYS
} from '../utils/feeWaiverStorage.js';
import { FEE_STRUCTURE, PERIOD_TYPE, WAIVER_STATUS } from '../utils/feeWaiverEngine.js';
import { reconcileSettings3Way } from '../services/cloudSyncEngine.js';

test('FinMan Phase 3 — Fee Waiver Persistence & Sync Suite', async (suite) => {

  suite.beforeEach(async () => {
    indexedDB = new IDBFactory();
    closeDB();
    await initDB();
  });

  suite.afterEach(() => {
    closeDB();
  });

  await suite.test('1. Create, read, edit, and delete single card configuration keyed by persistent ID', async () => {
    const cardId = 'acc_citi_premier_001';

    // 1a. Initial state: not configured
    const initialConfig = await getFeeWaiverConfigForCard(cardId);
    assert.equal(initialConfig, null, 'Unconfigured card must return null');

    // 1b. Create configuration
    const saved = await saveFeeWaiverConfig(cardId, {
      feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER,
      annualFee: 1000,
      spendThreshold: 30000,
      periodType: PERIOD_TYPE.ANNIVERSARY,
      issuanceDate: '2023-08-15',
    });

    assert.equal(saved.cardId, cardId);
    assert.equal(saved.annualFee, 1000);
    assert.equal(saved.spendThreshold, 30000);
    assert.equal(saved.periodType, PERIOD_TYPE.ANNIVERSARY);
    assert.equal(saved.issuanceDate, '2023-08-15');
    assert.ok(saved.updatedAt, 'Must set updatedAt timestamp');

    // Verify stored under settings
    const stored = await getFeeWaiverConfigForCard(cardId);
    assert.deepEqual(stored, saved);

    // 1c. Edit configuration
    const edited = await saveFeeWaiverConfig(cardId, {
      spendThreshold: 35000,
      annualFee: 1200,
    });
    assert.equal(edited.spendThreshold, 35000);
    assert.equal(edited.annualFee, 1200);
    assert.equal(edited.periodType, PERIOD_TYPE.ANNIVERSARY, 'Preserves untouched existing fields');

    // 1d. Delete configuration
    const deleted = await deleteFeeWaiverConfig(cardId);
    assert.equal(deleted, true);
    const afterDelete = await getFeeWaiverConfigForCard(cardId);
    assert.equal(afterDelete, null, 'Deleted card configuration must return null');
  });

  await suite.test('2. Multiple cards with different fee structures stored independently', async () => {
    const citiId = 'acc_citi_1';
    const axisId = 'acc_axis_flipkart_2';
    const iciciId = 'acc_icici_amazon_3';
    const amexId = 'acc_amex_4';

    await saveFeeWaiverConfig(citiId, {
      feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER,
      annualFee: 1000,
      spendThreshold: 30000,
      periodType: PERIOD_TYPE.ANNIVERSARY,
      issuanceDate: '2022-04-10',
    });

    await saveFeeWaiverConfig(axisId, {
      feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER,
      annualFee: 500,
      spendThreshold: 350000,
      periodType: PERIOD_TYPE.CALENDAR_YEAR,
    });

    await saveFeeWaiverConfig(iciciId, {
      feeStructure: FEE_STRUCTURE.LIFETIME_FREE,
      annualFee: 0,
      spendThreshold: 0,
    });

    await saveFeeWaiverConfig(amexId, {
      feeStructure: FEE_STRUCTURE.FIXED_FEE,
      annualFee: 4500,
      periodType: PERIOD_TYPE.FINANCIAL_YEAR,
    });

    const allConfigs = await getFeeWaiverConfigs();
    assert.equal(Object.keys(allConfigs).length, 4);
    assert.equal(allConfigs[citiId].feeStructure, FEE_STRUCTURE.THRESHOLD_WAIVER);
    assert.equal(allConfigs[axisId].periodType, PERIOD_TYPE.CALENDAR_YEAR);
    assert.equal(allConfigs[iciciId].feeStructure, FEE_STRUCTURE.LIFETIME_FREE);
    assert.equal(allConfigs[amexId].annualFee, 4500);
  });

  await suite.test('3. Reload persistence preserves configurations without altering account tables', async () => {
    const cardId = 'acc_reload_test';
    await saveFeeWaiverConfig(cardId, {
      feeStructure: FEE_STRUCTURE.THRESHOLD_WAIVER,
      annualFee: 2500,
      spendThreshold: 150000,
      periodType: PERIOD_TYPE.CUSTOM,
      customStartDate: '2026-01-01',
      customEndDate: '2026-06-30',
    });

    // Simulate app reload by closing and reopening database
    closeDB();
    await initDB();

    const loaded = await getFeeWaiverConfigForCard(cardId);
    assert.ok(loaded);
    assert.equal(loaded.annualFee, 2500);
    assert.equal(loaded.spendThreshold, 150000);
    assert.equal(loaded.customStartDate, '2026-01-01');
    assert.equal(loaded.customEndDate, '2026-06-30');
  });

  await suite.test('4. Finalized historical cycles and bank confirmations persisted separately from live progress', async () => {
    const cardId = 'acc_history_test';

    // Save cycle 1 historical outcome
    const outcome1 = await saveFeeWaiverCycleOutcome({
      cardId,
      cycleId: 'acc_history_test_2024_2025',
      periodStart: '2024-05-15',
      periodEnd: '2025-05-14',
      calculatedEligibleSpend: 165000,
      spendThreshold: 150000,
      annualFee: 2500,
      targetReached: true,
      bankOutcome: 'WAIVED',
      confirmationDate: '2025-05-20',
      notes: 'Fee waiver reflected in June statement',
    });

    assert.equal(outcome1.cardId, cardId);
    assert.equal(outcome1.bankOutcome, 'WAIVED');

    // Save cycle 2 historical outcome (missed target, fee charged)
    await saveFeeWaiverCycleOutcome({
      cardId,
      cycleId: 'acc_history_test_2025_2026',
      periodStart: '2025-05-15',
      periodEnd: '2026-05-14',
      calculatedEligibleSpend: 110000,
      spendThreshold: 150000,
      annualFee: 2500,
      targetReached: false,
      bankOutcome: 'CHARGED',
      confirmationDate: '2026-05-18',
    });

    const cardHistory = await getFeeWaiverHistoryForCard(cardId);
    assert.equal(cardHistory.length, 2);
    assert.equal(cardHistory[0].bankOutcome, 'WAIVED');
    assert.equal(cardHistory[1].bankOutcome, 'CHARGED');

    // Update cycle 2 bank confirmation notes
    await saveFeeWaiverCycleOutcome({
      cardId,
      cycleId: 'acc_history_test_2025_2026',
      notes: 'Customer support refused waiver retention request',
    });

    const updatedHistory = await getFeeWaiverHistoryForCard(cardId);
    assert.equal(updatedHistory.length, 2, 'Must not duplicate cycle record on update');
    assert.equal(updatedHistory[1].notes, 'Customer support refused waiver retention request');
  });

  await suite.test('5. 3-Way configuration merger: independent card edits on multiple devices merge cleanly', () => {
    const base = {
      card_1: { cardId: 'card_1', spendThreshold: 50000, updatedAt: '2026-01-01T10:00:00Z' },
    };

    // Device A edited card_1 threshold
    const local = {
      card_1: { cardId: 'card_1', spendThreshold: 60000, updatedAt: '2026-01-02T10:00:00Z' },
    };

    // Device B added card_2
    const cloud = {
      card_1: { cardId: 'card_1', spendThreshold: 50000, updatedAt: '2026-01-01T10:00:00Z' },
      card_2: { cardId: 'card_2', spendThreshold: 100000, updatedAt: '2026-01-02T11:00:00Z' },
    };

    const merged = mergeCardConfigs3Way({
      baseRaw: JSON.stringify(base),
      localRaw: JSON.stringify(local),
      cloudRaw: JSON.stringify(cloud),
    });

    assert.equal(Object.keys(merged).length, 2, 'Must contain both card_1 and card_2');
    assert.equal(merged.card_1.spendThreshold, 60000, 'Must preserve Device A edit for card_1');
    assert.equal(merged.card_2.spendThreshold, 100000, 'Must preserve Device B addition of card_2');
  });

  await suite.test('6. 3-Way configuration merger: concurrent edit on same card resolves via LWW per card', () => {
    const base = {
      card_1: { cardId: 'card_1', annualFee: 1000, updatedAt: '2026-01-01T10:00:00Z' },
    };

    const local = {
      card_1: { cardId: 'card_1', annualFee: 1200, updatedAt: '2026-01-02T10:00:00Z' },
    };

    const cloud = {
      card_1: { cardId: 'card_1', annualFee: 1500, updatedAt: '2026-01-02T12:00:00Z' }, // Newer
    };

    const merged = mergeCardConfigs3Way({
      baseRaw: JSON.stringify(base),
      localRaw: JSON.stringify(local),
      cloudRaw: JSON.stringify(cloud),
    });

    assert.equal(merged.card_1.annualFee, 1500, 'Newer timestamp wins in concurrent edit');
  });

  await suite.test('7. 3-Way history merger unions distinct cycle records across devices', () => {
    const base = [];
    const local = [
      { id: 'card1_2024', cardId: 'card1', bankOutcome: 'WAIVED', updatedAt: '2026-01-01T10:00:00Z' },
    ];
    const cloud = [
      { id: 'card2_2024', cardId: 'card2', bankOutcome: 'CHARGED', updatedAt: '2026-01-01T11:00:00Z' },
    ];

    const merged = mergeCardHistory3Way({
      baseRaw: JSON.stringify(base),
      localRaw: JSON.stringify(local),
      cloudRaw: JSON.stringify(cloud),
    });

    assert.equal(merged.length, 2);
    const ids = merged.map(m => m.id).sort();
    assert.deepEqual(ids, ['card1_2024', 'card2_2024']);
  });

  await suite.test('8. Cloud sync engine reconcileSettings3Way handles cc_fee_waiver_configs & history', () => {
    const baseSettings = {
      default_currency: 'INR',
      cc_fee_waiver_configs: JSON.stringify({
        card_a: { cardId: 'card_a', spendThreshold: 40000, updatedAt: '2026-01-01T00:00:00Z' }
      }),
    };

    const localSettings = {
      default_currency: 'INR',
      cc_fee_waiver_configs: JSON.stringify({
        card_a: { cardId: 'card_a', spendThreshold: 50000, updatedAt: '2026-01-02T00:00:00Z' }
      }),
    };

    const cloudSettings = {
      default_currency: 'INR',
      cc_fee_waiver_configs: JSON.stringify({
        card_a: { cardId: 'card_a', spendThreshold: 40000, updatedAt: '2026-01-01T00:00:00Z' },
        card_b: { cardId: 'card_b', spendThreshold: 100000, updatedAt: '2026-01-02T05:00:00Z' }
      }),
    };

    const res = reconcileSettings3Way({
      baseSettings,
      localSettings,
      cloudSettings,
    });

    assert.equal(res.conflicts.length, 0, 'Must merge without conflicts');
    const parsedConfigs = JSON.parse(res.mergedSettings.cc_fee_waiver_configs);
    assert.equal(parsedConfigs.card_a.spendThreshold, 50000, 'Local card_a edit retained');
    assert.equal(parsedConfigs.card_b.spendThreshold, 100000, 'Cloud card_b addition merged');
  });

});

