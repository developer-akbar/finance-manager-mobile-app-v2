import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';
import { executeAtomicMutation, executeAtomicBatch } from './atomicMutation.js';
import { computeEntityDiff } from '../utils/entityDiff.js';

export const getBudgets = async () => {
  const r = await getDB().query('SELECT * FROM budgets ORDER BY category');
  return r.values || [];
};

export const setBudget = async (category, amount, period = 'monthly') => {
  const db = getDB();
  const now = new Date().toISOString();
  const ex = await db.query('SELECT * FROM budgets WHERE category = ?', [category]);
  const existing = ex.values?.[0];

  if (existing) {
    const updated = {
      ...existing,
      amount: parseFloat(amount || 0),
      period: String(period)
    };
    await executeAtomicMutation({
      storeName: 'budgets',
      entityId: existing.id,
      operation: 'UPDATE',
      entityData: updated
    });
  } else {
    const id = uuid();
    const inserted = {
      id,
      category,
      amount: parseFloat(amount || 0),
      period: String(period),
      created_at: now
    };
    await executeAtomicMutation({
      storeName: 'budgets',
      entityId: id,
      operation: 'INSERT',
      entityData: inserted
    });
  }
};

export const deleteBudget = async (category) => {
  const db = getDB();
  const ex = await db.query('SELECT * FROM budgets WHERE category = ?', [category]);
  const existing = ex.values?.[0];
  if (existing) {
    await executeAtomicMutation({
      storeName: 'budgets',
      entityId: existing.id,
      operation: 'DELETE',
      tombstoneType: 'budget'
    });
  }
};

export const replaceBudgets = async (items) => {
  const db = getDB();
  const now = new Date().toISOString();
  const curBudgetsRes = await db.query('SELECT * FROM budgets');
  const curBudgets = curBudgetsRes.values || [];
  const curCatMap = new Map(curBudgets.map(b => [b.category, b]));

  const newBudgetRows = [];
  for (const item of (items || [])) {
    const cat = item.category || '';
    if (!cat) continue;
    const existing = curCatMap.get(cat);
    newBudgetRows.push({
      id: item.id || existing?.id || uuid(),
      category: cat,
      amount: parseFloat(item.amount || 0),
      period: item.period || 'Monthly',
      created_at: item.created_at || existing?.created_at || now
    });
  }

  const diff = await computeEntityDiff(curBudgets, newBudgetRows, 'id');
  const ops = diff.operations.map(op => ({
    storeName: 'budgets',
    id: op.id,
    operation: op.operation,
    entity: op.entity,
    expectedBaseEntity: op.oldEntity || (op.operation === 'DELETE' ? op.entity : null),
    base_checksum: op.base_checksum,
    new_checksum: op.new_checksum,
    tombstoneType: op.operation === 'DELETE' ? 'budget' : null
  }));

  if (ops.length > 0) {
    await executeAtomicBatch({ operations: ops });
  }
};
