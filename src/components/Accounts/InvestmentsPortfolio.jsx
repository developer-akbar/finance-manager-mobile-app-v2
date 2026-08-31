import React, { useState, useMemo, useEffect } from 'react';
import { PieChart, Pie, Cell } from 'recharts';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, formatINRCompact, parseDate, calculateAge, txnAmount, checkIsRedeemed } from '../../utils/format.js';
import TransactionItem from '../Transactions/TransactionItem.jsx';
import { activeHoldingsData } from '../../database/holdingsData.js';
import { calculateBrokerageState as calculateShareMarketBalances, parseTxnFields } from '../../utils/brokerageAccounting.js';
import './InvestmentsPortfolio.css';

const RADIAN = Math.PI / 180;
const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, index }) => {
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" style={{ fontSize: '0.68rem', fontWeight: 'bold' }}>
      {percent > 0.05 ? `${(percent * 100).toFixed(0)}%` : ''}
    </text>
  );
};

export default function InvestmentsPortfolio({ onBack, backInterceptRef }) {
  const { state } = useApp();
  const { transactions, accounts } = state;

  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('active'); // 'active' | 'redeemed'
  const [selectedAsset, setSelectedAsset] = useState('All'); // 'All' | accountName
  const [periodMode, setPeriodMode] = useState('all'); // 'all' | 'year' | 'fy'
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [sortBy, setSortBy] = useState('date-desc'); // 'date-desc' | 'date-asc' | 'amount-desc' | 'age-desc'
  const [viewMode, setViewMode] = useState('grouped'); // 'grouped' | 'list'
  const [expandedFunds, setExpandedFunds] = useState(new Set());
  const [activeIndex, setActiveIndex] = useState(-1);
  const [anyModalOpen, setAnyModalOpen] = useState(false);

  // Intercept back button
  useEffect(() => {
    if (!backInterceptRef) return;
    backInterceptRef.current = onBack;
    return () => {
      if (backInterceptRef) backInterceptRef.current = null;
    };
  }, [onBack, backInterceptRef]);

  // Sync scroll lock or container pointer events based on any open sheets
  useEffect(() => {
    const checkModal = () => {
      const hasModal = document.querySelector('.bottom-sheet.dp-sheet') !== null;
      setAnyModalOpen(hasModal);
    };
    checkModal();
    const observer = new MutationObserver(checkModal);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // 1. Identify Investment Accounts
  const investmentAccounts = useMemo(() => {
    return (accounts || []).filter(a => a.group?.toLowerCase() === 'investments');
  }, [accounts]);

  const isInvestmentAccount = useMemo(() => {
    const names = new Set(investmentAccounts.map(a => a.name.toLowerCase()));
    return (name) => name ? names.has(name.toLowerCase()) : false;
  }, [investmentAccounts]);

  const getAssociatedInvestmentAsset = (t) => {
    const acct = String(t.Account || t.FromAccount || '').trim();
    const dest = String(t.ToAccount || '').trim();
    const acctLower = acct.toLowerCase();
    const destLower = dest.toLowerCase();
    
    const ia = investmentAccounts.find(a => a.name.toLowerCase() === acctLower);
    if (ia) return ia.name;
    const idest = investmentAccounts.find(a => a.name.toLowerCase() === destLower);
    if (idest) return idest.name;

    const note = String(t.Note || '').toLowerCase();
    const desc = String(t.Description || '').toLowerCase();
    const cat = String(t.Category || '').toLowerCase();
    const combined = `${note} ${desc} ${cat}`;

    if (combined.includes('tax saver') || combined.includes('tax advantage')) {
      return 'Mutual Funds Tax Saver';
    }
    if (combined.includes('liquid') || combined.includes('lmf')) {
      return 'Liquid Mutual Funds';
    }
    if (combined.includes('mutual fund') || combined.includes('mf') || combined.includes('groww')) {
      return 'Liquid Mutual Funds';
    }
    if (combined.includes('share market') || combined.includes('zerodha') || combined.includes('dividend') || cat === 'equity') {
      return 'Share Market';
    }
    return null;
  };

  const getAssociatedSubAccount = (t, parentAsset) => {
    const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || t.ToSubAccount || t.to_sub_account || '').trim();
    if (sub) return sub;

    const note = String(t.Note || '').toLowerCase();
    const desc = String(t.Description || '').toLowerCase();
    const combined = `${note} ${desc}`;

    if (parentAsset === 'Share Market') {
      if (combined.includes('groww') || combined.includes('fareeda')) return 'Fareeda Groww';
      return 'Zerodha';
    }
    if (parentAsset === 'Liquid Mutual Funds') {
      if (combined.includes('ammi grow') || combined.includes('ammi')) return 'Ammi Groww';
      if (combined.includes('fareeda') && combined.includes('groww')) return 'Fareeda Groww';
      if (combined.includes('fareeda') && combined.includes('etmoney')) return 'Fareeda ETMoney';
      if (combined.includes('scripbox')) return 'Scripbox';
      return 'Groww';
    }
    return null;
  };

  const isInvestmentTxn = useMemo(() => {
    return (t) => {
      const f = parseTxnFields(t);
      if (f.brokerage || f.type === 'BUY' || f.type === 'SELL' || f.type === 'OPENING_LOT' || f.type === 'BONUS' || f.type === 'REALIZED_PNL') {
        return true;
      }
      
      const acct = t.Account || t.FromAccount || '';
      const dest = t.ToAccount || '';
      const isInvAcc = isInvestmentAccount(acct) || isInvestmentAccount(dest);
      
      const cat = String(t.Category || '').toLowerCase();
      const note = String(t.Note || '').toLowerCase();

      // Ignore generic/inventory stock profit and lending profit on non-investment accounts
      if (!isInvAcc && (note === 'stock profit' || note === 'profit')) {
        return false;
      }

      if (isInvAcc) return true;
      if (cat === 'equity' || cat === 'investment returns') return true;
      if (
        note.includes('dividend') || 
        note.includes('profit') || 
        note.includes('loss') ||
        note === 'motilal oswal asset management' ||
        note === 'l&t tax advantage'
      ) {
        return true;
      }
      return false;
    };
  }, [isInvestmentAccount]);

  // 2. Period Filters Helpers
  const getPeriodRange = useMemo(() => {
    if (periodMode === 'all') return { start: null, end: null };
    if (periodMode === 'year') {
      const start = new Date(selectedYear, 0, 1);
      const end = new Date(selectedYear, 11, 31, 23, 59, 59);
      return { start, end };
    }
    if (periodMode === 'fy') {
      const start = new Date(selectedYear, 3, 1);
      const end = new Date(selectedYear + 1, 2, 31, 23, 59, 59);
      return { start, end };
    }
    return { start: null, end: null };
  }, [periodMode, selectedYear]);

  const isInPeriod = useMemo(() => {
    return (dateStr) => {
      if (periodMode === 'all') return true;
      const d = parseDate(dateStr);
      if (d.getTime() === 0) return false;
      const { start, end } = getPeriodRange;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    };
  }, [periodMode, getPeriodRange]);

  // 3. Fetch all investment transactions
  const allInvestmentTxns = useMemo(() => {
    return transactions.filter(isInvestmentTxn);
  }, [transactions, isInvestmentTxn]);

  // 4. Dictionary of active investment fund names to match dividends correctly
  const fundNamesList = useMemo(() => {
    return Array.from(new Set(
      allInvestmentTxns
        .filter(t => !String(t.Note || '').toLowerCase().includes('dividend'))
        .map(t => (t.Note || t.Category || t.Account || '').trim())
        .filter(Boolean)
    ));
  }, [allInvestmentTxns]);

  const findDividendFund = (dividendNote) => {
    const divNoteLower = String(dividendNote || '').toLowerCase();
    for (const f of fundNamesList) {
      if (divNoteLower.includes(f.toLowerCase())) {
        return f;
      }
    }
  };



  // 5. Calculate Portfolio Stats & Balances (dynamically filtered by selected period and asset)
  const {
    accountBalances,
    totalPortfolioValue,
    totalInvestedCapital,
    portfolioGainLoss,
    gainLossPercent,
    totalDividends,
    dividendsByFund,
    fundValuationsMap,
    shareMarketBalances
  } = useMemo(() => {
    // Resolve asset key for a transaction
    const getAssetKeyForTxn = (parentName, subName) => {
      if (!parentName) return null;
      const a = investmentAccounts.find(acc => acc.name.toLowerCase() === parentName.toLowerCase());
      if (!a) return null;
      if (a.subAccounts && a.subAccounts.length > 0) {
        const sub = a.subAccounts.find(s => s.name.toLowerCase() === (subName || '').toLowerCase());
        if (sub) {
          return `${a.name} > ${sub.name}`;
        }
        if (subName) {
          return `${a.name} > ${subName}`;
        }
      }
      return a.name;
    };

    const balances = {};
    const invested = {};
    const divs = {};
    const realizedMap = {};
    let grandDivs = 0;

    const smBalances = calculateShareMarketBalances(transactions, state.brokerages, state.settings);

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

    let periodGainsSum = 0;
    let periodRealizedGains = 0;

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

      // Period Investments & Gains
      if (isInPeriod(t.Date)) {
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
              periodRealizedGains += amt;
              realizedMap[key] = (realizedMap[key] || 0) + amt;
            }
          }
        } else {
          // Regular buy/sell transfers
          if (isDestInv && destKey && !destKey.startsWith('Share Market > ')) {
            invested[destKey] = (invested[destKey] || 0) + amt;
          }
          if (isAcctInv && acctKey && !acctKey.startsWith('Share Market > ')) {
            invested[acctKey] = (invested[acctKey] || 0) - amt;
          }
        }

        // Gains summation within the period for investment account ledger adjustments
        if (isAcctInv && !isDividend && !isRealizedGain) {
          if (type === 'Income') {
            periodGainsSum += amt;
          } else if (type === 'Expense') {
            periodGainsSum -= amt;
          }
        }
      }
    }

    // ── Parse Valuations Chronologically for Accordion ──
    const valuations = {};
    const sortedTxns = [...transactions].sort((a, b) => {
      const da = parseDate(a.Date).getTime();
      const db = parseDate(b.Date).getTime();
      return da - db;
    });

    const isBeforeOrInPeriod = (dateStr) => {
      if (periodMode === 'all') return true;
      const d = parseDate(dateStr);
      if (d.getTime() === 0) return false;
      const { end } = getPeriodRange;
      if (end && d > end) return false;
      return true;
    };

    for (const t of sortedTxns) {
      if (!isBeforeOrInPeriod(t.Date)) continue;
      const desc = String(t.Description || t.description || '');
      const note = String(t.Note || t.note || '');
      const combined = `${note}\n${desc}`;

      if (combined.includes(':')) {
        const lines = combined.split(/\r?\n/);
        for (const line of lines) {
          const match = line.match(/^\s*([^:]+?)\s*:\s*([\d.]+)(?:\s+out\s+of\s+([\d.]+))?\s*$/i);
          if (match) {
            const fundName = match[1].trim();
            if (
              fundName.toLowerCase() === 'time' ||
              fundName.toLowerCase() === 'vi' ||
              fundName.toLowerCase() === 'jio' ||
              fundName.toLowerCase() === 'flipkart' ||
              fundName.toLowerCase() === 'amazon'
            ) {
              continue;
            }
            const val = parseFloat(match[2]);
            const inv = match[3] ? parseFloat(match[3]) : null;
            if (!isNaN(val)) {
              valuations[fundName] = {
                date: t.Date,
                currentValue: val,
                investedValue: inv
              };
            }
          }
        }
      }
    }

    const totalVal = Object.values(balances).reduce((sum, v) => sum + v, 0);
    const totalInv = Object.values(invested).reduce((sum, v) => sum + v, 0);

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
    if (periodMode === 'all') {
      Object.keys(balances).forEach(key => {
        if (key.startsWith('Share Market > ')) {
          const broker = key.substring('Share Market > '.length);
          const details = smBalances[broker];
          if (details) {
            totalGainLoss += (details.currentValue - details.investedCost);
          }
        } else {
          const valObj = getValuationForAssetLocal(key);
          const groupRealized = realizedMap[key] || 0;
          if (valObj) {
            const currentValue = valObj.currentValue;
            const totalAmount = invested[key] || 0;
            totalGainLoss += (currentValue - totalAmount) + groupRealized;
          } else {
            totalGainLoss += groupRealized;
          }
        }
      });
    }

    // Gain Loss display logic: cumulative if all time, period-specific if filtered
    const gainLoss = periodMode === 'all'
      ? totalGainLoss
      : periodGainsSum + periodRealizedGains;

    const gainLossPct = totalInv > 0 ? (gainLoss / totalInv) * 100 : 0;

    return {
      accountBalances: balances,
      totalPortfolioValue: totalVal,
      totalInvestedCapital: totalInv,
      portfolioGainLoss: gainLoss,
      gainLossPercent: gainLossPct,
      totalDividends: grandDivs,
      dividendsByFund: divs,
      fundValuationsMap: valuations,
      shareMarketBalances: smBalances
    };
  }, [transactions, investmentAccounts, selectedAsset, isInPeriod, periodMode, fundNamesList, getPeriodRange]);

  // 6. Filter transactions into Active vs. Redeemed
  const { activeTxns, redeemedTxns } = useMemo(() => {
    const active = [];
    const redeemed = [];

    for (const t of allInvestmentTxns) {
      if (selectedAsset !== 'All') {
        const acct = t.Account || t.FromAccount || '';
        const dest = t.ToAccount || '';
        if (acct.toLowerCase() !== selectedAsset.toLowerCase() && dest.toLowerCase() !== selectedAsset.toLowerCase()) {
          continue;
        }
      }

      if (!isInPeriod(t.Date)) {
        continue;
      }

      const isRed = checkIsRedeemed(t);
      if (isRed) {
        redeemed.push(t);
      } else {
        active.push(t);
      }
    }

    return {
      activeTxns: active,
      redeemedTxns: redeemed
    };
  }, [allInvestmentTxns, selectedAsset, isInPeriod]);

  // 7. Filter, Search, and Sort display list
  const filteredList = useMemo(() => {
    const list = activeTab === 'active' ? activeTxns : redeemedTxns;

    const q = search.toLowerCase().trim();
    const searched = q
      ? list.filter(t =>
        (t.Note || '').toLowerCase().includes(q) ||
        (t.Category || '').toLowerCase().includes(q) ||
        (t.Description || '').toLowerCase().includes(q) ||
        (t.Account || t.FromAccount || '').toLowerCase().includes(q) ||
        (t.ToAccount || '').toLowerCase().includes(q) ||
        (t.Tags || '').toLowerCase().includes(q)
      )
      : list;

    const sorted = [...searched];
    sorted.sort((a, b) => {
      const da = parseDate(a.Date).getTime();
      const db = parseDate(b.Date).getTime();
      const amta = parseFloat(a.INR || a.Amount || 0);
      const amtb = parseFloat(b.INR || b.Amount || 0);

      if (sortBy === 'date-desc') return db - da;
      if (sortBy === 'date-asc') return da - db;
      if (sortBy === 'amount-desc') return amtb - amta;
      if (sortBy === 'age-desc') return da - db;
      return 0;
    });

    return sorted;
  }, [activeTab, activeTxns, redeemedTxns, search, sortBy]);

  // 8. Group list by Fund Name and apply dynamic sorting (Issue 1)
  const groupedList = useMemo(() => {
    if (viewMode !== 'grouped') return [];

    // Resolve asset key for a transaction
    const getAssetKeyForTxn = (parentName, subName) => {
      if (!parentName) return null;
      const a = investmentAccounts.find(acc => acc.name.toLowerCase() === parentName.toLowerCase());
      if (!a) return null;
      if (a.subAccounts && a.subAccounts.length > 0) {
        const sub = a.subAccounts.find(s => s.name.toLowerCase() === (subName || '').toLowerCase());
        if (sub) {
          return `${a.name} > ${sub.name}`;
        }
        if (subName) {
          return `${a.name} > ${subName}`;
        }
      }
      return a.name;
    };

    const getValuationForAsset = (assetKey) => {
      if (!assetKey) return null;
      if (fundValuationsMap[assetKey]) return fundValuationsMap[assetKey];
      if (assetKey.includes(' > ')) {
        const parts = assetKey.split(' > ');
        const subPart = parts[parts.length - 1];
        if (fundValuationsMap[subPart]) return fundValuationsMap[subPart];
      }
      return null;
    };

    const groups = {};

    for (const t of filteredList) {
      const acct = String(t.Account || t.FromAccount || '').trim();
      const dest = String(t.ToAccount || '').trim();
      const sub = String(t.SubAccount || t.sub_account || t.FromSubAccount || t.from_sub_account || '').trim();
      const destSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

      const resolvedSub = sub || (isInvestmentAccount(acct) ? getAssociatedSubAccount(t, acct) : '');
      const resolvedDestSub = destSub || (isInvestmentAccount(dest) ? getAssociatedSubAccount(t, dest) : '');

      const acctKey = getAssetKeyForTxn(acct, resolvedSub);
      const destKey = getAssetKeyForTxn(dest, resolvedDestSub);

      let fundName = (t.Note || t.Category || t.Account || 'Unspecified').trim();
      if (destKey) {
        fundName = destKey;
      } else if (acctKey) {
        fundName = acctKey;
      } else {
        // Fallback for bank-deposited dividends or mutual fund profit/loss
        const cat = String(t.Category || '').toLowerCase();
        const note = String(t.Note || '').toLowerCase();
        const isDividend = note.includes('dividend') || (cat === 'equity' && note === 'dividend');
        const isRealizedGain = !isDividend && (
          note.includes('profit') || 
          note.includes('loss') ||
          (cat === 'equity' && (note === 'motilal oswal asset management' || note === 'l&t tax advantage'))
        );

        if (isDividend || isRealizedGain) {
          const parent = getAssociatedInvestmentAsset(t);
          if (parent) {
            const sName = getAssociatedSubAccount(t, parent);
            const key = getAssetKeyForTxn(parent, sName);
            if (key) {
              fundName = key;
            }
          }
        }
      }

      if (!groups[fundName]) {
        groups[fundName] = {
          fundName,
          transactions: [],
          totalAmount: 0,
          currentValue: 0,
          gainAmount: 0,
          gainPercent: 0
        };
      }
      groups[fundName].transactions.push(t);

      // Sum net capital contributions (Rule 7)
      const amt = parseFloat(t.INR || t.Amount || 0);
      const type = String(t['Income/Expense'] || '').trim();
      const isDestInv = isInvestmentAccount(dest);
      const isAcctInv = isInvestmentAccount(acct);
      const isIncome = (type === 'Income');

      let netVal = 0;
      if (isDestInv && !isIncome) {
        netVal += amt;
      }
      if (isAcctInv && !isIncome) {
        netVal -= amt;
      }
      groups[fundName].totalAmount += netVal;
    }

    // Enrich valuations and gains
    for (const g of Object.values(groups)) {
      let groupRealized = 0;
      let groupDividends = 0;
      for (const t of g.transactions) {
        const amt = parseFloat(t.INR || t.Amount || 0);
        const cat = String(t.Category || '').toLowerCase();
        const note = String(t.Note || '').toLowerCase();
        const f = parseTxnFields(t);
        if (f.type === 'REALIZED_PNL') {
          groupRealized += f.realizedPnL;
        } else if (f.type === 'DIVIDEND') {
          groupDividends += f.cashImpact;
        } else if (note.includes('dividend') || (cat === 'equity' && note === 'dividend')) {
          groupDividends += amt;
        } else if (
          note.includes('profit') || 
          note.includes('loss') ||
          (cat === 'equity' && (note === 'motilal oswal asset management' || note === 'l&t tax advantage'))
        ) {
          groupRealized += amt;
        }
      }

      // Check if this is a stock holding in Share Market
      let stockHoldingCost = 0;
      let stockCurrentVal = 0;
      let hasStockHolding = false;

      Object.values(shareMarketBalances || {}).forEach(brokerDetails => {
        const h = brokerDetails.activeHoldings?.find(hold => hold.symbol === g.fundName);
        if (h) {
          stockHoldingCost += h.investedCost;
          stockCurrentVal += h.currentValue;
          hasStockHolding = true;
        }
      });

      if (activeTab === 'active') {
        if (hasStockHolding) {
          g.totalAmount = stockHoldingCost;
          g.currentValue = stockCurrentVal;
          g.gainAmount = (g.currentValue - g.totalAmount) + groupRealized + groupDividends;
        } else {
          const valObj = getValuationForAsset(g.fundName);
          if (valObj) {
            g.currentValue = valObj.currentValue;
            g.gainAmount = (g.currentValue - g.totalAmount) + groupRealized + groupDividends;
          } else {
            g.currentValue = accountBalances[g.fundName] !== undefined ? accountBalances[g.fundName] : g.totalAmount;
            g.gainAmount = groupRealized + groupDividends;
          }
        }
        g.gainPercent = g.totalAmount > 0 ? (g.gainAmount / g.totalAmount) * 100 : 0;
      } else {
        // Redeemed tab - calculate realized profit
        let totalBuy = 0;
        let totalSell = 0;
        for (const t of g.transactions) {
          const f = parseTxnFields(t);
          if (f.type === 'BUY' || f.type === 'OPENING_LOT') {
            totalBuy += f.cost;
          } else if (f.type === 'SELL') {
            totalSell += f.cost;
          } else {
            const amt = parseFloat(t.INR || t.Amount || 0);
            const type = String(t['Income/Expense'] || '').trim();
            const acct = String(t.Account || t.FromAccount || '').trim();
            const dest = String(t.ToAccount || '').trim();
            const isDestInv = isInvestmentAccount(dest);
            const isAcctInv = isInvestmentAccount(acct);
            const isIncome = (type === 'Income');

            if (isDestInv && !isIncome) totalBuy += amt;
            if (isAcctInv && !isIncome) totalSell += amt;
          }
        }
        g.currentValue = totalSell;
        g.totalAmount = totalBuy;
        g.gainAmount = (totalSell - totalBuy) + groupRealized + groupDividends;
        g.gainPercent = totalBuy > 0 ? (g.gainAmount / totalBuy) * 100 : 0;
      }
    }

    const sortedGroups = Object.values(groups).filter(g => {
      const nameLower = g.fundName.toLowerCase();
      if (nameLower === 'share market' || nameLower === 'share market > zerodha') {
        return false;
      }
      const excludedKeywords = [
        'demat charges',
        'zerodha demat amc',
        'demat credit',
        'fno',
        'to zerodha',
        'from zerodha',
        'to share market',
        'unspecified'
      ];
      return !excludedKeywords.some(keyword => nameLower.includes(keyword));
    });

    // Group accordions dynamic sorting (Issue 1)
    sortedGroups.sort((a, b) => {
      const valA = a.currentValue || a.totalAmount;
      const valB = b.currentValue || b.totalAmount;
      if (sortBy === 'amount-desc') {
        return valB - valA;
      }

      const getNewestTime = (g) => Math.max(...g.transactions.map(t => parseDate(t.Date).getTime()));
      const getOldestTime = (g) => Math.min(...g.transactions.map(t => parseDate(t.Date).getTime()));

      const taNew = getNewestTime(a);
      const tbNew = getNewestTime(b);
      const taOld = getOldestTime(a);
      const tbOld = getOldestTime(b);

      if (sortBy === 'date-desc') return tbNew - taNew;
      if (sortBy === 'date-asc') return taOld - tbOld;
      if (sortBy === 'age-desc') return taOld - tbOld;
      return 0;
    });

    return sortedGroups;
  }, [filteredList, viewMode, isInvestmentAccount, sortBy, activeTab, fundValuationsMap, shareMarketBalances]);

  // 9. Chart Allocation Data
  const chartData = useMemo(() => {
    const colors = ['#00e5a0', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981'];
    return Object.entries(accountBalances)
      .map(([name, val], i) => ({
        name,
        value: val > 0 ? val : 0,
        color: colors[i % colors.length]
      }))
      .filter(d => d.value > 0);
  }, [accountBalances]);

  return (
    <div className="investments-portfolio-screen">
      {/* Header */}
      <div className="page-hdr" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={onBack}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              padding: 0
            }}
            title="Go back"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="20" height="20" style={{ stroke: 'var(--text-muted)' }}>
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>
          <div className="page-hdr-title">Investment Portfolio</div>
        </div>
      </div>

      {/* Main Container - pointerEvents locked when modal is open */}
      <div
        className="portfolio-scrollable-content"
        style={{ pointerEvents: anyModalOpen ? 'none' : 'auto' }}
      >
        {/* Core Summary Stats Card */}
        <div className="portfolio-hero-card">
          <div className="portfolio-hero-main">
            <div className="portfolio-hero-lbl">
              {selectedAsset === 'All' ? 'Portfolio Value' : `${selectedAsset} Value`}
            </div>
            <div className="portfolio-hero-val">{formatINR(totalPortfolioValue)}</div>
            <div className={`portfolio-hero-change ${portfolioGainLoss >= 0 ? 'profit' : 'loss'}`}>
              {portfolioGainLoss >= 0 ? '▲' : '▼'} {formatINR(Math.abs(portfolioGainLoss))} ({gainLossPercent.toFixed(2)}%)
            </div>
          </div>
          <div className="portfolio-hero-details">
            <div className="portfolio-hero-det-item">
              <div className="portfolio-hero-det-lbl">Invested Capital</div>
              <div className="portfolio-hero-det-val">{formatINR(totalInvestedCapital)}</div>
            </div>
            <div className="portfolio-hero-det-divider" />
            <div className="portfolio-hero-det-item">
              <div className="portfolio-hero-det-lbl">Period Gains</div>
              <div className="portfolio-hero-det-val" style={{ color: portfolioGainLoss >= 0 ? 'var(--green)' : 'var(--expense)' }}>
                {portfolioGainLoss >= 0 ? '+' : ''}{formatINR(portfolioGainLoss)}
              </div>
            </div>
            <div className="portfolio-hero-det-divider" />
            <div className="portfolio-hero-det-item">
              <div className="portfolio-hero-det-lbl">Period Dividends</div>
              <div className="portfolio-hero-det-val" style={{ color: 'var(--green)' }}>
                +{formatINR(totalDividends)}
              </div>
            </div>
          </div>
        </div>

        {/* Period Selector Tabs & Paginator */}
        <div className="portfolio-period-wrap">
          <div className="portfolio-tabs period-tabs">
            <button
              className={`portfolio-tab-btn ${periodMode === 'all' ? 'active' : ''}`}
              onClick={() => setPeriodMode('all')}
            >
              All Time
            </button>
            <button
              className={`portfolio-tab-btn ${periodMode === 'year' ? 'active' : ''}`}
              onClick={() => setPeriodMode('year')}
            >
              Calendar Year
            </button>
            <button
              className={`portfolio-tab-btn ${periodMode === 'fy' ? 'active' : ''}`}
              onClick={() => setPeriodMode('fy')}
            >
              Financial Year
            </button>
          </div>

          {periodMode !== 'all' && (
            <div className="portfolio-paginator">
              <button className="paginator-btn" onClick={() => setSelectedYear(y => y - 1)}>◀</button>
              <div className="paginator-label">
                {periodMode === 'year'
                  ? `${selectedYear}`
                  : `FY ${selectedYear}-${String(selectedYear + 1).slice(-2)}`
                }
              </div>
              <button className="paginator-btn" onClick={() => setSelectedYear(y => y + 1)}>▶</button>
            </div>
          )}
        </div>

        {/* Charts & Asset Allocation - Fixed width/height warning */}
        {selectedAsset === 'All' && chartData.length > 0 && (
          <div className="portfolio-section-card" style={{ marginTop: 14 }}>
            <div className="section-title">Asset Allocation</div>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16, justifyContent: 'center' }}>
              <div style={{ width: 180, height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <PieChart width={180} height={180}>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={renderCustomizedLabel}
                    outerRadius={75}
                    fill="#8884d8"
                    dataKey="value"
                    isAnimationActive={false}
                    onMouseEnter={(data, index) => setActiveIndex(index)}
                    onMouseLeave={() => setActiveIndex(-1)}
                    onClick={(data, index) => setActiveIndex(activeIndex === index ? -1 : index)}
                  >
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.color}
                        stroke={activeIndex === index ? 'var(--text-primary)' : 'none'}
                        strokeWidth={activeIndex === index ? 2 : 0}
                        opacity={activeIndex === -1 || activeIndex === index ? 1 : 0.6}
                        style={{ transition: 'opacity 0.2s ease', outline: 'none', cursor: 'pointer' }}
                      />
                    ))}
                  </Pie>
                </PieChart>
              </div>
              <div className="portfolio-legend-list">
                {chartData.map((d, index) => {
                  const pct = totalPortfolioValue > 0 ? (d.value / totalPortfolioValue) * 100 : 0;
                  const isHighlighted = activeIndex === index;
                  return (
                    <div
                      key={d.name}
                      className={`legend-item ${isHighlighted ? 'highlighted' : ''}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseLeave={() => setActiveIndex(-1)}
                      onClick={() => setActiveIndex(activeIndex === index ? -1 : index)}
                      style={{
                        padding: '6px 8px',
                        borderRadius: '8px',
                        background: isHighlighted ? 'var(--bg-hover)' : 'transparent',
                        transition: 'all 0.2s ease',
                        cursor: 'pointer',
                        border: isHighlighted ? '1px solid var(--border)' : '1px solid transparent'
                      }}
                    >
                      <div className="legend-color-dot" style={{ backgroundColor: d.color }} />
                      <div className="legend-item-info">
                        <span className="legend-item-name" style={{ fontWeight: isHighlighted ? '800' : '700' }}>{d.name}</span>
                        <span className="legend-item-val">{formatINRCompact(d.value)} ({pct.toFixed(0)}%)</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Asset Selector Horizontal Chips */}
        <div className="portfolio-asset-chips-wrap">
          <button
            className={`portfolio-chip-btn ${selectedAsset === 'All' ? 'active' : ''}`}
            onClick={() => setSelectedAsset('All')}
          >
            All Assets
          </button>
          {investmentAccounts.map(acc => (
            <button
              key={acc.name}
              className={`portfolio-chip-btn ${selectedAsset === acc.name ? 'active' : ''}`}
              onClick={() => setSelectedAsset(acc.name)}
            >
              {acc.name}
            </button>
          ))}
        </div>

        {/* Search & Filter Toolbar */}
        <div className="portfolio-toolbar">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div className="portfolio-tabs view-mode-tabs" style={{ flex: 1 }}>
              <button
                className={`portfolio-tab-btn ${viewMode === 'grouped' ? 'active' : ''}`}
                onClick={() => setViewMode('grouped')}
              >
                Grouped
              </button>
              <button
                className={`portfolio-tab-btn ${viewMode === 'list' ? 'active' : ''}`}
                onClick={() => setViewMode('list')}
              >
                Flat List
              </button>
            </div>
            <div className="portfolio-tabs active-tab-select" style={{ flex: 1 }}>
              <button
                className={`portfolio-tab-btn ${activeTab === 'active' ? 'active' : ''}`}
                onClick={() => setActiveTab('active')}
              >
                Active ({selectedAsset === 'Share Market' ? Object.values(shareMarketBalances || {}).reduce((sum, b) => sum + (b.activeCount ?? b.activeHoldings?.length ?? 0), 0) : activeTxns.length})
              </button>
              <button
                className={`portfolio-tab-btn ${activeTab === 'redeemed' ? 'active' : ''}`}
                onClick={() => setActiveTab('redeemed')}
              >
                Redeemed ({selectedAsset === 'Share Market' ? Object.values(shareMarketBalances || {}).reduce((sum, b) => sum + (b.redeemedCount ?? b.redeemedHoldings?.length ?? 0), 0) : redeemedTxns.length})
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <div className="portfolio-search-input-wrap" style={{ flex: 1.4 }}>
              <input
                type="text"
                placeholder="Search investments..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="portfolio-search-input"
              />
              {search && (
                <button className="portfolio-search-clear" onClick={() => setSearch('')}>✕</button>
              )}
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="portfolio-sort-select"
              style={{ flex: 0.8 }}
            >
              <option value="date-desc">Newest</option>
              <option value="date-asc">Oldest</option>
              <option value="amount-desc">Highest</option>
              <option value="age-desc">Longest</option>
            </select>
          </div>
        </div>

        {/* Grouped Accordion List or Flat list */}
        {selectedAsset === 'Share Market' ? (
          <div className="share-market-dashboard">
            {Object.entries(shareMarketBalances || {}).map(([broker, details]) => {
              const hasHoldings = details.activeHoldings && details.activeHoldings.length > 0;
              const isExpanded = expandedFunds.has(broker);
              
              // Calculate dynamic gains
              const unrealizedGain = details.currentValue - details.investedCost;
              const unrealizedGainPct = details.investedCost > 0 ? (unrealizedGain / details.investedCost) * 100 : 0;
              
              return (
                <div key={broker} className={`portfolio-group-card ${isExpanded ? 'expanded' : ''}`} style={{ marginBottom: 16 }}>
                  <div
                    className="portfolio-group-hdr"
                    style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    onClick={() => {
                      if (!hasHoldings) return;
                      setExpandedFunds(prev => {
                        const newSet = new Set(prev);
                        if (newSet.has(broker)) {
                          newSet.delete(broker);
                        } else {
                          newSet.add(broker);
                        }
                        return newSet;
                      });
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1.5 }}>
                      {hasHoldings && <span className={`group-chevron ${isExpanded ? 'expanded' : ''}`}>▼</span>}
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span className="group-fund-name" style={{ fontWeight: '800', fontSize: '1rem', color: 'var(--text-primary)' }}>{broker}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                          Cash Balance: {(details.cashBalance < 0 || details.cash < 0) ? '−' : ''}{formatINR(Math.abs(details.cashBalance !== undefined ? details.cashBalance : details.cash))}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flex: 1 }}>
                      <span className="group-fund-amount" style={{ fontWeight: '800', fontSize: '1rem', color: 'var(--text-primary)' }}>
                        {formatINR(details.totalPortfolioValue !== undefined ? details.totalPortfolioValue : details.totalValue)}
                      </span>
                      <div style={{ display: 'flex', gap: 8, fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        <span>Invested: {formatINR(details.investedCost)}</span>
                        {hasHoldings && (
                          <span style={{ color: unrealizedGain >= 0 ? 'var(--green)' : 'var(--expense)', fontWeight: 'bold' }}>
                            {unrealizedGain >= 0 ? '▲' : '▼'} {formatINR(Math.abs(unrealizedGain))} ({unrealizedGainPct.toFixed(2)}%)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {isExpanded && hasHoldings && (
                    <div className="portfolio-group-txns" style={{ padding: '0px 0px 12px 0px', background: 'var(--bg-card2)' }}>
                      <div style={{ overflowX: 'auto', padding: '12px 16px 4px 16px' }}>
                        <table className="holdings-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: 500 }}>
                          <thead>
                            <tr style={{ borderBottom: '1.5px solid var(--border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                              <th style={{ padding: '6px 4px', fontWeight: 'bold' }}>Holding</th>
                              <th style={{ padding: '6px 4px', fontWeight: 'bold', textAlign: 'right' }}>Qty</th>
                              <th style={{ padding: '6px 4px', fontWeight: 'bold', textAlign: 'right' }}>Avg. Price</th>
                              <th style={{ padding: '6px 4px', fontWeight: 'bold', textAlign: 'right' }}>Invested Cost</th>
                              <th style={{ padding: '6px 4px', fontWeight: 'bold', textAlign: 'right' }}>Current Price</th>
                              <th style={{ padding: '6px 4px', fontWeight: 'bold', textAlign: 'right' }}>Current Value</th>
                              <th style={{ padding: '6px 4px', fontWeight: 'bold', textAlign: 'right' }}>Returns</th>
                            </tr>
                          </thead>
                          <tbody>
                            {details.activeHoldings.map(h => {
                              const hAvgPrice = h.qty > 0 ? h.investedCost / h.qty : 0;
                              const hCurrentPrice = h.qty > 0 ? h.currentValue / h.qty : 0;
                              const hReturn = h.currentValue - h.investedCost;
                              const hReturnPct = h.investedCost > 0 ? (hReturn / h.investedCost) * 100 : 0;
                              
                              return (
                                <tr key={h.symbol} style={{ borderBottom: '1px solid var(--border-light)' }}>
                                  <td style={{ padding: '10px 4px', fontWeight: 'bold', color: 'var(--text-primary)' }}>{h.symbol}</td>
                                  <td style={{ padding: '10px 4px', textAlign: 'right', color: 'var(--text-primary)' }}>{h.qty}</td>
                                  <td style={{ padding: '10px 4px', textAlign: 'right', color: 'var(--text-muted)' }}>{formatINR(hAvgPrice)}</td>
                                  <td style={{ padding: '10px 4px', textAlign: 'right', color: 'var(--text-primary)' }}>{formatINR(h.investedCost)}</td>
                                  <td style={{ padding: '10px 4px', textAlign: 'right', color: 'var(--text-muted)' }}>{formatINR(hCurrentPrice)}</td>
                                  <td style={{ padding: '10px 4px', textAlign: 'right', fontWeight: '700', color: 'var(--text-primary)' }}>{formatINR(h.currentValue)}</td>
                                  <td style={{ padding: '10px 4px', textAlign: 'right', fontWeight: 'bold', color: hReturn >= 0 ? 'var(--green)' : 'var(--expense)' }}>
                                    <div>{hReturn >= 0 ? '+' : ''}{formatINR(hReturn)}</div>
                                    <div style={{ fontSize: '0.66rem', opacity: 0.85, marginTop: 1 }}>{hReturnPct.toFixed(1)}%</div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : viewMode === 'grouped' ? (
          <div className="portfolio-grouped-list">
            {groupedList.map(g => {
              const isExpanded = expandedFunds.has(g.fundName);
              const fundDivs = dividendsByFund[g.fundName] || 0;
              return (
                <div key={g.fundName} className={`portfolio-group-card ${isExpanded ? 'expanded' : ''}`}>
                  <div
                    className="portfolio-group-hdr"
                    onClick={() => {
                      setExpandedFunds(prev => {
                        const newSet = new Set(prev);
                        if (newSet.has(g.fundName)) {
                          newSet.delete(g.fundName);
                        } else {
                          newSet.add(g.fundName);
                        }
                        return newSet;
                      });
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', flex: 1.5 }}>
                      <span className={`group-chevron ${isExpanded ? 'expanded' : ''}`}>▼</span>
                      <span className="group-fund-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.fundName}</span>
                      <span className="group-fund-count" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>({g.transactions.length})</span>
                    </div>
                    {/* Render Values on the right */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flex: 1 }}>
                      <span className="group-fund-amount" style={{ fontWeight: 'bold', fontSize: '0.84rem' }}>{formatINR(g.currentValue)}</span>
                      <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        Inv {formatINR(g.totalAmount)}
                      </span>
                      {fundDivs > 0 && (
                        <span className="group-fund-divs" style={{ fontSize: '0.66rem', color: 'var(--green)', fontWeight: 'bold', marginTop: '2px' }}>
                          +{formatINR(fundDivs)} Div
                        </span>
                      )}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="portfolio-group-txns">
                      {g.transactions.map(t => (
                        <div key={t.id || t._id} className="portfolio-txn-item-card" style={{ border: 'none', background: 'none', borderTop: '1px solid var(--border)', borderRadius: 0 }}>
                          <TransactionItem
                            transaction={t}
                            showDate={true}
                            backInterceptRef={backInterceptRef}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {groupedList.length === 0 && (
              <div className="empty-state" style={{ padding: '40px 10px' }}>
                <div className="empty-icon">📈</div>
                <div className="empty-title">No funds found</div>
                <div className="empty-desc">
                  No records match the current filters or sorting selection.
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="portfolio-txns-list">
            {filteredList.map(t => (
              <div key={t.id || t._id} className="portfolio-txn-item-card">
                <TransactionItem
                  transaction={t}
                  showDate={true}
                  backInterceptRef={backInterceptRef}
                />
              </div>
            ))}
            {filteredList.length === 0 && (
              <div className="empty-state" style={{ padding: '40px 10px' }}>
                <div className="empty-icon">📈</div>
                <div className="empty-title">No transactions found</div>
                <div className="empty-desc">
                  No transactions match the current filters.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
