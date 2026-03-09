import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export async function getRecurring() {
  const db = getDB();
  const r = await db.query('SELECT * FROM recurring WHERE active=1 ORDER BY next_date ASC');
  return r.values || [];
}

export async function saveRecurring(r) {
  const db = getDB();
  const id = r.id||uuid();
  await db.run(
    `INSERT OR REPLACE INTO recurring
     (id,name,amount,account,category,subcategory,type,frequency,next_date,note,active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, r.name||'', parseFloat(r.amount||0), r.account||'', r.category||'',
     r.subcategory||'', r.type||'Expense', r.frequency||'monthly', r.next_date||'', r.note||'', 1]
  );
  return { ...r, id };
}

export async function deleteRecurring(id) {
  const db = getDB();
  await db.run('DELETE FROM recurring WHERE id=?', [id]);
}
