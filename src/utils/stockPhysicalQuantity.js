/**
 * Stock Inventory Physical Quantity Engine
 * 
 * Provides deterministic decomposition, dimension tracking, and aggregation
 * of physical weight (kg, g), volume (L, ml), and count (pcs) from stock batch
 * variant metadata.
 * 
 * Designed as a pure analytical layer on top of discrete batch counts.
 */

// Dimension mapping
const UNIT_DIMENSIONS = {
  l: 'volume',
  ltr: 'volume',
  liter: 'volume',
  liters: 'volume',
  litres: 'volume',
  ml: 'volume',
  mls: 'volume',
  kg: 'mass',
  kgs: 'mass',
  g: 'mass',
  gm: 'mass',
  gms: 'mass',
  gram: 'mass',
  grams: 'mass',
  pcs: 'count',
  pc: 'count',
  piece: 'count',
  pieces: 'count',
  btl: 'count',
  bottle: 'count',
  bottles: 'count',
  pack: 'count',
  packs: 'count',
  units: 'count',
  unit: 'count'
};

const STANDARD_UNITS = {
  l: 'L',
  ltr: 'L',
  liter: 'L',
  liters: 'L',
  litres: 'L',
  ml: 'ml',
  mls: 'ml',
  kg: 'kg',
  kgs: 'kg',
  g: 'g',
  gm: 'g',
  gms: 'g',
  gram: 'g',
  grams: 'g',
  pcs: 'pcs',
  pc: 'pcs',
  piece: 'pcs',
  pieces: 'pcs',
  btl: 'pcs',
  bottle: 'pcs',
  bottles: 'pcs',
  pack: 'pcs',
  packs: 'pcs',
  units: 'pcs',
  unit: 'pcs'
};

/**
 * Parse a stock batch variant string into structured physical quantity metadata.
 * 
 * @param {string} variantStr - Raw variant string (e.g. "1L*9", "125g*8", "10kg", "550ml*2", "Standard")
 * @param {string} [rawNameStr=""] - Raw product name line for recoverable extraction
 * @param {number} [purchasedQty=1] - Number of purchased packs/units
 * @returns {Object} Physical metadata { packCount, packSizeValue, packSizeUnit, unitPhysicalQty, totalPhysicalQty, physicalUnit, dimension, confidence, isRecoverable }
 */
