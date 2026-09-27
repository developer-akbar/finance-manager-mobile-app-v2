import { getDB } from './db.js';
import { v4 as uuid } from 'uuid';
import { addTransaction } from './transactions.js';
import { saveRecurringRule, buildInstalmentSchedule, buildInstalmentNote } from './recurring.js';
import { parseStockLine, getCanonicalProductName } from '../utils/stockInventoryNormalization.js';
import { executeAtomicMutation, executeAtomicBatch } from './atomicMutation.js';
import { computeEntityDiff } from '../utils/entityDiff.js';

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

export const addInventoryPurchase = async (fromAccountOrData, maybeDate, maybeItems, noteText = 'in stock', timeText = '') => {
  let fromAccount, date, items;
  if (typeof fromAccountOrData === 'object' && fromAccountOrData !== null && !maybeDate) {
    fromAccount = fromAccountOrData.fromAccount || fromAccountOrData.account || 'Cash';
    date = fromAccountOrData.date || new Date().toISOString().slice(0, 10);
    items = fromAccountOrData.items || [];
    noteText = fromAccountOrData.noteText || fromAccountOrData.note || noteText;
    timeText = fromAccountOrData.timeText || fromAccountOrData.time || timeText;
  } else {
    fromAccount = fromAccountOrData;
    date = maybeDate || new Date().toISOString().slice(0, 10);
    items = maybeItems || [];
  }
  const now = new Date().toISOString();
  let totalAmount = 0;
  const itemDetails = [];

  const formattedDate = date.includes('/') ? date : date.split('-').reverse().join('/');
  const formattedTime = timeText || new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5);

  const txnId = uuid();
  const isoDate = date.includes('/') ? date.split('/').reverse().join('-') : date;

  const ops = [];
  const inventoryRows = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const packQty = parseFloat(item.pack_qty) || 1;
    const subQty = parseFloat(item.sub_qty) || 1;
    const subUnit = item.sub_unit || 'pcs';
    const partsVal = parseFloat(item.original_qty) || 1;
    const remainingParts = item.qty !== '' && item.qty !== undefined && !isNaN(parseFloat(item.qty))
      ? parseFloat(item.qty)
      : partsVal;
    const originalPrice = parseFloat(item.price) || 0;
    const discountedPrice = item.discounted_price !== undefined && !isNaN(parseFloat(item.discounted_price))
      ? parseFloat(item.discounted_price)
      : originalPrice;

    totalAmount += discountedPrice;

    const cleanedName = cleanItemName(item.name);
    
    const sizePart = partsVal > 1 ? `${subQty}${subUnit}*${partsVal}` : `${subQty}${subUnit}`;
    const suffix = remainingParts < partsVal ? `, ${remainingParts}` : '';
    const statusWord = remainingParts > 0 ? 'stock available' : 'stock unavailable';
    itemDetails.push(`${cleanedName} ${statusWord} ${sizePart}: ${originalPrice}: @${discountedPrice}${suffix}`);

    const status = remainingParts > 0 ? 'available' : 'unavailable';
    const batchId = `${isoDate}_${txnId}_${i}`;
    const unitPrice = partsVal > 0 ? (discountedPrice / partsVal) : discountedPrice;

    const row = {
      id: batchId,
      name: cleanedName,
      qty: remainingParts,
      unit: item.unit || 'pcs',
      price: originalPrice,
      discounted_price: unitPrice,
      status,
      purchased_date: isoDate,
      notes: item.notes || '',
      updated_at: now,
      sub_qty: subQty,
      sub_unit: subUnit,
      original_qty: partsVal,
      pack_qty: packQty,
      discount_type: item.discountType || 'final_price',
      discount_value: parseFloat(item.discountValue) || 0,
      category: item.category || '',
      brand: item.brand || ''
    };
    inventoryRows.push(row);
  }

  const roundedTotal = Math.round(totalAmount);
  const description = itemDetails.join('\n');
  const txn = {
    id: txnId,
    _id: txnId,
    ID: txnId,
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

  const totalBundleItems = inventoryRows.length + 1;
  // Event 0: Transfer transaction
  ops.push({
    storeName: 'transactions',
    id: txnId,
    operation: 'INSERT',
    entity: {
      id: txnId,
      date: formattedDate,
      time: formattedTime,
      account: fromAccount,
      from_account: fromAccount,
      to_account: 'Stock',
      category: 'Transfer',
      subcategory: '',
      note: noteText,
      description,
      inr: roundedTotal,
      amount: String(roundedTotal),
      currency: 'INR',
      type: 'Transfer-Out',
      created_at: now,
      updated_at: now,
      recurring_rule_id: '',
      tags: '#stock #inventory',
      split_group_id: '',
      receipt_image: '',
      warranty_expiry: '',
      serial_no: '',
      sub_account: '',
      from_sub_account: '',
      to_sub_account: ''
    },
    bundle_id: txnId,
    bundle_index: 0,
    bundle_total: totalBundleItems
  });

  // Events 1..K: Inventory items
  for (let i = 0; i < inventoryRows.length; i++) {
    const invRow = inventoryRows[i];
    ops.push({
      storeName: 'inventory',
      id: invRow.id,
      operation: 'INSERT',
      entity: invRow,
      bundle_id: txnId,
      bundle_index: i + 1,
      bundle_total: totalBundleItems
    });
  }

  await executeAtomicBatch({ operations: ops, bundleId: txnId });
  return { txnId, totalAmount: roundedTotal, items: inventoryRows };
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
  const ops = [];

  // Clicked item first
  const currQty = parseFloat(item.qty) || 0;
  const deductFromCurrent = Math.min(currQty > 0 ? currQty : remainingToConsume, remainingToConsume);
  const newQty = Math.max(0, currQty - deductFromCurrent);
  const status = newQty > 0.0001 ? 'available' : 'unavailable';

  if (res.values?.[0]) {
    const updatedClickedItem = {
      ...item,
      qty: newQty,
      status,
      updated_at: now
    };
    ops.push({
      storeName: 'inventory',
      id: itemId,
      operation: 'UPDATE',
      entity: updatedClickedItem,
      expectedBaseEntity: item
    });
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

      const updatedOtherItem = {
        ...other,
        qty: newQtyOther,
        status: statusOther,
        updated_at: now
      };
      ops.push({
        storeName: 'inventory',
        id: other.id,
        operation: 'UPDATE',
        entity: updatedOtherItem,
        expectedBaseEntity: other
      });

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

  const bundleId = uuid();

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
    const ruleId = uuid();

    const rule = {
      id: ruleId,
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
      created_at: now
    };

    const schedule = buildInstalmentSchedule(rule);
    rule.total_parts = schedule.length;
    rule.completed_parts = schedule.length;
    rule.next_date = '';
    rule.end_date = schedule[schedule.length - 1]?.date || '';
    rule.amount_per_part = schedule[0]?.amount || 0;

    ops.push({
      storeName: 'recurring_rules',
      id: ruleId,
      operation: 'INSERT',
      entity: rule
    });

    for (const inst of schedule) {
      const [iy, im, id2] = inst.date.split('-');
      const instTxnDate = `${id2}/${im}/${iy}`;
      const instTxnId = uuid();
      ops.push({
        storeName: 'transactions',
        id: instTxnId,
        operation: 'INSERT',
        entity: {
          id: instTxnId,
          date: instTxnDate,
          time: finalTime,
          account: 'Stock',
          from_account: 'Stock',
          to_account: '',
          category: category,
          subcategory: subcategory || 'Default',
          note: buildInstalmentNote(baseInstalmentNote, inst.part, inst.total),
          description: description,
          inr: inst.amount,
          amount: String(inst.amount),
          currency: 'INR',
          type: 'Expense',
          created_at: now,
          updated_at: now,
          recurring_rule_id: ruleId,
          tags: `#stock #instalment ${stockTags}`,
          split_group_id: '',
          receipt_image: '',
          warranty_expiry: '',
          serial_no: '',
          sub_account: '',
          from_sub_account: '',
          to_sub_account: ''
        }
      });
    }
  } else {
    const finalNote = (userNote || '').trim() || (usageType === 'lend' ? `Lend to ${personName.trim()}` : '');
    const txnId = uuid();
    ops.push({
      storeName: 'transactions',
      id: txnId,
      operation: 'INSERT',
      entity: {
        id: txnId,
        date: formattedDate,
        time: finalTime,
        account: usageType === 'lend' ? 'Lend' : 'Stock',
        from_account: usageType === 'lend' ? 'Lend' : 'Stock',
        to_account: '',
        category: usageType === 'lend' ? 'Lend' : category,
        subcategory: usageType === 'lend' ? '' : subcategory,
        note: finalNote,
        description: description,
        inr: roundedExpense,
        amount: String(roundedExpense),
        currency: 'INR',
        type: 'Expense',
        created_at: now,
        updated_at: now,
        recurring_rule_id: '',
        tags: `#stock #${usageType === 'lend' ? 'lent' : 'consumed'} ${stockTags}`,
        split_group_id: '',
        receipt_image: '',
        warranty_expiry: '',
        serial_no: '',
        sub_account: '',
        from_sub_account: '',
        to_sub_account: ''
      }
    });
  }

  // Index bundle
  const bundleTotal = ops.length;
  for (let i = 0; i < ops.length; i++) {
    ops[i].bundle_id = bundleId;
    ops[i].bundle_index = i;
    ops[i].bundle_total = bundleTotal;
  }

  await executeAtomicBatch({ operations: ops, bundleId });
  return { bundleId, totalAmount: roundedExpense, deductions };
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

  let targetId = id;
  const existingRes = await db.query('SELECT * FROM inventory WHERE id = ?', [id]);
  const isExisting = existingRes.values && existingRes.values.length > 0;

  const entity = {
    id: targetId,
    name: cleanedName,
    qty,
    unit: data.unit || 'pcs',
    price,
    discounted_price: discPrice,
    status,
    purchased_date: data.purchased_date || '',
    notes: data.notes || '',
    updated_at: now,
    sub_qty: parseFloat(data.sub_qty) || 1,
    sub_unit: data.sub_unit || '',
    original_qty,
    pack_qty,
    discount_type: data.discount_type || 'percentage',
    discount_value: parseFloat(data.discount_value) || 0,
    category: data.category || '',
    brand: data.brand || ''
  };

  await executeAtomicMutation({
    storeName: 'inventory',
    entityId: targetId,
    operation: isExisting ? 'UPDATE' : 'INSERT',
    entityData: entity
  });

  return targetId;
};

