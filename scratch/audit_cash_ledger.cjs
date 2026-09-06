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

const raw = fs.readFileSync('finman_2026-08-30_shares_data.csv', 'utf8');
const rows = parseCSV(raw);

// Let's audit all Zerodha transactions in depth
let bankFunding = 0;
let bankWithdrawals = 0;
let realBuyCost = 0;
let realBuyINR = 0;
let reconBuyCost = 0;
let reconBuyINR = 0;
let realSellProceeds = 0;
let realSellCostBasis = 0;
let realSellINR = 0;
let charges = 0;
let otherDebitCredit = 0;
let realizedPnLGains = 0;
let realizedPnLLosses = 0;
let dividendsZerodha = 0;
let dividendsBank = 0;

// Also check all symbols in Zerodha
const symbolTrades = {};

rows.forEach((r, idx) => {
  const desc = String(r.Description || '').trim();
  const note = String(r.Note || '').trim();
  const cat = String(r.Category || '').trim();
  const type = String(r['Income/Expense'] || '').trim();
  const acct = String(r.Account || r.FromAccount || '').trim();
  const dest = String(r.ToAccount || '').trim();
  const sub = String(r.SubAccount || r.FromSubAccount || '').trim();
  const destSub = String(r.ToSubAccount || '').trim();
  const inr = parseFloat(r.INR || r.Amount || 0);

  // Zerodha check
  const isZerodha = (sub === 'Zerodha' || destSub === 'Zerodha' ||
    (acct === 'Share Market' && !sub) || (dest === 'Share Market' && !destSub) ||
    desc.includes('Broker=Zerodha') || desc.includes('Broker = Zerodha') ||
    note.toLowerCase().includes('zerodha') || desc.toLowerCase().includes('zerodha'));

  if (!isZerodha) return;

  if (desc.startsWith('BUY |') || desc.startsWith('BUY|')) {
    const isRecon = desc.includes('EntryDate=UNKNOWN') || desc.includes('historical position closure') || desc.includes('Source=CurrentP&L');
    const costMatch = desc.match(/Cost=([^|]+)/);
    const cost = costMatch ? parseFloat(costMatch[1]) : inr;
    const symMatch = desc.match(/Symbol=([^|]+)/);
    const sym = symMatch ? symMatch[1].trim().toUpperCase() : 'UNKNOWN';
    const qtyMatch = desc.match(/Qty=([^|]+)/);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 0;

    if (!symbolTrades[sym]) symbolTrades[sym] = { buys: [], sells: [], recons: [] };

    if (isRecon) {
      reconBuyCost += cost;
      reconBuyINR += inr;
      symbolTrades[sym].recons.push({ idx: idx + 2, qty, cost, inr, desc });
    } else {
      realBuyCost += cost;
      realBuyINR += inr;
      symbolTrades[sym].buys.push({ idx: idx + 2, qty, cost, inr, date: r.Date });
    }
  } else if (desc.startsWith('BUY_RECON |') || desc.startsWith('BUY_RECON|')) {
    const costMatch = desc.match(/Cost=([^|]+)/);
    const cost = costMatch ? parseFloat(costMatch[1]) : inr;
    const symMatch = desc.match(/Symbol=([^|]+)/);
    const sym = symMatch ? symMatch[1].trim().toUpperCase() : 'UNKNOWN';
    const qtyMatch = desc.match(/Qty=([^|]+)/);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 0;

    if (!symbolTrades[sym]) symbolTrades[sym] = { buys: [], sells: [], recons: [] };
    reconBuyCost += cost;
    reconBuyINR += inr;
    symbolTrades[sym].recons.push({ idx: idx + 2, qty, cost, inr, desc });
  } else if (desc.startsWith('SELL |') || desc.startsWith('SELL|')) {
    const procMatch = desc.match(/TradeValue=([^|]+)/) || desc.match(/SaleProceeds=([^|]+)/);
    const costMatch = desc.match(/CostBasis=([^|]+)/);
    const symMatch = desc.match(/Symbol=([^|]+)/);
    const sym = symMatch ? symMatch[1].trim().toUpperCase() : 'UNKNOWN';
    const qtyMatch = desc.match(/Qty=([^|]+)/);
    const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 0;

    const proceeds = procMatch ? parseFloat(procMatch[1]) : inr;
    const costBasis = costMatch ? parseFloat(costMatch[1]) : 0;

    if (!symbolTrades[sym]) symbolTrades[sym] = { buys: [], sells: [], recons: [] };
    realSellProceeds += proceeds;
    realSellCostBasis += costBasis;
    realSellINR += inr;
    symbolTrades[sym].sells.push({ idx: idx + 2, qty, proceeds, costBasis, inr, date: r.Date });
  } else if (note === 'Zerodha Gains') {
    realizedPnLGains += inr;
  } else if (note === 'Zerodha Losses') {
    realizedPnLLosses += inr;
  } else if (note === 'Other Credit & Debit') {
    otherDebitCredit += inr;
  } else if (note === 'Zerodha Charges' || desc.includes('charges per current P&L')) {
    charges += inr;
  } else if (type === 'Transfer-Out') {
    if (acct !== 'Share Market' && dest === 'Share Market') {
      bankFunding += inr;
    } else if (acct === 'Share Market' && dest !== 'Share Market') {
      bankWithdrawals += inr;
    }
  } else if (note.toLowerCase().includes('dividend') || cat.toLowerCase().includes('dividend')) {
    if (acct === 'Share Market' || dest === 'Share Market') {
      dividendsZerodha += inr;
    } else {
      dividendsBank += inr;
    }
  }
});

