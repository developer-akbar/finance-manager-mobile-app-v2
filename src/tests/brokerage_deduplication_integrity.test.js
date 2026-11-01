import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReconciledDataIntegrity } from '../services/snapshotDeviceImport.js';

test('FinMan Phase 13 — Brokerage Deduplication & Strict Identity Verification', async (t) => {
  const createMockDb = (storedBrokerages = [], countsOverride = {}) => {
    return {
      query: async (sql, params = []) => {
        const s = sql.toLowerCase();
        if (s.includes('select count(*) as count from brokerages')) {
          return { values: [{ count: storedBrokerages.length }] };
        }
        if (s.includes('select count(*) as count from')) {
          const tbl = s.match(/from\s+([a-z_]+)/)?.[1] || '';
          return { values: [{ count: countsOverride[tbl] ?? 0 }] };
        }
        if (s.includes('select name from brokerages')) {
          return { values: storedBrokerages.map(b => ({ name: b.name })) };
        }
        if (s.includes('pragma integrity_check')) {
          return { values: [{ integrity_check: 'ok' }] };
        }
        if (s.includes('pragma foreign_key_check')) {
          return { values: [] };
        }
        if (s.includes('select * from transactions')) {
          return { values: [] };
        }
        return { values: [] };
      }
    };
  };

  await t.test('1. Legitimate duplicate brokerage records collapse into unique rows and pass validation', async () => {
    // Snapshot payload contains 4 brokerage records, but 2 are duplicates (Zerodha x2, Groww x2)
    const expectedEntities = {
      transactions: [],
      investment_transactions: [],
      accounts: [],
      categories: [],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [
        { id: 'b1', name: 'Zerodha' },
        { id: 'b2', name: 'Zerodha' },
        { id: 'b3', name: 'Groww' },
        { id: 'b4', name: 'Groww' }
      ]
    };

    // The SQLite table enforces UNIQUE(name), collapsing them into 2 distinct rows
    const liveBrokerages = [
      { id: 'b1', name: 'Zerodha' },
      { id: 'b3', name: 'Groww' }
    ];

    const db = createMockDb(liveBrokerages);
    const cloudPayload = { entities: expectedEntities };

    const result = await verifyReconciledDataIntegrity(db, cloudPayload);
    assert.ok(result, 'Validation must succeed when duplicates collapse cleanly to unique rows');
    assert.equal(result.actualCounts.brokerages, 2);
  });

  await t.test('2. Missing legitimate brokerage identity fails validation with specific error', async () => {
    // Snapshot expected 3 distinct brokerages: Zerodha, Groww, AngelOne
    const expectedEntities = {
      transactions: [],
      investment_transactions: [],
      accounts: [],
      categories: [],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [
        { id: 'b1', name: 'Zerodha' },
        { id: 'b2', name: 'Groww' },
        { id: 'b3', name: 'AngelOne' }
      ]
    };

    // Database only contains 2, AngelOne is missing
    const liveBrokerages = [
      { id: 'b1', name: 'Zerodha' },
      { id: 'b2', name: 'Groww' }
    ];

    const db = createMockDb(liveBrokerages);
    const cloudPayload = { entities: expectedEntities };

    await assert.rejects(
      async () => {
        await verifyReconciledDataIntegrity(db, cloudPayload);
      },
      (err) => {
        assert.ok(err.message.includes('Data integrity verification failed'));
        assert.ok(err.message.includes('brokerage') || err.message.includes('angelone'));
        return true;
      },
      'Missing legitimate brokerage identity must strictly fail validation'
    );
  });

  await t.test('3. Permissive row count range check is eliminated — unexpected extra/fewer brokerages fail', async () => {
    // Expected 2 brokerages
    const expectedEntities = {
      transactions: [],
      investment_transactions: [],
      accounts: [],
      categories: [],
      subcategories: [],
      sub_accounts: [],
      inventory: [],
      account_groups: [],
      brokerages: [
        { id: 'b1', name: 'Zerodha' },
        { id: 'b2', name: 'Groww' }
      ]
    };

    // Actual only has 1 brokerage ('Zerodha'). Under the old `actual >= 1 && actual <= expected` bug,
    // actual=1 would falsely PASS because 1 >= 1 && 1 <= 2.
    // Under our tightened normalized identity validation, this MUST FAIL.
    const liveBrokerages = [
      { id: 'b1', name: 'Zerodha' }
    ];

    const db = createMockDb(liveBrokerages);
    const cloudPayload = { entities: expectedEntities };

    await assert.rejects(
      async () => {
        await verifyReconciledDataIntegrity(db, cloudPayload);
      },
      (err) => {
        assert.ok(err.message.includes('Data integrity verification failed'));
        assert.ok(err.message.includes('groww') || err.message.includes('brokerage'));
        return true;
      },
      'Single brokerage when 2 were expected must fail closed and never pass permissively'
    );
  });
});

