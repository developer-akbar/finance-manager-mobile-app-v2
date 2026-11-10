/**
 * db.js — IndexedDB (web) | SQLite (Android)
 * v2.1.2 — stable merge IDs, date fixes for bulk import, settings keyPath
 */
import { Capacitor } from '@capacitor/core';

const IDB_NAME    = 'finman_v2';
const IDB_VERSION = 17; // v17 — transaction_bookmarks store

// Each store and its primary key field
export const STORE_DEFS = [
  { name:'transactions',            key:'id'  },
  { name:'accounts',                key:'id'  },
  { name:'account_groups',          key:'id'  },
  { name:'account_mapping',         key:'id'  },
  { name:'categories',              key:'id'  },
  { name:'subcategories',           key:'id'  },
  { name:'sub_accounts',            key:'id'  },
  { name:'budgets',                 key:'id'  },
  { name:'settings',                key:'key' }, // settings uses 'key' not 'id'
  { name:'recurring_rules',          key:'id'  },
  { name:'inventory',               key:'id'  },
  { name:'investment_transactions', key:'id'  },
  { name:'brokerages',              key:'id'  },
  { name:'investment_plans',         key:'id'  },
  { name:'transaction_bookmarks',   key:'id'  },
  { name:'sync_tombstones',         key:'id'  },
  { name:'sync_delta_queue',        key:'event_id' },
  { name:'sync_local_state',        key:'key' },
  { name:'sync_staged_packages',    key:'package_id' },
  { name:'sync_staged_events',      key:'event_id' },
  { name:'sync_peer_state',         key:'peer_device_id' },
  { name:'sync_process_locks',      key:'lock_name' },
  { name:'sync_conflicts',          key:'conflict_id' },
];

export const SYNCED_SETTINGS_WHITELIST = [
  'customTags',
  'theme',
  'headerColor',
  'fontSize',
  'fontFamily',
  'fontDataWeight',
  'default_currency',
  'budget_start_day',
  'portfolio_benchmark',
  'profileName',
  'name'
];

const storeKey = (store) => STORE_DEFS.find(s => s.name === store)?.key ?? 'id';

let _idb = null;

export const closeDB = () => {
  if (_idb) {
    try { _idb.close(); } catch {}
    _idb = null;
  }
  _db = null;
  _initPromise = null;
};

export const getRawIDB = () => _idb;
export const setRawIDB = (val) => { _idb = val; };
export const openIDBInstance = () => openIDB();

