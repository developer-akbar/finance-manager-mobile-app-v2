import { getDB } from './db.js';
import { executeAtomicMutation } from './atomicMutation.js';

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

export const getSetting = async (key, fallback = null) => {
  try {
    const r = await getDB().query('SELECT * FROM settings WHERE key=?', [key]);
    return r.values?.[0]?.value ?? fallback;
  } catch { return fallback; }
};

export const setSetting = async (key, value) => {
  const strVal = String(value);
  const isSynced = SYNCED_SETTINGS_WHITELIST.includes(key);

  if (isSynced) {
    const db = getDB();
    const ex = await db.query('SELECT * FROM settings WHERE key = ?', [key]);
    const isExisting = (ex.values || []).length > 0;

    await executeAtomicMutation({
      storeName: 'settings',
      entityId: key,
      operation: isExisting ? 'UPDATE' : 'INSERT',
      entityData: { key, value: strVal }
    });
  } else {
    // Local-only setting: write directly without creating delta event
    await getDB().run(
      'INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',
      [key, strVal]
    );
  }
};

export const getAllSettings = async () => {
  try {
    const r = await getDB().query('SELECT * FROM settings');
    return Object.fromEntries((r.values || []).map(x => [x.key, x.value]));
  } catch { return {}; }
};
