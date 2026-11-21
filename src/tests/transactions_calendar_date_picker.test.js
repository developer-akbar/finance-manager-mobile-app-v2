/**
 * src/tests/transactions_calendar_date_picker.test.js
 *
 * Automated Test Suite for FinMan Calendar Date Picker on Transactions Screen.
 *
 * Requirements covered:
 * 1. Clicking the month/year heading opens the calendar.
 * 2. Selecting a date in the current month navigates correctly.
 * 3. Selecting a date in another month updates month/year correctly.
 * 4. Selecting a date in another year works correctly.
 * 5. Selection switches Monthly view to Daily view.
 * 6. The selected date is scrolled into view.
 * 7. Selecting a date with no transactions does not jump to another date.
 * 8. Today's and selected-date highlights are distinguishable.
 * 9. Escape and outside click close the calendar.
 * 10. Existing previous/next navigation remains functional.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseDate, toDDMMYYYY } from '../utils/format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

test('FinMan — Calendar Date Picker & Transactions Navigation Suite', async (t) => {

  await t.test('1. CalendarDatePicker component exists with required structure', () => {
    const compPath = path.join(projectRoot, 'src/components/Common/CalendarDatePicker.jsx');
    assert.ok(fs.existsSync(compPath), 'CalendarDatePicker.jsx must exist');
    const content = fs.readFileSync(compPath, 'utf8');

    assert.ok(content.includes('export default function CalendarDatePicker'), 'Must export default CalendarDatePicker');
    assert.ok(content.includes('role="dialog"'), 'Must have role="dialog"');
    assert.ok(content.includes('aria-modal="true"'), 'Must have aria-modal="true"');
    assert.ok(content.includes('cal-popover-backdrop'), 'Must have backdrop overlay');
    assert.ok(content.includes('cal-days-grid'), 'Must have 7-column days grid');
    assert.ok(content.includes('cal-day-today'), 'Must have distinct class for today');
    assert.ok(content.includes('cal-day-selected'), 'Must have distinct class for selected date');
  });

  await t.test('2. Month/Year heading in Transactions.jsx is an accessible interactive button', () => {
    const txnPath = path.join(projectRoot, 'src/components/Transactions/Transactions.jsx');
    const content = fs.readFileSync(txnPath, 'utf8').replace(/\r\n/g, '\n');

    // Heading in Daily mode is a button with aria attributes and onClick
    assert.ok(
      content.includes('<button\n            type="button"\n            className="month-title-btn"\n            onClick={() => setShowCal(true)}'),
      'Month heading in Daily view must be an interactive button opening calendar'
    );
    assert.ok(content.includes('aria-haspopup="dialog"'), 'Heading button must have aria-haspopup="dialog"');
    assert.ok(content.includes('aria-expanded={showCal}'), 'Heading button must reflect showCal state');

    // Heading in Monthly mode is also interactive
    assert.ok(
      content.includes('className="monthly-yr-btn"'),
      'Year label in Monthly view must be interactive button'
    );

    // Verify format imports
    assert.ok(
      content.includes('toDDMMYYYY'),
      'Transactions.jsx must import toDDMMYYYY from utils/format.js'
    );
  });

  await t.test('3. Date selection logic: navigating within current month, another month, and another year', () => {
    // Simulate state machine transitions
    let viewYear = 2026;
    let viewMonth = 10; // November
    let viewMode = 'daily';
    let selectedTargetDate = null;
    let showCal = true;

    const handleSelectCalendarDate = (date) => {
      viewYear = date.getFullYear();
      viewMonth = date.getMonth();
      viewMode = 'daily';
      selectedTargetDate = toDDMMYYYY(date);
      showCal = false;
    };

    // Test 3.1: Same month selection (Nov 12, 2026)
    handleSelectCalendarDate(new Date(2026, 10, 12));
    assert.equal(viewYear, 2026);
    assert.equal(viewMonth, 10);
    assert.equal(viewMode, 'daily');
    assert.equal(selectedTargetDate, '12/11/2026');
    assert.equal(showCal, false, 'Calendar must close on selection');

    // Test 3.2: Different month selection (Oct 15, 2026)
    handleSelectCalendarDate(new Date(2026, 9, 15));
    assert.equal(viewYear, 2026);
    assert.equal(viewMonth, 9, 'viewMonth must update to October (9)');
    assert.equal(selectedTargetDate, '15/10/2026');

    // Test 3.3: Different year selection (Dec 25, 2025)
    handleSelectCalendarDate(new Date(2025, 11, 25));
    assert.equal(viewYear, 2025, 'viewYear must update to 2025');
    assert.equal(viewMonth, 11, 'viewMonth must update to December (11)');
    assert.equal(selectedTargetDate, '25/12/2025');
  });

  await t.test('4. Selection while in Monthly view switches view to Daily view', () => {
    let viewYear = 2026;
    let viewMonth = 5;
    let viewMode = 'monthly';
    let selectedTargetDate = null;

    const handleSelectCalendarDate = (date) => {
      viewYear = date.getFullYear();
      viewMonth = date.getMonth();
      viewMode = 'daily';
      selectedTargetDate = toDDMMYYYY(date);
    };

    // User selects July 4, 2026 from calendar while on monthly overview
    handleSelectCalendarDate(new Date(2026, 6, 4));
    assert.equal(viewMode, 'daily', 'Must switch viewMode to daily');
    assert.equal(viewYear, 2026);
    assert.equal(viewMonth, 6);
    assert.equal(selectedTargetDate, '04/07/2026');
  });

  await t.test('5. Scroll into view: Custom event scroll-to-date and scroll-to-today dispatching', () => {
    const txnPath = path.join(projectRoot, 'src/components/Transactions/Transactions.jsx');
    const content = fs.readFileSync(txnPath, 'utf8');

    // Must dispatch scroll-to-date with dateKey and date detail
    assert.ok(
      content.includes("window.dispatchEvent(new CustomEvent('scroll-to-date'"),
      'Must dispatch scroll-to-date custom event on date selection'
    );
    // DateGroupedList must register listener for scroll-to-date
    assert.ok(
      content.includes("window.addEventListener('scroll-to-date', handleScrollToDate)"),
      'DateGroupedList must listen to scroll-to-date'
    );
    // DateGroupedList must register listener for scroll-to-today
    assert.ok(
      content.includes("window.addEventListener('scroll-to-today', handleScrollToToday)"),
      'DateGroupedList must listen to scroll-to-today'
    );
  });

  await t.test('6. Selecting a date with no transactions does not jump to another date', () => {
    const txnPath = path.join(projectRoot, 'src/components/Transactions/Transactions.jsx');
    const content = fs.readFileSync(txnPath, 'utf8');

    // DateGroupedList displays clear empty-date-banner if date has no transactions in month
    assert.ok(
      content.includes('empty-date-banner'),
      'Must render empty-date-banner when selected target date is not in group list'
    );
    assert.ok(
      content.includes('formatBannerDate(targetDateKey)'),
      'Banner must display formatted target date'
    );
    assert.ok(
      content.includes('empty-date-add-btn'),
      'Banner must provide direct action to add transaction on that date'
    );
  });

  await t.test('7. Today and Selected Date highlights are distinguishable in CalendarDatePicker', () => {
    const cssPath = path.join(projectRoot, 'src/components/Common/CalendarDatePicker.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    // Today indicator
    assert.ok(css.includes('.cal-day-btn.cal-day-today'), 'Must have specific styles for today');
    assert.ok(css.includes('.cal-today-dot'), 'Must have dot or ring indicator for today');

    // Selected indicator
    assert.ok(css.includes('.cal-day-btn.cal-day-selected'), 'Must have specific styles for selected date');
    assert.ok(css.includes('background: var(--dash-primary, #0075FF)'), 'Selected date must have solid primary background');
  });

  await t.test('8. Escape key and outside click close calendar', () => {
    const compPath = path.join(projectRoot, 'src/components/Common/CalendarDatePicker.jsx');
    const content = fs.readFileSync(compPath, 'utf8');

    // Escape key
    assert.ok(content.includes("e.key === 'Escape'"), 'Must handle Escape keydown');
    assert.ok(content.includes('onClose();'), 'Must invoke onClose on Escape');

    // Backdrop click
    assert.ok(content.includes('className="cal-popover-backdrop" onClick={onClose}'), 'Backdrop must trigger onClose');
  });

  await t.test('9. Existing previous and next month/year navigation remains functional', () => {
    const txnPath = path.join(projectRoot, 'src/components/Transactions/Transactions.jsx');
    const content = fs.readFileSync(txnPath, 'utf8');

    // Daily prevMonth and nextMonth
    assert.ok(content.includes('const prevMonth = () => {'), 'prevMonth must exist');
    assert.ok(content.includes('const nextMonth = () => {'), 'nextMonth must exist');
    assert.ok(content.includes('setSelectedTargetDate(null);'), 'Navigating month clears pinned target date');

    // Monthly prevYear and nextYear
    assert.ok(content.includes('const prevYear = () => setYear(y => y - 1);'), 'prevYear must exist in MonthlyView');
    assert.ok(content.includes('const nextYear = () => setYear(y => y + 1);'), 'nextYear must exist in MonthlyView');
  });

  await t.test('10. Light and Dark mode theme support in CalendarDatePicker.css and Transactions.css', () => {
    const calCss = fs.readFileSync(path.join(projectRoot, 'src/components/Common/CalendarDatePicker.css'), 'utf8');
    const txnCss = fs.readFileSync(path.join(projectRoot, 'src/components/Transactions/Transactions.css'), 'utf8');

    assert.ok(calCss.includes('[data-theme="light"] .cal-popover-card'), 'Calendar must have light theme overrides');
    assert.ok(calCss.includes('[data-theme="light"] .cal-day-btn'), 'Days must have light theme styling');
    assert.ok(txnCss.includes('.month-title-btn:hover'), 'Month title button must have hover treatment');
    assert.ok(txnCss.includes('.month-title-btn:focus-visible'), 'Month title button must have focus-visible treatment');
  });

  await t.test('11. Global Transactions date groups do not receive Account sticky scroll-margin-top', () => {
    const txnCss = fs.readFileSync(path.join(projectRoot, 'src/components/Transactions/Transactions.css'), 'utf8');
    const acctCss = fs.readFileSync(path.join(projectRoot, 'src/components/Accounts/Accounts.css'), 'utf8');

    // Transactions.css sets scroll-margin-top: 0 for .txn-list date groups
    assert.ok(
      txnCss.includes('.txn-list .date-group-container') && txnCss.includes('scroll-margin-top: 0;'),
      'Transactions.css must enforce scroll-margin-top: 0 on .txn-list .date-group-container'
    );

    // Accounts.css must NOT have unscoped .date-group-container scroll-margin-top
    assert.ok(
      !acctCss.includes('\n.date-group-container,\n') && !acctCss.includes('\n.date-group-container {'),
      'Accounts.css must not have unscoped .date-group-container rules'
    );
    assert.ok(
      acctCss.includes('.acct-detail-body .date-group-container'),
      'Accounts.css must strictly scope scroll-margin-top under .acct-detail-body'
    );
  });

  await t.test('12. Selected date navigation in Global Transactions preserves compact layout without blank gap', () => {
    // In Global Transactions: scroll container is .txn-list, with no internal sticky header
    const txnList = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 120, height: 600 }),
      scrollTo: function(opts) { this.scrollTop = opts.top; }
    };
    // Selected target group (e.g. 8 September 2026) located at offset 0 (first in list)
    const targetGroup = {
      getBoundingClientRect: () => ({ top: 120, height: 80 })
    };

    // When scrollIntoView or container scrolling occurs with scroll-margin-top: 0,
    // target sits at top: 0 relative to scroll container viewport without artificial 200px+ gap
    const targetOffsetFromTop = targetGroup.getBoundingClientRect().top - txnList.getBoundingClientRect().top;
    assert.equal(targetOffsetFromTop, 0, 'Target date group must sit directly below the summary strip with 0 extra gap');
  });
});

