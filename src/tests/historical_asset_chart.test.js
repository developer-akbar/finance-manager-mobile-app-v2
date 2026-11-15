import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterObservationsByRange,
  fetchHistoricalAssetSeries,
  parseDmYToTimestamp
} from '../services/historicalAssetPriceService.js';

test('Historical Asset Performance Chart Test Suite', async (t) => {

  await t.test('1. 1M and 6M use Absolute Return: ((Latest / Start) - 1) * 100', () => {
    const endTs = new Date(2026, 10, 15).getTime();
    const oneDay = 24 * 3600 * 1000;
    const mockObs = [
      { date: '15-10-2026', timestamp: endTs - (31 * oneDay), price: 80.0 },
      { date: '01-11-2026', timestamp: endTs - (14 * oneDay), price: 85.0 },
      { date: '15-11-2026', timestamp: endTs, price: 92.0 }
    ];

    const res1M = filterObservationsByRange(mockObs, '1M');
    assert.equal(res1M.startObservation.price, 80.0);
    assert.equal(res1M.endObservation.price, 92.0);
    // ((92 / 80) - 1) * 100 = 15.0%
    assert.equal(res1M.returnPercent, 15.0);
    assert.equal(res1M.isAnnualised, false);
    assert.equal(res1M.periodLabel, '1M return');
    assert.equal(res1M.isPositive, true);
  });

  await t.test('2. 1Y uses One-Year Return: ((Latest / Start) - 1) * 100', () => {
    const endTs = new Date(2026, 10, 15).getTime();
    const oneDay = 24 * 3600 * 1000;
    const mockObs = [
      { date: '15-11-2025', timestamp: endTs - (365 * oneDay), price: 100.0 },
      { date: '15-05-2026', timestamp: endTs - (184 * oneDay), price: 110.0 },
      { date: '15-11-2026', timestamp: endTs, price: 125.0 }
    ];

    const res1Y = filterObservationsByRange(mockObs, '1Y');
    assert.equal(res1Y.startObservation.price, 100.0);
    assert.equal(res1Y.endObservation.price, 125.0);
    // ((125 / 100) - 1) * 100 = 25.0%
    assert.equal(res1Y.returnPercent, 25.0);
    assert.equal(res1Y.isAnnualised, false);
    assert.equal(res1Y.periodLabel, '1Y return');
  });

  await t.test('3. 3Y and 5Y use Annualised CAGR: ((NAV_end / NAV_start)^(365.2425/Days) - 1) * 100', () => {
    const endTs = new Date(2026, 10, 13).getTime();
    const oneDay = 24 * 3600 * 1000;
    // Parag Parikh 3Y actual observations
    // 13-11-2023: NAV 65.3870, 13-11-2026: NAV 94.2594, Days: 1096
    const mock3YObs = [
      { date: '13-11-2023', timestamp: endTs - (1096 * oneDay), price: 65.3870 },
      { date: '13-11-2024', timestamp: endTs - (730 * oneDay), price: 80.0000 },
      { date: '13-11-2025', timestamp: endTs - (365 * oneDay), price: 90.0000 },
      { date: '13-11-2026', timestamp: endTs, price: 94.2594 }
    ];

    const res3Y = filterObservationsByRange(mock3YObs, '3Y');
    assert.equal(res3Y.isAnnualised, true);
    assert.equal(res3Y.periodLabel, '3Y annualised');
    // CAGR should be ~12.96% (matches Groww's +12.95% within 0.01%)
    assert.ok(Math.abs(res3Y.returnPercent - 12.96) < 0.05, `CAGR was ${res3Y.returnPercent}, expected ~12.96%`);

    // Cumulative return should still be calculated accurately
    assert.ok(Math.abs(res3Y.cumulativeReturnPercent - 44.16) < 0.1, `Cumulative was ${res3Y.cumulativeReturnPercent}, expected ~44.16%`);
  });

  await t.test('4. All-time uses Since-Inception CAGR based on actual elapsed days', () => {
    const endTs = new Date(2026, 10, 13).getTime();
    const oneDay = 24 * 3600 * 1000;
    // Parag Parikh Inception: 28-05-2013 NAV 9.9992 -> 13-11-2026 NAV 94.2594, Days: 4917
    const mockAllObs = [
      { date: '28-05-2013', timestamp: endTs - (4917 * oneDay), price: 9.9992 },
      { date: '13-11-2026', timestamp: endTs, price: 94.2594 }
    ];

    const resAll = filterObservationsByRange(mockAllObs, 'All');
    assert.equal(resAll.isAnnualised, true);
    assert.equal(resAll.periodLabel, 'Since inception annualised');
    // CAGR should be ~18.13% (matches Groww's +18.10% within 0.03%)
    assert.ok(Math.abs(resAll.returnPercent - 18.13) < 0.05, `Inception CAGR was ${resAll.returnPercent}, expected ~18.13%`);
  });

  await t.test('5. Negative CAGR correctly handles depreciation over 3Y', () => {
    const endTs = new Date(2026, 10, 15).getTime();
    const oneDay = 24 * 3600 * 1000;
    const mockObs = [
      { date: '15-11-2023', timestamp: endTs - (1095 * oneDay), price: 100.0 },
      { date: '15-11-2026', timestamp: endTs, price: 72.9 }
    ];

    const res = filterObservationsByRange(mockObs, '3Y');
    assert.equal(res.isPositive, false);
    // (72.9 / 100)^(1/3) - 1 = 0.9 - 1 = -10.0%
    assert.ok(Math.abs(res.returnPercent - (-10.0)) < 0.1, `Return was ${res.returnPercent}`);
    assert.equal(res.periodLabel, '3Y annualised');
  });

  await t.test('6. Gracefully handles partial history when requested period exceeds inception date', () => {
    const endTs = new Date(2026, 10, 15).getTime();
    const mockObs = [
      { date: '15-03-2026', timestamp: new Date(2026, 2, 15).getTime(), price: 10.0 },
      { date: '15-11-2026', timestamp: endTs, price: 12.0 }
    ];

    const res3Y = filterObservationsByRange(mockObs, '3Y');
    assert.equal(res3Y.isPartial, true);
    assert.ok(res3Y.availableSpanText.includes('Available:'));
    assert.equal(res3Y.startObservation.price, 10.0);
    assert.equal(res3Y.endObservation.price, 12.0);
    // Under 1 year, falls back to absolute return cleanly
    assert.equal(res3Y.returnPercent, 20.0);
  });

  await t.test('7. Handles empty or single observation safely without manufacturing fake returns', () => {
    const resEmpty = filterObservationsByRange([], '1Y');
    assert.equal(resEmpty.filteredObservations.length, 0);
    assert.equal(resEmpty.returnPercent, null);

    const resSingle = filterObservationsByRange([{ date: '01-01-2026', timestamp: 1000, price: 50 }], '1Y');
    assert.equal(resSingle.filteredObservations.length, 0);
    assert.equal(resSingle.returnPercent, null);
  });

  await t.test('8. Handles missing or null position gracefully', async () => {
    const res = await fetchHistoricalAssetSeries(null);
    assert.equal(res.isAvailable, false);
    assert.ok(res.error);
  });
  await t.test('9. parseDmYToTimestamp handles DD-MM-YYYY and rejects invalid dates', () => {
    // Standard DD-MM-YYYY with day > 12 (which breaks standard JS new Date('15-05-2023'))
    const ts1 = parseDmYToTimestamp('15-05-2023');
    assert.ok(ts1 > 0);
    const d1 = new Date(ts1);
    assert.equal(d1.getFullYear(), 2023);
    assert.equal(d1.getMonth(), 4); // May is 0-indexed
    assert.equal(d1.getDate(), 15);

    // End of year
    const ts2 = parseDmYToTimestamp('31-12-2024');
    assert.ok(ts2 > 0);
    const d2 = new Date(ts2);
    assert.equal(d2.getFullYear(), 2024);
    assert.equal(d2.getMonth(), 11);
    assert.equal(d2.getDate(), 31);

    // Invalid format / date rejection
    assert.equal(parseDmYToTimestamp(''), 0);
    assert.equal(parseDmYToTimestamp(null), 0);
    assert.equal(parseDmYToTimestamp('invalid-date'), 0);
    assert.equal(parseDmYToTimestamp('99-99-9999'), 0);
  });
});
