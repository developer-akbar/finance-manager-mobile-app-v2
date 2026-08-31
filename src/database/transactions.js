import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';

export const rowToTxn = (r) => {
  const base = {
    _id: r.id, ID: r.id,
    Date: r.date, Time: r.time || '',
    Account: r.account || '', FromAccount: r.from_account || '', ToAccount: r.to_account || '',
    Category: r.category || '', Subcategory: r.subcategory || '',
    Note: r.note || '', Description: r.description || '',
    INR: parseFloat(r.inr) || 0, Amount: r.amount || String(r.inr || 0),
    Currency: r.currency || 'INR', 'Income/Expense': r.type || 'Expense',
    created_at: r.created_at, updated_at: r.updated_at,
    recurring_rule_id: r.recurring_rule_id || '',
    Tags: r.tags || '',
    split_group_id: r.split_group_id || '',
    receipt_image: r.receipt_image || '',
    warranty_expiry: r.warranty_expiry || '',
    serial_no: r.serial_no || '',
    SubAccount: r.sub_account || '',
    FromSubAccount: r.from_sub_account || '',
    ToSubAccount: r.to_sub_account || '',
  };
  
  if (r.investment_transaction_type || r.brokerage) {
    return {
      ...base,
      InvestmentTransactionType: r.investment_transaction_type || '',
      Brokerage: r.brokerage || '',
      SecuritySymbol: r.security_symbol || '',
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
      Source: r.source || ''
    };
  }
  return base;
};

