import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';
import { recordTombstone, recordTombstonesBatch } from './tombstones.js';
import { executeAtomicMutation, executeAtomicBatch } from './atomicMutation.js';
import { parseDescriptionStockInfo, parseStockLine, LEGACY_HISTORICAL_REF_MAP } from '../utils/stockInventoryNormalization.js';
import { buildInstalmentNote } from './recurring.js';

export { parseDescriptionStockInfo };

export const rowToTxn = (r) => {
  const base = {
    id: r.id, _id: r.id, ID: r.id,
    Date: r.date, date: r.date,
    Time: r.time || '', time: r.time || '',
    Account: r.account || '', account: r.account || '',
    FromAccount: r.from_account || '', from_account: r.from_account || '',
    ToAccount: r.to_account || '', to_account: r.to_account || '',
    Category: r.category || '', category: r.category || '',
    Subcategory: r.subcategory || '', subcategory: r.subcategory || '',
    Note: r.note || '', note: r.note || '',
    Description: r.description || '', description: r.description || '',
    INR: parseFloat(r.inr) || 0, inr: parseFloat(r.inr) || 0,
    Amount: r.amount || String(r.inr || 0), amount: r.amount || String(r.inr || 0),
    Currency: r.currency || 'INR', currency: r.currency || 'INR',
    'Income/Expense': r.type || 'Expense', type: r.type || 'Expense',
    created_at: r.created_at, updated_at: r.updated_at,
    recurring_rule_id: r.recurring_rule_id || '',
    Tags: r.tags || '', tags: r.tags || '',
    split_group_id: r.split_group_id || '',
    receipt_image: r.receipt_image || '',
    warranty_expiry: r.warranty_expiry || '',
    serial_no: r.serial_no || '',
    SubAccount: r.sub_account || '', sub_account: r.sub_account || '',
    FromSubAccount: r.from_sub_account || '', from_sub_account: r.from_sub_account || '',
    ToSubAccount: r.to_sub_account || '', to_sub_account: r.to_sub_account || '',
    InvestmentAccount: r.investment_account || '',
    ActualAmount: parseFloat(r.actual_amount || 0) || (r.actual_amount === 0 ? 0 : ''),
    TotalCharges: parseFloat(r.total_charges || 0) || 0,
    BrokerageCharges: parseFloat(r.brokerage_charges || 0) || (r.brokerage_charges === 0 ? 0 : ''),
    ExchangeCharges: parseFloat(r.exchange_charges || 0) || (r.exchange_charges === 0 ? 0 : ''),
    STTCharges: parseFloat(r.stt_charges || 0) || (r.stt_charges === 0 ? 0 : ''),
    SEBICharges: parseFloat(r.sebi_charges || 0) || (r.sebi_charges === 0 ? 0 : ''),
    StampDutyCharges: parseFloat(r.stamp_duty_charges || 0) || (r.stamp_duty_charges === 0 ? 0 : ''),
    GSTCharges: parseFloat(r.gst_charges || 0) || (r.gst_charges === 0 ? 0 : ''),
    DPCharges: parseFloat(r.dp_charges || 0) || (r.dp_charges === 0 ? 0 : ''),
    OtherCharges: parseFloat(r.other_charges || 0) || (r.other_charges === 0 ? 0 : ''),
    SecurityDisplayName: r.security_display_name || '',
    SettlementMode: r.settlement_mode || 'ACTUAL',
  };
  
  if (r.investment_transaction_type || r.brokerage) {
    return {
      ...base,
      InvestmentAccount: r.investment_account || (r.investment_transaction_type === 'SELL' ? (r.from_account || r.account) : (r.to_account || r.account || r.category)) || '',
      InvestmentTransactionType: r.investment_transaction_type || '',
      Brokerage: r.brokerage || '',
      SecuritySymbol: r.security_symbol || '',
      SecurityDisplayName: r.security_display_name || '',
      SecurityISIN: r.security_isin || '',
      Quantity: parseFloat(r.quantity) || 0,
      UnitPrice: parseFloat(r.unit_price) || 0,
      TradeValue: parseFloat(r.trade_value) || 0,
      CostBasis: parseFloat(r.cost_basis) || 0,
      CashImpact: parseFloat(r.cash_impact) || 0,
      PositionQuantityChange: parseFloat(r.position_qty_change) || 0,
      RealizedPnl: parseFloat(r.realized_pnl) || 0,
      TradeId: r.trade_id || '',
      OrderId: r.order_id || '',
      Exchange: r.exchange || '',
      Segment: r.segment || '',
      Source: r.source || '',
      ActualAmount: parseFloat(r.actual_amount || 0) || (r.actual_amount === 0 ? 0 : ''),
      TotalCharges: parseFloat(r.total_charges || 0) || 0,
      BrokerageCharges: parseFloat(r.brokerage_charges || 0) || (r.brokerage_charges === 0 ? 0 : ''),
      ExchangeCharges: parseFloat(r.exchange_charges || 0) || (r.exchange_charges === 0 ? 0 : ''),
      STTCharges: parseFloat(r.stt_charges || 0) || (r.stt_charges === 0 ? 0 : ''),
      SEBICharges: parseFloat(r.sebi_charges || 0) || (r.sebi_charges === 0 ? 0 : ''),
      StampDutyCharges: parseFloat(r.stamp_duty_charges || 0) || (r.stamp_duty_charges === 0 ? 0 : ''),
      GSTCharges: parseFloat(r.gst_charges || 0) || (r.gst_charges === 0 ? 0 : ''),
      DPCharges: parseFloat(r.dp_charges || 0) || (r.dp_charges === 0 ? 0 : ''),
      OtherCharges: parseFloat(r.other_charges || 0) || (r.other_charges === 0 ? 0 : ''),
      SettlementMode: r.settlement_mode || 'ACTUAL',
    };
  }
  return base;
};

