const fs = require('fs');
const path = require('path');

function parseCSV(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];
  
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] !== undefined ? values[idx] : '';
    });
    rows.push(obj);
  }
  return rows;
}

function parseCSVLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

const csvPath = path.resolve('finman_2026-08-30_shares_data.csv');
const raw = fs.readFileSync(csvPath, 'utf8');
const rows = parseCSV(raw);

// Check all fields and columns
console.log('Total rows:', rows.length);

// Let's audit all Zerodha transactions
// Let's write comprehensive audit functions
const audit = {
  funding: 0,
  withdrawals: 0,
  buyAmount: 0,
  sellAmount: 0,
  charges: 0,
  otherCreditDebit: 0,
  dividends: 0,
  realizedPLGains: 0,
  realizedPLLosses: 0,
  grossRealizedPL: 0,
  historicalReconstructionCost: 0,
  rowTypes: {},
  descTypes: {},
  invalidRows: [],
  duplicateIds: new Set(),
  seenIds: new Set(),
  missingIds: 0,
  malformedDescriptions: []
};

rows.forEach((r, idx) => {
  const id = r.ID || r.id;
  if (!id) audit.missingIds++;
  else if (audit.seenIds.has(id)) audit.duplicateIds.add(id);
  else audit.seenIds.add(id);
});

console.log('Missing IDs:', audit.missingIds, 'Duplicate IDs count:', audit.duplicateIds.size);

// Let's check each row for Zerodha
const zerodhaTxns = [];

rows.forEach((r, idx) => {
  const desc = String(r.Description || '').trim();
  const note = String(r.Note || '').trim();
  const cat = String(r.Category || '').trim();
  const acct = String(r.Account || r.FromAccount || '').trim();
  const dest = String(r.ToAccount || '').trim();
  const sub = String(r.SubAccount || r.FromSubAccount || '').trim();
  const destSub = String(r.ToSubAccount || '').trim();
  const broker = r.Brokerage || (desc.match(/Broker=([^|]+)/) ? desc.match(/Broker=([^|]+)/)[1].trim() : '') || (sub === 'Zerodha' || destSub === 'Zerodha' ? 'Zerodha' : '');
  
  const isZerodha = broker === 'Zerodha' ||
    (acct === 'Share Market' && (sub === 'Zerodha' || !sub)) ||
    (dest === 'Share Market' && (destSub === 'Zerodha' || !destSub)) ||
    note.toLowerCase().includes('zerodha') ||
    desc.toLowerCase().includes('zerodha');

  if (isZerodha) {
    zerodhaTxns.push({ rowIdx: idx + 2, r });
  }
});

console.log('Total Zerodha related transactions:', zerodhaTxns.length);

// Analyze row types in zerodhaTxns
const breakdown = {};
let bankFunding = 0;
let bankWithdrawals = 0;
let realBuyTradesCost = 0;
let realBuyTradesCash = 0;
let realSellTradesCost = 0;
let realSellTradesCash = 0;
let reconBuyCost = 0;
let chargesSum = 0;
let otherDebitCreditSum = 0;
let dividendSum = 0;
let realizedPnLRowsSum = 0;
let realizedPnLGains = 0;
let realizedPnLLosses = 0;
let shareMarketToShareMarket = 0;

zerodhaTxns.forEach(({ rowIdx, r }) => {
  const desc = String(r.Description || '').trim();
  const note = String(r.Note || '').trim();
  const cat = String(r.Category || '').trim();
  const type = String(r['Income/Expense'] || '').trim();
  const acct = String(r.Account || r.FromAccount || '').trim();
  const dest = String(r.ToAccount || '').trim();
  const sub = String(r.SubAccount || r.FromSubAccount || '').trim();
  const destSub = String(r.ToSubAccount || '').trim();
  const inr = parseFloat(r.INR || r.Amount || 0);

  let pType = 'OTHER';
  if (desc.includes('|')) {
    pType = desc.split('|')[0].trim();
  }

  breakdown[pType] = (breakdown[pType] || 0) + 1;

  if (pType === 'REALIZED_PNL') {
    const plMatch = desc.match(/RealizedPL=([^|]+)/);
    const plVal = plMatch ? parseFloat(plMatch[1]) : inr;
    realizedPnLRowsSum += plVal;
    if (plVal > 0) realizedPnLGains += plVal;
    else realizedPnLLosses += plVal;
  } else if (pType === 'BUY') {
    const isRecon = desc.includes('EntryDate=UNKNOWN') || desc.includes('historical position closure');
    const costMatch = desc.match(/Cost=([^|]+)/);
    const costVal = costMatch ? parseFloat(costMatch[1]) : inr;
    if (isRecon) {
      reconBuyCost += costVal;
    } else {
      realBuyTradesCost += costVal;
      realBuyTradesCash += inr;
    }
  } else if (pType === 'SELL') {
    const procMatch = desc.match(/TradeValue=([^|]+)/) || desc.match(/SaleProceeds=([^|]+)/);
    const costMatch = desc.match(/CostBasis=([^|]+)/);
    realSellTradesCash += inr;
    realSellTradesCost += (costMatch ? parseFloat(costMatch[1]) : 0);
  } else if (pType === 'CHARGE') {
    chargesSum += inr;
  } else if (pType === 'OTHER_CREDIT_DEBIT') {
    otherDebitCreditSum += (type === 'Expense' ? -inr : inr);
  } else if (pType === 'DIVIDEND' || cat.toLowerCase().includes('dividend') || note.toLowerCase().includes('dividend')) {
    dividendSum += inr;
  } else if (pType === 'POSITION_STATUS') {
    // metadata only
  } else {
    // Non-pipe or funding/withdrawal transfer
    if (type === 'Transfer-Out') {
      if (acct !== 'Share Market' && dest === 'Share Market') {
        bankFunding += inr;
      } else if (acct === 'Share Market' && dest !== 'Share Market') {
        bankWithdrawals += inr;
      } else if (acct === 'Share Market' && dest === 'Share Market') {
        shareMarketToShareMarket += inr;
      }
    } else if (type === 'Expense' && acct === 'Share Market') {
      chargesSum += inr;
    } else if (type === 'Income' && acct === 'Share Market') {
      dividendSum += inr;
    }
  }
});

console.log('Breakdown of Zerodha row types:', breakdown);
console.log({
  bankFunding,
  bankWithdrawals,
  realBuyTradesCost,
  realBuyTradesCash,
  realSellTradesCash,
  reconBuyCost,
  chargesSum,
  otherDebitCreditSum,
  dividendSum,
  realizedPnLRowsSum,
  realizedPnLGains,
  realizedPnLLosses,
  shareMarketToShareMarket
});