const openIDB = () => new Promise((res, rej) => {
  if (_idb) { res(_idb); return; }
  let settled = false;
  let blockTimeout = null;

  const req = indexedDB.open(IDB_NAME, IDB_VERSION);

  req.onblocked = () => {
    console.warn('[DB] IndexedDB open/upgrade blocked by active connection in another tab or instance.');
    if (!blockTimeout) {
      blockTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          rej(new Error('IndexedDB upgrade blocked. Please close other open FinMan tabs and reload.'));
        }
      }, 5000);
    }
  };

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

  req.onsuccess = e => {
    if (blockTimeout) clearTimeout(blockTimeout);
    if (settled) return;
    settled = true;
    _idb = e.target.result;

    // Register versionchange listener to immediately close stale connection when another tab upgrades
    _idb.onversionchange = () => {
      console.warn('[DB] Database version change detected. Closing stale connection.');
      try { _idb.close(); } catch {}
      _idb = null;
      _db = null;
    };

    res(_idb);
  };

  req.onerror = e => {
    if (blockTimeout) clearTimeout(blockTimeout);
    if (settled) return;
    settled = true;
    rej(e.target.error || new Error('Failed to open IndexedDB'));
  };
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
    const trimmed = p.trim();
    if (/^1\s*=\s*1$/.test(trimmed)) return null;

    const notInM = trimmed.match(/^([a-zA-Z_]\w*)\s+NOT\s+IN\s*\(([^)]+)\)/i);
    const inM = trimmed.match(/^([a-zA-Z_]\w*)\s+IN\s*\(([^)]+)\)/i);
    const neqLit = trimmed.match(/^([a-zA-Z_]\w*)\s*(?:!=|<>)\s*['"]([^'"]*)['"]/);
    const neqNum = trimmed.match(/^([a-zA-Z_]\w*)\s*(?:!=|<>)\s*(\d+(?:\.\d+)?)/);
    const neq = trimmed.match(/^([a-zA-Z_]\w*)\s*(?:!=|<>)\s*\?/);
    const lm  = trimmed.match(/^([a-zA-Z_]\w*)\s+LIKE\s+\?/i);
    const lte = trimmed.match(/^([a-zA-Z_]\w*)\s*<=\s*\?/);
    const gte = trimmed.match(/^([a-zA-Z_]\w*)\s*>=\s*\?/);
    const lt  = trimmed.match(/^([a-zA-Z_]\w*)\s*<\s*\?/);
    const gt  = trimmed.match(/^([a-zA-Z_]\w*)\s*>\s*\?/);
    const lowerEm = trimmed.match(/^LOWER\(([a-zA-Z_]\w*)\)\s*=\s*\?/i);
    const emLit = trimmed.match(/^([a-zA-Z_]\w*)\s*=\s*['"]([^'"]*)['"]/);
    const emNum = trimmed.match(/^([a-zA-Z_]\w*)\s*=\s*(\d+(?:\.\d+)?)/);
    const em  = trimmed.match(/^([a-zA-Z_]\w*)\s*=\s*\?/);
    const om  = trimmed.match(/^\((.+)\)/);  // OR groups like (a=? OR b=? OR c=?)
    if (notInM) {
      const inner = notInM[2].trim();
      let notInVals;
      if (inner.includes('?')) {
        const qCount = (inner.match(/\?/g) || []).length;
        notInVals = vals.slice(vi, vi + qCount);
        vi += qCount;
      } else {
        notInVals = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      }
      return { col: notInM[1], op: 'NOT IN', val: notInVals };
    }
    if (inM) {
      const inner = inM[2].trim();
      let inVals;
      if (inner.includes('?')) {
        const qCount = (inner.match(/\?/g) || []).length;
        inVals = vals.slice(vi, vi + qCount);
        vi += qCount;
      } else {
        inVals = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      }
      return { col: inM[1], op: 'IN', val: inVals };
    }
    if (neqLit) return { col:neqLit[1], op:'!=', val:neqLit[2] };
    if (neqNum) return { col:neqNum[1], op:'!=', val:Number(neqNum[2]) };
    if (neq) return { col:neq[1], op:'!=',   val:vals[vi++] };
    if (lm)  return { col:lm[1],  op:'LIKE', val:vals[vi++] };
    if (lte) return { col:lte[1], op:'<=',   val:vals[vi++] };
    if (gte) return { col:gte[1], op:'>=',   val:vals[vi++] };
    if (lt)  return { col:lt[1],  op:'<',    val:vals[vi++] };
    if (gt)  return { col:gt[1],  op:'>',    val:vals[vi++] };
    if (lowerEm) return { col:lowerEm[1], op:'LOWER_EQ', val:vals[vi++] };
    if (emLit) return { col:emLit[1], op:'=', val:emLit[2] };
    if (emNum) return { col:emNum[1], op:'=', val:Number(emNum[2]) };
    if (em)  return { col:em[1],  op:'=',    val:vals[vi++] };
    if (om) {
      // parse OR sub-conditions
      const subs = om[1].split(/\s+OR\s+/i).map(sp => {
        const slm = sp.trim().match(/^LOWER\(([a-zA-Z_]\w*)\)\s*=\s*\?/i);
        const sm = sp.trim().match(/^([a-zA-Z_]\w*)\s*=\s*\?/);
        const sl = sp.trim().match(/^([a-zA-Z_]\w*)\s+LIKE\s+\?/i);
        if (slm) return { col:slm[1], op:'LOWER_EQ', val:vals[vi++] };
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
  const rawVal = row[c.col];
  const rv = String(rawVal ?? '');
  if (c.op === 'NOT IN') return Array.isArray(c.val) && !c.val.map(x => String(x ?? '')).includes(rv);
  if (c.op === 'IN')   return Array.isArray(c.val) && c.val.map(x => String(x ?? '')).includes(rv);
  if (c.op === '!=')   return rv !== String(c.val ?? '');
  if (c.op === 'LOWER_EQ') return rv.toLowerCase() === String(c.val ?? '').toLowerCase();
  if (c.op === '=')    return rv === String(c.val ?? '');
  if (c.op === '<=') {
    const n1 = Number(rawVal), n2 = Number(c.val);
    if (!isNaN(n1) && !isNaN(n2) && typeof rawVal === 'number') return n1 <= n2;
    return rv <= String(c.val ?? '');
  }
  if (c.op === '>=') {
    const n1 = Number(rawVal), n2 = Number(c.val);
    if (!isNaN(n1) && !isNaN(n2) && typeof rawVal === 'number') return n1 >= n2;
    return rv >= String(c.val ?? '');
  }
  if (c.op === '<') {
    const n1 = Number(rawVal), n2 = Number(c.val);
    if (!isNaN(n1) && !isNaN(n2) && typeof rawVal === 'number') return n1 < n2;
    return rv < String(c.val ?? '');
  }
  if (c.op === '>') {
    const n1 = Number(rawVal), n2 = Number(c.val);
    if (!isNaN(n1) && !isNaN(n2) && typeof rawVal === 'number') return n1 > n2;
    return rv > String(c.val ?? '');
  }
  if (c.op === 'LIKE') return new RegExp('^' + String(c.val ?? '').replace(/%/g,'.*').replace(/_/g,'.') + '$','i').test(rv);
  return true;
};
const matchConds = (row, conds) => conds.every(c => matchCond(row, c));

const parseAndRun = async (db, sql, vals = []) => {
  const s = sql.trim().replace(/\s+/g,' '), u = s.toUpperCase();
  if (/^(PRAGMA|CREATE TABLE|CREATE INDEX|ALTER TABLE)/.test(u)) return { values:[], changes:{changes:0} };

  // ── SELECT ──
  if (u.startsWith('SELECT')) {
    // Support subquery UNION count: SELECT COUNT(*) AS count FROM ( SELECT id FROM transactions UNION SELECT id FROM investment_transactions )
    if (/SELECT\s+COUNT\(\*\).+FROM\s*\(\s*SELECT\s+id\s+FROM\s+(?:main\.)?transactions\s+UNION\s+SELECT\s+id\s+FROM\s+(?:main\.)?investment_transactions\s*\)/i.test(s)) {
      const [tRows, invRows] = await Promise.all([
        idbAll(db, 'transactions'),
        idbAll(db, 'investment_transactions')
      ]);
      const uniqueIds = new Set([
        ...tRows.map(r => r.id).filter(Boolean),
        ...invRows.map(r => r.id).filter(Boolean)
      ]);
      const aliasMatch = s.match(/SELECT\s+COUNT\(\*\)(?:\s+AS\s+(\w+))?/i);
      const alias = aliasMatch?.[1] || 'count';
      return { values: [{ [alias]: uniqueIds.size, count: uniqueIds.size }] };
    }

    const fm = s.match(/FROM\s+(?:main\.)?(\w+)/i); if (!fm) return { values:[] };
    const store = fm[1];
    if (store === 'sqlite_master') {
      return { values: STORE_DEFS.map(s => ({ name: s.name })) };
    }
    const pk = storeKey(store);
    const wm = s.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
    let rows;

    // Fast-path: Single primary key equality lookup (e.g. WHERE id = ? or WHERE key = ?)
    // Bypasses loading all 29,000+ records into memory when checking a single entity
    if (wm && pk && vals.length === 1 && wm[1].trim().toLowerCase() === `${pk.toLowerCase()} = ?`) {
      const single = await idbGet(db, store, vals[0]);
      rows = single !== undefined ? [single] : [];
    } else {
      rows = await idbAll(db, store);
      if (wm) {
        const c = parseWhere(wm[1], vals);
        rows = rows.filter(r => matchConds(r, c));
      }
    }

    const om = s.match(/ORDER BY\s+([\w,\s]+?)(?:\s+LIMIT|$)/i);
    if (om) {
      const parts = om[1].trim().split(',').map(p => { const [col,dir]=p.trim().split(/\s+/); return {col,desc:(dir||'').toUpperCase()==='DESC'}; });
      rows.sort((a,b) => { for(const {col,desc} of parts){const av=a[col]??'',bv=b[col]??'';const cmp=av<bv?-1:av>bv?1:0;if(cmp)return desc?-cmp:cmp;} return 0; });
    }
    if (/SELECT\s+COUNT\(\*\)/i.test(s)) {
      const aliasMatch = s.match(/SELECT\s+COUNT\(\*\)(?:\s+AS\s+(\w+))?/i);
      const alias = aliasMatch?.[1] || 'count';
      return { values: [{ [alias]: rows.length, count: rows.length }] };
    }

    const maxMatch = s.match(/SELECT\s+MAX\((\w+)\)(?:\s+AS\s+(\w+))?/i);
    if (maxMatch) {
      const col = maxMatch[1];
      const alias = maxMatch[2] || `max_${col}`;
      const maxVal = rows.reduce((max, r) => {
        const val = Number(r[col]);
        return (!isNaN(val) && val > max) ? val : max;
      }, 0);
      return { values: [{ [alias]: maxVal, max: maxVal, max_seq: maxVal }] };
    }

    const minMatch = s.match(/SELECT\s+MIN\((\w+)\)(?:\s+AS\s+(\w+))?/i);
    if (minMatch) {
      const col = minMatch[1];
      const alias = minMatch[2] || `min_${col}`;
      const minVal = rows.reduce((min, r) => {
        const val = Number(r[col]);
        return (!isNaN(val) && val < min) ? val : min;
      }, Infinity);
      const finalMin = minVal === Infinity ? 0 : minVal;
      return { values: [{ [alias]: finalMin, min: finalMin }] };
    }

    const lm = s.match(/LIMIT\s+(\d+)/i); if (lm) rows = rows.slice(0, +lm[1]);
    return { values: rows };
  }

  // ── INSERT ──
  if (u.startsWith('INSERT')) {
    const orIgnore  = /INSERT OR IGNORE/i.test(s);
    const orReplace = /INSERT OR REPLACE/i.test(s);
    const tm = s.match(/INTO\s+(?:main\.)?(\w+)/i);          if (!tm) return { changes:{changes:0} };
    const cm = s.match(/\(([^)]+)\)\s+VALUES/i);  if (!cm) return { changes:{changes:0} };
    const cols = cm[1].split(',').map(c => c.trim());
    let insertVals = vals;
    if (!insertVals || insertVals.length === 0) {
      const vm = s.match(/VALUES\s*\(([^)]+)\)/i);
      if (vm) {
        insertVals = vm[1].split(',').map(v => {
          const t = v.trim();
          if (/^['"].*['"]$/.test(t)) return t.slice(1, -1);
          if (!isNaN(Number(t))) return Number(t);
          if (t.toLowerCase() === 'null') return null;
          return t;
        });
      }
    }
    const obj  = {};
    cols.forEach((col, i) => { obj[col] = insertVals[i] ?? null; });
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
    const tm = s.match(/UPDATE\s+(?:main\.)?(\w+)\s+SET/i); if (!tm) return { changes:{changes:0} };
    const sm = s.match(/SET\s+(.+?)\s+WHERE/i);
    const wm = s.match(/WHERE\s+(.+)$/i);
    if (!sm || !wm) return { changes:{changes:0} };
    const setCols = sm[1].split(',').map(p => p.trim().split(/\s*=\s*\?/)[0].trim());
    const setVals = vals.slice(0, setCols.length);
    const condVals = vals.slice(setCols.length);
    const pk = storeKey(tm[1]);
    let changed = 0;

    // Fast-path: Single primary key equality update (WHERE id = ? or WHERE key = ?)
    if (pk && condVals.length === 1 && wm[1].trim().toLowerCase() === `${pk.toLowerCase()} = ?`) {
      const existing = await idbGet(db, tm[1], condVals[0]);
      if (existing) {
        const upd = { ...existing };
        setCols.forEach((col, i) => { upd[col] = setVals[i] ?? null; });
        await idbPut(db, tm[1], upd);
        changed = 1;
      }
      return { changes: { changes: changed } };
    }

    const conds = parseWhere(wm[1], condVals);
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
    const tm = s.match(/FROM\s+(?:main\.)?(\w+)/i); if (!tm) return { changes:{changes:0} };
    const wm = s.match(/WHERE\s+(.+)$/i);
    if (!wm) { await idbClear(db, tm[1]); return { changes:{changes:1} }; }
    const pk = storeKey(tm[1]);

    // Fast-path: Single primary key equality delete (WHERE id = ? or WHERE key = ?)
    if (pk && vals.length === 1 && wm[1].trim().toLowerCase() === `${pk.toLowerCase()} = ?`) {
      await idbDelete(db, tm[1], vals[0]);
      return { changes: { changes: 1 } };
    }

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
  // Atomic store replacement — clears and puts all items in ONE IDB transaction
  batchReplace: async (store, items) => {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = idb.transaction(store, 'readwrite');
        const st = tx.objectStore(store);
        st.clear();
        let added = 0;
        if (Array.isArray(items) && items.length > 0) {
          items.forEach(obj => {
            st.put(obj);
            added++;
          });
        }
        tx.oncomplete = () => resolve({ replaced: added });
        tx.onerror = () => {
          try { tx.abort(); } catch {}
          reject(tx.error);
        };
        tx.onabort = () => reject(tx.error || new Error(`Transaction aborted for batchReplace(${store})`));
      } catch (err) {
        if (tx) {
          try { tx.abort(); } catch {}
        }
        reject(err);
      }
    });
  },
  isNativeSQLite: false,
  checkSQLiteVersion: async () => ({ version: 'web_idb', isVacuumIntoSupported: false }),
  getDatabasePath: async () => '',
  promoteStagingSnapshot: async (stagingDataOrPath) => {
    let entities = null;
    if (stagingDataOrPath && typeof stagingDataOrPath === 'object') {
      entities = stagingDataOrPath.entities || stagingDataOrPath;
    } else if (typeof globalThis !== 'undefined' && globalThis.__mockStagingDbEntities) {
      entities = globalThis.__mockStagingDbEntities;
    }
    if (entities && typeof entities === 'object') {
      const { populateLocalEntitiesBootstrap } = await import('../services/cloudSyncEngine.js');
      await populateLocalEntitiesBootstrap(makeWebDB(idb), entities, { allowRecoveryReplacement: true });
      const distinctBrokerages = Array.isArray(entities.brokerages)
        ? Array.from(new Set(entities.brokerages.map(b => (b.name || b.NAME || '').trim().toLowerCase()).filter(Boolean)))
        : [];
      return { success: true, promotedTables: Object.keys(entities), distinctBrokerages };
    }
    return { success: true, distinctBrokerages: [] };
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

  db.bulkInsertIgnore = async (store, items) => {
    if (!items.length) return { added: 0, skipped: 0 };
    const sample = items[0];
    const cols = Object.keys(sample);
    const colCount = cols.length;

    // Use multi-row INSERT OR IGNORE batching
    // Standard SQLite parameter limit is 999
    const ROWS_PER_BATCH = Math.max(1, Math.floor(900 / colCount));
    let added = 0;

    try { await db.run('BEGIN TRANSACTION;'); } catch {}

    for (let i = 0; i < items.length; i += ROWS_PER_BATCH) {
      const chunk = items.slice(i, i + ROWS_PER_BATCH);
      const placeholders = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
      const sql = `INSERT OR IGNORE INTO ${store} (${cols.join(',')}) VALUES ${placeholders}`;
      const vals = [];
      for (const row of chunk) {
        for (const col of cols) {
          vals.push(row[col] ?? null);
        }
      }
      try {
        const res = await db.run(sql, vals);
        added += (res.changes?.changes ?? chunk.length);
      } catch (err) {
        console.warn(`bulkInsertIgnore batch failed for ${store}, falling back to single-row:`, err);
        const singleSql = `INSERT OR IGNORE INTO ${store} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
        for (const row of chunk) {
          try {
            const r = await db.run(singleSql, cols.map(c => row[c] ?? null));
            if (r.changes?.changes > 0) added++;
          } catch {}
        }
      }
    }

    try { await db.run('COMMIT;'); } catch {}
    return { added, skipped: items.length - added };
  };

  db.batchReplace = async (store, items) => {
    if (!/^[a-zA-Z0-9_]+$/.test(store)) {
      throw new Error(`Invalid store name: ${store}`);
    }
    await db.run('BEGIN TRANSACTION;');
    try {
      await db.run(`DELETE FROM ${store};`);
      let added = 0;
      if (Array.isArray(items) && items.length > 0) {
        const sample = items[0];
        const cols = Object.keys(sample);
        const colCount = cols.length;
        const ROWS_PER_BATCH = Math.max(1, Math.floor(900 / colCount));
        for (let i = 0; i < items.length; i += ROWS_PER_BATCH) {
          const chunk = items.slice(i, i + ROWS_PER_BATCH);
          const placeholders = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
          const sql = `INSERT INTO ${store} (${cols.join(',')}) VALUES ${placeholders}`;
          const vals = [];
          for (const row of chunk) {
            for (const col of cols) {
              vals.push(row[col] ?? null);
            }
          }
          await db.run(sql, vals);
          added += chunk.length;

          // Cooperative event loop yield every 20 sub-batches (~500 records) to prevent ANR and allow GC
          if ((i / ROWS_PER_BATCH) % 20 === 0 && i > 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      }
      await db.run('COMMIT;');
      return { replaced: added };
    } catch (err) {
      try { await db.run('ROLLBACK;'); } catch {}
      throw err;
    }
  };

  attachNativeBackupMethods(db);
  return db;
};

export const normalizeColumnKey = (name) => {
  if (!name) return '';
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
};

const COLUMN_ALIASES = {
  'positionquantitychange': 'position_qty_change',
  'positionqtychange': 'position_qty_change',
  'incomeexpense': 'type',
  'realizedpl': 'realized_pnl',
  'realizedpnl': 'realized_pnl'
};

export const matchTableColumns = (pragmaTarget = [], pragmaSource = []) => {
  const targetExactMap = new Map();
  const targetNormMap = new Map();

  for (const c of pragmaTarget) {
    const colName = c?.name || c?.NAME;
    if (!colName) continue;
    targetExactMap.set(String(colName).toLowerCase(), colName);
    targetNormMap.set(normalizeColumnKey(colName), colName);
  }

  const matched = [];
  for (const sc of pragmaSource) {
    const sColName = sc?.name || sc?.NAME;
    if (!sColName) continue;
    const lower = String(sColName).toLowerCase();
    const norm = normalizeColumnKey(sColName);

    let targetName = targetExactMap.get(lower) || targetNormMap.get(norm);
    if (!targetName && COLUMN_ALIASES[norm]) {
      const alias = COLUMN_ALIASES[norm];
      targetName = targetExactMap.get(alias) || targetNormMap.get(normalizeColumnKey(alias));
    }

    if (targetName && !matched.some(m => m.target === targetName)) {
      matched.push({ target: targetName, source: sColName });
    }
  }
  return matched;
};

export const attachNativeBackupMethods = (db) => {
  db.isNativeSQLite = true;

  const safeDeleteFile = async (filePath) => {
    if (!filePath) return;
    try {
      const { Filesystem } = await import('@capacitor/filesystem');
      await Filesystem.deleteFile({ path: filePath });
      return;
    } catch {
      if (typeof process !== 'undefined' && process.versions?.node) {
        try {
          const fs = await import('fs');
          if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath).catch(() => {});
          }
        } catch {}
      }
    }
  };

  const safeRenameFile = async (fromPath, toPath) => {
    if (fromPath === toPath) return;
    try {
      const { Filesystem } = await import('@capacitor/filesystem');
      await Filesystem.rename({ from: fromPath, to: toPath });
      return;
    } catch (capErr) {
      if (typeof process !== 'undefined' && process.versions?.node) {
        try {
          const fs = await import('fs');
          if (fs.existsSync(fromPath)) {
            await fs.promises.rename(fromPath, toPath);
            return;
          }
          // In Node test harnesses simulating native SQLite, mocked paths may not exist on disk
          return;
        } catch (fsErr) {
          throw new Error(`File promotion failed from ${fromPath} to ${toPath}: ${fsErr?.message || capErr?.message}`);
        }
      }
      throw capErr;
    }
  };

  // Execute an administrative SQL statement strictly outside any transaction
  // (Required for VACUUM, ATTACH, DETACH, PRAGMA wal_checkpoint, and PRAGMA foreign_keys)
  // Capacitor SQLite defaults transaction to true in run() and execute(), which causes
  // "error code 1: cannot VACUUM from within a transaction".
  const execNonTransactional = async (sql) => {
    if (typeof db.execute === 'function') {
      try {
        return await db.execute(sql, false);
      } catch (execErr) {
        if (typeof db.run === 'function') {
          return await db.run(sql, [], false);
        }
        throw execErr;
      }
    }
    if (typeof db.run === 'function') {
      return await db.run(sql, [], false);
    }
  };

  db.execNonTransactional = execNonTransactional;

  if (!db.checkSQLiteVersion) {
    db.checkSQLiteVersion = async () => {
      try {
        const res = await db.query('SELECT sqlite_version() AS version;');
        const versionStr = res.values?.[0]?.version || '0.0.0';
        const parts = versionStr.split('.').map(n => parseInt(n, 10) || 0);
        const isVacuumIntoSupported = (parts[0] > 3) || (parts[0] === 3 && parts[1] >= 27);
        return { version: versionStr, isVacuumIntoSupported };
      } catch (err) {
        return { version: '0.0.0', isVacuumIntoSupported: false, error: err.message };
      }
    };
  }

  db.getDatabasePath = async () => {
    try {
      const urlRes = await db.getUrl();
      const raw = urlRes?.url || '';
      return raw.startsWith('file://') ? raw.replace('file://', '') : raw;
    } catch {
      return '';
    }
  };

  db.createNativeBackup = async (targetPath, options = {}) => {
    const startTime = performance.now();
    const verCheck = await db.checkSQLiteVersion();
    if (!verCheck.isVacuumIntoSupported) {
      throw new Error(`SQLITE_VERSION_UNSUPPORTED: VACUUM INTO requires SQLite >= 3.27.0 (found ${verCheck.version})`);
    }

    // Verify there is no lingering uncommitted transaction active before attempting VACUUM
    if (typeof db.isTransactionActive === 'function') {
      try {
        const activeRes = await db.isTransactionActive();
        if (activeRes?.result) {
          throw new Error('CANNOT_VACUUM_IN_TRANSACTION: Database has an active transaction before backup');
        }
      } catch (txErr) {
        if (txErr.message?.includes('CANNOT_VACUUM_IN_TRANSACTION')) throw txErr;
      }
    }

    // Capture pre-backup table counts for integrity validation
    const [txCountRes, invCountRes, acctCountRes, catCountRes] = await Promise.all([
      db.query('SELECT count(*) as count FROM transactions').catch(() => ({ values: [{ count: 0 }] })),
      db.query('SELECT count(*) as count FROM investment_transactions').catch(() => ({ values: [{ count: 0 }] })),
      db.query('SELECT count(*) as count FROM accounts').catch(() => ({ values: [{ count: 0 }] })),
      db.query('SELECT count(*) as count FROM categories').catch(() => ({ values: [{ count: 0 }] }))
    ]);
    const expectedCounts = {
      transactions: txCountRes.values?.[0]?.count ?? 0,
      investment_transactions: invCountRes.values?.[0]?.count ?? 0,
      accounts: acctCountRes.values?.[0]?.count ?? 0,
      categories: catCountRes.values?.[0]?.count ?? 0
    };

    const tempPath = options.tempPath || `${targetPath}.tmp_${Date.now()}`;

    // Clean up any stale temp file from previous aborted attempts (VACUUM INTO fails if destination exists)
    await safeDeleteFile(tempPath);

    // Flush dirty pages from WAL journal into the main database file before VACUUM
    // db.query() uses selectSQL which returns row values without starting a transaction
    try {
      await db.query('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (e) {
      console.warn('wal_checkpoint pragma warning before backup:', e?.message);
    }

    try {
      // Execute VACUUM INTO strictly outside any transaction using execNonTransactional
      await execNonTransactional(`VACUUM INTO '${tempPath}';`);

      // Self-validate backup by attaching it outside any transaction
      try {
        await execNonTransactional(`ATTACH DATABASE '${tempPath}' AS verify_bkp;`);

        const integrityRes = await db.query('PRAGMA verify_bkp.integrity_check;');
        const integrityStatus = integrityRes.values?.[0]?.integrity_check || integrityRes.values?.[0]?.['integrity_check'] || '';
        if (integrityStatus.toLowerCase() !== 'ok') {
          throw new Error(`Backup database integrity check failed: ${integrityStatus}`);
        }

        const [bTxRes, bInvRes, bAcctRes, bCatRes] = await Promise.all([
          db.query('SELECT count(*) as count FROM verify_bkp.transactions'),
          db.query('SELECT count(*) as count FROM verify_bkp.investment_transactions'),
          db.query('SELECT count(*) as count FROM verify_bkp.accounts'),
          db.query('SELECT count(*) as count FROM verify_bkp.categories')
        ]);

        const backupCounts = {
          transactions: bTxRes.values?.[0]?.count ?? 0,
          investment_transactions: bInvRes.values?.[0]?.count ?? 0,
          accounts: bAcctRes.values?.[0]?.count ?? 0,
          categories: bCatRes.values?.[0]?.count ?? 0
        };

        if (backupCounts.transactions !== expectedCounts.transactions ||
            backupCounts.investment_transactions !== expectedCounts.investment_transactions ||
            backupCounts.accounts !== expectedCounts.accounts ||
            backupCounts.categories !== expectedCounts.categories) {
          throw new Error(`Backup validation count mismatch: expected txns=${expectedCounts.transactions}, got ${backupCounts.transactions}`);
        }
      } finally {
        try {
          await execNonTransactional('DETACH DATABASE verify_bkp;');
        } catch (detachErr) {
          console.warn('Failed to detach verify_bkp:', detachErr?.message);
        }
      }

      // Promote verified temporary backup file to final target path atomically
      let finalPath = targetPath;
      if (tempPath !== targetPath) {
        await safeRenameFile(tempPath, targetPath);
      }

      const durationMs = performance.now() - startTime;
      return {
        success: true,
        backupPath: finalPath,
        durationMs,
        counts: expectedCounts,
        verified: true
      };
    } catch (err) {
      // Guarantee temporary backup file cleanup on failure
      await safeDeleteFile(tempPath);
      throw err;
    }
  };

  db.restoreNativeBackup = async (backupPath) => {
    const startTime = performance.now();
    try {
      await db.query('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}

    // Disable foreign keys OUTSIDE the active transaction.
    // Changing PRAGMA foreign_keys inside an active transaction is a no-op in SQLite.
    try {
      await execNonTransactional('PRAGMA foreign_keys = OFF;');
    } catch (fkErr) {
      console.warn('Warning: PRAGMA foreign_keys = OFF failed before restore:', fkErr?.message);
    }

    await execNonTransactional(`ATTACH DATABASE '${backupPath}' AS restore_bkp;`);
    try {
      const integrityRes = await db.query('PRAGMA restore_bkp.integrity_check;');
      const status = integrityRes.values?.[0]?.integrity_check || '';
      if (status.toLowerCase() !== 'ok') {
        throw new Error(`Backup database failed integrity check: ${status}`);
      }

      const tablesRes = await db.query(`SELECT name FROM restore_bkp.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';`);
      const tableNames = (tablesRes.values || []).map(r => r?.name || r?.NAME || '').filter(Boolean);
      const mainTablesRes = await db.query(`SELECT name FROM main.sqlite_master WHERE type='table';`);
      const mainTableSet = new Set((mainTablesRes.values || []).map(r => (r?.name || r?.NAME || '').toLowerCase()).filter(Boolean));

      // Explicit transaction: pass transaction = false so plugin does not nest beginTransaction()
      await db.run('BEGIN IMMEDIATE TRANSACTION;', [], false);
      try {
        for (const tbl of tableNames) {
          if (tbl.startsWith('sqlite_') || tbl === 'android_metadata' || tbl === 'room_master_table') continue;
          if (!mainTableSet.has(tbl.toLowerCase())) continue;

          const pragmaMain = (await db.query(`PRAGMA main.table_info(${tbl});`)).values || [];
          const pragmaBackup = (await db.query(`PRAGMA restore_bkp.table_info(${tbl});`)).values || [];

          const matchedCols = matchTableColumns(pragmaMain, pragmaBackup);

          await db.run(`DELETE FROM main.${tbl};`, [], false);
          if (matchedCols.length > 0) {
            const mainColList = matchedCols.map(c => `"${c.target}"`).join(', ');
            const backupColList = matchedCols.map(c => `"${c.source}"`).join(', ');
            await db.run(`INSERT OR REPLACE INTO main.${tbl} (${mainColList}) SELECT ${backupColList} FROM restore_bkp.${tbl};`, [], false);
          } else {
            await db.run(`INSERT OR REPLACE INTO main.${tbl} SELECT * FROM restore_bkp.${tbl};`, [], false);
          }
        }
        try {
          await db.run('DELETE FROM main.sqlite_sequence;', [], false);
          await db.run('INSERT OR IGNORE INTO main.sqlite_sequence SELECT * FROM restore_bkp.sqlite_sequence;', [], false);
        } catch {}
        await db.run('COMMIT;', [], false);
      } catch (txErr) {
        try { await db.run('ROLLBACK;', [], false); } catch {}
        throw txErr;
      }

      // Re-enable foreign keys OUTSIDE transaction and verify referential integrity
      try {
        await execNonTransactional('PRAGMA foreign_keys = ON;');
        const fkCheck = await db.query('PRAGMA foreign_key_check;');
        if (fkCheck.values && fkCheck.values.length > 0) {
          console.warn(`Foreign key check warnings post-restore: ${fkCheck.values.length} violations found.`);
        }
      } catch (fkErr) {
        console.warn('Warning: PRAGMA foreign_keys = ON failed after restore:', fkErr?.message);
      }

      return {
        success: true,
        restoredTables: tableNames,
        durationMs: performance.now() - startTime
      };
    } finally {
      try {
        await execNonTransactional('DETACH DATABASE restore_bkp;');
      } catch (detachErr) {
        console.warn('Failed to detach restore_bkp:', detachErr?.message);
      }
      try {
        await execNonTransactional('PRAGMA foreign_keys = ON;');
        await db.query('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {}
    }
  };

  db.promoteStagingSnapshot = async (stagingPath) => {
    const startTime = performance.now();
    try {
      await db.query('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}

    try {
      await execNonTransactional('PRAGMA foreign_keys = OFF;');
    } catch (fkErr) {
      console.warn('Warning: PRAGMA foreign_keys = OFF failed before staging promotion:', fkErr?.message);
    }

    await execNonTransactional(`ATTACH DATABASE '${stagingPath}' AS staging_snap;`);
    try {
      const integrityRes = await db.query('PRAGMA staging_snap.integrity_check;');
      const status = integrityRes.values?.[0]?.integrity_check || '';
      if (status.toLowerCase() !== 'ok') {
        throw new Error(`Staging snapshot database failed integrity check: ${status}`);
      }

      const tablesRes = await db.query(`SELECT name FROM staging_snap.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';`);
      const tableNames = (tablesRes.values || []).map(r => r?.name || r?.NAME || '').filter(Boolean);
      const mainTablesRes = await db.query(`SELECT name FROM main.sqlite_master WHERE type='table';`);
      const mainTableSet = new Set((mainTablesRes.values || []).map(r => (r?.name || r?.NAME || '').toLowerCase()).filter(Boolean));

      await db.run('BEGIN IMMEDIATE TRANSACTION;', [], false);
      try {
        const EXCLUDED_STAGING_TABLES = [
          'sync_local_state',
          'sync_delta_queue',
          'sync_peer_state',
          'sync_staged_packages',
          'sync_staged_events',
          'sync_process_locks',
          'sync_conflicts',
          'android_metadata',
          'room_master_table'
        ];

        for (const tbl of tableNames) {
          if (EXCLUDED_STAGING_TABLES.includes(tbl) || tbl.startsWith('sqlite_') || tbl === 'android_metadata') {
            continue;
          }
          if (!mainTableSet.has(tbl.toLowerCase())) {
            continue;
          }

          if (tbl === 'settings') {
            const stagingSettings = (await db.query('SELECT key, value FROM staging_snap.settings;')).values || [];
            for (const s of stagingSettings) {
              if (s && s.key && SYNCED_SETTINGS_WHITELIST.includes(s.key)) {
                await db.run(
                  'INSERT OR REPLACE INTO main.settings (key, value) VALUES (?, ?);',
                  [s.key, String(s.value ?? '')],
                  false
                );
              }
            }
            continue;
          }

          if (tbl === 'brokerages') {
            const stagingBrokRes = await db.query('SELECT * FROM staging_snap.brokerages;').catch(() => ({ values: [] }));
            const stagingBroks = stagingBrokRes.values || [];
            const seenByNorm = new Map();
            for (const brk of stagingBroks) {
              if (!brk || !brk.name) continue;
              const normName = String(brk.name).trim().toLowerCase();
              const canonId = getCanonicalBrokerageId(brk);
              const bank = String(brk.bank_account || '').trim();
              const owner = String(brk.owner || '').trim();
              if (seenByNorm.has(normName)) {
                const existing = seenByNorm.get(normName);
                if (existing.bank && bank && existing.bank.toLowerCase() !== bank.toLowerCase()) {
                  throw new Error(`Snapshot reconciliation failed: Conflicting bank_account for brokerage "${brk.name}" ("${existing.bank}" vs "${bank}")`);
                }
                if (existing.owner && owner && existing.owner.toLowerCase() !== owner.toLowerCase()) {
                  throw new Error(`Snapshot reconciliation failed: Conflicting owner for brokerage "${brk.name}" ("${existing.owner}" vs "${owner}")`);
                }
                if (!existing.bank && bank) existing.bank = bank;
                if (!existing.owner && owner) existing.owner = owner;
              } else {
                seenByNorm.set(normName, {
                  id: canonId,
                  name: String(brk.name).trim(),
                  bank,
                  owner
                });
              }
            }
            await db.run('DELETE FROM main.brokerages;', [], false);
            for (const b of seenByNorm.values()) {
              await db.run(
                'INSERT OR REPLACE INTO main.brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?);',
                [b.id, b.name, b.bank, b.owner],
                false
              );
            }
            continue;
          }

          const pragmaMain = (await db.query(`PRAGMA main.table_info(${tbl});`)).values || [];
          const pragmaStaging = (await db.query(`PRAGMA staging_snap.table_info(${tbl});`)).values || [];

          const matchedCols = matchTableColumns(pragmaMain, pragmaStaging);

          await db.run(`DELETE FROM main.${tbl};`, [], false);
          if (matchedCols.length > 0) {
            const mainColList = matchedCols.map(c => `"${c.target}"`).join(', ');
            const stagingColList = matchedCols.map(c => `"${c.source}"`).join(', ');
            await db.run(`INSERT OR REPLACE INTO main.${tbl} (${mainColList}) SELECT ${stagingColList} FROM staging_snap.${tbl};`, [], false);
          } else {
            await db.run(`INSERT OR REPLACE INTO main.${tbl} SELECT * FROM staging_snap.${tbl};`, [], false);
          }
        }
        try {
          await db.run('DELETE FROM main.sqlite_sequence;', [], false);
          await db.run('INSERT OR IGNORE INTO main.sqlite_sequence SELECT * FROM staging_snap.sqlite_sequence;', [], false);
        } catch {}
        await db.run('COMMIT;', [], false);
      } catch (txErr) {
        try { await db.run('ROLLBACK;', [], false); } catch {}
        throw txErr;
      }

      try {
        await execNonTransactional('PRAGMA foreign_keys = ON;');
        const fkCheck = await db.query('PRAGMA foreign_key_check;');
        if (fkCheck.values && fkCheck.values.length > 0) {
          console.warn(`Foreign key check warnings post-staging promotion: ${fkCheck.values.length} violations found.`);
        }
      } catch (fkErr) {
        console.warn('Warning: PRAGMA foreign_keys = ON failed after staging promotion:', fkErr?.message);
      }

      let distinctBrokerages = [];
      try {
        const brokRes = await db.query('SELECT DISTINCT LOWER(TRIM(name)) as name FROM staging_snap.brokerages WHERE name IS NOT NULL AND TRIM(name) != "";');
        distinctBrokerages = (brokRes.values || []).map(r => r.name).filter(Boolean);
      } catch {}

      return {
        success: true,
        promotedTables: tableNames,
        distinctBrokerages,
        durationMs: performance.now() - startTime
      };
    } finally {
      try {
        await execNonTransactional('DETACH DATABASE staging_snap;');
      } catch (detachErr) {
        console.warn('Failed to detach staging_snap:', detachErr?.message);
      }
      try {
        await execNonTransactional('PRAGMA foreign_keys = ON;');
        await db.query('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {}
    }
  };

  return db;
};



const _tableColumnsCache = new Map();

export const getTableColumns = async (db, table) => {
  if (!db || !table) return null;
  const key = String(table).toLowerCase();
  if (_tableColumnsCache.has(key)) return _tableColumnsCache.get(key);
  const cols = new Set();
  try {
    if (typeof db.query === 'function') {
      const info = await db.query(`PRAGMA table_info(${table})`);
      for (const row of info.values || []) {
        if (row.name) cols.add(row.name.toLowerCase());
      }
    }
  } catch {}
  if (cols.size > 0) {
    _tableColumnsCache.set(key, cols);
    return cols;
  }
  return null;
};

export const clearTableColumnsCache = () => {
  _tableColumnsCache.clear();
};

export const safeAddCol = async (db, table, colDef) => {
  try {
    const colName = colDef.trim().split(/\s+/)[0].toLowerCase();
    let existingCols = await getTableColumns(db, table);
    if (existingCols && existingCols.has(colName)) {
      return; // Column already exists, skip ALTER TABLE entirely
    }
    if (typeof db.run === 'function') {
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
    } else if (typeof db.execute === 'function') {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
    }
    if (existingCols) {
      existingCols.add(colName);
    }
  } catch {
    // Ignore: column already exists or ALTER TABLE unsupported (e.g. IDB)
  }
};

const applySchema = async (db) => {
  await db.execute(`CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY,date TEXT NOT NULL,time TEXT DEFAULT '',account TEXT DEFAULT '',from_account TEXT DEFAULT '',to_account TEXT DEFAULT '',category TEXT DEFAULT '',subcategory TEXT DEFAULT '',note TEXT DEFAULT '',description TEXT DEFAULT '',inr REAL DEFAULT 0,amount TEXT DEFAULT '0',currency TEXT DEFAULT 'INR',type TEXT DEFAULT 'Expense',created_at TEXT,updated_at TEXT,recurring_rule_id TEXT DEFAULT '',tags TEXT DEFAULT '',split_group_id TEXT DEFAULT '',receipt_image TEXT DEFAULT '',warranty_expiry TEXT DEFAULT '',serial_no TEXT DEFAULT '',sub_account TEXT DEFAULT '',from_sub_account TEXT DEFAULT '',to_sub_account TEXT DEFAULT '',created_by_device_id TEXT DEFAULT NULL,updated_by_device_id TEXT DEFAULT NULL,created_by_provenance TEXT DEFAULT NULL,updated_by_provenance TEXT DEFAULT NULL);`);
  await safeAddCol(db, 'transactions', "description TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "time TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "recurring_rule_id TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "tags TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "split_group_id TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "receipt_image TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "warranty_expiry TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "serial_no TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "sub_account TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "from_sub_account TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "to_sub_account TEXT DEFAULT ''");
  await safeAddCol(db, 'transactions', "created_by_device_id TEXT DEFAULT NULL");
  await safeAddCol(db, 'transactions', "updated_by_device_id TEXT DEFAULT NULL");
  await safeAddCol(db, 'transactions', "created_by_provenance TEXT DEFAULT NULL");
  await safeAddCol(db, 'transactions', "updated_by_provenance TEXT DEFAULT NULL");
  await safeAddCol(db, 'transactions', "investment_account TEXT");
  await safeAddCol(db, 'transactions', "actual_amount REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "total_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "brokerage_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "exchange_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "stt_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "sebi_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "stamp_duty_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "gst_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "dp_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "cdsl_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "other_charges REAL DEFAULT 0");
  await safeAddCol(db, 'transactions', "security_display_name TEXT");
  await safeAddCol(db, 'transactions', "settlement_mode TEXT DEFAULT 'ACTUAL'");

  await db.execute(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY,name TEXT NOT NULL,group_name TEXT DEFAULT '',sort_order INTEGER DEFAULT 0,created_at TEXT,acct_type TEXT DEFAULT '',settlement_date INTEGER DEFAULT 0,payment_due_days INTEGER DEFAULT 0,is_asset INTEGER DEFAULT 1,card_last4 TEXT DEFAULT '');`);
  await safeAddCol(db, 'accounts', "acct_type TEXT DEFAULT ''");
  await safeAddCol(db, 'accounts', "settlement_date INTEGER DEFAULT 0");
  await safeAddCol(db, 'accounts', "payment_due_days INTEGER DEFAULT 0");
  await safeAddCol(db, 'accounts', "is_asset INTEGER DEFAULT 1");
  await safeAddCol(db, 'accounts', "card_last4 TEXT DEFAULT ''");

  await db.execute(`CREATE TABLE IF NOT EXISTS account_groups (id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_order INTEGER DEFAULT 0);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS account_mapping (id TEXT PRIMARY KEY,source_name TEXT,account_name TEXT);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT DEFAULT 'Expense',sort_order INTEGER DEFAULT 0);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS subcategories (id TEXT PRIMARY KEY,name TEXT NOT NULL,category_id TEXT NOT NULL,sort_order INTEGER DEFAULT 0);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sub_accounts (id TEXT PRIMARY KEY,name TEXT NOT NULL,account_id TEXT NOT NULL,sort_order INTEGER DEFAULT 0);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY,category TEXT NOT NULL,amount REAL NOT NULL,period TEXT DEFAULT 'Monthly',created_at TEXT);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT);`);
  await db.execute(`CREATE TABLE IF NOT EXISTS recurring_rules (id TEXT PRIMARY KEY,rule_type TEXT NOT NULL,status TEXT DEFAULT 'active',txn_type TEXT DEFAULT 'Expense',account TEXT DEFAULT '',from_account TEXT DEFAULT '',to_account TEXT DEFAULT '',category TEXT DEFAULT '',subcategory TEXT DEFAULT '',base_note TEXT DEFAULT '',description TEXT DEFAULT '',currency TEXT DEFAULT 'INR',total_amount REAL DEFAULT 0,amount_per_part REAL DEFAULT 0,total_days INTEGER DEFAULT 0,total_parts INTEGER DEFAULT 0,completed_parts INTEGER DEFAULT 0,start_date TEXT DEFAULT '',next_date TEXT DEFAULT '',end_date TEXT DEFAULT '',schedule_mode TEXT DEFAULT 'on_date',frequency TEXT DEFAULT '',created_at TEXT DEFAULT '',updated_at TEXT DEFAULT '');`);
  await safeAddCol(db, 'recurring_rules', "updated_at TEXT DEFAULT ''");

  await db.execute(`CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY,name TEXT NOT NULL,qty REAL DEFAULT 0,unit TEXT DEFAULT '',price REAL DEFAULT 0,discounted_price REAL DEFAULT 0,status TEXT DEFAULT 'available',purchased_date TEXT DEFAULT '',notes TEXT DEFAULT '',updated_at TEXT,sub_qty REAL DEFAULT 1,sub_unit TEXT DEFAULT '',original_qty REAL DEFAULT 0,pack_qty REAL DEFAULT 1,discount_type TEXT DEFAULT 'percentage',discount_value REAL DEFAULT 0,category TEXT DEFAULT '',brand TEXT DEFAULT '');`);
  await safeAddCol(db, 'inventory', "sub_qty REAL DEFAULT 1");
  await safeAddCol(db, 'inventory', "sub_unit TEXT DEFAULT ''");
  await safeAddCol(db, 'inventory', "original_qty REAL DEFAULT 0");
  await safeAddCol(db, 'inventory', "pack_qty REAL DEFAULT 1");
  await safeAddCol(db, 'inventory', "discount_type TEXT DEFAULT 'percentage'");
  await safeAddCol(db, 'inventory', "discount_value REAL DEFAULT 0");
  await safeAddCol(db, 'inventory', "category TEXT DEFAULT ''");
  await safeAddCol(db, 'inventory', "brand TEXT DEFAULT ''");

  await db.execute(`CREATE TABLE IF NOT EXISTS investment_transactions (
    id TEXT PRIMARY KEY,
    date TEXT,
    time TEXT,
    account TEXT,
    from_account TEXT,
    to_account TEXT,
    category TEXT,
    subcategory TEXT,
    note TEXT,
    description TEXT,
    inr REAL,
    amount TEXT,
    currency TEXT,
    type TEXT,
    created_at TEXT,
    updated_at TEXT,
    recurring_rule_id TEXT,
    tags TEXT,
    split_group_id TEXT,
    receipt_image TEXT,
    warranty_expiry TEXT,
    serial_no TEXT,
    sub_account TEXT,
    from_sub_account TEXT,
    to_sub_account TEXT,
    investment_transaction_type TEXT,
    brokerage TEXT,
    security_symbol TEXT,
    security_isin TEXT,
    quantity REAL,
    unit_price REAL,
    trade_value REAL,
    cost_basis REAL,
    cash_impact REAL,
    position_qty_change REAL,
    realized_pnl REAL,
    trade_id TEXT,
    order_id TEXT,
    exchange TEXT,
    segment TEXT,
    source TEXT,
    investment_account TEXT,
    actual_amount REAL,
    total_charges REAL,
    brokerage_charges REAL,
    exchange_charges REAL,
    stt_charges REAL,
    sebi_charges REAL,
    stamp_duty_charges REAL,
    gst_charges REAL,
    dp_charges REAL,
    cdsl_charges REAL,
    other_charges REAL,
    security_display_name TEXT,
    settlement_mode TEXT DEFAULT 'ACTUAL',
    created_by_device_id TEXT DEFAULT NULL,
    updated_by_device_id TEXT DEFAULT NULL,
    created_by_provenance TEXT DEFAULT NULL,
    updated_by_provenance TEXT DEFAULT NULL
  );`);
  await safeAddCol(db, 'investment_transactions', "created_by_device_id TEXT DEFAULT NULL");
  await safeAddCol(db, 'investment_transactions', "updated_by_device_id TEXT DEFAULT NULL");
  await safeAddCol(db, 'investment_transactions', "created_by_provenance TEXT DEFAULT NULL");
  await safeAddCol(db, 'investment_transactions', "updated_by_provenance TEXT DEFAULT NULL");
  await safeAddCol(db, 'investment_transactions', "investment_account TEXT");
  await safeAddCol(db, 'investment_transactions', "actual_amount REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "total_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "brokerage_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "exchange_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "stt_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "sebi_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "stamp_duty_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "gst_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "dp_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "cdsl_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "other_charges REAL DEFAULT 0");
  await safeAddCol(db, 'investment_transactions', "security_display_name TEXT");
  await safeAddCol(db, 'investment_transactions', "settlement_mode TEXT DEFAULT 'ACTUAL'");
  await db.execute(`CREATE TABLE IF NOT EXISTS brokerages (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE,
    bank_account TEXT,
    owner TEXT
  );`);
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
    target_amount REAL DEFAULT 0,
    current_value REAL DEFAULT 0,
    created_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
  );`);
  await db.execute(`CREATE TABLE IF NOT EXISTS transaction_bookmarks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transaction_type TEXT DEFAULT 'Expense',
    template_data TEXT NOT NULL,
    source_transaction_id TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    usage_count INTEGER DEFAULT 0,
    last_used_at TEXT DEFAULT '',
    created_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
  );`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_tombstones (
    id TEXT PRIMARY KEY,
    entity_type TEXT DEFAULT 'transaction',
    entity_id TEXT,
    generation INTEGER DEFAULT 0,
    deleted_checksum TEXT,
    deleted_at TEXT NOT NULL
  );`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_delta_queue (
    event_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    collection TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    base_checksum TEXT,
    new_checksum TEXT,
    tombstone_generation INTEGER DEFAULT 0,
    payload TEXT,
    status TEXT DEFAULT 'PENDING',
    bundle_id TEXT,
    bundle_index INTEGER DEFAULT 0,
    bundle_total INTEGER DEFAULT 1,
    bundle_checksum TEXT,
    parent_event_id TEXT,
    resolution_type TEXT,
    resolved_event_id TEXT,
    resolved_conflict_id TEXT,
    acknowledged_at TEXT,
    created_at TEXT
  );`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_local_state (
    key TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    base_snapshot_id TEXT,
    base_cloud_version INTEGER DEFAULT 0,
    last_parent_snapshot_id TEXT,
    lifecycle_state TEXT DEFAULT 'UNINITIALIZED',
    last_allocated_sequence INTEGER DEFAULT 0,
    last_uploaded_sequence INTEGER DEFAULT 0,
    last_pushed_sequence INTEGER DEFAULT 0,
    last_acked_sequence INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
  );`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_staged_packages (
    package_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    sequence_range TEXT,
    base_snapshot_id TEXT,
    start_sequence INTEGER NOT NULL,
    end_sequence INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    package_checksum TEXT NOT NULL,
    drive_file_id TEXT,
    staged_at TEXT NOT NULL,
    status TEXT DEFAULT 'STAGED'
  );`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_staged_events (
    event_id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    collection TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    base_checksum TEXT,
    new_checksum TEXT,
    tombstone_generation INTEGER DEFAULT 0,
    payload TEXT,
    bundle_id TEXT,
    bundle_index INTEGER DEFAULT 0,
    bundle_total INTEGER DEFAULT 1,
    bundle_checksum TEXT,
    parent_event_id TEXT,
    resolution_type TEXT,
    resolved_event_id TEXT,
    resolved_conflict_id TEXT,
    staged_at TEXT NOT NULL,
    status TEXT DEFAULT 'STAGED'
  );`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_peer_state (
    peer_device_id TEXT PRIMARY KEY,
    last_staged_sequence INTEGER DEFAULT 0,
    last_reconciled_sequence INTEGER DEFAULT 0,
    base_snapshot_id TEXT,
    updated_at TEXT NOT NULL
  );`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_process_locks (
    lock_name TEXT PRIMARY KEY,
    owner_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_conflicts (
    conflict_id TEXT PRIMARY KEY,
    collection TEXT DEFAULT '',
    entity_type TEXT DEFAULT '',
    entity_id TEXT NOT NULL,
    conflict_type TEXT DEFAULT '',
    peer_device_id TEXT DEFAULT '',
    event_id TEXT DEFAULT '',
    package_id TEXT,
    base_checksum TEXT,
    local_checksum TEXT,
    remote_checksum TEXT,
    base_state TEXT,
    local_state TEXT,
    remote_state TEXT,
    local_payload TEXT,
    remote_payload TEXT,
    status TEXT DEFAULT 'PENDING',
    resolution TEXT,
    created_at TEXT DEFAULT '',
    detected_at TEXT DEFAULT '',
    resolved_at TEXT
  );`);

  await ensureSyncSchema(db);
};

/**
 * Ensures all sync table columns exist on SQLite, safely handling both Capacitor SQLite db.run and db.execute.
 */
export const ensureSyncSchema = async (db) => {
  if (!db) return;

  // sync_local_state migrations
  await safeAddCol(db, 'sync_local_state', "lifecycle_state TEXT DEFAULT 'UNINITIALIZED'");
  await safeAddCol(db, 'sync_local_state', 'base_snapshot_id TEXT');
  await safeAddCol(db, 'sync_local_state', 'base_cloud_version INTEGER DEFAULT 0');
  await safeAddCol(db, 'sync_local_state', 'last_parent_snapshot_id TEXT');
  await safeAddCol(db, 'sync_local_state', 'last_uploaded_sequence INTEGER DEFAULT 0');
  await safeAddCol(db, 'sync_local_state', 'last_acked_sequence INTEGER DEFAULT 0');

  // sync_peer_state migrations
  await safeAddCol(db, 'sync_peer_state', 'base_snapshot_id TEXT');

  // sync_delta_queue migrations
  await safeAddCol(db, 'sync_delta_queue', 'acknowledged_at TEXT');
  await safeAddCol(db, 'sync_delta_queue', 'created_at TEXT');

  // sync_tombstones migrations
  await safeAddCol(db, 'sync_tombstones', 'entity_id TEXT');
  await safeAddCol(db, 'sync_tombstones', 'generation INTEGER DEFAULT 0');
  await safeAddCol(db, 'sync_tombstones', 'deleted_checksum TEXT');

  // sync_staged_packages migrations
  await safeAddCol(db, 'sync_staged_packages', 'sequence_range TEXT');
  await safeAddCol(db, 'sync_staged_packages', 'base_snapshot_id TEXT');

  // sync_conflicts migrations
  await safeAddCol(db, 'sync_conflicts', "entity_type TEXT DEFAULT ''");
  await safeAddCol(db, 'sync_conflicts', 'local_state TEXT');
  await safeAddCol(db, 'sync_conflicts', 'remote_state TEXT');
  await safeAddCol(db, 'sync_conflicts', 'base_state TEXT');
  await safeAddCol(db, 'sync_conflicts', "detected_at TEXT DEFAULT ''");

  // investment_plans migrations
  await safeAddCol(db, 'investment_plans', 'target_amount REAL DEFAULT 0');
  await safeAddCol(db, 'investment_plans', 'current_value REAL DEFAULT 0');

  // recurring_rules migrations
  await safeAddCol(db, 'recurring_rules', "updated_at TEXT DEFAULT ''");

  // High-performance indexes for delta sync queue
  try {
    await db.execute('CREATE INDEX IF NOT EXISTS idx_sync_delta_queue_sequence ON sync_delta_queue (sequence);');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_sync_delta_queue_status ON sync_delta_queue (status);');
  } catch {}

  // Automatically prune acknowledged delta events covered by the current snapshot watermark
  await pruneAcknowledgedDeltas(db).catch(() => {});
};

/**
 * Safely prunes acknowledged delta events from sync_delta_queue that are strictly <= last_acked_sequence
 * and already covered by the authoritative cloud snapshot baseline.
 */
export async function pruneAcknowledgedDeltas(dbInstance = null) {
  const db = dbInstance || getDB();
  if (!db) return 0;
  try {
    const sRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
    const localState = sRes?.values?.[0] || {};
    const safeWatermark = Number(localState.last_acked_sequence || 0);
    if (safeWatermark > 0) {
      const res = await db.run(
        "DELETE FROM sync_delta_queue WHERE status = 'ACKNOWLEDGED' AND sequence <= ?",
        [safeWatermark]
      ).catch(() => ({ changes: { changes: 0 } }));
      return res?.changes?.changes || 0;
    }
  } catch (err) {
    console.warn('[pruneAcknowledgedDeltas] Warning:', err);
  }
  return 0;
};

/**
 * Resolve canonical brokerage identity from item object or name string.
 * Deterministic mapping: Zerodha -> brk_zerodha, Groww -> brk_groww.
 */
export function getCanonicalBrokerageId(itemOrName) {
  if (typeof itemOrName === 'object' && itemOrName !== null) {
    const rawId = String(itemOrName.id || itemOrName.ID || '').trim();
    if (rawId.startsWith('brk_')) return rawId;
  }
  const raw = typeof itemOrName === 'string'
    ? itemOrName
    : (itemOrName?.name || itemOrName?.id || itemOrName?.NAME || itemOrName?.ID || '');
  const norm = String(raw).trim().toLowerCase();
  if (norm === 'zerodha' || norm === 'brk_zerodha') return 'brk_zerodha';
  if (norm === 'groww' || norm === 'brk_groww') return 'brk_groww';
  if (norm.startsWith('brk_')) return norm;
  return `brk_${norm.replace(/[^a-z0-9_]/g, '_')}`;
}

/**
 * Safe, idempotent migration for existing brokerage records.
 * Canonicalizes IDs to deterministic names, preserves complete metadata,
 * fails closed on conflicting metadata, and deduplicates multiple UUID rows.
 */
export async function migrateExistingBrokerages(db) {
  try {
    const res = await db.query('SELECT * FROM brokerages;').catch(() => ({ values: [] }));
    const rows = res.values || [];
    if (rows.length === 0) return;

    const seenByNorm = new Map();
    let migrationNeeded = false;

    for (const r of rows) {
      if (!r || !r.name) continue;
      const norm = String(r.name).trim().toLowerCase();
      const canonId = getCanonicalBrokerageId(r);
      if (r.id !== canonId) {
        migrationNeeded = true;
      }
      const bank = String(r.bank_account || '').trim();
      const owner = String(r.owner || '').trim();

      if (seenByNorm.has(norm)) {
        migrationNeeded = true;
        const existing = seenByNorm.get(norm);
        if (existing.bank && bank && existing.bank.toLowerCase() !== bank.toLowerCase()) {
          throw new Error(`Brokerage migration failed: Conflicting bank_account for "${r.name}" ("${existing.bank}" vs "${bank}")`);
        }
        if (existing.owner && owner && existing.owner.toLowerCase() !== owner.toLowerCase()) {
          throw new Error(`Brokerage migration failed: Conflicting owner for "${r.name}" ("${existing.owner}" vs "${owner}")`);
        }
        if (!existing.bank && bank) existing.bank = bank;
        if (!existing.owner && owner) existing.owner = owner;
      } else {
        seenByNorm.set(norm, {
          id: canonId,
          name: String(r.name).trim(),
          bank,
          owner
        });
      }
    }

    if (!migrationNeeded) return;

    await db.run('DELETE FROM brokerages;');
    for (const b of seenByNorm.values()) {
      await db.run(
        'INSERT OR REPLACE INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?);',
        [b.id, b.name, b.bank, b.owner]
      );
    }
  } catch (err) {
    console.error('Brokerage migration error:', err);
    throw err;
  }
}

let _db = null;
let _initPromise = null;

export const initDB = async () => {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      if (Capacitor.getPlatform() === 'web') {
        const idb = await openIDB();
        _db = makeWebDB(idb);
      } else {
        _db = await openSQLite();
      }
      await applySchema(_db);

      // Seed default brokerages config with deterministic canonical IDs if empty
      try {
        const res = await _db.query('SELECT COUNT(*) as count FROM brokerages');
        const count = res.values?.[0]?.count ?? 0;
        if (count === 0) {
          await _db.run(`INSERT OR IGNORE INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)`, ['brk_zerodha', 'Zerodha', 'HDFC', 'Akbar']);
          await _db.run(`INSERT OR IGNORE INTO brokerages (id, name, bank_account, owner) VALUES (?, ?, ?, ?)`, ['brk_groww', 'Groww', 'Canara', 'Fareeda']);
        }
      } catch (err) {
        console.error('Failed to seed brokerages:', err);
      }

      // Safe, idempotent migration for existing brokerage records
      try {
        await migrateExistingBrokerages(_db);
      } catch (err) {
        console.error('Failed to migrate brokerages:', err);
      }

      return _db;
    } catch (err) {
      // Clear incomplete state so subsequent calls can retry cleanly
      closeDB();
      throw err;
    } finally {
      _initPromise = null;
    }
  })();

  return _initPromise;
};
export const getDB = () => { if (!_db) throw new Error('DB not initialised'); return _db; };