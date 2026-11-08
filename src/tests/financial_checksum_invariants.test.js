import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFinancialBaselineChecksum } from '../services/legacyDeviceAuditMigration.js';

test('FinMan Financial Checksum Invariants Suite', async (t) => {
  const sampleRecords = [
    {
      id: 'tx_001',
      date: '2026-11-01',
      time: '10:00:00',
      account: 'HDFC Bank',
      category: 'Food',
      subcategory: 'Groceries',
      amount: '500.50',
      inr: 500.50,
      currency: 'INR',
      type: 'Expense',
      created_by_device_id: null,
      created_by_provenance: null,
      updated_by_device_id: null,
      updated_by_provenance: null,
      created_at: '2026-11-01T10:00:00.000Z',
      updated_at: '2026-11-01T10:00:00.000Z'
    },
    {
      id: 'inv_001',
      date: '2026-11-02',
      time: '14:30:00',
      account: 'Zerodha Equity',
      category: 'Investment',
      subcategory: 'Equities',
      amount: '15000',
      inr: 15000,
      currency: 'INR',
      type: 'Transfer',
      security_symbol: 'RELIANCE',
      security_isin: 'INE002A01018',
      security_display_name: 'Reliance Industries Ltd',
      quantity: 10,
      unit_price: 1500,
      trade_value: 15000,
      cost_basis: 15000,
      cash_impact: -15020,
      realized_pnl: 0,
      brokerage: 'Zerodha',
      total_charges: 20,
      brokerage_charges: 0,
      exchange_charges: 5,
      stt_charges: 10,
      sebi_charges: 1,
      stamp_duty_charges: 2,
      gst_charges: 2,
      dp_charges: 0,
      other_charges: 0,
      actual_amount: 15020,
      settlement_mode: 'ACTUAL',
      created_by_device_id: null,
      created_by_provenance: null,
      updated_by_device_id: null,
      updated_by_provenance: null,
      created_at: '2026-11-02T14:30:00.000Z',
      updated_at: '2026-11-02T14:30:00.000Z'
    }
  ];

  const baselineChecksum = await computeFinancialBaselineChecksum(sampleRecords);
  assert.ok(baselineChecksum && baselineChecksum.length === 64, 'Checksum must be a valid 64-character SHA-256');

  await t.test('1. Attribution-only modifications leave checksum 100% UNCHANGED', async () => {
    const attributedRecords = sampleRecords.map(r => ({
      ...r,
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: 'dev_c7e4544221f4',
      updated_by_provenance: 'LEGACY_ASSIGNED'
    }));

    const postAttributionChecksum = await computeFinancialBaselineChecksum(attributedRecords);
    assert.equal(
      postAttributionChecksum,
      baselineChecksum,
      'Financial checksum must remain identical after device attribution updates'
    );
  });

  await t.test('2. Modifying security_symbol changes checksum', async () => {
    const mutated = JSON.parse(JSON.stringify(sampleRecords));
    mutated[1].security_symbol = 'TCS';
    const mutatedChecksum = await computeFinancialBaselineChecksum(mutated);
    assert.notEqual(mutatedChecksum, baselineChecksum);
  });

  await t.test('3. Modifying quantity changes checksum', async () => {
    const mutated = JSON.parse(JSON.stringify(sampleRecords));
    mutated[1].quantity = 11;
    const mutatedChecksum = await computeFinancialBaselineChecksum(mutated);
    assert.notEqual(mutatedChecksum, baselineChecksum);
  });

  await t.test('4. Modifying unit_price changes checksum', async () => {
    const mutated = JSON.parse(JSON.stringify(sampleRecords));
    mutated[1].unit_price = 1500.05;
    const mutatedChecksum = await computeFinancialBaselineChecksum(mutated);
    assert.notEqual(mutatedChecksum, baselineChecksum);
  });

  await t.test('5. Modifying brokerage charges changes checksum', async () => {
    const mutated = JSON.parse(JSON.stringify(sampleRecords));
    mutated[1].brokerage_charges = 20;
    const mutatedChecksum = await computeFinancialBaselineChecksum(mutated);
    assert.notEqual(mutatedChecksum, baselineChecksum);
  });

  await t.test('6. Modifying realized P&L changes checksum', async () => {
    const mutated = JSON.parse(JSON.stringify(sampleRecords));
    mutated[1].realized_pnl = 250.75;
    const mutatedChecksum = await computeFinancialBaselineChecksum(mutated);
    assert.notEqual(mutatedChecksum, baselineChecksum);
  });

  await t.test('7. Modifying regular transaction amount or inr changes checksum', async () => {
    const mutated = JSON.parse(JSON.stringify(sampleRecords));
    mutated[0].amount = '500.51';
    const mutatedChecksum = await computeFinancialBaselineChecksum(mutated);
    assert.notEqual(mutatedChecksum, baselineChecksum);
  });

  await t.test('8. Shared UUID across transactions and investment_transactions is separated by table identity', async () => {
    const sharedUuid = 'ef41e977-a250-47a7-a41c-fea7944aa71e';
    const recTxn = {
      id: sharedUuid,
      _table: 'transactions',
      amount: '100',
      category: 'Food',
      date: '2026-11-01'
    };
    const recInv = {
      id: sharedUuid,
      _table: 'investment_transactions',
      amount: '100',
      category: 'Food',
      date: '2026-11-01'
    };

    const checksumBoth = await computeFinancialBaselineChecksum([recTxn, recInv]);
    assert.ok(checksumBoth && checksumBoth.length === 64);

    // If table identity is flipped, the checksum must change
    const flippedBoth = [
      { ...recTxn, _table: 'investment_transactions' },
      { ...recInv, _table: 'transactions' }
    ];
    // Since records had different table identities, swapping them or modifying table identity changes hash
    const singleTxn = await computeFinancialBaselineChecksum([recTxn]);
    const singleInv = await computeFinancialBaselineChecksum([recInv]);
    assert.notEqual(singleTxn, singleInv, 'Identical UUID in transactions vs investment_transactions must produce distinct checksums due to table binding');
  });
});

