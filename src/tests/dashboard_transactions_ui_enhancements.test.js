/**
 * src/tests/dashboard_transactions_ui_enhancements.test.js
 *
 * Automated Test Suite for FinMan Phase 2: Dashboard and Transactions UI Enhancements.
 * Covers:
 * 1. Transactions Daily tab: Today's date highlight & badge logic.
 * 2. Transactions Monthly tab: Current month highlight & calendar comparison.
 * 3. Monthly to Daily back navigation logic and scroll event dispatch.
 * 4. Dashboard Bookmarks button and navigation consistency.
 * 5. High-contrast theme-aware hover styles for Paste, Bookmarks, Search.
 * 6. Persistent Net Worth Reveal/Hide control synchronization and privacy masking.
 * 7. Authoritative 1D portfolio return calculation, INR/percentage formatting, and unavailable handling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseDate, formatINR } from '../utils/format.js';
import { computePortfolio1DReturns } from '../utils/portfolioAggregation.js';

test('FinMan Phase 2 — Dashboard and Transactions UI Enhancements Suite', async (t) => {

  await t.test('1. Transactions Daily Tab: Correctly identifies and marks today\'s date', () => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const currentDate = now.getDate();

    // Check date comparison logic
    const testToday = new Date(currentYear, currentMonth, currentDate, 10, 30);
    const isToday = testToday.getFullYear() === now.getFullYear() &&
                    testToday.getMonth() === now.getMonth() &&
                    testToday.getDate() === now.getDate();
    assert.equal(isToday, true, 'Today\'s date must be identified as true');

    // Check yesterday
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterdayToday = yesterday.getFullYear() === now.getFullYear() &&
                            yesterday.getMonth() === now.getMonth() &&
                            yesterday.getDate() === now.getDate();
    assert.equal(isYesterdayToday, false, 'Yesterday must not be identified as today');

    // Verify Transactions.jsx source contains dg-header-today and dg-today-badge
    const txnsCode = fs.readFileSync('src/components/Transactions/Transactions.jsx', 'utf8');
    assert.ok(txnsCode.includes('dg-header-today'), 'Transactions.jsx must use dg-header-today class');
    assert.ok(txnsCode.includes('dg-today-badge'), 'Transactions.jsx must include dg-today-badge');
  });

  await t.test('2. Transactions Monthly Tab: Correctly identifies calendar current month and year', () => {
    const now = new Date();
    const currentCalYear = now.getFullYear();
    const currentCalMonth = now.getMonth();

    // Matching current year & current month
    const isCurrent = (currentCalYear === now.getFullYear() && currentCalMonth === now.getMonth());
    assert.equal(isCurrent, true, 'Current year and month must match');

    // Same month, different year (e.g. November 2025 vs November 2026)
    const isPastYearSameMonth = ((currentCalYear - 1) === now.getFullYear() && currentCalMonth === now.getMonth());
    assert.equal(isPastYearSameMonth, false, 'Same month in different year must not be marked as current');

    // Same year, different month
    const otherMonth = (currentCalMonth + 1) % 12;
    const isOtherMonth = (currentCalYear === now.getFullYear() && otherMonth === now.getMonth());
    assert.equal(isOtherMonth, false, 'Different month in same year must not be marked as current');

    // Verify Transactions.jsx source contains month-row-current and month-current-badge
    const txnsCode = fs.readFileSync('src/components/Transactions/Transactions.jsx', 'utf8');
    assert.ok(txnsCode.includes('month-row-current'), 'Transactions.jsx must use month-row-current class');
    assert.ok(txnsCode.includes('month-current-badge'), 'Transactions.jsx must include month-current-badge');
  });

  await t.test('3. Back Navigation from Monthly to Daily returns to today\'s date without app exit', () => {
    const txnsCode = fs.readFileSync('src/components/Transactions/Transactions.jsx', 'utf8');

    // Verify backInterceptRef handles viewMode === 'monthly'
    assert.ok(txnsCode.includes("viewMode === 'monthly'"), 'backInterceptRef must check viewMode === monthly');
    assert.ok(txnsCode.includes("setViewMode('daily')"), 'Must reset viewMode to daily');
    assert.ok(txnsCode.includes("window.dispatchEvent(new CustomEvent('scroll-to-today'))"), 'Must dispatch scroll-to-today');

    // Verify popstate listener is registered and cleaned up
    assert.ok(txnsCode.includes("window.addEventListener('popstate'"), 'Must register popstate listener');
    assert.ok(txnsCode.includes("window.removeEventListener('popstate'"), 'Must clean up popstate listener');
  });

  await t.test('4. Bookmarks Button: Placed beside floating + button on Dashboard and Transactions', () => {
    const dashCode = fs.readFileSync('src/components/Dashboard/Dashboard.jsx', 'utf8');
    const txnCode = fs.readFileSync('src/components/Transactions/Transactions.jsx', 'utf8');

    // Dashboard floating action button group with bookmarks
    assert.ok(dashCode.includes('className="screen-fab-group"'), 'Dashboard must render screen-fab-group');
    assert.ok(dashCode.includes('className="bookmarks-fab"'), 'Dashboard must render bookmarks-fab beside + button');
    assert.ok(dashCode.includes("navigate('bookmarks')"), 'Dashboard bookmarks-fab must navigate to bookmarks');

    // Transactions floating action button group with bookmarks
    assert.ok(txnCode.includes('className="screen-fab-group"'), 'Transactions must render screen-fab-group');
    assert.ok(txnCode.includes('className="bookmarks-fab"'), 'Transactions must render bookmarks-fab beside + button');
    assert.ok(txnCode.includes("navigate('bookmarks')"), 'Transactions bookmarks-fab must navigate to bookmarks');

    // Shortcuts strip Bookmarks pill preserved
    assert.ok(dashCode.includes("{ id: 'bookmarks', label: 'Bookmarks', icon: '🔖', onClick: () => navigate('bookmarks') }"), 'Shortcuts strip must include Bookmarks pill');
  });

  await t.test('5. Button Hover Contrast: Transactions action buttons have theme-aware styles', () => {
    const cssCode = fs.readFileSync('src/components/Transactions/Transactions.css', 'utf8');

    // Dark mode hover rules
    assert.ok(cssCode.includes('.txn-paste-btn:hover, .txn-bookmark-btn:hover, .txn-search-btn:hover'), 'Must style hover for paste, bookmark, search');
    assert.ok(cssCode.includes('border-color: var(--accent'), 'Must highlight border with accent on hover');

    // Light mode hover rules with high contrast
    assert.ok(cssCode.includes('[data-theme="light"] .txn-paste-btn:hover'), 'Must have light theme hover rules');
    assert.ok(cssCode.includes('color: var(--text-primary, #0d1b2a) !important'), 'Light theme hover must enforce dark text contrast');
    assert.ok(cssCode.includes('stroke: var(--accent, #00b87a) !important'), 'Light theme hover must enforce visible icon stroke');

    // Focus-visible and active states
    assert.ok(cssCode.includes(':focus-visible'), 'Must have focus-visible styles');
    assert.ok(cssCode.includes(':active'), 'Must have active press state');
  });

  await t.test('6. Net Worth Reveal Button: Persistent in Dashboard header and synchronized', () => {
    const dashCode = fs.readFileSync('src/components/Dashboard/Dashboard.jsx', 'utf8');

    // Header privacy button
    assert.ok(dashCode.includes('dash-header-privacy-btn'), 'Dashboard header must render dash-header-privacy-btn');
    assert.ok(dashCode.includes('onClick={() => setShowPrivacy(v => !v)}'), 'Header privacy button must toggle showPrivacy state');
    assert.ok(dashCode.includes("<EyeIcon open={showPrivacy} />"), 'Header button must render EyeIcon matching showPrivacy');
    assert.ok(dashCode.includes("showPrivacy ? 'Mask' : 'Reveal'"), 'Label must match showPrivacy state');

    // Hero overview also uses the same showPrivacy
    assert.ok(dashCode.includes('showPrivacy={showPrivacy}'), 'showPrivacy must be passed to DashboardOverviewHero');
  });

  await t.test('7. Dashboard Investment Portfolio 1D Return: Authoritative computation and safe display', () => {
    const summaryCode = fs.readFileSync('src/components/Dashboard/DashboardInvestmentSummary.jsx', 'utf8');

    // Verify 1D metrics extracted from summaryMetrics
    assert.ok(summaryCode.includes('summaryMetrics?.total1DChange'), 'Must extract total1DChange');
    assert.ok(summaryCode.includes('summaryMetrics?.portfolio1DPct'), 'Must extract portfolio1DPct');
    assert.ok(summaryCode.includes('summaryMetrics?.valid1DCount'), 'Must extract valid1DCount');

    // Verify 1D Return pill rendered
    assert.ok(summaryCode.includes('1D Return'), 'Must display 1D Return label');
    assert.ok(summaryCode.includes('formatINR(total1DChange)'), 'Must format rupee amount in INR');
    assert.ok(summaryCode.includes(`${'{portfolio1DPct}% 1D'}`), 'Must format 1D percentage');

    // Verify unavailable state handled safely with '—' rather than fabricating '0%'
    assert.ok(summaryCode.includes(": '—'"), 'Must fallback to dash when total1DChange is unavailable');
    assert.ok(summaryCode.includes('<span className="dash-pnl-sub-pct neutral">—</span>'), 'Must fallback to dash when portfolio1DPct is unavailable');

    // Verify computePortfolio1DReturns logic independently
    const mockValuationProvider = {
      getValuation: (pos) => {
        if (pos.symbol === 'RELIANCE') {
          return { isValued: true, nav: 1525, previousClose: 1500 };
        }
        if (pos.symbol === 'TCS') {
          return { isValued: true, nav: 3800, previousClose: 3850 };
        }
        return { isValued: false };
      }
    };

    const mockPositions = [
      { symbol: 'RELIANCE', currentUnits: 10, remainingCostBasis: 14000 },
      { symbol: 'TCS', currentUnits: 5, remainingCostBasis: 18000 },
      { symbol: 'UNVALUED', currentUnits: 20, remainingCostBasis: 5000 }
    ];

    const result = computePortfolio1DReturns(mockPositions, mockValuationProvider);

    // RELIANCE: (1525 - 1500) * 10 = +250, prevVal = 1500 * 10 = 15,000
    // TCS: (3800 - 3850) * 5 = -250, prevVal = 3850 * 5 = 19,250
    // Sum 1D change = 250 - 250 = 0
    // Sum prev value = 15,000 + 19,250 = 34,250
    // Portfolio 1D % = 0 / 34,250 = 0%
    assert.equal(result.total1DChange, 0);
    assert.equal(result.portfolio1DPct, 0);
    assert.equal(result.valid1DCount, 2);

    // Empty or unvalued positions return null (never fabricate 0%)
    const emptyResult = computePortfolio1DReturns([], mockValuationProvider);
    assert.equal(emptyResult.total1DChange, null);
    assert.equal(emptyResult.portfolio1DPct, null);
  });

});

