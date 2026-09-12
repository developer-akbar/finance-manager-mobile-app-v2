/**
 * casParser.js — Consolidated Account Statement (CAS) Parser
 *
 * Robust parser for CAMS and KFintech Mutual Fund Consolidated Account Statements.
 * Extracts investor metadata, schemes, folios, holding modes, and transactions
 * (Purchases, SIPs, Redemptions, Switches, Stamp Duty, Reconciliations).
 */

const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

/**
 * Parse date string from "19-May-2025" or "19/05/2025" into "dd/mm/yyyy"
 */
export function parseCASDate(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).trim();
  const mDmy = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3})[-\s/](\d{4})$/);
  if (mDmy) {
    const day = String(mDmy[1]).padStart(2, '0');
    const mon = MONTH_MAP[mDmy[2].toLowerCase()] || '01';
    const yr = mDmy[3];
    return `${day}/${mon}/${yr}`;
  }
  const mNum = s.match(/^(\d{1,2})[-\s/](\d{1,2})[-\s/](\d{4})$/);
  if (mNum) {
    const day = String(mNum[1]).padStart(2, '0');
    const mon = String(mNum[2]).padStart(2, '0');
    const yr = mNum[3];
    return `${day}/${mon}/${yr}`;
  }
  return s;
}

/**
 * Clean numeric string removing commas, parentheses, etc.
 */
function parseNum(val, defaultVal = 0) {
  if (val === null || val === undefined || val === '') return defaultVal;
  const s = String(val).replace(/,/g, '').trim();
  const isNeg = s.startsWith('(') && s.endsWith(')');
  const clean = s.replace(/[()]/g, '');
  const num = parseFloat(clean);
  if (isNaN(num)) return defaultVal;
  return isNeg ? -num : num;
}

/**
 * Parse combined Price and Units field if concatenated (e.g., "26.4717188.872")
 */
function unpackPriceAndUnits(rawNumStr, amount, unitBalance, prevUnitBalance, isRedemption) {
  const s = String(rawNumStr || '').replace(/,/g, '').replace(/[()]/g, '').trim();
  if (!s) return { price: 0, units: 0 };

  // If there's whitespace separating price and units
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const p = parseFloat(parts[0]) || 0;
    const u = parseFloat(parts[1]) || 0;
    return { price: p, units: isRedemption ? -Math.abs(u) : Math.abs(u) };
  }

  // If unitBalance and prevUnitBalance are available, the units are exactly the difference!
  if (!isNaN(unitBalance) && !isNaN(prevUnitBalance)) {
    const expectedUnitsDelta = Math.abs(unitBalance - prevUnitBalance);
    if (expectedUnitsDelta > 0.0001) {
      const units = isRedemption ? -expectedUnitsDelta : expectedUnitsDelta;
      const price = amount > 0 && expectedUnitsDelta > 0 ? parseFloat((amount / expectedUnitsDelta).toFixed(4)) : 0;
      return { price, units };
    }
  }

  // Fallback: heuristic decimal split
  // NAV in India is typically formatted with 2 to 4 decimal places (e.g. 26.4717 or 113.9663)
  const dotIdx = s.indexOf('.');
  if (dotIdx !== -1 && s.length > dotIdx + 5) {
    const candidatePriceStr = s.substring(0, dotIdx + 5);
    const candidateUnitsStr = s.substring(dotIdx + 5);
    const p = parseFloat(candidatePriceStr);
    const u = parseFloat(candidateUnitsStr);
    if (!isNaN(p) && p > 0 && !isNaN(u) && u > 0) {
      return { price: p, units: isRedemption ? -u : u };
    }
  }

  const single = parseFloat(s) || 0;
  return { price: single, units: 0 };
}

/**
 * Main parser function: converts raw CAS text into structured statement object
 */
