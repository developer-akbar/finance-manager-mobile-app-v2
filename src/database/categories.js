import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';
import { executeAtomicBatch } from './atomicMutation.js';
import { computeEntityDiff } from '../utils/entityDiff.js';

export const getCategories = async () => {
  const db = getDB();
  const cats = await db.query('SELECT * FROM categories ORDER BY sort_order,name');
  const subs = await db.query('SELECT * FROM subcategories ORDER BY sort_order,name');
  const subMap = {};
  for (const s of (subs.values || [])) {
    if (!subMap[s.category_id]) subMap[s.category_id] = [];
    subMap[s.category_id].push({ id: s.id, name: s.name });
  }
  return (cats.values || []).map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    sortOrder: c.sort_order,
    subcategories: subMap[c.id] || []
  }));
};

export const replaceCategories = async (list) => {
  const db = getDB();
  const [curCatsRes, curSubsRes] = await Promise.all([
    db.query('SELECT * FROM categories'),
    db.query('SELECT * FROM subcategories')
  ]);
  const curCats = curCatsRes.values || [];
  const curSubs = curSubsRes.values || [];
  const curCatNameMap = new Map(curCats.map(c => [c.name, c]));

  const newCatRows = [];
  const newSubRows = [];

  for (let i = 0; i < (list || []).length; i++) {
    const cat = list[i];
    const existing = curCatNameMap.get(cat.name);
    const catId = cat.id || existing?.id || uuid();

    newCatRows.push({
      id: catId,
      name: cat.name,
      type: cat.type || 'Expense',
      sort_order: cat.sortOrder !== undefined ? cat.sortOrder : i
    });

    const subs = cat.subcategories || [];
    for (let j = 0; j < subs.length; j++) {
      const sub = subs[j];
      const sId = typeof sub === 'object' ? (sub.id || uuid()) : uuid();
      const sName = typeof sub === 'object' ? sub.name : sub;
      const sOrder = typeof sub === 'object' && sub.sortOrder !== undefined ? sub.sortOrder : j;

      newSubRows.push({
        id: sId,
        name: sName,
        category_id: catId,
        sort_order: sOrder
      });
    }
  }

  const [diffCats, diffSubs] = await Promise.all([
    computeEntityDiff(curCats, newCatRows, 'id'),
    computeEntityDiff(curSubs, newSubRows, 'id')
  ]);

  const ops = [];
  for (const op of diffCats.operations) {
    ops.push({
      storeName: 'categories',
      id: op.id,
      operation: op.operation,
      entity: op.entity,
      expectedBaseEntity: op.oldEntity || (op.operation === 'DELETE' ? op.entity : null),
      base_checksum: op.base_checksum,
      new_checksum: op.new_checksum,
      tombstoneType: op.operation === 'DELETE' ? 'category' : null
    });
  }

  for (const op of diffSubs.operations) {
    ops.push({
      storeName: 'subcategories',
      id: op.id,
      operation: op.operation,
      entity: op.entity,
      expectedBaseEntity: op.oldEntity || (op.operation === 'DELETE' ? op.entity : null),
      base_checksum: op.base_checksum,
      new_checksum: op.new_checksum,
      tombstoneType: op.operation === 'DELETE' ? 'subcategory' : null
    });
  }

  if (ops.length > 0) {
    await executeAtomicBatch({ operations: ops });
  }
};