export const getTransactions = async (filters = {}) => {
  const db = getDB();
  
  let sql1 = 'SELECT * FROM transactions WHERE 1=1';
  const vals1 = [];
  if (filters.account) {
    sql1 += ' AND (account=? OR from_account=? OR to_account=?)';
    vals1.push(filters.account, filters.account, filters.account);
  }
  if (filters.category) { sql1 += ' AND category=?'; vals1.push(filters.category); }
  if (filters.type)     { sql1 += ' AND type=?';     vals1.push(filters.type); }
  if (filters.tag) {
    sql1 += ' AND (tags LIKE ? OR note LIKE ? OR description LIKE ?)';
    const t = `%${filters.tag}%`;
    vals1.push(t, t, t);
  }
  if (filters.search) {
    const rawQ = filters.search.trim();
    if (rawQ.startsWith('#')) {
      const cleanTag = rawQ.replace(/^#/, '');
      sql1 += ' AND (tags LIKE ? OR note LIKE ? OR description LIKE ?)';
      const t = `%#${cleanTag}%`;
      vals1.push(t, t, t);
    } else {
      sql1 += ' AND (note LIKE ? OR category LIKE ? OR account LIKE ? OR description LIKE ? OR from_account LIKE ? OR to_account LIKE ? OR tags LIKE ?)';
      const q = `%${rawQ}%`;
      vals1.push(q, q, q, q, q, q, q);
    }
  }

  let sql2 = 'SELECT * FROM investment_transactions WHERE 1=1';
  const vals2 = [];
  if (filters.account) {
    sql2 += ' AND (account=? OR from_account=? OR to_account=? OR brokerage=?)';
    vals2.push(filters.account, filters.account, filters.account, filters.account);
  }
  if (filters.category) { sql2 += ' AND category=?'; vals2.push(filters.category); }
  if (filters.type)     { sql2 += ' AND type=?';     vals2.push(filters.type); }
  if (filters.tag) {
    sql2 += ' AND (tags LIKE ? OR note LIKE ? OR description LIKE ? OR security_symbol LIKE ?)';
    const t = `%${filters.tag}%`;
    vals2.push(t, t, t, t);
  }
  if (filters.search) {
    const rawQ = filters.search.trim();
    if (rawQ.startsWith('#')) {
      const cleanTag = rawQ.replace(/^#/, '');
      sql2 += ' AND (tags LIKE ? OR note LIKE ? OR description LIKE ?)';
      const t = `%#${cleanTag}%`;
      vals2.push(t, t, t);
    } else {
      sql2 += ' AND (note LIKE ? OR category LIKE ? OR account LIKE ? OR description LIKE ? OR from_account LIKE ? OR to_account LIKE ? OR tags LIKE ? OR brokerage LIKE ? OR security_symbol LIKE ?)';
      const q = `%${rawQ}%`;
      vals2.push(q, q, q, q, q, q, q, q, q);
    }
  }

  const [res1, res2] = await Promise.all([
    db.query(sql1, vals1),
    db.query(sql2, vals2)
  ]);

  const txnMap = new Map();
  (res1.values || []).map(rowToTxn).forEach(t => {
    if (t._id) txnMap.set(t._id, t);
  });
  (res2.values || []).map(rowToTxn).forEach(t => {
    if (t._id) txnMap.set(t._id, t);
  });
  const txns = Array.from(txnMap.values());


  const parseDateToTime = (dStr) => {
    if (!dStr) return 0;
    const parts = dStr.split('/');
    if (parts.length === 3) {
      return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
    }
    return new Date(dStr).getTime() || 0;
  };

  txns.sort((a, b) => {
    const da = parseDateToTime(a.Date);
    const db = parseDateToTime(b.Date);
    if (da !== db) return db - da;
    const ta = a.Time || '';
    const tb = b.Time || '';
    if (ta !== tb) return tb.localeCompare(ta);
    const ca = a.created_at || '';
    const cb = b.created_at || '';
    return cb.localeCompare(ca);
  });

  if (filters.limit) {
    return txns.slice(0, filters.limit);
  }
  return txns;
};

export const addTransaction = async (data) => {
  const id  = data.id || data.ID || data._id || uuid();
  const now = new Date().toISOString();
  
  const isInv = !!(data.InvestmentTransactionType || data.Brokerage);
  const storeName = isInv ? 'investment_transactions' : 'transactions';
  
  let rowObj;
  if (isInv) {
    const invAcct = data.InvestmentAccount || data.investment_account || data.Category || '';
    const actualAmt = parseFloat(data.ActualAmount !== undefined && data.ActualAmount !== '' ? data.ActualAmount : (data.actual_amount !== undefined && data.actual_amount !== '' ? data.actual_amount : 0)) || 0;
    const totCharges = parseFloat(data.TotalCharges !== undefined && data.TotalCharges !== '' ? data.TotalCharges : (data.total_charges !== undefined && data.total_charges !== '' ? data.total_charges : 0)) || 0;
    const brokCharges = parseFloat(data.BrokerageCharges !== undefined && data.BrokerageCharges !== '' ? data.BrokerageCharges : (data.brokerage_charges !== undefined && data.brokerage_charges !== '' ? data.brokerage_charges : 0)) || 0;
    const exCharges = parseFloat(data.ExchangeCharges !== undefined && data.ExchangeCharges !== '' ? data.ExchangeCharges : (data.exchange_charges !== undefined && data.exchange_charges !== '' ? data.exchange_charges : 0)) || 0;
    const sttCh = parseFloat(data.STTCharges !== undefined && data.STTCharges !== '' ? data.STTCharges : (data.stt_charges !== undefined && data.stt_charges !== '' ? data.stt_charges : 0)) || 0;
    const sebiCh = parseFloat(data.SEBICharges !== undefined && data.SEBICharges !== '' ? data.SEBICharges : (data.sebi_charges !== undefined && data.sebi_charges !== '' ? data.sebi_charges : 0)) || 0;
    const stampCh = parseFloat(data.StampDutyCharges !== undefined && data.StampDutyCharges !== '' ? data.StampDutyCharges : (data.stamp_duty_charges !== undefined && data.stamp_duty_charges !== '' ? data.stamp_duty_charges : 0)) || 0;
    const gstCh = parseFloat(data.GSTCharges !== undefined && data.GSTCharges !== '' ? data.GSTCharges : (data.gst_charges !== undefined && data.gst_charges !== '' ? data.gst_charges : 0)) || 0;
    const dpCh = parseFloat(data.DPCharges !== undefined && data.DPCharges !== '' ? data.DPCharges : (data.dp_charges !== undefined && data.dp_charges !== '' ? data.dp_charges : 0)) || 0;
    const otherCh = parseFloat(data.OtherCharges !== undefined && data.OtherCharges !== '' ? data.OtherCharges : (data.other_charges !== undefined && data.other_charges !== '' ? data.other_charges : 0)) || 0;
    const secDispName = String(data.SecurityDisplayName || data.security_display_name || data.Note || data.note || '');
    const setMode = String(data.SettlementMode || data.settlement_mode || 'ACTUAL').toUpperCase();

    const inrVal = parseFloat(data.INR !== undefined && data.INR !== '' ? data.INR : (data.inr !== undefined && data.inr !== '' ? data.inr : (data.Amount !== undefined && data.Amount !== '' ? data.Amount : (data.amount !== undefined && data.amount !== '' ? data.amount : 0)))) || 0;
    const amtStr = String(data.Amount !== undefined && data.Amount !== '' ? data.Amount : (data.amount !== undefined && data.amount !== '' ? data.amount : (data.INR !== undefined && data.INR !== '' ? data.INR : (data.inr !== undefined && data.inr !== '' ? data.inr : '0'))));
    const typeVal = data['Income/Expense'] || data.type || (data.Type || 'Expense');

    rowObj = {
      id, date:data.Date||data.date||'', time:data.Time||data.time||'', account:data.Account||data.account||'', from_account:data.FromAccount||data.from_account||'', to_account:data.ToAccount||data.to_account||'',
      category:data.Category||data.category||'', subcategory:data.Subcategory||data.subcategory||'', note:data.Note||data.note||'', description:data.Description||data.description||'',
      inr:inrVal, amount:amtStr, currency:data.Currency||data.currency||'INR',
      type:typeVal, created_at:data.created_at||now, updated_at:data.updated_at||now, recurring_rule_id:data.recurring_rule_id||'',
      tags:data.Tags||data.tags||'', split_group_id:data.split_group_id||'',
      receipt_image:data.receipt_image||'', warranty_expiry:data.warranty_expiry||'', serial_no:data.serial_no||'',
      sub_account:data.SubAccount||data.sub_account||'',
      from_sub_account:data.FromSubAccount||data.from_sub_account||data.SubAccount||data.sub_account||'',
      to_sub_account:data.ToSubAccount||data.to_sub_account||'',
      investment_transaction_type:data.InvestmentTransactionType||data.investment_transaction_type||'', brokerage:data.Brokerage||data.brokerage||'', security_symbol:data.SecuritySymbol||data.security_symbol||'', security_isin:data.SecurityISIN||data.security_isin||'',
      quantity:parseFloat(data.Quantity||data.quantity||0), unit_price:parseFloat(data.UnitPrice||data.unit_price||0), trade_value:parseFloat(data.TradeValue||data.trade_value||0),
      cost_basis:parseFloat(data.CostBasis||data.cost_basis||0), cash_impact:parseFloat(data.CashImpact||data.cash_impact||0), position_qty_change:parseFloat(data.PositionQuantityChange||data.position_qty_change||0),
      realized_pnl:parseFloat(data.RealizedPnl||data.realized_pnl||0), trade_id:data.TradeId||data.trade_id||'', order_id:data.OrderId||data.order_id||'', exchange:data.Exchange||data.exchange||'', segment:data.Segment||data.segment||'', source:data.Source||data.source||'',
      investment_account:invAcct,
      actual_amount:actualAmt, total_charges:totCharges, brokerage_charges:brokCharges, exchange_charges:exCharges,
      stt_charges:sttCh, sebi_charges:sebiCh, stamp_duty_charges:stampCh, gst_charges:gstCh, dp_charges:dpCh, other_charges:otherCh,
      security_display_name:secDispName,
      settlement_mode:setMode
    };
  } else {
    const inrVal = parseFloat(data.INR !== undefined && data.INR !== '' ? data.INR : (data.inr !== undefined && data.inr !== '' ? data.inr : (data.Amount !== undefined && data.Amount !== '' ? data.Amount : (data.amount !== undefined && data.amount !== '' ? data.amount : 0)))) || 0;
    const amtStr = String(data.Amount !== undefined && data.Amount !== '' ? data.Amount : (data.amount !== undefined && data.amount !== '' ? data.amount : (data.INR !== undefined && data.INR !== '' ? data.INR : (data.inr !== undefined && data.inr !== '' ? data.inr : '0'))));
    const typeVal = data['Income/Expense'] || data.type || (data.Type || 'Expense');

    rowObj = {
      id, date:data.Date||data.date||'', time:data.Time||data.time||'', account:data.Account||data.account||'', from_account:data.FromAccount||data.from_account||'', to_account:data.ToAccount||data.to_account||'',
      category:data.Category||data.category||'', subcategory:data.Subcategory||data.subcategory||'', note:data.Note||data.note||'', description:data.Description||data.description||'',
      inr:inrVal, amount:amtStr, currency:data.Currency||data.currency||'INR',
      type:typeVal, created_at:data.created_at||now, updated_at:data.updated_at||now, recurring_rule_id:data.recurring_rule_id||'',
      tags:data.Tags||data.tags||'', split_group_id:data.split_group_id||'',
      receipt_image:data.receipt_image||'', warranty_expiry:data.warranty_expiry||'', serial_no:data.serial_no||'',
      sub_account:data.SubAccount||data.sub_account||'',
      from_sub_account:data.FromSubAccount||data.from_sub_account||data.SubAccount||data.sub_account||'',
      to_sub_account:data.ToSubAccount||data.to_sub_account||''
    };
  }

  const companionCharges = Array.isArray(data.companion_charges) ? data.companion_charges : (Array.isArray(data.charges) ? data.charges : []);
  let stockOps = [];
  if (rowObj.tags && rowObj.tags.includes('#stock_ref_')) {
    const stockRes = await computeStockOperationsOnTxnChange(null, rowObj);
    stockOps = stockRes.ops || [];
  }

  const allOps = [
    {
      storeName,
      id,
      operation: 'INSERT',
      entity: rowObj
    }
  ];

  for (let i = 0; i < companionCharges.length; i++) {
    const ch = companionCharges[i];
    const chId = ch.id || ch.ID || `charge_${id}_${i + 1}`;
    const chRow = {
      id: chId,
      date: ch.date || data.Date || data.date || '',
      time: ch.time || data.Time || data.time || '',
      account: ch.account || data.Account || data.account || '',
      category: ch.category || 'Charges',
      subcategory: ch.subcategory || '',
      note: ch.note || ch.notes || `Companion charge for ${id}`,
      description: ch.description || '',
      inr: parseFloat(ch.inr || ch.amount || 0),
      amount: String(ch.amount || ch.inr || '0'),
      currency: ch.currency || 'INR',
      type: 'Expense',
      created_at: now,
      updated_at: now,
      split_group_id: `inv_charge_${id}`
    };
    allOps.push({
      storeName: 'transactions',
      id: chId,
      operation: 'INSERT',
      entity: chRow
    });
  }

  for (const sOp of stockOps) {
    allOps.push(sOp);
  }

  if (allOps.length > 1) {
    const bundleId = id;
    const bundleTotal = allOps.length;
    for (let i = 0; i < allOps.length; i++) {
      allOps[i].bundle_id = bundleId;
      allOps[i].bundle_index = i;
      allOps[i].bundle_total = bundleTotal;
    }
    await executeAtomicBatch({ operations: allOps, bundleId });
  } else {
    await executeAtomicMutation({
      storeName,
      entityId: id,
      operation: 'INSERT',
      entityData: rowObj
    });
  }

  return rowToTxn(rowObj);
};

export const parseStockRefTags = (tagsStr) => {
  if (!tagsStr) return [];
  const matches = [];
  const regex = /#stock_ref_([^\s,;:]+)(?::([\d\.]+))?/g;
  let m;
  while ((m = regex.exec(tagsStr)) !== null) {
    matches.push({
      fullMatch: m[0],
      id: m[1],
      qty: m[2] !== undefined ? parseFloat(m[2]) : null
    });
  }
  return matches;
};

/**
 * Unambiguously resolve the inventory DB entity associated with a given stock reference ID.
 * 1. Checks exact match by item.id.
 * 2. Checks canonical mapping for legacy historical IDs.
 * 3. Checks structured batch format (YYYY-MM-DD_<txnId>_<lineIdx>) matching purchase transaction ID.
 * 4. Checks single unique item name match if unambiguous. Refuses to restore if multiple candidates exist.
 */
export const resolveInventoryItemForStockRef = async (db, itemId, info = null, txn = null) => {
  if (!itemId) return null;

  // 1. Exact match on inventory row ID
  const exactRes = await db.query('SELECT * FROM inventory WHERE id = ?', [itemId]);
  if (exactRes.values?.[0]) {
    return exactRes.values[0];
  }

  // 2. Check canonical mapping for legacy historical IDs
  const mappedId = LEGACY_HISTORICAL_REF_MAP?.[itemId];
  if (mappedId) {
    const mapRes = await db.query('SELECT * FROM inventory WHERE id = ?', [mappedId]);
    if (mapRes.values?.[0]) {
      return mapRes.values[0];
    }
  }

  // 3. Structured pattern match: YYYY-MM-DD_<txnId>_<lineIdx>
  // Handles index offsets (e.g., when purchase had a store header)
  const matchParts = itemId.match(/^(\d{4}-\d{2}-\d{2})_(.+)_\d+$/);
  if (matchParts) {
    const [, , pTxnId] = matchParts;
    const invRes = await db.query('SELECT * FROM inventory');
    const candidates = (invRes.values || []).filter(item => item.id && item.id.includes(pTxnId));
    if (candidates.length === 1) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      const desc = txn ? (txn.description || txn.Description || '') : '';
      const nameMatch = desc.match(/(?:Used|Lent|Instalment Use)\s+[\d\/\.\s\w]+\s+of\s+([^(]+?)(?:\s*\(|$)/i);
      const targetName = (nameMatch ? nameMatch[1].trim() : (info?.name || '')).toLowerCase();
      if (targetName) {
        const filtered = candidates.filter(c => c.name && (c.name.toLowerCase().includes(targetName) || targetName.includes(c.name.toLowerCase())));
        if (filtered.length === 1) {
          return filtered[0];
        }
      }
      console.warn(`[resolveInventoryItemForStockRef] Multiple inventory candidates found for purchase ${pTxnId}. Refusing ambiguous restoration.`);
      return null;
    }
  }

  // 4. Safe fallback by item name from description if unambiguously unique
  const desc = txn ? (txn.description || txn.Description || '') : '';
  const nameMatch = desc.match(/(?:Used|Lent|Instalment Use)\s+[\d\/\.\s\w]+\s+of\s+([^(]+?)(?:\s*\(|$)/i);
  const targetName = (nameMatch ? nameMatch[1].trim() : (info?.name || '')).toLowerCase();
  if (targetName) {
    const allInv = await db.query('SELECT * FROM inventory');
    const nameCandidates = (allInv.values || []).filter(item => item.name && item.name.toLowerCase() === targetName);
    if (nameCandidates.length === 1) {
      return nameCandidates[0];
    }
    if (nameCandidates.length > 1) {
      console.warn(`[resolveInventoryItemForStockRef] Multiple inventory candidates found with name "${targetName}" for ref ${itemId}. Refusing ambiguous restoration.`);
      return null;
    }
  }

  return null;
};

export const computeStockOperationsOnTxnChange = async (oldTxn, newTxn) => {
  const oldRefs = parseStockRefTags(oldTxn ? (oldTxn.tags || oldTxn.Tags) : '');
  const newRefs = parseStockRefTags(newTxn ? (newTxn.tags || newTxn.Tags) : '');
  const oldIds = oldRefs.map(r => r.id);
  const newIds = newRefs.map(r => r.id);
  const ops = [];
  const db = getDB();
  const now = new Date().toISOString();
  let updatedTags = newTxn ? (newTxn.tags || newTxn.Tags || '') : '';

  // Synchronize stock-reference tags if quantity changed in description
  if (oldTxn && newTxn) {
    if (newRefs.length === 1) {
      const targetRef = newRefs[0];
      const newInfo = parseDescriptionStockInfo(newTxn.description);
      if (newInfo && !isNaN(newInfo.qty) && newInfo.qty > 0) {
        let newQtyInPacks = newInfo.qty;
        let item = (await db.query('SELECT * FROM inventory WHERE id = ?', [targetRef.id])).values?.[0];
        if (!item) {
          item = await resolveInventoryItemForStockRef(db, targetRef.id, newInfo, newTxn);
        }
        if (!item && /^\d{4}-\d{2}-\d{2}_.+_\d+$/.test(targetRef.id)) {
          const parts = targetRef.id.split('_');
          const pLineIdx = parseInt(parts[parts.length - 1], 10);
          const pTxnId = parts.slice(1, parts.length - 1).join('_');
          const pRes = await db.query('SELECT * FROM transactions WHERE id = ?', [pTxnId]);
          const pTxn = pRes.values?.[0];
          if (pTxn) {
            const lines = (pTxn.description || pTxn.Description || '').split('\n');
            if (lines[pLineIdx]) {
              const parsed = parseStockLine(lines[pLineIdx], pTxn, pLineIdx);
              if (parsed) {
                item = parsed;
              }
            }
          }
        }
        if (item && item.sub_unit && newInfo.unit && item.sub_unit.toLowerCase() === newInfo.unit.toLowerCase() && item.unit && item.unit.toLowerCase() !== newInfo.unit.toLowerCase()) {
          const subQtyVal = parseFloat(item.sub_qty) || 1;
          if (subQtyVal > 0) {
            newQtyInPacks = newInfo.qty / subQtyVal;
          }
        }
        const cleanQtyStr = Number.isInteger(newQtyInPacks) ? String(newQtyInPacks) : String(parseFloat(newQtyInPacks.toFixed(4)));

        // Safely replace only the targetRef tag in updatedTags, preserving exact canonical batch ID and other tags
        const escapedRef = targetRef.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const refRegex = new RegExp(`#stock_ref_${escapedRef}(?::[\\d\\.]+)?(?=[\\s,;]|$)`, 'g');
        updatedTags = updatedTags.replace(refRegex, `#stock_ref_${targetRef.id}:${cleanQtyStr}`);
      } else if (newTxn.description && (!newInfo || isNaN(newInfo.qty) || newInfo.qty <= 0)) {
        console.warn('[computeStockOperationsOnTxnChange] Description does not contain a reliable explicit stock quantity; preserving existing stock-reference tags.');
      }
    } else if (newRefs.length > 1) {
      console.warn('[computeStockOperationsOnTxnChange] Multiple stock-reference tags detected on edit; preserving distinct FIFO split tags.');
    }
  }

  // 1. Restore any old ref that is no longer present in newRefs
  const removedRefs = oldRefs.filter(r => !newIds.includes(r.id));
  if (removedRefs.length > 0) {
    const oldInfo = parseDescriptionStockInfo(oldTxn ? oldTxn.description : '');
    for (const r of removedRefs) {
      let restoreQty = r.qty;
      if (restoreQty === null) {
        restoreQty = oldInfo ? oldInfo.qty : 0;
      }
      if (restoreQty > 0) {
        const item = await resolveInventoryItemForStockRef(db, r.id, oldInfo, oldTxn);
        if (item) {
          const currQty = parseFloat(item.qty) || 0;
          const subQtyVal = parseFloat(item.sub_qty) || 1;
          let finalQtyToRestore = restoreQty;
          if (item.sub_unit && oldInfo && oldInfo.unit === item.sub_unit && subQtyVal > 0) {
            finalQtyToRestore = restoreQty / subQtyVal;
          }
          const newQty = currQty + finalQtyToRestore;
          const status = newQty > 0 ? 'available' : 'unavailable';
          ops.push({
            storeName: 'inventory',
            id: item.id || r.id,
            operation: 'UPDATE',
            entity: { ...item, qty: newQty, status, updated_at: now },
            expectedBaseEntity: item
          });
        }
      }
    }
  }

  // 2. Adjust first batch if quantities changed but references remained same
  if (oldRefs.length > 0 && newRefs.length > 0 && oldRefs[0].id === newRefs[0].id) {
    const firstRef = oldRefs[0];
    const oldInfo = parseDescriptionStockInfo(oldTxn.description);
    const newInfo = parseDescriptionStockInfo(newTxn.description);
    if (oldInfo && newInfo) {
      const qtyDiff = newInfo.qty - oldInfo.qty;
      if (qtyDiff !== 0 || oldInfo.unit !== newInfo.unit) {
        const item = await resolveInventoryItemForStockRef(db, firstRef.id, oldInfo, oldTxn);
        if (item) {
          const subQtyVal = parseFloat(item.sub_qty) || 1;
          let oldQtyInPacks = oldInfo.qty;
          if (item.sub_unit && oldInfo.unit === item.sub_unit && subQtyVal > 0) {
            oldQtyInPacks = oldInfo.qty / subQtyVal;
          }
          let newQtyInPacks = newInfo.qty;
          if (item.sub_unit && newInfo.unit === item.sub_unit && subQtyVal > 0) {
            newQtyInPacks = newInfo.qty / subQtyVal;
          }
          const packDiff = newQtyInPacks - oldQtyInPacks;
          const currQty = parseFloat(item.qty) || 0;
          const newQty = Math.max(0, currQty - packDiff);
          const status = newQty > 0.0001 ? 'available' : 'unavailable';
          ops.push({
            storeName: 'inventory',
            id: item.id || firstRef.id,
            operation: 'UPDATE',
            entity: { ...item, qty: newQty, status, updated_at: now },
            expectedBaseEntity: item
          });
        }
      }
    }
  }

  // 3. Deduct any new ref that was added
  const addedRefs = newRefs.filter(r => !oldIds.includes(r.id));
  if (addedRefs.length > 0) {
    const newInfo = parseDescriptionStockInfo(newTxn.description);
    for (const r of addedRefs) {
      let deductQty = r.qty;
      if (deductQty === null) {
        deductQty = newInfo ? newInfo.qty : 0;
      }
      if (deductQty > 0) {
        const item = await resolveInventoryItemForStockRef(db, r.id, newInfo, newTxn);
        if (item) {
          const subQtyVal = parseFloat(item.sub_qty) || 1;
          let qtyInPacks = deductQty;
          if (newInfo && item.sub_unit && newInfo.unit === item.sub_unit && subQtyVal > 0 && r.qty === null) {
            qtyInPacks = deductQty / subQtyVal;
          }
          const currQty = parseFloat(item.qty) || 0;
          const newQty = Math.max(0, currQty - qtyInPacks);
          const status = newQty > 0.0001 ? 'available' : 'unavailable';
          ops.push({
            storeName: 'inventory',
            id: item.id || r.id,
            operation: 'UPDATE',
            entity: { ...item, qty: newQty, status, updated_at: now },
            expectedBaseEntity: item
          });
        }
      }
    }
  }

  return { ops, updatedTags };
};

export const updateTransaction = async (idOrData, maybeData) => {
  let id, data;
  if (typeof idOrData === 'object' && idOrData !== null && !maybeData) {
    id = idOrData.id || idOrData.ID;
    data = idOrData;
  } else {
    id = idOrData;
    data = maybeData || {};
  }
  const db = getDB();
  const now = new Date().toISOString();
  let stockOps = [];
  let synchronizedTags = (data.Tags !== undefined ? data.Tags : data.tags);
  let oldTxn = null;
  try {
    const res = await db.query('SELECT * FROM transactions WHERE id = ?', [id]);
    oldTxn = res.values?.[0];
    if (oldTxn) {
      if (synchronizedTags === undefined || synchronizedTags === null) {
        synchronizedTags = oldTxn.tags || oldTxn.Tags || '';
      }
      const newTxn = {
        tags: synchronizedTags,
        description: data.Description !== undefined ? data.Description : (data.description !== undefined ? data.description : (oldTxn.description || oldTxn.Description || ''))
      };
      const stockRes = await computeStockOperationsOnTxnChange(oldTxn, newTxn);
      stockOps = stockRes.ops || [];
      if (stockRes.updatedTags) {
        synchronizedTags = stockRes.updatedTags;
      }
    }
  } catch (err) {
    console.error('Failed to compute stock on transaction edit:', err);
  }
  if (synchronizedTags === undefined || synchronizedTags === null) {
    synchronizedTags = '';
  }

  const isInv = !!(data.InvestmentTransactionType || data.Brokerage);
  const storeName = isInv ? 'investment_transactions' : 'transactions';

  let rowObj;
  if (isInv) {
    const invAcct = data.InvestmentAccount || data.investment_account || data.Category || oldTxn?.investment_account || oldTxn?.InvestmentAccount || '';
    const actualAmt = parseFloat(data.ActualAmount !== undefined && data.ActualAmount !== '' ? data.ActualAmount : (data.actual_amount !== undefined && data.actual_amount !== '' ? data.actual_amount : (oldTxn?.actual_amount || 0))) || 0;
    const totCharges = parseFloat(data.TotalCharges !== undefined && data.TotalCharges !== '' ? data.TotalCharges : (data.total_charges !== undefined && data.total_charges !== '' ? data.total_charges : (oldTxn?.total_charges || 0))) || 0;
    const brokCharges = parseFloat(data.BrokerageCharges !== undefined && data.BrokerageCharges !== '' ? data.BrokerageCharges : (data.brokerage_charges !== undefined && data.brokerage_charges !== '' ? data.brokerage_charges : (oldTxn?.brokerage_charges || 0))) || 0;
    const exCharges = parseFloat(data.ExchangeCharges !== undefined && data.ExchangeCharges !== '' ? data.ExchangeCharges : (data.exchange_charges !== undefined && data.exchange_charges !== '' ? data.exchange_charges : (oldTxn?.exchange_charges || 0))) || 0;
    const sttCh = parseFloat(data.STTCharges !== undefined && data.STTCharges !== '' ? data.STTCharges : (data.stt_charges !== undefined && data.stt_charges !== '' ? data.stt_charges : (oldTxn?.stt_charges || 0))) || 0;
    const sebiCh = parseFloat(data.SEBICharges !== undefined && data.SEBICharges !== '' ? data.SEBICharges : (data.sebi_charges !== undefined && data.sebi_charges !== '' ? data.sebi_charges : (oldTxn?.sebi_charges || 0))) || 0;
    const stampCh = parseFloat(data.StampDutyCharges !== undefined && data.StampDutyCharges !== '' ? data.StampDutyCharges : (data.stamp_duty_charges !== undefined && data.stamp_duty_charges !== '' ? data.stamp_duty_charges : (oldTxn?.stamp_duty_charges || 0))) || 0;
    const gstCh = parseFloat(data.GSTCharges !== undefined && data.GSTCharges !== '' ? data.gst_charges : (data.gst_charges !== undefined && data.gst_charges !== '' ? data.gst_charges : (oldTxn?.gst_charges || 0))) || 0;
    const dpCh = parseFloat(data.DPCharges !== undefined && data.DPCharges !== '' ? data.DPCharges : (data.dp_charges !== undefined && data.dp_charges !== '' ? data.dp_charges : (oldTxn?.dp_charges || 0))) || 0;
    const otherCh = parseFloat(data.OtherCharges !== undefined && data.OtherCharges !== '' ? data.OtherCharges : (data.other_charges !== undefined && data.other_charges !== '' ? data.other_charges : (oldTxn?.other_charges || 0))) || 0;
    const secDispName = String(data.SecurityDisplayName || data.security_display_name || data.Note || data.note || oldTxn?.security_display_name || oldTxn?.SecurityDisplayName || oldTxn?.note || oldTxn?.Note || '');
    const setMode = String(data.SettlementMode || data.settlement_mode || oldTxn?.settlement_mode || oldTxn?.SettlementMode || 'ACTUAL').toUpperCase();

    const inrVal = parseFloat(data.INR !== undefined && data.INR !== '' ? data.INR : (data.inr !== undefined && data.inr !== '' ? data.inr : (data.Amount !== undefined && data.Amount !== '' ? data.Amount : (data.amount !== undefined && data.amount !== '' ? data.amount : (oldTxn?.INR !== undefined ? oldTxn.INR : (oldTxn?.inr !== undefined ? oldTxn.inr : 0)))))) || 0;
    const amtStr = String(data.Amount !== undefined && data.Amount !== '' ? data.Amount : (data.amount !== undefined && data.amount !== '' ? data.amount : (data.INR !== undefined && data.INR !== '' ? data.INR : (data.inr !== undefined && data.inr !== '' ? data.inr : (oldTxn?.Amount !== undefined ? oldTxn.Amount : (oldTxn?.amount !== undefined ? oldTxn.amount : String(inrVal)))))));
    const typeVal = data['Income/Expense'] || data.type || (data.Type || (oldTxn?.['Income/Expense'] || oldTxn?.type || oldTxn?.Type || 'Expense'));

    rowObj = {
      id,
      date: data.Date || data.date || oldTxn?.date || oldTxn?.Date || '',
      time: data.Time || data.time || oldTxn?.time || oldTxn?.Time || '',
      account: data.Account || data.account || oldTxn?.account || oldTxn?.Account || '',
      from_account: data.FromAccount || data.from_account || oldTxn?.from_account || oldTxn?.FromAccount || '',
      to_account: data.ToAccount || data.to_account || oldTxn?.to_account || oldTxn?.ToAccount || '',
      category: data.Category || data.category || oldTxn?.category || oldTxn?.Category || '',
      subcategory: data.Subcategory || data.subcategory || oldTxn?.subcategory || oldTxn?.Subcategory || '',
      note: data.Note !== undefined ? data.Note : (data.note !== undefined ? data.note : (oldTxn?.note || oldTxn?.Note || '')),
      description: data.Description !== undefined ? data.Description : (data.description !== undefined ? data.description : (oldTxn?.description || oldTxn?.Description || '')),
      inr: inrVal, amount: amtStr, currency: data.Currency || data.currency || oldTxn?.currency || oldTxn?.Currency || 'INR',
      type: typeVal, created_at: data.created_at || oldTxn?.created_at || now, updated_at: now, recurring_rule_id: data.recurring_rule_id !== undefined ? data.recurring_rule_id : (oldTxn?.recurring_rule_id || ''),
      tags: synchronizedTags, split_group_id: data.split_group_id || oldTxn?.split_group_id || '',
      receipt_image: data.receipt_image !== undefined ? data.receipt_image : (oldTxn?.receipt_image || ''),
      warranty_expiry: data.warranty_expiry !== undefined ? data.warranty_expiry : (oldTxn?.warranty_expiry || ''),
      serial_no: data.serial_no !== undefined ? data.serial_no : (oldTxn?.serial_no || ''),
      sub_account: data.SubAccount || data.sub_account || oldTxn?.sub_account || oldTxn?.SubAccount || '',
      from_sub_account: data.FromSubAccount || data.from_sub_account || data.SubAccount || data.sub_account || oldTxn?.from_sub_account || oldTxn?.FromSubAccount || '',
      to_sub_account: data.ToSubAccount || data.to_sub_account || oldTxn?.to_sub_account || oldTxn?.ToSubAccount || '',
      investment_transaction_type: data.InvestmentTransactionType || data.investment_transaction_type || oldTxn?.investment_transaction_type || oldTxn?.InvestmentTransactionType || '',
      brokerage: data.Brokerage || data.brokerage || oldTxn?.brokerage || oldTxn?.Brokerage || '',
      security_symbol: data.SecuritySymbol || data.security_symbol || oldTxn?.security_symbol || oldTxn?.SecuritySymbol || '',
      security_isin: data.SecurityISIN || data.security_isin || oldTxn?.security_isin || oldTxn?.SecurityISIN || '',
      quantity: parseFloat(data.Quantity !== undefined ? data.Quantity : (data.quantity !== undefined ? data.quantity : (oldTxn?.quantity || 0))),
      unit_price: parseFloat(data.UnitPrice !== undefined ? data.UnitPrice : (data.unit_price !== undefined ? data.unit_price : (oldTxn?.unit_price || 0))),
      trade_value: parseFloat(data.TradeValue !== undefined ? data.TradeValue : (data.trade_value !== undefined ? data.trade_value : (oldTxn?.trade_value || 0))),
      cost_basis: parseFloat(data.CostBasis !== undefined ? data.CostBasis : (data.cost_basis !== undefined ? data.cost_basis : (oldTxn?.cost_basis || 0))),
      cash_impact: parseFloat(data.CashImpact !== undefined ? data.CashImpact : (data.cash_impact !== undefined ? data.cash_impact : (oldTxn?.cash_impact || 0))),
      position_qty_change: parseFloat(data.PositionQuantityChange !== undefined ? data.PositionQuantityChange : (data.position_qty_change !== undefined ? data.position_qty_change : (oldTxn?.position_qty_change || 0))),
      realized_pnl: parseFloat(data.RealizedPnl !== undefined ? data.RealizedPnl : (data.realized_pnl !== undefined ? data.realized_pnl : (oldTxn?.realized_pnl || 0))),
      trade_id: data.TradeId || data.trade_id || oldTxn?.trade_id || oldTxn?.TradeId || '',
      order_id: data.OrderId || data.order_id || oldTxn?.order_id || oldTxn?.OrderId || '',
      exchange: data.Exchange || data.exchange || oldTxn?.exchange || oldTxn?.Exchange || '',
      segment: data.Segment || data.segment || oldTxn?.segment || oldTxn?.Segment || '',
      source: data.Source || data.source || oldTxn?.source || oldTxn?.Source || '',
      investment_account: invAcct,
      actual_amount: actualAmt, total_charges: totCharges, brokerage_charges: brokCharges, exchange_charges: exCharges,
      stt_charges: sttCh, sebi_charges: sebiCh, stamp_duty_charges: stampCh, gst_charges: gstCh, dp_charges: dpCh, other_charges: otherCh,
      security_display_name: secDispName,
      settlement_mode: setMode
    };
  } else {
    const inrVal = parseFloat(data.INR !== undefined && data.INR !== '' ? data.INR : (data.inr !== undefined && data.inr !== '' ? data.inr : (data.Amount !== undefined && data.Amount !== '' ? data.Amount : (data.amount !== undefined && data.amount !== '' ? data.amount : (oldTxn?.INR !== undefined ? oldTxn.INR : (oldTxn?.inr !== undefined ? oldTxn.inr : 0)))))) || 0;
    const amtStr = String(data.Amount !== undefined && data.Amount !== '' ? data.Amount : (data.amount !== undefined && data.amount !== '' ? data.amount : (data.INR !== undefined && data.INR !== '' ? data.INR : (data.inr !== undefined && data.inr !== '' ? data.inr : (oldTxn?.Amount !== undefined ? oldTxn.Amount : (oldTxn?.amount !== undefined ? oldTxn.amount : String(inrVal)))))));
    const typeVal = data['Income/Expense'] || data.type || (data.Type || (oldTxn?.['Income/Expense'] || oldTxn?.type || oldTxn?.Type || 'Expense'));

    rowObj = {
      id,
      date: data.Date || data.date || oldTxn?.date || oldTxn?.Date || '',
      time: data.Time || data.time || oldTxn?.time || oldTxn?.Time || '',
      account: data.Account || data.account || oldTxn?.account || oldTxn?.Account || '',
      from_account: data.FromAccount || data.from_account || oldTxn?.from_account || oldTxn?.FromAccount || '',
      to_account: data.ToAccount || data.to_account || oldTxn?.to_account || oldTxn?.ToAccount || '',
      category: data.Category || data.category || oldTxn?.category || oldTxn?.Category || '',
      subcategory: data.Subcategory || data.subcategory || oldTxn?.subcategory || oldTxn?.Subcategory || '',
      note: data.Note !== undefined ? data.Note : (data.note !== undefined ? data.note : (oldTxn?.note || oldTxn?.Note || '')),
      description: data.Description !== undefined ? data.Description : (data.description !== undefined ? data.description : (oldTxn?.description || oldTxn?.Description || '')),
      inr: inrVal, amount: amtStr, currency: data.Currency || data.currency || oldTxn?.currency || oldTxn?.Currency || 'INR',
      type: typeVal, created_at: data.created_at || oldTxn?.created_at || now, updated_at: now, recurring_rule_id: data.recurring_rule_id !== undefined ? data.recurring_rule_id : (oldTxn?.recurring_rule_id || ''),
      tags: synchronizedTags, split_group_id: data.split_group_id || oldTxn?.split_group_id || '',
      receipt_image: data.receipt_image !== undefined ? data.receipt_image : (oldTxn?.receipt_image || ''),
      warranty_expiry: data.warranty_expiry !== undefined ? data.warranty_expiry : (oldTxn?.warranty_expiry || ''),
      serial_no: data.serial_no !== undefined ? data.serial_no : (oldTxn?.serial_no || ''),
      sub_account: data.SubAccount || data.sub_account || oldTxn?.sub_account || oldTxn?.SubAccount || '',
      from_sub_account: data.FromSubAccount || data.from_sub_account || data.SubAccount || data.sub_account || oldTxn?.from_sub_account || oldTxn?.FromSubAccount || '',
      to_sub_account: data.ToSubAccount || data.to_sub_account || oldTxn?.to_sub_account || oldTxn?.ToSubAccount || ''
    };
  }

  const mainOp = {
    storeName,
    id,
    operation: 'UPDATE',
    entity: rowObj
  };

  const allOps = [mainOp, ...stockOps];
  if (allOps.length > 1) {
    const bundleId = id;
    const bundleTotal = allOps.length;
    for (let i = 0; i < allOps.length; i++) {
      allOps[i].bundle_id = bundleId;
      allOps[i].bundle_index = i;
      allOps[i].bundle_total = bundleTotal;
    }
    await executeAtomicBatch({ operations: allOps, bundleId });
  } else {
    await executeAtomicMutation(mainOp);
  }

  return rowToTxn(rowObj);
};

export const convertTransactionToInstalment = async ({
  transactionId,
  updatedTransactionData,
  instalmentRule,
  schedule,
  oldRuleIdToRetire = null
}) => {
  if (!transactionId) throw new Error('convertTransactionToInstalment requires transactionId');
  if (!Array.isArray(schedule) || schedule.length < 2) {
    throw new Error('convertTransactionToInstalment requires a schedule with at least 2 parts');
  }
  const db = getDB();
  const now = new Date().toISOString();

  // 1. Fetch original transaction to ensure it exists
  const resTxn = await db.query('SELECT * FROM transactions WHERE id = ?', [transactionId]);
  const oldTxn = resTxn.values?.[0];
  if (!oldTxn) {
    throw new Error(`Transaction to convert not found: ${transactionId}`);
  }

  const operations = [];

  // 2. Retire obsolete recurring rule if specified
  if (oldRuleIdToRetire) {
    try {
      const resRule = await db.query('SELECT * FROM recurring_rules WHERE id = ?', [oldRuleIdToRetire]);
      const oldRule = resRule.values?.[0];
      if (oldRule) {
        operations.push({
          storeName: 'recurring_rules',
          id: oldRuleIdToRetire,
          operation: 'UPDATE',
          entity: {
            ...oldRule,
            status: 'cancelled',
            updated_at: now
          },
          expectedBaseEntity: oldRule
        });
      }
    } catch (e) {
      console.warn(`[convertTransactionToInstalment] Could not fetch old rule ${oldRuleIdToRetire}:`, e);
    }
  }

  // 3. New instalment recurring rule
  const ruleId = instalmentRule.id || uuid();
  const newRuleEntity = {
    ...instalmentRule,
    id: ruleId,
    rule_type: 'instalment',
    status: 'completed',
    total_parts: schedule.length,
    completed_parts: schedule.length,
    next_date: '',
    end_date: schedule[schedule.length - 1]?.date || '',
    amount_per_part: schedule[0]?.amount || 0,
    created_at: instalmentRule.created_at || now,
    updated_at: now
  };
  operations.push({
    storeName: 'recurring_rules',
    id: ruleId,
    operation: 'INSERT',
    entity: newRuleEntity
  });

  // 4. Update original transaction in-place as Part 1
  const part1 = schedule[0];
  const [iy0, im0, id0] = part1.date.split('-');
  const firstTxnDate = `${id0}/${im0}/${iy0}`;
  const baseNote = instalmentRule.base_note || oldTxn.note || '';
  const firstPartNote = buildInstalmentNote(baseNote, part1.part, part1.total);

  const updatedPart1Row = {
    id: transactionId,
    date: firstTxnDate,
    time: updatedTransactionData.Time || updatedTransactionData.time || oldTxn.time || '00:00',
    account: updatedTransactionData.Account || updatedTransactionData.account || oldTxn.account || '',
    from_account: updatedTransactionData.FromAccount || updatedTransactionData.from_account || oldTxn.from_account || '',
    to_account: updatedTransactionData.ToAccount || updatedTransactionData.to_account || oldTxn.to_account || '',
    category: updatedTransactionData.Category || updatedTransactionData.category || oldTxn.category || '',
    subcategory: updatedTransactionData.Subcategory !== undefined ? updatedTransactionData.Subcategory : (oldTxn.subcategory || ''),
    note: firstPartNote,
    description: updatedTransactionData.Description !== undefined ? updatedTransactionData.Description : (oldTxn.description || ''),
    inr: part1.amount,
    amount: String(part1.amount),
    currency: updatedTransactionData.Currency || oldTxn.currency || 'INR',
    type: updatedTransactionData['Income/Expense'] || updatedTransactionData.type || oldTxn.type || 'Expense',
    recurring_rule_id: ruleId,
    tags: updatedTransactionData.Tags !== undefined ? updatedTransactionData.Tags : (oldTxn.tags || ''),
    split_group_id: oldTxn.split_group_id || '',
    receipt_image: updatedTransactionData.receipt_image !== undefined ? updatedTransactionData.receipt_image : (oldTxn.receipt_image || ''),
    warranty_expiry: updatedTransactionData.warranty_expiry !== undefined ? updatedTransactionData.warranty_expiry : (oldTxn.warranty_expiry || ''),
    serial_no: updatedTransactionData.serial_no !== undefined ? updatedTransactionData.serial_no : (oldTxn.serial_no || ''),
    sub_account: updatedTransactionData.SubAccount !== undefined ? updatedTransactionData.SubAccount : (oldTxn.sub_account || ''),
    from_sub_account: updatedTransactionData.FromSubAccount !== undefined ? updatedTransactionData.FromSubAccount : (oldTxn.from_sub_account || ''),
    to_sub_account: updatedTransactionData.ToSubAccount !== undefined ? updatedTransactionData.ToSubAccount : (oldTxn.to_sub_account || ''),
    created_at: oldTxn.created_at || now,
    updated_at: now
  };
  operations.push({
    storeName: 'transactions',
    id: transactionId,
    operation: 'UPDATE',
    entity: updatedPart1Row,
    expectedBaseEntity: oldTxn
  });

  // 5. Create sibling transactions Parts 2..N
  const siblingRows = [];
  for (let i = 1; i < schedule.length; i++) {
    const inst = schedule[i];
    const [iy, im, id2] = inst.date.split('-');
    const instTxnDate = `${id2}/${im}/${iy}`;
    const sibId = uuid();
    const sibRow = {
      id: sibId,
      date: instTxnDate,
      time: updatedPart1Row.time,
      account: updatedPart1Row.account,
      from_account: updatedPart1Row.from_account,
      to_account: updatedPart1Row.to_account,
      category: updatedPart1Row.category,
      subcategory: updatedPart1Row.subcategory,
      note: buildInstalmentNote(baseNote, inst.part, inst.total),
      description: updatedPart1Row.description,
      inr: inst.amount,
      amount: String(inst.amount),
      currency: updatedPart1Row.currency,
      type: updatedPart1Row.type,
      recurring_rule_id: ruleId,
      tags: updatedPart1Row.tags,
      split_group_id: '',
      receipt_image: '',
      warranty_expiry: '',
      serial_no: '',
      sub_account: updatedPart1Row.sub_account,
      from_sub_account: updatedPart1Row.from_sub_account,
      to_sub_account: updatedPart1Row.to_sub_account,
      created_at: now,
      updated_at: now
    };
    siblingRows.push(sibRow);
    operations.push({
      storeName: 'transactions',
      id: sibId,
      operation: 'INSERT',
      entity: sibRow
    });
  }

  // 6. Assign bundle info
  const bundleId = transactionId;
  const bundleTotal = operations.length;
  for (let i = 0; i < operations.length; i++) {
    operations[i].bundle_id = bundleId;
    operations[i].bundle_index = i;
    operations[i].bundle_total = bundleTotal;
  }

  // 7. Execute atomic batch
  await executeAtomicBatch({ operations, bundleId });

  return {
    rule: newRuleEntity,
    updatedTransaction: rowToTxn(updatedPart1Row),
    siblingTransactions: siblingRows.map(rowToTxn),
    retiredRuleId: oldRuleIdToRetire
  };
};

export const deleteTransaction = async (id) => {
  const db = getDB();
  const stockOps = [];
  try {
    const res = await db.query('SELECT * FROM transactions WHERE id = ?', [id]);
    let txn = res.values?.[0];
    if (!txn) {
      const resInv = await db.query('SELECT * FROM investment_transactions WHERE id = ?', [id]);
      txn = resInv.values?.[0];
    }
    if (txn) {
      const stockRefTags = parseStockRefTags(txn.tags || txn.Tags || '');
      if (stockRefTags.length > 0) {
        const info = parseDescriptionStockInfo(txn.description);
        const now = new Date().toISOString();
        const modifiedItems = new Map();
        const originalItems = new Map();

        for (const tag of stockRefTags) {
          let itemId = tag.id;
          let qtyToRestore = tag.qty !== null ? tag.qty : (info ? info.qty : 0);
          let unitMode = info?.unit || 'pack';
          if (qtyToRestore > 0) {
            const item = await resolveInventoryItemForStockRef(db, itemId, info, txn);
            if (item) {
              if (!originalItems.has(item.id)) {
                originalItems.set(item.id, item);
              }
              const currentItem = modifiedItems.get(item.id) || item;
              const currQty = parseFloat(currentItem.qty) || 0;
              const subQtyVal = parseFloat(item.sub_qty) || 1;
              let finalQty = qtyToRestore;
              if (item.sub_unit && unitMode === item.sub_unit && subQtyVal > 0) {
                finalQty = qtyToRestore / subQtyVal;
              }
              const newQty = currQty + finalQty;
              const status = newQty > 0 ? 'available' : 'unavailable';
              modifiedItems.set(item.id, {
                ...currentItem,
                qty: newQty,
                status,
                updated_at: now
              });
            }
          }
        }

        for (const [resItemId, updatedEntity] of modifiedItems.entries()) {
          const originalEntity = originalItems.get(resItemId);
          stockOps.push({
            storeName: 'inventory',
            id: resItemId,
            operation: 'UPDATE',
            entity: updatedEntity,
            expectedBaseEntity: originalEntity
          });
        }
      }
    }
  } catch (err) {
    console.error('Failed to compute stock on transaction delete:', err);
  }

  // Fetch linked charge IDs before deleting to record companion tombstones
  let chargeIds = [];
  try {
    const [res1, res2] = await Promise.all([
      db.query('SELECT id FROM transactions WHERE split_group_id=?', [`inv_charge_${id}`]),
      db.query('SELECT id FROM investment_transactions WHERE split_group_id=?', [`inv_charge_${id}`])
    ]);
    const allFound = [...(res1.values || []).map(r => r.id), ...(res2.values || []).map(r => r.id)];
    chargeIds = Array.from(new Set(allFound));
  } catch {}

  const allIds = Array.from(new Set([id, ...chargeIds]));
  const ops = [...stockOps];

  for (const targetId of allIds) {
    const [hasTxn, hasInv] = await Promise.all([
      db.query('SELECT id FROM transactions WHERE id = ?', [targetId]),
      db.query('SELECT id FROM investment_transactions WHERE id = ?', [targetId])
    ]);

    if (hasTxn.values?.length > 0) {
      ops.push({
        storeName: 'transactions',
        id: targetId,
        operation: 'DELETE',
        tombstoneType: 'transaction'
      });
    }
    if (hasInv.values?.length > 0) {
      ops.push({
        storeName: 'investment_transactions',
        id: targetId,
        operation: 'DELETE',
        tombstoneType: 'transaction'
      });
    }
  }

  // Assign bundle metadata if multiple operations or companion charges exist
  const isBundle = ops.length > 1;
  const bundleId = isBundle ? id : null;
  const bundleTotal = ops.length;

  for (let i = 0; i < ops.length; i++) {
    if (isBundle) {
      ops[i].bundle_id = bundleId;
      ops[i].bundle_index = i;
      ops[i].bundle_total = bundleTotal;
    }
  }

  await executeAtomicBatch({ operations: ops, bundleId });
};

export const deleteAllTransactions = async ()  => {
  const db = getDB();
  const [tRes, invRes] = await Promise.all([
    db.query('SELECT id FROM transactions'),
    db.query('SELECT id FROM investment_transactions')
  ]);
  const ops = [];
  for (const r of (tRes.values || [])) {
    ops.push({
      storeName: 'transactions',
      id: r.id,
      operation: 'DELETE',
      tombstoneType: 'transaction'
    });
  }
  for (const r of (invRes.values || [])) {
    ops.push({
      storeName: 'investment_transactions',
      id: r.id,
      operation: 'DELETE',
      tombstoneType: 'transaction'
    });
  }
  if (ops.length > 0) {
    await executeAtomicBatch({ operations: ops });
  }
};

// Normalise any date value → dd/mm/yyyy string for storage.
// Matches same logic as xlsParser.normaliseCellDate:
//   Numeric serials: (serial−25569)×86400000 UTC ms formula.
// Money Manager XLS dates are TEXT: "dd/mm/yyyy HH:MM:SS" (Indian format, day first always)
export const normaliseDateStr = (raw) => {
  if (raw === null || raw === undefined || raw === '') return '';
  // Excel serial number (from SheetJS numeric cells)
  if (typeof raw === 'number' && raw > 1000) {
    const ms = (raw - 25569) * 86400 * 1000;
    const d  = new Date(ms);
    return String(d.getUTCDate()).padStart(2,'0') + '/' +
           String(d.getUTCMonth()+1).padStart(2,'0') + '/' +
           d.getUTCFullYear();
  }
  // JS Date object (cellDates:true)
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return '';
    return String(raw.getUTCDate()).padStart(2,'0') + '/' +
           String(raw.getUTCMonth()+1).padStart(2,'0') + '/' +
           raw.getUTCFullYear();
  }
  let s = String(raw).trim();
  if (!s) return '';

  // Excel serial number as a string (from CSV parsed lines)
  if (/^\d+(\.\d+)?$/.test(s)) {
    const num = parseFloat(s);
    if (num > 1000) {
      const ms = (num - 25569) * 86400 * 1000;
      const d  = new Date(ms);
      return String(d.getUTCDate()).padStart(2,'0') + '/' +
             String(d.getUTCMonth()+1).padStart(2,'0') + '/' +
             d.getUTCFullYear();
    }
  }

  // Strip time component: "dd/mm/yyyy HH:MM:SS" → "dd/mm/yyyy"
  s = s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?.*$/, '').trim();
  // ISO: yyyy-mm-dd
  const iso = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  // dd/mm/yyyy (Indian format — confirmed day-first from Money Manager export)
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const d = +dmy[1], m = +dmy[2], y = dmy[3];
    // Only swap if month position is clearly > 12 (unambiguous)
    if (m > 12 && d <= 12) return `${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')}/${y}`;
    return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
  }
  // Fallback
  const jsD = new Date(s);
  if (!isNaN(jsD)) {
    return String(jsD.getDate()).padStart(2,'0') + '/' +
           String(jsD.getMonth()+1).padStart(2,'0') + '/' +
           jsD.getFullYear();
  }
  return s;
};

// Normalise Income/Expense type string
const normaliseType = (raw) => {
  const s = String(raw || '').trim();
  if (s === 'Income') return 'Income';
  if (/^transfer.?in$/i.test(s))  return 'Transfer-In';
  if (s.toLowerCase().startsWith('transfer')) return 'Transfer-Out';
  return 'Expense';
};

// Generate a stable ID from a key string using a simple hash
// This ensures the same transaction always gets the same ID across imports
function deterministicId(key) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (h2 >>> 0) + (h1 >>> 0);
  return 'txn-' + n.toString(36).padStart(12, '0');
}

// Count existing transactions (fast check for empty DB)
export const getTransactionCount = async () => {
  const db = getDB();
  const res = await db.query('SELECT COUNT(*) as n FROM transactions', []);
  return (res.values?.[0]?.n) ?? 0;
};

// Analyse rows before import:
//   fileDupeCount  = rows with identical stableKey within the file itself
//   dbDupeCount    = rows whose stableKey already exists in the DB (merge scenario)

// Words that must never appear as account or category names —
// they are format/type markers that leak in from broken CSV rows.
const RESERVED_ACCT_WORDS  = new Set(['INR','USD','GBP','EUR','Transfer','Transfer-Out','Transfer-In']);
const RESERVED_CAT_WORDS   = new Set(['Transfer','Transfer-Out','Transfer-In','Income','Expense']);
const isReservedAcct = (s) => !s || RESERVED_ACCT_WORDS.has(s);
const isReservedCat  = (s) => !s || RESERVED_CAT_WORDS.has(s);

// A date string is valid if it looks like dd/mm/yyyy (after normalisation).
const isValidDateStr = (s) => /^\d{2}\/\d{2}\/\d{4}$/.test(String(s||'').trim());

export const getRowStableKey = (r, dateVal, acctName) => {
  const isInv = !!(r.InvestmentTransactionType || r.Brokerage);
  const timeVal = String(r.Time || r.time || '').trim();
  const amtVal = parseFloat(r.INR || r.Amount || r.inr || r.amount || 0);
  const noteVal = String(r.Note || r.note || '').trim();
  const descVal = String(r.Description || r.description || '').trim();

  if (isInv) {
    const invType = String(r.InvestmentTransactionType || '').trim();
    const broker = String(r.Brokerage || '').trim();
    const symbol = String(r.SecuritySymbol || '').trim();
    const isin = String(r.SecurityISIN || '').trim();
    const qty = parseFloat(r.Quantity || 0);
    const price = parseFloat(r.UnitPrice || 0);
    const val = parseFloat(r.TradeValue || 0);
    const tradeId = String(r.TradeId || '').trim();
    const orderId = String(r.OrderId || '').trim();
    const source = String(r.Source || '').trim();
    return `INV|${dateVal}|${timeVal}|${acctName}|${broker}|${invType}|${symbol}|${isin}|${qty}|${price}|${val}|${tradeId}|${orderId}|${amtVal}|${noteVal}|${descVal}|${source}`;
  }

  const catVal = String(r.Category || r.category || '').trim();
  const subVal = String(r.Subcategory || r.subcategory || '').trim();
  const toAcctVal = String(r.ToAccount || r.to_account || '').trim();
  const fromSub = String(r.FromSubAccount || r.from_sub_account || r.SubAccount || r.sub_account || '').trim();
  const toSub = String(r.ToSubAccount || r.to_sub_account || '').trim();
  return `GEN|${dateVal}|${timeVal}|${acctName}|${toAcctVal}|${fromSub}|${toSub}|${amtVal}|${catVal}|${subVal}|${noteVal}|${descVal}`;
};

export const analyseImport = async (rows) => {
  const seenKeys = new Map(); // stableKey → count
  const itemKeys = [];
  let invalidCount = 0;
  let investmentCount = 0;

  for (const r of rows) {
    const rawDate = r.Date || r.date || '';
    const dateVal = normaliseDateStr(rawDate);
    if (!isValidDateStr(dateVal)) {
      itemKeys.push(null);
      invalidCount++;
      continue;
    }
    const isInv = !!(r.InvestmentTransactionType || r.Brokerage);
    if (isInv) investmentCount++;

    const rawAcct = String(r.Account || r.account || '').trim();
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
    const acctName = looksNumeric(rawAcct)
      ? String(r.FromAccount || r.from_account || rawAcct).trim()
      : rawAcct;

    const stableKey = getRowStableKey(r, dateVal, acctName);
    itemKeys.push(stableKey);
    seenKeys.set(stableKey, (seenKeys.get(stableKey) || 0) + 1);
  }

  const fileDupeKeys = new Set([...seenKeys.entries()].filter(([, v]) => v > 1).map(([k]) => k));
  const fileDupeCount = itemKeys.filter(k => k && fileDupeKeys.has(k)).length;

  let dbDupeCount = 0;
  try {
    const db = getDB();
    const [existing, existingInv] = await Promise.all([
      db.query('SELECT id FROM transactions', []),
      db.query('SELECT id FROM investment_transactions', [])
    ]);
    const existingIds = new Set([
      ...(existing.values || []).map(r => r.id),
      ...(existingInv.values || []).map(r => r.id)
    ]);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const key = itemKeys[i];
      if (!key) continue;
      const id = r.ID || r.id || deterministicId(key);
      if (existingIds.has(id)) dbDupeCount++;
    }
  } catch (err) {
    console.warn('analyseImport duplicate check warning:', err);
  }

  const validTotal = rows.filter((_, i) => itemKeys[i] !== null).length;
  const newRows = Math.max(0, validTotal - dbDupeCount);

  return {
    total: validTotal,
    totalRows: rows.length,
    newRows,
    dbDupeCount,
    fileDupeCount,
    invalidCount,
    investmentCount
  };
};

