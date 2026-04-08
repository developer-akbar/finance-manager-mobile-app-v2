/**
 * recurring.js — Instalment and Repeat transaction rules
 *
 * INSTALMENT rule stores:
 *   type = 'instalment'
 *   total_amount, total_days, start_date, schedule_mode ('on_day' | 'start_of_month')
 *   total_parts, completed_parts (set after generation)
 *   next_date = date of next pending instalment
 *   status: 'active' | 'completed' | 'cancelled'
 *
 * REPEAT rule stores:
 *   type = 'repeat'
 *   frequency: 'daily'|'weekly'|'fortnightly'|'monthly'|'3months'|'6months'|'annually'
 *   schedule_mode: 'on_date' | 'start_of_month'
 *   next_date = next due date
 *   status: 'active' | 'paused' | 'cancelled'
 *
 * Common fields: id, base_note, account, from_account, to_account,
 *   category, subcategory, currency, txn_type, amount_per_part (for repeat = amount)
 */
import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

// ── Schema (called from applySchema in db.js via initDB) ──────────────────
export const applyRecurringSchema = async (db) => {
  await db.execute(`CREATE TABLE IF NOT EXISTS recurring_rules (
    id TEXT PRIMARY KEY,
    rule_type TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    txn_type TEXT DEFAULT 'Expense',
    account TEXT DEFAULT '',
    from_account TEXT DEFAULT '',
    to_account TEXT DEFAULT '',
    category TEXT DEFAULT '',
    subcategory TEXT DEFAULT '',
    base_note TEXT DEFAULT '',
    description TEXT DEFAULT '',
    currency TEXT DEFAULT 'INR',
    total_amount REAL DEFAULT 0,
    amount_per_part REAL DEFAULT 0,
    total_days INTEGER DEFAULT 0,
    total_parts INTEGER DEFAULT 0,
    completed_parts INTEGER DEFAULT 0,
    start_date TEXT DEFAULT '',
    next_date TEXT DEFAULT '',
    end_date TEXT DEFAULT '',
    schedule_mode TEXT DEFAULT 'on_date',
    frequency TEXT DEFAULT '',
    created_at TEXT DEFAULT ''
  );`);
};

// ── CRUD ──────────────────────────────────────────────────────────────────
export const getAllRecurringRules = async () => {
  const r = await getDB().query('SELECT * FROM recurring_rules ORDER BY created_at DESC');
  return r.values || [];
};

export const getActiveRecurringRules = async () => {
  const r = await getDB().query(
    "SELECT * FROM recurring_rules WHERE status = 'active' ORDER BY next_date ASC"
  );
  return r.values || [];
};

