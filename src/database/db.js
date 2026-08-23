/**
 * db.js — IndexedDB (web) | SQLite (Android)
 * v2.1.2 — stable merge IDs, date fixes for bulk import, settings keyPath
 */
import { Capacitor } from '@capacitor/core';

const IDB_NAME    = 'finman_v2';
const IDB_VERSION = 10; // v10 — sub_accounts table

// Each store and its primary key field
const STORE_DEFS = [
  { name:'transactions',    key:'id'  },
  { name:'accounts',        key:'id'  },
  { name:'account_groups',  key:'id'  },
  { name:'account_mapping', key:'id'  },
  { name:'categories',      key:'id'  },
  { name:'subcategories',   key:'id'  },
  { name:'sub_accounts',    key:'id'  },
  { name:'budgets',         key:'id'  },
  { name:'settings',        key:'key' }, // settings uses 'key' not 'id'
  { name:'recurring_rules',  key:'id'  },
  { name:'inventory',       key:'id'  },
];

const storeKey = (store) => STORE_DEFS.find(s => s.name === store)?.key ?? 'id';

let _idb = null;
const openIDB = () => new Promise((res, rej) => {
  if (_idb) { res(_idb); return; }
  const req = indexedDB.open(IDB_NAME, IDB_VERSION);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    STORE_DEFS.forEach(({ name, key }) => {
      if (db.objectStoreNames.contains(name)) {
        try {
          const store = e.target.transaction.objectStore(name);
          // If keyPath is wrong, delete and recreate (loses data — intentional for schema fix)
          if (store.keyPath !== key) {
            db.deleteObjectStore(name);
            db.createObjectStore(name, { keyPath: key });
          }
        } catch { /* store already recreated */ }
      } else {
        db.createObjectStore(name, { keyPath: key });
      }
    });
  };
  req.onsuccess = e => { _idb = e.target.result; res(_idb); };
  req.onerror   = e => rej(e.target.error);
});

