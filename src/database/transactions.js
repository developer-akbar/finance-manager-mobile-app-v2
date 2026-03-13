import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export const rowToTxn = (r) => ({
  _id: r.id, ID: r.id,
  Date: r.date, Time: r.time || '',
  Account: r.account || '', FromAccount: r.from_account || '', ToAccount: r.to_account || '',
  Category: r.category || '', Subcategory: r.subcategory || '',
  Note: r.note || '', Description: r.description || '',
  INR: parseFloat(r.inr) || 0, Amount: r.amount || String(r.inr || 0),
  Currency: r.currency || 'INR', 'Income/Expense': r.type || 'Expense',
  created_at: r.created_at, updated_at: r.updated_at,
});

export const getTransactions = async (filters = {}) => {
  const db = getDB();
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const vals = [];
  if (filters.account) {
    sql += ' AND (account=? OR from_account=? OR to_account=?)';
    vals.push(filters.account, filters.account, filters.account);
  }
  if (filters.category) { sql += ' AND category=?'; vals.push(filters.category); }
  if (filters.type)     { sql += ' AND type=?';     vals.push(filters.type); }
  if (filters.search) {
    sql += ' AND (note LIKE ? OR category LIKE ? OR account LIKE ? OR description LIKE ? OR from_account LIKE ? OR to_account LIKE ?)';
    const q = `%${filters.search}%`;
    vals.push(q, q, q, q, q, q);
  }
  sql += ' ORDER BY date DESC, time DESC, created_at DESC';
  if (filters.limit) { sql += ' LIMIT ?'; vals.push(filters.limit); }
  const res = await db.query(sql, vals);
  return (res.values || []).map(rowToTxn);
};

export const addTransaction = async (data) => {
  const db  = getDB();
  const id  = data.ID || data._id || uuid();
  const now = new Date().toISOString();
  await db.run(
    `INSERT OR IGNORE INTO transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, data.Date||'', data.Time||'', data.Account||'', data.FromAccount||'', data.ToAccount||'',
     data.Category||'', data.Subcategory||'', data.Note||'', data.Description||'',
     parseFloat(data.INR||data.Amount||0), String(data.Amount||data.INR||'0'),
     data.Currency||'INR', data['Income/Expense']||'Expense', now, now]
  );
  return rowToTxn({ id, date:data.Date||'', time:data.Time||'', account:data.Account||'', from_account:data.FromAccount||'', to_account:data.ToAccount||'', category:data.Category||'', subcategory:data.Subcategory||'', note:data.Note||'', description:data.Description||'', inr:parseFloat(data.INR||data.Amount||0), amount:String(data.Amount||data.INR||'0'), currency:data.Currency||'INR', type:data['Income/Expense']||'Expense', created_at:now, updated_at:now });
};

export const updateTransaction = async (id, data) => {
  const db  = getDB();
  const now = new Date().toISOString();
  await db.run(
    `UPDATE transactions SET date=?,time=?,account=?,from_account=?,to_account=?,category=?,subcategory=?,note=?,description=?,inr=?,amount=?,currency=?,type=?,updated_at=? WHERE id=?`,
    [data.Date, data.Time||'', data.Account||'', data.FromAccount||'', data.ToAccount||'',
     data.Category||'', data.Subcategory||'', data.Note||'', data.Description||'',
     parseFloat(data.INR||data.Amount||0), String(data.Amount||data.INR||'0'),
     data.Currency||'INR', data['Income/Expense']||'Expense', now, id]
  );
  return rowToTxn({ id, date:data.Date||'', time:data.Time||'', account:data.Account||'', from_account:data.FromAccount||'', to_account:data.ToAccount||'', category:data.Category||'', subcategory:data.Subcategory||'', note:data.Note||'', description:data.Description||'', inr:parseFloat(data.INR||data.Amount||0), amount:String(data.Amount||data.INR||'0'), currency:data.Currency||'INR', type:data['Income/Expense']||'Expense', updated_at:now });
};

export const deleteTransaction    = async (id) => { await getDB().run('DELETE FROM transactions WHERE id=?', [id]); };
export const deleteAllTransactions = async ()  => { await getDB().run('DELETE FROM transactions'); };

// Normalise any date value → dd/mm/yyyy string for storage.
// Matches same logic as xlsParser.normaliseCellDate:
//   Numeric serials: (serial−25569)×86400000 UTC ms formula.
// Money Manager XLS dates are TEXT: "dd/mm/yyyy HH:MM:SS" (Indian format, day first always)
export const normaliseDateStr = (raw) => {
  if (raw === null || raw === undefined || raw === '') return '';
  // Excel serial number (from SheetJS numeric cells)
  if (typeof raw === 'number' && raw > 1000) {
    const ms = (raw - 25569) * 86400 * 1000;
    const d  = new Date(ms);
    return String(d.getUTCDate()).padStart(2,'0') + '/' +
           String(d.getUTCMonth()+1).padStart(2,'0') + '/' +
           d.getUTCFullYear();
  }
  // JS Date object (cellDates:true)
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return '';
    return String(raw.getUTCDate()).padStart(2,'0') + '/' +
           String(raw.getUTCMonth()+1).padStart(2,'0') + '/' +
           raw.getUTCFullYear();
  }
  let s = String(raw).trim();
  if (!s) return '';
  // Strip time component: "dd/mm/yyyy HH:MM:SS" → "dd/mm/yyyy"
  s = s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?.*$/, '').trim();
  // ISO: yyyy-mm-dd
  const iso = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  // dd/mm/yyyy (Indian format — confirmed day-first from Money Manager export)
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const d = +dmy[1], m = +dmy[2], y = dmy[3];
    // Only swap if month position is clearly > 12 (unambiguous)
    if (m > 12 && d <= 12) return `${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')}/${y}`;
    return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
  }
  // Fallback
  const jsD = new Date(s);
  if (!isNaN(jsD)) {
    return String(jsD.getDate()).padStart(2,'0') + '/' +
           String(jsD.getMonth()+1).padStart(2,'0') + '/' +
           jsD.getFullYear();
  }
  return s;
};

// Normalise Income/Expense type string
const normaliseType = (raw) => {
  const s = String(raw || '').trim();
  if (s === 'Income') return 'Income';
  if (/^transfer.?in$/i.test(s))  return 'Transfer-In';
  if (s.toLowerCase().startsWith('transfer')) return 'Transfer-Out';
  return 'Expense';
};

// Generate a stable ID from a key string using a simple hash
// This ensures the same transaction always gets the same ID across imports
function deterministicId(key) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (h2 >>> 0) + (h1 >>> 0);
  return 'txn-' + n.toString(36).padStart(12, '0');
}