export const saveRecurringRule = async (rule) => {
  const db = getDB();
  const obj = { ...rule, id: rule.id || uuid(), created_at: rule.created_at || new Date().toISOString() };
  await db.run(
    `INSERT OR REPLACE INTO recurring_rules
     (id,rule_type,status,txn_type,account,from_account,to_account,category,subcategory,
      base_note,description,currency,total_amount,amount_per_part,total_days,total_parts,
      completed_parts,start_date,next_date,end_date,schedule_mode,frequency,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [obj.id, obj.rule_type, obj.status||'active', obj.txn_type||'Expense',
     obj.account||'', obj.from_account||'', obj.to_account||'', obj.category||'',
     obj.subcategory||'', obj.base_note||'', obj.description||'', obj.currency||'INR',
     obj.total_amount||0, obj.amount_per_part||0, obj.total_days||0, obj.total_parts||0,
     obj.completed_parts||0, obj.start_date||'', obj.next_date||'', obj.end_date||'',
     obj.schedule_mode||'on_date', obj.frequency||'', obj.created_at]
  );
  return obj;
};

export const updateRecurringRule = async (id, updates) => {
  const rules = await getAllRecurringRules();
  const rule = rules.find(r => r.id === id);
  if (!rule) return;
  await saveRecurringRule({ ...rule, ...updates, id });
};

export const deleteRecurringRule = async (id) => {
  await getDB().run('DELETE FROM recurring_rules WHERE id = ?', [id]);
};

// ── Instalment math ───────────────────────────────────────────────────────
/**
 * Build instalment schedule from a rule.
 * Returns array of { date: 'YYYY-MM-DD', amount: number, part: number, total: number }
 */
export const buildInstalmentSchedule = (rule) => {
  const { total_amount, total_days, start_date, schedule_mode } = rule;

  // Parse start date
  const [sy, sm, sd] = start_date.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);

  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const endDate = addDays(start, total_days - 1);

  const segments = []; // { segStart, segEnd, days }

  if (schedule_mode === 'start_of_month') {
    // Segment 1: start_date → end of that month (or endDate)
    const firstMonthEnd = new Date(sy, sm - 1 + 1, 0); // last day of start month
    const seg1End = firstMonthEnd < endDate ? firstMonthEnd : endDate;
    segments.push({ segStart: start, segEnd: seg1End });

    // Subsequent segments: 1st of each following month
    let cur = new Date(sy, sm - 1 + 1, 1); // 1st of next month
    while (cur <= endDate) {
      const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const segEnd = monthEnd < endDate ? monthEnd : endDate;
      segments.push({ segStart: new Date(cur), segEnd });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
  } else {
    // 'on_day' mode: divide total_days by 30, create monthly instalments on same day
    // e.g. 3 months → 22 Mar, 22 Apr, 22 May
    const numMonths = Math.round(total_days / 30) || 1;
    for (let i = 0; i < numMonths; i++) {
      const segDate = new Date(sy, sm - 1 + i, sd);
      segments.push({ segStart: segDate, segEnd: segDate, singleDay: true });
    }
  }

  // Compute amounts (proportional for start_of_month, equal for on_day)
  const total = segments.length;
  let amounts;

  if (schedule_mode === 'start_of_month') {
    amounts = segments.map(s => {
      const days = (s.segEnd - s.segStart) / (1000 * 60 * 60 * 24) + 1;
      return Math.round((days / total_days) * total_amount);
    });
  } else {
    const base = Math.floor(total_amount / total);
    amounts = new Array(total).fill(base);
  }

  // Fix rounding difference on last segment
  const diff = total_amount - amounts.reduce((a, b) => a + b, 0);
  if (amounts.length > 0) amounts[amounts.length - 1] += diff;

  return segments.map((s, i) => ({
    date: fmtDate(s.segStart),
    amount: amounts[i],
    part: i + 1,
    total,
  }));
};

// ── Repeat: compute next date after a given date ──────────────────────────
export const computeNextRepeatDate = (currentDate, frequency, schedule_mode) => {
  const [y, m, d] = currentDate.split('-').map(Number);
  const cur = new Date(y, m - 1, d);
  const fmtDate = (dt) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;

  let next;
  switch (frequency) {
    case 'daily':       next = new Date(y, m-1, d+1);  break;
    case 'weekly':      next = new Date(y, m-1, d+7);  break;
    case 'fortnightly': next = new Date(y, m-1, d+14); break;
    case 'monthly':     next = new Date(y, m,   d);    break;
    case '3months':     next = new Date(y, m+2, d);    break;
    case '6months':     next = new Date(y, m+5, d);    break;
    case 'annually':    next = new Date(y+1, m-1, d);  break;
    default:            next = new Date(y, m,   d);
  }

  // start_of_month: snap to 1st of the computed month
  if (schedule_mode === 'start_of_month') {
    next = new Date(next.getFullYear(), next.getMonth(), 1);
  }

  return fmtDate(next);
};

// ── Note helpers ──────────────────────────────────────────────────────────
/** Strip instalment suffix like " (2/4)" from a note for autocomplete */
export const stripInstalmentSuffix = (note) =>
  (note || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();

/** Build instalment note: "Test (2/4)" */
export const buildInstalmentNote = (baseNote, part, total) =>
  `${baseNote} (${part}/${total})`;