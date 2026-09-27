/**
 * investmentPlans.js — Lightweight recurring Investment Plans (SIP) model and persistence
 *
 * An Investment Plan is a template/schedule for recurring investments (e.g. monthly MF SIPs).
 * It never acts as an accounting transaction itself. Actual execution produces a standard
 * Investment BUY transaction.
 */
import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';
import { executeAtomicMutation } from './atomicMutation.js';

export const applyInvestmentPlansSchema = async (db) => {
  await db.execute(`CREATE TABLE IF NOT EXISTS investment_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    frequency TEXT DEFAULT 'monthly',
    planned_amount REAL DEFAULT 0,
    investment_type TEXT DEFAULT 'BUY',
    owner TEXT DEFAULT 'Myself',
    investment_account TEXT DEFAULT '',
    funding_account TEXT DEFAULT '',
    brokerage TEXT DEFAULT '',
    sub_account TEXT DEFAULT '',
    security_symbol TEXT DEFAULT '',
    security_isin TEXT DEFAULT '',
    security_name TEXT DEFAULT '',
    folio TEXT DEFAULT '',
    holding_mode TEXT DEFAULT '',
    note TEXT DEFAULT '',
    description TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    next_due_date TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
  );`);
};

export const getAllInvestmentPlans = async () => {
  try {
    const r = await getDB().query('SELECT * FROM investment_plans ORDER BY active DESC, created_at DESC');
    return (r.values || []).map(normalizePlan);
  } catch (err) {
    console.error('Failed to get investment plans:', err);
    return [];
  }
};

export const getActiveInvestmentPlans = async () => {
  try {
    const r = await getDB().query('SELECT * FROM investment_plans WHERE active = 1 ORDER BY next_due_date ASC, created_at DESC');
    return (r.values || []).map(normalizePlan);
  } catch (err) {
    console.error('Failed to get active investment plans:', err);
    return [];
  }
};

export const saveInvestmentPlan = async (plan) => {
  const db = getDB();
  const now = new Date().toISOString();
  const id = plan.id || uuid();
  const cleanPlan = {
    id,
    name: (plan.name || plan.security_name || plan.securityDisplayName || 'Investment Plan').trim(),
    frequency: plan.frequency || 'monthly',
    planned_amount: parseFloat(plan.planned_amount || plan.plannedAmount || plan.tradeValue || plan.amount || 0) || 0,
    investment_type: (plan.investment_type || plan.investmentTransactionType || 'BUY').toUpperCase(),
    owner: plan.owner || 'Myself',
    investment_account: plan.investment_account || plan.investmentAccount || '',
    funding_account: plan.funding_account || plan.fundingAccount || '',
    brokerage: plan.brokerage || plan.sub_account || plan.subAccount || '',
    sub_account: plan.sub_account || plan.subAccount || plan.brokerage || '',
    security_symbol: plan.security_symbol || plan.securitySymbol || '',
    security_isin: plan.security_isin || plan.securityISIN || '',
    security_name: plan.security_name || plan.securityDisplayName || plan.note || '',
    folio: plan.folio || '',
    holding_mode: plan.holding_mode || plan.holdingMode || '',
    note: plan.note || '',
    description: plan.description || '',
    tags: plan.tags || '',
    next_due_date: plan.next_due_date || plan.nextDueDate || '',
    active: plan.active === false || plan.active === 0 ? 0 : 1,
    created_at: plan.created_at || now,
    updated_at: now
  };

  const existingRes = await db.query('SELECT id FROM investment_plans WHERE id = ?', [id]);
  const isExisting = (existingRes.values || []).length > 0;

  await executeAtomicMutation({
    storeName: 'investment_plans',
    entityId: id,
    operation: isExisting ? 'UPDATE' : 'INSERT',
    entityData: cleanPlan
  });

  return cleanPlan;
};