export const ensureZerodhaReconciliationTransaction = async (dbInstance) => {
  const db = dbInstance || getDB();
  try {
    const res = await db.query(
      `SELECT COUNT(*) as count FROM investment_transactions WHERE investment_transaction_type = 'RECONCILIATION' AND brokerage = 'Zerodha'`
    );
    const count = res.values?.[0]?.count ?? 0;
    if (count === 0) {
      const reconId = 'zerodha_opening_cash_recon_pre_tradebook';
      const now = new Date().toISOString();
      await db.run(
        `INSERT OR IGNORE INTO investment_transactions (
          id, date, time, account, from_account, to_account, category, subcategory, note, description,
          inr, amount, currency, type, created_at, updated_at, recurring_rule_id, tags, split_group_id,
          receipt_image, warranty_expiry, serial_no, sub_account, from_sub_account, to_sub_account,
          investment_transaction_type, brokerage, security_symbol, security_isin, quantity, unit_price,
          trade_value, cost_basis, cash_impact, position_qty_change, realized_pnl, trade_id, order_id, exchange, segment, source
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          reconId, '2024-04-01', '00:00:00', 'Share Market', 'Share Market', '', 'Finance', '',
          'Historical opening cash reconciliation for pre-tradebook activity',
          'RECONCILIATION | Broker=Zerodha | Amount=-1953.02 | Reason=Historical opening cash reconciliation for pre-tradebook activity',
          -1953.02, '-1953.02', 'INR', 'Expense', now, now, '', '', '',
          '', '', '', 'Zerodha', 'Zerodha', '',
          'RECONCILIATION', 'Zerodha', '', '', 0, 0,
          0, 0, -1953.02, 0, 0, '', '', '', '', 'Historical Reconciliation'
        ]
      );
    }
  } catch (err) {
    console.error('Failed to ensure Zerodha reconciliation transaction:', err);
  }
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

  const txns = [
    ...(res1.values || []).map(rowToTxn),
    ...(res2.values || []).map(rowToTxn)
  ];

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
  const db  = getDB();
  const id  = data.ID || data._id || uuid();
  const now = new Date().toISOString();
  
  const isInv = !!(data.InvestmentTransactionType || data.Brokerage);
  
  if (isInv) {
    await db.run(
      `INSERT OR IGNORE INTO investment_transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at,recurring_rule_id,tags,split_group_id,receipt_image,warranty_expiry,serial_no,sub_account,from_sub_account,to_sub_account,investment_transaction_type,brokerage,security_symbol,security_isin,quantity,unit_price,trade_value,cost_basis,cash_impact,position_qty_change,realized_pnl,trade_id,order_id,exchange,segment,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, data.Date||'', data.Time||'', data.Account||'', data.FromAccount||'', data.ToAccount||'',
       data.Category||'', data.Subcategory||'', data.Note||'', data.Description||'',
       parseFloat(data.INR||data.Amount||0), String(data.Amount||data.INR||'0'),
       data.Currency||'INR', data['Income/Expense']||'Expense', now, now,
       data.recurring_rule_id||'', data.Tags||data.tags||'', data.split_group_id||'',
       data.receipt_image||'', data.warranty_expiry||'', data.serial_no||'',
       data.SubAccount||data.sub_account||'',
       data.FromSubAccount||data.from_sub_account||data.SubAccount||data.sub_account||'',
       data.ToSubAccount||data.to_sub_account||'',
       data.InvestmentTransactionType||'', data.Brokerage||'', data.SecuritySymbol||'', data.SecurityISIN||'',
       parseFloat(data.Quantity||0), parseFloat(data.UnitPrice||0), parseFloat(data.TradeValue||0),
       parseFloat(data.CostBasis||0), parseFloat(data.CashImpact||0), parseFloat(data.PositionQuantityChange||0),
       parseFloat(data.RealizedPnl||0), data.TradeId||'', data.OrderId||'', data.Exchange||'', data.Segment||'', data.Source||'']
    );
    return rowToTxn({
      id, date:data.Date||'', time:data.Time||'', account:data.Account||'', from_account:data.FromAccount||'', to_account:data.ToAccount||'',
      category:data.Category||'', subcategory:data.Subcategory||'', note:data.Note||'', description:data.Description||'',
      inr:parseFloat(data.INR||data.Amount||0), amount:String(data.Amount||data.INR||'0'), currency:data.Currency||'INR',
      type:data['Income/Expense']||'Expense', created_at:now, updated_at:now, recurring_rule_id:data.recurring_rule_id||'',
      tags:data.Tags||data.tags||'', split_group_id:data.split_group_id||'',
      receipt_image:data.receipt_image||'', warranty_expiry:data.warranty_expiry||'', serial_no:data.serial_no||'',
      sub_account:data.SubAccount||data.sub_account||'',
      from_sub_account:data.FromSubAccount||data.from_sub_account||data.SubAccount||data.sub_account||'',
      to_sub_account:data.ToSubAccount||data.to_sub_account||'',
      investment_transaction_type:data.InvestmentTransactionType||'', brokerage:data.Brokerage||'', security_symbol:data.SecuritySymbol||'', security_isin:data.SecurityISIN||'',
      quantity:parseFloat(data.Quantity||0), unit_price:parseFloat(data.UnitPrice||0), trade_value:parseFloat(data.TradeValue||0),
      cost_basis:parseFloat(data.CostBasis||0), cash_impact:parseFloat(data.CashImpact||0), position_qty_change:parseFloat(data.PositionQuantityChange||0),
      realized_pnl:parseFloat(data.RealizedPnl||0), trade_id:data.TradeId||'', order_id:data.OrderId||'', exchange:data.Exchange||'', segment:data.Segment||'', source:data.Source||''
    });
  } else {
    await db.run(
      `INSERT OR IGNORE INTO transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at,recurring_rule_id,tags,split_group_id,receipt_image,warranty_expiry,serial_no,sub_account,from_sub_account,to_sub_account) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, data.Date||'', data.Time||'', data.Account||'', data.FromAccount||'', data.ToAccount||'',
       data.Category||'', data.Subcategory||'', data.Note||'', data.Description||'',
       parseFloat(data.INR||data.Amount||0), String(data.Amount||data.INR||'0'),
       data.Currency||'INR', data['Income/Expense']||'Expense', now, now,
       data.recurring_rule_id||'', data.Tags||data.tags||'', data.split_group_id||'',
       data.receipt_image||'', data.warranty_expiry||'', data.serial_no||'',
       data.SubAccount||data.sub_account||'',
       data.FromSubAccount||data.from_sub_account||data.SubAccount||data.sub_account||'',
       data.ToSubAccount||data.to_sub_account||'']
    );
    return rowToTxn({
      id, date:data.Date||'', time:data.Time||'', account:data.Account||'', from_account:data.FromAccount||'', to_account:data.ToAccount||'',
      category:data.Category||'', subcategory:data.Subcategory||'', note:data.Note||'', description:data.Description||'',
      inr:parseFloat(data.INR||data.Amount||0), amount:String(data.Amount||data.INR||'0'), currency:data.Currency||'INR',
      type:data['Income/Expense']||'Expense', created_at:now, updated_at:now, recurring_rule_id:data.recurring_rule_id||'',
      tags:data.Tags||data.tags||'', split_group_id:data.split_group_id||'',
      receipt_image:data.receipt_image||'', warranty_expiry:data.warranty_expiry||'', serial_no:data.serial_no||'',
      sub_account:data.SubAccount||data.sub_account||'',
      from_sub_account:data.FromSubAccount||data.from_sub_account||data.SubAccount||data.sub_account||'',
      to_sub_account:data.ToSubAccount||data.to_sub_account||''
    });
  }
};

const parseDescriptionStockInfo = (description) => {
  if (!description) return null;
  const match = description.match(/^(Used|Lent)\s+([\d\.\s\/]+)\s+(\w+)\s+of\s+/i);
  if (!match) return null;

  const type = match[1].toLowerCase();
  const qtyStr = match[2].trim();
  const unit = match[3].trim();

  let qty = 0;
  if (qtyStr.includes('/')) {
    if (qtyStr.includes(' ')) {
      const parts = qtyStr.split(/\s+/);
      const whole = parseFloat(parts[0]) || 0;
      const fracParts = parts[1].split('/');
      const num = parseFloat(fracParts[0]) || 0;
      const den = parseFloat(fracParts[1]) || 1;
      qty = whole + (num / den);
    } else {
      const parts = qtyStr.split('/');
      const num = parseFloat(parts[0]) || 0;
      const den = parseFloat(parts[1]) || 1;
      qty = num / den;
    }
  } else {
    qty = parseFloat(qtyStr) || 0;
  }

  return { type, qty, unit };
};

const syncStockOnTxnChange = async (oldTxn, newTxn) => {
  const parseStockRefs = (tagsStr) => {
    return (tagsStr || '').split(' ').filter(t => t.startsWith('#stock_ref_')).map(tag => {
      const content = tag.replace('#stock_ref_', '');
      const parts = content.split(':');
      return {
        id: parts[0],
        qty: parts.length > 1 ? parseFloat(parts[1]) || 0 : null
      };
    });
  };

  const oldRefs = parseStockRefs(oldTxn.tags || oldTxn.Tags);
  const newRefs = parseStockRefs(newTxn.tags || newTxn.Tags);
  const oldIds = oldRefs.map(r => r.id);
  const newIds = newRefs.map(r => r.id);

  // 1. Restore any old ref that is no longer present in newRefs
  const removedRefs = oldRefs.filter(r => !newIds.includes(r.id));
  if (removedRefs.length > 0) {
    const { restoreInventoryItem } = await import('./inventory.js');
    const oldInfo = parseDescriptionStockInfo(oldTxn.description);
    for (const r of removedRefs) {
      let restoreQty = r.qty;
      if (restoreQty === null) {
        restoreQty = oldInfo ? oldInfo.qty : 0;
      }
      if (restoreQty > 0) {
        await restoreInventoryItem(r.id, restoreQty, oldInfo && oldInfo.unit === 'sub' ? 'sub' : 'pack');
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
        const { getDB } = await import('./db.js');
        const db = getDB();
        const res = await db.query('SELECT * FROM inventory WHERE id = ?', [firstRef.id]);
        const item = res.values?.[0];
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
          await db.run(
            'UPDATE inventory SET qty = ?, status = ?, updated_at = ? WHERE id = ?',
            [newQty, status, new Date().toISOString(), firstRef.id]
          );
        }
      }
    }
  }

  // 3. Deduct any new ref that was added
  const addedRefs = newRefs.filter(r => !oldIds.includes(r.id));
  if (addedRefs.length > 0) {
    const { getDB } = await import('./db.js');
    const db = getDB();
    const newInfo = parseDescriptionStockInfo(newTxn.description);
    for (const r of addedRefs) {
      let deductQty = r.qty;
      if (deductQty === null) {
        deductQty = newInfo ? newInfo.qty : 0;
      }
      if (deductQty > 0) {
        const res = await db.query('SELECT * FROM inventory WHERE id = ?', [r.id]);
        const item = res.values?.[0];
        if (item) {
          const subQtyVal = parseFloat(item.sub_qty) || 1;
          let qtyInPacks = deductQty;
          if (newInfo && item.sub_unit && newInfo.unit === item.sub_unit && subQtyVal > 0 && r.qty === null) {
            qtyInPacks = deductQty / subQtyVal;
          }
          const currQty = parseFloat(item.qty) || 0;
          const newQty = Math.max(0, currQty - qtyInPacks);
          const status = newQty > 0.0001 ? 'available' : 'unavailable';
          await db.run(
            'UPDATE inventory SET qty = ?, status = ?, updated_at = ? WHERE id = ?',
            [newQty, status, new Date().toISOString(), r.id]
          );
        }
      }
    }
  }
};

export const updateTransaction = async (id, data) => {
  const db = getDB();
  const now = new Date().toISOString();
  try {
    const res = await db.query('SELECT * FROM transactions WHERE id = ?', [id]);
    const oldTxn = res.values?.[0];
    if (oldTxn) {
      const newTxn = {
        tags: data.Tags || data.tags || '',
        description: data.Description || ''
      };
      await syncStockOnTxnChange(oldTxn, newTxn);
    }
  } catch (err) {
    console.error('Failed to sync stock on transaction edit:', err);
  }

  await Promise.all([
    db.run('DELETE FROM transactions WHERE id=?', [id]),
    db.run('DELETE FROM investment_transactions WHERE id=?', [id])
  ]);

  const result = await addTransaction({ ...data, ID: id });
  return result;
};

export const deleteTransaction = async (id) => {
  const db = getDB();
  try {
    const res = await db.query('SELECT * FROM transactions WHERE id = ?', [id]);
    let txn = res.values?.[0];
    if (!txn) {
      const resInv = await db.query('SELECT * FROM investment_transactions WHERE id = ?', [id]);
      txn = resInv.values?.[0];
    }
    if (txn) {
      const stockRefTags = (txn.tags || txn.Tags || '').split(' ').filter(t => t.startsWith('#stock_ref_'));
      if (stockRefTags.length > 0) {
        const { restoreInventoryItem } = await import('./inventory.js');
        const info = parseDescriptionStockInfo(txn.description);
        for (const tag of stockRefTags) {
          const content = tag.replace('#stock_ref_', '');
          let itemId = content;
          let qtyToRestore = 0;
          if (content.includes(':')) {
            const parts = content.split(':');
            itemId = parts[0];
            qtyToRestore = parseFloat(parts[1]) || 0;
            if (qtyToRestore > 0) {
              await restoreInventoryItem(itemId, qtyToRestore, 'pack');
            }
          } else {
            qtyToRestore = info ? info.qty : 0;
            if (qtyToRestore > 0) {
              await restoreInventoryItem(itemId, qtyToRestore, info.unit);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Failed to restore stock on transaction delete:', err);
  }
  await Promise.all([
    db.run('DELETE FROM transactions WHERE id=?', [id]),
    db.run('DELETE FROM investment_transactions WHERE id=?', [id])
  ]);
};
export const deleteAllTransactions = async ()  => {
  const db = getDB();
  await Promise.all([
    db.run('DELETE FROM transactions'),
    db.run('DELETE FROM investment_transactions')
  ]);
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

export const analyseImport = async (rows) => {
  const seenKeys = new Map(); // stableKey → count
  const itemKeys = [];

  for (const r of rows) {
    const rawDate = r.Date || r.date || '';
    const dateVal = normaliseDateStr(rawDate);
    if (!isValidDateStr(dateVal)) { itemKeys.push(null); continue; }
    const typeStr = normaliseType(r['Income/Expense'] || r.type || '');
    const isXfer  = typeStr.startsWith('Transfer');
    const rawAcct = String(r.Account || r.account || '').trim();
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
    const acctName = looksNumeric(rawAcct)
      ? String(r.FromAccount || r.from_account || rawAcct).trim()
      : rawAcct;
    const stableKey = `${dateVal}|${String(r.Time||r.time||'').trim()}|${acctName}|${parseFloat(r.INR||r.Amount||r.inr||r.amount||0)}|${String(r.Note||r.note||'').trim()}`;
    itemKeys.push(stableKey);
    seenKeys.set(stableKey, (seenKeys.get(stableKey) || 0) + 1);
  }

  const fileDupeKeys = new Set([...seenKeys.entries()].filter(([,v])=>v>1).map(([k])=>k));
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

  return { total: rows.filter((_,i) => itemKeys[i] !== null).length, fileDupeCount, dbDupeCount };
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

    const stableKey = `${dateVal}|${rawTime}|${acctName}|${parseFloat(r.INR||r.Amount||r.inr||r.amount||0)}|${String(r.Note||r.note||'').trim()}`;
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

  if (genItems.length > 0) {
    if (typeof db.bulkInsertIgnore === 'function') {
      const res = await db.bulkInsertIgnore('transactions', genItems);
      imported += res.added;
      skipped += res.skipped;
    } else {
      for (const obj of genItems) {
        try {
          const res = await db.run(
            `INSERT OR IGNORE INTO transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at,recurring_rule_id,tags,split_group_id,receipt_image,warranty_expiry,serial_no,sub_account,from_sub_account,to_sub_account) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [obj.id, obj.date, obj.time, obj.account, obj.from_account, obj.to_account,
             obj.category, obj.subcategory, obj.note, obj.description,
             obj.inr, obj.amount, obj.currency, obj.type, obj.created_at, obj.updated_at,
             obj.recurring_rule_id, obj.tags, obj.split_group_id,
             obj.receipt_image, obj.warranty_expiry, obj.serial_no,
             obj.sub_account, obj.from_sub_account, obj.to_sub_account]
          );
          if (res.changes?.changes > 0) imported++; else skipped++;
        } catch { skipped++; }
      }
    }
  }

  if (invItems.length > 0) {
    if (typeof db.bulkInsertIgnore === 'function') {
      const res = await db.bulkInsertIgnore('investment_transactions', invItems);
      imported += res.added;
      skipped += res.skipped;
    } else {
      for (const obj of invItems) {
        try {
          const res = await db.run(
            `INSERT OR IGNORE INTO investment_transactions (id,date,time,account,from_account,to_account,category,subcategory,note,description,inr,amount,currency,type,created_at,updated_at,recurring_rule_id,tags,split_group_id,receipt_image,warranty_expiry,serial_no,sub_account,from_sub_account,to_sub_account,investment_transaction_type,brokerage,security_symbol,security_isin,quantity,unit_price,trade_value,cost_basis,cash_impact,position_qty_change,realized_pnl,trade_id,order_id,exchange,segment,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [obj.id, obj.date, obj.time, obj.account, obj.from_account, obj.to_account,
             obj.category, obj.subcategory, obj.note, obj.description,
             obj.inr, obj.amount, obj.currency, obj.type, obj.created_at, obj.updated_at,
             obj.recurring_rule_id, obj.tags, obj.split_group_id,
             obj.receipt_image, obj.warranty_expiry, obj.serial_no,
             obj.sub_account, obj.from_sub_account, obj.to_sub_account,
             obj.investment_transaction_type, obj.brokerage, obj.security_symbol, obj.security_isin,
             obj.quantity, obj.unit_price, obj.trade_value, obj.cost_basis, obj.cash_impact,
             obj.position_qty_change, obj.realized_pnl, obj.trade_id, obj.order_id, obj.exchange, obj.segment, obj.source]
          );
          if (res.changes?.changes > 0) imported++; else skipped++;
        } catch { skipped++; }
      }
    }
  }

  return { imported, skipped, total: rows.length };
};