export function parseCASText(rawText, defaultPlatform = null) {
  if (!rawText || typeof rawText !== 'string') {
    return { investor: {}, schemes: [], summary: {} };
  }

  const lines = rawText.split(/\r?\n/);
  const investor = {
    name: '',
    email: '',
    mobile: '',
    pan: '',
    platform: defaultPlatform
  };

  // 1. Extract Header Metadata
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const l = lines[i].trim();
    if (/Email\s*Id:\s*([^\s]+@[^\s]+)/i.test(l)) {
      investor.email = l.match(/Email\s*Id:\s*([^\s]+@[^\s]+)/i)[1];
    }
    if (/Mobile:\s*(\d+)/i.test(l)) {
      investor.mobile = l.match(/Mobile:\s*(\d+)/i)[1];
    }
    if (i >= 6 && i <= 10 && l && !investor.name && !l.startsWith('Page') && !l.includes('Consolidated') && !l.includes('Email')) {
      if (/^[A-Z\s\.]+$/.test(l) && l.length > 3) {
        investor.name = l;
      }
    }
  }

  // Determine platform default if investor matches known profile (or use explicit override)
  if (defaultPlatform) {
    investor.platform = defaultPlatform;
  } else {
    const emailLower = (investor.email || '').toLowerCase();
    const nameUpper = (investor.name || '').toUpperCase();
    if (emailLower.includes('akbar') || nameUpper.includes('AKBAR')) {
      investor.platform = 'Ak ETMoney';
    } else if (emailLower.includes('mullahaseena') || nameUpper.includes('HASEENA')) {
      investor.platform = 'Ammi Groww';
    } else if (emailLower.includes('fareedamulla') || nameUpper.includes('FAREEDA')) {
      investor.platform = 'Fareeda Groww';
    } else {
      investor.platform = 'Mutual Funds';
    }
  }

  const schemes = [];
  let currentScheme = null;
  let currentAmc = '';
  let runningUnitBalance = 0;

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Check AMC header
    if (line.includes('Mutual Fund') && line.length < 50 && !line.includes('ISIN:') && !line.includes('Folio') && !line.includes('Cost Value')) {
      currentAmc = line;
    }

    // Check Scheme Header & ISIN
    if (/ISIN\s*:/i.test(line)) {
      const isinMatch = line.match(/ISIN\s*:\s*([A-Z0-9\s]{12,24})/i);
      const isin = isinMatch ? isinMatch[1].replace(/\s+/g, '').toUpperCase().slice(0, 12) : '';

      // Collect complete scheme description (might span preceding 1-3 lines)
      let fullSchemeName = line;
      for (let k = Math.max(0, i - 4); k < i; k++) {
        const prev = lines[k].trim();
        if (prev && (prev.includes('Fund') || prev.includes('Growth') || prev.includes('Direct') || prev.includes('Plan') || prev.includes('Option'))) {
          if (!prev.includes('PORTFOLIO') && !prev.includes('PAN:') && !prev.includes('Folio')) {
            fullSchemeName = prev + ' ' + fullSchemeName;
          }
        }
      }

      // Check Demat vs Physical (Non-Demat)
      const hasNonDemat = /Non\s*-?\s*Demat/i.test(fullSchemeName) || /Non\s*-?\s*Demat/i.test(line);
      const hasDemat = /\(\s*Demat\s*\)/i.test(fullSchemeName) || /\(\s*Demat\s*\)/i.test(line);
      const holdingMode = (hasDemat && !hasNonDemat) ? 'DEMAT' : 'PHYSICAL';

      let folio = '';
      let registrar = 'CAMS';
      let advisor = '';
      if (line.toLowerCase().includes('kfintech')) registrar = 'KFINTECH';

      // Look ahead for Folio, Advisor and Registrar
      for (let j = i; j < Math.min(lines.length, i + 12); j++) {
        const check = lines[j].trim();
        if (/Folio\s*No:\s*(.+)$/i.test(check)) {
          const fm = check.match(/Folio\s*No:\s*(.+)$/i);
          if (fm) folio = fm[1].replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
        }
        if (/Advisor\s*:\s*(.+)$/i.test(check)) {
          const am = check.match(/Advisor\s*:\s*(.+)$/i);
          if (am) advisor = am[1].trim();
        }
        if (check.toLowerCase().includes('kfintech')) registrar = 'KFINTECH';
        if (check.toLowerCase().includes('cams')) registrar = 'CAMS';
      }

      // Finalize previous scheme if exists
      if (currentScheme) {
        schemes.push(currentScheme);
      }

      currentScheme = {
        amc: currentAmc,
        schemeName: fullSchemeName,
        isin,
        folio,
        advisor,
        holdingMode,
        registrar,
        openingUnits: 0,
        closingUnits: 0,
        closingCostValue: 0,
        closingMarketValue: 0,
        transactions: []
      };
      runningUnitBalance = 0;
    }

    // Check Folio and Advisor if encountered after scheme header
    if (currentScheme) {
      if (/Folio\s*No:\s*(.+)$/i.test(line)) {
        const fm = line.match(/Folio\s*No:\s*(.+)$/i);
        if (fm && !currentScheme.folio) {
          currentScheme.folio = fm[1].replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
        }
      }
      if (/Advisor\s*:\s*(.+)$/i.test(line)) {
        const am = line.match(/Advisor\s*:\s*(.+)$/i);
        if (am && !currentScheme.advisor) {
          currentScheme.advisor = am[1].trim();
        }
      }
    }

    // Check Opening Unit Balance
    if (currentScheme && /Opening\s*Unit\s*Balance:\s*([\d,\.]+)/i.test(line)) {
      const m = line.match(/Opening\s*Unit\s*Balance:\s*([\d,\.]+)/i);
      if (m) {
        currentScheme.openingUnits = parseNum(m[1]);
        runningUnitBalance = currentScheme.openingUnits;
      }
    }

    // Check Closing Unit Balance & Cost Value
    if (currentScheme && /Closing\s*Unit\s*Balance\s*:/i.test(line)) {
      const mUnits = line.match(/Closing\s*Unit\s*Balance\s*:\s*([\d,\.]+)/i);
      if (mUnits) currentScheme.closingUnits = parseNum(mUnits[1]);

      const mCost = line.match(/Total\s*Cost\s*Value\s*:\s*([\d,\.]+)/i);
      if (mCost) currentScheme.closingCostValue = parseNum(mCost[1]);
    }

    // Check Market Value
    if (currentScheme && /Market\s*Value\s*on/i.test(line)) {
      const mMkt = line.match(/Market\s*Value\s*on\s*[^:]+:\s*INR\s*([\d,\.]+)/i);
      if (mMkt) currentScheme.closingMarketValue = parseNum(mMkt[1]);
    }

    // Parse Transaction Line
    // Pattern starts with Date: e.g. "19-May-2025" or "14-Nov-2024"
    const mDate = line.match(/^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(.*)$/);
    if (currentScheme && mDate) {
      const rawDate = mDate[1];
      const dateVal = parseCASDate(rawDate);
      const rest = mDate[2].trim();

      // Check Stamp Duty
      if (rest.includes('*** Stamp Duty ***') || rest.includes('***Stamp Duty***') || rest.toLowerCase().includes('stamp duty')) {
        const numMatches = rest.match(/[\d,]+\.?\d*/g);
        const sdAmt = numMatches && numMatches.length > 0 ? parseNum(numMatches[0]) : 0;
        if (currentScheme.transactions.length > 0) {
          const lastTxn = currentScheme.transactions[currentScheme.transactions.length - 1];
          lastTxn.stampDuty = (lastTxn.stampDuty || 0) + sdAmt;
          lastTxn.totalCost = (lastTxn.totalCost || lastTxn.tradeValue) + sdAmt;
        }
      }
      // Check STT Paid
      else if (rest.includes('*** STT Paid ***') || rest.includes('***STT Paid***') || rest.toLowerCase().includes('stt paid')) {
        const numMatches = rest.match(/[\d,]+\.?\d*/g);
        const sttAmt = numMatches && numMatches.length > 0 ? parseNum(numMatches[0]) : 0;
        if (currentScheme.transactions.length > 0) {
          const lastTxn = currentScheme.transactions[currentScheme.transactions.length - 1];
          lastTxn.stt = (lastTxn.stt || 0) + sttAmt;
        }
      }
      // Check Non-transaction Informational Notices
      else if (
        rest.includes('***Registration of Nominee***') ||
        rest.includes('***Address Updated') ||
        rest.includes('***Systematic Cancellation***') ||
        rest.includes('***Cancelled***') ||
        rest.includes('***Refund Primary KYC') ||
        rest.startsWith('***')
      ) {
        // Skip informational notices from transaction ledger
      }
      // Genuine Financial Transaction (Purchase / SIP / Redemption / Switch)
      else {
        const isRedemption = rest.toLowerCase().includes('redemption') || 
                             rest.toLowerCase().includes('repurchase') || 
                             rest.toLowerCase().includes('sale') || 
                             rest.toLowerCase().includes('switch out') || 
                             rest.toLowerCase().includes('extinguished') || 
                             rest.toLowerCase().includes('extinguish') || 
                             rest.startsWith('(');
        const isSwitchIn = rest.toLowerCase().includes('switch in') || rest.toLowerCase().includes('switch-in');
        const isDividendReinvest = rest.toLowerCase().includes('dividend reinvest') || rest.toLowerCase().includes('reinvestment');
        const isSegregatedCreation = rest.toLowerCase().includes('creation of units') || (rest.toLowerCase().includes('segregated') && !isRedemption);

        let type = 'BUY';
        if (isRedemption) type = 'SELL';
        else if (isSwitchIn) type = 'BUY';
        else if (isDividendReinvest) type = 'DIVIDEND_REINVEST';
        else if (isSegregatedCreation) type = 'CORPORATE_ACTION';

        // Check Case 0: Segregated Portfolio Unit Creation (<Description> <Units> <Balance>)
        const mCreation = rest.match(/^(.*?creation\s+of\s+units.*?)\s+([\d,\.]+)\s+([\d,\.]+)$/i);
        if (mCreation) {
          const desc = mCreation[1].trim();
          const unitsVal = Math.abs(parseNum(mCreation[2]));
          const endBalance = parseNum(mCreation[3]);

          if (!isNaN(endBalance)) {
            runningUnitBalance = endBalance;
          } else {
            runningUnitBalance = runningUnitBalance + unitsVal;
          }

          currentScheme.transactions.push({
            date: dateVal,
            rawDate,
            type: 'CORPORATE_ACTION',
            tradeValue: 0,
            unitPrice: 0,
            quantity: unitsVal,
            positionQuantityChange: unitsVal,
            stampDuty: 0,
            stt: 0,
            totalCost: 0,
            description: desc,
            unitBalance: runningUnitBalance
          });
        } else {
          // Check Case 1: Visual / Table order (<Description> <Amount> <Units> <Price> <Balance>)
          const mTable = rest.match(/^(.*?)\s+(\(?[\d,]+\.?\d*\)?)\s+(\(?[\d,]+\.?\d*\)?)\s+(\(?[\d,]+\.?\d*\)?)\s+(\(?[\d,]+\.?\d*\)?)$/);
          if (mTable && /[a-zA-Z]/.test(mTable[1])) {
          const desc = mTable[1].trim();
          const rawAmt = mTable[2];
          const rawUnits = mTable[3];
          const rawPrice = mTable[4];
          const rawBal = mTable[5];

          const tradeValue = Math.abs(parseNum(rawAmt));
          const unitsVal = Math.abs(parseNum(rawUnits));
          const priceVal = parseNum(rawPrice);
          const endBalance = parseNum(rawBal);

          if (!isNaN(endBalance)) {
            runningUnitBalance = endBalance;
          } else {
            runningUnitBalance = isRedemption ? (runningUnitBalance - unitsVal) : (runningUnitBalance + unitsVal);
          }

          currentScheme.transactions.push({
            date: dateVal,
            rawDate,
            type,
            tradeValue,
            unitPrice: priceVal,
            quantity: unitsVal,
            positionQuantityChange: isRedemption ? -unitsVal : unitsVal,
            stampDuty: 0,
            stt: 0,
            totalCost: tradeValue,
            description: desc,
            unitBalance: runningUnitBalance
          });
        }
        // Case 2: Content-stream / Prefix-amount order (<Amount> <Price> <Units> <Description> <Balance>)
        else {
          const mAmt = rest.match(/^(\(?[\d,]+\.?\d*\)?)\s+(.*)$/);
          if (mAmt) {
            const rawAmt = mAmt[1];
            const tradeValue = Math.abs(parseNum(rawAmt));
            const afterAmt = mAmt[2].trim();

            let endBalance = NaN;
            const mEndBal = afterAmt.match(/[\s\t]([\d,]+\.\d{3})$/);
            if (mEndBal) {
              endBalance = parseNum(mEndBal[1]);
            }

            let descKeyword = 'Purchase';
            const kwMatch = afterAmt.match(/(Sys\.\s*Investment|Systematic\s*Investment|SIP\s*Purchase|Purchase\s*Systematic|Purchase|Redemption\s*Less\s*STT|Redemption|Switch\s*In|Switch\s*Out|Allotment|Dividend\s*Reinvestment|Dividend)/i);
            if (kwMatch) descKeyword = kwMatch[1];

            let priceUnitsStr = afterAmt;
            if (kwMatch && kwMatch.index > 0) {
              priceUnitsStr = afterAmt.substring(0, kwMatch.index).trim();
            }

            const { price, units } = unpackPriceAndUnits(priceUnitsStr, tradeValue, endBalance, runningUnitBalance, isRedemption);
            const posUnits = Math.abs(units);

            if (!isNaN(endBalance)) {
              runningUnitBalance = endBalance;
            } else {
              runningUnitBalance = isRedemption ? (runningUnitBalance - posUnits) : (runningUnitBalance + posUnits);
            }

            currentScheme.transactions.push({
              date: dateVal,
              rawDate,
              type,
              tradeValue,
              unitPrice: price,
              quantity: posUnits,
              positionQuantityChange: isRedemption ? -posUnits : posUnits,
              stampDuty: 0,
              stt: 0,
              totalCost: tradeValue,
              description: afterAmt,
              unitBalance: runningUnitBalance
            });
          }
        }
      }
    }
  }

  i++;
}

  // Push the final scheme
  if (currentScheme) {
    schemes.push(currentScheme);
  }

  // Compute portfolio summary metrics
  const totalSchemes = schemes.length;
  const activeSchemes = schemes.filter(s => s.closingUnits > 0).length;
  const totalCostValue = schemes.reduce((acc, s) => acc + (s.closingCostValue || 0), 0);
  const totalMarketValue = schemes.reduce((acc, s) => acc + (s.closingMarketValue || 0), 0);
  const totalTxns = schemes.reduce((acc, s) => acc + s.transactions.length, 0);

  return {
    investor,
    schemes,
    summary: {
      totalSchemes,
      activeSchemes,
      totalCostValue,
      totalMarketValue,
      totalTxns
    }
  };
}
