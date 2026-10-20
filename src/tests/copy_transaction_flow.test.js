/**
 * copy_transaction_flow.test.js
 *
 * Test suite verifying Copy Transaction workflows:
 * - Exact date & time preservation for "Original date & time"
 * - Formatting & normalization of various time formats (HH:mm, HH:mm:ss, 12h AM/PM)
 * - Safe fallback when original time is empty/null (not leaking current time)
 * - "Today's date & time" behavior
 * - Timezone-neutral date parsing (no midnight offset shifts)
 * - FinMan sync payload generation ("Copy for Sync")
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toDDMMYYYY,
  toInputDate,
  toInputTime,
  inputToStorage,
  formatTime
} from '../utils/format.js';
import { bundleRelatedTransactions, serializeTransactions, parseFinmanPayload } from '../utils/finmanPayload.js';

test('Copy Transaction: toInputTime helper handles varied time inputs correctly', () => {
  // Exact reproduction case
  assert.equal(toInputTime('12:58'), '12:58', 'Preserves standard 24-hour time 12:58');
  assert.equal(toInputTime('12:58:00'), '12:58', 'Strips seconds from 12:58:00');
  assert.equal(toInputTime('09:05'), '09:05', 'Preserves morning time with leading zero 09:05');

  // 12-hour AM/PM formats
  assert.equal(toInputTime('12:58 PM'), '12:58', 'Converts 12:58 PM to 12:58');
  assert.equal(toInputTime('12:58 AM'), '00:58', 'Converts 12:58 AM to 00:58');
  assert.equal(toInputTime('1:30 pm'), '13:30', 'Converts 1:30 pm to 13:30');
  assert.equal(toInputTime('01:30pm'), '13:30', 'Converts 01:30pm to 13:30');
  assert.equal(toInputTime('9:15 am'), '09:15', 'Converts 9:15 am to 09:15');

  // Missing or empty time with fallback
  assert.equal(toInputTime('', '00:00'), '00:00', 'Empty string uses documented fallback 00:00');
  assert.equal(toInputTime(null, '00:00'), '00:00', 'Null uses documented fallback 00:00');
  assert.equal(toInputTime(undefined, '00:00'), '00:00', 'Undefined uses documented fallback 00:00');
  assert.equal(toInputTime('   ', '00:00'), '00:00', 'Whitespace string uses documented fallback 00:00');

  // Fallback when custom fallback provided
  assert.equal(toInputTime(undefined, '14:20'), '14:20', 'Uses custom fallback when input is undefined');
});

test('Copy Transaction: Date helpers are timezone-neutral and never shift around midnight', () => {
  // Reproduction case date: 09/10/2026
  assert.equal(toInputDate('09/10/2026'), '2026-10-09', 'Converts DD/MM/YYYY to YYYY-MM-DD without day shift');
  assert.equal(toDDMMYYYY('2026-10-09'), '09/10/2026', 'Converts YYYY-MM-DD to DD/MM/YYYY without day shift');

  // Month-end and year-end boundary dates
  assert.equal(toInputDate('31/12/2026'), '2026-12-31');
  assert.equal(toDDMMYYYY('2026-12-31'), '31/12/2026');

  assert.equal(toInputDate('01/01/2026'), '2026-01-01');
  assert.equal(toDDMMYYYY('2026-01-01'), '01/01/2026');

  // Storage round-trip
  const storageDate = '09/10/2026';
  const inputDate = toInputDate(storageDate);
  const backToStorage = inputToStorage(inputDate);
  assert.equal(backToStorage, storageDate, 'Round-trip from storage to input and back preserves exact date');
});

test('Copy Transaction: Original date & time copy workflow preserves 09/10/2026 and 12:58', () => {
  // Original transaction as stored in FinMan
  const originalTxn = {
    _id: 'txn-original-123',
    ID: 'txn-original-123',
    Date: '09/10/2026',
    date: '09/10/2026',
    Time: '12:58',
    time: '12:58',
    Account: 'HDFC Bank',
    Category: 'Groceries',
    Subcategory: 'Vegetables',
    Note: 'Supermarket weekly shopping',
    INR: 1450,
    Amount: '1450',
    'Income/Expense': 'Expense'
  };

  // 1. Simulating DetailSheet handleCopyWithOriginal
  const copyPayload = {
    ...originalTxn,
    Date: originalTxn.Date || originalTxn.date,
    date: originalTxn.date || originalTxn.Date,
    Time: originalTxn.Time || originalTxn.time || '',
    time: originalTxn.time || originalTxn.Time || '',
    _copyMode: 'original'
  };

  // 2. Simulating parent component passing to AddTransaction (e.g. Transactions.jsx setCopyTxn({ ...txn, _id: undefined }))
  const copyTransaction = {
    ...copyPayload,
    _id: undefined
  };

  // 3. Simulating AddTransaction form initialization
  const formDate = toInputDate(copyTransaction.Date || copyTransaction.date);
  const formTime = toInputTime(
    copyTransaction.Time || copyTransaction.time,
    copyTransaction._copyMode === 'today' ? '12:00' : '00:00'
  );

  assert.equal(formDate, '2026-10-09', 'AddTransaction initializes form.date to 2026-10-09');
  assert.equal(formTime, '12:58', 'AddTransaction initializes form.time to exact original 12:58');
  assert.equal(copyTransaction._id, undefined, 'New transaction ID will be generated upon save');
});

test('Copy Transaction: Today date & time copy workflow initializes current date/time', () => {
  const originalTxn = {
    _id: 'txn-original-456',
    Date: '01/01/2024',
    Time: '08:15',
    Account: 'HDFC Bank',
    Category: 'Dining',
    INR: 650,
    'Income/Expense': 'Expense'
  };

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const todayDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const todayTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  // Simulating DetailSheet handleCopyWithToday
  const copyPayload = {
    ...originalTxn,
    Date: todayDate,
    date: todayDate,
    Time: todayTime,
    time: todayTime,
    _copyMode: 'today'
  };

  const copyTransaction = { ...copyPayload, _id: undefined };

  const formDate = toInputDate(copyTransaction.Date || copyTransaction.date);
  const formTime = toInputTime(
    copyTransaction.Time || copyTransaction.time,
    copyTransaction._copyMode === 'today' ? todayTime : '00:00'
  );

  assert.equal(formDate, todayDate, 'Form date matches today');
  assert.equal(formTime, todayTime, 'Form time matches today');
});

test('Copy Transaction: Fallback when original time is empty does NOT leak current time', () => {
  const originalTxnWithoutTime = {
    _id: 'txn-no-time-789',
    Date: '15/08/2026',
    date: '15/08/2026',
    Time: '',
    time: '',
    Account: 'SBI',
    Category: 'Utilities',
    INR: 2300,
    'Income/Expense': 'Expense'
  };

  // User chooses "Original date & time"
  const copyPayload = {
    ...originalTxnWithoutTime,
    Date: originalTxnWithoutTime.Date || originalTxnWithoutTime.date,
    date: originalTxnWithoutTime.date || originalTxnWithoutTime.Date,
    Time: originalTxnWithoutTime.Time || originalTxnWithoutTime.time || '',
    time: originalTxnWithoutTime.time || originalTxnWithoutTime.Time || '',
    _copyMode: 'original'
  };

  const copyTransaction = { ...copyPayload, _id: undefined };

  const formDate = toInputDate(copyTransaction.Date || copyTransaction.date);
  const formTime = toInputTime(
    copyTransaction.Time || copyTransaction.time,
    copyTransaction._copyMode === 'today' ? '99:99' : '00:00'
  );

  assert.equal(formDate, '2026-08-15', 'Preserves original date');
  assert.equal(formTime, '00:00', 'Uses documented 00:00 fallback, does NOT use current/random time');
});

test('Copy Transaction: Investment copy retains security details with original date & time', () => {
  const invTxn = {
    _id: 'inv-txn-101',
    Date: '09/10/2026',
    Time: '12:58',
    InvestmentTransactionType: 'BUY',
    SecuritySymbol: 'NIFTYBEES',
    SecurityDisplayName: 'Nippon India ETF Nifty 50 BeES',
    SecurityISIN: 'INF732E01015',
    Brokerage: 'Zerodha',
    TradeValue: 25000,
    Quantity: 100,
    UnitPrice: 250,
    'Income/Expense': 'Investment'
  };

  const copyPayload = {
    ...invTxn,
    Date: invTxn.Date,
    Time: invTxn.Time,
    _copyMode: 'original'
  };

  const copyTransaction = { ...copyPayload, _id: undefined };

  const formDate = toInputDate(copyTransaction.Date || copyTransaction.date);
  const formTime = toInputTime(
    copyTransaction.Time || copyTransaction.time,
    copyTransaction._copyMode === 'today' ? '12:00' : '00:00'
  );

  assert.equal(formDate, '2026-10-09', 'Preserves investment original date');
  assert.equal(formTime, '12:58', 'Preserves investment original time');
  assert.equal(copyTransaction.SecuritySymbol, 'NIFTYBEES');
  assert.equal(copyTransaction.SecurityISIN, 'INF732E01015');
});

test('Copy Transaction: Copy for Sync bundles complete transaction payload', () => {
  const txn = {
    _id: 'txn-sync-1',
    id: 'txn-sync-1',
    date: '09/10/2026',
    time: '12:58',
    account: 'HDFC',
    category: 'Shopping',
    inr: 1500,
    amount: '1500',
    type: 'Expense',
    recurring_rule_id: 'rule-123'
  };

  const allTxns = [txn];
  const bundled = bundleRelatedTransactions([txn], allTxns);
  assert.equal(bundled.transactions.length, 1);

  const payloadText = serializeTransactions(bundled.transactions, {
    source: 'FinMan',
    exportedAt: '2026-10-20T12:00:00.000Z'
  });

  assert.ok(payloadText.length > 0, 'Payload string is generated');
  const res = parseFinmanPayload(payloadText);
  assert.equal(res.success, true, 'Parsing payload succeeds');
  assert.ok(Array.isArray(res.payload.transactions), 'Payload transactions array exists');
  assert.equal(res.payload.transactions.length, 1);
  assert.equal(res.payload.transactions[0].id || res.payload.transactions[0]._id, 'txn-sync-1');
});