console.log('=== Zerodha Accounting Breakdown ===');
console.log('Bank Funding (+):', bankFunding);
console.log('Bank Withdrawals (-):', bankWithdrawals);
console.log('Real BUY Trades Cost (Cost field):', realBuyCost);
console.log('Real BUY Trades Cash (INR field):', realBuyINR);
console.log('Recon BUY Cost (Cost field):', reconBuyCost);
console.log('Recon BUY Cash (INR field):', reconBuyINR);
console.log('Real SELL Trades Proceeds (Cost/TradeValue/INR):', realSellProceeds, 'realSellINR:', realSellINR);
console.log('Real SELL Cost Basis:', realSellCostBasis);
console.log('Gross Realized P&L rows (Gains):', realizedPnLGains);
console.log('Gross Realized P&L rows (Losses):', realizedPnLLosses);
console.log('Gross Realized P&L net:', realizedPnLGains + realizedPnLLosses);
console.log('Zerodha Charges row:', charges);
console.log('Other Credit & Debit rows:', otherDebitCredit);
console.log('Dividends (Zerodha):', dividendsZerodha);
console.log('Dividends (Bank direct):', dividendsBank);

// Let's test cash equation:
// 1. Raw Trade Movements (Funding - Withdrawals + SELL Proceeds - BUY Cost + Charges + Other Debit/Credit)
const rawTradeCash_Cost = bankFunding - bankWithdrawals + realSellProceeds - (realBuyCost + reconBuyCost) + charges + otherDebitCredit;
const rawTradeCash_NoRecon = bankFunding - bankWithdrawals + realSellProceeds - realBuyCost + charges + otherDebitCredit;
console.log('\nRaw trade cash (with Recon BUY):', rawTradeCash_Cost);
console.log('Raw trade cash (without Recon BUY):', rawTradeCash_NoRecon);

// What about Net Realized P&L cash relation:
// In brokerage accounting:
// Realized Cash = Funding - Withdrawals + Gross Realized P&L + Charges + Other Debit/Credit + Dividends(if in brokerage) - Current Active Invested Cost
// Let's verify:
const activeInvestedCost = 39704.9791;
const netTradingPL = (realizedPnLGains + realizedPnLLosses) + charges + otherDebitCredit;
const brokerageCashFromPL = (bankFunding - bankWithdrawals) + netTradingPL - activeInvestedCost;
console.log('\nNet Trading P&L:', netTradingPL);
console.log('Brokerage Cash from P&L formula: (Funding - Withdrawals + Net Trading P&L - Active Invested Cost):', brokerageCashFromPL);

