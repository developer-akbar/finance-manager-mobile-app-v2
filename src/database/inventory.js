import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';
import { addTransaction } from './transactions.js';
import { saveRecurringRule, buildInstalmentSchedule, buildInstalmentNote } from './recurring.js';
import { parseStockLine, getCanonicalProductName } from '../utils/stockInventoryNormalization.js';

const formatFraction = (val) => {
  if (val === 0 || !val) return '0';
  const integerPart = Math.floor(val);
  const decimalPart = val - integerPart;

  if (decimalPart < 0.005) {
    return String(integerPart);
  }
  if (Math.abs(decimalPart - 1) < 0.005) {
    return String(integerPart + 1);
  }

  const epsilon = 0.01;
  const fractions = [
    { dec: 0.5, frac: '1/2' },
    { dec: 0.25, frac: '1/4' },
    { dec: 0.75, frac: '3/4' },
    { dec: 1/3, frac: '1/3' },
    { dec: 2/3, frac: '2/3' },
    { dec: 1/8, frac: '1/8' },
    { dec: 3/8, frac: '3/8' },
    { dec: 5/8, frac: '5/8' },
    { dec: 7/8, frac: '7/8' },
    { dec: 0.2, frac: '1/5' },
    { dec: 0.4, frac: '2/5' },
    { dec: 0.6, frac: '3/5' },
    { dec: 0.8, frac: '4/5' },
    { dec: 1/6, frac: '1/6' },
    { dec: 5/6, frac: '5/6' },
  ];

  for (const item of fractions) {
    if (Math.abs(decimalPart - item.dec) < epsilon) {
      return integerPart > 0 ? `${integerPart} ${item.frac}` : item.frac;
    }
  }

  return String(parseFloat(val.toFixed(3)));
};

const cleanItemName = (rawName) => {
  if (!rawName) return '';
  let name = rawName.trim();
  // Strip trailing size patterns like " 10kg", " 500g", " 1L", " 125g*8", " 600g*2"
  name = name.replace(/\s+([\d\.]+)\s*(kg|g|ml|l|pcs|pc|box|pack|bottle|oz|m)s?(\s*[\*x]\s*\d+)?\s*$/i, '');
  return name.trim();
};

export const getInventoryItems = async () => {
  const db = getDB();
  const res = await db.query('SELECT * FROM inventory ORDER BY purchased_date DESC, updated_at DESC', []);
  return res.values || [];
};

export const addInventoryPurchase = async (fromAccount, date, items, noteText = 'in stock', timeText = '') => {
  const db = getDB();
  const now = new Date().toISOString();
  let totalAmount = 0;
  const itemDetails = [];

  const formattedDate = date.includes('/') ? date : date.split('-').reverse().join('/');
  const formattedTime = timeText || new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5);

  for (const item of items) {
    const packQty = parseFloat(item.pack_qty) || 1; // Items/Packs bought
    const subQty = parseFloat(item.sub_qty) || 1;   // Pack Size (e.g. 200)
    const subUnit = item.sub_unit || 'pcs';         // Pack Unit (e.g. g)
    const partsVal = parseFloat(item.original_qty) || 1; // Parts (e.g. 4)
    const remainingParts = item.qty !== '' && item.qty !== undefined && !isNaN(parseFloat(item.qty))
      ? parseFloat(item.qty)
      : partsVal; // Available Parts (e.g. 4)
    const originalPrice = parseFloat(item.price) || 0; // Original Price of batch (e.g. 360)
    const discountedPrice = item.discounted_price !== undefined && !isNaN(parseFloat(item.discounted_price))
      ? parseFloat(item.discounted_price)
      : originalPrice; // Discounted Price of batch (e.g. 324)

    totalAmount += discountedPrice;

    const cleanedName = cleanItemName(item.name);
    
    // Formatting description line
    const sizePart = partsVal > 1 ? `${subQty}${subUnit}*${partsVal}` : `${subQty}${subUnit}`;
    const suffix = remainingParts < partsVal ? `, ${remainingParts}` : '';
    const statusWord = remainingParts > 0 ? 'stock available' : 'stock unavailable';
    itemDetails.push(`${cleanedName} ${statusWord} ${sizePart}: ${originalPrice}: @${discountedPrice}${suffix}`);

    const status = remainingParts > 0 ? 'available' : 'unavailable';
    const id = uuid();
    
    // Calculate unit price per part
    const unitPrice = partsVal > 0 ? (discountedPrice / partsVal) : discountedPrice;

    await db.run(
      'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date, notes, updated_at, sub_qty, sub_unit, original_qty, pack_qty, discount_type, discount_value, category, brand) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, cleanedName, remainingParts, item.unit || 'pcs', originalPrice, unitPrice, status, date, item.notes || '', now, subQty, subUnit, partsVal, packQty, item.discountType || 'final_price', parseFloat(item.discountValue) || 0, item.category || '', item.brand || '']
    );
  }

  // Always save rounded values for transactions
  const roundedTotal = Math.round(totalAmount);
  const description = itemDetails.join('\n');
  const txn = {
    Date: formattedDate,
    Time: formattedTime,
    Account: fromAccount,
    FromAccount: fromAccount,
    ToAccount: 'Stock',
    Category: 'Transfer',
    Subcategory: '',
    Note: noteText,
    Description: description,
    INR: roundedTotal,
    Amount: String(roundedTotal),
    Currency: 'INR',
    'Income/Expense': 'Transfer-Out',
    tags: '#stock #inventory',
  };

  await addTransaction(txn);
};

