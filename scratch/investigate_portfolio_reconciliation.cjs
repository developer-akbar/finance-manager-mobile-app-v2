const fs = require('fs');
const { calculateBrokerageState } = require('../src/utils/brokerageAccounting.js');

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let fields = [];
  let field = '';
  let inQ = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inQ) {
      if (ch === '"' && next === '"') {
        field += '"'; i += 2; continue;
      }
      if (ch === '"') {
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') {
      inQ = true; i++; continue;
    }
    if (ch === ',') {
      fields.push(field); field = ''; i++; continue;
    }
    if (ch === '\n') {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      i++; continue;
    }
    field += ch; i++;
  }
  fields.push(field);
  if (fields.some(f => f !== '')) records.push(fields);

  if (records.length < 2) return [];
  const headers = records[0].map(h => h.trim());
  const rows = [];

  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (rec[idx] || '').trim();
    });
    if (Object.values(row).every(v => !v)) continue;
    rows.push(row);
  }
  return rows;
}

const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const transactions = parseCSV(raw);

// Mock state.brokerages & accounts as in AppContext
const brokerages = [{ name: 'Zerodha' }, { name: 'Fareeda Groww', totalValue: 123003 }, { name: 'Groww' }];
const smBalances = calculateBrokerageState(transactions, brokerages, {});

// Extract all investment accounts from CSV
const acctSet = new Map();
transactions.forEach(t => {
  const grp = t.AccountGroup || t.FromAccountGroup || '';
  const acct = t.Account || t.FromAccount || '';
  if (grp === 'Investments' || acct === 'Share Market' || acct === 'Liquid Mutual Funds' || acct === 'PPF' || acct === 'Tax Mutual Funds' || acct === 'NPS') {
    if (!acctSet.has(acct)) {
      acctSet.set(acct, { name: acct, group: 'Investments', subAccounts: [] });
    }
    const sub = t.SubAccount || t.FromSubAccount || '';
    if (sub) {
      const existing = acctSet.get(acct);
      if (!existing.subAccounts.some(s => s.name === sub)) {
        existing.subAccounts.push({ name: sub });
      }
    }
  }
});

const investmentAccounts = Array.from(acctSet.values());

// Reproduce InvestmentsPortfolio.jsx calculations
const parseDate = (s) => {
  if (!s) return new Date(0);
  const parts = s.split(/[\/\-\.]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) return new Date(parts[0], parts[1]-1, parts[2]);
    return new Date(parts[2], parts[1]-1, parts[0]);
  }
  return new Date(s);
};

const getAssociatedSubAccount = (t, parentAccount) => {
  if (t.SubAccount) return t.SubAccount;
  if (t.FromSubAccount && (t.Account === parentAccount || t.FromAccount === parentAccount)) return t.FromSubAccount;
  if (t.ToSubAccount && t.ToAccount === parentAccount) return t.ToSubAccount;
  const desc = (t.Description || '').toLowerCase();
  const note = (t.Note || '').toLowerCase();
  const combined = `${note} ${desc}`;
  if (parentAccount === 'Share Market') {
    if (combined.includes('zerodha')) return 'Zerodha';
    if (combined.includes('fareeda') || combined.includes('ammi')) return 'Fareeda Groww';
    if (combined.includes('groww')) return 'Groww';
    return 'Zerodha';
  }
  if (parentAccount === 'Liquid Mutual Funds') {
    if (combined.includes('fareeda') || combined.includes('ammi')) return 'Fareeda Groww';
    if (combined.includes('groww')) return 'Groww';
    return 'Groww';
  }
  return '';
};

const getAssetKeyForTxn = (parent, sub) => {
  if (!parent) return '';
  if (sub) return `${parent} > ${sub}`;
  return parent;
};

