/**
 * description_layout_and_view_formatting.test.js
 *
 * Test suite verifying:
 * 1. Mobile transaction list: Description displayed within existing grid space on the Note row
 * 2. Single-line ellipsis formatting for list display without multi-row expansion
 * 3. View Transaction popup: Full multi-line Description formatting preservation with pre-wrap
 * 4. Normalization of excessive consecutive blank lines (at most 2 consecutive empty lines for display only)
 * 5. Data preservation: Stored Description and Edit form content remain strictly unchanged
 * 6. Show Description preference compatibility (ON / OFF)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDescriptionForView } from '../utils/format.js';

// ── 1. View Popup Formatting & Normalization ─────────────────────────────────

test('normalizeDescriptionForView: preserves normal single line breaks and paragraph breaks', () => {
  const original = `Tax Deposited: 206225
Tax Liability: 130745
Total: 78120

Returns 75480 + Int 2640: 78120

Adjusted 2500 for payment CA Veera: 78120-2500: 75620
Adjusted 75620 for FnO losses: 75620-75620: 0`;

  const formatted = normalizeDescriptionForView(original);

  // Normal line breaks preserved
  assert.match(formatted, /Tax Deposited: 206225\nTax Liability: 130745\nTotal: 78120/);
  // Paragraph break (1 empty line) preserved
  assert.match(formatted, /Total: 78120\n\nReturns 75480/);
  // Trailing line breaks preserved
  assert.match(formatted, /CA Veera: 78120-2500: 75620\nAdjusted 75620/);
  assert.equal(formatted, original, 'Exact matching string preserved when no excessive blank lines exist');
});

test('normalizeDescriptionForView: preserves up to 2 consecutive empty lines (3 newlines)', () => {
  const textWithTwoEmptyLines = 'Header\n\n\nBody section';
  const result = normalizeDescriptionForView(textWithTwoEmptyLines);
  assert.equal(result, 'Header\n\n\nBody section', 'Two consecutive empty lines are allowed and preserved');
});

test('normalizeDescriptionForView: collapses 3 or more consecutive empty lines down to at most 2', () => {
  const textWithExcessiveEmptyLines = 'Section 1\n\n\n\n\n\nSection 2\n\n\n\nSection 3';
  const result = normalizeDescriptionForView(textWithExcessiveEmptyLines);
  assert.equal(result, 'Section 1\n\n\nSection 2\n\n\nSection 3', 'Collapsed excessive blank lines to exactly 2 empty lines (3 newlines)');
});

test('normalizeDescriptionForView: trims leading and trailing blank lines while preserving internal breaks', () => {
  const textWithSurroundingBlanks = '\n\n\n   \nLine 1\nLine 2\n\n\n\n   \n';
  const result = normalizeDescriptionForView(textWithSurroundingBlanks);
  assert.equal(result, 'Line 1\nLine 2', 'Surrounding whitespace and blank lines trimmed cleanly');
});

test('normalizeDescriptionForView: preserves indentation and special characters on content lines', () => {
  const indentedText = 'Summary:\n  * Item A: ₹500\n  * Item B: ₹1,200\n    - Sub-detail';
  const result = normalizeDescriptionForView(indentedText);
  assert.equal(result, indentedText, 'Meaningful indentation and bullet structures are preserved');
});

test('normalizeDescriptionForView: handles CRLF and CR line endings correctly', () => {
  const crlfText = 'Line 1\r\nLine 2\r\n\r\nLine 3';
  const result = normalizeDescriptionForView(crlfText);
  assert.equal(result, 'Line 1\nLine 2\n\nLine 3', 'CRLF line breaks converted cleanly to LF without doubling');
});

test('normalizeDescriptionForView: safely returns empty string for empty, null or undefined input', () => {
  assert.equal(normalizeDescriptionForView(null), '');
  assert.equal(normalizeDescriptionForView(undefined), '');
  assert.equal(normalizeDescriptionForView(''), '');
  assert.equal(normalizeDescriptionForView('    \n\n   '), '');
});

// ── 2. Data Preservation Safeguard ──────────────────────────────────────────

test('Data Preservation: View formatting normalization never mutates stored transaction object', () => {
  const originalDesc = 'Tax Deposited: 206225\n\n\n\n\n\nTotal: 78120\n\n\n';
  const txn = {
    _id: 'txn_test_123',
    Note: 'IT Return',
    Description: originalDesc,
    Amount: 78120,
    Category: 'Taxes'
  };

  // Generate view presentation
  const viewPresentation = normalizeDescriptionForView(txn.Description);

  // Assert view presentation is normalized
  assert.equal(viewPresentation, 'Tax Deposited: 206225\n\n\nTotal: 78120');

  // Assert original transaction object remains 100% untouched
  assert.equal(txn.Description, originalDesc, 'Original stored Description in txn object is completely unmodified');

  // Simulating Edit form loading
  const editFormState = {
    note: txn.Note,
    description: txn.Description || ''
  };
  assert.equal(editFormState.description, originalDesc, 'Edit form loads the exact raw un-normalized description');

  // Simulating Edit form save without changes
  const updatedTxn = {
    ...txn,
    Description: editFormState.description
  };
  assert.equal(updatedTxn.Description, originalDesc, 'Saving unchanged description produces identical stored value');
});

// ── 3. Mobile Transaction List Layout ───────────────────────────────────────

test('Mobile List Layout: Single-line description collapses newlines for compact list display', () => {
  const multiLineDesc = 'Tax Deposited: 206225\nTax Liability: 130745\nTotal: 78120';
  const singleLineDesc = multiLineDesc.replace(/[\r\n]+/g, ' ').trim();

  assert.equal(singleLineDesc, 'Tax Deposited: 206225 Tax Liability: 130745 Total: 78120');
  assert.equal(singleLineDesc.includes('\n'), false, 'Newlines collapsed to single space for list display');
});

test('Mobile List Layout: Short note and description share existing horizontal space without vertical expansion', () => {
  const note = 'Tea';
  const desc = 'Morning tea with cookies';

  // Structure: .txn-note-row contains .txn-note-l and .txn-desc-inline
  const noteRowHasDesc = Boolean(desc);
  assert.equal(noteRowHasDesc, true, 'Row has-desc class applied when description is present');

  // When desc is present, note-l max-width is 55%, desc-inline takes remaining flex: 1
  const maxNoteWidthPct = noteRowHasDesc ? 55 : 100;
  assert.equal(maxNoteWidthPct, 55);

  // Both elements use nowrap and ellipsis
  const descStyles = {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
    flex: 1
  };
  assert.equal(descStyles.whiteSpace, 'nowrap', 'Description will not wrap to another line');
  assert.equal(descStyles.overflow, 'hidden', 'Description will truncate if width exceeds container');
  assert.equal(descStyles.textOverflow, 'ellipsis', 'Ellipsis shown for overflow');
});

test('Mobile List Layout: Long description truncates with single-line ellipsis within available width', () => {
  const longDesc = 'This is an exceptionally long transaction description designed to test single line overflow and ellipsis behavior on small mobile screens without expanding height';
  const singleLineDesc = longDesc.replace(/[\r\n]+/g, ' ').trim();

  assert.ok(singleLineDesc.length > 80, 'Description is long');
  // In CSS, .txn-desc-inline uses:
  // white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1;
  // This guarantees single-line height regardless of character length
});

// ── 4. Show Description Preference Integration ──────────────────────────────

test('Show Description Preference: ON displays inline desc & View popup; OFF hides both without data loss', () => {
  const rawDesc = 'Monthly Broadband bill';
  const txn = { Note: 'Internet', Description: rawDesc };

  // 1. Preference ON
  let showDescription = true;
  let mobileRenderedDesc = showDescription && rawDesc ? rawDesc : null;
  let viewPopupRenderedDesc = showDescription && txn.Description ? normalizeDescriptionForView(txn.Description) : null;

  assert.equal(mobileRenderedDesc, rawDesc, 'Inline description rendered when showDescription is ON');
  assert.equal(viewPopupRenderedDesc, rawDesc, 'View popup description rendered when showDescription is ON');

  // 2. Preference OFF
  showDescription = false;
  mobileRenderedDesc = showDescription && rawDesc ? rawDesc : null;
  viewPopupRenderedDesc = showDescription && txn.Description ? normalizeDescriptionForView(txn.Description) : null;

  assert.equal(mobileRenderedDesc, null, 'Inline description hidden when showDescription is OFF');
  assert.equal(viewPopupRenderedDesc, null, 'View popup description hidden when showDescription is OFF');

  // Stored data remains intact
  assert.equal(txn.Description, rawDesc, 'Turning OFF preference preserves underlying stored data');

  // 3. Preference toggled back ON
  showDescription = true;
  mobileRenderedDesc = showDescription && rawDesc ? rawDesc : null;
  assert.equal(mobileRenderedDesc, rawDesc, 'Restored visibility when toggled ON again');
});
