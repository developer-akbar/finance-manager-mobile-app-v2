const assert = require('assert');

// Simulate the exact state transition logic implemented in AddTransaction.jsx
const roundNum = (n, maxDec = 2) => {
  if (isNaN(n) || n === null || n === '') return '';
  const factor = Math.pow(10, maxDec);
  return String(Math.round((Number(n) + Number.EPSILON) * factor) / factor);
};

const calcPnl = (tradeValStr, costBasisStr) => {
  if (tradeValStr === '' || tradeValStr === null || tradeValStr === undefined) return '';
  if (costBasisStr === '' || costBasisStr === null || costBasisStr === undefined) return '';
  const v = parseFloat(tradeValStr);
  const cb = parseFloat(costBasisStr);
  if (!isNaN(v) && !isNaN(cb)) {
    return roundNum(v - cb, 2);
  }
  return '';
};

function handleUnitsChange(prev, val) {
  const q = parseFloat(val);
  const p = parseFloat(prev.unitPrice);
  const v = parseFloat(prev.tradeValue || prev.amount);
  const invType = (prev.investmentTransactionType || 'BUY').toUpperCase();

  let nextTradeVal = prev.tradeValue;
  let nextUnitPrice = prev.unitPrice;

  if (!isNaN(q) && q > 0) {
    if (!isNaN(p) && p > 0) {
      nextTradeVal = roundNum(q * p, 2);
    } else if (!isNaN(v) && v > 0) {
      nextUnitPrice = roundNum(v / q, 4);
    }
  }

  const nextPnl = invType === 'SELL' ? calcPnl(nextTradeVal, prev.costBasis) : prev.realizedPnl;

  return {
    ...prev,
    quantity: val,
    unitPrice: nextUnitPrice,
    tradeValue: nextTradeVal,
    amount: nextTradeVal,
    realizedPnl: nextPnl
  };
}

function handlePriceChange(prev, val) {
  const p = parseFloat(val);
  const q = parseFloat(prev.quantity);
  const v = parseFloat(prev.tradeValue || prev.amount);
  const invType = (prev.investmentTransactionType || 'BUY').toUpperCase();

  let nextTradeVal = prev.tradeValue;
  let nextQuantity = prev.quantity;

  if (!isNaN(p) && p > 0) {
    if (!isNaN(q) && q > 0) {
      nextTradeVal = roundNum(q * p, 2);
    } else if (!isNaN(v) && v > 0) {
      nextQuantity = roundNum(v / p, 3);
    }
  }

  const nextPnl = invType === 'SELL' ? calcPnl(nextTradeVal, prev.costBasis) : prev.realizedPnl;

  return {
    ...prev,
    unitPrice: val,
    quantity: nextQuantity,
    tradeValue: nextTradeVal,
    amount: nextTradeVal,
    realizedPnl: nextPnl
  };
}

function handleTradeValueChange(prev, val) {
  const v = parseFloat(val);
  const q = parseFloat(prev.quantity);
  const p = parseFloat(prev.unitPrice);
  const invType = (prev.investmentTransactionType || 'BUY').toUpperCase();

  let nextUnitPrice = prev.unitPrice;
  let nextQuantity = prev.quantity;

  if (!isNaN(v) && v > 0) {
    if (!isNaN(q) && q > 0 && (isNaN(p) || p <= 0)) {
      nextUnitPrice = roundNum(v / q, 4);
    } else if (!isNaN(p) && p > 0 && (isNaN(q) || q <= 0)) {
      nextQuantity = roundNum(v / p, 3);
    }
  }

  const nextPnl = invType === 'SELL' ? calcPnl(val, prev.costBasis) : prev.realizedPnl;

  return {
    ...prev,
    tradeValue: val,
    amount: val,
    unitPrice: nextUnitPrice,
    quantity: nextQuantity,
    realizedPnl: nextPnl
  };
}

function handleCostBasisChange(prev, val) {
  const currentTradeVal = prev.tradeValue || prev.amount;
  const nextPnl = calcPnl(currentTradeVal, val);
  return {
    ...prev,
    costBasis: val,
    realizedPnl: nextPnl
  };
}

