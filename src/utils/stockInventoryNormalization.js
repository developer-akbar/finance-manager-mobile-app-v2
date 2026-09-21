/**
 * Stock Inventory Normalization & Product History Engine
 * 
 * Provides deterministic normalization for stock inventory purchase batches,
 * canonical product resolution, variant/pack configurations, and product-level aggregations.
 */

/**
 * Clean and parse complex arithmetic price expressions
 * (e.g. "139*5", "@125*5", "626", "@187 @174", "180 @118", "@210/2", "247 @191")
 */
export function parsePriceExpression(expr) {
  if (!expr) return null;
  const clean = expr.trim();

  // Whitespace-separated token pairs within a segment e.g. "247 @191"
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const parsedTokens = tokens.map(t => parsePriceExpression(t)).filter(Boolean);
    return parsedTokens;
  }

  // Multiplier arithmetic e.g. "139*5", "@125*5", "@97.5*4", "282*4"
  const multMatch = clean.match(/^@?([\d\.]+)\s*[\*x]\s*([\d\.]+)$/i);
  if (multMatch) {
    const p1 = parseFloat(multMatch[1]) || 0;
    const p2 = parseFloat(multMatch[2]) || 0;
    return {
      raw: clean,
      unitVal: p1,
      multiplier: p2,
      totalVal: Number((p1 * p2).toFixed(2)),
      isDiscounted: clean.startsWith('@')
    };
  }

  // Division arithmetic e.g. "@210/2", "@176/2"
  const divMatch = clean.match(/^@?([\d\.]+)\s*\/\s*([\d\.]+)$/i);
  if (divMatch) {
    const p1 = parseFloat(divMatch[1]) || 0;
    const p2 = parseFloat(divMatch[2]) || 1;
    return {
      raw: clean,
      unitVal: p1 / p2,
      multiplier: 1,
      totalVal: Number((p1 / p2).toFixed(2)),
      isDiscounted: clean.startsWith('@')
    };
  }

  // Plain number e.g. "219", "@187", "626", "1123"
  const numMatch = clean.match(/^@?([\d\.]+)$/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]) || 0;
    return {
      raw: clean,
      unitVal: val,
      multiplier: 1,
      totalVal: val,
      isDiscounted: clean.startsWith('@')
    };
  }

  return null;
}

/**
 * Standardize text title casing
 */
