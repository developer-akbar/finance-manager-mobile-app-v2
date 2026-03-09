import { getDB } from './db.js';

export async function getSetting(key) {
  const db = getDB();
  const r = await db.query('SELECT value FROM settings WHERE key=?', [key]);
  return (r.values||[])[0]?.value ?? null;
}

export async function setSetting(key, value) {
  const db = getDB();
  await db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, String(value)]);
}

export async function getAllSettings() {
  const db = getDB();
  const r = await db.query('SELECT key,value FROM settings');
  const out = {};
  for (const row of (r.values||[])) out[row.key] = row.value;
  return out;
}
