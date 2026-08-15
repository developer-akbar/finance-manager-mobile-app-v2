import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';
import { addTransaction } from './transactions.js';

const formatFraction = (val) => {
  if (val === 0 || !val) return '0';
  const integerPart = Math.floor(val);
  const decimalPart = val - integerPart;

  if (decimalPart < 0.005) {
    return String(integerPart);
  }
  if (Math.abs(decimalPart - 1) < 0.005) {
    return String(integerPart + 1);
  }

  const epsilon = 0.01;
  const fractions = [
    { dec: 0.5, frac: '1/2' },
    { dec: 0.25, frac: '1/4' },
    { dec: 0.75, frac: '3/4' },
    { dec: 1/3, frac: '1/3' },
    { dec: 2/3, frac: '2/3' },
    { dec: 1/8, frac: '1/8' },
    { dec: 3/8, frac: '3/8' },
    { dec: 5/8, frac: '5/8' },
    { dec: 7/8, frac: '7/8' },
    { dec: 0.2, frac: '1/5' },
    { dec: 0.4, frac: '2/5' },
    { dec: 0.6, frac: '3/5' },
    { dec: 0.8, frac: '4/5' },
    { dec: 1/6, frac: '1/6' },
    { dec: 5/6, frac: '5/6' },
  ];

  for (const item of fractions) {
    if (Math.abs(decimalPart - item.dec) < epsilon) {
      return integerPart > 0 ? `${integerPart} ${item.frac}` : item.frac;
    }
  }

  return String(parseFloat(val.toFixed(3)));
};

export const getInventoryItems = async () => {
  const db = getDB();
  const res = await db.query('SELECT * FROM inventory ORDER BY purchased_date DESC, updated_at DESC', []);
  return res.values || [];
};

export const addInventoryPurchase = async (fromAccount, date, items, noteText = 'in stock', timeText = '') => {
  const db = getDB();
  const now = new Date().toISOString();
  let totalAmount = 0;
  const itemDetails = [];

  const formattedDate = date.includes('/') ? date : date.split('-').reverse().join('/');
  const formattedTime = timeText || new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5);

  for (const item of items) {
    const qty = parseFloat(item.qty) || 0;
    const price = parseFloat(item.price) || 0;
    const discPrice = parseFloat(item.discounted_price) || price;
    totalAmount += qty * discPrice;

    const subQty = item.sub_qty || 1;
    const subUnit = item.sub_unit || '';
    const itemAmtBeforeDisc = price * qty;
    const itemAmtAfterDisc = discPrice * qty;
    itemDetails.push(`${item.name} ${qty} ${item.unit} ${subQty} ${subUnit} ${itemAmtBeforeDisc}: @${itemAmtAfterDisc}`);

    const status = qty > 0 ? 'available' : 'unavailable';
    const id = uuid();
    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date, notes, updated_at, sub_qty, sub_unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, item.name.trim(), qty, item.unit || '', price, discPrice, status, date, item.notes || '', now, parseFloat(item.sub_qty) || 1, item.sub_unit || '']
    );
  }

  // Always save rounded values for transactions
  const roundedTotal = Math.round(totalAmount);
  const description = itemDetails.join('\n');
  const txn = {
    Date: formattedDate,
    Time: formattedTime,
    Account: fromAccount,
    FromAccount: fromAccount,
    ToAccount: 'Stock',
    Category: 'Transfer',
    Subcategory: '',
    Note: noteText,
    Description: description,
    INR: roundedTotal,
    Amount: String(roundedTotal),
    Currency: 'INR',
    'Income/Expense': 'Transfer-Out',
    tags: '#stock #inventory',
  };

  await addTransaction(txn);
};

