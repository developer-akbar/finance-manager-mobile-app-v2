import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

// Always return {id, name, group, icon, isAsset, subAccounts} — app expects "group" not "group_name"
export const getAccounts = async () => {
  const db = getDB();
  const r = await db.query('SELECT * FROM accounts ORDER BY sort_order,name');
  let subs = [];
  try {
    const s = await db.query('SELECT * FROM sub_accounts ORDER BY sort_order,name');
    subs = s.values || [];
  } catch (e) {
    console.warn('sub_accounts query failed:', e);
  }
  const subMap = {};
  for (const s of subs) {
    if (!subMap[s.account_id]) subMap[s.account_id] = [];
    subMap[s.account_id].push({ id: s.id, name: s.name });
  }

  return (r.values || []).map(a => {
    const isLiabilityName = ['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later', 'installments'].some(k => (a.group_name || a.acct_type || a.name || '').toLowerCase().includes(k));
    const isAsset = a.is_asset !== undefined && a.is_asset !== null
      ? (Number(a.is_asset) === 1)
      : !isLiabilityName;

    return {
      id:              a.id,
      name:            a.name        || '',
      group:           a.group_name  || '',   // DB col = group_name, app field = group
      icon:            '💳',
      acctType:        a.acct_type   || '',
      settlementDate:  a.settlement_date  ? Number(a.settlement_date)  : 0,
      paymentDueDays:  a.payment_due_days ? Number(a.payment_due_days) : 0,
      isAsset,
      cardLast4:       a.card_last4 || a.cardLast4 || '',
      subAccounts:     subMap[a.id] || []
    };
  });
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

  const set = [
    { statement: 'DELETE FROM sub_accounts', values: [] },
    { statement: 'DELETE FROM accounts', values: [] }
  ];
  for (let i = 0; i < uniqueList.length; i++) {
    const a    = typeof uniqueList[i] === 'string' ? { name: uniqueList[i] } : uniqueList[i];
    const name = a.name || '';
    const grp  = a.group || a.group_name || '';
    const acctType       = a.acctType || a.acct_type || '';
    const settlementDate = (a.settlementDate !== undefined ? Number(a.settlementDate) : (a.settlement_date !== undefined ? Number(a.settlement_date) : 0)) || 0;
    const paymentDueDays = (a.paymentDueDays !== undefined ? Number(a.paymentDueDays) : (a.payment_due_days !== undefined ? Number(a.payment_due_days) : 0)) || 0;
    const isAsset        = a.isAsset !== undefined ? (a.isAsset ? 1 : 0) : (a.is_asset !== undefined ? (Number(a.is_asset) === 1 ? 1 : 0) : (['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later', 'installments'].some(k => (grp || acctType || name).toLowerCase().includes(k)) ? 0 : 1));
    const cardLast4      = (a.cardLast4 || a.card_last4 || '').trim();
    const parentId       = a.id || uuid();

    set.push({
      statement: 'INSERT OR REPLACE INTO accounts (id,name,group_name,sort_order,created_at,acct_type,settlement_date,payment_due_days,is_asset,card_last4) VALUES (?,?,?,?,?,?,?,?,?,?)',
      values: [parentId, name, grp, i, now, acctType, settlementDate, paymentDueDays, isAsset, cardLast4]
    });

    const subs = a.subAccounts || [];
    for (let j = 0; j < subs.length; j++) {
      const s = subs[j];
      const sId = typeof s === 'object' ? (s.id || uuid()) : uuid();
      const sName = typeof s === 'object' ? s.name : s;
      set.push({
        statement: 'INSERT INTO sub_accounts (id,name,account_id,sort_order) VALUES (?,?,?,?)',
        values: [sId, sName, parentId, j]
      });
    }
  }

  if (typeof db.executeSet === 'function') {
    await db.executeSet(set);
  } else {
    await db.run('DELETE FROM sub_accounts');
    await db.run('DELETE FROM accounts');
    for (const stmt of set.slice(2)) {
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