// Low-level IDB helpers
const idbAll    = (db, store)       => new Promise((res, rej) => { const r=db.transaction(store,'readonly').objectStore(store).getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); });
const idbGet    = (db, store, id)   => new Promise((res, rej) => { const r=db.transaction(store,'readonly').objectStore(store).get(id);  r.onsuccess=()=>res(r.result);    r.onerror=()=>rej(r.error); });
const idbPut    = (db, store, obj)  => new Promise((res, rej) => { const r=db.transaction(store,'readwrite').objectStore(store).put(obj); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
const idbDelete = (db, store, id)   => new Promise((res, rej) => { const r=db.transaction(store,'readwrite').objectStore(store).delete(id); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });
const idbClear  = (db, store)       => new Promise((res, rej) => { const r=db.transaction(store,'readwrite').objectStore(store).clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });

// Batch put — open ONE transaction for all items (fast bulk insert)
const idbPutBatch = (db, store, items) => new Promise((res, rej) => {
  if (!items.length) { res(0); return; }
  const tx = db.transaction(store, 'readwrite');
  const st = tx.objectStore(store);
  let added = 0;
  tx.oncomplete = () => res(added);
  tx.onerror    = () => rej(tx.error);
  items.forEach(obj => {
    const r = st.put(obj);
    r.onsuccess = () => added++;
  });
});

// Simple WHERE parser for our SQL subset
const parseWhere = (clause, vals) => {
  let vi = 0;
  return clause.split(/\s+AND\s+/i).map(p => {
    const lm = p.trim().match(/^(\w+)\s+LIKE\s+\?/i);
    const em = p.trim().match(/^(\w+)\s*=\s*\?/);
    const om = p.trim().match(/^\((.+)\)/);  // OR groups like (a=? OR b=? OR c=?)
    if (lm) return { col:lm[1], op:'LIKE', val:vals[vi++] };
    if (em) return { col:em[1], op:'=',    val:vals[vi++] };
    if (om) {
      // parse OR sub-conditions
      const subs = om[1].split(/\s+OR\s+/i).map(sp => {
        const sm = sp.trim().match(/^(\w+)\s*=\s*\?/);
        const sl = sp.trim().match(/^(\w+)\s+LIKE\s+\?/i);
        if (sm) return { col:sm[1], op:'=',    val:vals[vi++] };
        if (sl) return { col:sl[1], op:'LIKE', val:vals[vi++] };
        return null;
      }).filter(Boolean);
      return { op:'OR', subs };
    }
    return null;
  }).filter(Boolean);
};

const matchCond = (row, c) => {
  if (c.op === 'OR')   return c.subs.some(s => matchCond(row, s));
  const rv = String(row[c.col] ?? '');
  if (c.op === '=')    return rv === String(c.val ?? '');
  if (c.op === 'LIKE') return new RegExp('^' + String(c.val ?? '').replace(/%/g,'.*').replace(/_/g,'.') + '$','i').test(rv);
  return true;
};
const matchConds = (row, conds) => conds.every(c => matchCond(row, c));

const parseAndRun = async (db, sql, vals = []) => {
  const s = sql.trim().replace(/\s+/g,' '), u = s.toUpperCase();
  if (/^(PRAGMA|CREATE TABLE|CREATE INDEX|ALTER TABLE)/.test(u)) return { values:[], changes:{changes:0} };

  // ── SELECT ──
  if (u.startsWith('SELECT')) {
    const fm = s.match(/FROM\s+(\w+)/i); if (!fm) return { values:[] };
    let rows = await idbAll(db, fm[1]);
    const wm = s.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
    if (wm) {
      const c = parseWhere(wm[1], vals);
      rows = rows.filter(r => matchConds(r, c));
    }
    const om = s.match(/ORDER BY\s+([\w,\s]+?)(?:\s+LIMIT|$)/i);
    if (om) {
      const parts = om[1].trim().split(',').map(p => { const [col,dir]=p.trim().split(/\s+/); return {col,desc:(dir||'').toUpperCase()==='DESC'}; });
      rows.sort((a,b) => { for(const {col,desc} of parts){const av=a[col]??'',bv=b[col]??'';const cmp=av<bv?-1:av>bv?1:0;if(cmp)return desc?-cmp:cmp;} return 0; });
    }
    const lm = s.match(/LIMIT\s+(\d+)/i); if (lm) rows = rows.slice(0, +lm[1]);
    return { values: rows };
  }

  // ── INSERT ──
  if (u.startsWith('INSERT')) {
    const orIgnore  = /INSERT OR IGNORE/i.test(s);
    const orReplace = /INSERT OR REPLACE/i.test(s);
    const tm = s.match(/INTO\s+(\w+)/i);          if (!tm) return { changes:{changes:0} };
    const cm = s.match(/\(([^)]+)\)\s+VALUES/i);  if (!cm) return { changes:{changes:0} };
    const cols = cm[1].split(',').map(c => c.trim());
    const obj  = {};
    cols.forEach((col, i) => { obj[col] = vals[i] ?? null; });
    const pk = storeKey(tm[1]);

    if (orIgnore) {
      // Check if record with this PK already exists
      let exists = false;
      try { exists = (await idbGet(db, tm[1], obj[pk])) !== undefined; } catch {}
      if (exists) return { changes:{changes:0} };
    }
    if (orReplace) {
      try { await idbDelete(db, tm[1], obj[pk]); } catch {}
    }
    await idbPut(db, tm[1], obj);
    return { changes:{changes:1} };
  }

  // ── UPDATE ──
  if (u.startsWith('UPDATE')) {
    const tm = s.match(/UPDATE\s+(\w+)\s+SET/i);       if (!tm) return { changes:{changes:0} };
    const sm = s.match(/SET\s+(.+?)\s+WHERE/i);
    const wm = s.match(/WHERE\s+(.+)$/i);
    if (!sm || !wm) return { changes:{changes:0} };
    const setCols = sm[1].split(',').map(p => p.trim().split(/\s*=\s*\?/)[0].trim());
    const setVals = vals.slice(0, setCols.length);
    const conds   = parseWhere(wm[1], vals.slice(setCols.length));
    const pk = storeKey(tm[1]);
    let changed = 0;
    for (const row of await idbAll(db, tm[1])) {
      if (matchConds(row, conds)) {
        const upd = { ...row };
        setCols.forEach((col,i) => { upd[col] = setVals[i] ?? null; });
        await idbPut(db, tm[1], upd); changed++;
      }
    }
    return { changes:{changes:changed} };
  }

  // ── DELETE ──
  if (u.startsWith('DELETE')) {
    const tm = s.match(/FROM\s+(\w+)/i); if (!tm) return { changes:{changes:0} };
    const wm = s.match(/WHERE\s+(.+)$/i);
    if (!wm) { await idbClear(db, tm[1]); return { changes:{changes:1} }; }
    const pk = storeKey(tm[1]);
    const conds = parseWhere(wm[1], vals); let changed = 0;
    for (const row of await idbAll(db, tm[1])) {
      if (matchConds(row, conds)) { await idbDelete(db, tm[1], row[pk]); changed++; }
    }
    return { changes:{changes:changed} };
  }

  return { values:[], changes:{changes:0} };
};

// Exposed web DB object
const makeWebDB = (idb) => ({
  query:       (sql, vals=[]) => parseAndRun(idb, sql, vals),
  run:         (sql, vals=[]) => parseAndRun(idb, sql, vals),
  execute:     (sql)          => parseAndRun(idb, sql, []),
  open:        async () => {},
  // Fast bulk insert — bypasses the slow one-by-one INSERT OR IGNORE in parseAndRun
  bulkInsertIgnore: async (store, items) => {
    if (!items.length) return { added:0, skipped:0 };
    const pk    = storeKey(store);
    const exist = new Set((await idbAll(idb, store)).map(r => r[pk]));
    const news  = items.filter(r => r[pk] && !exist.has(r[pk]));
    await idbPutBatch(idb, store, news);
    return { added: news.length, skipped: items.length - news.length };
  },
});

// ── SQLite (Android) ──────────────────────────────────────────────────────────
const DB_NAME = 'finman_v2';
const openSQLite = async () => {
  const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
  const sqlite = new SQLiteConnection(CapacitorSQLite);

  let db;
  try {
    const isConn = (await sqlite.isConnection(DB_NAME, false)).result;
    db = isConn
      ? await sqlite.retrieveConnection(DB_NAME, false)
      : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  } catch {
    db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  }

  await db.open();

  // PRAGMA journal_mode=WAL returns a result row → must use query() not execute()
  // execute() on Android maps to execSQL() which rejects any SELECT-returning statement
  try { await db.query('PRAGMA journal_mode=WAL;'); } catch (e) { console.warn('WAL pragma skipped:', e?.message); }

  db.bulkInsertIgnore = null; // SQLite falls back to row-by-row insert path
  return db;
};

const applySchema = async (db) => {
  await db.execute(`CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY,date TEXT NOT NULL,time TEXT DEFAULT '',account TEXT DEFAULT '',from_account TEXT DEFAULT '',to_account TEXT DEFAULT '',category TEXT DEFAULT '',subcategory TEXT DEFAULT '',note TEXT DEFAULT '',description TEXT DEFAULT '',inr REAL DEFAULT 0,amount TEXT DEFAULT '0',currency TEXT DEFAULT 'INR',type TEXT DEFAULT 'Expense',created_at TEXT,updated_at TEXT,recurring_rule_id TEXT DEFAULT '',tags TEXT DEFAULT '',split_group_id TEXT DEFAULT '',receipt_image TEXT DEFAULT '',warranty_expiry TEXT DEFAULT '',serial_no TEXT DEFAULT '',sub_account TEXT DEFAULT '',from_sub_account TEXT DEFAULT '',to_sub_account TEXT DEFAULT '');`);
  try { await db.run(`ALTER TABLE transactions ADD COLUMN description TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN time TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN recurring_rule_id TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN tags TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN split_group_id TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN receipt_image TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN warranty_expiry TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN serial_no TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN sub_account TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN from_sub_account TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE transactions ADD COLUMN to_sub_account TEXT DEFAULT ''`); } catch {}
  await db.execute(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY,name TEXT NOT NULL,group_name TEXT DEFAULT '',sort_order INTEGER DEFAULT 0,created_at TEXT,acct_type TEXT DEFAULT '',settlement_date INTEGER DEFAULT 0,payment_due_days INTEGER DEFAULT 0,is_asset INTEGER DEFAULT 1,card_last4 TEXT DEFAULT '');`);
  try { await db.execute(`ALTER TABLE accounts ADD COLUMN acct_type TEXT DEFAULT '';`); } catch {}
  try { await db.execute(`ALTER TABLE accounts ADD COLUMN settlement_date INTEGER DEFAULT 0;`); } catch {}
  try { await db.execute(`ALTER TABLE accounts ADD COLUMN payment_due_days INTEGER DEFAULT 0;`); } catch {}
  try { await db.execute(`ALTER TABLE accounts ADD COLUMN is_asset INTEGER DEFAULT 1;`); } catch {}
  try { await db.execute(`ALTER TABLE accounts ADD COLUMN card_last4 TEXT DEFAULT '';`); } catch {}
  try { await db.run(`ALTER TABLE accounts ADD COLUMN card_last4 TEXT DEFAULT ''`); } catch {}
  await db.execute(`CREATE TABLE IF NOT EXISTS account_groups (id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_order INTEGER DEFAULT 0);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS account_mapping (id TEXT PRIMARY KEY,source_name TEXT,account_name TEXT);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT DEFAULT 'Expense',sort_order INTEGER DEFAULT 0);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS subcategories (id TEXT PRIMARY KEY,name TEXT NOT NULL,category_id TEXT NOT NULL,sort_order INTEGER DEFAULT 0);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sub_accounts (id TEXT PRIMARY KEY,name TEXT NOT NULL,account_id TEXT NOT NULL,sort_order INTEGER DEFAULT 0);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY,category TEXT NOT NULL,amount REAL NOT NULL,period TEXT DEFAULT 'Monthly',created_at TEXT);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS recurring_rules (id TEXT PRIMARY KEY,rule_type TEXT NOT NULL,status TEXT DEFAULT 'active',txn_type TEXT DEFAULT 'Expense',account TEXT DEFAULT '',from_account TEXT DEFAULT '',to_account TEXT DEFAULT '',category TEXT DEFAULT '',subcategory TEXT DEFAULT '',base_note TEXT DEFAULT '',description TEXT DEFAULT '',currency TEXT DEFAULT 'INR',total_amount REAL DEFAULT 0,amount_per_part REAL DEFAULT 0,total_days INTEGER DEFAULT 0,total_parts INTEGER DEFAULT 0,completed_parts INTEGER DEFAULT 0,start_date TEXT DEFAULT '',next_date TEXT DEFAULT '',end_date TEXT DEFAULT '',schedule_mode TEXT DEFAULT 'on_date',frequency TEXT DEFAULT '',created_at TEXT DEFAULT '');`);
  await db.execute(`CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY,name TEXT NOT NULL,qty REAL DEFAULT 0,unit TEXT DEFAULT '',price REAL DEFAULT 0,discounted_price REAL DEFAULT 0,status TEXT DEFAULT 'available',purchased_date TEXT DEFAULT '',notes TEXT DEFAULT '',updated_at TEXT,sub_qty REAL DEFAULT 1,sub_unit TEXT DEFAULT '',original_qty REAL DEFAULT 0,pack_qty REAL DEFAULT 1,discount_type TEXT DEFAULT 'percentage',discount_value REAL DEFAULT 0);`);
  try { await db.run(`ALTER TABLE inventory ADD COLUMN sub_qty REAL DEFAULT 1`); } catch {}
  try { await db.run(`ALTER TABLE inventory ADD COLUMN sub_unit TEXT DEFAULT ''`); } catch {}
  try { await db.run(`ALTER TABLE inventory ADD COLUMN original_qty REAL DEFAULT 0`); } catch {}
  try { await db.run(`ALTER TABLE inventory ADD COLUMN pack_qty REAL DEFAULT 1`); } catch {}
  try { await db.run(`ALTER TABLE inventory ADD COLUMN discount_type TEXT DEFAULT 'percentage'`); } catch {}
  try { await db.run(`ALTER TABLE inventory ADD COLUMN discount_value REAL DEFAULT 0`); } catch {}
};

let _db = null;
export const initDB = async () => {
  if (_db) return _db;
  if (Capacitor.getPlatform() === 'web') {
    const idb = await openIDB();
    _db = makeWebDB(idb);
  } else {
    _db = await openSQLite();
  }
  await applySchema(_db);
  return _db;
};
export const getDB = () => { if (!_db) throw new Error('DB not initialised'); return _db; };