// Count existing transactions (fast check for empty DB)
export const getTransactionCount = async () => {
  const db = getDB();
  const res = await db.query('SELECT COUNT(*) as n FROM transactions', []);
  return (res.values?.[0]?.n) ?? 0;
};

// Analyse rows before import:
//   fileDupeCount  = rows with identical stableKey within the file itself
//   dbDupeCount    = rows whose stableKey already exists in the DB (merge scenario)
export const analyseImport = async (rows) => {
  const seenKeys = new Map(); // stableKey → count
  const itemKeys = [];

  for (const r of rows) {
    const dateVal = r.Date || r.date || '';
    if (!dateVal && !(r.INR || r.Amount || r.inr || r.amount)) { itemKeys.push(null); continue; }
    const typeStr = normaliseType(r['Income/Expense'] || r.type || '');
    const isXfer  = typeStr.startsWith('Transfer');
    const acctName = isXfer
      ? String(r.FromAccount || r.from_account || '').trim()
      : String(r.Account     || r.account      || '').trim();
    const stableKey = `${dateVal}|${String(r.Time||r.time||'').trim()}|${acctName}|${parseFloat(r.INR||r.Amount||r.inr||r.amount||0)}|${String(r.Note||r.note||'').trim()}`;
    itemKeys.push(stableKey);
    seenKeys.set(stableKey, (seenKeys.get(stableKey) || 0) + 1);
  }

  // In-file duplicates: same stableKey appears more than once
  const fileDupeKeys = new Set([...seenKeys.entries()].filter(([,v])=>v>1).map(([k])=>k));
  const fileDupeCount = itemKeys.filter(k => k && fileDupeKeys.has(k)).length;

  // In-DB duplicates: stableKey already exists in the database
  let dbDupeCount = 0;
  try {
    const db = getDB();
    const existing = await db.query('SELECT id FROM transactions', []);
    const existingIds = new Set((existing.values || []).map(r => r.id));
    for (const key of itemKeys) {
      if (!key) continue;
      const id = deterministicId(key);
      if (existingIds.has(id)) dbDupeCount++;
    }
  } catch { /* DB might not have data yet */ }

  return { total: rows.filter((_,i) => itemKeys[i] !== null).length, fileDupeCount, dbDupeCount };
};

