import React, { useState, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseImportFile, exportToCSV, exportToJSON, downloadBlob } from '../../utils/importExport.js';
import './Settings.css';

export default function DataManager({ onBack }) {
  const { state, importTransactions, cancelImport, clearAllData, toast } = useApp();
  const { transactions, importProgress } = state;

  const [mode,        setMode]        = useState(null); // 'override'|'merge'
  const [pending,     setPending]     = useState(null);
  const [showConsent, setShowConsent] = useState(false);
  const [showDelete,  setShowDelete]  = useState(false);
  const [result,      setResult]      = useState(null);
  const fileRef = useRef();

  const isImporting = !!importProgress;
  const pct = importProgress
    ? Math.min(100, Math.round((importProgress.processed/importProgress.total)*100)) : 0;
  const elapsed = importProgress
    ? ((Date.now()-importProgress.startTime)/1000) : 0;
  const rate = importProgress && importProgress.processed > 0
    ? importProgress.processed / elapsed : 0;
  const eta = rate > 0 && importProgress
    ? Math.ceil((importProgress.total - importProgress.processed) / rate) : 0;
  const etaStr = eta > 60 ? `~${Math.ceil(eta/60)}m left` : eta > 0 ? `~${eta}s left` : '';

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    fileRef.current.value = '';
    if (transactions.length > 0) {
      setPending(file);
      setShowConsent(true);
    } else {
      await startImport(file, 'override');
    }
  };

  const handleConsent = async (m) => {
    setShowConsent(false);
    const file = pending; setPending(null);
    await startImport(file, m);
  };

  const startImport = async (file, m) => {
    setResult(null);
    try {
      const rows = await parseImportFile(file);
      if (!rows.length) { toast('No valid transactions found', 'error'); return; }
      const r = await importTransactions(rows, m);
      if (r.cancelled) {
        setResult({ type:'info', msg:`Cancelled — ${r.imported.toLocaleString()} rows saved` });
      } else {
        setResult({ type:'success', msg:`✓ Imported ${r.imported.toLocaleString()} rows${r.skipped?`, skipped ${r.skipped}`:''}`});
        toast(`Imported ${r.imported.toLocaleString()} transactions ✓`);
      }
    } catch (e) {
      setResult({ type:'error', msg: e.message || 'Import failed' });
      toast(e.message||'Import failed','error');
    }
  };

  const doExportCSV  = () => { downloadBlob(exportToCSV(transactions),  `finman_${today()}.csv`);  toast('Exported CSV ✓'); };
  const doExportJSON = () => { downloadBlob(exportToJSON(transactions), `finman_${today()}.json`); toast('Exported JSON ✓'); };

  const doDeleteAll = async () => {
    setShowDelete(false);
    await clearAllData();
    toast('All data deleted');
  };

  const today = () => new Date().toISOString().split('T')[0];

  return (
    <div className="subpage settings-screen">
      <div className="subpage-header">
        <button className="back-btn" onClick={onBack}><BackIcon /></button>
        <div className="subpage-title">Data Manager</div>
      </div>

      {/* Stats */}
      <div className="data-stats card" style={{margin:'0 16px 20px'}}>
        <div className="data-stat"><div className="data-stat-val">{transactions.length.toLocaleString()}</div><div className="data-stat-label">Transactions</div></div>
        <div className="data-stat-div" />
        <div className="data-stat"><div className="data-stat-val">{new Set(transactions.map(t=>t.Account)).size}</div><div className="data-stat-label">Accounts</div></div>
        <div className="data-stat-div" />
        <div className="data-stat"><div className="data-stat-val">{new Set(transactions.map(t=>t.Category)).size}</div><div className="data-stat-label">Categories</div></div>
      </div>

      {/* Import section */}
      <div className="settings-group-label" style={{padding:'0 20px',marginBottom:10}}>Import</div>
      <div className="card" style={{margin:'0 16px',padding:16}}>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.json"
          onChange={handleFileChange} style={{display:'none'}} disabled={isImporting} />

        <div className={`import-drop-zone ${isImporting?'importing':''}`}
          onClick={() => !isImporting && fileRef.current?.click()}>
          <div style={{fontSize:36}}>📂</div>
          <div style={{fontSize:15,fontWeight:700,color:'var(--text)',marginTop:8}}>
            {isImporting ? 'Importing…' : 'Choose File to Import'}
          </div>
          <div style={{fontSize:12,color:'var(--text3)',marginTop:4}}>
            Excel (.xlsx/.xls), CSV, JSON — up to 50MB
          </div>
        </div>

        {isImporting && importProgress && (
          <div className="import-progress-wrap">
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:6,fontSize:13}}>
              <span style={{color:'var(--text2)',fontWeight:600}}>
                {importProgress.processed.toLocaleString()} / {importProgress.total.toLocaleString()} rows
              </span>
              <span style={{color:'var(--text3)'}}>{etaStr}</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{width:`${pct}%`,background:'var(--green)'}} />
            </div>
            <div style={{display:'flex',justifyContent:'space-between',marginTop:6,fontSize:12,color:'var(--text3)'}}>
              <span>{pct}% complete</span>
              <span>{(importProgress.total-importProgress.processed).toLocaleString()} remaining</span>
            </div>
            <button className="btn btn-danger btn-full" style={{marginTop:12}} onClick={cancelImport}>
              ⏹ Cancel Import
            </button>
          </div>
        )}

        {result && (
          <div className={`import-result ${result.type}`}>
            {result.msg}
            <button style={{background:'none',border:'none',color:'inherit',cursor:'pointer',marginLeft:8}} onClick={() => setResult(null)}>×</button>
          </div>
        )}
      </div>

      <div style={{fontSize:12,color:'var(--text3)',padding:'8px 20px',lineHeight:1.7}}>
        <strong style={{color:'var(--text2)'}}>Supported columns:</strong> Date, Account, Category, Subcategory, Note, INR, Income/Expense, FromAccount, ToAccount, Currency, ID<br/>
        <strong style={{color:'var(--text2)'}}>Date formats:</strong> DD/MM/YYYY, YYYY-MM-DD, Excel serial numbers
      </div>

      {/* Export section */}
      <div className="settings-group-label" style={{padding:'12px 20px 10px'}}>Export</div>
      <div className="settings-list" style={{margin:'0 16px'}}>
        <div className="settings-row card-pressable" onClick={doExportCSV}>
          <div className="settings-row-icon">📄</div>
          <div className="settings-row-text">
            <div className="settings-row-title">Export as CSV</div>
            <div className="settings-row-sub">Import-compatible · {transactions.length.toLocaleString()} rows</div>
          </div>
          <DownloadIcon />
        </div>
        <div className="settings-row last card-pressable" onClick={doExportJSON}>
          <div className="settings-row-icon">🗂️</div>
          <div className="settings-row-text">
            <div className="settings-row-title">Export as JSON</div>
            <div className="settings-row-sub">Full backup with metadata</div>
          </div>
          <DownloadIcon />
        </div>
      </div>

      {/* Danger zone */}
      <div className="settings-group-label" style={{padding:'20px 20px 10px',color:'var(--red)'}}>Danger Zone</div>
      <div className="settings-list" style={{margin:'0 16px'}}>
        <div className="settings-row last card-pressable" onClick={() => setShowDelete(true)}>
          <div className="settings-row-icon" style={{background:'var(--red-dim)'}}>🗑️</div>
          <div className="settings-row-text">
            <div className="settings-row-title" style={{color:'var(--red)'}}>Delete All Transactions</div>
            <div className="settings-row-sub">This cannot be undone</div>
          </div>
        </div>
      </div>

      {/* Consent modal */}
      {showConsent && (
        <div className="sheet-overlay" onClick={() => { setShowConsent(false); setPending(null); }}>
          <div className="sheet-body" onClick={e=>e.stopPropagation()}>
            <div className="sheet-handle" />
            <div style={{fontSize:20,fontWeight:800,color:'var(--text)',marginBottom:8}}>Import Mode</div>
            <div style={{fontSize:14,color:'var(--text3)',marginBottom:20}}>
              You already have {transactions.length.toLocaleString()} transactions. How should we import?
            </div>
            <button className="btn btn-danger btn-full btn-lg" style={{marginBottom:10}} onClick={() => handleConsent('override')}>
              Override — replace all existing data
            </button>
            <button className="btn btn-primary btn-full btn-lg" style={{marginBottom:10}} onClick={() => handleConsent('merge')}>
              Merge — add new, skip duplicates
            </button>
            <button className="btn btn-ghost btn-full" onClick={() => { setShowConsent(false); setPending(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {showDelete && (
        <div className="sheet-overlay" onClick={() => setShowDelete(false)}>
          <div className="sheet-body" onClick={e=>e.stopPropagation()}>
            <div className="sheet-handle" />
            <div style={{fontSize:20,fontWeight:800,color:'var(--red)',marginBottom:8}}>⚠️ Delete All Data?</div>
            <div style={{fontSize:14,color:'var(--text3)',marginBottom:20}}>
              This will permanently delete all {transactions.length.toLocaleString()} transactions. This cannot be undone.
            </div>
            <button className="btn btn-danger btn-full btn-lg" style={{marginBottom:10}} onClick={doDeleteAll}>
              Yes, Delete Everything
            </button>
            <button className="btn btn-ghost btn-full" onClick={() => setShowDelete(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{height:20}}/>
    </div>
  );
}

const BackIcon     = () => <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>;
const DownloadIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>;
