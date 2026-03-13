import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

// Always return {id, name, group, icon} — app expects "group" not "group_name"
export const getAccounts = async () => {
  const r = await getDB().query('SELECT * FROM accounts ORDER BY sort_order,name');
  return (r.values || []).map(a => ({
    id:    a.id,
    name:  a.name   || '',
    group: a.group_name || '',   // DB col = group_name, app field = group
    icon:  '💳',
  }));
};

export const replaceAccounts = async (list) => {
  const db = getDB();
  await db.run('DELETE FROM accounts');
  const now = new Date().toISOString();
  for (let i = 0; i < list.length; i++) {
    const a    = typeof list[i] === 'string' ? { name: list[i] } : list[i];
    const name = a.name || '';
    const grp  = a.group || a.group_name || '';
    await db.run(
      'INSERT OR REPLACE INTO accounts (id,name,group_name,sort_order,created_at) VALUES (?,?,?,?,?)',
      [a.id || uuid(), name, grp, i, now]
    );
  }
};

// Returns plain string array — app stores groups as string[]
export const getAccountGroups = async () => {
  const r = await getDB().query('SELECT * FROM account_groups ORDER BY sort_order,name');
  return (r.values || []).map(g => g.name).filter(Boolean);
};

export const replaceAccountGroups = async (list) => {
  const db = getDB();
  await db.run('DELETE FROM account_groups');
  for (let i = 0; i < list.length; i++) {
    const name = typeof list[i] === 'string' ? list[i] : (list[i]?.name || '');
    if (!name) continue;
    await db.run(
      'INSERT INTO account_groups (id,name,sort_order) VALUES (?,?,?)',
      [uuid(), name, i]
    );
  }
};

export const getAccountMapping = async () => (await getDB().query('SELECT * FROM account_mapping')).values || [];
export const replaceAccountMapping = async (list) => {
  const db = getDB();
  await db.run('DELETE FROM account_mapping');
  for (const m of list)
    await db.run('INSERT INTO account_mapping (id,source_name,account_name) VALUES (?,?,?)', [m.id || uuid(), m.source_name||'', m.account_name||'']);
};
