import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatINR, formatINRCompact } from '../utils/format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

test('FinMan Dashboard — Spending Intelligence History Default Tab Suite', async (t) => {
  const spendingIntelPath = path.join(projectRoot, 'src/components/Dashboard/DashboardSpendingIntel.jsx');
  assert.ok(fs.existsSync(spendingIntelPath), 'DashboardSpendingIntel.jsx must exist');

  const content = fs.readFileSync(spendingIntelPath, 'utf8').replace(/\r\n/g, '\n');

  await t.test('1. History is the first tab in Spending Intelligence widget', () => {
    // Extract tab buttons from toggle group
    const toggleGroupMatch = content.match(/<div className="dash-pill-toggle-group">([\s\S]*?)<\/div>/);
    assert.ok(toggleGroupMatch, 'dash-pill-toggle-group must be present in component');

    const toggleGroupHtml = toggleGroupMatch[1];
    // Match each button and its text label
    const buttonMatches = [...toggleGroupHtml.matchAll(/>\s*([A-Za-z][A-Za-z\s]+?)\s*<\/button>/g)];
    const buttonTexts = buttonMatches.map(m => m[1].trim());

    assert.deepStrictEqual(
      buttonTexts,
      ['History', 'Top Categories', 'MoM Spikes', 'Highest'],
      'Tabs must be strictly ordered: History, Top Categories, MoM Spikes, Highest'
    );
  });

  await t.test('2. History is selected by default upon initial load', () => {
    // Verify useState initialization
    const useStateMatch = content.match(/const\s*\[\s*activeTab\s*,\s*setActiveTab\s*\]\s*=\s*useState\(\s*['"]history['"]\s*\)/);
    assert.ok(useStateMatch, "activeTab state must be initialized to 'history'");

    // Verify first tab button applies active class when activeTab === 'history'
    assert.ok(
      content.includes("activeTab === 'history' ? 'active' : ''"),
      "History tab must receive 'active' class when activeTab === 'history'"
    );

    // Verify history content view is conditionally rendered when activeTab === 'history'
    assert.ok(
      content.includes("{activeTab === 'history' && ("),
      "History content view must be rendered when activeTab === 'history'"
    );
  });

  await t.test('3. Other three tabs (Top Categories, MoM Spikes, Highest) remain fully functional', () => {
    // Verify click handlers for all 4 tabs
    assert.ok(content.includes("onClick={() => setActiveTab('history')}"), 'History tab must have click handler');
    assert.ok(content.includes("onClick={() => setActiveTab('categories')}"), 'Top Categories tab must have click handler');
    assert.ok(content.includes("onClick={() => setActiveTab('spikes')}"), 'MoM Spikes tab must have click handler');
    assert.ok(content.includes("onClick={() => setActiveTab('highest')}"), 'Highest tab must have click handler');

    // Verify conditional rendering blocks exist for all 4 tabs
    assert.ok(content.includes("{activeTab === 'history' && ("), 'History tab view block must exist');
    assert.ok(content.includes("{activeTab === 'categories' && ("), 'Top Categories tab view block must exist');
    assert.ok(content.includes("{activeTab === 'spikes' && ("), 'MoM Spikes tab view block must exist');
    assert.ok(content.includes("{activeTab === 'highest' && ("), 'Highest tab view block must exist');

    // Verify categories list and actions remain intact
    assert.ok(content.includes('dash-top-categories-list'), 'Top categories list view must remain intact');
    assert.ok(content.includes('dash-spikes-list'), 'Spikes list view must remain intact');
    assert.ok(content.includes('dash-highest-list'), 'Highest expenses list view must remain intact');
  });

  await t.test('4. Existing History data metrics and calculations are preserved', () => {
    // Verify the History view structure
    assert.ok(content.includes('dash-history-view'), 'dash-history-view container must exist');
    assert.ok(content.includes('dash-history-stats-grid'), 'dash-history-stats-grid must exist');

    // Check historical metrics bindings
    assert.ok(content.includes('historical.allTimeAvgMonthly'), 'Must display allTimeAvgMonthly');
    assert.ok(content.includes('historical.allTimeAvgYearly'), 'Must display allTimeAvgYearly');
    assert.ok(content.includes('historical.peakMonth'), 'Must display peakMonth');
    assert.ok(content.includes('historical.peakMonthAmt'), 'Must display peakMonthAmt');
    assert.ok(content.includes('historical.peakYear'), 'Must display peakYear');
    assert.ok(content.includes('historical.peakYearAmt'), 'Must display peakYearAmt');

    // Check yearly breakdown table bindings
    assert.ok(content.includes('historical.yearlyRows'), 'Must display yearlyRows');
    assert.ok(content.includes('r.year'), 'Must display year column');
    assert.ok(content.includes('r.total'), 'Must display total column');
    assert.ok(content.includes('r.monthlyAvg'), 'Must display monthlyAvg column');
    assert.ok(content.includes('r.savings'), 'Must display savings column');

    // Mock data test verifying formatting integrity
    const mockHistorical = {
      allTimeAvgMonthly: 45000,
      allTimeAvgYearly: 540000,
      peakMonth: 'October 2026',
      peakMonthAmt: 78500,
      peakYear: 2026,
      peakYearAmt: 620000,
      yearlyRows: [
        { year: 2026, total: 620000, monthlyAvg: 51667, savings: 180000 },
        { year: 2025, total: 460000, monthlyAvg: 38333, savings: 240000 }
      ]
    };

    assert.strictEqual(formatINRCompact(mockHistorical.allTimeAvgMonthly), '₹45.0K');
    assert.strictEqual(formatINRCompact(mockHistorical.allTimeAvgYearly), '₹5.4L');
    assert.strictEqual(formatINR(mockHistorical.peakMonthAmt), '₹78,500');
    assert.strictEqual(formatINRCompact(mockHistorical.yearlyRows[0].savings), '₹1.8L');
  });
});
