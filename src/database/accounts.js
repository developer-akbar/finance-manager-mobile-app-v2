import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

// Always return {id, name, group, icon} — app expects "group" not "group_name"
export const getAccounts = async () => {
  const r = await getDB().query('SELECT * FROM accounts ORDER BY sort_order,name');
  return (r.values || []).map(a => ({
    id:              a.id,
    name:            a.name        || '',
    group:           a.group_name  || '',   // DB col = group_name, app field = group
    icon:            '💳',
    acctType:        a.acct_type   || '',
    settlementDate:  a.settlement_date  ? Number(a.settlement_date)  : 0,
    paymentDueDays:  a.payment_due_days ? Number(a.payment_due_days) : 0,
  }));
};

export const replaceAccounts = async (list) => {
  const db = getDB();
  const now = new Date().toISOString();

  const seen = new Set();
  const uniqueList = (list || []).filter(item => {
    const a = typeof item === 'string' ? { name: item } : item;
    const name = (a.name || '').trim();
    if (!name) return false;
    const duplicate = seen.has(name);
    seen.add(name);
    return !duplicate;
  });

  const set = [{ statement: 'DELETE FROM accounts', values: [] }];
  for (let i = 0; i < uniqueList.length; i++) {
    const a    = typeof uniqueList[i] === 'string' ? { name: uniqueList[i] } : uniqueList[i];
    const name = a.name || '';
    const grp  = a.group || a.group_name || '';
    const acctType       = a.acctType       || '';
    const settlementDate = a.settlementDate ? Number(a.settlementDate) : 0;
    const paymentDueDays = a.paymentDueDays ? Number(a.paymentDueDays) : 0;
    set.push({
      statement: 'INSERT OR REPLACE INTO accounts (id,name,group_name,sort_order,created_at,acct_type,settlement_date,payment_due_days) VALUES (?,?,?,?,?,?,?,?)',
      values: [a.id || uuid(), name, grp, i, now, acctType, settlementDate, paymentDueDays]
    });
  }

  if (typeof db.executeSet === 'function') {
    await db.executeSet(set);
  } else {
    await db.run('DELETE FROM accounts');
    for (const stmt of set.slice(1)) {
      await db.run(stmt.statement, stmt.values);
    }
  }
};

// Returns plain string array — app stores groups as string[]
export const getAccountGroups = async () => {
  const r = await getDB().query('SELECT * FROM account_groups ORDER BY sort_order,name');
  return (r.values || []).map(g => g.name).filter(Boolean);
};

export const replaceAccountGroups = async (list) => {
  const db = getDB();
  const uniqueList = [...new Set((list || []).map(item => (typeof item === 'string' ? item : (item?.name || '')).trim()).filter(Boolean))];

  const set = [{ statement: 'DELETE FROM account_groups', values: [] }];
  for (let i = 0; i < uniqueList.length; i++) {
    const name = uniqueList[i];
    set.push({
      statement: 'INSERT INTO account_groups (id,name,sort_order) VALUES (?,?,?)',
      values: [uuid(), name, i]
    });
  }

  if (typeof db.executeSet === 'function') {
    await db.executeSet(set);
  } else {
    await db.run('DELETE FROM account_groups');
    for (const stmt of set.slice(1)) {
      await db.run(stmt.statement, stmt.values);
    }
  }
};

export const getAccountMapping = async () => (await getDB().query('SELECT * FROM account_mapping')).values || [];
export const replaceAccountMapping = async (list) => {
  const db = getDB();
  const set = [{ statement: 'DELETE FROM account_mapping', values: [] }];
  for (const m of list) {
    set.push({
      statement: 'INSERT INTO account_mapping (id,source_name,account_name) VALUES (?,?,?)',
      values: [m.id || uuid(), m.source_name||'', m.account_name||'']
    });
  }

  if (typeof db.executeSet === 'function') {
    await db.executeSet(set);
  } else {
    await db.run('DELETE FROM account_mapping');
    for (const stmt of set.slice(1)) {
      await db.run(stmt.statement, stmt.values);
    }
  }
};
