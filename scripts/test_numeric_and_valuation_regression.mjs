import assert from 'assert';
import { cleanNumericInput } from '../src/utils/format.js';
import { ValuationProvider } from '../src/utils/valuationProvider.js';

console.log('--- RUNNING NUMERIC INPUT & VALUATION CACHE REGRESSION TESTS ---');

// 1. Test cleanNumericInput
assert.strictEqual(cleanNumericInput(''), '', 'Empty string returns empty');
assert.strictEqual(cleanNumericInput('100'), '100', 'Integer string preserved');
assert.strictEqual(cleanNumericInput('100.50'), '100.50', 'Decimal string preserved');
assert.strictEqual(cleanNumericInput('abc'), '', 'Letters stripped');
assert.strictEqual(cleanNumericInput('12a34'), '1234', 'Letters filtered out');
assert.strictEqual(cleanNumericInput('₹100.50'), '100.50', 'Currency symbols filtered');
assert.strictEqual(cleanNumericInput('100.50.25'), '100.5025', 'Multiple decimal points collapsed to single decimal');
assert.strictEqual(cleanNumericInput('-50', true), '-50', 'Negative sign supported when enabled');
assert.strictEqual(cleanNumericInput('-50', false), '50', 'Negative sign filtered when disabled');
console.log('✓ cleanNumericInput passes all validation cases');

// 2. Test ValuationProvider negative caching
const provider = new ValuationProvider();

// Seed a 404 / unavailable ticker in cache
provider.cacheMap.set('TATAMTRDVR.NS', {
  symbol: 'TATAMTRDVR.NS',
  isin: null,
  assetType: 'EQUITY',
  price: null,
  isAvailable: false,
  freshness: 'UNAVAILABLE',
  isStale: true,
  fetchedAt: new Date().toISOString(),
  error: 'Symbol not found (404)'
});

const testPositions = [
  {
    status: 'ACTIVE',
    security: 'TATAMTRDVR.NS',
    investmentAccount: 'Share Market',
    subAccount: 'Zerodha',
    currentUnits: 10,
    remainingCostBasis: 1000
  }
];

// Verify getValuation returns clean isValued: false without crashing
const v = provider.getValuation(testPositions[0]);
assert.strictEqual(v.isValued, false, 'Unavailable ticker is not valued');
assert.strictEqual(v.nav, null, 'NAV is null');
assert.strictEqual(v.freshness, 'UNAVAILABLE', 'Freshness is UNAVAILABLE');
console.log('✓ ValuationProvider handles UNAVAILABLE position cleanly');

console.log('ALL NUMERIC & VALUATION REGRESSION TESTS PASSED! ✅');