export function parseBatchPhysicalQuantity(variantStr = '', rawNameStr = '', purchasedQty = 1) {
  const v = (variantStr || '').trim();
  const raw = (rawNameStr || '').trim();
  const combined = `${v} ${raw}`.trim();
  const effectiveQty = parseFloat(purchasedQty) || 1;

  // 1. Nested Triple Multiplier pattern:
  // Pattern 1A: Unit at first position e.g. "125g*5*2"
  const tripleMatchA = combined.match(/(\d+(\.\d+)?)\s*(g|gm|gms|kg|ml|l|ltr)\s*\*\s*(\d+)\s*\*\s*(\d+)/i);
  if (tripleMatchA) {
    const sizeVal = parseFloat(tripleMatchA[1]);
    const rawUnit = tripleMatchA[3].toLowerCase();
    const p1 = parseFloat(tripleMatchA[4]);
    const p2 = parseFloat(tripleMatchA[5]);
    const totalPacks = p1 * p2;
    const stdUnit = STANDARD_UNITS[rawUnit] || rawUnit;
    const dim = UNIT_DIMENSIONS[rawUnit] || null;
    const totalPhysical = totalPacks * sizeVal;

    return {
      packCount: totalPacks,
      packSizeValue: sizeVal,
      packSizeUnit: stdUnit,
      unitPhysicalQty: effectiveQty > 0 ? (totalPhysical / effectiveQty) : sizeVal,
      totalPhysicalQty: totalPhysical,
      physicalUnit: stdUnit,
      dimension: dim,
      confidence: 'confident',
      isRecoverable: true
    };
  }

  // Pattern 1B: Unit at middle position e.g. "6*100g*4"
  const tripleMatchB = combined.match(/(\d+)\s*\*\s*(\d+(\.\d+)?)\s*(g|gm|gms|kg|ml|l|ltr)\s*\*\s*(\d+)/i);
  if (tripleMatchB) {
    const p1 = parseFloat(tripleMatchB[1]);
    const sizeVal = parseFloat(tripleMatchB[2]);
    const rawUnit = tripleMatchB[4].toLowerCase();
    const p2 = parseFloat(tripleMatchB[5]);
    const totalPacks = p1 * p2;
    const stdUnit = STANDARD_UNITS[rawUnit] || rawUnit;
    const dim = UNIT_DIMENSIONS[rawUnit] || null;
    const totalPhysical = totalPacks * sizeVal;

    return {
      packCount: totalPacks,
      packSizeValue: sizeVal,
      packSizeUnit: stdUnit,
      unitPhysicalQty: effectiveQty > 0 ? (totalPhysical / effectiveQty) : sizeVal,
      totalPhysicalQty: totalPhysical,
      physicalUnit: stdUnit,
      dimension: dim,
      confidence: 'confident',
      isRecoverable: true
    };
  }

  // 2. Compound Multiplier in variant:
  // Pattern 2A: Size with unit first e.g. "125g*8", "1L*9", "550ml*2", "1kg*4", "1L*2.5"
  const compoundMatch = v.match(/^([\d\.]+)\s*([a-zA-Z]+)\s*[\*xX]\s*([\d\.]+)$/);
  if (compoundMatch) {
    const sizeVal = parseFloat(compoundMatch[1]);
    const rawUnit = compoundMatch[2].toLowerCase();
    const multiplier = parseFloat(compoundMatch[3]);
    const stdUnit = STANDARD_UNITS[rawUnit];
    const dim = UNIT_DIMENSIONS[rawUnit];
    const totalPhysical = multiplier * sizeVal;

    if (stdUnit && dim) {
      return {
        packCount: multiplier,
        packSizeValue: sizeVal,
        packSizeUnit: stdUnit,
        unitPhysicalQty: effectiveQty > 0 ? (totalPhysical / effectiveQty) : sizeVal,
        totalPhysicalQty: totalPhysical,
        physicalUnit: stdUnit,
        dimension: dim,
        confidence: 'confident',
        isRecoverable: false
      };
    }
  }

  // Pattern 2B: Count multiplier first e.g. "9*100g", "4*750ml", "3*500ml"
  const countFirstMatch = v.match(/^([\d\.]+)\s*[\*xX]\s*([\d\.]+)\s*([a-zA-Z]+)$/);
  if (countFirstMatch) {
    const multiplier = parseFloat(countFirstMatch[1]);
    const sizeVal = parseFloat(countFirstMatch[2]);
    const rawUnit = countFirstMatch[3].toLowerCase();
    const stdUnit = STANDARD_UNITS[rawUnit];
    const dim = UNIT_DIMENSIONS[rawUnit];
    const totalPhysical = multiplier * sizeVal;

    if (stdUnit && dim) {
      return {
        packCount: multiplier,
        packSizeValue: sizeVal,
        packSizeUnit: stdUnit,
        unitPhysicalQty: effectiveQty > 0 ? (totalPhysical / effectiveQty) : sizeVal,
        totalPhysicalQty: totalPhysical,
        physicalUnit: stdUnit,
        dimension: dim,
        confidence: 'confident',
        isRecoverable: false
      };
    }
  }

  // Pattern 2C: Pure count multiplication in variant e.g. "6*2"
  const countMultMatch = v.match(/^([\d\.]+)\s*[\*xX]\s*([\d\.]+)$/);
  if (countMultMatch) {
    const p1 = parseFloat(countMultMatch[1]);
    const p2 = parseFloat(countMultMatch[2]);
    const totalCount = p1 * p2;
    const totalPhysical = effectiveQty * totalCount;
    return {
      packCount: effectiveQty,
      packSizeValue: totalCount,
      packSizeUnit: 'pcs',
      unitPhysicalQty: totalCount,
      totalPhysicalQty: totalPhysical,
      physicalUnit: 'pcs',
      dimension: 'count',
      confidence: 'confident',
      isRecoverable: false
    };
  }

  // 3. Simple Single Unit in variant: e.g. "1L", "500ml", "10kg", "125g", "3kg", "250g"
  const singleMatch = v.match(/^([\d\.]+)\s*([a-zA-Z]+)$/);
  if (singleMatch) {
    const sizeVal = parseFloat(singleMatch[1]);
    const rawUnit = singleMatch[2].toLowerCase();
    const stdUnit = STANDARD_UNITS[rawUnit];
    const dim = UNIT_DIMENSIONS[rawUnit];
    const totalPhysical = effectiveQty * sizeVal;

    if (stdUnit && dim) {
      return {
        packCount: effectiveQty,
        packSizeValue: sizeVal,
        packSizeUnit: stdUnit,
        unitPhysicalQty: sizeVal,
        totalPhysicalQty: totalPhysical,
        physicalUnit: stdUnit,
        dimension: dim,
        confidence: 'confident',
        isRecoverable: false
      };
    }
  }

  // 4. Pure integer count in variant: e.g. "1", "2", "6", "10"
  const numOnlyMatch = v.match(/^([\d\.]+)$/);
  if (numOnlyMatch) {
    const sizeVal = parseFloat(numOnlyMatch[1]);
    const totalPhysical = effectiveQty * sizeVal;
    return {
      packCount: effectiveQty,
      packSizeValue: sizeVal,
      packSizeUnit: 'pcs',
      unitPhysicalQty: sizeVal,
      totalPhysicalQty: totalPhysical,
      physicalUnit: 'pcs',
      dimension: 'count',
      confidence: 'confident',
      isRecoverable: false
    };
  }

  // 5. Recoverable patterns from rawName when variant is "Standard" or missing:
  // e.g. "pestro 4*750ml", "Cinthol 9*100g", "Pestro glass cleaner 3*500ml"
  const rawMultiplierMatch = raw.match(/(\d+)\s*\*\s*(\d+(\.\d+)?)\s*(g|gm|gms|kg|ml|l|ltr)/i);
  if (rawMultiplierMatch) {
    const count = parseFloat(rawMultiplierMatch[1]);
    const sizeVal = parseFloat(rawMultiplierMatch[2]);
    const rawUnit = rawMultiplierMatch[4].toLowerCase();
    const stdUnit = STANDARD_UNITS[rawUnit] || rawUnit;
    const dim = UNIT_DIMENSIONS[rawUnit] || null;
    const totalPhysical = count * sizeVal;

    return {
      packCount: count,
      packSizeValue: sizeVal,
      packSizeUnit: stdUnit,
      unitPhysicalQty: effectiveQty > 0 ? (totalPhysical / effectiveQty) : sizeVal,
      totalPhysicalQty: totalPhysical,
      physicalUnit: stdUnit,
      dimension: dim,
      confidence: 'recoverable',
      isRecoverable: true
    };
  }

  // 6. Ambiguous / Non-physical patterns: e.g. "Salt 22", "Sugar 1", "MTR 220", "Standard", etc.
  return {
    packCount: effectiveQty,
    packSizeValue: null,
    packSizeUnit: null,
    unitPhysicalQty: null,
    totalPhysicalQty: null,
    physicalUnit: null,
    dimension: null,
    confidence: 'unknown',
    isRecoverable: false
  };
}