export const updateInvestmentPlan = async (id, updates) => {
  const db = getDB();
  const existingList = await db.query('SELECT * FROM investment_plans WHERE id = ?', [id]);
  const existing = existingList.values?.[0];
  if (!existing) throw new Error(`Investment plan not found: ${id}`);

  const now = new Date().toISOString();
  const merged = {
    ...existing,
    ...updates,
    updated_at: now
  };

  // Convert boolean active to integer
  if (merged.active !== undefined) {
    merged.active = merged.active === true || merged.active === 1 ? 1 : 0;
  }
  if (merged.planned_amount !== undefined) {
    merged.planned_amount = parseFloat(merged.planned_amount) || 0;
  }

  await executeAtomicMutation({
    storeName: 'investment_plans',
    entityId: id,
    operation: 'UPDATE',
    entityData: merged
  });

  return normalizePlan(merged);
};

export const deleteInvestmentPlan = async (idOrObj) => {
  const id = typeof idOrObj === 'object' && idOrObj !== null ? (idOrObj.id || idOrObj.ID) : idOrObj;
  await executeAtomicMutation({
    storeName: 'investment_plans',
    entityId: id,
    operation: 'DELETE',
    tombstoneType: 'investment_plan'
  });
  return id;
};

/**
 * Computes the next scheduled due date after execution based on plan frequency.
 */
export function computeNextPlanDate(currentDateStr, frequency = 'monthly') {
  if (!currentDateStr) return '';
  const parts = String(currentDateStr).trim().slice(0, 10).split('-');
  if (parts.length < 3) return '';
  let y = parseInt(parts[0], 10);
  let m = parseInt(parts[1], 10) - 1; // 0-indexed month
  let d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return '';

  const freq = (frequency || 'monthly').toLowerCase();

  switch (freq) {
    case 'weekly': {
      const dt = new Date(Date.UTC(y, m, d + 7));
      return dt.toISOString().slice(0, 10);
    }
    case 'fortnightly': {
      const dt = new Date(Date.UTC(y, m, d + 14));
      return dt.toISOString().slice(0, 10);
    }
    case 'quarterly':
    case '3months': {
      m += 3;
      y += Math.floor(m / 12);
      m = (m % 12 + 12) % 12;
      const maxDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const targetDay = Math.min(d, maxDays);
      const mm = String(m + 1).padStart(2, '0');
      const dd = String(targetDay).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    case 'half-yearly':
    case '6months': {
      m += 6;
      y += Math.floor(m / 12);
      m = (m % 12 + 12) % 12;
      const maxDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const targetDay = Math.min(d, maxDays);
      const mm = String(m + 1).padStart(2, '0');
      const dd = String(targetDay).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    case 'annually':
    case 'yearly': {
      y += 1;
      const maxDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const targetDay = Math.min(d, maxDays);
      const mm = String(m + 1).padStart(2, '0');
      const dd = String(targetDay).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    case 'monthly':
    default: {
      m += 1;
      y += Math.floor(m / 12);
      m = (m % 12 + 12) % 12;
      const maxDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const targetDay = Math.min(d, maxDays);
      const mm = String(m + 1).padStart(2, '0');
      const dd = String(targetDay).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
  }
}

export const advancePlanDueDate = async (id, executedDateStr) => {
  try {
    const list = await getDB().query('SELECT * FROM investment_plans WHERE id = ?', [id]);
    const plan = list.values?.[0];
    if (!plan) return null;

    let baseDate = plan.next_due_date;
    if (!baseDate || isNaN(new Date(baseDate).getTime())) {
      baseDate = executedDateStr || new Date().toISOString().slice(0, 10);
    }

    let nextDate = computeNextPlanDate(baseDate, plan.frequency || 'monthly');

    // If nextDate is still on or before executedDateStr (e.g. logging an overdue plan),
    // advance until it is in the next future cycle.
    const exec = executedDateStr ? new Date(executedDateStr) : new Date();
    while (nextDate && new Date(nextDate) <= exec) {
      nextDate = computeNextPlanDate(nextDate, plan.frequency || 'monthly');
    }

    return await updateInvestmentPlan(id, { next_due_date: nextDate });
  } catch (err) {
    console.error('Failed to advance plan due date:', err);
    return null;
  }
};

function normalizePlan(raw) {
  if (!raw) return null;
  return {
    ...raw,
    active: raw.active === 1 || raw.active === true || raw.active === '1',
    planned_amount: parseFloat(raw.planned_amount || 0) || 0
  };
}