export const toTitleCase = (str) => {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Strip trailing size specification from item name
 */
export const cleanRawItemName = (rawName) => {
  if (!rawName) return '';
  let name = rawName.trim();
  // Strip trailing size patterns like " 10kg", " 500g", " 1L", " 125g*8", " 600g*2", " 5L"
  name = name.replace(/\s+([\d\.]+)\s*(kg|g|ml|l|pcs|pc|box|pack|bottle|oz|m)s?(\s*[\*x]\s*[\d\.]+)?\s*$/i, '');
  return name.replace(/\s+/g, ' ').trim();
};

/**
 * Resolves a raw item name to its canonical product name.
 * Product identity is strictly lexical and DOES NOT depend on price parsing.
 * NO generic rule maps Gemini to Cooking Oil.
 */
export const getCanonicalProductName = (rawName) => {
  if (!rawName) return 'Unknown Product';
  let name = (rawName || '').trim();
  name = name.replace(/^(?:stock\s+)?unavailable\s+/i, '').trim();
  name = name.replace(/\s+(?:stock\s+)?unavailable$/i, '').trim();

  const lower = cleanRawItemName(name).toLowerCase();

  if (lower.startsWith('gemini tea') || lower === 'gemini' || lower.startsWith('gemini tea powder')) {
    return 'Gemini Tea';
  }
  if (lower.startsWith('peanut oil')) {
    return 'Peanut Oil';
  }
  if (lower.startsWith('oil') || lower.startsWith('cooking oil') || lower === 'sunflower oil' || lower.startsWith('fortune oil')) {
    return 'Cooking Oil';
  }
  if (lower.startsWith('santoor red') || lower.startsWith('santoor white') || lower.startsWith('santoor')) {
    return 'Santoor Soap';
  }
  if (lower.startsWith('cinthol')) {
    return 'Cinthol Soap';
  }
  if (lower.startsWith('pears')) {
    return 'Pears Soap';
  }
  if (lower.startsWith('mysore sandal')) {
    return 'Mysore Sandal Soap';
  }
  if (lower.startsWith('margo')) {
    return 'Margo Soap';
  }
  if (lower.startsWith('colgate') || lower.startsWith('kid toothbrush') || lower.startsWith('baby toothbrush')) {
    return lower.includes('toothbrush') ? 'Toothbrush' : 'Colgate Toothpaste';
  }
  if (lower.startsWith('tide')) {
    return 'Tide Detergent';
  }
  if (lower.startsWith('ariel')) {
    return 'Ariel Detergent';
  }
  if (lower.startsWith('pestro') || lower.startsWith('presto')) {
    if (lower.includes('toilet')) return 'Presto Toilet Cleaner';
    if (lower.includes('bathroom')) return 'Presto Bathroom Cleaner';
    if (lower.includes('floor')) return 'Presto Floor Cleaner';
    if (lower.includes('gel') || lower.includes('dish')) return 'Presto Dishwash Gel';
    if (lower.includes('detergent')) return 'Presto Detergent';
    return 'Presto Cleaners';
  }
  if (lower.startsWith('dabur amla')) {
    return 'Dabur Amla Hair Oil';
  }
  if (lower.startsWith('parachute')) {
    return 'Parachute Hair Oil';
  }
  if (lower.startsWith('bajaj')) {
    return 'Bajaj Almond Hair Oil';
  }
  if (lower.startsWith('lifebuoy') || lower.startsWith('lifebouy')) {
    return lower.includes('sanitizer') ? 'Lifebuoy Hand Sanitizer' : 'Lifebuoy Hand Wash';
  }
  if (lower.startsWith('goodnight') || lower.startsWith('good night')) {
    return 'Good Knight Repellent';
  }
  if (lower.startsWith('himalaya diaper')) {
    return 'Himalaya Diapers';
  }
  if (lower.startsWith('basmati')) {
    return 'Basmati Rice';
  }
  if (lower.startsWith('phool makhana') || lower === 'makhana') {
    return 'Phool Makhana';
  }
  if (lower.startsWith('pumpkin seeds') || lower === 'pumpkin, sunflower seeds') {
    return 'Pumpkin Seeds';
  }

  return toTitleCase(cleanRawItemName(name));
};

/**
 * Parse a raw stock inventory line into a structured batch object
 */
export const parseStockLine = (rawLine, txn = {}, lineIdx = 0) => {
  const cleanLine = (rawLine || '').trim();
  if (!cleanLine) return null;

  const isAvail = cleanLine.toLowerCase().includes('stock available');
  const isUnavail = cleanLine.toLowerCase().includes('stock unavailable');
  if (!isAvail && !isUnavail) return null;
  const status = isAvail ? 'available' : 'unavailable';

  // 1. Remove status token and clean whitespace
  let lineWithoutStatus = cleanLine.replace(/stock (available|unavailable)/i, ' ').replace(/\s+/g, ' ').trim();

  // 2. Extract trailing remaining parts after comma (e.g. ", 7" or ", 1")
  let explicitRemaining = null;
  const commaIdx = lineWithoutStatus.lastIndexOf(',');
  if (commaIdx !== -1) {
    const afterComma = lineWithoutStatus.slice(commaIdx + 1).trim();
    const matchNum = afterComma.match(/^(\d+(?:\.\d+)?)/);
    if (matchNum) {
      explicitRemaining = parseFloat(matchNum[1]);
    }
    lineWithoutStatus = lineWithoutStatus.slice(0, commaIdx).trim();
  }

  // 3. Segment by colons
  let rawSegments = lineWithoutStatus.split(':').map(s => s.trim()).filter(Boolean);
  let itemHeader = rawSegments[0] || '';
  let priceSegments = rawSegments.slice(1);

  let productName = itemHeader;
  let variantStr = '';
  let subQty = 1;
  let subUnit = '';
  let packQty = 1;

  // 4. Extract size / variant
  const sizeMultMatch = itemHeader.match(/^(.*?)(?:^|\s+)([\d\.]+)\s*([a-zA-Z]+)\s*[\*x]\s*([\d\.]+)(?:\s+(.*))?$/i);
  const sizeSingleMatch = itemHeader.match(/^(.*?)(?:^|\s+)([\d\.]+)\s*(kg|g|ml|l|pcs|pc|box|pack|bottle|oz|m)s?(?:\s+(.*))?$/i);

  if (sizeMultMatch) {
    productName = sizeMultMatch[1].trim();
    subQty = parseFloat(sizeMultMatch[2]) || 1;
    subUnit = sizeMultMatch[3];
    packQty = parseFloat(sizeMultMatch[4]) || 1;
    variantStr = `${subQty}${subUnit}*${packQty}`;
    if (sizeMultMatch[5]) {
      priceSegments.unshift(sizeMultMatch[5].trim());
    }
  } else if (sizeSingleMatch) {
    productName = sizeSingleMatch[1].trim();
    subQty = parseFloat(sizeSingleMatch[2]) || 1;
    subUnit = sizeSingleMatch[3];
    packQty = 1;
    variantStr = `${subQty}${subUnit}`;
    if (sizeSingleMatch[4]) {
      priceSegments.unshift(sizeSingleMatch[4].trim());
    }
  }

  // Check for trailing pack count after unit (e.g. "parachute 1L 2" -> packQty = 2)
  const trailingPackCountMatch = productName.match(/^(.*?)\s+(\d+)$/);
  if (trailingPackCountMatch && (variantStr.includes('L') || variantStr.includes('ml') || variantStr.includes('g') || variantStr.includes('kg'))) {
    productName = trailingPackCountMatch[1].trim();
    packQty = parseFloat(trailingPackCountMatch[2]) || packQty;
  }

  if (!productName && itemHeader) {
    productName = itemHeader;
  }
  productName = productName.replace(/^(?:stock\s+)?unavailable\s+/i, '').trim();
  if (!variantStr) variantStr = 'Standard';

  // 4b. Explicit deterministic recovery for verified legacy Standard patterns
  if (variantStr === 'Standard') {
    // 1. Triple multiplier pattern 1A: e.g. "Santoor white 125g*5*2"
    const tripleA = itemHeader.match(/(?:^|\s+)([\d\.]+)\s*(g|gm|gms|kg|ml|l|ltr|litre|litres)\s*[\*xX]\s*(\d+)\s*[\*xX]\s*(\d+)/i);
    if (tripleA) {
      const u = (tripleA[2].toLowerCase() === 'litre' || tripleA[2].toLowerCase() === 'litres') ? 'L' : tripleA[2];
      variantStr = `${tripleA[1]}${u}*${tripleA[3]}*${tripleA[4]}`;
      subQty = parseFloat(tripleA[1]) || 1;
      subUnit = u;
    } else {
      // 2. Triple multiplier pattern 1B: e.g. "Cinthol 6*100g*4"
      const tripleB = itemHeader.match(/(?:^|\s+)(\d+)\s*[\*xX]\s*([\d\.]+)\s*(g|gm|gms|kg|ml|l|ltr|litre|litres)\s*[\*xX]\s*(\d+)/i);
      if (tripleB) {
        const u = (tripleB[3].toLowerCase() === 'litre' || tripleB[3].toLowerCase() === 'litres') ? 'L' : tripleB[3];
        variantStr = `${tripleB[1]}*${tripleB[2]}${u}*${tripleB[4]}`;
        subQty = parseFloat(tripleB[2]) || 1;
        subUnit = u;
      } else {
        // 3. Leading count multiplier: e.g. "Cinthol 9*100g", "pestro 4*750ml", "Pestro glass cleaner 3*500ml", "Pestro dish gel 4*750ml"
        const countUnit = itemHeader.match(/(?:^|\s+)(\d+)\s*[\*xX]\s*([\d\.]+)\s*(g|gm|gms|kg|ml|l|ltr|litre|litres)(?:\s+|$|:)/i);
        if (countUnit) {
          const u = (countUnit[3].toLowerCase() === 'litre' || countUnit[3].toLowerCase() === 'litres') ? 'L' : countUnit[3];
          variantStr = `${countUnit[1]}*${countUnit[2]}${u}`;
          subQty = parseFloat(countUnit[2]) || 1;
          subUnit = u;
        } else {
          // 4. Explicit '1litre' / '1liter' in name e.g. "Honey 1litre"
          const litreMatch = itemHeader.match(/(?:^|\s+)([\d\.]+)\s*(litre|liter|litres)(?:\s+|$|:)/i);
          if (litreMatch) {
            variantStr = `${litreMatch[1]}L`;
            subQty = parseFloat(litreMatch[1]) || 1;
            subUnit = 'L';
          } else {
            // 5. Explicit count multiplier e.g. "toothbrush 6*2"
            if (cleanLine.toLowerCase().includes('toothbrush')) {
              const tbMatch = itemHeader.match(/(\d+)\s*[\*xX]\s*(\d+)/);
              if (tbMatch) {
                variantStr = `${tbMatch[1]}*${tbMatch[2]}`;
                subQty = parseFloat(tbMatch[1]) || 1;
                subUnit = 'pcs';
              }
            }
          }
        }
      }
    }
  }

  // 5. Parse Price Tokens
  const flatTokens = [];
  priceSegments.forEach(seg => {
    const segSizeMult = seg.match(/^([\d\.]+)\s*([a-zA-Z]+)\s*[\*x]\s*([\d\.]+)$/i);
    const segSizeSingle = seg.match(/^([\d\.]+)\s*(kg|g|ml|l|pcs|pc|box|pack|bottle|oz|m)s?$/i);
    if (segSizeMult && variantStr === 'Standard') {
      subQty = parseFloat(segSizeMult[1]) || 1;
      subUnit = segSizeMult[2];
      packQty = parseFloat(segSizeMult[3]) || 1;
      variantStr = `${subQty}${subUnit}*${packQty}`;
      return;
    } else if (segSizeSingle && variantStr === 'Standard') {
      subQty = parseFloat(segSizeSingle[1]) || 1;
      subUnit = segSizeSingle[2];
      packQty = 1;
      variantStr = `${subQty}${subUnit}`;
      return;
    }

    const res = parsePriceExpression(seg);
    if (Array.isArray(res)) {
      flatTokens.push(...res);
    } else if (res) {
      flatTokens.push(res);
    }
  });

  // 6. Evaluate MRP & Paid (Model A - Direct Raw Token Standard)
  let derivedMRP = 0;
  let derivedPaid = 0;

  if (flatTokens.length === 1) {
    derivedMRP = flatTokens[0].totalVal;
    derivedPaid = flatTokens[0].totalVal;
  } else if (flatTokens.length === 2) {
    derivedMRP = flatTokens[0].totalVal;
    derivedPaid = flatTokens[1].totalVal;
  } else if (flatTokens.length >= 3) {
    derivedMRP = flatTokens[0].totalVal;
    derivedPaid = flatTokens[flatTokens.length - 1].totalVal;
  }

  const purchasedQty = packQty;
  const remainingQty = explicitRemaining !== null ? explicitRemaining : (status === 'available' ? purchasedQty : 0);
  const consumedQty = Math.max(0, purchasedQty - remainingQty);

  const unitMRP = purchasedQty > 0 ? (derivedMRP / purchasedQty) : derivedMRP;
  const unitPrice = purchasedQty > 0 ? (derivedPaid / purchasedQty) : derivedPaid;
  
  // Direct MRP - Paid without Math.max(0, ...) clamping to preserve negative price variances
  const batchSavings = derivedMRP - derivedPaid;

  const rawCleanedName = cleanRawItemName(productName);
  const canonicalName = getCanonicalProductName(rawCleanedName);

  // Store extraction from transaction description header
  let storeName = '';
  const txnDesc = txn.Description || txn.description || '';
  const descLines = txnDesc.split('\n');
  if (descLines[0] && !descLines[0].toLowerCase().includes('stock')) {
    storeName = descLines[0].split('with')[0].trim();
  }

  // Format date
  const rawDate = txn.Date || txn.date || '';
  let formattedDate = rawDate;
  if (rawDate.includes('/')) {
    const parts = rawDate.split('/');
    if (parts.length === 3) {
      formattedDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }

  const txnUniqueId = txn.ID || txn._id || txn.id || '';
  const tIndex = txn.tIdx !== undefined ? txn.tIdx : (txn.id || 0);
  const batchId = txnUniqueId ? `${formattedDate}_${txnUniqueId}_${lineIdx}` : `${formattedDate}_${tIndex}_${lineIdx}`;
  const altBatchId = `${formattedDate}_${tIndex}_${lineIdx}`;

  return {
    id: batchId,
    batchId,
    altBatchId,
    txnUniqueId,
    tIdx: tIndex,
    lineIdx,
    rawLine: cleanLine,
    rawName: productName,
    cleanedName: rawCleanedName,
    canonicalProduct: canonicalName,
    variant: variantStr,
    sub_qty: subQty,
    sub_unit: subUnit,
    purchasedQty,
    remainingQty,
    consumedQty,
    unit: subUnit || 'pcs',
    mrp: derivedMRP,
    paid: derivedPaid,
    unitMRP,
    unitPrice,
    savings: batchSavings,
    status: remainingQty > 0 ? 'available' : 'unavailable',
    purchasedDate: formattedDate,
    rawDate: rawDate || formattedDate,
    source: storeName,
    txnId: txn.id || txn.TxnId || batchId,
    originalTxn: txn
  };
};

/**
 * Extract all normalized batches from transactions list
 */
export const extractNormalizedBatchesFromTransactions = (transactions = []) => {
  const batches = [];
  transactions.forEach((txn, tIdx) => {
    const desc = txn.Description || txn.description || '';
    const lines = desc.split('\n');
    lines.forEach((l, lIdx) => {
      const parsed = parseStockLine(l, { ...txn, tIdx }, lIdx);
      if (parsed) {
        batches.push(parsed);
      }
    });
  });

  // Apply dynamic consumption transactions that reference batches via #stock_ref_<batchRef>:<qty>
  // Note: The 5 historical baseline UUIDs (which existed in the canonical CSV) were already factored into the trailing ", <rem>" in the CSV purchase description lines.
  const historicalBaselineRefIds = new Set([
    '9ba4ff10-0847-40dd-9398-d5903ba598ec',
    'e970fc35-b2a3-4bc9-856f-359e434b52a2',
    '08279080-c81c-459e-a6a4-f83528defeab',
    'de34ffd0-8639-4a05-81fd-f429eab188e4'
  ]);

  transactions.forEach((txn) => {
    const tags = txn.Tags || txn.tags || txn.Tag || '';
    if (!tags.includes('#stock_ref_')) return;

    // Extract all #stock_ref_<refId>:<qty> matches
    const refRegex = /#stock_ref_([^\s:]+)(?::([\d\.]+))?/g;
    let match;
    while ((match = refRegex.exec(tags)) !== null) {
      const refId = match[1];
      const qty = match[2] ? parseFloat(match[2]) : 1;

      if (historicalBaselineRefIds.has(refId)) {
        continue;
      }

      // Find the referenced batch
      const targetBatch = batches.find(b => {
        if (b.batchId === refId || b.id === refId || b.altBatchId === refId || b.txnId === refId) return true;
        if (b.txnUniqueId && (b.txnUniqueId === refId || refId.includes(b.txnUniqueId))) return true;
        if (b.originalTxn && (b.originalTxn.ID === refId || b.originalTxn._id === refId || b.originalTxn.id === refId || b.originalTxn.TxnId === refId)) return true;
        if (refId.startsWith(b.purchasedDate) && refId.endsWith(`_${b.lineIdx}`)) {
          const parts = refId.split('_');
          if (parts.length >= 3) {
            const middle = parts.slice(1, -1).join('_');
            if (middle === String(b.tIdx) || middle === b.txnUniqueId || (b.originalTxn && (b.originalTxn.ID === middle || b.originalTxn._id === middle))) {
              return true;
            }
          }
        }
        return false;
      });

      if (targetBatch && !isNaN(qty) && qty > 0) {
        targetBatch.remainingQty = Math.max(0, targetBatch.remainingQty - qty);
        targetBatch.consumedQty = Math.max(0, targetBatch.purchasedQty - targetBatch.remainingQty);
        targetBatch.status = targetBatch.remainingQty > 0 ? 'available' : 'unavailable';
      }
    }
  });

  return batches;
};

export const DEFAULT_STOCK_CATEGORIES = [
  'Groceries',
  'Cooking Oil',
  'Tea & Coffee',
  'Snacks & Beverages',
  'Personal Care',
  'Household Cleaning',
  'Laundry',
  'Baby Care',
  'Health & Wellness',
  'Stationery',
  'Electronics',
  'Other'
];

/**
 * Group batches by canonical product and aggregate metrics
 */
export const groupBatchesByProduct = (batches) => {
  const productMap = new Map();

  for (const batch of batches) {
    const prodName = batch.canonicalProduct || getCanonicalProductName(batch.cleanedName || batch.name);
    if (!productMap.has(prodName)) {
      productMap.set(prodName, {
        productName: prodName,
        category: batch.category || '',
        brand: batch.brand || '',
        totalPurchasedBatches: 0,
        totalPurchasedQty: 0,
        totalRemainingQty: 0,
        totalConsumedQty: 0,
        totalMRP: 0,
        totalPaid: 0,
        totalSavings: 0,
        availableValue: 0,
        variants: new Map(),
        batches: []
      });
    }

    const prod = productMap.get(prodName);
    if (!prod.category && batch.category) prod.category = batch.category;
    if (!prod.brand && batch.brand) prod.brand = batch.brand;
    const pQty = batch.purchasedQty !== undefined ? batch.purchasedQty : parseFloat(batch.original_qty || batch.qty || 1);
    const rem = typeof batch.remainingQty === 'number' ? batch.remainingQty : parseFloat(batch.qty || 0);
    const consumed = Math.max(0, pQty - rem);

    const mrp = typeof batch.mrp === 'number' ? batch.mrp : parseFloat(batch.price || 0);
    const paid = typeof batch.paid === 'number' ? batch.paid : (parseFloat(batch.discounted_price || batch.price || 0) * pQty);
    const unitPaid = typeof batch.unitPrice === 'number' ? batch.unitPrice : parseFloat(batch.discounted_price || batch.price || 0);
    const savings = typeof batch.savings === 'number' ? batch.savings : (mrp - paid);

    prod.totalPurchasedBatches += 1;
    prod.totalPurchasedQty += pQty;
    prod.totalRemainingQty += rem;
    prod.totalConsumedQty += consumed;
    prod.totalMRP += mrp;
    prod.totalPaid += paid;
    prod.totalSavings += savings;
    prod.availableValue += rem * unitPaid;

    // Track variant
    const variantKey = batch.variant || (batch.sub_unit ? `${batch.sub_qty}${batch.sub_unit}` : 'Standard');
    if (!prod.variants.has(variantKey)) {
      prod.variants.set(variantKey, {
        variant: variantKey,
        totalPurchasedBatches: 0,
        totalPurchasedQty: 0,
        totalRemainingQty: 0,
        totalConsumedQty: 0,
        totalMRP: 0,
        totalPaid: 0,
        totalSavings: 0,
        availableValue: 0,
        batches: []
      });
    }

    const v = prod.variants.get(variantKey);
    v.totalPurchasedBatches += 1;
    v.totalPurchasedQty += pQty;
    v.totalRemainingQty += rem;
    v.totalConsumedQty += consumed;
    v.totalMRP += mrp;
    v.totalPaid += paid;
    v.totalSavings += savings;
    v.availableValue += rem * unitPaid;
    v.batches.push(batch);

    prod.batches.push(batch);
  }

  // Finalize statistics & sort
  return Array.from(productMap.values()).map(p => {
    p.savingsPct = p.totalMRP > 0 ? Number(((p.totalSavings / p.totalMRP) * 100).toFixed(1)) : 0;
    p.batches.sort((a, b) => (b.purchasedDate || b.purchased_date || '').localeCompare(a.purchasedDate || a.purchased_date || ''));

    p.variantList = Array.from(p.variants.values()).map(v => {
      v.savingsPct = v.totalMRP > 0 ? Number(((v.totalSavings / v.totalMRP) * 100).toFixed(1)) : 0;
      v.batches.sort((a, b) => (b.purchasedDate || b.purchased_date || '').localeCompare(a.purchasedDate || a.purchased_date || ''));
      return v;
    }).sort((a, b) => b.totalPurchasedBatches - a.totalPurchasedBatches);

    return p;
  }).sort((a, b) => {
    // In stock products first, then by total batches
    if (a.totalRemainingQty > 0 && b.totalRemainingQty <= 0) return -1;
    if (a.totalRemainingQty <= 0 && b.totalRemainingQty > 0) return 1;
    return b.totalPurchasedBatches - a.totalPurchasedBatches;
  });
};
