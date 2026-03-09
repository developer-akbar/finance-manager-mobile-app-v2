import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export async function getAccounts() {
  const db = getDB();
  const r = await db.query('SELECT * FROM accounts ORDER BY sort_order ASC, name ASC');
  return r.values || [];
}

export async function replaceAccounts(list) {
  const db = getDB();
  await db.run('DELETE FROM accounts');
  for (const a of list) {
    await db.run(
      'INSERT INTO accounts (id,name,group_name,icon,color,sort_order) VALUES (?,?,?,?,?,?)',
      [a.id||uuid(), a.name||'', a.group_name||'', a.icon||'💳', a.color||'#4d9fff', a.sort_order||0]
    );
  }
}

export async function getAccountGroups() {
  const db = getDB();
  const r = await db.query('SELECT * FROM account_groups ORDER BY sort_order ASC, name ASC');
  return r.values || [];
}

export async function replaceAccountGroups(list) {
  const db = getDB();
  await db.run('DELETE FROM account_groups');
  for (const g of list) {
    await db.run(
      'INSERT INTO account_groups (id,name,sort_order) VALUES (?,?,?)',
      [g.id||uuid(), g.name||'', g.sort_order||0]
    );
  }
}
