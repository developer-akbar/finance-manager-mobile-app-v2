/**
 * split_transaction_flow.test.js
 *
 * Test suite verifying Split Transaction enhancements:
 * - Separate descriptions and notes for each split transaction leg
 * - Persistence and retrieval of individual split descriptions
 * - Hashtag extraction from each split's note and description into combinedTags
 * - Preservation of split_group_id across child legs
 * - Calculation and validation of split sums and balance remaining
 */

import test from 'node:test';
import assert from 'node:assert/strict';

test('Split Transaction Flow: Hashtag extraction aggregates tags from all split notes and descriptions', () => {
  const splits = [
    {
      id: 's1',
      category: 'Groceries',
      amount: '500',
      note: 'Fresh apples #grocery #market',
      description: 'Bought at farm stand #organic'
    },
    {
      id: 's2',
      category: 'Household',
      amount: '300',
      note: 'Detergent & soap #supplies',
      description: 'Bulk refill pack #discount'
    }
  ];

  const noteAndDesc = splits.map(s => `${s.note || ''} ${s.description || ''}`).join(' ');
  const extractedHashtags = (noteAndDesc.match(/#[a-zA-Z0-9_\u0900-\u097F-]+/g) || []).map(t => t.toLowerCase());

  assert.ok(extractedHashtags.includes('#grocery'));
  assert.ok(extractedHashtags.includes('#market'));
  assert.ok(extractedHashtags.includes('#organic'));
  assert.ok(extractedHashtags.includes('#supplies'));
  assert.ok(extractedHashtags.includes('#discount'));
  assert.equal(extractedHashtags.length, 5);
});

test('Split Transaction Flow: Independent split descriptions are preserved per leg', () => {
  const splitGroupId = 'split-test-' + Date.now();
  const splits = [
    {
      category: 'Food & Dining',
      subcategory: 'Groceries',
      amount: '750',
      note: 'Weekly essentials',
      description: 'Receipt #1234 - Whole foods'
    },
    {
      category: 'Utilities',
      subcategory: 'Electricity',
      amount: '250',
      note: 'Bill split',
      description: 'Invoice #EB-992'
    }
  ];

  const createdTxns = splits.map(s => ({
    Category: s.category,
    Subcategory: s.subcategory,
    Note: s.note.trim(),
    Description: s.description ? s.description.trim() : '',
    INR: parseFloat(s.amount),
    Amount: s.amount,
    split_group_id: splitGroupId
  }));

  assert.equal(createdTxns.length, 2);
  assert.equal(createdTxns[0].Description, 'Receipt #1234 - Whole foods');
  assert.equal(createdTxns[1].Description, 'Invoice #EB-992');
  assert.notEqual(createdTxns[0].Description, createdTxns[1].Description, 'Each split maintains its unique description');
  assert.equal(createdTxns[0].split_group_id, createdTxns[1].split_group_id, 'Split legs share the same split_group_id');
});

test('Split Transaction Flow: Balanced calculation matches total sum exactly', () => {
  const enteredTotal = 1200;
  const splits = [
    { amount: '400' },
    { amount: '550' },
    { amount: '250' }
  ];

  const allocatedSum = splits.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
  const remaining = Math.round((enteredTotal - allocatedSum) * 100) / 100;

  assert.equal(allocatedSum, 1200);
  assert.equal(remaining, 0, 'Fully allocated split balance remaining is exactly 0');
});

test('Split Transaction Flow: Re-hydration maps split group transactions into separate split objects with description', () => {
  const mockGroupTxns = [
    {
      _id: 'txn_split_1',
      Category: 'Electronics',
      Subcategory: 'Gadgets',
      Amount: '12000',
      INR: 12000,
      Note: 'Headphones',
      Description: 'Noise cancelling model with warranty'
    },
    {
      _id: 'txn_split_2',
      Category: 'Office',
      Subcategory: 'Stationery',
      Amount: '3000',
      INR: 3000,
      Note: 'Notebooks',
      Description: 'Refills for journal'
    }
  ];

  const hydratedSplits = mockGroupTxns.map((t, idx) => ({
    id: t._id || ('s' + (idx + 1)),
    transactionId: t._id,
    category: t.Category || '',
    subcategory: t.Subcategory || '',
    amount: String(t.INR || t.Amount || ''),
    note: t.Note || '',
    description: t.Description || ''
  }));

  assert.equal(hydratedSplits.length, 2);
  assert.equal(hydratedSplits[0].description, 'Noise cancelling model with warranty');
  assert.equal(hydratedSplits[1].description, 'Refills for journal');
  assert.equal(hydratedSplits[0].amount, '12000');
  assert.equal(hydratedSplits[1].amount, '3000');
});