const getAssociatedInvestmentAsset = (t) => {
  const acct = String(t.Account || t.FromAccount || '').trim();
  const dest = String(t.ToAccount || '').trim();
  if (investmentAccounts.some(a => a.name.toLowerCase() === acct.toLowerCase())) return acct;
  if (investmentAccounts.some(a => a.name.toLowerCase() === dest.toLowerCase())) return dest;
  const desc = (t.Description || '').toLowerCase();
  const note = (t.Note || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();
  const combined = `${note} ${desc}`;
  if (combined.includes('share market') || combined.includes('zerodha') || combined.includes('dividend') || cat === 'equity') {
    return 'Share Market';
  }
  if (combined.includes('liquid') || combined.includes('groww')) return 'Liquid Mutual Funds';
  if (combined.includes('ppf')) return 'PPF';
  return null;
};

function runPortfolioCalculation(selectedAsset = 'All') {
  const balances = {};
  const invested = {};
  const divs = {};
  const realizedMap = {};
  let grandDivs = 0;

  const targetAccounts = selectedAsset === 'All'
    ? investmentAccounts
    : investmentAccounts.filter(a => a.name.toLowerCase() === selectedAsset.toLowerCase());

  targetAccounts.forEach(a => {
    if (a.name === 'Share Market') {
      Object.keys(smBalances).forEach(broker => {
        const key = `${a.name} > ${broker}`;
        balances[key] = smBalances[broker].totalValue;
        invested[key] = smBalances[broker].investedCost;
        divs[key] = 0;
      });
    } else if (a.subAccounts && a.subAccounts.length > 0) {
      a.subAccounts.forEach(sub => {
        const key = `${a.name} > ${sub.name}`;
        balances[key] = 0;
        invested[key] = 0;
        divs[key] = 0;
      });
    } else {
      balances[a.name] = 0;
      invested[a.name] = 0;
      divs[a.name] = 0;
    }
  });

  const isTargetAccount = (name) => {
    if (!name) return false;
    return targetAccounts.some(a => a.name.toLowerCase() === name.toLowerCase());
  };

  const addToBal = (n, subName, v) => {
    const key = getAssetKeyForTxn(n, subName);
    if (key && balances[key] !== undefined && !key.startsWith('Share Market > ')) {
      balances[key] = (balances[key] || 0) + v;
    }
  };

  for (const t of transactions) {
    const amt = parseFloat(t.INR || t.Amount || 0);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || t.FromAccount || '').trim();
    const dest = String(t.ToAccount || '').trim();

    const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || '').trim();
    const destSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

    const resolvedSub = sub || (isTargetAccount(acct) ? getAssociatedSubAccount(t, acct) : '');
    const resolvedDestSub = destSub || (isTargetAccount(dest) ? getAssociatedSubAccount(t, dest) : '');

    const acctKey = getAssetKeyForTxn(acct, resolvedSub);
    const destKey = getAssetKeyForTxn(dest, resolvedDestSub);

    const isAcctInv = isTargetAccount(acct);
    const isDestInv = isTargetAccount(dest);

    // Cumulative Balances
    if (type === 'Income') {
      addToBal(acct, resolvedSub, +amt);
    } else if (type === 'Expense') {
      addToBal(acct, resolvedSub, -amt);
    } else if (type === 'Transfer-Out') {
      addToBal(acct, resolvedSub, -amt);
      addToBal(dest, resolvedDestSub, +amt);
    }

    const cat = String(t.Category || '').toLowerCase();
    const note = String(t.Note || '').toLowerCase();
    const isDividend = note.includes('dividend') || (cat === 'equity' && note === 'dividend');

    const isRealizedGain = !isDividend && (
      note.includes('profit') || 
      note.includes('loss') ||
      (cat === 'equity' && (note === 'motilal oswal asset management' || note === 'l&t tax advantage'))
    );

    if (isDividend) {
      const parent = getAssociatedInvestmentAsset(t);
      if (parent && isTargetAccount(parent)) {
        const sName = getAssociatedSubAccount(t, parent);
        const key = getAssetKeyForTxn(parent, sName);
        if (key && divs[key] !== undefined) {
          grandDivs += amt;
          divs[key] = (divs[key] || 0) + amt;
        }
      }
    } else if (isRealizedGain) {
      const parent = getAssociatedInvestmentAsset(t);
      if (parent && isTargetAccount(parent)) {
        const sName = getAssociatedSubAccount(t, parent);
        const key = getAssetKeyForTxn(parent, sName);
        if (key) {
          realizedMap[key] = (realizedMap[key] || 0) + amt;
        }
      }
    } else {
      if (isDestInv && destKey && !destKey.startsWith('Share Market > ')) {
        invested[destKey] = (invested[destKey] || 0) + amt;
      }
      if (isAcctInv && acctKey && !acctKey.startsWith('Share Market > ')) {
        invested[acctKey] = (invested[acctKey] || 0) - amt;
      }
    }
  }

  // Parse Valuations
  const valuations = {};
  const sortedTxns = [...transactions].sort((a, b) => parseDate(a.Date).getTime() - parseDate(b.Date).getTime());

  for (const t of sortedTxns) {
    const desc = String(t.Description || t.description || '');
    const note = String(t.Note || t.note || '');
    const combined = `${note}\n${desc}`;

    if (combined.includes(':')) {
      const lines = combined.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^\s*([^:]+?)\s*:\s*([\d.]+)(?:\s+out\s+of\s+([\d.]+))?\s*$/i);
        if (match) {
          const fundName = match[1].trim();
          if (['time', 'vi', 'jio', 'flipkart', 'amazon'].includes(fundName.toLowerCase())) continue;
          const val = parseFloat(match[2]);
          const inv = match[3] ? parseFloat(match[3]) : null;
          if (!isNaN(val)) {
            valuations[fundName] = { date: t.Date, currentValue: val, investedValue: inv };
          }
        }
      }
    }
  }

  const getValuationForAssetLocal = (keyName) => {
    if (!keyName) return null;
    if (valuations[keyName]) return valuations[keyName];
    if (keyName.includes(' > ')) {
      const parts = keyName.split(' > ');
      const lastPart = parts[parts.length - 1];
      if (valuations[lastPart]) return valuations[lastPart];
    }
    return null;
  };

  let totalGainLoss = 0;
  const breakdown = [];

  Object.keys(balances).forEach(key => {
    if (key.startsWith('Share Market > ')) {
      const broker = key.substring('Share Market > '.length);
      const details = smBalances[broker];
      if (details) {
        const itemGain = (details.currentValue - details.investedCost);
        totalGainLoss += itemGain;
        breakdown.push({
          key,
          balance: details.totalValue,
          invested: details.investedCost,
          gain: itemGain,
          source: 'Brokerage State (Unrealized P&L)'
        });
      }
    } else {
      const valObj = getValuationForAssetLocal(key);
      const groupRealized = realizedMap[key] || 0;
      if (valObj) {
        const currentValue = valObj.currentValue;
        const totalAmount = invested[key] || 0;
        const itemGain = (currentValue - totalAmount) + groupRealized;
        totalGainLoss += itemGain;
        breakdown.push({
          key,
          balance: balances[key],
          valCurrent: currentValue,
          invested: totalAmount,
          realized: groupRealized,
          gain: itemGain,
          source: 'Valuation note + Realized'
        });
      } else {
        totalGainLoss += groupRealized;
        breakdown.push({
          key,
          balance: balances[key],
          invested: invested[key] || 0,
          realized: groupRealized,
          gain: groupRealized,
          source: 'Realized only'
        });
      }
    }
  });

  const totalVal = Object.values(balances).reduce((sum, v) => sum + v, 0);
  const totalInv = Object.values(invested).reduce((sum, v) => sum + v, 0);

  return {
    selectedAsset,
    totalPortfolioValue: totalVal,
    totalInvestedCapital: totalInv,
    portfolioGainLoss: totalGainLoss,
    totalDividends: grandDivs,
    breakdown
  };
}