console.log('=== VERIFYING REALIZED P&L REACTIVITY TEST MATRIX ===\n');

// A. Initial state:
// Units = 2, NAV = 60, Trade Value = 120, Cost Basis = 100, P&L = 20
let state = {
  investmentTransactionType: 'SELL',
  quantity: '2',
  unitPrice: '60',
  tradeValue: '120',
  amount: '120',
  costBasis: '100',
  realizedPnl: '20'
};

console.log('Step A (Initial):', {
  Units: state.quantity,
  NAV: state.unitPrice,
  TradeValue: state.tradeValue,
  CostBasis: state.costBasis,
  PnL: state.realizedPnl
});
assert.strictEqual(state.tradeValue, '120');
assert.strictEqual(state.realizedPnl, '20');

// B. Change NAV to 65. WITHOUT touching Cost Basis:
// Trade Value must become 130, P&L must become 30 immediately.
state = handlePriceChange(state, '65');
console.log('Step B (Change NAV to 65):', {
  Units: state.quantity,
  NAV: state.unitPrice,
  TradeValue: state.tradeValue,
  CostBasis: state.costBasis,
  PnL: state.realizedPnl
});
assert.strictEqual(state.unitPrice, '65');
assert.strictEqual(state.quantity, '2');
assert.strictEqual(state.tradeValue, '130');
assert.strictEqual(state.realizedPnl, '30');

// C. Change Cost Basis to 110.
// P&L must become 20 immediately.
state = handleCostBasisChange(state, '110');
console.log('Step C (Change Cost Basis to 110):', {
  Units: state.quantity,
  NAV: state.unitPrice,
  TradeValue: state.tradeValue,
  CostBasis: state.costBasis,
  PnL: state.realizedPnl
});
assert.strictEqual(state.costBasis, '110');
assert.strictEqual(state.tradeValue, '130');
assert.strictEqual(state.realizedPnl, '20');

// D. Change Units to 3.
// Trade Value must become 195. P&L must become 85.
state = handleUnitsChange(state, '3');
console.log('Step D (Change Units to 3):', {
  Units: state.quantity,
  NAV: state.unitPrice,
  TradeValue: state.tradeValue,
  CostBasis: state.costBasis,
  PnL: state.realizedPnl
});
assert.strictEqual(state.quantity, '3');
assert.strictEqual(state.unitPrice, '65');
assert.strictEqual(state.tradeValue, '195');
assert.strictEqual(state.realizedPnl, '85');

// E. Change NAV to 70.
// Trade Value must become 210. P&L must become 100.
state = handlePriceChange(state, '70');
console.log('Step E (Change NAV to 70):', {
  Units: state.quantity,
  NAV: state.unitPrice,
  TradeValue: state.tradeValue,
  CostBasis: state.costBasis,
  PnL: state.realizedPnl
});
assert.strictEqual(state.unitPrice, '70');
assert.strictEqual(state.quantity, '3');
assert.strictEqual(state.tradeValue, '210');
assert.strictEqual(state.realizedPnl, '100');

// F. Change Trade Value directly to 250 (as one of 2-of-3 fields)
// Units = 3, Price empty -> Price becomes 250 / 3 = 83.3333
// P&L must become 250 - 110 = 140.
let stateTV = {
  investmentTransactionType: 'SELL',
  quantity: '3',
  unitPrice: '',
  tradeValue: '',
  costBasis: '110',
  realizedPnl: ''
};
stateTV = handleTradeValueChange(stateTV, '250');
console.log('Step F (Trade Value entered directly as 250):', {
  Units: stateTV.quantity,
  NAV: stateTV.unitPrice,
  TradeValue: stateTV.tradeValue,
  CostBasis: stateTV.costBasis,
  PnL: stateTV.realizedPnl
});
assert.strictEqual(stateTV.tradeValue, '250');
assert.strictEqual(stateTV.unitPrice, '83.3333');
assert.strictEqual(stateTV.realizedPnl, '140');

console.log('\n========================================');
console.log('ALL STEPS A, B, C, D, E, F PASSED 100%!');
console.log('========================================\n');