export const bulkImport = async (rows, { firstImport = false } = {}) => {
  const db  = getDB();
  const now = new Date().toISOString();
  let imported = 0, skipped = 0;

  const genItems = [];
  const invItems = [];

  for (const r of rows) {
    const rawDate = r.Date || r.date || '';
    const dateVal = normaliseDateStr(rawDate);
    if (!isValidDateStr(dateVal)) { skipped++; continue; }

    const typeStr = normaliseType(r['Income/Expense'] || r.type || '');
    const isXfer  = typeStr.startsWith('Transfer');

    const rawAcct = String(r.Account || r.account || '').trim();
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
    const acctName = looksNumeric(rawAcct)
      ? String(r.FromAccount || r.from_account || rawAcct).trim()
      : rawAcct;

    const rawTo  = String(r.ToAccount  || r.to_account  || '').trim();
    const rawCat = String(r.Category   || r.category    || '').trim();
    const toAcctName = isXfer
      ? (rawTo && !isReservedAcct(rawTo) ? rawTo : rawCat)
      : '';

    const rawTime = String(r.Time||r.time||'').trim();
    const parseExcelTime = (s) => {
      if (!s) return '';
      if (/^\d{1,2}:\d{2}/.test(s)) return s.substring(0, 5);
      if (/[ap]m/i.test(s)) return s;
      const val = parseFloat(s);
      if (!isNaN(val)) {
        const fraction = val - Math.floor(val);
        const totalSeconds = Math.round(fraction * 86400);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      }
      return s;
    };
    const timeVal = parseExcelTime(rawTime);

    const stableKey = getRowStableKey(r, dateVal, acctName);
    const id = r.ID || r.id || (firstImport ? uuid() : deterministicId(stableKey));
    const categoryVal = isXfer ? toAcctName : rawCat;
    const rawSub = String(r.Subcategory || r.subcategory || '').trim();
    const subcategoryVal = rawSub.toLowerCase() === 'default' ? '' : rawSub;

    const isInv = !!(r.InvestmentTransactionType || r.Brokerage);

    if (isInv) {
      invItems.push({
        id,
        date: dateVal,
        time: timeVal,
        account: acctName,
        from_account: String(r.FromAccount || r.from_account || acctName || '').trim(),
        to_account: String(r.ToAccount || r.to_account || toAcctName || '').trim(),
        category: categoryVal,
        subcategory: subcategoryVal,
        note: String(r.Note || r.note || '').trim(),
        description: String(r.Description || r.description || '').trim(),
        inr: parseFloat(r.INR || r.Amount || r.inr || r.amount || 0),
        amount: String(r.Amount || r.INR || r.amount || r.inr || '0').trim(),
        currency: String(r.Currency || r.currency || 'INR').trim(),
        type: typeStr,
        created_at: r.created_at || r['Created At'] || r.Created_At || r.CreatedAt || now,
        updated_at: r.updated_at || r['Last Modified At'] || r.updated_at || r.UpdatedAt || r.Updated_At || now,
        recurring_rule_id: String(r.recurring_rule_id || '').trim(),
        tags: String(r.Tags || r.tags || '').trim(),
        split_group_id: String(r.split_group_id || '').trim(),
        receipt_image: String(r.receipt_image || '').trim(),
        warranty_expiry: String(r.warranty_expiry || '').trim(),
        serial_no: String(r.serial_no || '').trim(),
        sub_account: String(r.SubAccount || r.sub_account || '').trim(),
        from_sub_account: String(r.FromSubAccount || r.from_sub_account || r.SubAccount || r.sub_account || '').trim(),
        to_sub_account: String(r.ToSubAccount || r.to_sub_account || '').trim(),
        investment_transaction_type: String(r.InvestmentTransactionType || '').trim(),
        brokerage: String(r.Brokerage || '').trim(),
        security_symbol: String(r.SecuritySymbol || '').trim(),
        security_isin: String(r.SecurityISIN || '').trim(),
        quantity: parseFloat(r.Quantity || 0),
        unit_price: parseFloat(r.UnitPrice || 0),
        trade_value: parseFloat(r.TradeValue || 0),
        cost_basis: parseFloat(r.CostBasis || 0),
        cash_impact: parseFloat(r.CashImpact || 0),
        position_qty_change: parseFloat(r.PositionQuantityChange || 0),
        realized_pnl: parseFloat(r.RealizedPnl || 0),
        trade_id: String(r.TradeId || '').trim(),
        order_id: String(r.OrderId || '').trim(),
        exchange: String(r.Exchange || '').trim(),
        segment: String(r.Segment || '').trim(),
        source: String(r.Source || '').trim()
      });
    } else {
      genItems.push({
        id,
        date: dateVal,
        time: timeVal,
        account: acctName,
        from_account: String(r.FromAccount || r.from_account || acctName || '').trim(),
        to_account: String(r.ToAccount || r.to_account || toAcctName || '').trim(),
        category: categoryVal,
        subcategory: subcategoryVal,
        note: String(r.Note || r.note || '').trim(),
        description: String(r.Description || r.description || '').trim(),
        inr: parseFloat(r.INR || r.Amount || r.inr || r.amount || 0),
        amount: String(r.Amount || r.INR || r.amount || r.inr || '0').trim(),
        currency: String(r.Currency || r.currency || 'INR').trim(),
        type: typeStr,
        created_at: r.created_at || r['Created At'] || r.Created_At || r.CreatedAt || now,
        updated_at: r.updated_at || r['Last Modified At'] || r.updated_at || r.UpdatedAt || r.Updated_At || now,
        recurring_rule_id: String(r.recurring_rule_id || '').trim(),
        tags: String(r.Tags || r.tags || '').trim(),
        split_group_id: String(r.split_group_id || '').trim(),
        receipt_image: String(r.receipt_image || '').trim(),
        warranty_expiry: String(r.warranty_expiry || '').trim(),
        serial_no: String(r.serial_no || '').trim(),
        sub_account: String(r.SubAccount || r.sub_account || '').trim(),
        from_sub_account: String(r.FromSubAccount || r.from_sub_account || r.SubAccount || r.sub_account || '').trim(),
        to_sub_account: String(r.ToSubAccount || r.to_sub_account || '').trim()
      });
    }
  }

  const ops = [];
  if (genItems.length > 0) {
    const resGen = await db.query('SELECT id FROM transactions', []);
    const genIdSet = new Set((resGen.values || []).map(r => r.id));
    for (const obj of genItems) {
      if (!genIdSet.has(obj.id)) {
        ops.push({
          storeName: 'transactions',
          id: obj.id,
          operation: 'INSERT',
          entity: obj
        });
        imported++;
      } else {
        skipped++;
      }
    }
  }

  if (invItems.length > 0) {
    const resInv = await db.query('SELECT id FROM investment_transactions', []);
    const invIdSet = new Set((resInv.values || []).map(r => r.id));
    for (const obj of invItems) {
      if (!invIdSet.has(obj.id)) {
        ops.push({
          storeName: 'investment_transactions',
          id: obj.id,
          operation: 'INSERT',
          entity: obj
        });
        imported++;
      } else {
        skipped++;
      }
    }
  }

  if (ops.length > 0) {
    await executeAtomicBatch({ operations: ops });
  }

  return { imported, skipped, total: rows.length };
};