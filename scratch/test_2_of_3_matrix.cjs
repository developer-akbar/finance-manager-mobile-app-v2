const assert = require('assert');

// Exact implementation from AddTransaction.jsx
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

class FormSimulator {
  constructor(initialState = {}) {
    this.state = {
      investmentTransactionType: 'SELL',
      quantity: '',
      unitPrice: '',
      tradeValue: '',
      amount: '',
      costBasis: '100',
      realizedPnl: '',
      ...initialState
    };
    this.lastEditedInvInput = 'quantity';
  }

  handleUnitsChange(val) {
    this.lastEditedInvInput = 'quantity';
    const prev = this.state;
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

    this.state = {
      ...prev,
      quantity: val,
      unitPrice: nextUnitPrice,
      tradeValue: nextTradeVal,
      amount: nextTradeVal,
      realizedPnl: nextPnl
    };
    return this.state;
  }

  handlePriceChange(val) {
    this.lastEditedInvInput = 'unitPrice';
    const prev = this.state;
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

    this.state = {
      ...prev,
      unitPrice: val,
      quantity: nextQuantity,
      tradeValue: nextTradeVal,
      amount: nextTradeVal,
      realizedPnl: nextPnl
    };
    return this.state;
  }

  handleTradeValueChange(val) {
    const prev = this.state;
    const v = parseFloat(val);
    const q = parseFloat(prev.quantity);
    const p = parseFloat(prev.unitPrice);
    const invType = (prev.investmentTransactionType || 'BUY').toUpperCase();

    let nextUnitPrice = prev.unitPrice;
    let nextQuantity = prev.quantity;

    if (!isNaN(v) && v > 0) {
      if (!isNaN(q) && q > 0) {
        nextUnitPrice = roundNum(v / q, 4);
      } else if (!isNaN(p) && p > 0) {
        nextQuantity = roundNum(v / p, 3);
      }
    }

    const nextPnl = invType === 'SELL' ? calcPnl(val, prev.costBasis) : prev.realizedPnl;

    this.state = {
      ...prev,
      tradeValue: val,
      amount: val,
      unitPrice: nextUnitPrice,
      quantity: nextQuantity,
      realizedPnl: nextPnl
    };
    return this.state;
  }

  handleCostBasisChange(val) {
    const prev = this.state;
    const currentTradeVal = prev.tradeValue || prev.amount;
    const nextPnl = calcPnl(currentTradeVal, val);
    this.state = {
      ...prev,
      costBasis: val,
      realizedPnl: nextPnl
    };
    return this.state;
  }
}

console.log('=== VERIFYING 2-OF-3 TEST CASES ===\n');

// Case 1: Units = 2, NAV = 60 => Trade Value = 120
{
  const sim = new FormSimulator({ costBasis: '100' });
  sim.handleUnitsChange('2');
  const res = sim.handlePriceChange('60');
  console.log('Case 1 (Units=2, NAV=60):', { Units: res.quantity, NAV: res.unitPrice, TradeValue: res.tradeValue, PnL: res.realizedPnl });
  assert.strictEqual(res.quantity, '2');
  assert.strictEqual(res.unitPrice, '60');
  assert.strictEqual(res.tradeValue, '120');
  assert.strictEqual(res.realizedPnl, '20'); // 120 - 100
}

// Case 2: Units = 2, Trade Value = 250 => NAV = 125
{
  const sim = new FormSimulator({ costBasis: '100' });
  sim.handleUnitsChange('2');
  const res = sim.handleTradeValueChange('250');
  console.log('Case 2 (Units=2, TradeValue=250):', { Units: res.quantity, NAV: res.unitPrice, TradeValue: res.tradeValue, PnL: res.realizedPnl });
  assert.strictEqual(res.quantity, '2');
  assert.strictEqual(res.unitPrice, '125');
  assert.strictEqual(res.tradeValue, '250');
  assert.strictEqual(res.realizedPnl, '150'); // 250 - 100
}

// Case 3: Units = 2, Trade Value = 300 => NAV = 150 (from previous Case 2 state)
{
  const sim = new FormSimulator({ costBasis: '100' });
  sim.handleUnitsChange('2');
  sim.handleTradeValueChange('250');
  const res = sim.handleTradeValueChange('300');
  console.log('Case 3 (Units=2, TradeValue=300):', { Units: res.quantity, NAV: res.unitPrice, TradeValue: res.tradeValue, PnL: res.realizedPnl });
  assert.strictEqual(res.quantity, '2');
  assert.strictEqual(res.unitPrice, '150');
  assert.strictEqual(res.tradeValue, '300');
  assert.strictEqual(res.realizedPnl, '200'); // 300 - 100
}

// Case 4: NAV = 50, Trade Value = 250 => Units = 5
{
  const sim = new FormSimulator({ costBasis: '100' });
  sim.handlePriceChange('50');
  const res = sim.handleTradeValueChange('250');
  console.log('Case 4 (NAV=50, TradeValue=250):', { Units: res.quantity, NAV: res.unitPrice, TradeValue: res.tradeValue, PnL: res.realizedPnl });
  assert.strictEqual(res.unitPrice, '50');
  assert.strictEqual(res.quantity, '5');
  assert.strictEqual(res.tradeValue, '250');
  assert.strictEqual(res.realizedPnl, '150'); // 250 - 100
}

// Case 5: Units = 3, NAV = 65 => Trade Value = 195
{
  const sim = new FormSimulator({ costBasis: '100' });
  sim.handleUnitsChange('3');
  const res = sim.handlePriceChange('65');
  console.log('Case 5 (Units=3, NAV=65):', { Units: res.quantity, NAV: res.unitPrice, TradeValue: res.tradeValue, PnL: res.realizedPnl });
  assert.strictEqual(res.quantity, '3');
  assert.strictEqual(res.unitPrice, '65');
  assert.strictEqual(res.tradeValue, '195');
  assert.strictEqual(res.realizedPnl, '95'); // 195 - 100
}

// Case 6: Units = 3, Trade Value = 300 => NAV = 100
{
  const sim = new FormSimulator({ costBasis: '100' });
  sim.handleUnitsChange('3');
  const res = sim.handleTradeValueChange('300');
  console.log('Case 6 (Units=3, TradeValue=300):', { Units: res.quantity, NAV: res.unitPrice, TradeValue: res.tradeValue, PnL: res.realizedPnl });
  assert.strictEqual(res.quantity, '3');
  assert.strictEqual(res.unitPrice, '100');
  assert.strictEqual(res.tradeValue, '300');
  assert.strictEqual(res.realizedPnl, '200'); // 300 - 100
}

// Case 7: NAV = 75, Trade Value = 300 => Units = 4
{
  const sim = new FormSimulator({ costBasis: '100' });
  sim.handlePriceChange('75');
  const res = sim.handleTradeValueChange('300');
  console.log('Case 7 (NAV=75, TradeValue=300):', { Units: res.quantity, NAV: res.unitPrice, TradeValue: res.tradeValue, PnL: res.realizedPnl });
  assert.strictEqual(res.unitPrice, '75');
  assert.strictEqual(res.quantity, '4');
  assert.strictEqual(res.tradeValue, '300');
  assert.strictEqual(res.realizedPnl, '200'); // 300 - 100
}

console.log('\n========================================');
console.log('ALL 7 2-OF-3 TEST CASES PASSED WITH 100% SUCCESS!');
console.log('========================================\n');
