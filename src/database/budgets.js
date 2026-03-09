import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export async function getBudgets() {
  const db = getDB();
  const r = await db.query('SELECT * FROM budgets ORDER BY name ASC');
  return r.values || [];
}

export async function saveBudget(b) {
  const db = getDB();
  const id = b.id||uuid();
  await db.run(
    'INSERT OR REPLACE INTO budgets (id,name,category,amount,period) VALUES (?,?,?,?,?)',
    [id, b.name||b.category, b.category, parseFloat(b.amount||0), b.period||'monthly']
  );
  return { ...b, id };
}

export async function deleteBudget(id) {
  const db = getDB();
  await db.run('DELETE FROM budgets WHERE id=?', [id]);
}