export const consumeInventoryItem = async (
  itemId,
  qtyToConsume,
  date,
  useSubUnit = false,
  category = 'To Home',
  subcategory = 'Groceries',
  usageType = 'consume',
  personName = '',
  instalmentMonths = 3,
  timeStr = '',
  userNote = '',
  batchMeta = null
) => {
  const db = getDB();
  const now = new Date().toISOString();

  const res = await db.query('SELECT * FROM inventory WHERE id = ?', [itemId]);
  let item = res.values?.[0];
  if (!item && batchMeta) {
    const rawBatchId = batchMeta.batchId || batchMeta.id || itemId;
    item = {
      id: rawBatchId,
      name: batchMeta.cleanedName || batchMeta.rawName || batchMeta.canonicalProduct || batchMeta.name,
      qty: batchMeta.remainingQty !== undefined ? batchMeta.remainingQty : (batchMeta.qty !== undefined ? batchMeta.qty : 1),
      sub_qty: batchMeta.sub_qty || 1,
      sub_unit: batchMeta.sub_unit || 'pcs',
      unit: batchMeta.unit || 'pcs',
      price: batchMeta.mrp || batchMeta.price || 0,
      discounted_price: batchMeta.unitPrice || batchMeta.discounted_price || 0,
      purchased_date: batchMeta.purchasedDate || batchMeta.purchased_date || '',
      notes: batchMeta.source || batchMeta.notes || ''
    };
  }
  if (!item) throw new Error('Item not found in stock');

  const subQtyVal = parseFloat(item.sub_qty) || 1;
  let finalQtyToConsume = qtyToConsume;
  if (useSubUnit && subQtyVal > 0) {
    finalQtyToConsume = qtyToConsume / subQtyVal;
  }

  // 1. Get all batches of the same name to validate total quantity (filtering/sorting done in JS to support IndexedDB query limitations)
  const allRes = await db.query(
    'SELECT * FROM inventory WHERE name = ?',
    [item.name]
  );
  const nameLower = (item.name || '').toLowerCase();
  const allBatches = (allRes.values || []).filter(b => (b.name || '').toLowerCase() === nameLower && (parseFloat(b.qty) || 0) > 0.0001);

  const totalAvailablePacks = allBatches.length > 0
    ? allBatches.reduce((sum, b) => {
        const bQty = parseFloat(b.qty) || 0;
        return sum + (bQty > 0.0001 ? bQty : 0);
      }, 0)
    : (parseFloat(item.qty) || 0);

  if (finalQtyToConsume > (totalAvailablePacks + 0.0001) && totalAvailablePacks > 0) {
    throw new Error(`Insufficient total stock. You requested ${formatFraction(finalQtyToConsume)} packs but only have ${formatFraction(totalAvailablePacks)} packs in total.`);
  }

  // 2. Perform sequential FIFO deduction (starting with clicked item first, then oldest other batches)
  let remainingToConsume = finalQtyToConsume;
  let totalCost = 0;
  const detailsList = [];
  const deductions = [];

  // Clicked item first
  const currQty = parseFloat(item.qty) || 0;
  const deductFromCurrent = Math.min(currQty > 0 ? currQty : remainingToConsume, remainingToConsume);
  const newQty = Math.max(0, currQty - deductFromCurrent);
  const status = newQty > 0.0001 ? 'available' : 'unavailable';

  if (res.values?.[0]) {
    await db.run(
      'UPDATE inventory SET qty = ?, status = ?, updated_at = ? WHERE id = ?',
      [newQty, status, now, itemId]
    );
  }

  const pricePaidPerPack = parseFloat(item.discounted_price) || parseFloat(item.price) || 0;
  totalCost += deductFromCurrent * pricePaidPerPack;
  remainingToConsume -= deductFromCurrent;

  const targetBatchRef = batchMeta?.batchId || batchMeta?.id || item.id || itemId;

  if (deductFromCurrent > 0.0001) {
    deductions.push({ id: targetBatchRef, qty: deductFromCurrent });
    const batchDate = item.purchased_date
      ? new Date(item.purchased_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'unknown date';
    const batchStore = item.notes ? ` from ${item.notes}` : '';
    const consumedStrCurrent = useSubUnit
      ? `${formatFraction(deductFromCurrent * subQtyVal)} ${item.sub_unit || 'g'}`
      : `${formatFraction(deductFromCurrent)} ${item.unit || 'pcs'}`;
    detailsList.push(`${consumedStrCurrent} (bought on ${batchDate}${batchStore})`);
  }

  // Other batches next
  if (remainingToConsume > 0.0001) {
    const otherBatches = (allRes.values || []).filter(b => (b.name || '').toLowerCase() === nameLower && b.id !== itemId && (parseFloat(b.qty) || 0) > 0.0001);
    otherBatches.sort((a, b) => (a.purchased_date || '').localeCompare(b.purchased_date || '') || (a.updated_at || '').localeCompare(b.updated_at || ''));

    for (const other of otherBatches) {
      if (remainingToConsume <= 0.0001) break;

      const otherQty = parseFloat(other.qty) || 0;
      if (otherQty <= 0.0001) continue;

      const deductFromOther = Math.min(otherQty, remainingToConsume);
      if (deductFromOther <= 0.0001) continue;

      const newQtyOther = Math.max(0, otherQty - deductFromOther);
      const statusOther = newQtyOther > 0.0001 ? 'available' : 'unavailable';

      await db.run(
        'UPDATE inventory SET qty = ?, status = ?, updated_at = ? WHERE id = ?',
        [newQtyOther, statusOther, now, other.id]
      );

      const otherPrice = parseFloat(other.discounted_price) || parseFloat(other.price) || 0;
      totalCost += deductFromOther * otherPrice;
      remainingToConsume -= deductFromOther;

      if (deductFromOther > 0.0001) {
        deductions.push({ id: other.id, qty: deductFromOther });
        const otherSubQty = parseFloat(other.sub_qty) || 1;
        const otherDate = other.purchased_date
          ? new Date(other.purchased_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
          : 'unknown date';
        const otherStore = other.notes ? ` from ${other.notes}` : '';
        const consumedStrOther = useSubUnit
          ? `${formatFraction(deductFromOther * otherSubQty)} ${other.sub_unit || 'g'}`
          : `${formatFraction(deductFromOther)} ${other.unit || 'pcs'}`;
        detailsList.push(`${consumedStrOther} (bought on ${otherDate}${otherStore})`);
      }
    }
  }

  const roundedExpense = Math.round(totalCost);
  const formattedDate = date.includes('/') ? date : date.split('-').reverse().join('/');
  const finalTime = timeStr || new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5);

  let labelPrefix = 'Used';
  if (usageType === 'lend') labelPrefix = 'Lent';
  else if (usageType === 'instalment') labelPrefix = 'Instalment Use';

  const totalQtyStr = formatFraction(qtyToConsume);
  const totalConsumedStr = useSubUnit
    ? `${totalQtyStr} ${item.sub_unit || 'g'}`
    : `${totalQtyStr} ${item.unit || 'pcs'}`;

  const description = `${labelPrefix} ${totalConsumedStr} of ${item.name} (${detailsList.join(', ')})`;
  const stockTags = deductions.map(d => `#stock_ref_${d.id}:${d.qty}`).join(' ');

  if (usageType === 'instalment') {
    // Convert date format to YYYY-MM-DD for recurring engine
    let isoStartDate = date;
    if (date.includes('/')) {
      const [dd, mm, yyyy] = date.split('/');
      isoStartDate = `${yyyy}-${mm}-${dd}`;
    }

    const months = parseInt(instalmentMonths) || 3;
    const totalDays = months * 30;
    const baseInstalmentNote = (userNote || '').trim() || 'consumed';

    const rule = {
      rule_type: 'instalment',
      status: 'completed', // all parts created upfront
      txn_type: 'Expense',
      account: 'Stock',
      from_account: 'Stock',
      to_account: '',
      category: category,
      subcategory: subcategory || 'Default',
      base_note: baseInstalmentNote,
      description: description,
      currency: 'INR',
      total_amount: roundedExpense,
      total_days: totalDays,
      start_date: isoStartDate,
      schedule_mode: 'on_date',
    };

    const schedule = buildInstalmentSchedule(rule);
    rule.total_parts = schedule.length;
    rule.completed_parts = schedule.length;
    rule.next_date = '';
    rule.end_date = schedule[schedule.length - 1]?.date || '';
    rule.amount_per_part = schedule[0]?.amount || 0;

    const saved = await saveRecurringRule(rule);

    for (const inst of schedule) {
      const [iy, im, id2] = inst.date.split('-');
      const instTxnDate = `${id2}/${im}/${iy}`;
      await addTransaction({
        Date: instTxnDate,
        Time: finalTime,
        Account: 'Stock',
        FromAccount: 'Stock',
        ToAccount: '',
        Category: category,
        Subcategory: subcategory || 'Default',
        Note: buildInstalmentNote(baseInstalmentNote, inst.part, inst.total),
        Description: description,
        INR: inst.amount,
        Amount: String(inst.amount),
        Currency: 'INR',
        'Income/Expense': 'Expense',
        recurring_rule_id: saved.id,
        Tags: `#stock #instalment ${stockTags}`,
      });
    }
  } else {
    const finalNote = (userNote || '').trim() || (usageType === 'lend' ? `Lend to ${personName.trim()}` : '');
    const txn = {
      Date: formattedDate,
      Time: finalTime,
      Account: usageType === 'lend' ? 'Lend' : 'Stock',
      FromAccount: usageType === 'lend' ? 'Lend' : 'Stock',
      ToAccount: '',
      Category: usageType === 'lend' ? 'Lend' : category,
      Subcategory: usageType === 'lend' ? '' : subcategory,
      Note: finalNote,
      Description: description,
      INR: roundedExpense,
      Amount: String(roundedExpense),
      Currency: 'INR',
      'Income/Expense': 'Expense',
      tags: `#stock #${usageType === 'lend' ? 'lent' : 'consumed'} ${stockTags}`,
    };
    await addTransaction(txn);
  }
};

export const updateInventoryItem = async (id, data) => {
  const db = getDB();
  const now = new Date().toISOString();
  const qty = parseFloat(data.qty) || 0;
  const price = parseFloat(data.price) || 0;
  const discPrice = parseFloat(data.discounted_price) || price;
  const status = qty > 0 ? 'available' : 'unavailable';
  const original_qty = parseFloat(data.original_qty) || qty;
  const pack_qty = parseFloat(data.pack_qty) || 1;
  const cleanedName = cleanItemName(data.name);

  await db.run(
    'UPDATE inventory SET name = ?, qty = ?, unit = ?, price = ?, discounted_price = ?, status = ?, purchased_date = ?, notes = ?, updated_at = ?, sub_qty = ?, sub_unit = ?, original_qty = ?, pack_qty = ?, discount_type = ?, discount_value = ?, category = ?, brand = ? WHERE id = ?',
    [cleanedName, qty, data.unit || '', price, discPrice, status, data.purchased_date || '', data.notes || '', now, parseFloat(data.sub_qty) || 1, data.sub_unit || '', original_qty, pack_qty, data.discount_type || 'percentage', parseFloat(data.discount_value) || 0, data.category || '', data.brand || '', id]
  );
};

export const deleteInventoryItem = async (itemId) => {
  const db = getDB();
  await db.run('DELETE FROM inventory WHERE id = ?', [itemId]);
};

export const restoreInventoryItem = async (itemId, qtyToRestore, unitMode) => {
  const db = getDB();
  const res = await db.query('SELECT * FROM inventory WHERE id = ?', [itemId]);
  const item = res.values?.[0];
  if (!item) return;

  const currQty = parseFloat(item.qty) || 0;
  const subQtyVal = parseFloat(item.sub_qty) || 1;

  let finalQtyToRestore = qtyToRestore;
  if (item.sub_unit && unitMode === item.sub_unit && subQtyVal > 0) {
    finalQtyToRestore = qtyToRestore / subQtyVal;
  }

  const newQty = currQty + finalQtyToRestore;
  const status = newQty > 0 ? 'available' : 'unavailable';

  await db.run(
    'UPDATE inventory SET qty = ?, status = ?, updated_at = ? WHERE id = ?',
    [newQty, status, new Date().toISOString(), itemId]
  );
};

export const syncStockFromPastTransactions = async () => {
  const db = getDB();
  const now = new Date().toISOString();

  // Query all past transactions matching To:Stock, Stock category, #stock tags, or stock descriptions
  const res = await db.query(
    "SELECT * FROM transactions WHERE to_account = 'Stock' OR category = 'Stock' OR tags LIKE '%stock%' OR description LIKE '%stock available%' OR description LIKE '%stock unavailable%'",
    []
  );
  
  const txns = res.values || [];
  let parsedCount = 0;

  // Clear existing items to prevent duplicates
  await db.run('DELETE FROM inventory', []);

  for (const r of txns) {
    const desc = r.description || '';
    const lines = desc.split('\n');

    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
      const line = lines[lIdx];
      const parsed = parseStockLine(line, r, lIdx);
      if (!parsed) continue;

      const id = uuid();
      let discountType = 'percentage';
      let discountValue = 0;
      if (parsed.mrp > 0 && parsed.paid < parsed.mrp) {
        discountType = 'percentage';
        discountValue = Number((((parsed.mrp - parsed.paid) / parsed.mrp) * 100).toFixed(2));
      }

      await db.run(
        'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date, notes, updated_at, sub_qty, sub_unit, original_qty, pack_qty, discount_type, discount_value, category, brand) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          parsed.canonicalProduct || parsed.cleanedName,
          parsed.remainingQty,
          parsed.unit || 'pcs',
          parsed.mrp,
          parsed.unitPrice,
          parsed.status,
          parsed.purchasedDate,
          parsed.source || '',
          now,
          parsed.sub_qty || 1,
          parsed.sub_unit || '',
          parsed.purchasedQty || 1,
          parsed.purchasedQty || 1,
          discountType,
          discountValue,
          parsed.category || '',
          parsed.brand || ''
        ]
      );
      parsedCount++;
    }
  }
  
  return parsedCount;
};
