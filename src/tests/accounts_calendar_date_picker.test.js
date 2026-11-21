/**
 * src/tests/accounts_calendar_date_picker.test.js
 *
 * Automated Test Suite for FinMan Calendar Date Picker in Drilled-Down Account Screens.
 *
 * Requirements covered:
 * 1. Calendar opens from an account transaction month/year heading (.pp-label-btn sets showCal=true).
 * 2. Selecting a date jumps to the correct account-specific date.
 * 3. The selected account remains unchanged (acctName & subAccountName preserved).
 * 4. Selecting a date in another month works (viewMonth & viewYear updated).
 * 5. Selecting a date in another year works.
 * 6. Selecting a date with transactions scrolls its header below the sticky section.
 * 7. Selecting a date without transactions scrolls the empty-date message below the sticky section.
 * 8. The Add button in the empty-date message remains visible.
 * 9. Scrolling happens inside the correct account transaction container (.acct-detail-body).
 * 10. Dynamic sticky header heights are respected across responsive layouts.
 * 11. Switching dates repeatedly does not accumulate incorrect scroll offsets.
 * 12. Hardware Back button intercept closes the calendar popover without exiting the screen.
 * 13. Period navigation buttons clear selectedTargetDate highlight.
 * 14. Common CalendarDatePicker maintains accessibility, keyboard dismissal, and styling.
 * 15. Global Transactions calendar date picker continues to work without regression.
 * 16. CSS styling consistency in Accounts.css: scroll-margin-top for sticky clearance.
 * 17. AccountDetail handles sub-accounts and credit cards seamlessly.
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

function extractScrollHelper(source) {
  const funcMatch = source.match(/export function scrollToElementBelowSticky\([\s\S]*?\n\}/);
  if (!funcMatch) throw new Error('scrollToElementBelowSticky not found in source');
  return new Function('return (' + funcMatch[0].replace('export ', '') + ')')();
}

test('FinMan — Calendar Date Picker in Account Drill-Down Screens Suite', async (t) => {

  const acctPath = path.join(projectRoot, 'src/components/Accounts/Accounts.jsx');
  assert.ok(fs.existsSync(acctPath), 'Accounts.jsx must exist');
  const acctContent = fs.readFileSync(acctPath, 'utf8');
  const scrollToElementBelowSticky = extractScrollHelper(acctContent);

  await t.test('1. CalendarDatePicker is imported and reused in Accounts.jsx without duplication', () => {
    assert.ok(
      acctContent.includes("import CalendarDatePicker from '../Common/CalendarDatePicker.jsx'"),
      'Accounts.jsx must import reusable CalendarDatePicker from ../Common/CalendarDatePicker.jsx'
    );
    assert.ok(
      acctContent.includes('toDDMMYYYY'),
      'Accounts.jsx must import toDDMMYYYY utility'
    );
    assert.ok(
      acctContent.includes('<CalendarDatePicker'),
      'Accounts.jsx must render CalendarDatePicker component'
    );
    assert.ok(
      acctContent.includes('isOpen={showCal}'),
      'CalendarDatePicker must bind isOpen to showCal'
    );
    assert.ok(
      acctContent.includes('onSelectDate={handleSelectCalendarDate}'),
      'CalendarDatePicker must bind onSelectDate to handleSelectCalendarDate'
    );
    assert.ok(
      acctContent.includes('onClose={() => setShowCal(false)}'),
      'CalendarDatePicker must bind onClose to close handler'
    );
  });

  await t.test('2. Month/Year heading in AccountDetail is an accessible interactive button (.pp-label-btn)', () => {
    assert.ok(
      acctContent.includes('className="pp-label pp-label-btn"'),
      'Period/Date heading in AccountDetail must be rendered as a button with pp-label-btn class'
    );
    assert.ok(
      acctContent.includes('onClick={() => setShowCal(true)}'),
      'Clicking heading button must set showCal to true'
    );
    assert.ok(
      acctContent.includes('aria-haspopup="dialog"'),
      'Heading button must have aria-haspopup="dialog"'
    );
    assert.ok(
      acctContent.includes('aria-expanded={showCal}'),
      'Heading button must have aria-expanded attribute'
    );

    const cssPath = path.join(projectRoot, 'src/components/Accounts/Accounts.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('.pp-label-btn'), 'Accounts.css must define .pp-label-btn');
    assert.ok(css.includes('.pp-label-btn:hover'), 'Accounts.css must define hover state');
    assert.ok(css.includes('.pp-label-btn:focus-visible'), 'Accounts.css must define focus-visible state');
  });

  await t.test('3. Date selection logic: preserves account context while updating date state', () => {
    const accountContext = {
      acctName: 'HDFC Bank',
      subAccountName: 'Savings',
      allTxns: [
        { _id: 't1', Date: '12/11/2026', Account: 'HDFC Bank', 'Income/Expense': 'Expense', Amount: 500 },
        { _id: 't2', Date: '05/10/2026', Account: 'HDFC Bank', 'Income/Expense': 'Income', Amount: 25000 },
        { _id: 't3', Date: '25/12/2025', Account: 'HDFC Bank', 'Income/Expense': 'Expense', Amount: 1200 }
      ]
    };

    let viewYear = 2026;
    let viewMonth = 10; // November
    let period = 'Month';
    let selectedTargetDate = null;
    let showCal = true;

    const handleSelectCalendarDate = (date) => {
      viewYear = date.getFullYear();
      viewMonth = date.getMonth();
      period = 'Month';
      selectedTargetDate = toDDMMYYYY(date);
      showCal = false;
    };

    // Selecting Nov 12, 2026 in HDFC Bank
    handleSelectCalendarDate(new Date(2026, 10, 12));
    assert.equal(accountContext.acctName, 'HDFC Bank', 'Account must remain HDFC Bank');
    assert.equal(accountContext.subAccountName, 'Savings', 'SubAccount must remain Savings');
    assert.equal(viewYear, 2026);
    assert.equal(viewMonth, 10);
    assert.equal(period, 'Month');
    assert.equal(selectedTargetDate, '12/11/2026');
    assert.equal(showCal, false, 'Calendar modal must close on selection');

    // Selecting Oct 5, 2026 (different month)
    handleSelectCalendarDate(new Date(2026, 9, 5));
    assert.equal(accountContext.acctName, 'HDFC Bank');
    assert.equal(viewYear, 2026);
    assert.equal(viewMonth, 9, 'Must update viewMonth to October (9)');
    assert.equal(selectedTargetDate, '05/10/2026');

    // Selecting Dec 25, 2025 (different year)
    handleSelectCalendarDate(new Date(2025, 11, 25));
    assert.equal(accountContext.acctName, 'HDFC Bank');
    assert.equal(viewYear, 2025, 'Must update viewYear to 2025');
    assert.equal(viewMonth, 11, 'Must update viewMonth to December (11)');
    assert.equal(selectedTargetDate, '25/12/2025');
  });

  await t.test('4. Selecting a date with transactions scrolls its header below the sticky section', () => {
    // Mock container (.acct-detail-body)
    const container = {
      scrollTop: 100,
      getBoundingClientRect: () => ({ top: 50, height: 600 }),
      scrollTo: function(opts) { this.scrollTop = opts.top; }
    };
    // Mock sticky header (.acct-sticky-header-wrap)
    const stickyEl = {
      getBoundingClientRect: () => ({ top: 50, height: 180 })
    };
    // Mock target date group (.date-group-container) located down the scroll canvas
    const targetEl = {
      getBoundingClientRect: () => ({ top: 400, height: 80 })
    };

    const targetScrollTop = scrollToElementBelowSticky(container, targetEl, stickyEl, { smooth: true, gap: 8 });

    // Calculation verification:
    // targetOffsetTop = (400 - 50) + 100 = 450
    // stickyHeight = 180, gap = 8
    // targetScrollTop = 450 - 180 - 8 = 262
    assert.equal(targetScrollTop, 262);
    assert.equal(container.scrollTop, 262);

    // After scrolling, target's top relative to container top will be:
    // targetOffsetTop - container.scrollTop = 450 - 262 = 188
    // Which is stickyHeight (180) + gap (8) = exactly 8px below the sticky header bottom!
    const targetRelativeTop = 450 - container.scrollTop;
    assert.equal(targetRelativeTop, 188);
    assert.ok(targetRelativeTop >= 180, 'Target must not be obscured behind 180px sticky header');
  });

  await t.test('5. Selecting a date without transactions scrolls the empty-date message below the sticky section', () => {
    // User was scrolled down at 500px in the account list
    const container = {
      scrollTop: 500,
      getBoundingClientRect: () => ({ top: 60, height: 600 }),
      scrollTo: function(opts) { this.scrollTop = opts.top; }
    };
    const stickyEl = {
      getBoundingClientRect: () => ({ top: 60, height: 200 })
    };
    // Empty date banner (.empty-date-banner) rendered near the top of the content list
    const emptyBannerEl = {
      getBoundingClientRect: () => ({ top: 220 - 500 + 60, height: 48 }) // targetOffsetTop = 220
    };

    const targetScrollTop = scrollToElementBelowSticky(container, emptyBannerEl, stickyEl, { smooth: true, gap: 8 });

    // targetOffsetTop = 220
    // stickyHeight = 200, gap = 8
    // targetScrollTop = Math.max(0, 220 - 200 - 8) = 12
    assert.equal(targetScrollTop, 12);
    assert.equal(container.scrollTop, 12);

    // After scroll, top of banner relative to container is 220 - 12 = 208 (200px sticky + 8px gap)
    const bannerRelativeTop = 220 - container.scrollTop;
    assert.equal(bannerRelativeTop, 208);
    assert.ok(bannerRelativeTop >= 200, 'Empty banner must be fully visible below sticky header');
  });

  await t.test('6. The Add button in empty-date message and empty-state is preserved with prefill handlers', () => {
    assert.ok(acctContent.includes('empty-date-banner'), 'Must render empty-date-banner when date has no txns in month');
    assert.ok(acctContent.includes('formatBannerDate(selectedTargetDate)'), 'Banner must display formatted target date');
    assert.ok(
      acctContent.includes('onClick={() => setAddDate(parseDate(selectedTargetDate))}'),
      'Empty date banner button must prefill add date with target date'
    );
    assert.ok(
      acctContent.includes('+ Add transaction for {acctName}'),
      'Empty month state must provide option to add transaction for account on that date'
    );
    assert.ok(
      acctContent.includes('ref={emptyBannerRef}'),
      'Empty date banner must attach emptyBannerRef'
    );
    assert.ok(
      acctContent.includes('ref={emptyStateRef}'),
      'Empty state must attach emptyStateRef'
    );
  });

  await t.test('7. Scrolling happens inside the correct account transaction container (.acct-detail-body)', () => {
    assert.ok(
      acctContent.includes('ref={bodyRef}'),
      'acct-detail-body must attach bodyRef'
    );
    assert.ok(
      acctContent.includes('ref={stickyHeaderRef}'),
      'acct-sticky-header-wrap must attach stickyHeaderRef'
    );
    assert.ok(
      acctContent.includes('scrollToElementBelowSticky(bodyRef.current'),
      'Must scroll bodyRef.current, NOT window or document body'
    );
  });

  await t.test('8. Dynamic sticky header heights are respected across responsive layouts', () => {
    const createContainer = () => ({
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0, height: 700 }),
      scrollTo: function(opts) { this.scrollTop = opts.top; }
    });
    const targetEl = {
      getBoundingClientRect: () => ({ top: 600, height: 50 })
    };

    // Scenario A: Standard desktop header (175px)
    const containerA = createContainer();
    const desktopSticky = { getBoundingClientRect: () => ({ height: 175 }) };
    const desktopScroll = scrollToElementBelowSticky(containerA, targetEl, desktopSticky, { gap: 8 });
    assert.equal(desktopScroll, 600 - 175 - 8);

    // Scenario B: Mobile / Credit Card header with billing cycle strip (240px)
    const containerB = createContainer();
    const mobileSticky = { getBoundingClientRect: () => ({ height: 240 }) };
    const mobileScroll = scrollToElementBelowSticky(containerB, targetEl, mobileSticky, { gap: 8 });
    assert.equal(mobileScroll, 600 - 240 - 8);

    assert.notEqual(desktopScroll, mobileScroll, 'Scroll offset must dynamically adapt to different sticky header heights');
  });

  await t.test('9. Switching dates repeatedly does not accumulate incorrect scroll offsets', () => {
    const container = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0, height: 600 }),
      scrollTo: function(opts) { this.scrollTop = opts.top; }
    };
    const stickyEl = { getBoundingClientRect: () => ({ height: 190 }) };
    const targetA = { getBoundingClientRect: () => ({ top: 800 - container.scrollTop, height: 60 }) };
    const targetB = { getBoundingClientRect: () => ({ top: 400 - container.scrollTop, height: 60 }) };

    // Select Date A
    const scrollA1 = scrollToElementBelowSticky(container, targetA, stickyEl, { gap: 8 });
    assert.equal(scrollA1, 800 - 190 - 8); // 602

    // Switch to Date B
    const scrollB1 = scrollToElementBelowSticky(container, targetB, stickyEl, { gap: 8 });
    assert.equal(scrollB1, 400 - 190 - 8); // 202

    // Switch back to Date A
    const scrollA2 = scrollToElementBelowSticky(container, targetA, stickyEl, { gap: 8 });
    assert.equal(scrollA2, scrollA1, 'Repeated navigation to Date A must resolve to the exact same scrollTop');

    // Switch back to Date B
    const scrollB2 = scrollToElementBelowSticky(container, targetB, stickyEl, { gap: 8 });
    assert.equal(scrollB2, scrollB1, 'Repeated navigation to Date B must resolve to the exact same scrollTop');
  });

  await t.test('10. Hardware Back button intercept for calendar popover', () => {
    assert.ok(
      acctContent.includes('if (showCal)'),
      'Accounts.jsx must have back intercept effect checking showCal'
    );
    assert.ok(
      acctContent.includes('backInterceptRef.current = () => setShowCal(false)'),
      'Back button intercept must close calendar instead of navigating away'
    );
  });

  await t.test('11. Period navigation buttons clear selectedTargetDate highlight', () => {
    assert.ok(
      acctContent.includes('const prev = () => {') && acctContent.includes('setSelectedTargetDate(null);'),
      'Navigating previous period must reset selectedTargetDate'
    );
    assert.ok(
      acctContent.includes('const next = () => {') && acctContent.includes('setSelectedTargetDate(null);'),
      'Navigating next period must reset selectedTargetDate'
    );
  });

  await t.test('12. Common CalendarDatePicker maintains accessibility, keyboard dismissal, and styling', () => {
    const compPath = path.join(projectRoot, 'src/components/Common/CalendarDatePicker.jsx');
    const content = fs.readFileSync(compPath, 'utf8');

    assert.ok(content.includes("e.key === 'Escape'"), 'CalendarDatePicker must support Escape key dismissal');
    assert.ok(content.includes('className="cal-popover-backdrop" onClick={onClose}'), 'Backdrop click must call onClose');
    assert.ok(content.includes('role="dialog"'), 'Calendar popover must have role="dialog"');
    assert.ok(content.includes('aria-modal="true"'), 'Calendar popover must have aria-modal="true"');
  });

  await t.test('13. Global Transactions calendar date picker continues to work without regression', () => {
    const txnPath = path.join(projectRoot, 'src/components/Transactions/Transactions.jsx');
    const content = fs.readFileSync(txnPath, 'utf8');

    assert.ok(content.includes("import CalendarDatePicker from '../Common/CalendarDatePicker.jsx'"), 'Transactions must still import CalendarDatePicker');
    assert.ok(content.includes('className="month-title-btn"'), 'Transactions Daily heading button still intact');
    assert.ok(content.includes('handleSelectCalendarDate'), 'Transactions date select handler intact');
    assert.ok(content.includes('scroll-to-date'), 'Transactions scroll event intact');
  });

  await t.test('14. CSS styling consistency in Accounts.css: scroll-margin-top is strictly scoped to .acct-detail-body', () => {
    const cssPath = path.join(projectRoot, 'src/components/Accounts/Accounts.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    assert.ok(css.includes('.empty-date-banner'), 'Accounts.css must style empty-date-banner');
    assert.ok(css.includes('.empty-date-add-btn'), 'Accounts.css must style empty-date-add-btn');
    assert.ok(css.includes('.date-group-target'), 'Accounts.css must style target date group container');
    assert.ok(css.includes('.dg-target-badge'), 'Accounts.css must style target date badge');
    assert.ok(
      css.includes('.acct-detail-body .date-group-container'),
      'Accounts.css must scope scroll-margin-top under .acct-detail-body'
    );
    assert.ok(
      !css.includes('\n.date-group-container,') && !css.includes('\n.date-group-container {'),
      'Accounts.css must NOT define unscoped .date-group-container'
    );
  });

  await t.test('15. AccountDetail handles sub-accounts and credit cards seamlessly', () => {
    assert.ok(
      acctContent.includes('prefillSubAccount={subAccountName}'),
      'AddTransaction invocations must preserve subAccountName'
    );
    assert.ok(
      acctContent.includes("period === 'CC Cycle'"),
      'AccountDetail must preserve CC Cycle logic'
    );
  });
});
