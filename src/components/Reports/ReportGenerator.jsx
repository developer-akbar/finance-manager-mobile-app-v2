import React, { useState, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import {
  parseDate, formatDate, formatINR, formatINRCompact, calcTotals, txnType, txnAmount,
  getFY, fyLabel, fyStart, fyEnd, currentFY,
} from '../../utils/format.js';
import './ReportGenerator.css';

const PRESETS = [
  { id: 'cur_fy', label: 'Current FY' },
  { id: 'prev_fy', label: 'Previous FY' },
  { id: 'cur_year', label: 'This Year' },
  { id: 'last_30', label: 'Last 30 Days' },
  { id: 'last_90', label: 'Last 90 Days' },
  { id: 'all_time', label: 'All Time' },
  { id: 'custom', label: 'Custom' },
];

export default function ReportGenerator({ onBack }) {
  const { state } = useApp();
  const { transactions, accounts, categories } = state;

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // Default to Current Financial Year
  const [preset, setPreset] = useState('cur_fy');
  const [startDate, setStartDate] = useState(() => {
    const start = fyStart(currentFY());
    return start.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => {
    const end = fyEnd(currentFY());
    return end > now ? todayStr : end.toISOString().split('T')[0];
  });

  const [selType, setSelType] = useState('All'); // All, Expense, Income, Transfer
  const [selAccts, setSelAccts] = useState(new Set()); // empty = all
  const [selCats, setSelCats] = useState(new Set()); // empty = all
  const [selTag, setSelTag] = useState('All');
  const [activeTab, setActiveTab] = useState('summary'); // summary, transactions
  const [exporting, setExporting] = useState(false);

  // Available tags across transactions
  const allAvailableTags = useMemo(() => {
    const seen = new Set();
    for (const t of transactions) {
      if (t.Tags) {
        t.Tags.split(',').forEach(tag => {
          const clean = tag.trim().toLowerCase();
          if (clean) seen.add(clean.startsWith('#') ? clean : `#${clean}`);
        });
      }
      const matches = ((t.Note || '') + ' ' + (t.Description || '')).match(/#[a-zA-Z0-9_\u0900-\u097F-]+/g);
      if (matches) matches.forEach(m => seen.add(m.toLowerCase()));
    }
    return Array.from(seen).sort();
  }, [transactions]);

  // Handle preset selection
  const applyPreset = (p) => {
    setPreset(p);
    const today = new Date();
    if (p === 'cur_fy') {
      const s = fyStart(currentFY());
      const e = fyEnd(currentFY());
      setStartDate(s.toISOString().split('T')[0]);
      setEndDate(e > today ? todayStr : e.toISOString().split('T')[0]);
    } else if (p === 'prev_fy') {
      const s = fyStart(currentFY() - 1);
      const e = fyEnd(currentFY() - 1);
      setStartDate(s.toISOString().split('T')[0]);
      setEndDate(e.toISOString().split('T')[0]);
    } else if (p === 'cur_year') {
      setStartDate(`${today.getFullYear()}-01-01`);
      setEndDate(todayStr);
    } else if (p === 'last_30') {
      const d = new Date(today);
      d.setDate(d.getDate() - 30);
      setStartDate(d.toISOString().split('T')[0]);
      setEndDate(todayStr);
    } else if (p === 'last_90') {
      const d = new Date(today);
      d.setDate(d.getDate() - 90);
      setStartDate(d.toISOString().split('T')[0]);
      setEndDate(todayStr);
    } else if (p === 'all_time') {
      setStartDate('2000-01-01');
      setEndDate(todayStr);
    }
  };

  // Filtered dataset
  const filteredTxns = useMemo(() => {
    const sTime = startDate ? new Date(`${startDate}T00:00:00`).getTime() : 0;
    const eTime = endDate ? new Date(`${endDate}T23:59:59`).getTime() : Infinity;

    return transactions.filter(t => {
      const d = parseDate(t.Date).getTime();
      if (d < sTime || d > eTime) return false;

      const type = txnType(t);
      if (selType === 'Expense' && type !== 'expense') return false;
      if (selType === 'Income' && type !== 'income') return false;
      if (selType === 'Transfer' && !t['Income/Expense']?.startsWith('Transfer')) return false;

      if (selAccts.size > 0) {
        const acct = t.Account || t.FromAccount || '';
        const toAcct = t.ToAccount || '';
        if (!selAccts.has(acct) && !selAccts.has(toAcct)) return false;
      }

      if (selCats.size > 0) {
        const cat = t.Category || '';
        if (!selCats.has(cat)) return false;
      }

      if (selTag !== 'All') {
        const hasTag = (t.Tags || '').toLowerCase().includes(selTag.toLowerCase()) ||
          ((t.Note || '') + ' ' + (t.Description || '')).toLowerCase().includes(selTag.toLowerCase());
        if (!hasTag) return false;
      }

      return true;
    });
  }, [transactions, startDate, endDate, selType, selAccts, selCats, selTag]);

  const totals = useMemo(() => calcTotals(filteredTxns), [filteredTxns]);

  // Category breakdown for filtered transactions
  const categoryBreakdown = useMemo(() => {
    const map = {};
    for (const t of filteredTxns) {
      if (txnType(t) !== 'expense') continue;
      const cat = t.Category || 'Other';
      map[cat] = (map[cat] || 0) + txnAmount(t);
    }
    return Object.entries(map)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [filteredTxns]);

  const totalExpense = totals.expense || 1;

  // File save utility
  const saveReportFile = async (content, filename, mimeType, isBase64 = false) => {
    const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform?.());
    if (isNative) {
      try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        await Filesystem.writeFile({
          path: filename,
          data: isBase64 ? content : btoa(unescape(encodeURIComponent(content))),
          directory: Directory.Documents,
          recursive: true,
        });
        alert(`Report saved to Documents/${filename}\n\nCheck your Files app → Documents.`);
        return;
      } catch (err) {
        console.error('Capacitor report save failed:', err);
      }
    }
    // Browser fallback
    const blob = isBase64
      ? new Blob([Uint8Array.from(atob(content), c => c.charCodeAt(0))], { type: mimeType })
      : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 1000);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  // Export to Excel (.xlsx)
  const handleExportExcel = async () => {
    setExporting(true);
    try {
      const XLSX = await import('xlsx');

      // Sheet 1: Summary
      const summaryData = [
        ['FinMan Financial Statement & Report'],
        ['Generated On', new Date().toLocaleString('en-IN')],
        ['Period', `${startDate} to ${endDate}`],
        ['Type Filter', selType],
        ['Tag Filter', selTag],
        [],
        ['--- KEY TOTALS ---', 'AMOUNT (INR)'],
        ['Total Income', totals.income],
        ['Total Expenses', totals.expense],
        ['Net Savings', totals.balance],
        ['Total Transfers', totals.transfer],
        ['Total Transactions', filteredTxns.length],
        [],
        ['--- CATEGORY BREAKDOWN (EXPENSES) ---', 'AMOUNT (INR)', 'PERCENTAGE'],
        ...categoryBreakdown.map(c => [
          c.name,
          c.amount,
          `${((c.amount / totalExpense) * 100).toFixed(1)}%`
        ]),
      ];
      const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);

      // Sheet 2: Transactions
      const headers = ['Date', 'Time', 'Type', 'Account', 'FromAccount', 'ToAccount', 'Category', 'Subcategory', 'Note', 'Description', 'Tags', 'Amount', 'Currency'];
      const txnRows = filteredTxns.map(t => [
        t.Date,
        t.Time || '',
        t['Income/Expense'] || 'Expense',
        t.Account || '',
        t.FromAccount || '',
        t.ToAccount || '',
        t.Category || '',
        t.Subcategory && t.Subcategory !== 'Default' ? t.Subcategory : '',
        t.Note || '',
        t.Description || '',
        t.Tags || '',
        parseFloat(t.INR || t.Amount || 0),
        t.Currency || 'INR',
      ]);
      const wsTxns = XLSX.utils.aoa_to_sheet([headers, ...txnRows]);

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsSummary, 'Report Summary');
      XLSX.utils.book_append_sheet(wb, wsTxns, 'Transactions');

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const filename = `FinMan_Report_${startDate}_to_${endDate}.xlsx`;
      await saveReportFile(wbout, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true);
    } catch (err) {
      alert(`Export error: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  // Export to CSV
  const handleExportCSV = async () => {
    setExporting(true);
    try {
      const hdrs = ['Date', 'Time', 'Type', 'Account', 'FromAccount', 'ToAccount', 'Category', 'Subcategory', 'Note', 'Description', 'Tags', 'INR', 'Currency'];
      const esc = v => { const s = String(v ?? ''); return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const rows = [
        hdrs.join(','),
        ...filteredTxns.map(t => [
          esc(t.Date),
          esc(t.Time || ''),
          esc(t['Income/Expense'] || 'Expense'),
          esc(t.Account || ''),
          esc(t.FromAccount || ''),
          esc(t.ToAccount || ''),
          esc(t.Category || ''),
          esc(t.Subcategory && t.Subcategory !== 'Default' ? t.Subcategory : ''),
          esc(t.Note || ''),
          esc(t.Description || ''),
          esc(t.Tags || ''),
          t.INR || t.Amount || 0,
          esc(t.Currency || 'INR'),
        ].join(','))
      ];
      const filename = `FinMan_Transactions_${startDate}_to_${endDate}.csv`;
      await saveReportFile('\ufeff' + rows.join('\n'), filename, 'text/csv;charset=utf-8;');
    } catch (err) {
      alert(`CSV Export error: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="report-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="page-hdr-title">Reports & Export</div>
      </div>

      <div className="report-body">
        {/* Preset Selector */}
        <div className="report-preset-row">
          {PRESETS.map(p => (
            <button
              key={p.id}
              className={`report-preset-btn ${preset === p.id ? 'active' : ''}`}
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Date Range & Filter Card */}
        <div className="report-filter-card">
          <div className="report-date-row">
            <div className="report-date-field">
              <label>From Date</label>
              <input
                type="date"
                className="report-date-input"
                value={startDate}
                onChange={e => { setPreset('custom'); setStartDate(e.target.value); }}
              />
            </div>
            <div className="report-date-field">
              <label>To Date</label>
              <input
                type="date"
                className="report-date-input"
                value={endDate}
                onChange={e => { setPreset('custom'); setEndDate(e.target.value); }}
              />
            </div>
          </div>

          {/* Type Filter & Tag Filter */}
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Type</label>
              <select
                className="report-date-input"
                value={selType}
                onChange={e => setSelType(e.target.value)}
              >
                <option value="All">All Types</option>
                <option value="Expense">Expenses Only</option>
                <option value="Income">Income Only</option>
                <option value="Transfer">Transfers Only</option>
              </select>
            </div>

            {allAvailableTags.length > 0 && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Tag</label>
                <select
                  className="report-date-input"
                  value={selTag}
                  onChange={e => setSelTag(e.target.value)}
                >
                  <option value="All">All Tags</option>
                  {allAvailableTags.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Export Buttons Bar */}
        <div className="report-export-bar">
          <button
            className="report-export-btn excel"
            onClick={handleExportExcel}
            disabled={exporting || filteredTxns.length === 0}
          >
            📊 {exporting ? 'Generating…' : 'Export Excel (.xlsx)'}
          </button>
          <button
            className="report-export-btn csv"
            onClick={handleExportCSV}
            disabled={exporting || filteredTxns.length === 0}
          >
            📄 Export CSV
          </button>
        </div>

        {/* Metrics Grid */}
        <div className="report-metrics-grid">
          <div className="report-metric-box income">
            <div className="report-metric-l">Total Income</div>
            <div className="report-metric-v" style={{ color: 'var(--income)' }}>{formatINR(totals.income)}</div>
          </div>
          <div className="report-metric-box expense">
            <div className="report-metric-l">Total Expense</div>
            <div className="report-metric-v" style={{ color: 'var(--expense)' }}>{formatINR(totals.expense)}</div>
          </div>
          <div className="report-metric-box savings">
            <div className="report-metric-l">Net Savings</div>
            <div className="report-metric-v" style={{ color: totals.balance >= 0 ? 'var(--income)' : 'var(--expense)' }}>
              {totals.balance >= 0 ? '+' : ''}{formatINR(totals.balance)}
            </div>
          </div>
          <div className="report-metric-box count">
            <div className="report-metric-l">Transactions</div>
            <div className="report-metric-v">{filteredTxns.length.toLocaleString()}</div>
          </div>
        </div>

        {/* View Tabs */}
        <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
          <button
            className={`report-preset-btn ${activeTab === 'summary' ? 'active' : ''}`}
            onClick={() => setActiveTab('summary')}
          >
            Category Summary
          </button>
          <button
            className={`report-preset-btn ${activeTab === 'transactions' ? 'active' : ''}`}
            onClick={() => setActiveTab('transactions')}
          >
            Transactions ({filteredTxns.length})
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'summary' ? (
          <div className="report-filter-card">
            <div style={{ fontSize: '0.85rem', fontWeight: 800, marginBottom: 8 }}>Top Spending Categories</div>
            {categoryBreakdown.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16, fontSize: '0.8rem' }}>No expense transactions in this date range.</div>
            ) : (
              categoryBreakdown.slice(0, 15).map((c, i) => {
                const pct = Math.round((c.amount / totalExpense) * 100);
                return (
                  <div key={c.name} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                      <span style={{ fontWeight: 600 }}>{i + 1}. {c.name}</span>
                      <span style={{ fontWeight: 700 }}>{formatINR(c.amount)} <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>({pct}%)</span></span>
                    </div>
                    <div style={{ height: 4, background: 'var(--bg-input)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="report-filter-card" style={{ padding: 8 }}>
            {filteredTxns.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: '0.82rem' }}>No transactions match the selected filters.</div>
            ) : (
              filteredTxns.slice(0, 50).map(t => (
                <div key={t._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: '0.82rem', fontWeight: 700 }}>{t.Note || t.Category}</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t.Date} • {t.Account || t.FromAccount}</span>
                  </div>
                  <span style={{ fontSize: '0.85rem', fontWeight: 800, color: t['Income/Expense'] === 'Income' ? 'var(--income)' : t['Income/Expense']?.startsWith('Transfer') ? 'var(--transfer)' : 'var(--expense)' }}>
                    {t['Income/Expense'] === 'Income' ? '+' : '−'}{formatINR(t.INR || t.Amount)}
                  </span>
                </div>
              ))
            )}
            {filteredTxns.length > 50 && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.75rem', padding: 8 }}>
                Showing first 50 of {filteredTxns.length} records. Use Excel export to view full dataset.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
