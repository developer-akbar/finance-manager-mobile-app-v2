import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export const getCategories = async () => {
  const db=getDB();
  const cats=await db.query('SELECT * FROM categories ORDER BY sort_order,name');
  const subs=await db.query('SELECT * FROM subcategories ORDER BY sort_order,name');
  const subMap={};
  for(const s of(subs.values||[])){ if(!subMap[s.category_id])subMap[s.category_id]=[]; subMap[s.category_id].push({id:s.id,name:s.name}); }
  return (cats.values||[]).map(c=>({id:c.id,name:c.name,type:c.type,sortOrder:c.sort_order,subcategories:subMap[c.id]||[]}));
};

export const replaceCategories = async (list) => {
  const db = getDB();
  const set = [
    { statement: 'DELETE FROM subcategories', values: [] },
    { statement: 'DELETE FROM categories', values: [] }
  ];
  for (const cat of list) {
    const catId = cat.id || uuid();
    set.push({
      statement: 'INSERT INTO categories (id,name,type,sort_order) VALUES (?,?,?,?)',
      values: [catId, cat.name, cat.type || 'Expense', cat.sortOrder || 0]
    });
    for (const sub of (cat.subcategories || [])) {
      set.push({
        statement: 'INSERT INTO subcategories (id,name,category_id,sort_order) VALUES (?,?,?,?)',
        values: [sub.id || uuid(), sub.name || sub, catId, sub.sortOrder || 0]
      });
    }
  }

  if (typeof db.executeSet === 'function') {
    await db.executeSet(set);
  } else {
    await db.run('DELETE FROM subcategories');
    await db.run('DELETE FROM categories');
    for (const stmt of set.slice(2)) {
      await db.run(stmt.statement, stmt.values);
    }
  }
};
