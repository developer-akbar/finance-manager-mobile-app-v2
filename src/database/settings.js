import { getDB } from './db.js';

export const getSetting = async (key, fallback = null) => {
  try {
    const r = await getDB().query('SELECT * FROM settings WHERE key=?', [key]);
    return r.values?.[0]?.value ?? fallback;
  } catch { return fallback; }
};

export const setSetting = async (key, value) => {
  // settings store uses keyPath:'key' — object must have {key, value}
  await getDB().run(
    'INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',
    [key, String(value)]
  );
};

export const getAllSettings = async () => {
  try {
    const r = await getDB().query('SELECT * FROM settings');
    return Object.fromEntries((r.values || []).map(x => [x.key, x.value]));
  } catch { return {}; }
};
