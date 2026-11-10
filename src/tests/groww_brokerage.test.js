import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateGrowwCharges } from '../utils/brokerageAccounting.js';

test('Groww Brokerage: Delivery BUY (HINDZINC 20 @ ₹543 = ₹10,860)', () => {
  const result = calculateGrowwCharges({
    invType: 'BUY',
    tradeVal: 10860,
    securitySymbol: 'HINDZINC',
    securityISIN: 'INE267A01025',
    investmentAccount: 'Share Market',
    exchange: 'NSE'
  });

  // Brokerage = MIN(20, MAX(5, 10860 * 0.001)) = 10.86
  assert.equal(result.brokerageCharges, 10.86, 'Brokerage must be ₹10.86 (0.1%)');
  // STT: 0.1% rounded off to nearest rupee = 11
  assert.equal(result.sttCharges, 11);
  // Exchange: 0.00307% on NSE = 0.33
  assert.equal(result.exchangeCharges, 0.33);
  // SEBI: 0.0001% = 0.01
  assert.equal(result.sebiCharges, 0.01);
  // Stamp Duty: 0.015% on BUY = 1.63
  assert.equal(result.stampDutyCharges, 1.63);
  // DP Charges: 0 on BUY (never applied to buys)
  assert.equal(result.dpCharges, 0);
  assert.equal(result.cdslCharges, 0);
});

test('Groww Brokerage Reference Example 1: Standard Engineering (₹9,520.70 Delivery SELL)', () => {
  const result = calculateGrowwCharges({
    invType: 'SELL',
    tradeVal: 9520.70,
    securitySymbol: 'STANDARDENG',
    securityISIN: 'INE123A01011',
    exchange: 'NSE'
  });

  assert.equal(result.brokerageCharges, 9.52);
  assert.equal(result.dpCharges, 16.50);
  assert.equal(result.cdslCharges, 3.25);
  assert.equal(result.sttCharges, 10);
  assert.equal(result.exchangeCharges, 0.29);
  assert.equal(result.sebiCharges, 0.01);
  assert.equal(result.gstCharges, 5);
  assert.equal(result.totalCharges, 44.57);
});

test('Groww Brokerage Reference Example 2: IndiaBulls (₹2,544.00 Delivery SELL)', () => {
  const result = calculateGrowwCharges({
    invType: 'SELL',
    tradeVal: 2544.00,
    securitySymbol: 'IBULHSGFIN',
    securityISIN: 'INE148I01020',
    exchange: 'NSE'
  });

  assert.equal(result.brokerageCharges, 5.00);
  assert.equal(result.dpCharges, 16.50);
  assert.equal(result.cdslCharges, 3.25);
  assert.equal(result.sttCharges, 3);
  assert.equal(result.exchangeCharges, 0.08);
  assert.equal(result.sebiCharges, 0.00);
  assert.equal(result.gstCharges, 4);
  assert.equal(result.totalCharges, 31.83);
});

test('Groww Brokerage Reference Example 3: Exicom (₹4,204.80 Delivery SELL)', () => {
  const result = calculateGrowwCharges({
    invType: 'SELL',
    tradeVal: 4204.80,
    securitySymbol: 'EXICOM',
    securityISIN: 'INE777A01015',
    exchange: 'NSE'
  });

  assert.equal(result.brokerageCharges, 5.00);
  assert.equal(result.dpCharges, 16.50);
  assert.equal(result.cdslCharges, 3.25);
  assert.equal(result.sttCharges, 4);
  assert.equal(result.exchangeCharges, 0.13);
  assert.equal(result.sebiCharges, 0.00);
  assert.equal(result.gstCharges, 4);
  assert.equal(result.totalCharges, 32.88);
});