export const consumeInventoryItem = async (
  itemId,
  qtyToConsume,
  date,
  useSubUnit = false,
  category = 'To Home',
  subcategory = 'Groceries',
  usageType = 'consume',
  personName = ''
) => {
  const db = getDB();
  const now = new Date().toISOString();

  const res = await db.query('SELECT * FROM inventory WHERE id = ?', [itemId]);
  const item = res.values?.[0];
  if (!item) throw new Error('Item not found in stock');

  const currQty = parseFloat(item.qty) || 0;
  const subQtyVal = parseFloat(item.sub_qty) || 1;

  let finalQtyToConsume = qtyToConsume;
  if (useSubUnit && subQtyVal > 0) {
    // Convert sub-unit consumption to parent pack unit
    finalQtyToConsume = qtyToConsume / subQtyVal;
  }

  const newQty = Math.max(0, currQty - finalQtyToConsume);
  const status = newQty > 0 ? 'available' : 'unavailable';

  await db.run(
    'UPDATE inventory SET qty = ?, status = ?, updated_at = ? WHERE id = ?',
    [newQty, status, now, itemId]
  );

  // Create corresponding Expense transaction (Account: Stock)
  const pricePaidPerPack = parseFloat(item.discounted_price) || parseFloat(item.price) || 0;
  const rawExpense = finalQtyToConsume * pricePaidPerPack;
  const roundedExpense = Math.round(rawExpense);

  const formattedDate = date.includes('/') ? date : date.split('-').reverse().join('/');

  const qtyStrFormatted = formatFraction(qtyToConsume);
  const consumedStr = useSubUnit
    ? `${qtyStrFormatted} ${item.sub_unit || 'g'}`
    : `${qtyStrFormatted} ${item.unit || 'pcs'}`;

  // Human-readable batch connectivity in description
  const batchDate = item.purchased_date
    ? new Date(item.purchased_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    : 'unknown date';
  const batchStore = item.notes ? ` from ${item.notes}` : '';
  const description = `${usageType === 'lend' ? 'Lent' : 'Used'} ${consumedStr} of ${item.name} (Batch: bought on ${batchDate}${batchStore})`;

  const txn = {
    Date: formattedDate,
    Time: new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5),
    Account: usageType === 'lend' ? 'Lend' : 'Stock',
    FromAccount: usageType === 'lend' ? 'Lend' : 'Stock',
    ToAccount: '',
    Category: usageType === 'lend' ? 'Lend' : category,
    Subcategory: usageType === 'lend' ? '' : subcategory,
    Note: usageType === 'lend' ? `Lend to ${personName.trim()}` : 'consumed',
    Description: description,
    INR: roundedExpense,
    Amount: String(roundedExpense),
    Currency: 'INR',
    'Income/Expense': 'Expense',
    tags: `#stock #${usageType === 'lend' ? 'lent' : 'consumed'} #stock_ref_${item.id}`,
  };

  await addTransaction(txn);
};

export const updateInventoryItem = async (id, data) => {
  const db = getDB();
  const now = new Date().toISOString();
  const qty = parseFloat(data.qty) || 0;
  const price = parseFloat(data.price) || 0;
  const discPrice = parseFloat(data.discounted_price) || price;
  const status = qty > 0 ? 'available' : 'unavailable';

  await db.run(
    'UPDATE inventory SET name = ?, qty = ?, unit = ?, price = ?, discounted_price = ?, status = ?, purchased_date = ?, notes = ?, updated_at = ?, sub_qty = ?, sub_unit = ? WHERE id = ?',
    [data.name.trim(), qty, data.unit || '', price, discPrice, status, data.purchased_date || '', data.notes || '', now, parseFloat(data.sub_qty) || 1, data.sub_unit || '', id]
  );
};

export const deleteInventoryItem = async (itemId) => {
  const db = getDB();
  await db.run('DELETE FROM inventory WHERE id = ?', [itemId]);
};

export const restoreInventoryItem = async (itemId, qtyToRestore, unitMode) => {
  const db = getDB();
  const res = await db.query('SELECT * FROM inventory WHERE id = ?', [itemId]);
  const item = res.values?.[0];
  if (!item) return;

  const currQty = parseFloat(item.qty) || 0;
  const subQtyVal = parseFloat(item.sub_qty) || 1;

  let finalQtyToRestore = qtyToRestore;
  if (item.sub_unit && unitMode === item.sub_unit && subQtyVal > 0) {
    finalQtyToRestore = qtyToRestore / subQtyVal;
  }

  const newQty = currQty + finalQtyToRestore;
  const status = newQty > 0 ? 'available' : 'unavailable';

  await db.run(
    'UPDATE inventory SET qty = ?, status = ?, updated_at = ? WHERE id = ?',
    [newQty, status, new Date().toISOString(), itemId]
  );
};
