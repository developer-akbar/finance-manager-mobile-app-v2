import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';
import { executeAtomicBatch } from './atomicMutation.js';
import { computeEntityDiff } from '../utils/entityDiff.js';

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

  // Fetch current accounts and sub_accounts
  const [curAcctsRes, curSubsRes] = await Promise.all([
    db.query('SELECT * FROM accounts'),
    db.query('SELECT * FROM sub_accounts')
  ]);
  const curAccts = curAcctsRes.values || [];
  const curSubs = curSubsRes.values || [];
  const curAcctNameMap = new Map(curAccts.map(a => [a.name, a]));

  const newAcctRows = [];
  const newSubRows = [];

  for (let i = 0; i < uniqueList.length; i++) {
    const a    = typeof uniqueList[i] === 'string' ? { name: uniqueList[i] } : uniqueList[i];
    const name = a.name || '';
    const grp  = a.group || a.group_name || '';
    const acctType       = a.acctType || a.acct_type || '';
    const settlementDate = (a.settlementDate !== undefined ? Number(a.settlementDate) : (a.settlement_date !== undefined ? Number(a.settlement_date) : 0)) || 0;
    const paymentDueDays = (a.paymentDueDays !== undefined ? Number(a.paymentDueDays) : (a.payment_due_days !== undefined ? Number(a.payment_due_days) : 0)) || 0;
    const isAsset        = a.isAsset !== undefined ? (a.isAsset ? 1 : 0) : (a.is_asset !== undefined ? (Number(a.is_asset) === 1 ? 1 : 0) : (['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later', 'installments'].some(k => (grp || acctType || name).toLowerCase().includes(k)) ? 0 : 1));
    const cardLast4      = (a.cardLast4 || a.card_last4 || '').trim();
    const existing = curAcctNameMap.get(name);
    const parentId = a.id || existing?.id || uuid();

    newAcctRows.push({
      id: parentId,
      name,
      group_name: grp,
      sort_order: i,
      created_at: existing?.created_at || now,
      acct_type: acctType,
      settlement_date: settlementDate,
      payment_due_days: paymentDueDays,
      is_asset: isAsset,
      card_last4: cardLast4
    });

    const subs = a.subAccounts || [];
    for (let j = 0; j < subs.length; j++) {
      const s = subs[j];
      const sId = typeof s === 'object' ? (s.id || uuid()) : uuid();
      const sName = typeof s === 'object' ? s.name : s;
      newSubRows.push({
        id: sId,
        name: sName,
        account_id: parentId,
        sort_order: j
      });
    }
  }

  const [diffAccts, diffSubs] = await Promise.all([
    computeEntityDiff(curAccts, newAcctRows, 'id'),
    computeEntityDiff(curSubs, newSubRows, 'id')
  ]);

  const ops = [];
  for (const op of diffAccts.operations) {
    ops.push({
      storeName: 'accounts',
      id: op.id,
      operation: op.operation,
      entity: op.entity,
      expectedBaseEntity: op.oldEntity || (op.operation === 'DELETE' ? op.entity : null),
      base_checksum: op.base_checksum,
      new_checksum: op.new_checksum,
      tombstoneType: op.operation === 'DELETE' ? 'account' : null
    });
  }

  for (const op of diffSubs.operations) {
    ops.push({
      storeName: 'sub_accounts',
      id: op.id,
      operation: op.operation,
      entity: op.entity,
      expectedBaseEntity: op.oldEntity || (op.operation === 'DELETE' ? op.entity : null),
      base_checksum: op.base_checksum,
      new_checksum: op.new_checksum,
      tombstoneType: op.operation === 'DELETE' ? 'sub_account' : null
    });
  }

  if (ops.length > 0) {
    await executeAtomicBatch({ operations: ops });
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

  const curGroupsRes = await db.query('SELECT * FROM account_groups');
  const curGroups = curGroupsRes.values || [];
  const curNameMap = new Map(curGroups.map(g => [g.name, g]));

  const newGroups = [];
  for (let i = 0; i < uniqueList.length; i++) {
    const name = uniqueList[i];
    const existing = curNameMap.get(name);
    newGroups.push({
      id: existing?.id || uuid(),
      name,
      sort_order: i
    });
  }

  const diff = await computeEntityDiff(curGroups, newGroups, 'id');
  const ops = diff.operations.map(op => ({
    storeName: 'account_groups',
    id: op.id,
    operation: op.operation,
    entity: op.entity,
    expectedBaseEntity: op.oldEntity || (op.operation === 'DELETE' ? op.entity : null),
    base_checksum: op.base_checksum,
    new_checksum: op.new_checksum,
    tombstoneType: op.operation === 'DELETE' ? 'account_group' : null
  }));

  if (ops.length > 0) {
    await executeAtomicBatch({ operations: ops });
  }
};

export const getAccountMapping = async () => (await getDB().query('SELECT * FROM account_mapping')).values || [];

export const replaceAccountMapping = async (list) => {
  const db = getDB();
  const curMappingsRes = await db.query('SELECT * FROM account_mapping');
  const curMappings = curMappingsRes.values || [];

  const newMappings = (list || []).map(m => ({
    id: m.id || uuid(),
    source_name: m.source_name || '',
    account_name: m.account_name || ''
  }));

  const diff = await computeEntityDiff(curMappings, newMappings, 'id');
  const ops = diff.operations.map(op => ({
    storeName: 'account_mapping',
    id: op.id,
    operation: op.operation,
    entity: op.entity,
    expectedBaseEntity: op.oldEntity || (op.operation === 'DELETE' ? op.entity : null),
    base_checksum: op.base_checksum,
    new_checksum: op.new_checksum,
    tombstoneType: op.operation === 'DELETE' ? 'account_mapping' : null
  }));

  if (ops.length > 0) {
    await executeAtomicBatch({ operations: ops });
  }
};
