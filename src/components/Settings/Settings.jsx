import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, parseDate } from '../../utils/format.js';
import ReportGenerator from '../Reports/ReportGenerator.jsx';
import WarrantyLocker from '../Accounts/WarrantyLocker.jsx';
import GroupSplitManager from '../Groups/GroupSplitManager.jsx';
import { encryptBackupData, decryptBackupData } from '../../utils/cryptoBackup.js';
import { getDB } from '../../database/db.js';
import './Settings.css';

// ─────────────────────────────────────────────
// Confirm Modal — native bottom-sheet alternative
// ─────────────────────────────────────────────
function ConfirmModal({ isOpen, title, message, onConfirm, onCancel, isWarning = false }) {
  if (!isOpen) return null;
  return (
    <>
      <div className="dash-popup-overlay" onClick={onCancel} style={{ zIndex: 10000 }} />
      <div className="dash-popup-sheet" style={{ zIndex: 10001, padding: '20px 24px calc(var(--safe-bottom) + 20px)' }}>
        <div className="dash-popup-sheet-handle" />
        <div style={{ fontSize: '2.5rem', marginBottom: 12, textAlign: 'center' }}>{isWarning ? '⚠️' : '❓'}</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8, textAlign: 'center' }}>
          {title}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 20, textAlign: 'center' }}>
          {message.split('\n').map((line, idx) => <div key={idx}>{line}</div>)}
        </div>
        <div style={{ display: 'flex', gap: 12, width: '100%' }}>
          {onConfirm ? (
            <>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onCancel}>
                Cancel
              </button>
              <button className={isWarning ? "btn btn-danger" : "btn btn-primary"} style={{ flex: 1 }} onClick={onConfirm}>
                Yes, Delete
              </button>
            </>
          ) : (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={onCancel}>
              Got it
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// Kanban drag-drop with intra-column reordering
// ─────────────────────────────────────────────
function Kanban({ columns, items, getItemGroup, getItemLabel, onMove, onReorder, unassignedLabel = 'Ungrouped' }) {
  const [dragging, setDragging] = useState(null);
  const [overCol, setOverCol] = useState(null);
  const [overItem, setOverItem] = useState(null);
  const [localItems, setLocalItems] = useState(items);

  React.useEffect(() => { if (!dragging) setLocalItems(items); }, [items, dragging]);

  const grouped = useMemo(() => {
    const map = {};
    for (const col of [...columns, '__unassigned']) map[col] = [];
    for (const item of localItems) {
      const grp = getItemGroup(item);
      const col = columns.includes(grp) ? grp : '__unassigned';
      map[col].push(item);
    }
    return map;
  }, [columns, localItems, getItemGroup]);

  const allCols = [...columns, '__unassigned'];

  const handleDrop = (toCol) => {
    if (!dragging) return;
    const realTo = toCol === '__unassigned' ? '' : toCol;
    const realFrom = dragging.fromCol === '__unassigned' ? '' : dragging.fromCol;

    if (realFrom !== realTo) {
      // Move to different group
      const upd = localItems.map(it =>
        getItemLabel(it) === getItemLabel(dragging.item) ? { ...it, group: realTo } : it
      );
      setLocalItems(upd);
      onMove(dragging.item, realTo);
    } else if (overItem && getItemLabel(overItem) !== getItemLabel(dragging.item)) {
      // Reorder within same column
      const colItems = [...(grouped[toCol] || [])];
      const fi = colItems.findIndex(it => getItemLabel(it) === getItemLabel(dragging.item));
      const ti = colItems.findIndex(it => getItemLabel(it) === getItemLabel(overItem));
      if (fi !== -1 && ti !== -1) {
        const [moved] = colItems.splice(fi, 1);
        colItems.splice(ti, 0, moved);
        const others = localItems.filter(it => {
          const g = getItemGroup(it);
          return (columns.includes(g) ? g : '__unassigned') !== toCol;
        });
        const newList = [...others, ...colItems];
        setLocalItems(newList);
        onReorder?.(newList);
      }
    }
    setDragging(null); setOverCol(null); setOverItem(null);
  };

  return (
    <div className="kanban-board">
      {allCols.map(col => (
        <div key={col}
          className={`kanban-col ${overCol === col ? 'kanban-drop-active' : ''}`}
          onDragOver={e => { e.preventDefault(); setOverCol(col); }}
          onDragLeave={() => setOverCol(null)}
          onDrop={() => handleDrop(col)}
        >
          <div className="kanban-col-header">{col === '__unassigned' ? unassignedLabel : col}</div>
          <div className="kanban-col-items">
            {(grouped[col] || []).map(item => (
              <div key={getItemLabel(item)}
                className={`kanban-card ${dragging?.item === item ? 'dragging' : ''} ${overItem === item && dragging?.fromCol === col ? 'kanban-over-item' : ''}`}
                draggable
                onDragStart={() => setDragging({ item, fromCol: col })}
                onDragEnd={() => { setDragging(null); setOverCol(null); setOverItem(null); }}
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); setOverItem(item); }}
              >
                <span style={{ fontSize: '0.7rem', marginRight: 2, opacity: 0.5 }}>⠿</span>
                {getItemLabel(item)}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
// ─────────────────────────────────────────────
// Accounts Manager
// ─────────────────────────────────────────────
export function AccountsManager({ onBack }) {
  const { state, updateSettings, renameAccount, deleteAccountTransactions } = useApp();
  const [accounts, setAccounts] = useState(() => (state.accounts || []).map(a => typeof a === 'string' ? { name: a, group: '', icon: '💳', acctType: '', settlementDate: 0, paymentDueDays: 0, cardLast4: '' } : { ...a, cardLast4: a.cardLast4 || a.card_last4 || '' }));
  const [groups, setGroups] = useState(() => state.accountGroups || []);
  const [newAcct, setNewAcct] = useState('');
  const [newGrp, setNewGrp] = useState('');
  const [editingAcct, setEditingAcct] = useState(null);
  const [editName, setEditName] = useState('');
  const [editGrp, setEditGrp] = useState('');
  const [editAcctType, setEditAcctType] = useState('');
  const [editSettleDay, setEditSettleDay] = useState('');
  const [editPayDays, setEditPayDays] = useState('');
  const [editCardLast4, setEditCardLast4] = useState('');
  const [editErrors, setEditErrors] = useState({});
  const [tabMode, setTabMode] = useState('list'); // 'list' | 'kanban'
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [confirmState, setConfirmState] = useState(null);
  const [editGrpIdx, setEditGrpIdx] = useState(null);  // index of group being renamed
  const [editGrpName, setEditGrpName] = useState('');
  const dragIdx = useRef(null);
  const grpDragIdx = useRef(null);

  // Sync when state.accounts updates
  useEffect(() => {
    if (state.accounts) {
      setAccounts(state.accounts.map(a => typeof a === 'string' ? { name: a, group: '', icon: '💳', acctType: '', settlementDate: 0, paymentDueDays: 0, cardLast4: '' } : { ...a, cardLast4: a.cardLast4 || a.card_last4 || '' }));
    }
  }, [state.accounts]);

  const uniqueGroups = useMemo(() => [...new Set(groups)], [groups]);
  const uniqueAccounts = useMemo(() => {
    const seen = new Set();
    return accounts.filter(acc => {
      const duplicate = seen.has(acc.name);
      seen.add(acc.name);
      return !duplicate;
    });
  }, [accounts]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2200); };

  const save = async (accts = accounts, grps = groups) => {
    setSaving(true);
    try { await updateSettings({ accounts: accts, accountGroups: grps }); showToast('Saved ✓'); }
    finally { setSaving(false); }
  };

  const addGroup = () => {
    const t = newGrp.trim();
    if (!t || groups.includes(t)) return;
    const g = [...groups, t]; setGroups(g); setNewGrp(''); save(accounts, g);
  };

  const removeGroup = (g) => {
    const groupAccounts = accounts.filter(a => a.group === g);
    const count = groupAccounts.length;
    if (count > 0) {
      setConfirmState({
        title: 'Delete Account Group?',
        message: `Group "${g}" contains ${count} account(s).\n\nDeleting it will move these accounts to the "Ungrouped" section. Do you want to proceed?`,
        isWarning: true,
        onConfirm: async () => {
          setConfirmState(null);
          const upd = accounts.map(a => a.group === g ? { ...a, group: '' } : a);
          const grps = groups.filter(x => x !== g);
          setAccounts(upd);
          setGroups(grps);
          await save(upd, grps);
        }
      });
    } else {
      setConfirmState({
        title: 'Delete Account Group?',
        message: `Are you sure you want to delete the group "${g}"?`,
        isWarning: false,
        onConfirm: async () => {
          setConfirmState(null);
          const grps = groups.filter(x => x !== g);
          setGroups(grps);
          await save(accounts, grps);
        }
      });
    }
  };

  // Rename group
  const startEditGrp = (i) => { setEditGrpIdx(i); setEditGrpName(groups[i]); };
  const saveEditGrp = () => {
    const newName = editGrpName.trim();
    if (!newName || newName === groups[editGrpIdx]) { setEditGrpIdx(null); return; }
    const old = groups[editGrpIdx];
    const grps = groups.map((g, i) => i === editGrpIdx ? newName : g);
    const accts = accounts.map(a => a.group === old ? { ...a, group: newName } : a);
    setGroups(grps); setAccounts(accts); setEditGrpIdx(null);
    save(accts, grps);
  };

  // Group drag reorder
  const onGrpDragStart = (i) => { grpDragIdx.current = i; };
  const onGrpDragOver = (e, i) => {
    e.preventDefault();
    if (grpDragIdx.current === null || grpDragIdx.current === i) return;
    const upd = [...groups];
    const [moved] = upd.splice(grpDragIdx.current, 1);
    upd.splice(i, 0, moved);
    grpDragIdx.current = i;
    setGroups(upd);
  };
  const onGrpDragEnd = () => { grpDragIdx.current = null; save(accounts, groups); };

  const addAccount = () => {
    const t = newAcct.trim();
    if (!t || accounts.some(a => a.name === t)) return;
    const upd = [...accounts, { name: t, group: '', icon: '💳', acctType: '', settlementDate: 0, paymentDueDays: 0 }];
    setAccounts(upd); setNewAcct(''); save(upd);
  };

  const removeAccount = (name) => {
    if (name === 'Ungrouped') {
      setConfirmState({
        title: 'Cannot Delete Account',
        message: 'The "Ungrouped" account is a fallback system account and cannot be deleted.',
        isWarning: true
      });
      return;
    }
    const count = (state.transactions || []).filter(t => t.Account === name || t.FromAccount === name || t.ToAccount === name).length;
    if (count > 0) {
      setConfirmState({
        title: 'Move to Ungrouped?',
        message: `Account "${name}" has ${count} associated transaction(s).\n\nIt cannot be deleted permanently. Clicking delete will remove it from its current group and move it to the "Ungrouped" accounts section. Do you want to proceed?`,
        isWarning: true,
        onConfirm: async () => {
          setConfirmState(null);
          const upd = accounts.map(a => a.name === name ? { ...a, group: '' } : a);
          setAccounts(upd);
          await save(upd);
        }
      });
    } else {
      setConfirmState({
        title: 'Delete Account?',
        message: `Are you sure you want to delete the account "${name}"?`,
        isWarning: false,
        onConfirm: async () => {
          setConfirmState(null);
          const upd = accounts.filter(a => a.name !== name);
          setAccounts(upd);
          await save(upd);
        }
      });
    }
  };

  // Only suggest CC if name contains 'credit' — never trigger on 'card', 'cc' alone
  const looksLikeCC = (name) => /\bcredit\b/i.test(name);

  const startEdit = (a) => {
    if (!a) return;
    const hasExplicitType = a.acctType !== undefined && a.acctType !== null;
    const inferredType = hasExplicitType ? a.acctType : (looksLikeCC(a.name) ? 'Credit Card' : '');
    setEditingAcct(a.name);
    setEditName(a.name);
    setEditGrp(a.group || '');
    setEditAcctType(inferredType);
    setEditSettleDay(a.settlementDate ? String(a.settlementDate) : '');
    setEditPayDays(a.paymentDueDays ? String(a.paymentDueDays) : '');
    setEditCardLast4(a.cardLast4 || a.card_last4 || '');
    setEditErrors({});
  };

  const saveEdit = async () => {
    if (!editName.trim() || !editingAcct) return;
    const errs = {};
    const isCC = editAcctType === 'Credit Card';
    if (isCC) {
      const sd = parseInt(editSettleDay, 10);
      const pd = parseInt(editPayDays, 10);
      if (!editSettleDay || isNaN(sd) || sd < 1 || sd > 28)
        errs.settlementDate = 'Enter a day between 1 and 28';
      if (!editPayDays || isNaN(pd) || pd < 1 || pd > 30)
        errs.paymentDueDays = 'Enter days between 1 and 30';
    }
    if (Object.keys(errs).length) { setEditErrors(errs); return; }
    setEditErrors({});
    const oldName = editingAcct;

    const rawDigits = (editCardLast4 || '').replace(/\D/g, '');
    const cleanLast4 = rawDigits.length >= 4 ? rawDigits.slice(-4) : rawDigits;

    const upd = accounts.map(a => a.name === oldName ? {
      ...a,
      name: editName.trim(),
      group: editGrp,
      acctType: isCC ? 'Credit Card' : '',
      settlementDate: isCC ? parseInt(editSettleDay, 10) : 0,
      paymentDueDays: isCC ? parseInt(editPayDays, 10) : 0,
      cardLast4: cleanLast4,
    } : a);
    setAccounts(upd);
    setEditingAcct(null);
    if (oldName !== editName.trim()) await renameAccount(oldName, editName.trim());
    await save(upd);
  };

  // Account drag reorder
  const onDragStart = (i) => { dragIdx.current = i; };
  const onDragOver = (e, i) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === i) return;
    const upd = [...accounts];
    const [moved] = upd.splice(dragIdx.current, 1);
    upd.splice(i, 0, moved);
    dragIdx.current = i;
    setAccounts(upd);
  };
  const onDragEnd = () => { dragIdx.current = null; save(); };

  // Kanban: move account to a different group
  const handleKanbanMove = (item, newGroup) => {
    const upd = accounts.map(a => a.name === item.name ? { ...a, group: newGroup } : a);
    setAccounts(upd); save(upd);
  };

  // Kanban: reorder accounts within same column
  const handleKanbanReorder = (newList) => {
    setAccounts(newList); save(newList);
  };

  return (
    <div className="sub-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="page-hdr-title">Accounts</div>
        {saving && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 8 }}>Saving…</span>}
        {toast && <span style={{ fontSize: '0.7rem', color: 'var(--green)', marginLeft: 8 }}>{toast}</span>}
      </div>

      <div className="sub-body">
        {/* Groups section */}
        <div className="mgr-section-label">Account Groups</div>
        <div style={{ display: 'flex', gap: 8, padding: '0 var(--page-px) 8px' }}>
          <input className="form-input" style={{ flex: 1 }} placeholder="New group name" value={newGrp} onChange={e => setNewGrp(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGroup()} spellCheck="true" autoCapitalize="sentences" />
          <button className="btn btn-primary btn-sm" onClick={addGroup}>Add</button>
        </div>
        {uniqueGroups.length > 0 && (
          <div className="mgr-list">
            {uniqueGroups.map((g, gi) => (
              <div key={g}>
                <div className="mgr-list-row"
                  draggable
                  onDragStart={() => onGrpDragStart(gi)}
                  onDragOver={e => onGrpDragOver(e, gi)}
                  onDragEnd={onGrpDragEnd}
                >
                  <span className="mgr-drag-handle">⠿</span>
                  <span style={{ fontSize: '1rem', marginRight: 4 }}>📁</span>
                  <div className="mgr-list-name" style={{ flex: 1 }}>{g}</div>
                  <button className="mgr-edit-btn" onClick={() => editGrpIdx === gi ? setEditGrpIdx(null) : startEditGrp(gi)}>✏️</button>
                  <button className="mgr-del-btn" onClick={() => removeGroup(g)}>✕</button>
                </div>
                {editGrpIdx === gi && (
                  <div className="mgr-edit-panel">
                    <div className="mgr-edit-label">Rename Group</div>
                    <input className="form-input" value={editGrpName} onChange={e => setEditGrpName(e.target.value)} style={{ marginBottom: 8 }} spellCheck="true" autoCapitalize="sentences" />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditGrpIdx(null)}>Cancel</button>
                      <button className="btn btn-primary btn-sm" onClick={saveEditGrp}>Save</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Accounts section with List/Kanban tabs */}
        <div className="mgr-section-label">All Accounts ({uniqueAccounts.length})
          <span style={{ float: 'right', fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: '0.65rem', opacity: 0.6 }}>⠿ drag to set picker order</span>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '0 var(--page-px) 8px' }}>
          <input className="form-input" style={{ flex: 1 }} placeholder="Account name" value={newAcct} onChange={e => setNewAcct(e.target.value)} onKeyDown={e => e.key === 'Enter' && addAccount()} spellCheck="true" autoCapitalize="sentences" />
          <button className="btn btn-primary btn-sm" onClick={addAccount}>Add</button>
        </div>

        {/* Tab toggle */}
        <div className="mgr-tabs" style={{ padding: '0 var(--page-px) 8px', display: 'flex', gap: 6 }}>
          <button className={`mgr-tab-btn ${tabMode === 'list' ? 'active' : ''}`} onClick={() => setTabMode('list')}>List</button>
          <button className={`mgr-tab-btn ${tabMode === 'kanban' ? 'active' : ''}`} onClick={() => setTabMode('kanban')}>Board</button>
        </div>

        {tabMode === 'kanban' ? (
          <AccountKanbanBoard
            accounts={accounts}
            groups={groups}
            onMove={handleKanbanMove}
            onReorder={handleKanbanReorder}
            onAddGroup={() => {
              const name = window.prompt('New group name:');
              if (name && name.trim() && !groups.includes(name.trim())) {
                const g = [...groups, name.trim()];
                setGroups(g);
                save(accounts, g);
              }
            }}
          />
        ) : (() => {
          // Build grouped sections preserving flat indices for drag/edit/delete
          const sections = [];
          uniqueGroups.forEach(grp => {
            const items = uniqueAccounts.map((a, i) => ({ a, i })).filter(({ a }) => (a.group || '') === grp);
            if (items.length) sections.push({ label: grp, icon: '📁', items });
          });
          const ungrouped = uniqueAccounts.map((a, i) => ({ a, i })).filter(({ a }) => !a.group || !uniqueGroups.includes(a.group));
          if (ungrouped.length) sections.push({ label: 'Ungrouped', icon: '📋', items: ungrouped, muted: true });

          const renderEditPanel = (i) => (
            <div className="mgr-edit-panel">
              <div style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Edit Account
              </div>

              {/* Name */}
              <div className="mgr-edit-field">
                <label className="mgr-edit-field-label">Account Name</label>
                <input
                  className="form-input"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  spellCheck="true"
                  autoCapitalize="sentences"
                  placeholder="e.g. HDFC Credit, Amazon Pay ICICI"
                />
                <div className="mgr-edit-field-warn">⚠ Renaming updates all associated transactions</div>
              </div>

              {/* Group & Type in 2 columns */}
              <div className="mgr-edit-grid-2">
                <div className="mgr-edit-field">
                  <label className="mgr-edit-field-label">Group</label>
                  <select className="form-input" value={editGrp} onChange={e => setEditGrp(e.target.value)}>
                    <option value="">No group</option>
                    {uniqueGroups.map(g => <option key={g}>{g}</option>)}
                  </select>
                </div>
                <div className="mgr-edit-field">
                  <label className="mgr-edit-field-label">Account Type</label>
                  <select className="form-input" value={editAcctType} onChange={e => { setEditAcctType(e.target.value); setEditErrors({}); }}>
                    <option value="">Regular</option>
                    <option value="Credit Card">💳 Credit Card</option>
                  </select>
                </div>
              </div>

              {/* Credit Card Settings */}
              {editAcctType === 'Credit Card' && (
                <div className="cc-config-panel" style={{ margin: '4px 0 0' }}>
                  <div className="cc-config-title">💳 Credit Card Settings</div>
                  <div className="mgr-edit-grid-2">
                    <div className="mgr-edit-field">
                      <label className="mgr-edit-field-label">
                        Statement Date <span className="form-label-hint">(day bill closes)</span>
                      </label>
                      <input
                        className={`form-input${editErrors.settlementDate ? ' input-error' : ''}`}
                        type="number" inputMode="numeric" min="1" max="28"
                        placeholder="e.g. 18"
                        value={editSettleDay}
                        onChange={e => { setEditSettleDay(e.target.value); setEditErrors(p => ({ ...p, settlementDate: '' })); }}
                      />
                      {editErrors.settlementDate && <div className="form-error">{editErrors.settlementDate}</div>}
                      {editSettleDay && !editErrors.settlementDate && (() => {
                        const sd = parseInt(editSettleDay, 10);
                        if (sd >= 1 && sd <= 28) {
                          const now = new Date(), cy = now.getFullYear(), cm = now.getMonth(), cd = now.getDate();
                          let cycleStart, cycleEnd;
                          if (cd >= sd) { cycleStart = new Date(cy, cm, sd); cycleEnd = new Date(cy, cm + 1, sd - 1); }
                          else { cycleStart = new Date(cy, cm - 1, sd); cycleEnd = new Date(cy, cm, sd - 1); }
                          const fmt = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
                          return <div className="mgr-edit-field-hint">Billing: <strong>{fmt(cycleStart)} – {fmt(cycleEnd)}</strong></div>;
                        }
                        return null;
                      })()}
                    </div>

                    <div className="mgr-edit-field">
                      <label className="mgr-edit-field-label">
                        Payment Due Days <span className="form-label-hint">(after statement)</span>
                      </label>
                      <input
                        className={`form-input${editErrors.paymentDueDays ? ' input-error' : ''}`}
                        type="number" inputMode="numeric" min="1" max="30"
                        placeholder="e.g. 19"
                        value={editPayDays}
                        onChange={e => { setEditPayDays(e.target.value); setEditErrors(p => ({ ...p, paymentDueDays: '' })); }}
                      />
                      {editErrors.paymentDueDays && <div className="form-error">{editErrors.paymentDueDays}</div>}
                      {editSettleDay && editPayDays && !editErrors.settlementDate && !editErrors.paymentDueDays && (() => {
                        const sd = parseInt(editSettleDay, 10), pd = parseInt(editPayDays, 10);
                        if (sd >= 1 && sd <= 28 && pd >= 1 && pd <= 30) {
                          const now = new Date(), cy = now.getFullYear(), cm = now.getMonth(), cd = now.getDate();
                          let stmtDate;
                          if (cd >= sd) stmtDate = new Date(cy, cm, sd); else stmtDate = new Date(cy, cm - 1, sd);
                          const dueDate = new Date(stmtDate); dueDate.setDate(dueDate.getDate() + pd);
                          return <div className="mgr-edit-field-hint">Due: <strong>{dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</strong></div>;
                        }
                        return null;
                      })()}
                    </div>
                  </div>
                </div>
              )}

              {/* Card / Account Last 4 Digits */}
              <div className="mgr-edit-field">
                <label className="mgr-edit-field-label">
                  Card / Account Last 4 Digits
                </label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="e.g. 9009"
                  maxLength={19}
                  value={editCardLast4}
                  onChange={e => setEditCardLast4(e.target.value)}
                />
                <div className="mgr-edit-field-hint" style={{ marginTop: 2 }}>
                  {editCardLast4 && (
                    <span style={{ color: 'var(--accent)', fontWeight: 700, marginRight: 6 }}>
                      Masked preview: •••• {(editCardLast4.replace(/\D/g, '').slice(-4)) || editCardLast4} ·
                    </span>
                  )}
                  Helps auto-identify this account when parsing SMS or UPI alerts.
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setEditingAcct(null)}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={saveEdit}>Save</button>
              </div>
            </div>
          );

          return (
            <div className="mgr-list">
              {uniqueAccounts.length === 0 && <div className="mgr-empty">No accounts yet</div>}
              {sections.map(({ label, icon, items, muted }) => (
                <div key={label}>
                  <div className="mgr-acct-group-header" style={muted ? { opacity: 0.55 } : {}}>
                    <span>{icon} {label}</span>
                    <span className="mgr-acct-group-count">{items.length}</span>
                  </div>
                  {items.map(({ a, i }) => (
                    <div key={a.name}
                      draggable
                      onDragStart={() => onDragStart(i)}
                      onDragOver={e => onDragOver(e, i)}
                      onDragEnd={onDragEnd}
                    >
                      <div className="mgr-list-row mgr-list-row-indented">
                        <span className="mgr-drag-handle">⠿</span>
                        <div className="mgr-list-content" style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div className="mgr-list-name">{a.name}</div>
                            {(a.cardLast4 || a.card_last4) && (
                              <span style={{ fontSize: '0.62rem', background: 'var(--bg-card2)', border: '1px solid var(--border)', padding: '1px 6px', borderRadius: 6, color: 'var(--accent)', fontWeight: 700 }}>
                                •••• {a.cardLast4 || a.card_last4}
                              </span>
                            )}
                          </div>
                          {a.acctType === 'Credit Card' && (
                            <div style={{ fontSize: '0.63rem', color: 'var(--accent)', fontWeight: 700 }}>
                              💳 Credit Card{a.settlementDate ? ` · settles ${a.settlementDate}th` : ''}
                            </div>
                          )}
                        </div>
                        <button className="mgr-edit-btn" onClick={() => editingAcct === a.name ? setEditingAcct(null) : startEdit(a)}>✏️</button>
                        <button className="mgr-del-btn" onClick={() => removeAccount(a.name)}>✕</button>
                      </div>
                      {editingAcct === a.name && renderEditPanel(i)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          );
        })()}
        <ConfirmModal isOpen={!!confirmState} {...confirmState} onCancel={() => setConfirmState(null)} />
        <div className="h-8" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Categories Manager
// ─────────────────────────────────────────────
export function CategoriesManager({ onBack }) {
  const { state, updateSettings, renameCategory, deleteCategoryTransactions, deleteSubcategoryTransactions } = useApp();
  const [cats, setCats] = useState(() => {
    // Use categoriesArr (DB sort_order preserved) if available, else fall back to categories object
    const arr = state.categoriesArr;
    if (arr && arr.length > 0) {
      return arr.map(c => ({ name: c.name, type: c.type || 'Expense', subcategories: (c.subcategories || []).map(s => s.name || s) }));
    }
    const obj = state.categories || {};
    return Object.entries(obj).map(([name, d]) => ({ name, type: d.type || 'Expense', subcategories: (d.subcategories || []).map(s => s) }));
  });
  const [tabMode, setTabMode] = useState('list');
  const [newCat, setNewCat] = useState('');
  const [newType, setNewType] = useState('Expense');
  const [newSub, setNewSub] = useState('');
  const [newSubParent, setNSP] = useState('');
  const [editCat, setEditCat] = useState(null); // {i, j?} — j=sub index
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [confirmState, setConfirmState] = useState(null);
  const dragIdx = useRef(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2200); };

  const catsObj = useMemo(() => {
    const o = {};
    for (const c of cats) o[c.name] = { type: c.type, subcategories: c.subcategories };
    return o;
  }, [cats]);

  const save = async (updated = cats) => {
    setSaving(true);
    // Pass sortOrder so replaceCategories preserves drag order in DB
    const o = {};
    for (const [i, c] of updated.entries()) o[c.name] = { type: c.type, subcategories: c.subcategories, sortOrder: i };
    try { await updateSettings({ categories: o }); showToast('Saved ✓'); }
    finally { setSaving(false); }
  };

  const addCat = () => {
    const t = newCat.trim();
    if (!t || cats.some(c => c.name === t)) return;
    const upd = [...cats, { name: t, type: newType, subcategories: [] }];
    setCats(upd); setNewCat(''); save(upd);
  };

  const addSub = () => {
    const t = newSub.trim();
    if (!t || !newSubParent) return;
    const upd = cats.map(c => c.name === newSubParent && !c.subcategories.includes(t) ? { ...c, subcategories: [...c.subcategories, t] } : c);
    setCats(upd); setNewSub(''); save(upd);
  };

  const removeCat = (i) => {
    const name = cats[i].name;
    if (name === 'Unassigned') {
      setConfirmState({
        title: 'Cannot Delete Category',
        message: 'The "Unassigned" category is a fallback system category and cannot be deleted.',
        isWarning: true
      });
      return;
    }
    const count = (state.transactions || []).filter(t => t.Category === name).length;
    if (count > 0) {
      setConfirmState({
        title: 'Delete Category?',
        message: `Category "${name}" has ${count} associated transaction(s).\n\nDeleting it will move these transactions to the "Unassigned" category. Do you want to proceed?`,
        isWarning: true,
        onConfirm: async () => {
          setConfirmState(null);
          let nextCats = [...cats];
          if (!nextCats.some(c => c.name === 'Unassigned')) {
            nextCats.push({ name: 'Unassigned', type: 'Expense', subcategories: [] });
          }
          const upd = nextCats.filter((_, idx) => idx !== i);
          setCats(upd);
          await deleteCategoryTransactions(name, 'Unassigned');
          await save(upd);
        }
      });
    } else {
      setConfirmState({
        title: 'Delete Category?',
        message: `Are you sure you want to delete category "${name}"?`,
        isWarning: false,
        onConfirm: async () => {
          setConfirmState(null);
          const upd = cats.filter((_, idx) => idx !== i);
          setCats(upd);
          await save(upd);
        }
      });
    }
  };

  const removeSub = (ci, si) => {
    const catName = cats[ci].name;
    const subName = cats[ci].subcategories[si];
    const count = (state.transactions || []).filter(t => t.Category === catName && t.Subcategory === subName).length;
    if (count > 0) {
      setConfirmState({
        title: 'Delete Subcategory?',
        message: `Subcategory "${subName}" has ${count} associated transaction(s).\n\nDeleting it will remove the subcategory from these transactions. Do you want to proceed?`,
        isWarning: true,
        onConfirm: async () => {
          setConfirmState(null);
          const upd = cats.map((c, idx) => idx === ci ? { ...c, subcategories: c.subcategories.filter((_, j) => j !== si) } : c);
          setCats(upd);
          await deleteSubcategoryTransactions(catName, subName);
          await save(upd);
        }
      });
    } else {
      setConfirmState({
        title: 'Delete Subcategory?',
        message: `Are you sure you want to delete subcategory "${subName}"?`,
        isWarning: false,
        onConfirm: async () => {
          setConfirmState(null);
          const upd = cats.map((c, idx) => idx === ci ? { ...c, subcategories: c.subcategories.filter((_, j) => j !== si) } : c);
          setCats(upd);
          await save(upd);
        }
      });
    }
  };

  const startEditCat = (i) => { setEditCat({ i }); setEditName(cats[i].name); };
  const startEditSub = (i, j) => { setEditCat({ i, j }); setEditName(cats[i].subcategories[j]); };

  const saveEdit = async () => {
    const newName = editName.trim();
    if (!newName) return;
    const { i, j } = editCat;
    if (j === undefined) {
      const old = cats[i].name;
      const upd = cats.map((c, idx) => idx === i ? { ...c, name: newName } : c);
      setCats(upd); setEditCat(null);
      if (old !== newName) await renameCategory(old, newName);
      await save(upd);
    } else {
      const oldSub = cats[i].subcategories[j];
      const upd = cats.map((c, idx) => idx === i ? { ...c, subcategories: c.subcategories.map((s, si) => si === j ? newName : s) } : c);
      setCats(upd); setEditCat(null);
      if (oldSub !== newName) await renameCategory(cats[i].name, cats[i].name, oldSub, newName);
      await save(upd);
    }
  };

  // Drag reorder categories
  const onDragStart = (i) => { dragIdx.current = i; };
  const onDragOver = (e, i) => { e.preventDefault(); if (dragIdx.current === null || dragIdx.current === i) return; const upd = [...cats]; const [moved] = upd.splice(dragIdx.current, 1); upd.splice(i, 0, moved); dragIdx.current = i; setCats(upd); };
  const onDragEnd = () => { dragIdx.current = null; save(); };

  // Kanban: move subcategory to different parent category
  const allSubItems = useMemo(() => cats.flatMap(c => c.subcategories.map(s => ({ sub: s, parent: c.name }))), [cats]);
  const handleSubKanbanMove = (item, newParent) => {
    if (!newParent || !cats.find(c => c.name === newParent)) return;
    const upd = cats.map(c => {
      if (c.name === item.parent) return { ...c, subcategories: c.subcategories.filter(s => s !== item.sub) };
      if (c.name === newParent && !c.subcategories.includes(item.sub)) return { ...c, subcategories: [...c.subcategories, item.sub] };
      return c;
    });
    setCats(upd); save(upd);
  };

  const expCats = cats.filter(c => c.type === 'Expense');
  const incCats = cats.filter(c => c.type === 'Income');
  const [expanded, setExpanded] = useState(new Set());
  const toggleExpand = (name) => setExpanded(prev => {
    const s = new Set(prev);
    s.has(name) ? s.delete(name) : s.add(name);
    return s;
  });

  const renderSection = (list, typeLabel) => (
    <>
      <div className="mgr-section-label">{typeLabel} Categories
        <span style={{ float: 'right', fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: '0.65rem', opacity: 0.6 }}>⠿ drag to set picker order</span>
      </div>
      <div className="mgr-list">
        {list.length === 0 && <div className="mgr-empty">No {typeLabel.toLowerCase()} categories</div>}
        {list.map((c) => {
          const i = cats.indexOf(c);
          return (
            <div key={c.name}>
              <div className="mgr-list-row mgr-cat-row"
                draggable
                onDragStart={() => onDragStart(i)}
                onDragOver={e => onDragOver(e, i)}
                onDragEnd={onDragEnd}
              >
                <span className="mgr-drag-handle">⠿</span>
                <div className="mgr-list-name" style={{ flex: 1 }}>{c.name}</div>
                {c.subcategories.length > 0 && (
                  <button
                    className="mgr-accordion-btn"
                    onClick={(e) => { e.stopPropagation(); toggleExpand(c.name); }}
                  >
                    <span>{c.subcategories.length} subs</span>
                    <span style={{ fontSize: '0.8rem', transition: 'transform 0.2s', transform: expanded.has(c.name) ? 'rotate(180deg)' : 'rotate(0deg)', display: 'inline-block' }}>▾</span>
                  </button>
                )}
                <button className="mgr-edit-btn" onClick={() => editCat?.i === i && editCat?.j === undefined ? setEditCat(null) : startEditCat(i)}>✏️</button>
                <button className="mgr-del-btn" onClick={() => removeCat(i)}>✕</button>
              </div>
              {editCat?.i === i && editCat?.j === undefined && (
                <div className="mgr-edit-panel">
                  <div className="mgr-edit-label">Rename Category</div>
                  <input className="form-input" value={editName} onChange={e => setEditName(e.target.value)} style={{ marginBottom: 8 }} spellCheck="true" autoCapitalize="sentences" />
                  <div className="mgr-edit-warn">⚠ Updates all matching transactions</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditCat(null)}>Cancel</button>
                    <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                  </div>
                </div>
              )}
              {c.subcategories.length > 0 && expanded.has(c.name) && c.subcategories.map((s, j) => (
                <div key={s}>
                  <div className="mgr-list-row mgr-sub-row">
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginRight: 4 }}>└</span>
                    <div style={{ flex: 1 }}>
                      <div className="mgr-sub-name" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{s}</div>
                      <select className="mgr-inline-sel" value={c.name}
                        onChange={e => {
                          const newPar = e.target.value; if (newPar === c.name) return;
                          const u = cats.map((x, xi) => {
                            if (xi === i) return { ...x, subcategories: x.subcategories.filter((_, si) => si !== j) };
                            if (x.name === newPar) return { ...x, subcategories: [...x.subcategories, s] };
                            return x;
                          });
                          setCats(u); save(u);
                        }}>
                        {cats.map(x => <option key={x.name}>{x.name}</option>)}
                      </select>
                    </div>
                    <button className="mgr-edit-btn" style={{ width: 22, height: 22 }} onClick={() => editCat?.i === i && editCat?.j === j ? setEditCat(null) : startEditSub(i, j)}>✏️</button>
                    <button className="mgr-del-btn" style={{ width: 22, height: 22 }} onClick={() => removeSub(i, j)}>✕</button>
                  </div>
                  {editCat?.i === i && editCat?.j === j && (
                    <div className="mgr-edit-panel">
                      <div className="mgr-edit-label">Rename Subcategory</div>
                      <input className="form-input" value={editName} onChange={e => setEditName(e.target.value)} style={{ marginBottom: 8 }} spellCheck="true" autoCapitalize="sentences" />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditCat(null)}>Cancel</button>
                        <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div className="sub-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="page-hdr-title">Categories</div>
        {saving && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 8 }}>Saving…</span>}
        {toast && <span style={{ fontSize: '0.7rem', color: 'var(--green)', marginLeft: 8 }}>{toast}</span>}
      </div>
      <div className="sub-body">
        <>
          {/* Add Category */}
          <div className="mgr-section-label">Add Category</div>
          <div style={{ padding: '0 var(--page-px) 8px', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Name</label>
              <input className="form-input" value={newCat} onChange={e => setNewCat(e.target.value)} onKeyDown={e => e.key === 'Enter' && addCat()} spellCheck="true" autoCapitalize="sentences" />
            </div>
            <div className="form-group">
              <label className="form-label">Type</label>
              <select className="form-input" value={newType} onChange={e => setNewType(e.target.value)}>
                <option>Expense</option><option>Income</option>
              </select>
            </div>
            <button className="btn btn-primary btn-sm" style={{ marginBottom: 0, flexShrink: 0 }} onClick={addCat}>Add</button>
          </div>

          {/* Add Subcategory */}
          <div className="mgr-section-label">Add Subcategory</div>
          <div style={{ padding: '0 var(--page-px) 8px', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Parent Category</label>
              <select className="form-input" value={newSubParent} onChange={e => setNSP(e.target.value)}>
                <option value="">Select parent</option>
                {cats.map(c => <option key={c.name}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Name</label>
              <input className="form-input" value={newSub} onChange={e => setNewSub(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSub()} spellCheck="true" autoCapitalize="sentences" />
            </div>
            <button className="btn btn-primary btn-sm" style={{ flexShrink: 0 }} onClick={addSub}>Add</button>
          </div>

          {renderSection(expCats, 'Expense')}
          {renderSection(incCats, 'Income')}
        </>
        <ConfirmModal isOpen={!!confirmState} {...confirmState} onCancel={() => setConfirmState(null)} />
        <div className="h-8" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Tags Manager
// ─────────────────────────────────────────────
function TagsManager({ onBack }) {
  const { state, updateTransaction, updateSettings } = useApp();
  const { transactions } = state;
  const [newTagInput, setNewTagInput] = useState('');
  const [editingTag, setEditingTag] = useState(null); // { oldName, newName }
  const [confirmDelete, setConfirmDelete] = useState(null); // tag name

  const customTagsList = useMemo(() => {
    try {
      const parsed = JSON.parse(state.settings?.customTags || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [state.settings?.customTags]);

  // Aggregate all tags and their transaction counts
  const tagList = useMemo(() => {
    const map = {};
    // Populate all custom tags created by user with initial 0 count
    for (const ct of customTagsList) {
      const clean = String(ct).trim().toLowerCase();
      if (clean) {
        const withHash = clean.startsWith('#') ? clean : `#${clean}`;
        map[withHash] = 0;
      }
    }
    // Count occurrences from transactions
    for (const t of transactions) {
      const tags = [];
      if (t.Tags) {
        t.Tags.split(',').forEach(tag => {
          const clean = tag.trim().toLowerCase();
          if (clean) tags.push(clean.startsWith('#') ? clean : `#${clean}`);
        });
      }
      const matches = ((t.Note || '') + ' ' + (t.Description || '')).match(/#[a-zA-Z0-9_\u0900-\u097F-]+/g);
      if (matches) matches.forEach(m => tags.push(m.toLowerCase()));

      const unique = Array.from(new Set(tags));
      for (const tag of unique) {
        map[tag] = (map[tag] || 0) + 1;
      }
    }
    return Object.entries(map).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [transactions, customTagsList]);

  const handleAddNewTag = async () => {
    const trimmed = (newTagInput || '').trim();
    if (!trimmed) return;
    const clean = trimmed.toLowerCase().replace(/\s+/g, '_');
    const tagWithHash = clean.startsWith('#') ? clean : `#${clean}`;

    const currentCustom = [...customTagsList];
    if (!currentCustom.includes(tagWithHash)) {
      currentCustom.push(tagWithHash);
      await updateSettings({ customTags: JSON.stringify(currentCustom) });
    }
    setNewTagInput('');
  };

  const handleRename = async () => {
    if (!editingTag || !editingTag.newName.trim()) return;
    const rawOld = editingTag.oldName.toLowerCase();
    const oldHash = rawOld.startsWith('#') ? rawOld : `#${rawOld}`;
    const oldClean = rawOld.replace(/^#/, '');

    const rawNew = editingTag.newName.trim().toLowerCase();
    const newHash = rawNew.startsWith('#') ? rawNew : `#${rawNew}`;
    const newClean = rawNew.replace(/^#/, '');

    const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexOldHash = new RegExp(`(^|\\s)${escapeRegex(oldHash)}(\\b|\\s|$)`, 'gi');

    for (const t of transactions) {
      let changed = false;
      let curTags = (t.Tags || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (curTags.some(x => x === oldHash || x === oldClean)) {
        curTags = curTags.map(x => (x === oldHash || x === oldClean) ? newHash : x);
        changed = true;
      }
      let curNote = t.Note || '';
      if (curNote.toLowerCase().includes(oldHash)) {
        curNote = curNote.replace(regexOldHash, `$1${newHash}$2`).trim();
        changed = true;
      }
      let curDesc = t.Description || '';
      if (curDesc.toLowerCase().includes(oldHash)) {
        curDesc = curDesc.replace(regexOldHash, `$1${newHash}$2`).trim();
        changed = true;
      }
      if (changed) {
        const id = t._id || t.id;
        await updateTransaction(id, {
          ...t,
          Tags: Array.from(new Set(curTags)).join(', '),
          Note: curNote,
          Description: curDesc,
        });
      }
    }

    if (customTagsList.includes(oldHash)) {
      const nextCustom = customTagsList.map(t => t === oldHash ? newHash : t);
      await updateSettings({ customTags: JSON.stringify(nextCustom) });
    }

    setEditingTag(null);
  };

  const handleDelete = async (tagToDelete) => {
    const rawTag = tagToDelete.toLowerCase();
    const withHash = rawTag.startsWith('#') ? rawTag : `#${rawTag}`;
    const noHash = rawTag.replace(/^#/, '');

    const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hashRegex = new RegExp(`(^|\\s)${escapeRegex(withHash)}(\\b|\\s|$)`, 'gi');

    for (const t of transactions) {
      let changed = false;
      let curTags = (t.Tags || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (curTags.some(x => x === withHash || x === noHash)) {
        curTags = curTags.filter(x => x !== withHash && x !== noHash);
        changed = true;
      }
      let curNote = t.Note || '';
      if (curNote.toLowerCase().includes(withHash)) {
        curNote = curNote.replace(hashRegex, '$1$2').trim();
        changed = true;
      }
      let curDesc = t.Description || '';
      if (curDesc.toLowerCase().includes(withHash)) {
        curDesc = curDesc.replace(hashRegex, '$1$2').trim();
        changed = true;
      }
      if (changed) {
        const id = t._id || t.id;
        await updateTransaction(id, {
          ...t,
          Tags: curTags.join(', '),
          Note: curNote,
          Description: curDesc,
        });
      }
    }

    if (customTagsList.includes(withHash)) {
      const nextCustom = customTagsList.filter(t => t !== withHash);
      await updateSettings({ customTags: JSON.stringify(nextCustom) });
    }

    setConfirmDelete(null);
  };

  return (
    <div className="sub-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="page-hdr-title">Tags &amp; Hashtags</div>
      </div>

      <div className="sub-body">
        <div style={{ padding: '0 var(--page-px) 12px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          Tags allow cross-cutting tracking across multiple categories (e.g. #trip, #tax, #medical).
        </div>

        {/* Add Tag Row */}
        <div style={{ display: 'flex', gap: 8, padding: '0 var(--page-px) 14px' }}>
          <input
            className="form-input"
            style={{ flex: 1 }}
            placeholder="Add new tag (e.g. #trip, #medical, grocery)"
            value={newTagInput}
            onChange={e => setNewTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddNewTag(); }}
            spellCheck="true"
            autoCapitalize="none"
          />
          <button className="btn btn-primary btn-sm" onClick={handleAddNewTag}>
            + Add Tag
          </button>
        </div>

        <div className="settings-card" style={{ margin: '0 var(--page-px) 14px' }}>
          {tagList.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              No hashtags found yet. Type above to add a new tag or use #tag in any transaction.
            </div>
          ) : (
            tagList.map(tag => (
              <div key={tag.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border-light)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 800, color: 'var(--accent)', fontSize: '0.88rem' }}>{tag.name}</span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', background: 'var(--bg-card2)', padding: '2px 6px', borderRadius: 6 }}>
                    {tag.count} txn{tag.count !== 1 ? 's' : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setEditingTag({ oldName: tag.name, newName: tag.name })}
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => setConfirmDelete(tag.name)}
                    style={{ background: 'none', border: 'none', color: 'var(--expense)', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Rename Modal */}
        {editingTag && (
          <>
            <div className="overlay" onClick={() => setEditingTag(null)} />
            <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
              <div className="sheet-handle" />
              <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 8 }}>Rename Tag {editingTag.oldName}</div>
              <input
                className="form-input"
                style={{ marginBottom: 12 }}
                value={editingTag.newName}
                onChange={e => setEditingTag(p => ({ ...p, newName: e.target.value }))}
                placeholder="New tag name (e.g. #vacation)"
                autoFocus
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-ghost btn-full" onClick={() => setEditingTag(null)}>Cancel</button>
                <button className="btn btn-primary btn-full" onClick={handleRename}>Save &amp; Update All</button>
              </div>
            </div>
          </>
        )}

        {/* Confirm Delete Modal */}
        {confirmDelete && (
          <>
            <div className="overlay" onClick={() => setConfirmDelete(null)} />
            <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
              <div className="sheet-handle" />
              <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 6 }}>Delete tag {confirmDelete}?</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 14 }}>
                This will remove the tag from all associated transactions. The transactions themselves will NOT be deleted.
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-ghost btn-full" onClick={() => setConfirmDelete(null)}>Cancel</button>
                <button className="btn btn-danger btn-full" onClick={() => handleDelete(confirmDelete)}>Delete Tag</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Data Manager
// ─────────────────────────────────────────────
function DataManager({ onBack }) {
  const { state, importData, cancelImport, clearAllData, cleanupAccounts, analyseImport, updateSettings, modifyRecurringRule, removeRecurringRule } = useApp();
  const { transactions, accounts, accountGroups, accountMapping, categories, budgets, importProgress, recurringRules } = state;
  const fileRef = useRef(null);
  const [showReportGenerator, setShowReportGenerator] = useState(false);
  const [status, setStatus] = useState(null);
  const [showMode, setShowMode] = useState(false);
  const [pendingRows, setPending] = useState(null);
  const [pendingName, setPendingNm] = useState('');
  const [pendingIsBackup, setIsBackup] = useState(false);
  const [pendingBackup, setPendingBackup] = useState(null);
  const [backupSchedule, setBackupSchedule] = useState(() => state.settings?.backupSchedule || 'off');
  const [backupHistory, setBackupHistory] = useState(() => {
    try { return JSON.parse(state.settings?.backupHistory || '[]'); } catch { return []; }
  });
  const [showBackupSheet, setShowBackupSheet] = useState(false);
  const [showDel, setShowDel] = useState(false);
  const [analysis, setAnalysis] = useState(null);   // { total, fileDupeCount, dbDupeCount }
  const [analysing, setAnalysing] = useState(false);

  // Encrypted Backup & Restore State
  const [cryptoModal, setCryptoModal] = useState(null); // null | { mode: 'export' } | { mode: 'import', rawText, fileName }
  const [cryptoPin, setCryptoPin]     = useState('');
  const [cryptoErr, setCryptoErr]     = useState('');

  // Stats
  const txnCount = transactions.length;
  const yearsSet = txnCount > 0 ? new Set(transactions.map(t => parseDate(t.Date).getFullYear())) : new Set();
  const historyDays = useMemo(() => {
    if (!txnCount) return 0;
    const dates = transactions.map(t => parseDate(t.Date)).filter(d => d.getTime() > 0);
    if (!dates.length) return 0;
    const oldest = new Date(Math.min(...dates.map(d => d.getTime())));
    const newest = new Date(Math.max(...dates.map(d => d.getTime())));
    return Math.round((newest - oldest) / (1000 * 86400));
  }, [transactions]);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(null);
    const name = file.name.toLowerCase();

    // Check for encrypted FinMan backup (.finman or JSON with finman_encrypted_backup)
    if (name.endsWith('.finman')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;
        setCryptoModal({ mode: 'import', rawText: text, fileName: file.name });
        setCryptoPin('');
        setCryptoErr('');
      };
      reader.readAsText(file);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    try {
      const { parseFile } = await import('../../utils/xlsParser.js');
      const parsed = await parseFile(file);

      // Check if plain JSON file is actually an encrypted backup
      if (parsed && typeof parsed === 'object' && parsed.finman_encrypted_backup) {
        setCryptoModal({ mode: 'import', rawText: JSON.stringify(parsed), fileName: file.name });
        setCryptoPin('');
        setCryptoErr('');
        if (fileRef.current) fileRef.current.value = '';
        return;
      }

      // ── Full FinMan backup JSON ─────────────────────────────────────────
      // Detect by _finman_backup flag. These files contain both transactions
      // AND settings (accounts, groups, categories, budgets).
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed._finman_backup) {
        const backup = parsed;
        const txnRows = Array.isArray(backup.transactions) ? backup.transactions : [];
        setPending(txnRows);
        setPendingNm(file.name);
        setIsBackup(true);
        setPendingBackup(backup);
        setShowMode(true);
        if (fileRef.current) fileRef.current.value = '';
        return;
      }

      // ── Transactions-only file (CSV, XLS, or plain JSON array) ──────────
      const rows = Array.isArray(parsed) ? parsed : [];
      if (rows.length === 0) {
        setStatus({ type: 'error', msg: 'File appears empty or unreadable.' });
        if (fileRef.current) fileRef.current.value = '';
        return;
      }
      // Validate expected columns
      const firstRow = rows[0];
      const hasDate = 'Date' in firstRow || 'date' in firstRow;
      const hasType = 'Income/Expense' in firstRow || 'type' in firstRow;
      if (!hasDate || !hasType) {
        setStatus({ type: 'error', msg: `Missing required columns. Need: Date, Income/Expense, Amount/INR, Account, Category. Found: ${Object.keys(firstRow).slice(0, 6).join(', ')}…` });
        if (fileRef.current) fileRef.current.value = '';
        return;
      }
      setPending(rows);
      setPendingNm(file.name);
      setIsBackup(false);
      setPendingBackup(null);
      setShowMode(true);
    } catch (err) {
      setStatus({ type: 'error', msg: `Parse error: ${err.message}` });
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const doImport = async (mode) => {
    setShowMode(false);
    const result = await importData(pendingRows, mode, pendingBackup);
    setStatus(result.cancelled
      ? { type: 'error', msg: 'Import cancelled.' }
      : { type: 'success', msg: `✓ Imported ${result.imported.toLocaleString()} transactions${result.skipped > 0 ? ` (${result.skipped} skipped)` : ''}.` }
    );
    setPending(null);
    setPendingBackup(null);
  };

  // ── Capacitor-aware file save (no @capacitor/share — avoids Android 14 crash) ──
  // ── Backup helpers ─────────────────────────────────────────────────────────
  const MAX_BACKUPS = 3;

  const buildBackupPayload = async () => {
    let inventory = [];
    try {
      const db = getDB();
      const res = await db.query('SELECT * FROM inventory', []);
      inventory = res.values || [];
    } catch (e) {
      console.error('Failed to export stock inventory:', e);
    }
    return {
      _finman_backup: true,
      version: '2.3.0',
      exportedAt: new Date().toISOString(),
      transactions,
      accounts: accounts || [],
      accountGroups: accountGroups || [],
      accountMapping: accountMapping || [],
      categories: categories || {},
      budgets: budgets || [],
      recurringRules: recurringRules || [],
      customTags: state.settings?.customTags || '',
      inventory
    };
  };

  const runBackupNow = async () => {
    const payload = await buildBackupPayload();
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const filename = `finman_backup_${dateStr}.json`;
    const json = JSON.stringify(payload, null, 2);

    // Update history (keep last 3) AND mark lastBackupCheck
    const entry = { date: now.toISOString(), filename, size: json.length };
    const newHistory = [entry, ...backupHistory].slice(0, MAX_BACKUPS);
    setBackupHistory(newHistory);
    await updateSettings({
      backupHistory: JSON.stringify(newHistory),
      lastBackupCheck: now.toISOString(),
    });

    // Trigger download
    await saveFile(json, filename, 'application/json');
    setStatus({ type: 'success', msg: `✓ Backup saved — ${filename}` });
  };

  const saveBackupSchedule = async (val) => {
    setBackupSchedule(val);
    // Only save schedule — do NOT reset lastBackupCheck here.
    // lastBackupCheck is only updated when an actual backup is taken.
    await updateSettings({ backupSchedule: val });
  };

  const saveFile = async (content, filename, mimeType) => {
    const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform?.());
    if (isNative) {
      try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        // Write directly to Downloads folder — visible in Files app without Share plugin
        await Filesystem.writeFile({
          path: filename,
          data: btoa(unescape(encodeURIComponent(content))),
          directory: Directory.Documents,
          recursive: true,
        });
        // Show a toast-style alert so user knows where to find it
        alert(`Saved to Documents/${filename}\n\nOpen your Files app → Internal Storage → Documents`);
        return;
      } catch (err) {
        console.error('Capacitor save failed, falling back to browser:', err);
      }
    }
    // Browser fallback
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
    }, 1000);
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60000);
  };

  const exportCSV = async () => {
    const hdrs = [
      'Date', 'Time', 'Account', 'AccountGroup', 'AccountType', 'CardLast4', 'SettlementDate', 'PaymentDueDays', 'AccountOrder', 'AccountGroupOrder',
      'FromAccount', 'FromAccountGroup', 'FromAccountOrder', 'ToAccount', 'ToAccountGroup', 'ToAccountOrder',
      'Category', 'Subcategory', 'Note', 'Description',
      'INR', 'Amount', 'Currency', 'Income/Expense',
      'Tags', 'recurring_rule_id', 'warranty_expiry', 'serial_no', 'receipt_image', 'created_at', 'updated_at', 'ID'
    ];
    // RFC 4180: quote any field containing comma, double-quote, newline or carriage-return
    const esc = v => { const s = String(v ?? ''); return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [
      hdrs.join(','),
      ...transactions.map(t => {
        const acctIdx = (accounts || []).findIndex(a => a.name === t.Account);
        const acctObj = acctIdx !== -1 ? accounts[acctIdx] : null;
        const fromAcctIdx = (accounts || []).findIndex(a => a.name === (t.FromAccount || t.Account));
        const fromAcctObj = fromAcctIdx !== -1 ? accounts[fromAcctIdx] : null;
        const toAcctIdx = (accounts || []).findIndex(a => a.name === t.ToAccount);
        const toAcctObj = toAcctIdx !== -1 ? accounts[toAcctIdx] : null;
        const grpIdx = (accountGroups || []).findIndex(g => (typeof g === 'string' ? g : g.name) === (acctObj?.group || ''));

        return hdrs.map(h => {
          if (h === 'AccountGroup') return esc(acctObj?.group || '');
          if (h === 'AccountType') return esc(acctObj?.acctType || '');
          if (h === 'CardLast4') return esc(acctObj?.cardLast4 || '');
          if (h === 'SettlementDate') return esc(acctObj?.settlementDate || '');
          if (h === 'PaymentDueDays') return esc(acctObj?.paymentDueDays || '');
          if (h === 'AccountOrder') return esc(acctIdx !== -1 ? acctIdx : '');
          if (h === 'AccountGroupOrder') return esc(grpIdx !== -1 ? grpIdx : '');
          if (h === 'FromAccountGroup') return esc(fromAcctObj?.group || '');
          if (h === 'FromAccountOrder') return esc(fromAcctIdx !== -1 ? fromAcctIdx : '');
          if (h === 'ToAccountGroup') return esc(toAcctObj?.group || '');
          if (h === 'ToAccountOrder') return esc(toAcctIdx !== -1 ? toAcctIdx : '');
          if (h === 'Tags') return esc(t.Tags || t.tags || '');
          return esc(t[h] ?? '');
        }).join(',');
      })
    ];
    await saveFile('\ufeff' + rows.join('\n'), `finman_${new Date().toISOString().split('T')[0]}.csv`, 'text/csv;charset=utf-8;');
  };

  const exportJSON = async () => {
    const backup = await buildBackupPayload();
    await saveFile(JSON.stringify(backup, null, 2), `finman_backup_${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  };

  const handleCryptoExport = async () => {
    if (!cryptoPin || cryptoPin.length < 4) {
      setCryptoErr('Please enter at least 4 digits/characters for encryption');
      return;
    }
    try {
      const payload = await buildBackupPayload();
      const encryptedJson = await encryptBackupData(payload, cryptoPin);
      const filename = `finman_encrypted_${new Date().toISOString().split('T')[0]}.finman`;
      await saveFile(encryptedJson, filename, 'application/octet-stream');
      setStatus({ type: 'success', msg: `✓ Encrypted backup saved — ${filename}` });
      setCryptoModal(null);
      setCryptoPin('');
      setCryptoErr('');
    } catch (err) {
      setCryptoErr(err.message);
    }
  };

  const handleCryptoImport = async () => {
    if (!cryptoPin) {
      setCryptoErr('Please enter the password/PIN to decrypt');
      return;
    }
    try {
      const decryptedPayload = await decryptBackupData(cryptoModal.rawText, cryptoPin);
      if (decryptedPayload && decryptedPayload._finman_backup) {
        const backup = decryptedPayload;
        const txnRows = Array.isArray(backup.transactions) ? backup.transactions : [];
        setPending(txnRows);
        setPendingNm(cryptoModal.fileName);
        setIsBackup(true);
        setPendingBackup(backup);
        setShowMode(true);
        setCryptoModal(null);
        setCryptoPin('');
        setCryptoErr('');
      } else {
        setCryptoErr('Decrypted data is not a valid FinMan backup.');
      }
    } catch (err) {
      setCryptoErr(err.message);
    }
  };

  const pct = importProgress ? Math.round((importProgress.processed / importProgress.total) * 100) : 0;

  if (showReportGenerator) {
    return <ReportGenerator onBack={() => setShowReportGenerator(false)} />;
  }

  return (
    <div className="sub-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="page-hdr-title">Data Management</div>
      </div>

      <div className="sub-body">
        {/* Stats */}
        <div className="dm-stats" style={{ margin: '10px 0', borderRadius: 0, borderLeft: 'none', borderRight: 'none' }}>
          <div className="dm-stat">
            <div className="dm-stat-v">{txnCount.toLocaleString()}</div>
            <div className="dm-stat-l">Transactions</div>
          </div>
          <div className="dm-stat">
            <div className="dm-stat-v">{yearsSet.size || 0}</div>
            <div className="dm-stat-l">Years</div>
          </div>
          <div className="dm-stat">
            <div className="dm-stat-v">{historyDays > 0 ? `${historyDays}d` : '—'}</div>
            <div className="dm-stat-l">History</div>
          </div>
        </div>

        {/* Status banner */}
        {status && (
          <div className={`dm-status ${status.type}`}>
            {status.msg}
          </div>
        )}

        {/* Progress bar */}
        {importProgress && (
          <div className="dm-progress-wrap">
            <div className="dm-progress-bar">
              <div className="dm-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="dm-progress-txt">
              {importProgress.processed.toLocaleString()} / {importProgress.total.toLocaleString()} ({pct}%)
            </div>
          </div>
        )}

        {/* Import section */}
        <div className="dm-section-hdr">Import</div>
        <label className={`import-drop ${importProgress ? 'disabled' : ''}`} style={{ margin: '0 0 14px', borderLeft: 'none', borderRight: 'none', borderRadius: 0, padding: '18px var(--page-px)', display: 'block' }}>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.xlsm,.json,.finman" style={{ display: 'none' }} onChange={handleFile} disabled={!!importProgress} />
          <div className="import-folder-icon">📂</div>
          <div className="import-drop-title">Choose file</div>
          <div className="import-drop-sub">CSV / XLS / JSON / 🔒 .finman encrypted backup</div>
        </label>

        {/* Export section */}
        <div className="dm-section-hdr">Export &amp; Reports</div>
        <div className="dm-card" style={{ margin: '0 0 14px', borderRadius: 0, borderLeft: 'none', borderRight: 'none' }}>
          <div className="dm-row" onClick={() => setShowReportGenerator(true)}>
            <div className="dm-row-icon">📑</div>
            <div className="dm-row-content">
              <div className="dm-row-title">Custom Report &amp; Statement (Excel / CSV)</div>
              <div className="dm-row-sub">Date ranges, FY filters, category breakdown &amp; statements</div>
            </div>
          </div>
          <div className="dm-row" onClick={() => { setCryptoModal({ mode: 'export' }); setCryptoPin(''); setCryptoErr(''); }}>
            <div className="dm-row-icon">🔒</div>
            <div className="dm-row-content"><div className="dm-row-title">Export Encrypted Backup (.finman)</div><div className="dm-row-sub">AES-256 zero-knowledge backup protected by your PIN</div></div>
          </div>
          <div className="dm-row" onClick={exportJSON}>
            <div className="dm-row-icon">🗃️</div>
            <div className="dm-row-content"><div className="dm-row-title">Export Plain Backup (JSON)</div><div className="dm-row-sub">Transactions + accounts, groups, categories · re-importable</div></div>
          </div>
          <div className="dm-row" onClick={exportCSV}>
            <div className="dm-row-icon">📊</div>
            <div className="dm-row-content"><div className="dm-row-title">Export All CSV</div><div className="dm-row-sub">Transactions only · safe for spreadsheets</div></div>
          </div>
        </div>

        {/* Backup section */}
        <div className="dm-section-hdr">Backup</div>
        <div className="dm-card" style={{ margin: '0 0 14px', borderRadius: 0, borderLeft: 'none', borderRight: 'none' }}>
          <div className="dm-row" onClick={runBackupNow}>
            <div className="dm-row-icon">📲</div>
            <div className="dm-row-content">
              <div className="dm-row-title">Backup Now</div>
              <div className="dm-row-sub">Save full backup to device storage</div>
            </div>
          </div>
          <div className="dm-row" style={{ opacity: 0.5, cursor: 'default' }}>
            <div className="dm-row-icon">🔵</div>
            <div className="dm-row-content">
              <div className="dm-row-title">Google Drive <span style={{ fontSize: '0.62rem', fontWeight: 700, background: 'rgba(255,180,0,0.15)', color: 'var(--gold)', borderRadius: 4, padding: '1px 5px', marginLeft: 4 }}>Coming Soon</span></div>
              <div className="dm-row-sub">Requires Google Cloud OAuth setup · auto-sync to Drive app folder</div>
            </div>
          </div>
          <div className="dm-row" onClick={() => setShowBackupSheet(true)}>
            <div className="dm-row-icon">⏰</div>
            <div className="dm-row-content">
              <div className="dm-row-title">Auto Backup</div>
              <div className="dm-row-sub">
                {backupSchedule === 'off' ? 'Disabled' : `${backupSchedule.charAt(0).toUpperCase() + backupSchedule.slice(1)} · keeps last ${MAX_BACKUPS} backups`}
              </div>
            </div>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent)', flexShrink: 0 }}>
              {backupSchedule === 'off' ? 'Off' : backupSchedule.charAt(0).toUpperCase() + backupSchedule.slice(1)}
            </div>
          </div>
          {backupHistory.length > 0 && (
            <div style={{ padding: '8px var(--page-px)', borderTop: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Backup History (last {MAX_BACKUPS})</div>
              {backupHistory.map((b, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < backupHistory.length - 1 ? '1px solid var(--border-light)' : 'none' }}>
                  <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-primary)' }}>{b.filename}</div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>{new Date(b.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{b.size ? (b.size / 1024).toFixed(1) + 'KB' : ''}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Auto backup schedule picker */}
        {showBackupSheet && (
          <>
            <div className="overlay" onClick={() => setShowBackupSheet(false)} />
            <div className="bottom-sheet">
              <div className="sheet-handle" />
              <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 4 }}>Auto Backup Schedule</div>
              <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginBottom: 16 }}>
                Backup reminder triggers on app open when due. Saves to your device and keeps the last {MAX_BACKUPS} backups.
              </div>
              {[['off', 'Disabled', 'No automatic backups'], ['daily', 'Daily', 'Reminder every day'], ['weekly', 'Weekly', 'Reminder every 7 days'], ['monthly', 'Monthly', 'Reminder every 30 days']].map(([val, label, sub]) => (
                <div key={val}
                  onClick={() => { saveBackupSchedule(val); setShowBackupSheet(false); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light)', cursor: 'pointer' }}>
                  <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${backupSchedule === val ? 'var(--accent)' : 'var(--border)'}`, background: backupSchedule === val ? 'var(--accent)' : 'transparent', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>{label}</div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{sub}</div>
                  </div>
                </div>
              ))}
              <button className="btn btn-ghost btn-full" style={{ marginTop: 12 }} onClick={() => setShowBackupSheet(false)}>Cancel</button>
            </div>
          </>
        )}

        {/* Encrypted Export/Import PIN Modal */}
        {cryptoModal && (
          <>
            <div className="overlay" onClick={() => setCryptoModal(null)} />
            <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
              <div className="sheet-handle" />
              <div style={{ fontSize: '1.2rem', textAlign: 'center', marginBottom: 6 }}>
                {cryptoModal.mode === 'export' ? '🔒 Encrypt Backup' : '🔓 Decrypt & Restore Backup'}
              </div>
              <div style={{ fontSize: '0.95rem', fontWeight: 800, textAlign: 'center', marginBottom: 4 }}>
                {cryptoModal.mode === 'export' ? 'Create AES-256 Protected Backup' : `Decrypt ${cryptoModal.fileName || 'Backup'}`}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', marginBottom: 14 }}>
                {cryptoModal.mode === 'export'
                  ? 'Set a 4+ digit PIN or password. You will need this key whenever restoring on any device.'
                  : 'Enter the PIN or password used when this backup was encrypted.'}
              </div>

              {cryptoErr && (
                <div style={{ background: 'rgba(255, 77, 106, 0.15)', color: 'var(--expense)', padding: '6px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700, marginBottom: 12, textAlign: 'center' }}>
                  {cryptoErr}
                </div>
              )}

              <input
                type="password"
                className="form-input"
                autoFocus
                placeholder="Enter PIN or Password"
                value={cryptoPin}
                onChange={e => { setCryptoPin(e.target.value); setCryptoErr(''); }}
                style={{ fontSize: '1.1rem', textAlign: 'center', letterSpacing: 3, marginBottom: 16, background: 'var(--bg-card2)', borderRadius: 10, padding: '10px' }}
              />

              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-ghost btn-full" onClick={() => setCryptoModal(null)}>Cancel</button>
                <button
                  className="btn btn-primary btn-full"
                  onClick={cryptoModal.mode === 'export' ? handleCryptoExport : handleCryptoImport}
                >
                  {cryptoModal.mode === 'export' ? '🔒 Save Encrypted' : '🔓 Unlock & Import'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* Danger Zone */}
        <div className="dm-section-hdr" style={{ color: 'var(--expense)' }}>Danger Zone</div>
        <div className="dm-card" style={{ margin: '0 0 14px', borderRadius: 0, borderLeft: 'none', borderRight: 'none' }}>
          <div className="dm-row danger-row" onClick={() => setShowDel(true)}>
            <div className="dm-row-icon">🗑️</div>
            <div className="dm-row-content"><div className="dm-row-title" style={{ color: 'var(--expense)' }}>Delete All Transactions &amp; Metadata</div><div className="dm-row-sub">Perform factory reset · deletes all setups</div></div>
          </div>
        </div>

        {/* Delete confirm */}
        {showDel && (
          <>
            <div className="overlay" onClick={() => setShowDel(false)} />
            <div className="bottom-sheet">
              <div className="sheet-handle" />
              <div style={{ textAlign: 'center', padding: '0 var(--page-px) 16px' }}>
                <div style={{ fontSize: '2rem', marginBottom: 10 }}>⚠️</div>
                <div style={{ fontSize: '1rem', fontWeight: 800, marginBottom: 8 }}>Delete all data &amp; metadata?</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 20 }}>
                  This will permanently remove {txnCount.toLocaleString()} transactions, accounts, categories, groups, budgets, and all configuration settings.
                  <br /><br />
                  A CSV backup of your transactions will be automatically exported and downloaded before deletion.
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn btn-ghost btn-full" onClick={() => setShowDel(false)}>Cancel</button>
                  <button className="btn btn-danger btn-full" onClick={async () => {
                    // 1. Export CSV backup
                    const hdrs = ['Date', 'Time', 'Account', 'FromAccount', 'ToAccount', 'Category', 'Subcategory', 'Note', 'Description', 'INR', 'Amount', 'Currency', 'Income/Expense', 'ID'];
                    const esc = v => { const s = String(v ?? ''); return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
                    const rows = [hdrs.join(','), ...transactions.map(t => hdrs.map(h => esc(t[h])).join(','))];
                    await saveFile('\ufeff' + rows.join('\n'), `finman_backup_before_delete_${new Date().toISOString().split('T')[0]}.csv`, 'text/csv;charset=utf-8;');

                    // 2. Clear all tables
                    await clearAllData();
                    setShowDel(false);
                    setStatus({ type: 'success', msg: '✓ Backup downloaded. All transactions and metadata deleted successfully.' });
                  }}>Delete All &amp; Backup</button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Import mode sheet */}
        {showMode && (
          <>
            <div className="overlay" onClick={() => setShowMode(false)} />
            <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 20px)' }}>
              <div className="sheet-handle" />
              <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 4 }}>
                {pendingRows?.length?.toLocaleString()} rows found
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                File: {pendingName}
              </div>

              {/* Duplicate analysis */}
              {analysis && (analysis.fileDupeCount > 0 || analysis.dbDupeCount > 0) && (
                <div style={{ background: 'rgba(255,180,0,0.08)', border: '1px solid rgba(255,180,0,0.3)', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.78rem', color: 'var(--gold)', marginBottom: 6 }}>⚠ Duplicates detected</div>
                  {analysis.fileDupeCount > 0 && (
                    <div style={{ fontSize: '0.73rem', color: 'var(--text-secondary)', marginBottom: 3 }}>
                      • <b>{analysis.fileDupeCount}</b> rows in the file share an identical date/time/account/amount/note combination
                    </div>
                  )}
                  {analysis.dbDupeCount > 0 && (
                    <div style={{ fontSize: '0.73rem', color: 'var(--text-secondary)' }}>
                      • <b>{analysis.dbDupeCount}</b> rows already exist in the app (Merge will skip these)
                    </div>
                  )}
                </div>
              )}

              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 16 }}>
                <b style={{ color: 'var(--green)' }}>Merge</b> — keeps all existing transactions, accounts &amp; categories. Adds only new rows (exact duplicates skipped). <b>Recommended for FinMan exports.</b><br /><br />
                <b style={{ color: 'var(--expense)' }}>Override</b> — ⚠ deletes all existing transactions first, then imports fresh. Settings (accounts, categories) are rebuilt from the file. Use only when starting clean.
              </div>
              <button className="btn btn-primary btn-full" style={{ marginBottom: 8 }} onClick={() => doImport('merge')}>Merge (Recommended)</button>
              <button className="btn btn-danger  btn-full" onClick={() => doImport('override')}>Override — Delete &amp; Replace All</button>
              <button className="btn btn-ghost btn-full" style={{ marginTop: 8 }} onClick={() => { setShowMode(false); setPending(null); setAnalysis(null); setIsBackup(false); }}>Cancel</button>
            </div>
          </>
        )}

        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

// ── Profile & PIN Manager ────────────────────────────────────────────────────
function ProfileManager({ onBack }) {
  const { state, updateSettings } = useApp();
  const [name, setName] = useState(state.settings?.profileName || state.settings?.name || '');
  const [pin, setPin] = useState(state.settings?.pin || '');
  const [newPin, setNewPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState(null);
  const [showClear, setShowClear] = useState(false);

  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [biometricsEnabled, setBiometricsEnabled] = useState(state.settings?.biometricsEnabled === 'true');

  const hasPin = !!pin;

  useEffect(() => {
    const checkBiometrics = async () => {
      try {
        if (window.Capacitor && window.Capacitor.isNativePlatform?.()) {
          const { NativeBiometric } = await import('@capgo/capacitor-native-biometric');
          const result = await NativeBiometric.isAvailable();
          if (result.isAvailable) {
            setBiometricsAvailable(true);
          }
        }
      } catch (err) {
        console.warn('Biometrics check error:', err);
      }
    };
    checkBiometrics();
  }, []);

  const handleBiometricsToggle = async (checked) => {
    if (!hasPin && checked) {
      setMsg({ type: 'error', text: 'Please set a PIN first before enabling Biometrics' });
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    try {
      if (checked) {
        const { NativeBiometric } = await import('@capgo/capacitor-native-biometric');
        await NativeBiometric.verifyIdentity({
          reason: 'Enable biometric unlock for FinMan',
          title: 'Biometric Unlock',
          subtitle: 'Verify identity',
          description: 'Scan your fingerprint or face to enable biometric unlock.',
        });
        await updateSettings({ biometricsEnabled: 'true' });
        setBiometricsEnabled(true);
        setMsg({ type: 'success', text: 'Biometric unlock enabled ✓' });
      } else {
        await updateSettings({ biometricsEnabled: 'false' });
        setBiometricsEnabled(false);
        setMsg({ type: 'success', text: 'Biometric unlock disabled' });
      }
      setTimeout(() => setMsg(null), 2000);
    } catch (err) {
      console.error('Biometrics error:', err);
      setMsg({ type: 'error', text: 'Biometric verification failed' });
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const saveProfile = async () => {
    await updateSettings({ profileName: name.trim(), name: name.trim() });
    setMsg({ type: 'success', text: 'Name saved ✓' });
    setTimeout(() => setMsg(null), 2000);
  };

  const savePin = async () => {
    if (newPin.length < 4 || newPin.length > 6) { setMsg({ type: 'error', text: 'PIN must be 4–6 digits' }); return; }
    if (!/^\d+$/.test(newPin)) { setMsg({ type: 'error', text: 'PIN must be digits only' }); return; }
    if (newPin !== confirm) { setMsg({ type: 'error', text: 'PINs do not match' }); return; }
    await updateSettings({ pin: newPin, pinIdleSeconds: 10 });
    setPin(newPin); setNewPin(''); setConfirm('');
    setMsg({ type: 'success', text: 'PIN set ✓ — app locks after 10s idle' });
    setTimeout(() => setMsg(null), 3000);
  };

  const clearPin = async () => {
    await updateSettings({ pin: '', pinIdleSeconds: 0 });
    setPin(''); setShowClear(false);
    setMsg({ type: 'success', text: 'PIN removed' });
    setTimeout(() => setMsg(null), 2000);
  };

  return (
    <div className="settings-root">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div style={{ flex: 1 }}><div className="page-hdr-title">Profile & Security</div></div>
      </div>

      {msg && (
        <div style={{ margin: '0 var(--page-px) 10px', padding: '10px 14px', borderRadius: 10, background: msg.type === 'success' ? 'var(--income-bg)' : 'var(--expense-bg)', color: msg.type === 'success' ? 'var(--income)' : 'var(--expense)', fontSize: '0.8rem', fontWeight: 700 }}>
          {msg.text}
        </div>
      )}

      {/* Profile name */}
      <div className="settings-group-label">Your Profile</div>
      <div className="settings-card" style={{ padding: '14px var(--page-px)' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>Display Name</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="form-input" style={{ flex: 1 }} value={name} onChange={e => setName(e.target.value)} placeholder="Your name (optional)" spellCheck="true" autoCapitalize="sentences" />
          <button className="btn btn-primary btn-sm" onClick={saveProfile}>Save</button>
        </div>
      </div>

      {/* PIN */}
      <div className="settings-group-label">PIN Lock</div>
      <div className="settings-card" style={{ padding: '14px var(--page-px)' }}>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 12 }}>
          {hasPin ? '🔒 PIN is set. App auto-locks after 10 seconds of inactivity.' : '🔓 No PIN set. Anyone can open the app.'}
        </div>

        {hasPin ? (
          <>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>Change PIN</div>
            <input className="form-input" style={{ marginBottom: 8, letterSpacing: '0.3em' }} type="number" inputMode="numeric" maxLength={6} value={newPin} onChange={e => setNewPin(e.target.value.slice(0, 6))} placeholder="New PIN (4–6 digits)" />
            <input className="form-input" style={{ marginBottom: 12, letterSpacing: '0.3em' }} type="number" inputMode="numeric" maxLength={6} value={confirm} onChange={e => setConfirm(e.target.value.slice(0, 6))} placeholder="Confirm PIN" />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary btn-full" onClick={savePin}>Update PIN</button>
              <button className="btn btn-danger" onClick={() => setShowClear(true)}>Remove</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>Set PIN</div>
            <input className="form-input" style={{ marginBottom: 8, letterSpacing: '0.3em' }} type="number" inputMode="numeric" maxLength={6} value={newPin} onChange={e => setNewPin(e.target.value.slice(0, 6))} placeholder="New PIN (4–6 digits)" />
            <input className="form-input" style={{ marginBottom: 12, letterSpacing: '0.3em' }} type="number" inputMode="numeric" maxLength={6} value={confirm} onChange={e => setConfirm(e.target.value.slice(0, 6))} placeholder="Confirm PIN" />
            <button className="btn btn-primary btn-full" onClick={savePin}>Set PIN</button>
          </>
        )}
      </div>
      
      {/* Biometrics */}
      {window.Capacitor && window.Capacitor.isNativePlatform?.() && (
        <>
          <div className="settings-group-label">Biometric Lock</div>
          <div className="settings-card" style={{ padding: '14px var(--page-px)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ flex: 1, marginRight: 16 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Biometric Unlock</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {!biometricsAvailable 
                    ? '⚠️ Biometric hardware not available or enrolled on this device.'
                    : 'Use fingerprint or face recognition to unlock FinMan.'}
                </div>
              </div>
              <label className="toggle-switch" style={{ opacity: biometricsAvailable ? 1 : 0.4, pointerEvents: biometricsAvailable ? 'auto' : 'none' }}>
                <input type="checkbox" checked={biometricsEnabled} onChange={e => handleBiometricsToggle(e.target.checked)} />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>
        </>
      )}

      {showClear && (
        <>
          <div className="overlay" onClick={() => setShowClear(false)} />
          <div className="bottom-sheet">
            <div className="sheet-handle" />
            <div style={{ textAlign: 'center', padding: '0 var(--page-px) 16px' }}>
              <div style={{ fontSize: '2rem', marginBottom: 8 }}>🔓</div>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>Remove PIN?</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 20 }}>App will no longer lock when idle.</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-ghost btn-full" onClick={() => setShowClear(false)}>Cancel</button>
                <button className="btn btn-danger btn-full" onClick={clearPin}>Remove PIN</button>
              </div>
            </div>
          </div>
        </>
      )}
      <div style={{ height: 40 }} />
    </div>
  );
}

function BudgetsManager({ onBack }) {
  const { state, saveBudget, removeBudget } = useApp();
  const { budgets, categories, transactions } = state;
  const [newCat, setNewCat] = useState('');
  const [newAmt, setNewAmt] = useState('');
  const [newPer, setNewPer] = useState('Monthly');
  const now = new Date();

  const expCats = Object.entries(categories || {}).filter(([, d]) => d.type === 'Expense').map(([n]) => n).sort();

  const getSpend = (catName, period) => {
    let txns = transactions.filter(t => t.Category === catName);
    if (period === 'Monthly') txns = txns.filter(t => { const d = parseDate(t.Date); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); });
    else txns = txns.filter(t => parseDate(t.Date).getFullYear() === now.getFullYear());
    return txns.reduce((s, t) => s + (parseFloat(t.INR || t.Amount) || 0), 0);
  };

  const add = async () => {
    if (!newCat || !newAmt) return;
    await saveBudget(newCat, parseFloat(newAmt), newPer);
    setNewCat(''); setNewAmt('');
  };

  return (
    <div className="sub-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg></button>
        <div className="page-hdr-title">Budgets</div>
      </div>
      <div className="sub-body">
        <div className="mgr-section-label">Set Budget</div>
        <div style={{ padding: '0 var(--page-px) 10px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="form-input" style={{ flex: 2, minWidth: 120 }} value={newCat} onChange={e => setNewCat(e.target.value)}>
            <option value="">Category</option>
            {expCats.map(c => <option key={c}>{c}</option>)}
          </select>
          <input className="form-input" style={{ flex: 1, minWidth: 80 }} type="number" placeholder="Amount" value={newAmt} onChange={e => setNewAmt(e.target.value)} />
          <select className="form-input" style={{ flex: 1, minWidth: 90 }} value={newPer} onChange={e => setNewPer(e.target.value)}>
            <option>Monthly</option><option>Yearly</option>
          </select>
          <button className="btn btn-primary" onClick={add}>Set</button>
        </div>
        {budgets.map(b => {
          const spend = getSpend(b.category, b.period);
          const pct = Math.min(100, b.amount > 0 ? (spend / b.amount) * 100 : 0);
          return (
            <div key={b.category} className="budget-detail-card" style={{ margin: '0 0 8px' }}>
              <div className="budget-detail-top">
                <div className="budget-detail-name">{b.category}</div>
                <div className="budget-detail-period">{b.period}</div>
                <button className="mgr-del-btn" onClick={() => removeBudget(b.category)}>✕</button>
              </div>
              <div className="budget-detail-vals">
                <span style={{ color: pct > 85 ? 'var(--expense)' : 'var(--income)' }}>{formatINR(spend)}</span>
                <span style={{ color: 'var(--text-muted)' }}> / {formatINR(b.amount)}</span>
              </div>
              <div className="progress-track" style={{ marginTop: 8 }}>
                <div className="progress-fill" style={{ width: `${pct}%`, background: pct > 85 ? 'var(--expense)' : 'var(--green)' }} />
              </div>
            </div>
          );
        })}
        {budgets.length === 0 && <div className="mgr-empty" style={{ padding: '16px var(--page-px)' }}>No budgets yet</div>}
        <div className="h-8" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Appearance Manager
// ─────────────────────────────────────────────
function AppearanceManager({ onBack }) {
  const { state, updateSettings, setTheme, setFontSize, setFontFamily, setFontDataWeight } = useApp();
  const { theme, fontSize } = state;
  const fontDataWeight = state.fontDataWeight || 'regular';
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2200); };

  const save = async (updates) => {
    setSaving(true);
    try {
      await updateSettings(updates);
      showToast('Saved ✓');
    } finally {
      setSaving(false);
    }
  };

  const fontOptions = [
    { name: 'Sora', family: "'Sora', sans-serif", preview: 'The quick brown fox jumps over the lazy dog' },
    { name: 'Inter', family: "'Inter', sans-serif", preview: 'The quick brown fox jumps over the lazy dog' },
    { name: 'Roboto', family: "'Roboto', sans-serif", preview: 'The quick brown fox jumps over the lazy dog' },
    { name: 'Open Sans', family: "'Open Sans', sans-serif", preview: 'The quick brown fox jumps over the lazy dog' },
    { name: 'Lato', family: "'Lato', sans-serif", preview: 'The quick brown fox jumps over the lazy dog' },
  ];

  const currentFont = state.fontFamily || 'Sora';
  const fsLabel = fontSize < 0.9 ? 'Small' : fontSize > 1.1 ? 'Large' : 'Medium';

  return (
    <div className="sub-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="page-hdr-title">Appearance</div>
        {saving && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 8 }}>Saving…</span>}
        {toast && <span style={{ fontSize: '0.7rem', color: 'var(--green)', marginLeft: 8 }}>{toast}</span>}
      </div>

      <div className="sub-body">
        {/* Theme */}
        <div className="mgr-section-label">Theme</div>
        <div className="settings-card" style={{ margin: '0 var(--page-px) 16px' }}>
          <div className="settings-row" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            <div className="settings-row-icon" style={{ background: theme === 'dark' ? 'var(--bg-card2)' : '#fff3cd' }}>
              {theme === 'dark' ? '🌙' : '☀️'}
            </div>
            <div className="settings-row-content">
              <div className="settings-row-title">Theme</div>
              <div className="settings-row-sub">{theme === 'dark' ? 'Dark' : 'Light'} — tap to switch</div>
            </div>
            <div style={{ padding: '4px 10px', borderRadius: 'var(--r-full)', background: theme === 'dark' ? 'var(--bg-card2)' : 'var(--bg-card)', border: '1px solid var(--border)', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
              {theme === 'dark' ? 'Dark' : 'Light'}
            </div>
          </div>
        </div>

        {/* Font Size */}
        <div className="mgr-section-label">Font Size</div>
        <div className="settings-card" style={{ margin: '0 var(--page-px) 16px' }}>
          <div style={{ padding: '12px var(--page-px)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>Font Size</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{fsLabel} ({Math.round(fontSize * 100)}%)</div>
            </div>
            <div className="font-scale-row" style={{ padding: 0 }}>
              <span className="font-scale-label" style={{ fontSize: '0.65rem' }}>A</span>
              <input type="range" className="fs-slider" min="0.75" max="1.25" step="0.05"
                value={fontSize}
                onChange={e => setFontSize(parseFloat(e.target.value))}
                onMouseUp={e => setFontSize(parseFloat(e.target.value))} />
              <span className="font-scale-label" style={{ fontSize: '1rem' }}>A</span>
            </div>
          </div>
        </div>

        {/* Font Weight */}
        <div className="mgr-section-label">Content Font Weight</div>
        <div className="settings-card" style={{ margin: '0 var(--page-px) 16px' }}>
          <div style={{ padding: '12px var(--page-px)' }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 12 }}>
              Applies to transaction notes, amounts, account names, category names. Headings and labels are unaffected.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { key: 'light', label: 'Light', fw: '400', desc: 'Airy & minimal' },
                { key: 'regular', label: 'Regular', fw: '500', desc: 'Balanced' },
                { key: 'bold', label: 'Bold', fw: '700', desc: 'High contrast' },
              ].map(opt => (
                <div key={opt.key}
                  onClick={() => setFontDataWeight(opt.key)}
                  style={{
                    flex: 1, borderRadius: 10, border: `2px solid ${fontDataWeight === opt.key ? 'var(--accent)' : 'var(--border)'}`,
                    background: fontDataWeight === opt.key ? 'rgba(0,229,160,0.08)' : 'var(--bg-card2)',
                    padding: '10px 8px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s',
                  }}>
                  <div style={{ fontFamily: 'var(--font)', fontSize: '1rem', fontWeight: opt.fw, color: fontDataWeight === opt.key ? 'var(--accent)' : 'var(--text-primary)', marginBottom: 4 }}>
                    ₹1,234
                  </div>
                  <div style={{ fontSize: '0.72rem', fontWeight: opt.fw, color: fontDataWeight === opt.key ? 'var(--accent)' : 'var(--text-primary)', marginBottom: 2 }}>
                    {opt.label}
                  </div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                    {opt.desc}
                  </div>
                </div>
              ))}
            </div>
            {/* Live preview */}
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>Preview</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: '0.8rem', fontWeight: fontDataWeight === 'light' ? 400 : fontDataWeight === 'regular' ? 500 : 700, color: 'var(--text-primary)' }}>Groceries · Milk</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2 }}>10:30 am · To Home</div>
                </div>
                <div style={{ fontFamily: 'var(--font)', fontSize: '0.78rem', fontWeight: fontDataWeight === 'light' ? 400 : fontDataWeight === 'regular' ? 500 : 700, color: 'var(--expense)' }}>−₹250</div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: fontDataWeight === 'light' ? 400 : fontDataWeight === 'regular' ? 500 : 700, color: 'var(--text-primary)' }}>HDFC</div>
                <div style={{ fontFamily: 'var(--font)', fontSize: '0.78rem', fontWeight: fontDataWeight === 'light' ? 400 : fontDataWeight === 'regular' ? 500 : 700, color: 'var(--income)' }}>+₹9,67,413</div>
              </div>
            </div>
          </div>
        </div>

        {/* Font Family */}
        <div className="mgr-section-label">Font Family</div>
        <div className="settings-card" style={{ margin: '0 var(--page-px) 16px' }}>
          {fontOptions.map((font) => (
            <div key={font.name} className="settings-row" onClick={() => setFontFamily(font.name)}>
              <div className="settings-row-icon" style={{ background: 'rgba(167,139,250,0.15)' }}>
                {currentFont === font.name ? '✓' : 'Aa'}
              </div>
              <div className="settings-row-content">
                <div className="settings-row-title">{font.name}</div>
                <div className="settings-row-sub" style={{
                  fontFamily: font.family,
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                  marginTop: 4
                }}>
                  {font.preview}
                </div>
              </div>
              {currentFont === font.name && (
                <div style={{ color: 'var(--green)', fontSize: '1.2rem' }}>✓</div>
              )}
            </div>
          ))}
        </div>

        <div className="h-8" />
      </div>
    </div>
  );
}


// ── RecurringManager — Repeat rules only (instalments are pre-created, no management needed)
function RecurringManager({ onBack }) {
  const { state, modifyRecurringRule, removeRecurringRule } = useApp();
  // Only show repeat rules (instalment rules have status='completed' already)
  const rules = (state.recurringRules || []).filter(r => r.rule_type === 'repeat');
  const [confirmDelete, setConfirmDelete] = React.useState(null);

  const active = rules.filter(r => r.status === 'active');
  const paused = rules.filter(r => r.status === 'paused');
  const completed = rules.filter(r => r.status === 'cancelled');

  // next_date stored as YYYY-MM-DD
  const fmtDate = (d) => {
    if (!d || d === '') return '—';
    const parts = d.split('-');
    if (parts.length !== 3) return d;
    const [y, m, day] = parts;
    return `${day}/${m}/${y.slice(2)}`;
  };

  const FREQ_LABELS = {
    daily: 'Daily', weekly: 'Weekly', fortnightly: 'Every 2 weeks',
    monthly: 'Monthly', '3months': 'Every 3 months', '6months': 'Every 6 months', annually: 'Annually'
  };

  const RuleRow = ({ rule }) => {
    const nextLabel = rule.next_date && rule.next_date !== '' ? `Next: ${fmtDate(rule.next_date)}` : '';
    return (
      <div style={{ padding: '12px var(--page-px)', borderBottom: '1px solid var(--border-light)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '1rem' }}>🔁</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {rule.base_note || 'Repeat'}
            </div>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>
              {FREQ_LABELS[rule.frequency] || rule.frequency}
              {' · '}{rule.schedule_mode === 'start_of_month' ? 'Start of month' : 'On date'}
              {' · '}₹{rule.amount_per_part}
              {nextLabel ? ` · ${nextLabel}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {rule.status === 'active' && (
              <button className="btn btn-sm btn-secondary"
                onClick={() => modifyRecurringRule(rule.id, { status: 'paused' })}>Pause</button>
            )}
            {rule.status === 'paused' && (
              <button className="btn btn-sm btn-primary"
                onClick={() => modifyRecurringRule(rule.id, { status: 'active' })}>Resume</button>
            )}
            <button className="btn btn-sm btn-danger"
              onClick={() => setConfirmDelete(rule)}>✕</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="sub-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="page-hdr-title">Recurring</div>
      </div>
      <div className="sub-body">
        {rules.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 60 }}>
            <div className="empty-icon">🔁</div>
            <div className="empty-title">No recurring rules</div>
            <div className="empty-desc">Add a transaction with 🔁 Repeat to see it here</div>
          </div>
        ) : (
          <>
            {active.length > 0 && (
              <>
                <div className="mgr-section-label">Active ({active.length})</div>
                <div className="settings-card" style={{ margin: '0 var(--page-px) 12px' }}>
                  {active.map(r => <RuleRow key={r.id} rule={r} />)}
                </div>
              </>
            )}
            {paused.length > 0 && (
              <>
                <div className="mgr-section-label">Paused ({paused.length})</div>
                <div className="settings-card" style={{ margin: '0 var(--page-px) 12px' }}>
                  {paused.map(r => <RuleRow key={r.id} rule={r} />)}
                </div>
              </>
            )}
            {completed.length > 0 && (
              <>
                <div className="mgr-section-label">Completed / Cancelled ({completed.length})</div>
                <div className="settings-card" style={{ margin: '0 var(--page-px) 12px', opacity: 0.6 }}>
                  {completed.map(r => <RuleRow key={r.id} rule={r} />)}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {confirmDelete && (
        <>
          <div className="overlay" onClick={() => setConfirmDelete(null)} />
          <div className="bottom-sheet">
            <div className="sheet-handle" />
            <div style={{ textAlign: 'center', padding: '0 var(--page-px) 16px' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: 8 }}>
                {confirmDelete.rule_type === 'instalment' ? '📋' : '🔁'}
              </div>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>
                Stop repeating?
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 20 }}>
                The rule will be removed. Transactions already created are kept. No new occurrences will run.
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-ghost btn-full" onClick={() => setConfirmDelete(null)}>Keep</button>
                <button className="btn btn-danger btn-full" onClick={async () => {
                  await modifyRecurringRule(confirmDelete.id, { status: 'cancelled' });
                  setConfirmDelete(null);
                }}>Cancel rule</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Main Settings screen
// ─────────────────────────────────────────────
export default function Settings({ backInterceptRef } = {}) {
  const { state } = useApp();
  // Check if we navigated here from AddTransaction to reorder accounts/categories
  const [screen, setScreen] = useState(null);

  // Register Android back intercept for sub-screens
  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (screen) {
      backInterceptRef.current = () => setScreen(null);
    } else {
      backInterceptRef.current = null;
    }
    return () => { if (backInterceptRef) backInterceptRef.current = null; };
  }, [screen, backInterceptRef]);

  // Handle double-tap reset for Settings tab
  useEffect(() => {
    const handleReset = () => {
      setScreen(null);
    };
    window.addEventListener('reset-settings-view', handleReset);
    return () => window.removeEventListener('reset-settings-view', handleReset);
  }, []);


  if (screen === 'recurring') return <RecurringManager onBack={() => setScreen(null)} />;
  if (screen === 'data') return <DataManager onBack={() => setScreen(null)} />;
  if (screen === 'tags') return <TagsManager onBack={() => setScreen(null)} />;
  if (screen === 'groups') return <GroupSplitManager onBack={() => setScreen(null)} backInterceptRef={backInterceptRef} />;
  if (screen === 'warranty') return <WarrantyLocker onBack={() => setScreen(null)} backInterceptRef={backInterceptRef} />;
  if (screen === 'accounts') return <AccountsManager onBack={() => setScreen(null)} />;
  if (screen === 'categories') return <CategoriesManager onBack={() => setScreen(null)} />;
  if (screen === 'budgets') return <BudgetsManager onBack={() => setScreen(null)} />;
  if (screen === 'profile') return <ProfileManager onBack={() => setScreen(null)} />;
  if (screen === 'appearance') return <AppearanceManager onBack={() => setScreen(null)} />;

  const txnCount = state.transactions.length;
  const acctCount = (state.accounts || []).length;
  const catCount = Object.keys(state.categories || {}).length;

  return (
    <div className="settings-root">
      <div className="settings-title-row">
        <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>Settings</div>
      </div>

      {/* Profile card — top of settings */}
      <div className="settings-profile-card" onClick={() => setScreen('profile')}>
        <div className="settings-profile-avatar">
          {(state.settings?.profileName || state.settings?.name || 'A').trim().charAt(0).toUpperCase()}
        </div>
        <div className="settings-profile-info">
          <div className="settings-profile-name">{state.settings?.profileName || state.settings?.name || 'Your Name'}</div>
          <div className="settings-profile-sub">{state.settings?.pin ? '🔒 PIN enabled' : 'Finance Manager v2'}</div>
        </div>
        <button className="settings-profile-edit-btn" onClick={e => { e.stopPropagation(); setScreen('profile'); }}>Edit</button>
      </div>

      {/* Appearance */}
      <div className="settings-group-label">Appearance</div>
      <div className="settings-card">
        <div className="settings-row" onClick={() => setScreen('appearance')}>
          <div className="settings-row-icon" style={{ background: 'rgba(255,193,7,0.15)' }}>🎨</div>
          <div className="settings-row-content"><div className="settings-row-title">Appearance</div><div className="settings-row-sub">Theme, font size, and font family</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6" /></svg>
        </div>
      </div>

      {/* Data */}
      <div className="settings-group-label">Data</div>
      <div className="settings-card">
        <div className="settings-row" onClick={() => setScreen('data')}>
          <div className="settings-row-icon" style={{ background: 'rgba(77,159,255,0.15)' }}>📊</div>
          <div className="settings-row-content"><div className="settings-row-title">Data Management</div><div className="settings-row-sub">{txnCount.toLocaleString()} transactions · Encrypted Backups</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6" /></svg>
        </div>
      </div>

      {/* Manage */}
      <div className="settings-group-label">Manage</div>
      <div className="settings-card">
        <div className="settings-row" onClick={() => setScreen('groups')}>
          <div className="settings-row-icon" style={{ background: 'rgba(0,229,160,0.15)' }}>👥</div>
          <div className="settings-row-content"><div className="settings-row-title">Group Splits &amp; Trips</div><div className="settings-row-sub">Splitwise-style trip expenses, debt simplification &amp; slips</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6" /></svg>
        </div>
        <div className="settings-row" onClick={() => setScreen('warranty')}>
          <div className="settings-row-icon" style={{ background: 'rgba(0,229,160,0.15)' }}>🛡️</div>
          <div className="settings-row-content"><div className="settings-row-title">Warranty &amp; Receipts</div><div className="settings-row-sub">Track gadget warranty expiries and bill photos</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6" /></svg>
        </div>
        <div className="settings-row" onClick={() => setScreen('recurring')}>
          <div className="settings-row-icon" style={{ background: 'rgba(99,179,237,0.15)' }}>🔁</div>
          <div className="settings-row-content">
            <div className="settings-row-title">Recurring</div>
            <div className="settings-row-sub">{(state.recurringRules || []).filter(r => r.rule_type === 'repeat' && r.status === 'active').length} active repeat rules</div>
          </div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6" /></svg>
        </div>
        <div className="settings-row" onClick={() => setScreen('tags')}>
          <div className="settings-row-icon" style={{ background: 'rgba(0,229,160,0.15)' }}>#️⃣</div>
          <div className="settings-row-content"><div className="settings-row-title">Tags &amp; Hashtags</div><div className="settings-row-sub">Manage, rename, and clean cross-cutting tags</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6" /></svg>
        </div>
        <div className="settings-row" onClick={() => setScreen('accounts')}>
          <div className="settings-row-icon" style={{ background: 'rgba(0,229,160,0.12)' }}>💳</div>
          <div className="settings-row-content"><div className="settings-row-title">Accounts</div><div className="settings-row-sub">{acctCount} accounts</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6" /></svg>
        </div>
        <div className="settings-row" onClick={() => setScreen('categories')}>
          <div className="settings-row-icon" style={{ background: 'rgba(167,139,250,0.15)' }}>🏷️</div>
          <div className="settings-row-content"><div className="settings-row-title">Categories</div><div className="settings-row-sub">{catCount} categories</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6" /></svg>
        </div>
        <div className="settings-row" onClick={() => setScreen('budgets')}>
          <div className="settings-row-icon" style={{ background: 'rgba(255,209,102,0.15)' }}>🎯</div>
          <div className="settings-row-content"><div className="settings-row-title">Budgets</div><div className="settings-row-sub">{state.budgets?.length || 0} budgets set</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6" /></svg>
        </div>
      </div>

      {/* About */}
      <div className="settings-group-label">About</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-icon" style={{ background: 'rgba(0,229,160,0.12)' }}>💰</div>
          <div className="settings-row-content"><div className="settings-row-title">FinMan</div><div className="settings-row-sub">v2.2.1.3 — Built for you by Akbar 💚</div></div>
        </div>
      </div>

      <div className="h-8" />
    </div>
  );
}