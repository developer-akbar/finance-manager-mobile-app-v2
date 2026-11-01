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

export const setSetting = async (key, value, options = {}) => {
  const strVal = String(value);
  const isSynced = SYNCED_SETTINGS_WHITELIST.includes(key);

  if (isSynced && !options.suppressDeltaQueue) {
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
    // Local-only setting or explicitly suppressed (e.g. baseline installation / bootstrap): write directly without creating delta event
    await getDB().run(
      'INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',
      [key, strVal]
    );
  }
};

export const LARGE_BLOB_SETTINGS_KEYS = [
  'pre_recovery_durable_backup',
  'pre_recovery_quarantined_deltas',
  'sync_base_manifest'
];

export const getAllSettings = async () => {
  try {
    const placeholders = LARGE_BLOB_SETTINGS_KEYS.map(() => '?').join(',');
    const r = await getDB().query(
      `SELECT * FROM settings WHERE key NOT IN (${placeholders})`,
      LARGE_BLOB_SETTINGS_KEYS
    );
    return Object.fromEntries((r.values || []).map(x => [x.key, x.value]));
  } catch { return {}; }
};

export const getLargeBlobSetting = async (key, fallback = null) => {
  return await getSetting(key, fallback);
};
