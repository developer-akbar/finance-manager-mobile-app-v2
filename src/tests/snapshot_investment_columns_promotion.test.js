import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTableColumns, normalizeColumnKey } from '../database/db.js';
import { rowToTxn } from '../database/transactions.js';

test('Investment transaction columns promotion mapping', async (t) => {
  await t.test('All 54 investment_transactions columns match between PascalCase staging and snake_case main', () => {
    const mainCols = [
      'id', 'date', 'time', 'account', 'from_account', 'to_account',
      'category', 'subcategory', 'note', 'description', 'inr', 'amount',
      'currency', 'type', 'created_at', 'updated_at', 'recurring_rule_id',
      'tags', 'split_group_id', 'receipt_image', 'warranty_expiry', 'serial_no',
      'sub_account', 'from_sub_account', 'to_sub_account', 'investment_transaction_type',
      'brokerage', 'security_symbol', 'security_isin', 'quantity', 'unit_price',
      'trade_value', 'cost_basis', 'cash_impact', 'position_qty_change',
      'realized_pnl', 'trade_id', 'order_id', 'exchange', 'segment', 'source',
      'investment_account', 'actual_amount', 'total_charges', 'brokerage_charges',
      'exchange_charges', 'stt_charges', 'sebi_charges', 'stamp_duty_charges',
      'gst_charges', 'dp_charges', 'other_charges', 'security_display_name',
      'settlement_mode'
    ];

    const pragmaMain = mainCols.map(c => ({ name: c }));

    const rawInvRow = {
      id: 'test-id',
      date: '2026-10-31',
      time: '12:00',
      account: 'Share Market',
      from_account: 'Share Market',
      to_account: '',
      category: 'Share Market',
      subcategory: '',
      note: 'TATAPOWER',
      description: 'BUY | Symbol=TATAPOWER',
      inr: 4723,
      amount: '4723',
      currency: 'INR',
      type: 'Transfer-Out',
      created_at: '2026-10-31T12:00:00Z',
      updated_at: '2026-10-31T12:00:00Z',
      recurring_rule_id: '',
      tags: '',
      split_group_id: '',
      receipt_image: '',
      warranty_expiry: '',
      serial_no: '',
      sub_account: 'Zerodha',
      from_sub_account: 'Zerodha',
      to_sub_account: '',
      investment_transaction_type: 'BUY',
      brokerage: 'Zerodha',
      security_symbol: 'TATAPOWER',
      security_isin: 'INE245A01021',
      quantity: 20,
      unit_price: 236.15,
      trade_value: 4723,
      cost_basis: 4723,
      cash_impact: -4723,
      position_qty_change: 20,
      realized_pnl: 0,
      trade_id: 'tr-1',
      order_id: 'ord-1',
      exchange: 'NSE',
      segment: 'EQ',
      source: 'Zerodha',
      investment_account: 'Share Market',
      actual_amount: 4723,
      total_charges: 0,
      brokerage_charges: 0,
      exchange_charges: 0,
      stt_charges: 0,
      sebi_charges: 0,
      stamp_duty_charges: 0,
      gst_charges: 0,
      dp_charges: 0,
      other_charges: 0,
      security_display_name: 'Tata Power Ltd',
      settlement_mode: 'ACTUAL'
    };

    // Serialize through rowToTxn as in snapshot export
    const exportedObj = rowToTxn(rawInvRow);

    // Staging table pragma is constructed from exportedObj keys
    const stagingCols = Object.keys(exportedObj);
    const pragmaStaging = stagingCols.map(c => ({ name: c }));

    const matched = matchTableColumns(pragmaMain, pragmaStaging);

    const matchedTargets = new Set(matched.map(m => m.target));
    const missing = mainCols.filter(c => !matchedTargets.has(c));

    assert.equal(missing.length, 0, `All columns must match, but missing: ${missing.join(', ')}`);
    assert.equal(matched.length, mainCols.length, 'Matched count must equal main columns count');
  });
});