console.log('=== OVERALL PORTFOLIO (selectedAsset = "All") ===');
const allRes = runPortfolioCalculation('All');
console.log(`Portfolio Value:   ₹${allRes.totalPortfolioValue.toLocaleString('en-IN')}`);
console.log(`Invested Capital:  ₹${allRes.totalInvestedCapital.toLocaleString('en-IN')}`);
console.log(`Period Gains:      ₹${allRes.portfolioGainLoss.toLocaleString('en-IN')}`);
console.log(`Period Dividends:  ₹${allRes.totalDividends.toLocaleString('en-IN')}`);
console.log(`Invested + Gains:  ₹${(allRes.totalInvestedCapital + allRes.portfolioGainLoss).toLocaleString('en-IN')}`);
console.log(`Difference (Invested + Gains - Portfolio Value): ₹${(allRes.totalInvestedCapital + allRes.portfolioGainLoss - allRes.totalPortfolioValue).toFixed(2)}`);

console.log('\n--- Breakdown per Asset ---');
allRes.breakdown.forEach(b => {
  console.log(`${b.key}: Balance=₹${(b.balance||0).toFixed(2)}, Invested=₹${(b.invested||0).toFixed(2)}, Gain=₹${(b.gain||0).toFixed(2)} [${b.source}]`);
});

console.log('\n=== SHARE MARKET (selectedAsset = "Share Market") ===');
const smRes = runPortfolioCalculation('Share Market');
console.log(`Portfolio Value:   ₹${smRes.totalPortfolioValue.toLocaleString('en-IN')}`);
console.log(`Invested Capital:  ₹${smRes.totalInvestedCapital.toLocaleString('en-IN')}`);
console.log(`Period Gains:      ₹${smRes.portfolioGainLoss.toLocaleString('en-IN')}`);
console.log(`Period Dividends:  ₹${smRes.totalDividends.toLocaleString('en-IN')}`);
console.log('\n--- SM Breakdown ---');
smRes.breakdown.forEach(b => {
  console.log(`${b.key}: Balance=₹${(b.balance||0).toFixed(2)}, Invested=₹${(b.invested||0).toFixed(2)}, Gain=₹${(b.gain||0).toFixed(2)} [${b.source}]`);
});