/**
 * Calculate the physical quantities for a single batch based on purchased and consumed counts.
 * 
 * @param {Object} batch - Batch object with { variant, rawName, purchasedQty, consumedQty, remainingQty }
 * @returns {Object} { purchasedPhysical, consumedPhysical, remainingPhysical, unit, dimension, isConfident }
 */
export function calculateBatchPhysicalDetails(batch) {
  const meta = parseBatchPhysicalQuantity(batch.variant, batch.rawName || batch.name, batch.purchasedQty);
  
  if (meta.confidence === 'unknown' || meta.unitPhysicalQty === null || !meta.physicalUnit) {
    return {
      purchasedPhysical: null,
      consumedPhysical: null,
      remainingPhysical: null,
      unit: null,
      dimension: null,
      isConfident: false,
      unitPhysicalQty: null
    };
  }

  const purchasedQty = parseFloat(batch.purchasedQty) || 0;
  const consumedQty = parseFloat(batch.consumedQty) || 0;
  const remainingQty = parseFloat(batch.remainingQty) || 0;
  const unitSize = meta.unitPhysicalQty;

  return {
    purchasedPhysical: purchasedQty * unitSize,
    consumedPhysical: consumedQty * unitSize,
    remainingPhysical: remainingQty * unitSize,
    unit: meta.physicalUnit,
    dimension: meta.dimension,
    isConfident: meta.confidence === 'confident' || meta.confidence === 'recoverable',
    unitPhysicalQty: unitSize
  };
}

/**
 * Aggregate physical quantities across a list of batches for a product.
 * Separates incompatible physical dimensions (Mass vs Volume vs Count) without invalid conversions.
 * 
 * @param {Array} batches - List of batch objects belonging to a product
 * @returns {Object} Aggregated totals and formatted display strings
 */
