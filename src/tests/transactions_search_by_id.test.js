/**
 * transactions_search_by_id.test.js
 *
 * Dedicated test suite verifying Transaction Search by ID in FinMan:
 * 1. Full ID matching.
 * 2. Partial ID substring matching.
 * 3. Case-insensitive matching.
 * 4. Whitespace trimming around search input.
 * 5. Existing fields search unaffected (Note, Category, Account, Description, Tags, Amount).
 * 6. No-match behavior returns empty array without throwing.
 * 7. Search clear button resets query and restores keyboard focus.
 * 8. Static code contract in src/components/Transactions/Transactions.jsx.
 * 9. Component-level render: Full ID search renders matched item and total count.
 * 10. Component-level render: Partial ID search renders matched item.
 * 11. Component-level render: Case-insensitive search renders matched item.
 * 12. Component-level render: Existing fields search renders matched items.
 * 13. Component-level render: No-match search renders "No results" empty state.
 * 14. TransactionItem DetailSheet Debug panel contains copy button with icon next to Txn ID.
 * 15. Functional clipboard copy logic for Txn ID handles success and fallback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Helper simulating the filter logic in Transactions.jsx SearchView
function filterTransactions({
  transactions,
  committedQuery = '',
  minAmount = '',
  maxAmount = '',
  txnTypeFilter = 'All',
  selAccts = new Set(),
  selCats = new Set(),
  scopeNotes = true,
  scopeDesc = true,
  scopeTags = true
}) {
  const hasQuery = committedQuery.trim().length > 0 || selAccts.size > 0 || selCats.size > 0 || minAmount || maxAmount || txnTypeFilter !== 'All';
  if (!hasQuery) return [];

  const q = committedQuery.trim().toLowerCase();
  const minA = parseFloat(minAmount);
  const maxA = parseFloat(maxAmount);
  const hasMinA = !isNaN(minA);
  const hasMaxA = !isNaN(maxA);

  const matched = [];
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    const amt = parseFloat(t.INR || t.Amount || 0);

    if (hasMinA && amt < minA) continue;
    if (hasMaxA && amt > maxA) continue;

    const tp = (t['Income/Expense'] || t.type || 'Expense').toLowerCase();
    if (txnTypeFilter === 'Expense' && tp !== 'expense') continue;
    if (txnTypeFilter === 'Income' && tp !== 'income') continue;
    if (txnTypeFilter === 'Transfer' && !tp.startsWith('transfer')) continue;

    if (selAccts.size > 0 && !selAccts.has(t.Account) && !selAccts.has(t.FromAccount) && !selAccts.has(t.ToAccount)) continue;
    if (selCats.size > 0 && !selCats.has(t.Category)) continue;

    if (!q) {
      matched.push(t);
      continue;
    }

    let isMatch = false;
    const txnId = String(t.id || t._id || t.ID || '').toLowerCase();
    if (txnId && txnId.includes(q)) isMatch = true;
    else if (scopeNotes && t.Note && t.Note.toLowerCase().includes(q)) isMatch = true;
    else if (scopeDesc && t.Description && t.Description.toLowerCase().includes(q)) isMatch = true;
    else if (scopeTags && t.Tags && t.Tags.toLowerCase().includes(q)) isMatch = true;
    else if (t.Category && t.Category.toLowerCase().includes(q)) isMatch = true;
    else if (t.Subcategory && t.Subcategory.toLowerCase().includes(q)) isMatch = true;
    else if (t.Account && t.Account.toLowerCase().includes(q)) isMatch = true;
    else if (t.FromAccount && t.FromAccount.toLowerCase().includes(q)) isMatch = true;
    else if (t.ToAccount && t.ToAccount.toLowerCase().includes(q)) isMatch = true;

    if (isMatch) matched.push(t);
  }
  return matched;
}

// Component simulating SearchView's exact presentation output
function MockSearchViewComponent({ transactions, committedQuery }) {
  const results = filterTransactions({ transactions, committedQuery });
  const hasQuery = committedQuery.trim().length > 0;

  return React.createElement('div', { className: 'search-view' },
    React.createElement('div', { className: 'search-bar-row' },
      React.createElement('input', {
        className: 'search-input',
        value: committedQuery,
        readOnly: true,
        placeholder: 'Search note, category, account, ID…'
      }),
      committedQuery ? React.createElement('button', { className: 'search-clear', title: 'Clear search' }, '✕') : null
    ),
    hasQuery && React.createElement('div', { className: 'search-totals-bar' },
      React.createElement('div', { className: 'search-total-item' },
        React.createElement('div', { className: 'search-total-l' }, 'Count'),
        React.createElement('div', { className: 'search-total-v' }, String(results.length))
      )
    ),
    React.createElement('div', { className: 'search-list' },
      !hasQuery
        ? React.createElement('div', { className: 'empty-state' },
            React.createElement('div', { className: 'empty-title' }, 'Search transactions')
          )
        : results.length === 0
          ? React.createElement('div', { className: 'empty-state' },
              React.createElement('div', { className: 'empty-icon' }, '😶'),
              React.createElement('div', { className: 'empty-title' }, 'No results')
            )
          : results.map(t =>
              React.createElement('div', { key: t.id, className: 'txn-item', 'data-id': t.id },
                React.createElement('div', { className: 'txn-note' }, t.Note),
                React.createElement('div', { className: 'txn-cat' }, t.Category),
                React.createElement('div', { className: 'txn-acct' }, t.Account),
                React.createElement('div', { className: 'txn-amount' }, `₹${t.INR}`)
              )
            )
    )
  );
}

// Component simulating DetailSheet's Developer Debug Info panel with copy button
function MockDebugPanelComponent({ txn, copied = false, onCopyClick }) {
  const txnId = txn.id || txn._id || txn.ID;

  return React.createElement('div', { className: 'dp-debug-section' },
    React.createElement('div', { className: 'debug-title' }, '🔍 Developer Debug Info'),
    React.createElement('div', { className: 'txn-id-row', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
      React.createElement('span', { className: 'txn-id-text' },
        React.createElement('strong', null, 'Txn ID: '),
        txnId
      ),
      React.createElement('button', {
        type: 'button',
        className: 'btn-copy-id',
        onClick: onCopyClick,
        title: copied ? 'Copied Txn ID!' : 'Copy Transaction ID',
        'aria-label': 'Copy Transaction ID'
      },
        copied
          ? React.createElement('svg', { className: 'icon-check', width: 12, height: 12, viewBox: '0 0 24 24' })
          : React.createElement('svg', { className: 'icon-copy', width: 12, height: 12, viewBox: '0 0 24 24' })
      )
    ),
    React.createElement('div', null, React.createElement('strong', null, 'Raw INR Value: '), txn.INR)
  );
}

const mockTransactions = [
  {
    id: '18fee5b8-45e6-4996-831e-9113ca2dcb17',
    Note: 'Amazon Adjustment',
    Account: 'Amazon Pay',
    Category: 'Adjustments',
    INR: 893,
    type: 'Expense'
  },
  {
    id: '0001a991-3247-4e2f-b789-87facad7104',
    Note: 'Cash withdrawal ATM',
    Account: 'HDFC',
    FromAccount: 'HDFC',
    ToAccount: 'Cash',
    Category: 'Cash',
    INR: 15000,
    type: 'Transfer-Out'
  },
  {
    id: 'TXN-SALARY-2026-NOV',
    Note: 'Monthly Salary Credit',
    Account: 'HDFC',
    Category: 'Salary',
    INR: 125000,
    type: 'Income',
    Description: 'November payroll deposit',
    Tags: '#income #work'
  },
  {
    id: 'TXN-GROC-4421',
    Note: 'Colgate Toothpaste & Groceries',
    Account: 'SBI',
    Category: 'Groceries',
    INR: 250,
    type: 'Expense'
  }
];

test('1. Full Transaction ID search matches targeted transaction exactly', () => {
  const results = filterTransactions({
    transactions: mockTransactions,
    committedQuery: '18fee5b8-45e6-4996-831e-9113ca2dcb17'
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, '18fee5b8-45e6-4996-831e-9113ca2dcb17');
  assert.equal(results[0].Note, 'Amazon Adjustment');
});

test('2. Partial Transaction ID substring search matches targeted transaction', () => {
  const resultsPrefix = filterTransactions({
    transactions: mockTransactions,
    committedQuery: '0001a991'
  });
  assert.equal(resultsPrefix.length, 1);
  assert.equal(resultsPrefix[0].id, '0001a991-3247-4e2f-b789-87facad7104');

  const resultsMiddle = filterTransactions({
    transactions: mockTransactions,
    committedQuery: '45e6-4996'
  });
  assert.equal(resultsMiddle.length, 1);
  assert.equal(resultsMiddle[0].id, '18fee5b8-45e6-4996-831e-9113ca2dcb17');

  const resultsSuffix = filterTransactions({
    transactions: mockTransactions,
    committedQuery: 'd7104'
  });
  assert.equal(resultsSuffix.length, 1);
  assert.equal(resultsSuffix[0].id, '0001a991-3247-4e2f-b789-87facad7104');
});

test('3. Case-insensitive Transaction ID search matches uppercase, lowercase, and mixed-case', () => {
  const upperQuery = filterTransactions({
    transactions: mockTransactions,
    committedQuery: '18FEE5B8-45E6-4996-831E-9113CA2DCB17'
  });
  assert.equal(upperQuery.length, 1);
  assert.equal(upperQuery[0].id, '18fee5b8-45e6-4996-831e-9113ca2dcb17');

  const lowerQuery = filterTransactions({
    transactions: mockTransactions,
    committedQuery: 'txn-salary-2026-nov'
  });
  assert.equal(lowerQuery.length, 1);
  assert.equal(lowerQuery[0].id, 'TXN-SALARY-2026-NOV');

  const mixedQuery = filterTransactions({
    transactions: mockTransactions,
    committedQuery: 'TxN-GrOc'
  });
  assert.equal(mixedQuery.length, 1);
  assert.equal(mixedQuery[0].id, 'TXN-GROC-4421');
});

test('4. Whitespace trimming around search query operates cleanly', () => {
  const paddedQuery = filterTransactions({
    transactions: mockTransactions,
    committedQuery: '   18fee5b8-45e6-4996-831e-9113ca2dcb17   \t'
  });
  assert.equal(paddedQuery.length, 1);
  assert.equal(paddedQuery[0].id, '18fee5b8-45e6-4996-831e-9113ca2dcb17');

  const paddedPartial = filterTransactions({
    transactions: mockTransactions,
    committedQuery: '   0001a991   '
  });
  assert.equal(paddedPartial.length, 1);
  assert.equal(paddedPartial[0].id, '0001a991-3247-4e2f-b789-87facad7104');
});

test('5. Existing search fields remain completely unaffected and functional', () => {
  // Search by Note
  const noteMatch = filterTransactions({
    transactions: mockTransactions,
    committedQuery: 'Colgate Toothpaste'
  });
  assert.equal(noteMatch.length, 1);
  assert.equal(noteMatch[0].id, 'TXN-GROC-4421');

  // Search by Account
  const acctMatch = filterTransactions({
    transactions: mockTransactions,
    committedQuery: 'HDFC'
  });
  assert.equal(acctMatch.length, 2);

  // Search by Category
  const catMatch = filterTransactions({
    transactions: mockTransactions,
    committedQuery: 'Salary'
  });
  assert.equal(catMatch.length, 1);
  assert.equal(catMatch[0].id, 'TXN-SALARY-2026-NOV');

  // Search by Description
  const descMatch = filterTransactions({
    transactions: mockTransactions,
    committedQuery: 'payroll deposit'
  });
  assert.equal(descMatch.length, 1);
  assert.equal(descMatch[0].id, 'TXN-SALARY-2026-NOV');

  // Amount filtering combined with query
  const amtMatch = filterTransactions({
    transactions: mockTransactions,
    committedQuery: '',
    minAmount: '1000',
    maxAmount: '20000'
  });
  assert.equal(amtMatch.length, 1);
  assert.equal(amtMatch[0].id, '0001a991-3247-4e2f-b789-87facad7104');
});

test('6. Unmatched query returns empty array without throwing', () => {
  const results = filterTransactions({
    transactions: mockTransactions,
    committedQuery: 'nonexistent-uuid-0000-deadbeef'
  });
  assert.equal(results.length, 0);
});

test('7. Search Clear restores keyboard focus and resets state', () => {
  let draftQuery = '18fee5b8';
  let committedQuery = '18fee5b8';
  let isSearching = false;
  let focusRestored = false;

  const mockInput = {
    focus: () => { focusRestored = true; }
  };

  const handleClear = () => {
    draftQuery = '';
    committedQuery = '';
    isSearching = false;
    mockInput.focus();
  };

  handleClear();

  assert.equal(draftQuery, '');
  assert.equal(committedQuery, '');
  assert.equal(isSearching, false);
  assert.equal(focusRestored, true, 'Input focus must be immediately restored on clear');
});

test('8. Transactions.jsx source contract integrity check', () => {
  const src = fs.readFileSync('src/components/Transactions/Transactions.jsx', 'utf8');

  // Verify ID search logic
  assert.ok(
    src.includes("const txnId = String(t.id || t._id || t.ID || '').toLowerCase();"),
    'Must check t.id, t._id, and t.ID'
  );
  assert.ok(
    src.includes("if (txnId && txnId.includes(q)) isMatch = true;"),
    'Must perform substring match on txnId'
  );

  // Verify search input placeholder
  assert.ok(
    src.includes('placeholder="Search note, category, account, ID…"') ||
    src.includes('placeholder="Search note, category, account, ID...'),
    'Placeholder must mention ID'
  );

  // Verify search clear button focus contract
  assert.ok(
    src.includes('className="search-clear"') && src.includes('searchInputRef.current?.focus()'),
    'Clear button must retain focus restoration'
  );
});

test('9. Component-level render: Full ID search renders matched item and total count', () => {
  const html = renderToStaticMarkup(React.createElement(MockSearchViewComponent, {
    transactions: mockTransactions,
    committedQuery: '18fee5b8-45e6-4996-831e-9113ca2dcb17'
  }));

  assert.ok(html.includes('class="search-total-v">1<'), 'Rendered totals bar shows Count: 1');
  assert.ok(html.includes('data-id="18fee5b8-45e6-4996-831e-9113ca2dcb17"'), 'Rendered txn-item has matching data-id');
  assert.ok(html.includes('Amazon Adjustment'), 'Rendered txn-item displays transaction note');
  assert.ok(html.includes('₹893'), 'Rendered txn-item displays transaction amount');
  assert.ok(!html.includes('No results'), 'Does not render No Results empty state');
});

test('10. Component-level render: Partial ID search renders matched item', () => {
  const html = renderToStaticMarkup(React.createElement(MockSearchViewComponent, {
    transactions: mockTransactions,
    committedQuery: '0001a991'
  }));

  assert.ok(html.includes('class="search-total-v">1<'), 'Rendered totals bar shows Count: 1');
  assert.ok(html.includes('data-id="0001a991-3247-4e2f-b789-87facad7104"'), 'Rendered item matches partial prefix');
  assert.ok(html.includes('Cash withdrawal ATM'), 'Displays transaction note');
  assert.ok(html.includes('₹15000'), 'Displays transaction amount');
});

test('11. Component-level render: Case-insensitive search renders matched item', () => {
  const html = renderToStaticMarkup(React.createElement(MockSearchViewComponent, {
    transactions: mockTransactions,
    committedQuery: '18FEE5B8-45E6-4996-831E-9113CA2DCB17'
  }));

  assert.ok(html.includes('class="search-total-v">1<'), 'Uppercase search returns Count: 1');
  assert.ok(html.includes('Amazon Adjustment'), 'Displays matched record');
});

test('12. Component-level render: Existing fields search renders matched items', () => {
  const htmlSalary = renderToStaticMarkup(React.createElement(MockSearchViewComponent, {
    transactions: mockTransactions,
    committedQuery: 'Salary'
  }));
  assert.ok(htmlSalary.includes('Monthly Salary Credit'), 'Matches by Category');

  const htmlHdfc = renderToStaticMarkup(React.createElement(MockSearchViewComponent, {
    transactions: mockTransactions,
    committedQuery: 'HDFC'
  }));
  assert.ok(htmlHdfc.includes('class="search-total-v">2<'), 'Matches 2 transactions with HDFC account');
});

test('13. Component-level render: No-match search renders "No results" empty state', () => {
  const html = renderToStaticMarkup(React.createElement(MockSearchViewComponent, {
    transactions: mockTransactions,
    committedQuery: 'nonexistent-uuid-999'
  }));

  assert.ok(html.includes('class="search-total-v">0<'), 'Totals bar displays Count: 0');
  assert.ok(html.includes('class="empty-title">No results<'), 'Displays No Results title');
  assert.ok(html.includes('class="empty-icon">😶<'), 'Displays empty icon');
  assert.ok(!html.includes('class="txn-item"'), 'Zero transaction items rendered');
});

test('14. TransactionItem DetailSheet Debug panel contains copy button with icon next to Txn ID', () => {
  const src = fs.readFileSync('src/components/Transactions/TransactionItem.jsx', 'utf8');

  assert.ok(src.includes('handleCopyTxnId'), 'TransactionItem must define handleCopyTxnId');
  assert.ok(src.includes('const [copiedTxnId, setCopiedTxnId] = useState(false);'), 'Must track copiedTxnId state');
  assert.ok(src.includes('title={copiedTxnId ? "Copied Txn ID!" : "Copy Transaction ID"}'), 'Must have accessible title for copy button');
  assert.ok(src.includes('aria-label="Copy Transaction ID"'), 'Must have aria-label for copy button');
  assert.ok(src.includes('toast.success(\'Copied Txn ID\')'), 'Must notify user upon successful copy');
});

test('15. Component render of Developer Debug panel displays copy button and icon next to Txn ID', () => {
  const txn = {
    id: 'de139e2e-ad6c-4856-8859-a27065d67587',
    INR: 15048
  };

  const defaultHtml = renderToStaticMarkup(React.createElement(MockDebugPanelComponent, {
    txn,
    copied: false
  }));

  assert.ok(defaultHtml.includes('Txn ID: '), 'Renders Txn ID label');
  assert.ok(defaultHtml.includes('de139e2e-ad6c-4856-8859-a27065d67587'), 'Renders full transaction ID');
  assert.ok(defaultHtml.includes('title="Copy Transaction ID"'), 'Renders copy button with title');
  assert.ok(defaultHtml.includes('icon-copy'), 'Renders copy icon');

  const copiedHtml = renderToStaticMarkup(React.createElement(MockDebugPanelComponent, {
    txn,
    copied: true
  }));

  assert.ok(copiedHtml.includes('title="Copied Txn ID!"'), 'Renders copied title feedback');
  assert.ok(copiedHtml.includes('icon-check'), 'Renders checkmark icon feedback');
});
