import React, { useState, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { normaliseDate } from '../../utils/format.js';
import * as XLSX from 'xlsx';
import '../Settings/Settings.css';

export default function DataImport({ onBack }) {
  const { state, importData, cancelImport } = useApp();
  const { importProgress } = state;
  const isImporting = importProgress !== null;

  const [result,   setResult]   = useState(null);
  const [error,    setError]    = useState(null);
  const [mode,     setMode]     = useState(null); // 'override'|'merge'
  const [pending,  setPending]  = useState(null);
  const fileRef = useRef(null);

  const pct = importProgress && importProgress.total > 0
    ? Math.min(100, Math.round((importProgress.processed / importProgress.total) * 100))
    : 0;

  const timeLeft = () => {
    if (!importProgress?.startTime || importProgress.processed < 10) return '';
    const elapsed = (Date.now() - importProgress.startTime) / 1000;
    const rate    = importProgress.processed / elapsed;
    const secs    = Math.ceil((importProgress.total - importProgress.processed) / rate);
    if (secs <= 0) return 'Almost done…';
    return secs < 60 ? `~${secs}s left` : `~${Math.ceil(secs/60)}m left`;
  };

  const parseFile = async (file) => {
    if (/\.json$/i.test(file.name)) {
      const text = await file.text();
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : (parsed.transactions || []);
    }
    const buf = await file.arrayBuffer();
    const wb  = XLSX.read(buf, { type:'array', cellDates:false, raw:true });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval:'', raw:true });
    return rows.map(r => ({
      Date:             normaliseDate(r.Date ?? r.date ?? ''),
      Account:          String(r.Account     ?? r.account     ?? '').trim(),
      FromAccount:      String(r.FromAccount ?? r.fromAccount ?? '').trim(),
      ToAccount:        String(r.ToAccount   ?? r.toAccount   ?? '').trim(),
      Category:         String(r.Category    ?? r.category    ?? '').trim(),
      Subcategory:      String(r.Subcategory ?? r.subcategory ?? '').trim(),
      Note:             String(r.Note        ?? r.note        ?? '').trim(),
      Description:      String(r.Description ?? r.description ?? '').trim(),
      INR:              parseFloat(r.INR     ?? r.Amount      ?? r.amount ?? 0),
      Amount:           String(r.Amount      ?? r.INR         ?? '0').trim(),
      Currency:         String(r.Currency    ?? 'INR').trim(),
      'Income/Expense': String(r['Income/Expense'] ?? r.type  ?? 'Expense').trim(),
      ID:               String(r.ID ?? r.id ?? '').trim(),
    })).filter(t => t.Date);
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (fileRef.current) fileRef.current.value = '';
    setError(null); setResult(null);

    try {
      const rows = await parseFile(file);
      if (!rows.length) { setError('No valid rows found.'); return; }
      setPending({ rows, fileName: file.name });
      if (state.transactions?.length > 0) setMode('choose');
      else startImport(rows, 'override');
    } catch(err) {
      setError('Failed to parse file: ' + err.message);
    }
  };

  const startImport = async (rows, importMode) => {
    setMode(null); setPending(null);
    setResult(null); setError(null);
    const res = await importData(rows, importMode);
    if (res.cancelled) setResult({ msg:`Cancelled — ${res.imported} rows saved.` });
    else setResult({ msg:`Import complete!`, imported: res.imported, skipped: res.skipped, total: rows.length });
  };

  const handleModeChoice = (m) => {
    if (pending) startImport(pending.rows, m);
  };

  return (
    <div className="sub-panel">
      <div className="sub-panel-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <div className="sub-panel-title">Import Data</div>
      </div>

      <div style={{ padding:'var(--space-4)' }}>
        {/* Upload zone */}
        <label className={`import-dropzone ${isImporting ? 'disabled' : ''}`}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.json"
            onChange={handleFileChange} disabled={isImporting} hidden />
          <div className="import-dropzone-icon">📁</div>
          <div className="import-dropzone-title">{isImporting ? 'Import in progress…' : 'Tap to select file'}</div>
          <div className="import-dropzone-sub">Excel (.xlsx/.xls), CSV, JSON · max 50MB</div>
          <div className="import-dropzone-sub" style={{ color:'var(--text-muted)', marginTop:4 }}>
            Same format as v1: Date, Account, Category, INR, Income/Expense…
          </div>
        </label>

        {/* Progress */}
        {isImporting && importProgress && (
          <div className="import-progress-card">
            <div className="import-progress-top">
              <span>Processing {importProgress.processed.toLocaleString()} / {importProgress.total.toLocaleString()} rows</span>
              <span style={{ color:'var(--text-muted)', fontSize:12 }}>{timeLeft()}</span>
            </div>
            <div className="progress-bar-track" style={{ marginTop:8 }}>
              <div className="progress-bar-fill" style={{ width:`${pct}%`, background:'var(--green)' }} />
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', marginTop:6, fontSize:11, color:'var(--text-muted)' }}>
              <span>{pct}%</span>
              <span>{(importProgress.total - importProgress.processed).toLocaleString()} remaining</span>
            </div>
            <button className="btn btn-danger btn-sm" style={{ marginTop:12, width:'100%' }} onClick={cancelImport}>
              ⏹ Cancel Import
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="import-message error">
            ⚠️ {error}
            <button onClick={() => setError(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'inherit', cursor:'pointer', fontSize:14 }}>✕</button>
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="import-message success">
            <div>✅ {result.msg}</div>
            {result.imported !== undefined && (
              <div style={{ fontSize:12, marginTop:4, color:'var(--text-secondary)' }}>
                {result.imported} imported · {result.skipped} skipped · {result.total} total
              </div>
            )}
            <button onClick={() => setResult(null)} style={{ marginLeft:'auto', alignSelf:'flex-start', background:'none', border:'none', color:'inherit', cursor:'pointer', fontSize:14 }}>✕</button>
          </div>
        )}

        {/* Instructions */}
        <div className="import-info-card">
          <div className="import-info-title">Supported Columns</div>
          <div className="import-info-body">
            Date, Account, FromAccount, ToAccount, Category, Subcategory, Note, Description, INR, Amount, Currency, Income/Expense, ID
          </div>
          <div className="import-info-title" style={{ marginTop:12 }}>Date Formats</div>
          <div className="import-info-body">DD/MM/YYYY · DD-MM-YYYY · Excel serial dates · YYYY-MM-DD</div>
          <div className="import-info-title" style={{ marginTop:12 }}>Income/Expense Values</div>
          <div className="import-info-body">Income · Expense · Transfer-Out</div>
        </div>

        <div style={{ height:32 }} />
      </div>

      {/* Mode selection sheet */}
      {mode === 'choose' && pending && (
        <>
          <div className="overlay" onClick={() => { setMode(null); setPending(null); }} />
          <div className="bottom-sheet" style={{ padding:'24px 20px 40px' }}>
            <div style={{ textAlign:'center', marginBottom:20 }}>
              <div style={{ fontSize:32, marginBottom:8 }}>📂</div>
              <div style={{ fontSize:18, fontWeight:800, color:'var(--text-primary)', marginBottom:6 }}>Import Mode</div>
              <div style={{ fontSize:13, color:'var(--text-muted)' }}>
                {pending.rows.length.toLocaleString()} rows from {pending.fileName}
              </div>
              <div style={{ fontSize:13, color:'var(--text-muted)', marginTop:4 }}>You already have {state.transactions.length.toLocaleString()} transactions.</div>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <button className="btn btn-primary btn-full" onClick={() => handleModeChoice('merge')}>
                Merge — Add new, skip duplicates
              </button>
              <button className="btn btn-danger btn-full" onClick={() => handleModeChoice('override')}>
                Override — Delete all & reimport
              </button>
              <button className="btn btn-ghost btn-full" onClick={() => { setMode(null); setPending(null); }}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
