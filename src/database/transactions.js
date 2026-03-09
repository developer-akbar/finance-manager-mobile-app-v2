import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

// ── Row → app object ────────────────────────────────────────────────────────
function rowToTxn(r) {
  return {
    _id:          r.id,
    ID:           r.id,
    Date:         r.date,
    Account:      r.account,
    FromAccount:  r.from_account,
    ToAccount:    r.to_account,
    Category:     r.category,
    Subcategory:  r.subcategory,
    Note:         r.note,
    Description:  r.description,
    Amount:       String(r.amount),
    INR:          r.inr,
    Currency:     r.currency || 'INR',
    'Income/Expense': r.type,
    created_at:   r.created_at,
  };
}

export async function getTransactions() {
  const db = getDB();
  const res = await db.query('SELECT * FROM transactions ORDER BY date DESC, created_at DESC');
  return (res.values || []).map(rowToTxn);
}

export async function addTransaction(t) {
  const db = getDB();
  const id = t.ID || t._id || uuid();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO transactions
     (id,date,account,from_account,to_account,category,subcategory,note,description,amount,inr,currency,type,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, t.Date||'', t.Account||'', t.FromAccount||'', t.ToAccount||'',
     t.Category||'', t.Subcategory||'', t.Note||'', t.Description||'',
     parseFloat(t.Amount||t.INR||0), parseFloat(t.INR||t.Amount||0),
     t.Currency||'INR', t['Income/Expense']||'Expense', now, now]
  );
  return rowToTxn({ id, date:t.Date, account:t.Account, from_account:t.FromAccount,
    to_account:t.ToAccount, category:t.Category, subcategory:t.Subcategory,
    note:t.Note, description:t.Description, amount:parseFloat(t.Amount||0),
    inr:parseFloat(t.INR||t.Amount||0), currency:t.Currency||'INR',
    type:t['Income/Expense']||'Expense', created_at:now });
}

export async function updateTransaction(id, t) {
  const db = getDB();
  const now = new Date().toISOString();
  await db.run(
    `UPDATE transactions SET
     date=?,account=?,from_account=?,to_account=?,category=?,subcategory=?,
     note=?,description=?,amount=?,inr=?,currency=?,type=?,updated_at=?
     WHERE id=?`,
    [t.Date||'', t.Account||'', t.FromAccount||'', t.ToAccount||'',
     t.Category||'', t.Subcategory||'', t.Note||'', t.Description||'',
     parseFloat(t.Amount||t.INR||0), parseFloat(t.INR||t.Amount||0),
     t.Currency||'INR', t['Income/Expense']||'Expense', now, id]
  );
  return rowToTxn({ id, date:t.Date, account:t.Account, from_account:t.FromAccount,
    to_account:t.ToAccount, category:t.Category, subcategory:t.Subcategory,
    note:t.Note, description:t.Description, amount:parseFloat(t.Amount||0),
    inr:parseFloat(t.INR||t.Amount||0), currency:t.Currency||'INR',
    type:t['Income/Expense']||'Expense', created_at:t.created_at });
}

export async function deleteTransaction(id) {
  const db = getDB();
  await db.run('DELETE FROM transactions WHERE id=?', [id]);
}

export async function deleteAllTransactions() {
  const db = getDB();
  await db.run('DELETE FROM transactions');
}

export async function bulkImport(rows, merge = false) {
  const db = getDB();
  let imported = 0, skipped = 0;
  for (const t of rows) {
    const id = t.ID || t._id || uuid();
    const existing = await db.query('SELECT id FROM transactions WHERE id=?', [id]);
    if (merge && (existing.values||[]).length > 0) { skipped++; continue; }
    const now = new Date().toISOString();
    const stmt = merge
      ? `INSERT OR IGNORE INTO transactions
         (id,date,account,from_account,to_account,category,subcategory,note,description,amount,inr,currency,type,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      : `INSERT OR REPLACE INTO transactions
         (id,date,account,from_account,to_account,category,subcategory,note,description,amount,inr,currency,type,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    await db.run(stmt, [
      id, t.Date||'', t.Account||'', t.FromAccount||'', t.ToAccount||'',
      t.Category||'', t.Subcategory||'', t.Note||'', t.Description||'',
      parseFloat(t.Amount||t.INR||0), parseFloat(t.INR||t.Amount||0),
      t.Currency||'INR', t['Income/Expense']||'Expense', now, now
    ]);
    imported++;
  }
  return { imported, skipped };
}
