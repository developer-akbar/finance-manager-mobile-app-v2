import { getDB } from './db.js';
import { addTransaction } from './transactions.js';
import { v4 as uuid } from 'uuid';

export const getInventoryItems = async () => {
  const db = getDB();
  const res = await db.query('SELECT * FROM inventory ORDER BY name ASC');
  return res.values || [];
};

export const addInventoryPurchase = async (fromAccount, date, items, noteText = 'in stock') => {
  const db = getDB();
  const now = new Date().toISOString();
  let totalAmount = 0;
  const itemDetails = [];

  for (const item of items) {
    const qty = parseFloat(item.qty) || 0;
    const price = parseFloat(item.price) || 0;
    const discPrice = parseFloat(item.discounted_price) || price;
    totalAmount += qty * discPrice;

    itemDetails.push(`${qty}${item.unit ? ' ' + item.unit : ''} of ${item.name} (@₹${discPrice})`);

    // Check if an item with this name already exists (case-insensitive)
    // Using LIKE for case-insensitive comparison on SQLite and IDB query wrapper
    const existingRes = await db.query('SELECT * FROM inventory WHERE name LIKE ?', [item.name.trim()]);
    const existing = existingRes.values?.[0];

    if (existing) {
      const newQty = (parseFloat(existing.qty) || 0) + qty;
      const status = newQty > 0 ? 'available' : 'unavailable';
      await db.run(
        'UPDATE inventory SET qty = ?, price = ?, discounted_price = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?',
        [newQty, price, discPrice, status, item.notes || existing.notes || '', now, existing.id]
      );
    } else {
      const status = qty > 0 ? 'available' : 'unavailable';
      const id = uuid();
      await db.run(
        'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, item.name.trim(), qty, item.unit || '', price, discPrice, status, date, item.notes || '', now]
      );
    }
  }

  // Create corresponding Transfer transaction (From: selected account, To: Stock)
  const description = itemDetails.join(', ');
  const txn = {
    Date: date,
    Time: new Date().toLocaleTimeString('en-IN', { hour12: false }),
    Account: fromAccount,
    FromAccount: fromAccount,
    ToAccount: 'Stock',
    Category: 'Transfer',
    Subcategory: '',
    Note: noteText,
    Description: description,
    INR: totalAmount,
    Amount: String(totalAmount),
    Currency: 'INR',
    'Income/Expense': 'Transfer',
    tags: '#stock #inventory',
  };

  await addTransaction(txn);
};

export const consumeInventoryItem = async (itemId, qtyToConsume, date) => {
  const db = getDB();
  const now = new Date().toISOString();

  const res = await db.query('SELECT * FROM inventory WHERE id = ?', [itemId]);
  const item = res.values?.[0];
  if (!item) throw new Error('Item not found in stock');

  const currQty = parseFloat(item.qty) || 0;
  const newQty = Math.max(0, currQty - qtyToConsume);
  const status = newQty > 0 ? 'available' : 'unavailable';

  await db.run(
    'UPDATE inventory SET qty = ?, status = ?, updated_at = ? WHERE id = ?',
    [newQty, status, now, itemId]
  );

  // Create corresponding Expense transaction (Account: Stock)
  const pricePaid = parseFloat(item.discounted_price) || parseFloat(item.price) || 0;
  const expenseAmt = qtyToConsume * pricePaid;

  const txn = {
    Date: date,
    Time: new Date().toLocaleTimeString('en-IN', { hour12: false }),
    Account: 'Stock',
    FromAccount: 'Stock',
    ToAccount: '',
    Category: 'Groceries',
    Subcategory: '',
    Note: 'consumed',
    Description: `Used ${qtyToConsume} ${item.unit || 'pcs'} of ${item.name}`,
    INR: expenseAmt,
    Amount: String(expenseAmt),
    Currency: 'INR',
    'Income/Expense': 'Expense',
    tags: '#stock #consumed',
  };

  await addTransaction(txn);
};

export const deleteInventoryItem = async (itemId) => {
  const db = getDB();
  await db.run('DELETE FROM inventory WHERE id = ?', [itemId]);
};