export const bulkImport = async (rows, { firstImport = false } = {}) => {
  const db  = getDB();
  const now = new Date().toISOString();
  let imported = 0, skipped = 0;

  // Prepare all objects first (avoid per-row async overhead)
  const items = [];
  for (const r of rows) {
    // Skip header-looking or blank rows
    const dateVal = r.Date || r.date || '';
    if (!dateVal && !(r.INR || r.Amount || r.inr || r.amount)) { skipped++; continue; }

    // Determine type early — needed for account field mapping below
    const typeStr = normaliseType(r['Income/Expense'] || r.type || '');
    const isXfer  = typeStr.startsWith('Transfer');

    // ── Account field mapping ──────────────────────────────────────────────
    // Money Manager XLS column structure (confirmed from real export):
    //   Col 1 "Account"  = source account (always a real account name like "Canara", "HDFC")
    //   Col 2 "Category" = destination account for Transfer type, expense category otherwise
    //   Col 10 "Account" = DUPLICATE column containing INR amount as text — ignored by parser
    //
    // There is NO FromAccount / ToAccount in this file format.
    // SheetJS duplicate header handling renames col 10 to "Account_2" so r.Account = col 1.
    const rawAcct = String(r.Account || r.account || '').trim();
    // Guard: if Account still looks numeric (old data), fall back to FromAccount if available
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
    const acctName = looksNumeric(rawAcct)
      ? String(r.FromAccount || r.from_account || rawAcct).trim()
      : rawAcct;
    // For Transfer: Category = destination account name
    // For Expense/Income: no to_account
    const toAcctName = isXfer
      ? String(r.Category || r.category || r.ToAccount || r.to_account || '').trim()
      : '';

    // ID strategy:
    //  • firstImport (empty DB) → always use uuid so intentional in-file duplicates
    //    get unique IDs and all rows are inserted.
    //  • merge → deterministic hash from key fields so the same transaction
    //    always maps to the same ID and INSERT OR IGNORE skips true duplicates.
    const stableKey = `${dateVal}|${String(r.Time||r.time||'').trim()}|${acctName}|${parseFloat(r.INR||r.Amount||r.inr||r.amount||0)}|${String(r.Note||r.note||'').trim()}`;
    const id = r.ID || r.id || (firstImport ? uuid() : deterministicId(stableKey));
    items.push({
      id,
      date:         normaliseDateStr(dateVal),
      time:         String(r.Time || r.time || '').trim(),
      account:      acctName,
      from_account: acctName,   // same as account; kept for query/filter compatibility
      to_account:   toAcctName,
      category:     String(r.Category || r.category || '').trim(),
      subcategory:  String(r.Subcategory || r.subcategory || '').trim(),
      note:         String(r.Note || r.note || '').trim(),
      description:  String(r.Description || r.description || '').trim(),
      inr:          parseFloat(r.INR || r.Amount || r.inr || r.amount || 0),
      amount:       String(r.Amount || r.INR || r.amount || r.inr || '0').trim(),
      currency:     String(r.Currency || r.currency || 'INR').trim(),
      type:         typeStr,
      created_at:   now,
      updated_at:   now,
    });
  }

  // Use fast bulk insert if available (web/IDB), fall back to row-by-row for SQLite
  if (typeof db.bulkInsertIgnore === 'function') {
    const res = await db.bulkInsertIgnore('transactions', items);
    imported = res.added;
    skipped += res.skipped;
  } else {
    for (const obj of items) {
      try {
        const res = await db.run(
          `INSERT OR IGNORE INTO transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [obj.id, obj.date, obj.time, obj.account, obj.from_account, obj.to_account,
           obj.category, obj.subcategory, obj.note, obj.description,
           obj.inr, obj.amount, obj.currency, obj.type, obj.created_at, obj.updated_at]
        );
        if (res.changes?.changes > 0) imported++; else skipped++;
      } catch { skipped++; }
    }
  }

  return { imported, skipped, total: rows.length };
};
