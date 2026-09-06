const assert = require('assert');

// Exact implementation logic from AddTransaction.jsx
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

class FormUXSimulator {
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
    const invType = (prev.investmentTransactionType || 'BUY').toUpperCase();

    let nextTradeVal = prev.tradeValue;

    if (!isNaN(q) && q > 0 && !isNaN(p) && p > 0) {
      nextTradeVal = roundNum(q * p, 2);
    }

    const nextPnl = invType === 'SELL' ? calcPnl(nextTradeVal, prev.costBasis) : prev.realizedPnl;

    this.state = {
      ...prev,
      quantity: val,
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
    const invType = (prev.investmentTransactionType || 'BUY').toUpperCase();

    let nextTradeVal = prev.tradeValue;

    if (!isNaN(p) && p > 0 && !isNaN(q) && q > 0) {
      nextTradeVal = roundNum(q * p, 2);
    }

    const nextPnl = invType === 'SELL' ? calcPnl(nextTradeVal, prev.costBasis) : prev.realizedPnl;

    this.state = {
      ...prev,
      unitPrice: val,
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
}

console.log('=== TEST 1: INTERMEDIATE EMPTY STATES (NO FIGHTING) ===');

// Test 1.1: Clearing NAV does NOT change Units or Trade Value
{
  const sim = new FormUXSimulator({ quantity: '2', unitPrice: '60', tradeValue: '120', amount: '120', costBasis: '100', realizedPnl: '20' });
  const cleared = sim.handlePriceChange('');
  console.log('1.1 Clear NAV:', cleared);
  assert.strictEqual(cleared.unitPrice, '');
  assert.strictEqual(cleared.quantity, '2', 'Units must NOT be modified when NAV is cleared');
  assert.strictEqual(cleared.tradeValue, '120', 'Trade Value must NOT jump when NAV is cleared');
}

// Test 1.2: Clearing Trade Value does NOT change Units or NAV
{
  const sim = new FormUXSimulator({ quantity: '5', unitPrice: '50', tradeValue: '250', amount: '250', costBasis: '100', realizedPnl: '150' });
  const cleared = sim.handleTradeValueChange('');
  console.log('1.2 Clear Trade Value:', cleared);
  assert.strictEqual(cleared.tradeValue, '');
  assert.strictEqual(cleared.quantity, '5', 'Units must NOT be modified when Trade Value is cleared');
  assert.strictEqual(cleared.unitPrice, '50', 'NAV must NOT be modified when Trade Value is cleared');
  assert.strictEqual(cleared.realizedPnl, '', 'P&L must be empty when Trade Value is empty');
}

// Test 1.3: Clearing Units does NOT change NAV or Trade Value
{
  const sim = new FormUXSimulator({ quantity: '5', unitPrice: '50', tradeValue: '250', amount: '250', costBasis: '100', realizedPnl: '150' });
  const cleared = sim.handleUnitsChange('');
  console.log('1.3 Clear Units:', cleared);
  assert.strictEqual(cleared.quantity, '');
  assert.strictEqual(cleared.unitPrice, '50', 'NAV must NOT be modified when Units is cleared');
  assert.strictEqual(cleared.tradeValue, '250', 'Trade Value must NOT be modified when Units is cleared');
}

console.log('\n=== TEST 2: USER EXAMPLES FROM SPEC ===');

// Example 1: Start: Units 2, NAV 60, Trade Value 120. Clear NAV -> "", Type 50 -> Trade Value 100
{
  const sim = new FormUXSimulator({ quantity: '2', unitPrice: '60', tradeValue: '120', amount: '120', costBasis: '100', realizedPnl: '20' });
  sim.handlePriceChange(''); // user cleared NAV
  assert.strictEqual(sim.state.quantity, '2');
  assert.strictEqual(sim.state.unitPrice, '');
  assert.strictEqual(sim.state.tradeValue, '120');
  sim.handlePriceChange('50'); // user types 50
  console.log('Example 1 (Edit NAV -> 50):', { Units: sim.state.quantity, NAV: sim.state.unitPrice, TradeValue: sim.state.tradeValue });
  assert.strictEqual(sim.state.quantity, '2');
  assert.strictEqual(sim.state.unitPrice, '50');
  assert.strictEqual(sim.state.tradeValue, '100');
  assert.strictEqual(sim.state.realizedPnl, '0'); // 100 - 100
}

// Example 2: Start: Units 5, NAV 50, Trade Value 250. Clear Trade Value -> "", Type 300 -> NAV 60
{
  const sim = new FormUXSimulator({ quantity: '5', unitPrice: '50', tradeValue: '250', amount: '250', costBasis: '100', realizedPnl: '150' });
  sim.handleTradeValueChange(''); // user cleared Trade Value
  assert.strictEqual(sim.state.quantity, '5');
  assert.strictEqual(sim.state.unitPrice, '50');
  assert.strictEqual(sim.state.tradeValue, '');
  sim.handleTradeValueChange('300'); // user types 300
  console.log('Example 2 (Edit Trade Value -> 300):', { Units: sim.state.quantity, NAV: sim.state.unitPrice, TradeValue: sim.state.tradeValue });
  assert.strictEqual(sim.state.quantity, '5');
  assert.strictEqual(sim.state.unitPrice, '60');
  assert.strictEqual(sim.state.tradeValue, '300');
  assert.strictEqual(sim.state.realizedPnl, '200'); // 300 - 100
}

// Example 3: Start: Units 5, NAV 50, Trade Value 250. Clear Units -> "", Type 2 -> Trade Value 100
{
  const sim = new FormUXSimulator({ quantity: '5', unitPrice: '50', tradeValue: '250', amount: '250', costBasis: '100', realizedPnl: '150' });
  sim.handleUnitsChange(''); // user cleared Units
  assert.strictEqual(sim.state.quantity, '');
  assert.strictEqual(sim.state.unitPrice, '50');
  assert.strictEqual(sim.state.tradeValue, '250');
  sim.handleUnitsChange('2'); // user types 2
  console.log('Example 3 (Edit Units -> 2):', { Units: sim.state.quantity, NAV: sim.state.unitPrice, TradeValue: sim.state.tradeValue });
  assert.strictEqual(sim.state.quantity, '2');
  assert.strictEqual(sim.state.unitPrice, '50');
  assert.strictEqual(sim.state.tradeValue, '100');
  assert.strictEqual(sim.state.realizedPnl, '0'); // 100 - 100
}

// Example 4 & 5: Start: NAV 50, Trade Value 250, Units 5. Clear Units -> "", Type 4 -> Trade Value 200
{
  const sim = new FormUXSimulator({ quantity: '5', unitPrice: '50', tradeValue: '250', amount: '250', costBasis: '100', realizedPnl: '150' });
  sim.handleUnitsChange('');
  assert.strictEqual(sim.state.quantity, '');
  assert.strictEqual(sim.state.unitPrice, '50');
  assert.strictEqual(sim.state.tradeValue, '250');
  sim.handleUnitsChange('4');
  console.log('Example 4/5 (Edit Units -> 4):', { Units: sim.state.quantity, NAV: sim.state.unitPrice, TradeValue: sim.state.tradeValue });
  assert.strictEqual(sim.state.quantity, '4');
  assert.strictEqual(sim.state.unitPrice, '50');
  assert.strictEqual(sim.state.tradeValue, '200');
  assert.strictEqual(sim.state.realizedPnl, '100'); // 200 - 100
}

console.log('\n=== TEST 3: MANUAL ACCEPTANCE TEST FLOW ===');
// 1. Start: Units 2, NAV 60, Trade Value 120
// 2. Click NAV, Ctrl+A, Type 50 -> Units 2, NAV 50, Trade Value 100
// 3. Click Trade Value, Ctrl+A, Type 300 -> Units 2, NAV 150, Trade Value 300
// 4. Click Units, Ctrl+A, Type 5 -> Units 5, NAV 150, Trade Value 750
{
  const sim = new FormUXSimulator({ quantity: '2', unitPrice: '60', tradeValue: '120', amount: '120', costBasis: '100', realizedPnl: '20' });
  
  // Step 2-4: Click NAV, Ctrl+A, Type 50
  sim.handlePriceChange('50');
  console.log('Step 4 (Type NAV 50):', { Units: sim.state.quantity, NAV: sim.state.unitPrice, TradeValue: sim.state.tradeValue });
  assert.strictEqual(sim.state.quantity, '2');
  assert.strictEqual(sim.state.unitPrice, '50');
  assert.strictEqual(sim.state.tradeValue, '100');

  // Step 5-7: Click Trade Value, Ctrl+A, Type 300
  sim.handleTradeValueChange('300');
  console.log('Step 7 (Type Trade Value 300):', { Units: sim.state.quantity, NAV: sim.state.unitPrice, TradeValue: sim.state.tradeValue });
  assert.strictEqual(sim.state.quantity, '2');
  assert.strictEqual(sim.state.unitPrice, '150');
  assert.strictEqual(sim.state.tradeValue, '300');

  // Step 8-10: Click Units, Ctrl+A, Type 5
  sim.handleUnitsChange('5');
  console.log('Step 10 (Type Units 5):', { Units: sim.state.quantity, NAV: sim.state.unitPrice, TradeValue: sim.state.tradeValue });
  assert.strictEqual(sim.state.quantity, '5');
  assert.strictEqual(sim.state.unitPrice, '150');
  assert.strictEqual(sim.state.tradeValue, '750');
}

console.log('\n========================================');
console.log('ALL UX & CALCULATION TESTS PASSED 100%!');
console.log('========================================\n');