export function aggregateProductPhysicalQuantities(batches = []) {
  if (!batches || batches.length === 0) {
    return {
      purchasedDisplay: '',
      consumedDisplay: '',
      remainingDisplay: '',
      hasPhysicalData: false,
      totalsByUnit: {}
    };
  }

  // Buckets for separate physical dimensions
  const totals = {
    // Volume buckets (in Liters and Milliliters)
    volumeL: { purchased: 0, consumed: 0, remaining: 0 },
    volumeml: { purchased: 0, consumed: 0, remaining: 0 },

    // Mass buckets (in Kilograms and Grams)
    massKg: { purchased: 0, consumed: 0, remaining: 0 },
    massG: { purchased: 0, consumed: 0, remaining: 0 },

    // Discrete count bucket (pcs)
    countPcs: { purchased: 0, consumed: 0, remaining: 0 },

    // Unknown/Ambiguous discrete units count
    unknownUnits: { purchased: 0, consumed: 0, remaining: 0 }
  };

  let hasConfidentData = false;

  for (const b of batches) {
    const details = calculateBatchPhysicalDetails(b);

    if (details.isConfident && details.unit) {
      hasConfidentData = true;
      const u = details.unit;

      if (u === 'L') {
        totals.volumeL.purchased += details.purchasedPhysical;
        totals.volumeL.consumed += details.consumedPhysical;
        totals.volumeL.remaining += details.remainingPhysical;
      } else if (u === 'ml') {
        totals.volumeml.purchased += details.purchasedPhysical;
        totals.volumeml.consumed += details.consumedPhysical;
        totals.volumeml.remaining += details.remainingPhysical;
      } else if (u === 'kg') {
        totals.massKg.purchased += details.purchasedPhysical;
        totals.massKg.consumed += details.consumedPhysical;
        totals.massKg.remaining += details.remainingPhysical;
      } else if (u === 'g') {
        totals.massG.purchased += details.purchasedPhysical;
        totals.massG.consumed += details.consumedPhysical;
        totals.massG.remaining += details.remainingPhysical;
      } else if (u === 'pcs') {
        totals.countPcs.purchased += details.purchasedPhysical;
        totals.countPcs.consumed += details.consumedPhysical;
        totals.countPcs.remaining += details.remainingPhysical;
      }
    } else {
      totals.unknownUnits.purchased += (parseFloat(b.purchasedQty) || 0);
      totals.unknownUnits.consumed += (parseFloat(b.consumedQty) || 0);
      totals.unknownUnits.remaining += (parseFloat(b.remainingQty) || 0);
    }
  }

  if (!hasConfidentData) {
    return {
      purchasedDisplay: '',
      consumedDisplay: '',
      remainingDisplay: '',
      hasPhysicalData: false,
      totalsByUnit: {}
    };
  }

  // Format Helper per dimension bucket
  const formatBucketDisplay = (metricKey) => {
    const parts = [];

    // 1. Volume dimension
    let lVal = totals.volumeL[metricKey];
    let mlVal = totals.volumeml[metricKey];

    // Normalize ml into L if product is predominantly L (e.g. Cooking Oil 721L + 500ml = 721.5 L)
    if (lVal > 0 && mlVal > 0) {
      if (mlVal === 500 || mlVal % 250 === 0) {
        lVal += (mlVal / 1000);
        mlVal = 0;
      }
    }

    if (lVal > 0 && mlVal > 0) {
      parts.push(`${formatNum(lVal)} L + ${formatComma(mlVal)} ml`);
    } else if (lVal > 0) {
      parts.push(`${formatNum(lVal)} L`);
    } else if (mlVal > 0) {
      parts.push(`${formatComma(mlVal)} ml`);
    }

    // 2. Mass dimension
    let kgVal = totals.massKg[metricKey];
    let gVal = totals.massG[metricKey];

    // Reconcile Gemini Tea or similar g -> kg if product has both g and kg
    if (kgVal > 0 && gVal > 0) {
      if (gVal % 500 === 0 || gVal % 1000 === 0) {
        kgVal += (gVal / 1000);
        gVal = 0;
      }
    }

    if (kgVal > 0 && gVal > 0) {
      parts.push(`${formatNum(kgVal)} kg + ${formatNum(gVal)} g`);
    } else if (kgVal > 0) {
      parts.push(`${formatNum(kgVal)} kg`);
    } else if (gVal > 0) {
      // e.g. Cinthol: 45,950 g, Santoor: 17,250 g
      parts.push(`${formatComma(gVal)} g`);
    }

    // 3. Count dimension
    const pcsVal = totals.countPcs[metricKey];
    if (pcsVal > 0) {
      parts.push(`${formatNum(pcsVal)} pcs`);
    }

    return parts.length > 0 ? parts.join(' + ') : '0';
  };

  return {
    purchasedDisplay: formatBucketDisplay('purchased'),
    consumedDisplay: formatBucketDisplay('consumed'),
    remainingDisplay: formatBucketDisplay('remaining'),
    hasPhysicalData: true,
    rawTotals: totals
  };
}

function formatNum(n) {
  if (n === 0) return '0';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function formatComma(n) {
  if (n === 0) return '0';
  return n.toLocaleString('en-IN');
}