export const deleteInventoryItem = async (itemId) => {
  await executeAtomicMutation({
    storeName: 'inventory',
    entityId: itemId,
    operation: 'DELETE',
    tombstoneType: 'inventory'
  });
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

  const updatedItem = {
    ...item,
    qty: newQty,
    status,
    updated_at: new Date().toISOString()
  };

  await executeAtomicMutation({
    storeName: 'inventory',
    entityId: itemId,
    operation: 'UPDATE',
    entityData: updatedItem
  });
};

export const syncStockFromPastTransactions = async () => {
  const db = getDB();
  const now = new Date().toISOString();

  // Query all past transactions matching To:Stock, Stock category, #stock tags, or stock descriptions
  const [res, curInvRes] = await Promise.all([
    db.query(
      "SELECT * FROM transactions WHERE to_account = 'Stock' OR category = 'Stock' OR tags LIKE '%stock%' OR description LIKE '%stock available%' OR description LIKE '%stock unavailable%'",
      []
    ),
    db.query('SELECT * FROM inventory', [])
  ]);

  const txns = res.values || [];
  const curInventory = curInvRes.values || [];
  const newInventoryRows = [];

  for (const r of txns) {
    const desc = r.description || '';
    const lines = desc.split('\n');

    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
      const line = lines[lIdx];
      const parsed = parseStockLine(line, r, lIdx);
      if (!parsed) continue;

      const batchId = parsed.id || parsed.batchId || `${parsed.purchasedDate}_${r.id}_${lIdx}`;
      let discountType = 'percentage';
      let discountValue = 0;
      if (parsed.mrp > 0 && parsed.paid < parsed.mrp) {
        discountType = 'percentage';
        discountValue = Number((((parsed.mrp - parsed.paid) / parsed.mrp) * 100).toFixed(2));
      }

      newInventoryRows.push({
        id: batchId,
        name: parsed.canonicalProduct || parsed.cleanedName,
        qty: parsed.remainingQty,
        unit: parsed.unit || 'pcs',
        price: parsed.mrp,
        discounted_price: parsed.unitPrice,
        status: parsed.status,
        purchased_date: parsed.purchasedDate,
        notes: parsed.source || '',
        updated_at: now,
        sub_qty: parsed.sub_qty || 1,
        sub_unit: parsed.sub_unit || '',
        original_qty: parsed.purchasedQty || 1,
        pack_qty: parsed.purchasedQty || 1,
        discount_type: discountType,
        discount_value: discountValue,
        category: parsed.category || '',
        brand: parsed.brand || ''
      });
    }
  }

  const diff = await computeEntityDiff(curInventory, newInventoryRows, 'id');
  const ops = diff.operations.map(op => ({
    storeName: 'inventory',
    id: op.id,
    operation: op.operation,
    entity: op.entity,
    expectedBaseEntity: op.oldEntity || (op.operation === 'DELETE' ? op.entity : null),
    base_checksum: op.base_checksum,
    new_checksum: op.new_checksum,
    tombstoneType: op.operation === 'DELETE' ? 'inventory' : null
  }));

  if (ops.length > 0) {
    await executeAtomicBatch({ operations: ops });
  }

  return newInventoryRows.length;
};