test('Groww Brokerage: DP charge applied only once per ISIN per trading day', () => {
  const existingTxns = [
    {
      id: 'txn_sell_1',
      date: '2026-11-10',
      type: 'SELL',
      investment_transaction_type: 'SELL',
      security_isin: 'INE267A01025',
      security_symbol: 'HINDZINC',
      dp_charges: 16.50
    }
  ];

  // Second sell of the SAME ISIN on the SAME trading day -> DP charge must be 0
  const secondSellSameISIN = calculateGrowwCharges({
    invType: 'SELL',
    tradeVal: 5000,
    securitySymbol: 'HINDZINC',
    securityISIN: 'INE267A01025',
    date: '2026-11-10',
    existingTransactions: existingTxns
  });
  assert.equal(secondSellSameISIN.dpCharges, 0, 'Second sell of same ISIN on same date must have ₹0 Groww DP charges');
  assert.equal(secondSellSameISIN.cdslCharges, 0, 'Second sell of same ISIN on same date must have ₹0 CDSL DP charges');

  // Sell of a DIFFERENT ISIN on the SAME trading day -> DP charge must be applied
  const sellDifferentISIN = calculateGrowwCharges({
    invType: 'SELL',
    tradeVal: 5000,
    securitySymbol: 'TCS',
    securityISIN: 'INE467B01029',
    date: '2026-11-10',
    existingTransactions: existingTxns
  });
  assert.equal(sellDifferentISIN.dpCharges, 16.50);
  assert.equal(sellDifferentISIN.cdslCharges, 3.25);

  // Sell of the SAME ISIN on a DIFFERENT trading day -> DP charge must be applied
  const sellNextDay = calculateGrowwCharges({
    invType: 'SELL',
    tradeVal: 5000,
    securitySymbol: 'HINDZINC',
    securityISIN: 'INE267A01025',
    date: '2026-11-11',
    existingTransactions: existingTxns
  });
  assert.equal(sellNextDay.dpCharges, 16.50);
  assert.equal(sellNextDay.cdslCharges, 3.25);
});

test('Groww Brokerage: Floor enforcement at ₹5 (Trade Value ₹4,947)', () => {
  const result = calculateGrowwCharges({
    invType: 'BUY',
    tradeVal: 4947,
    securitySymbol: 'INFY',
    exchange: 'NSE'
  });

  // 4947 * 0.001 = 4.947, MIN(20, MAX(5, 4.947)) = 5.00
  assert.equal(result.brokerageCharges, 5.00);
});

test('Groww Brokerage: Ceiling cap at ₹20 (Trade Value ₹100,000)', () => {
  const result = calculateGrowwCharges({
    invType: 'BUY',
    tradeVal: 100000,
    securitySymbol: 'RELIANCE',
    exchange: 'NSE'
  });

  // 100000 * 0.001 = 100.00, MIN(20, MAX(5, 100)) = 20.00
  assert.equal(result.brokerageCharges, 20.00);
});

test('Groww Brokerage: Zero & negative trade value edge cases', () => {
  const zeroResult = calculateGrowwCharges({
    invType: 'BUY',
    tradeVal: 0,
    securitySymbol: 'TCS'
  });
  assert.equal(zeroResult.brokerageCharges, 0);
  assert.equal(zeroResult.totalCharges, 0);

  const negResult = calculateGrowwCharges({
    invType: 'BUY',
    tradeVal: -500,
    securitySymbol: 'TCS'
  });
  assert.equal(negResult.brokerageCharges, 0);
  assert.equal(negResult.totalCharges, 0);
});

test('Groww Brokerage: ETF delivery buy respects formula', () => {
  const result = calculateGrowwCharges({
    invType: 'BUY',
    tradeVal: 12500,
    securitySymbol: 'NIFTYBEES',
    exchange: 'NSE'
  });

  // 12500 * 0.001 = 12.50
  assert.equal(result.brokerageCharges, 12.50);
  // STT on ETF BUY is 0
  assert.equal(result.sttCharges, 0);
  // DP charge on BUY is 0
  assert.equal(result.dpCharges, 0);
});
