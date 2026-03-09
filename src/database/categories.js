import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export async function getCategories() {
  const db = getDB();
  const cats = await db.query('SELECT * FROM categories ORDER BY sort_order ASC, name ASC');
  const subs = await db.query('SELECT * FROM subcategories ORDER BY sort_order ASC, name ASC');
  const subMap = {};
  for (const s of (subs.values||[])) {
    if (!subMap[s.category_id]) subMap[s.category_id] = [];
    subMap[s.category_id].push({ id:s.id, name:s.name, icon:s.icon, sort_order:s.sort_order });
  }
  return (cats.values||[]).map(c => ({
    id:c.id, name:c.name, type:c.type, icon:c.icon||'📦', color:c.color||'#4d9fff',
    sort_order:c.sort_order, subcategories: subMap[c.id]||[],
  }));
}

export async function replaceCategories(list) {
  const db = getDB();
  await db.run('DELETE FROM subcategories');
  await db.run('DELETE FROM categories');
  for (const c of list) {
    const catId = c.id||uuid();
    await db.run(
      'INSERT INTO categories (id,name,type,icon,color,sort_order) VALUES (?,?,?,?,?,?)',
      [catId, c.name||'', c.type||'Expense', c.icon||'📦', c.color||'#4d9fff', c.sort_order||0]
    );
    for (const s of (c.subcategories||[])) {
      await db.run(
        'INSERT INTO subcategories (id,name,category_id,icon,sort_order) VALUES (?,?,?,?,?)',
        [s.id||uuid(), s.name||s, catId, s.icon||'', s.sort_order||0]
      );
    }
  }
}
