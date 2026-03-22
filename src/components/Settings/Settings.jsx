import React, { useState, useMemo, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, parseDate } from '../../utils/format.js';
import './Settings.css';

// ─────────────────────────────────────────────
// Kanban drag-drop with intra-column reordering
// ─────────────────────────────────────────────
function Kanban({ columns, items, getItemGroup, getItemLabel, onMove, onReorder, unassignedLabel = 'Ungrouped' }) {
  const [dragging,   setDragging]   = useState(null);
  const [overCol,    setOverCol]    = useState(null);
  const [overItem,   setOverItem]   = useState(null);
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
    const realTo   = toCol === '__unassigned' ? '' : toCol;
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
          className={`kanban-col ${overCol===col?'kanban-drop-active':''}`}
          onDragOver={e=>{e.preventDefault();setOverCol(col);}}
          onDragLeave={()=>setOverCol(null)}
          onDrop={()=>handleDrop(col)}
        >
          <div className="kanban-col-header">{col==='__unassigned'?unassignedLabel:col}</div>
          <div className="kanban-col-items">
            {(grouped[col]||[]).map(item=>(
              <div key={getItemLabel(item)}
                className={`kanban-card ${dragging?.item===item?'dragging':''} ${overItem===item&&dragging?.fromCol===col?'kanban-over-item':''}`}
                draggable
                onDragStart={()=>setDragging({item,fromCol:col})}
                onDragEnd={()=>{setDragging(null);setOverCol(null);setOverItem(null);}}
                onDragOver={e=>{e.preventDefault();e.stopPropagation();setOverItem(item);}}
              >
                <span style={{fontSize:'0.7rem',marginRight:2,opacity:0.5}}>⠿</span>
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
function AccountsManager({ onBack }) {
  const { state, updateSettings, renameAccount } = useApp();
  const [accounts, setAccounts]       = useState(() => (state.accounts||[]).map(a=>typeof a==='string'?{name:a,group:'',icon:'💳',acctType:'',settlementDate:0,paymentDueDays:0}:a));
  const [groups,   setGroups]         = useState(() => state.accountGroups||[]);
  const [newAcct,  setNewAcct]        = useState('');
  const [newGrp,   setNewGrp]         = useState('');
  const [editIdx,       setEditIdx]       = useState(null);
  const [editName,      setEditName]      = useState('');
  const [editGrp,       setEditGrp]       = useState('');
  const [editAcctType,  setEditAcctType]  = useState('');
  const [editSettleDay, setEditSettleDay] = useState('');
  const [editPayDays,   setEditPayDays]   = useState('');
  const [editErrors,    setEditErrors]    = useState({});
  const [tabMode,   setTabMode]       = useState('list'); // 'list' | 'kanban'
  const [saving,    setSaving]        = useState(false);
  const [toast,     setToast]         = useState('');
  const [editGrpIdx,setEditGrpIdx]    = useState(null);  // index of group being renamed
  const [editGrpName,setEditGrpName]  = useState('');
  const dragIdx    = useRef(null);
  const grpDragIdx = useRef(null);

  const uniqueGroups = useMemo(() => [...new Set(groups)], [groups]);
  const uniqueAccounts = useMemo(() => {
    const seen = new Set();
    return accounts.filter(acc => {
        const duplicate = seen.has(acc.name);
        seen.add(acc.name);
        return !duplicate;
    });
  }, [accounts]);

  const showToast = (msg) => { setToast(msg); setTimeout(()=>setToast(''),2200); };

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
    const upd = accounts.map(a => a.group===g ? {...a,group:''} : a);
    const grps = groups.filter(x=>x!==g);
    setAccounts(upd); setGroups(grps); save(upd, grps);
  };

  // Rename group
  const startEditGrp = (i) => { setEditGrpIdx(i); setEditGrpName(groups[i]); };
  const saveEditGrp = () => {
    const newName = editGrpName.trim();
    if (!newName || newName === groups[editGrpIdx]) { setEditGrpIdx(null); return; }
    const old = groups[editGrpIdx];
    const grps = groups.map((g, i) => i === editGrpIdx ? newName : g);
    const accts = accounts.map(a => a.group === old ? {...a, group: newName} : a);
    setGroups(grps); setAccounts(accts); setEditGrpIdx(null);
    save(accts, grps);
  };

  // Group drag reorder
  const onGrpDragStart = (i) => { grpDragIdx.current = i; };
  const onGrpDragOver  = (e, i) => {
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
    if (!t || accounts.some(a=>a.name===t)) return;
    const upd = [...accounts, {name:t,group:'',icon:'💳',acctType:'',settlementDate:0,paymentDueDays:0}];
    setAccounts(upd); setNewAcct(''); save(upd);
  };

  const removeAccount = (name) => {
    const upd = accounts.filter(a=>a.name!==name);
    setAccounts(upd); save(upd);
  };

  // Only suggest CC if name contains 'credit' — never trigger on 'card', 'cc' alone
  const looksLikeCC = (name) => /\bcredit\b/i.test(name);

  const startEdit = (i) => {
    const a = accounts[i];
    // If acctType is explicitly set (even ''), respect it — don't override with name detection
    // acctType === undefined/null means old account before feature: suggest from name
    const hasExplicitType = a.acctType !== undefined && a.acctType !== null;
    const inferredType = hasExplicitType ? a.acctType : (looksLikeCC(a.name) ? 'Credit Card' : '');
    setEditIdx(i);
    setEditName(a.name);
    setEditGrp(a.group || '');
    setEditAcctType(inferredType);
    setEditSettleDay(a.settlementDate ? String(a.settlementDate) : '');
    setEditPayDays(a.paymentDueDays ? String(a.paymentDueDays) : '');
    setEditErrors({});
  };

  const saveEdit = async () => {
    if (!editName.trim()) return;
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
    const old = accounts[editIdx].name;
    const upd = accounts.map((a,i) => i===editIdx ? {
      ...a,
      name:           editName.trim(),
      group:          editGrp,
      acctType:       isCC ? 'Credit Card' : '',
      settlementDate: isCC ? parseInt(editSettleDay, 10) : 0,
      paymentDueDays: isCC ? parseInt(editPayDays, 10)  : 0,
    } : a);
    setAccounts(upd); setEditIdx(null);
    if (old !== editName.trim()) await renameAccount(old, editName.trim());
    await save(upd);
  };

  // Account drag reorder
  const onDragStart = (i) => { dragIdx.current = i; };
  const onDragOver  = (e, i) => {
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
    const upd = accounts.map(a => a.name===item.name ? {...a,group:newGroup} : a);
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div className="page-hdr-title">Accounts</div>
        {saving && <span style={{fontSize:'0.7rem',color:'var(--text-muted)',marginLeft:8}}>Saving…</span>}
        {toast  && <span style={{fontSize:'0.7rem',color:'var(--green)',marginLeft:8}}>{toast}</span>}
      </div>

      <div className="sub-body">
        {/* Groups section */}
        <div className="mgr-section-label">Account Groups</div>
        <div style={{display:'flex',gap:8,padding:'0 var(--page-px) 8px'}}>
          <input className="form-input" style={{flex:1}} placeholder="New group name" value={newGrp} onChange={e=>setNewGrp(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addGroup()} spellCheck="true" autoCapitalize="sentences"/>
          <button className="btn btn-primary btn-sm" onClick={addGroup}>Add</button>
        </div>
        {uniqueGroups.length > 0 && (
          <div className="mgr-list">
            {uniqueGroups.map((g,gi)=>(
              <div key={g}>
                <div className="mgr-list-row"
                  draggable
                  onDragStart={()=>onGrpDragStart(gi)}
                  onDragOver={e=>onGrpDragOver(e,gi)}
                  onDragEnd={onGrpDragEnd}
                >
                  <span className="mgr-drag-handle">⠿</span>
                  <span style={{fontSize:'1rem',marginRight:4}}>📁</span>
                  <div className="mgr-list-name" style={{flex:1}}>{g}</div>
                  <button className="mgr-edit-btn" onClick={()=>editGrpIdx===gi?setEditGrpIdx(null):startEditGrp(gi)}>✏️</button>
                  <button className="mgr-del-btn" onClick={()=>removeGroup(g)}>✕</button>
                </div>
                {editGrpIdx===gi&&(
                  <div className="mgr-edit-panel">
                    <div className="mgr-edit-label">Rename Group</div>
                    <input className="form-input" value={editGrpName} onChange={e=>setEditGrpName(e.target.value)} style={{marginBottom:8}} spellCheck="true" autoCapitalize="sentences"/>
                    <div style={{display:'flex',gap:8}}>
                      <button className="btn btn-ghost btn-sm" onClick={()=>setEditGrpIdx(null)}>Cancel</button>
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
          <span style={{float:'right',fontWeight:400,textTransform:'none',letterSpacing:0,fontSize:'0.65rem',opacity:0.6}}>⠿ drag to set picker order</span>
        </div>
        <div style={{display:'flex',gap:8,padding:'0 var(--page-px) 8px'}}>
          <input className="form-input" style={{flex:1}} placeholder="Account name" value={newAcct} onChange={e=>setNewAcct(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addAccount()} spellCheck="true" autoCapitalize="sentences"/>
          <button className="btn btn-primary btn-sm" onClick={addAccount}>Add</button>
        </div>

        {/* Tab toggle */}
        <div className="mgr-tabs" style={{padding:'0 var(--page-px) 8px',display:'flex',gap:6}}>
          <button className={`mgr-tab-btn ${tabMode==='list'?'active':''}`} onClick={()=>setTabMode('list')}>List</button>
          <button className={`mgr-tab-btn ${tabMode==='kanban'?'active':''}`} onClick={()=>setTabMode('kanban')}>Kanban</button>
        </div>

        {tabMode==='kanban' ? (
          <Kanban
            columns={uniqueGroups}
            items={uniqueAccounts}
            getItemGroup={a=>a.group||''}
            getItemLabel={a=>a.name}
            onMove={handleKanbanMove}
            onReorder={handleKanbanReorder}
            unassignedLabel="Ungrouped"
          />
        ) : (() => {
          // Build grouped sections preserving flat indices for drag/edit/delete
          const sections = [];
          uniqueGroups.forEach(grp => {
            const items = uniqueAccounts.map((a,i)=>({a,i})).filter(({a})=>(a.group||'')===grp);
            if (items.length) sections.push({ label:grp, icon:'📁', items });
          });
          const ungrouped = uniqueAccounts.map((a,i)=>({a,i})).filter(({a})=>!a.group||!uniqueGroups.includes(a.group));
          if (ungrouped.length) sections.push({ label:'Ungrouped', icon:'📋', items:ungrouped, muted:true });

          const renderEditPanel = (i) => (
            <div className="mgr-edit-panel">
              <div className="mgr-edit-label">Edit Account</div>
              <div className="form-group" style={{marginBottom:8}}>
                <label className="form-label">Name</label>
                <input className="form-input" value={editName} onChange={e=>setEditName(e.target.value)} spellCheck="true" autoCapitalize="sentences"/>
                <div className="mgr-edit-warn">⚠ Renaming updates all transactions</div>
              </div>
              <div className="form-group" style={{marginBottom:8}}>
                <label className="form-label">Group</label>
                <select className="form-input" value={editGrp} onChange={e=>setEditGrp(e.target.value)}>
                  <option value="">No group</option>
                  {uniqueGroups.map(g=><option key={g}>{g}</option>)}
                </select>
              </div>
              <div className="form-group" style={{marginBottom:8}}>
                <label className="form-label">Account Type</label>
                <select className="form-input" value={editAcctType} onChange={e=>{ setEditAcctType(e.target.value); setEditErrors({}); }}>
                  <option value="">Regular</option>
                  <option value="Credit Card">💳 Credit Card</option>
                </select>
              </div>
              {editAcctType === 'Credit Card' && (
                <div className="cc-config-panel">
                  <div className="cc-config-title">💳 Credit Card Settings</div>
                  <div className="form-group" style={{marginBottom:8}}>
                    <label className="form-label">Statement / Settlement Date <span className="form-label-hint">(day of month bill closes)</span></label>
                    <input
                      className={`form-input${editErrors.settlementDate?' input-error':''}`}
                      type="number" inputMode="numeric" min="1" max="28"
                      placeholder="e.g. 18"
                      value={editSettleDay}
                      onChange={e=>{ setEditSettleDay(e.target.value); setEditErrors(p=>({...p,settlementDate:''})); }}
                    />
                    {editErrors.settlementDate && <div className="form-error">{editErrors.settlementDate}</div>}
                    <div className="form-hint">
                      {editSettleDay && !editErrors.settlementDate && (()=>{
                        const sd=parseInt(editSettleDay,10);
                        if(sd>=1&&sd<=28){
                          const now=new Date(),cy=now.getFullYear(),cm=now.getMonth(),cd=now.getDate();
                          let cycleStart,cycleEnd;
                          if(cd>=sd){cycleStart=new Date(cy,cm,sd);cycleEnd=new Date(cy,cm+1,sd-1);}
                          else{cycleStart=new Date(cy,cm-1,sd);cycleEnd=new Date(cy,cm,sd-1);}
                          const fmt=d=>d.toLocaleDateString('en-IN',{day:'numeric',month:'short'});
                          return <span>Current billing cycle: <strong>{fmt(cycleStart)} – {fmt(cycleEnd)}</strong></span>;
                        }
                        return null;
                      })()}
                    </div>
                  </div>
                  <div className="form-group" style={{marginBottom:8}}>
                    <label className="form-label">Payment Due Days <span className="form-label-hint">(days after statement date)</span></label>
                    <input
                      className={`form-input${editErrors.paymentDueDays?' input-error':''}`}
                      type="number" inputMode="numeric" min="1" max="30"
                      placeholder="e.g. 18"
                      value={editPayDays}
                      onChange={e=>{ setEditPayDays(e.target.value); setEditErrors(p=>({...p,paymentDueDays:''})); }}
                    />
                    {editErrors.paymentDueDays && <div className="form-error">{editErrors.paymentDueDays}</div>}
                    <div className="form-hint">
                      {editSettleDay && editPayDays && !editErrors.settlementDate && !editErrors.paymentDueDays && (()=>{
                        const sd=parseInt(editSettleDay,10),pd=parseInt(editPayDays,10);
                        if(sd>=1&&sd<=28&&pd>=1&&pd<=30){
                          const now=new Date(),cy=now.getFullYear(),cm=now.getMonth(),cd=now.getDate();
                          let stmtDate;
                          if(cd>=sd) stmtDate=new Date(cy,cm,sd); else stmtDate=new Date(cy,cm-1,sd);
                          const dueDate=new Date(stmtDate); dueDate.setDate(dueDate.getDate()+pd);
                          return <span>Last due date: <strong>{dueDate.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</strong></span>;
                        }
                        return null;
                      })()}
                    </div>
                  </div>
                </div>
              )}
              <div style={{display:'flex',gap:8}}>
                <button className="btn btn-ghost btn-sm" onClick={()=>setEditIdx(null)}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
              </div>
            </div>
          );

          return (
            <div className="mgr-list">
              {uniqueAccounts.length === 0 && <div className="mgr-empty">No accounts yet</div>}
              {sections.map(({label,icon,items,muted})=>(
                <div key={label}>
                  <div className="mgr-acct-group-header" style={muted?{opacity:0.55}:{}}>
                    <span>{icon} {label}</span>
                    <span className="mgr-acct-group-count">{items.length}</span>
                  </div>
                  {items.map(({a,i})=>(
                    <div key={a.name}
                      draggable
                      onDragStart={()=>onDragStart(i)}
                      onDragOver={e=>onDragOver(e,i)}
                      onDragEnd={onDragEnd}
                    >
                      <div className="mgr-list-row mgr-list-row-indented">
                        <span className="mgr-drag-handle">⠿</span>
                        <div className="mgr-list-content" style={{flex:1}}>
                          <div className="mgr-list-name">{a.name}</div>
                          {a.acctType==='Credit Card'&&(
                            <div style={{fontSize:'0.63rem',color:'var(--accent)',fontWeight:700}}>
                              💳 Credit Card{a.settlementDate?` · settles ${a.settlementDate}th`:''}
                            </div>
                          )}
                        </div>
                        <button className="mgr-edit-btn" onClick={()=>editIdx===i?setEditIdx(null):startEdit(i)}>✏️</button>
                        <button className="mgr-del-btn"  onClick={()=>removeAccount(a.name)}>✕</button>
                      </div>
                      {editIdx===i && renderEditPanel(i)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          );
        })()}
        <div className="h-8"/>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Categories Manager
// ─────────────────────────────────────────────
function CategoriesManager({ onBack }) {
  const { state, updateSettings, renameCategory } = useApp();
  const [cats,    setCats]    = useState(() => {
    // Use categoriesArr (DB sort_order preserved) if available, else fall back to categories object
    const arr = state.categoriesArr;
    if (arr && arr.length > 0) {
      return arr.map(c => ({name:c.name, type:c.type||'Expense', subcategories:(c.subcategories||[]).map(s=>s.name||s)}));
    }
    const obj = state.categories||{};
    return Object.entries(obj).map(([name,d])=>({name,type:d.type||'Expense',subcategories:(d.subcategories||[]).map(s=>s)}));
  });
  const [tabMode, setTabMode] = useState('list');
  const [newCat,  setNewCat]  = useState('');
  const [newType, setNewType] = useState('Expense');
  const [newSub,  setNewSub]  = useState('');
  const [newSubParent,setNSP] = useState('');
  const [editCat, setEditCat] = useState(null); // {i, j?} — j=sub index
  const [editName,setEditName]= useState('');
  const [saving,  setSaving]  = useState(false);
  const [toast,   setToast]   = useState('');
  const dragIdx = useRef(null);

  const showToast = (msg) => { setToast(msg); setTimeout(()=>setToast(''),2200); };

  const catsObj = useMemo(() => {
    const o={};
    for(const c of cats) o[c.name]={type:c.type,subcategories:c.subcategories};
    return o;
  }, [cats]);

  const save = async (updated = cats) => {
    setSaving(true);
    // Pass sortOrder so replaceCategories preserves drag order in DB
    const o={};
    for(const [i,c] of updated.entries()) o[c.name]={type:c.type,subcategories:c.subcategories,sortOrder:i};
    try { await updateSettings({categories:o}); showToast('Saved ✓'); }
    finally { setSaving(false); }
  };

  const addCat = () => {
    const t=newCat.trim();
    if(!t||cats.some(c=>c.name===t)) return;
    const upd=[...cats,{name:t,type:newType,subcategories:[]}];
    setCats(upd); setNewCat(''); save(upd);
  };

  const removeCat = (i) => { const upd=cats.filter((_,idx)=>idx!==i); setCats(upd); save(upd); };

  const addSub = () => {
    const t=newSub.trim();
    if(!t||!newSubParent) return;
    const upd=cats.map(c=>c.name===newSubParent&&!c.subcategories.includes(t)?{...c,subcategories:[...c.subcategories,t]}:c);
    setCats(upd); setNewSub(''); save(upd);
  };

  const removeSub = (ci, si) => { const upd=cats.map((c,i)=>i===ci?{...c,subcategories:c.subcategories.filter((_,j)=>j!==si)}:c); setCats(upd); save(upd); };

  const startEditCat = (i)   => { setEditCat({i}); setEditName(cats[i].name); };
  const startEditSub = (i,j) => { setEditCat({i,j}); setEditName(cats[i].subcategories[j]); };

  const saveEdit = async () => {
    const newName=editName.trim();
    if(!newName) return;
    const {i,j}=editCat;
    if(j===undefined) {
      const old=cats[i].name;
      const upd=cats.map((c,idx)=>idx===i?{...c,name:newName}:c);
      setCats(upd); setEditCat(null);
      if(old!==newName) await renameCategory(old,newName);
      await save(upd);
    } else {
      const oldSub=cats[i].subcategories[j];
      const upd=cats.map((c,idx)=>idx===i?{...c,subcategories:c.subcategories.map((s,si)=>si===j?newName:s)}:c);
      setCats(upd); setEditCat(null);
      if(oldSub!==newName) await renameCategory(cats[i].name,cats[i].name,oldSub,newName);
      await save(upd);
    }
  };

  // Drag reorder categories
  const onDragStart=(i)=>{dragIdx.current=i;};
  const onDragOver=(e,i)=>{e.preventDefault();if(dragIdx.current===null||dragIdx.current===i)return;const upd=[...cats];const[moved]=upd.splice(dragIdx.current,1);upd.splice(i,0,moved);dragIdx.current=i;setCats(upd);};
  const onDragEnd=()=>{dragIdx.current=null;save();};

  // Kanban: move subcategory to different parent category
  const allSubItems = useMemo(() => cats.flatMap(c => c.subcategories.map(s => ({sub:s,parent:c.name}))), [cats]);
  const handleSubKanbanMove = (item, newParent) => {
    if (!newParent || !cats.find(c=>c.name===newParent)) return;
    const upd = cats.map(c => {
      if (c.name === item.parent) return {...c,subcategories:c.subcategories.filter(s=>s!==item.sub)};
      if (c.name === newParent && !c.subcategories.includes(item.sub)) return {...c,subcategories:[...c.subcategories,item.sub]};
      return c;
    });
    setCats(upd); save(upd);
  };

  const expCats = cats.filter(c=>c.type==='Expense');
  const incCats = cats.filter(c=>c.type==='Income');
  const [expanded, setExpanded] = useState(new Set());
  const toggleExpand = (name) => setExpanded(prev => {
    const s = new Set(prev);
    s.has(name) ? s.delete(name) : s.add(name);
    return s;
  });

  const renderSection = (list, typeLabel) => (
    <>
      <div className="mgr-section-label">{typeLabel} Categories
            <span style={{float:'right',fontWeight:400,textTransform:'none',letterSpacing:0,fontSize:'0.65rem',opacity:0.6}}>⠿ drag to set picker order</span>
          </div>
      <div className="mgr-list">
        {list.length===0&&<div className="mgr-empty">No {typeLabel.toLowerCase()} categories</div>}
        {list.map((c) => {
          const i = cats.indexOf(c);
          return (
            <div key={c.name}>
              <div className="mgr-list-row mgr-cat-row"
                draggable
                onDragStart={()=>onDragStart(i)}
                onDragOver={e=>onDragOver(e,i)}
                onDragEnd={onDragEnd}
              >
                <span className="mgr-drag-handle">⠿</span>
                <div className="mgr-list-name" style={{flex:1}}>{c.name}</div>
                {c.subcategories.length>0&&(
                  <button
                    className="mgr-accordion-btn"
                    onClick={(e)=>{e.stopPropagation();toggleExpand(c.name);}}
                  >
                    <span>{c.subcategories.length} subs</span>
                    <span style={{fontSize:'0.8rem',transition:'transform 0.2s',transform:expanded.has(c.name)?'rotate(180deg)':'rotate(0deg)',display:'inline-block'}}>▾</span>
                  </button>
                )}
                <button className="mgr-edit-btn" onClick={()=>editCat?.i===i&&editCat?.j===undefined?setEditCat(null):startEditCat(i)}>✏️</button>
                <button className="mgr-del-btn"  onClick={()=>removeCat(i)}>✕</button>
              </div>
              {editCat?.i===i&&editCat?.j===undefined&&(
                <div className="mgr-edit-panel">
                  <div className="mgr-edit-label">Rename Category</div>
                  <input className="form-input" value={editName} onChange={e=>setEditName(e.target.value)} style={{marginBottom:8}} spellCheck="true" autoCapitalize="sentences"/>
                  <div className="mgr-edit-warn">⚠ Updates all matching transactions</div>
                  <div style={{display:'flex',gap:8,marginTop:8}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setEditCat(null)}>Cancel</button>
                    <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                  </div>
                </div>
              )}
              {c.subcategories.length>0&&expanded.has(c.name)&&c.subcategories.map((s,j)=>(
                <div key={s}>
                  <div className="mgr-list-row mgr-sub-row">
                    <span style={{color:'var(--text-muted)',fontSize:'0.75rem',marginRight:4}}>└</span>
                    <div style={{flex:1}}>
                      <div className="mgr-sub-name" style={{fontSize:'0.78rem',color:'var(--text-secondary)'}}>{s}</div>
                      <select className="mgr-inline-sel" value={c.name}
                        onChange={e=>{
                          const newPar=e.target.value; if(newPar===c.name)return;
                          const u=cats.map((x,xi)=>{
                            if(xi===i)return{...x,subcategories:x.subcategories.filter((_,si)=>si!==j)};
                            if(x.name===newPar)return{...x,subcategories:[...x.subcategories,s]};
                            return x;
                          });
                          setCats(u);save(u);
                        }}>
                        {cats.map(x=><option key={x.name}>{x.name}</option>)}
                      </select>
                    </div>
                    <button className="mgr-edit-btn" style={{width:22,height:22}} onClick={()=>editCat?.i===i&&editCat?.j===j?setEditCat(null):startEditSub(i,j)}>✏️</button>
                    <button className="mgr-del-btn"  style={{width:22,height:22}} onClick={()=>removeSub(i,j)}>✕</button>
                  </div>
                  {editCat?.i===i&&editCat?.j===j&&(
                    <div className="mgr-edit-panel">
                      <div className="mgr-edit-label">Rename Subcategory</div>
                      <input className="form-input" value={editName} onChange={e=>setEditName(e.target.value)} style={{marginBottom:8}} spellCheck="true" autoCapitalize="sentences"/>
                      <div style={{display:'flex',gap:8}}>
                        <button className="btn btn-ghost btn-sm" onClick={()=>setEditCat(null)}>Cancel</button>
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div className="page-hdr-title">Categories</div>
        {saving&&<span style={{fontSize:'0.7rem',color:'var(--text-muted)',marginLeft:8}}>Saving…</span>}
        {toast &&<span style={{fontSize:'0.7rem',color:'var(--green)',marginLeft:8}}>{toast}</span>}
      </div>
      <div className="sub-body">
        <>
            {/* Add Category */}
            <div className="mgr-section-label">Add Category</div>
            <div style={{padding:'0 var(--page-px) 8px',display:'flex',gap:8,alignItems:'flex-end'}}>
              <div className="form-group" style={{flex:1}}>
                <label className="form-label">Name</label>
                <input className="form-input" value={newCat} onChange={e=>setNewCat(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addCat()} spellCheck="true" autoCapitalize="sentences"/>
              </div>
              <div className="form-group">
                <label className="form-label">Type</label>
                <select className="form-input" value={newType} onChange={e=>setNewType(e.target.value)}>
                  <option>Expense</option><option>Income</option>
                </select>
              </div>
              <button className="btn btn-primary btn-sm" style={{marginBottom:0,flexShrink:0}} onClick={addCat}>Add</button>
            </div>

            {/* Add Subcategory */}
            <div className="mgr-section-label">Add Subcategory</div>
            <div style={{padding:'0 var(--page-px) 8px',display:'flex',gap:8,alignItems:'flex-end'}}>
              <div className="form-group" style={{flex:1}}>
                <label className="form-label">Parent Category</label>
                <select className="form-input" value={newSubParent} onChange={e=>setNSP(e.target.value)}>
                  <option value="">Select parent</option>
                  {cats.map(c=><option key={c.name}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group" style={{flex:1}}>
                <label className="form-label">Name</label>
                <input className="form-input" value={newSub} onChange={e=>setNewSub(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addSub()} spellCheck="true" autoCapitalize="sentences"/>
              </div>
              <button className="btn btn-primary btn-sm" style={{flexShrink:0}} onClick={addSub}>Add</button>
            </div>

            {renderSection(expCats,'Expense')}
            {renderSection(incCats,'Income')}
          </>
        <div className="h-8"/>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Data Manager
// ─────────────────────────────────────────────
function DataManager({ onBack }) {
  const { state, importData, cancelImport, clearAllData, cleanupAccounts, analyseImport, updateSettings } = useApp();
  const { transactions, accounts, accountGroups, accountMapping, categories, budgets, importProgress } = state;
  const fileRef = useRef(null);
  const [status,      setStatus]    = useState(null);
  const [showMode,    setShowMode]  = useState(false);
  const [pendingRows, setPending]     = useState(null);
  const [pendingName, setPendingNm]   = useState('');
  const [pendingIsBackup, setIsBackup]        = useState(false);
  const [backupSchedule,  setBackupSchedule]  = useState(() => state.settings?.backupSchedule || 'off');
  const [backupHistory,   setBackupHistory]   = useState(() => {
    try { return JSON.parse(state.settings?.backupHistory || '[]'); } catch { return []; }
  });
  const [showBackupSheet, setShowBackupSheet] = useState(false);
  const [showDel,     setShowDel]   = useState(false);
  const [analysis,    setAnalysis]  = useState(null);   // { total, fileDupeCount, dbDupeCount }
  const [analysing,   setAnalysing] = useState(false);

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
    try {
      const { parseFile } = await import('../../utils/xlsParser.js');
      const parsed = await parseFile(file);

      // ── Full FinMan backup JSON ─────────────────────────────────────────
      // Detect by _finman_backup flag. These files contain both transactions
      // AND settings (accounts, groups, categories, budgets).
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed._finman_backup) {
        const backup = parsed;
        const txnRows = Array.isArray(backup.transactions) ? backup.transactions : [];
        // Restore settings first so accounts/categories are ready before transactions
        await updateSettings({
          accounts:       Array.isArray(backup.accounts)        ? backup.accounts        : undefined,
          accountGroups:  Array.isArray(backup.accountGroups)   ? backup.accountGroups   : undefined,
          accountMapping: Array.isArray(backup.accountMapping)  ? backup.accountMapping  : undefined,
          categories:     backup.categories && typeof backup.categories === 'object' ? backup.categories : undefined,
        });
        if (txnRows.length === 0) {
          setStatus({ type:'success', msg:'✓ Settings restored. No transactions in backup.' });
          if (fileRef.current) fileRef.current.value = '';
          return;
        }
        setPending(txnRows);
        setPendingNm(file.name);
        setIsBackup(true);
        setShowMode(true);
        if (fileRef.current) fileRef.current.value = '';
        return;
      }

      // ── Transactions-only file (CSV, XLS, or plain JSON array) ──────────
      const rows = Array.isArray(parsed) ? parsed : [];
      if (rows.length === 0) {
        setStatus({ type:'error', msg:'File appears empty or unreadable.' });
        if (fileRef.current) fileRef.current.value = '';
        return;
      }
      // Validate expected columns
      const firstRow = rows[0];
      const hasDate  = 'Date' in firstRow || 'date' in firstRow;
      const hasType  = 'Income/Expense' in firstRow || 'type' in firstRow;
      if (!hasDate || !hasType) {
        setStatus({ type:'error', msg:`Missing required columns. Need: Date, Income/Expense, Amount/INR, Account, Category. Found: ${Object.keys(firstRow).slice(0,6).join(', ')}…` });
        if (fileRef.current) fileRef.current.value = '';
        return;
      }
      setPending(rows);
      setPendingNm(file.name);
      setIsBackup(false);
      setShowMode(true);
    } catch (err) {
      setStatus({ type:'error', msg: `Parse error: ${err.message}` });
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const doImport = async (mode) => {
    setShowMode(false);
    const result = await importData(pendingRows, mode);
    setStatus(result.cancelled
      ? { type:'error',   msg:'Import cancelled.' }
      : { type:'success', msg:`✓ Imported ${result.imported.toLocaleString()} transactions${result.skipped > 0 ? ` (${result.skipped} skipped)` : ''}.` }
    );
    setPending(null);
  };

  // ── Capacitor-aware file save (no @capacitor/share — avoids Android 14 crash) ──
  // ── Backup helpers ─────────────────────────────────────────────────────────
  const MAX_BACKUPS = 3;

  const buildBackupPayload = () => ({
    _finman_backup: true,
    version: '2.2.1.3',
    exportedAt: new Date().toISOString(),
    transactions,
    accounts:       accounts || [],
    accountGroups:  accountGroups || [],
    accountMapping: accountMapping || [],
    categories:     categories || {},
    budgets:        budgets || [],
  });

  const runBackupNow = async () => {
    const payload  = buildBackupPayload();
    const now      = new Date();
    const dateStr  = now.toISOString().split('T')[0];
    const filename = `finman_backup_${dateStr}.json`;
    const json     = JSON.stringify(payload, null, 2);

    // Update history (keep last 3) AND mark lastBackupCheck
    const entry = { date: now.toISOString(), filename, size: json.length };
    const newHistory = [entry, ...backupHistory].slice(0, MAX_BACKUPS);
    setBackupHistory(newHistory);
    await updateSettings({
      backupHistory:   JSON.stringify(newHistory),
      lastBackupCheck: now.toISOString(),
    });

    // Trigger download
    await saveFile(json, filename, 'application/json');
    setStatus({ type:'success', msg:`✓ Backup saved — ${filename}` });
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
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const exportCSV = async () => {
    const hdrs = ['Date','Time','Account','FromAccount','ToAccount','Category','Subcategory','Note','Description','INR','Amount','Currency','Income/Expense','ID'];
    // RFC 4180: quote any field containing comma, double-quote, newline or carriage-return
    const esc  = v => { const s=String(v??''); return /[,"\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };
    const rows = [hdrs.join(','), ...transactions.map(t => hdrs.map(h => esc(t[h])).join(','))];
    await saveFile(rows.join('\n'), `finman_${new Date().toISOString().split('T')[0]}.csv`, 'text/csv');
  };

  const exportJSON = async () => {
    const backup = buildBackupPayload();
    await saveFile(JSON.stringify(backup, null, 2), `finman_backup_${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  };

  const pct = importProgress ? Math.round((importProgress.processed / importProgress.total) * 100) : 0;

  return (
    <div className="sub-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div className="page-hdr-title">Data</div>
      </div>

      <div className="sub-body">
        {/* Stats */}
        <div className="dm-stats" style={{margin:'10px var(--page-px)'}}>
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

        {status && (
          <div className={`dm-alert ${status.type}`} style={{margin:'0 var(--page-px) 10px'}}>
            {status.msg}
          </div>
        )}

        {importProgress && (
          <div style={{margin:'0 var(--page-px) 10px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--r-lg)',padding:'12px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <span style={{fontSize:'0.8rem',fontWeight:700}}>Importing {importProgress.total.toLocaleString()} rows…</span>
              <button className="btn btn-sm btn-danger" onClick={cancelImport}>Cancel</button>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{width:`${pct}%`,background:'var(--green)'}}/>
            </div>
            <div style={{fontSize:'0.7rem',color:'var(--text-muted)',marginTop:5}}>
              {importProgress.processed.toLocaleString()} / {importProgress.total.toLocaleString()} ({pct}%)
            </div>
          </div>
        )}

        {/* Import section */}
        <div className="dm-section-hdr">Import</div>
        <label className={`import-drop ${importProgress ? 'disabled' : ''}`} style={{margin:'0 var(--page-px) 14px',display:'block'}}>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.xlsm,.json" style={{display:'none'}} onChange={handleFile} disabled={!!importProgress}/>
          <div className="import-folder-icon">📂</div>
          <div className="import-drop-title">Choose file</div>
          <div className="import-drop-sub">CSV / XLS — transactions only · JSON — full backup incl. accounts &amp; categories</div>
        </label>

        {/* Export section */}
        <div className="dm-section-hdr">Export</div>
        <div className="dm-card" style={{margin:'0 var(--page-px) 14px'}}>
          <div className="dm-row" onClick={exportCSV}>
            <div className="dm-row-icon">📊</div>
            <div className="dm-row-content"><div className="dm-row-title">Export CSV</div><div className="dm-row-sub">Transactions only · safe for spreadsheets</div></div>
          </div>
          <div className="dm-row" onClick={exportJSON}>
            <div className="dm-row-icon">🗃️</div>
            <div className="dm-row-content"><div className="dm-row-title">Export Full Backup (JSON)</div><div className="dm-row-sub">Transactions + accounts, groups, categories · re-importable</div></div>
          </div>
        </div>

        {/* Backup section */}
        <div className="dm-section-hdr">Backup</div>
        <div className="dm-card" style={{margin:'0 var(--page-px) 14px'}}>
          <div className="dm-row" onClick={runBackupNow}>
            <div className="dm-row-icon">📲</div>
            <div className="dm-row-content">
              <div className="dm-row-title">Backup Now</div>
              <div className="dm-row-sub">Save full backup to device storage</div>
            </div>
          </div>
          <div className="dm-row" style={{opacity:0.5,cursor:'default'}}>
            <div className="dm-row-icon">🔵</div>
            <div className="dm-row-content">
              <div className="dm-row-title">Google Drive <span style={{fontSize:'0.62rem',fontWeight:700,background:'rgba(255,180,0,0.15)',color:'var(--gold)',borderRadius:4,padding:'1px 5px',marginLeft:4}}>Coming Soon</span></div>
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
            <div style={{fontSize:'0.72rem',fontWeight:700,color:'var(--accent)',flexShrink:0}}>
              {backupSchedule === 'off' ? 'Off' : backupSchedule.charAt(0).toUpperCase() + backupSchedule.slice(1)}
            </div>
          </div>
          {backupHistory.length > 0 && (
            <div style={{padding:'8px var(--page-px)',borderTop:'1px solid var(--border-light)'}}>
              <div style={{fontSize:'0.6rem',fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:6}}>Backup History (last {MAX_BACKUPS})</div>
              {backupHistory.map((b, i) => (
                <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 0',borderBottom:i<backupHistory.length-1?'1px solid var(--border-light)':'none'}}>
                  <div>
                    <div style={{fontSize:'0.72rem',fontWeight:600,color:'var(--text-primary)'}}>{b.filename}</div>
                    <div style={{fontSize:'0.62rem',color:'var(--text-muted)'}}>{new Date(b.date).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
                  </div>
                  <div style={{fontSize:'0.65rem',color:'var(--text-muted)'}}>{b.size ? (b.size/1024).toFixed(1)+'KB' : ''}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Auto backup schedule picker */}
        {showBackupSheet && (
          <>
            <div className="overlay" onClick={() => setShowBackupSheet(false)}/>
            <div className="bottom-sheet">
              <div className="sheet-handle"/>
              <div style={{fontWeight:800,fontSize:'0.95rem',marginBottom:4}}>Auto Backup Schedule</div>
              <div style={{fontSize:'0.73rem',color:'var(--text-muted)',marginBottom:16}}>
                Backup reminder triggers on app open when due. Saves to your device and keeps the last {MAX_BACKUPS} backups.
              </div>
              {[['off','Disabled','No automatic backups'],['daily','Daily','Reminder every day'],['weekly','Weekly','Reminder every 7 days'],['monthly','Monthly','Reminder every 30 days']].map(([val,label,sub]) => (
                <div key={val}
                  onClick={() => { saveBackupSchedule(val); setShowBackupSheet(false); }}
                  style={{display:'flex',alignItems:'center',gap:12,padding:'12px 0',borderBottom:'1px solid var(--border-light)',cursor:'pointer'}}>
                  <div style={{width:18,height:18,borderRadius:'50%',border:`2px solid ${backupSchedule===val?'var(--accent)':'var(--border)'}`,background:backupSchedule===val?'var(--accent)':'transparent',flexShrink:0}}/>
                  <div>
                    <div style={{fontSize:'0.85rem',fontWeight:700,color:'var(--text-primary)'}}>{label}</div>
                    <div style={{fontSize:'0.68rem',color:'var(--text-muted)'}}>{sub}</div>
                  </div>
                </div>
              ))}
              <button className="btn btn-ghost btn-full" style={{marginTop:12}} onClick={() => setShowBackupSheet(false)}>Cancel</button>
            </div>
          </>
        )}

        {/* Danger Zone */}
        <div className="dm-section-hdr" style={{color:'var(--expense)'}}>Danger Zone</div>
        <div className="dm-card" style={{margin:'0 var(--page-px) 14px'}}>
          <div className="dm-row danger-row" onClick={() => setShowDel(true)}>
            <div className="dm-row-icon">🗑️</div>
            <div className="dm-row-content"><div className="dm-row-title" style={{color:'var(--expense)'}}>Delete All Transactions</div><div className="dm-row-sub">This action cannot be undone</div></div>
          </div>
        </div>

        {/* Delete confirm */}
        {showDel && (
          <>
            <div className="overlay" onClick={() => setShowDel(false)}/>
            <div className="bottom-sheet">
              <div className="sheet-handle"/>
              <div style={{textAlign:'center',padding:'0 var(--page-px) 16px'}}>
                <div style={{fontSize:'2rem',marginBottom:10}}>⚠️</div>
                <div style={{fontSize:'1rem',fontWeight:800,marginBottom:8}}>Delete all transactions?</div>
                <div style={{fontSize:'0.78rem',color:'var(--text-muted)',marginBottom:20}}>This will permanently remove {txnCount.toLocaleString()} transactions and cannot be undone.</div>
                <div style={{display:'flex',gap:10}}>
                  <button className="btn btn-ghost btn-full"  onClick={() => setShowDel(false)}>Cancel</button>
                  <button className="btn btn-danger btn-full" onClick={async () => { await clearAllData(); setShowDel(false); setStatus({ type:'success', msg:'All data deleted.' }); }}>Delete All</button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Import mode sheet */}
        {showMode && (
          <>
            <div className="overlay" onClick={() => setShowMode(false)}/>
            <div className="bottom-sheet" style={{paddingBottom:'calc(var(--safe-bottom) + 20px)'}}>
              <div className="sheet-handle"/>
              <div style={{fontWeight:800,fontSize:'0.95rem',marginBottom:4}}>
                {pendingRows?.length?.toLocaleString()} rows found
              </div>
              <div style={{fontSize:'0.75rem',color:'var(--text-muted)',marginBottom:4}}>
                File: {pendingName}
              </div>

              {/* Duplicate analysis */}
              {analysis && (analysis.fileDupeCount > 0 || analysis.dbDupeCount > 0) && (
                <div style={{background:'rgba(255,180,0,0.08)',border:'1px solid rgba(255,180,0,0.3)',borderRadius:10,padding:'10px 12px',marginBottom:12}}>
                  <div style={{fontWeight:700,fontSize:'0.78rem',color:'var(--gold)',marginBottom:6}}>⚠ Duplicates detected</div>
                  {analysis.fileDupeCount > 0 && (
                    <div style={{fontSize:'0.73rem',color:'var(--text-secondary)',marginBottom:3}}>
                      • <b>{analysis.fileDupeCount}</b> rows in the file share an identical date/time/account/amount/note combination
                    </div>
                  )}
                  {analysis.dbDupeCount > 0 && (
                    <div style={{fontSize:'0.73rem',color:'var(--text-secondary)'}}>
                      • <b>{analysis.dbDupeCount}</b> rows already exist in the app (Merge will skip these)
                    </div>
                  )}
                </div>
              )}

              <div style={{fontSize:'0.78rem',color:'var(--text-muted)',marginBottom:16}}>
                <b style={{color:'var(--green)'}}>Merge</b> — keeps all existing transactions, accounts &amp; categories. Adds only new rows (exact duplicates skipped). <b>Recommended for FinMan exports.</b><br/><br/>
                <b style={{color:'var(--expense)'}}>Override</b> — ⚠ deletes all existing transactions first, then imports fresh. Settings (accounts, categories) are rebuilt from the file. Use only when starting clean.
              </div>
              <button className="btn btn-primary btn-full" style={{marginBottom:8}} onClick={() => doImport('merge')}>Merge (recommended)</button>
              <button className="btn btn-danger  btn-full" onClick={() => doImport('override')}>Override — delete &amp; replace all</button>
              <button className="btn btn-ghost btn-full" style={{marginTop:8}} onClick={() => { setShowMode(false); setPending(null); setAnalysis(null); setIsBackup(false); }}>Cancel</button>
            </div>
          </>
        )}

        <div style={{height:24}}/>
      </div>
    </div>
  );
}

// ── Profile & PIN Manager ────────────────────────────────────────────────────
function ProfileManager({ onBack }) {
  const { state, updateSettings } = useApp();
  const [name,      setName]    = useState(state.settings?.profileName || state.settings?.name || '');
  const [pin,       setPin]     = useState(state.settings?.pin || '');
  const [newPin,    setNewPin]  = useState('');
  const [confirm,   setConfirm] = useState('');
  const [msg,       setMsg]     = useState(null);
  const [showClear, setShowClear] = useState(false);

  const hasPin = !!pin;

  const saveProfile = async () => {
    await updateSettings({ profileName: name.trim(), name: name.trim() });
    setMsg({ type:'success', text:'Name saved ✓' });
    setTimeout(() => setMsg(null), 2000);
  };

  const savePin = async () => {
    if (newPin.length < 4 || newPin.length > 6) { setMsg({ type:'error', text:'PIN must be 4–6 digits' }); return; }
    if (!/^\d+$/.test(newPin)) { setMsg({ type:'error', text:'PIN must be digits only' }); return; }
    if (newPin !== confirm) { setMsg({ type:'error', text:'PINs do not match' }); return; }
    await updateSettings({ pin: newPin, pinIdleSeconds: 10 });
    setPin(newPin); setNewPin(''); setConfirm('');
    setMsg({ type:'success', text:'PIN set ✓ — app locks after 10s idle' });
    setTimeout(() => setMsg(null), 3000);
  };

  const clearPin = async () => {
    await updateSettings({ pin: '', pinIdleSeconds: 0 });
    setPin(''); setShowClear(false);
    setMsg({ type:'success', text:'PIN removed' });
    setTimeout(() => setMsg(null), 2000);
  };

  return (
    <div className="settings-root">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div style={{flex:1}}><div className="page-hdr-title">Profile & Security</div></div>
      </div>

      {msg && (
        <div style={{margin:'0 var(--page-px) 10px',padding:'10px 14px',borderRadius:10,background:msg.type==='success'?'var(--income-bg)':'var(--expense-bg)',color:msg.type==='success'?'var(--income)':'var(--expense)',fontSize:'0.8rem',fontWeight:700}}>
          {msg.text}
        </div>
      )}

      {/* Profile name */}
      <div className="settings-group-label">Your Profile</div>
      <div className="settings-card" style={{padding:'14px var(--page-px)'}}>
        <div style={{fontSize:'0.7rem',fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.6px',marginBottom:6}}>Display Name</div>
        <div style={{display:'flex',gap:8}}>
          <input className="form-input" style={{flex:1}} value={name} onChange={e=>setName(e.target.value)} placeholder="Your name (optional)" spellCheck="true" autoCapitalize="sentences"/>
          <button className="btn btn-primary btn-sm" onClick={saveProfile}>Save</button>
        </div>
      </div>

      {/* PIN */}
      <div className="settings-group-label">PIN Lock</div>
      <div className="settings-card" style={{padding:'14px var(--page-px)'}}>
        <div style={{fontSize:'0.78rem',color:'var(--text-muted)',marginBottom:12}}>
          {hasPin ? '🔒 PIN is set. App auto-locks after 10 seconds of inactivity.' : '🔓 No PIN set. Anyone can open the app.'}
        </div>

        {hasPin ? (
          <>
            <div style={{fontSize:'0.7rem',fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.6px',marginBottom:6}}>Change PIN</div>
            <input className="form-input" style={{marginBottom:8,letterSpacing:'0.3em'}} type="number" inputMode="numeric" maxLength={6} value={newPin} onChange={e=>setNewPin(e.target.value.slice(0,6))} placeholder="New PIN (4–6 digits)"/>
            <input className="form-input" style={{marginBottom:12,letterSpacing:'0.3em'}} type="number" inputMode="numeric" maxLength={6} value={confirm} onChange={e=>setConfirm(e.target.value.slice(0,6))} placeholder="Confirm PIN"/>
            <div style={{display:'flex',gap:8}}>
              <button className="btn btn-primary btn-full" onClick={savePin}>Update PIN</button>
              <button className="btn btn-danger" onClick={()=>setShowClear(true)}>Remove</button>
            </div>
          </>
        ) : (
          <>
            <div style={{fontSize:'0.7rem',fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.6px',marginBottom:6}}>Set PIN</div>
            <input className="form-input" style={{marginBottom:8,letterSpacing:'0.3em'}} type="number" inputMode="numeric" maxLength={6} value={newPin} onChange={e=>setNewPin(e.target.value.slice(0,6))} placeholder="New PIN (4–6 digits)"/>
            <input className="form-input" style={{marginBottom:12,letterSpacing:'0.3em'}} type="number" inputMode="numeric" maxLength={6} value={confirm} onChange={e=>setConfirm(e.target.value.slice(0,6))} placeholder="Confirm PIN"/>
            <button className="btn btn-primary btn-full" onClick={savePin}>Set PIN</button>
          </>
        )}
      </div>

      {showClear && (
        <>
          <div className="overlay" onClick={()=>setShowClear(false)}/>
          <div className="bottom-sheet">
            <div className="sheet-handle"/>
            <div style={{textAlign:'center',padding:'0 var(--page-px) 16px'}}>
              <div style={{fontSize:'2rem',marginBottom:8}}>🔓</div>
              <div style={{fontWeight:800,marginBottom:8}}>Remove PIN?</div>
              <div style={{fontSize:'0.78rem',color:'var(--text-muted)',marginBottom:20}}>App will no longer lock when idle.</div>
              <div style={{display:'flex',gap:10}}>
                <button className="btn btn-ghost btn-full" onClick={()=>setShowClear(false)}>Cancel</button>
                <button className="btn btn-danger btn-full" onClick={clearPin}>Remove PIN</button>
              </div>
            </div>
          </div>
        </>
      )}
      <div style={{height:40}}/>
    </div>
  );
}

function BudgetsManager({ onBack }) {
  const { state, saveBudget, removeBudget } = useApp();
  const { budgets, categories, transactions } = state;
  const [newCat,  setNewCat]  = useState('');
  const [newAmt,  setNewAmt]  = useState('');
  const [newPer,  setNewPer]  = useState('Monthly');
  const now = new Date();

  const expCats = Object.entries(categories||{}).filter(([,d])=>d.type==='Expense').map(([n])=>n).sort();

  const getSpend = (catName, period) => {
    let txns = transactions.filter(t=>t.Category===catName);
    if(period==='Monthly') txns=txns.filter(t=>{const d=parseDate(t.Date);return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth();});
    else txns=txns.filter(t=>parseDate(t.Date).getFullYear()===now.getFullYear());
    return txns.reduce((s,t)=>s+(parseFloat(t.INR||t.Amount)||0),0);
  };

  const add = async () => {
    if(!newCat||!newAmt) return;
    await saveBudget(newCat,parseFloat(newAmt),newPer);
    setNewCat(''); setNewAmt('');
  };

  return (
    <div className="sub-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>
        <div className="page-hdr-title">Budgets</div>
      </div>
      <div className="sub-body">
        <div className="mgr-section-label">Set Budget</div>
        <div style={{padding:'0 var(--page-px) 10px',display:'flex',gap:8,flexWrap:'wrap'}}>
          <select className="form-input" style={{flex:2,minWidth:120}} value={newCat} onChange={e=>setNewCat(e.target.value)}>
            <option value="">Category</option>
            {expCats.map(c=><option key={c}>{c}</option>)}
          </select>
          <input className="form-input" style={{flex:1,minWidth:80}} type="number" placeholder="Amount" value={newAmt} onChange={e=>setNewAmt(e.target.value)}/>
          <select className="form-input" style={{flex:1,minWidth:90}} value={newPer} onChange={e=>setNewPer(e.target.value)}>
            <option>Monthly</option><option>Yearly</option>
          </select>
          <button className="btn btn-primary" onClick={add}>Set</button>
        </div>
        {budgets.map(b=>{
          const spend=getSpend(b.category,b.period);
          const pct=Math.min(100,b.amount>0?(spend/b.amount)*100:0);
          return(
            <div key={b.category} className="budget-detail-card" style={{margin:'0 var(--page-px) 8px'}}>
              <div className="budget-detail-top">
                <div className="budget-detail-name">{b.category}</div>
                <div className="budget-detail-period">{b.period}</div>
                <button className="mgr-del-btn" onClick={()=>removeBudget(b.category)}>✕</button>
              </div>
              <div className="budget-detail-vals">
                <span style={{color:pct>85?'var(--expense)':'var(--income)'}}>{formatINR(spend)}</span>
                <span style={{color:'var(--text-muted)'}}> / {formatINR(b.amount)}</span>
              </div>
              <div className="progress-track" style={{marginTop:8}}>
                <div className="progress-fill" style={{width:`${pct}%`,background:pct>85?'var(--expense)':'var(--green)'}}/>
              </div>
            </div>
          );
        })}
        {budgets.length===0&&<div className="mgr-empty" style={{padding:'16px var(--page-px)'}}>No budgets yet</div>}
        <div className="h-8"/>
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div className="page-hdr-title">Appearance</div>
        {saving && <span style={{fontSize:'0.7rem',color:'var(--text-muted)',marginLeft:8}}>Saving…</span>}
        {toast && <span style={{fontSize:'0.7rem',color:'var(--green)',marginLeft:8}}>{toast}</span>}
      </div>

      <div className="sub-body">
        {/* Theme */}
        <div className="mgr-section-label">Theme</div>
        <div className="settings-card" style={{margin:'0 var(--page-px) 16px'}}>
          <div className="settings-row" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            <div className="settings-row-icon" style={{background: theme === 'dark' ? 'var(--bg-card2)' : '#fff3cd'}}>
              {theme === 'dark' ? '🌙' : '☀️'}
            </div>
            <div className="settings-row-content">
              <div className="settings-row-title">Theme</div>
              <div className="settings-row-sub">{theme === 'dark' ? 'Dark' : 'Light'} — tap to switch</div>
            </div>
            <div style={{padding:'4px 10px',borderRadius:'var(--r-full)',background: theme === 'dark' ? 'var(--bg-card2)' : 'var(--bg-card)',border:'1px solid var(--border)',fontSize:'0.72rem',fontWeight:700,color:'var(--text-secondary)'}}>
              {theme === 'dark' ? 'Dark' : 'Light'}
            </div>
          </div>
        </div>

        {/* Font Size */}
        <div className="mgr-section-label">Font Size</div>
        <div className="settings-card" style={{margin:'0 var(--page-px) 16px'}}>
          <div style={{padding:'12px var(--page-px)'}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
              <div style={{fontSize:'0.85rem',fontWeight:700,color:'var(--text-primary)'}}>Font Size</div>
              <div style={{fontSize:'0.75rem',color:'var(--text-muted)'}}>{fsLabel} ({Math.round(fontSize*100)}%)</div>
            </div>
            <div className="font-scale-row" style={{padding:0}}>
              <span className="font-scale-label" style={{fontSize:'0.65rem'}}>A</span>
              <input type="range" className="fs-slider" min="0.75" max="1.25" step="0.05"
                value={fontSize}
                onChange={e => setFontSize(parseFloat(e.target.value))}
                onMouseUp={e => setFontSize(parseFloat(e.target.value))}/>
              <span className="font-scale-label" style={{fontSize:'1rem'}}>A</span>
            </div>
          </div>
        </div>

        {/* Font Weight */}
        <div className="mgr-section-label">Content Font Weight</div>
        <div className="settings-card" style={{margin:'0 var(--page-px) 16px'}}>
          <div style={{padding:'12px var(--page-px)'}}>
            <div style={{fontSize:'0.72rem',color:'var(--text-muted)',marginBottom:12}}>
              Applies to transaction notes, amounts, account names, category names. Headings and labels are unaffected.
            </div>
            <div style={{display:'flex',gap:8}}>
              {[
                { key:'light',   label:'Light',   fw:'400', desc:'Airy & minimal' },
                { key:'regular', label:'Regular',  fw:'500', desc:'Balanced' },
                { key:'bold',    label:'Bold',     fw:'700', desc:'High contrast' },
              ].map(opt => (
                <div key={opt.key}
                  onClick={() => setFontDataWeight(opt.key)}
                  style={{
                    flex:1, borderRadius:10, border:`2px solid ${fontDataWeight===opt.key?'var(--accent)':'var(--border)'}`,
                    background: fontDataWeight===opt.key ? 'rgba(0,229,160,0.08)' : 'var(--bg-card2)',
                    padding:'10px 8px', cursor:'pointer', textAlign:'center', transition:'all 0.15s',
                  }}>
                  <div style={{fontFamily:'var(--font)',fontSize:'1rem',fontWeight:opt.fw,color:fontDataWeight===opt.key?'var(--accent)':'var(--text-primary)',marginBottom:4}}>
                    ₹1,234
                  </div>
                  <div style={{fontSize:'0.72rem',fontWeight:opt.fw,color:fontDataWeight===opt.key?'var(--accent)':'var(--text-primary)',marginBottom:2}}>
                    {opt.label}
                  </div>
                  <div style={{fontSize:'0.6rem',color:'var(--text-muted)'}}>
                    {opt.desc}
                  </div>
                </div>
              ))}
            </div>
            {/* Live preview */}
            <div style={{marginTop:12,padding:'10px 12px',background:'var(--bg-surface)',borderRadius:8,border:'1px solid var(--border-light)'}}>
              <div style={{fontSize:'0.6rem',fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:8}}>Preview</div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <div>
                  <div style={{fontSize:'0.8rem',fontWeight:fontDataWeight==='light'?400:fontDataWeight==='regular'?500:700,color:'var(--text-primary)'}}>Groceries · Milk</div>
                  <div style={{fontSize:'0.65rem',color:'var(--text-muted)',marginTop:2}}>10:30 am · To Home</div>
                </div>
                <div style={{fontFamily:'var(--font)',fontSize:'0.78rem',fontWeight:fontDataWeight==='light'?400:fontDataWeight==='regular'?500:700,color:'var(--expense)'}}>−₹250</div>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{fontSize:'0.8rem',fontWeight:fontDataWeight==='light'?400:fontDataWeight==='regular'?500:700,color:'var(--text-primary)'}}>HDFC</div>
                <div style={{fontFamily:'var(--font)',fontSize:'0.78rem',fontWeight:fontDataWeight==='light'?400:fontDataWeight==='regular'?500:700,color:'var(--income)'}}>+₹9,67,413</div>
              </div>
            </div>
          </div>
        </div>

        {/* Font Family */}
        <div className="mgr-section-label">Font Family</div>
        <div className="settings-card" style={{margin:'0 var(--page-px) 16px'}}>
          {fontOptions.map((font) => (
            <div key={font.name} className="settings-row" onClick={() => setFontFamily(font.name)}>
              <div className="settings-row-icon" style={{background:'rgba(167,139,250,0.15)'}}>
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
                <div style={{color:'var(--green)',fontSize:'1.2rem'}}>✓</div>
              )}
            </div>
          ))}
        </div>

        <div className="h-8"/>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Main Settings screen
// ─────────────────────────────────────────────
export default function Settings({ backInterceptRef } = {}) {
  const { state } = useApp();
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


  if (screen==='data')       return <DataManager       onBack={()=>setScreen(null)}/>;
  if (screen==='accounts')   return <AccountsManager   onBack={()=>setScreen(null)}/>;
  if (screen==='categories') return <CategoriesManager onBack={()=>setScreen(null)}/>;
  if (screen==='budgets')    return <BudgetsManager    onBack={()=>setScreen(null)}/>;
  if (screen==='profile')    return <ProfileManager    onBack={()=>setScreen(null)}/>;
  if (screen==='appearance') return <AppearanceManager onBack={()=>setScreen(null)}/>;

  const txnCount  = state.transactions.length;
  const acctCount = (state.accounts||[]).length;
  const catCount  = Object.keys(state.categories||{}).length;

  return (
    <div className="settings-root">
      <div className="settings-title-row">
        <div style={{fontSize:'1.4rem',fontWeight:800}}>Settings</div>
      </div>

      {/* Profile card — top of settings */}
      <div className="settings-profile-card" onClick={()=>setScreen('profile')}>
        <div className="settings-profile-avatar">
          {(state.settings?.profileName || state.settings?.name || 'A').trim().charAt(0).toUpperCase()}
        </div>
        <div className="settings-profile-info">
          <div className="settings-profile-name">{state.settings?.profileName || state.settings?.name || 'Your Name'}</div>
          <div className="settings-profile-sub">{state.settings?.pin ? '🔒 PIN enabled' : 'Finance Manager v2'}</div>
        </div>
        <button className="settings-profile-edit-btn" onClick={e=>{e.stopPropagation();setScreen('profile');}}>Edit</button>
      </div>

      {/* Appearance */}
      <div className="settings-group-label">Appearance</div>
      <div className="settings-card">
        <div className="settings-row" onClick={()=>setScreen('appearance')}>
          <div className="settings-row-icon" style={{background:'rgba(255,193,7,0.15)'}}>🎨</div>
          <div className="settings-row-content"><div className="settings-row-title">Appearance</div><div className="settings-row-sub">Theme, font size, and font family</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6"/></svg>
        </div>
      </div>

      {/* Data */}
      <div className="settings-group-label">Data</div>
      <div className="settings-card">
        <div className="settings-row" onClick={()=>setScreen('data')}>
          <div className="settings-row-icon" style={{background:'rgba(77,159,255,0.15)'}}>📊</div>
          <div className="settings-row-content"><div className="settings-row-title">Data Management</div><div className="settings-row-sub">{txnCount.toLocaleString()} transactions</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6"/></svg>
        </div>
      </div>

      {/* Manage */}
      <div className="settings-group-label">Manage</div>
      <div className="settings-card">
        <div className="settings-row" onClick={()=>setScreen('accounts')}>
          <div className="settings-row-icon" style={{background:'rgba(0,229,160,0.12)'}}>💳</div>
          <div className="settings-row-content"><div className="settings-row-title">Accounts</div><div className="settings-row-sub">{acctCount} accounts</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6"/></svg>
        </div>
        <div className="settings-row" onClick={()=>setScreen('categories')}>
          <div className="settings-row-icon" style={{background:'rgba(167,139,250,0.15)'}}>🏷️</div>
          <div className="settings-row-content"><div className="settings-row-title">Categories</div><div className="settings-row-sub">{catCount} categories</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6"/></svg>
        </div>
        <div className="settings-row" onClick={()=>setScreen('budgets')}>
          <div className="settings-row-icon" style={{background:'rgba(255,209,102,0.15)'}}>🎯</div>
          <div className="settings-row-content"><div className="settings-row-title">Budgets</div><div className="settings-row-sub">{state.budgets?.length||0} budgets set</div></div>
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="14" height="14"><path d="M9 18l6-6-6-6"/></svg>
        </div>
      </div>

      {/* About */}
      <div className="settings-group-label">About</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-icon" style={{background:'rgba(0,229,160,0.12)'}}>💰</div>
          <div className="settings-row-content"><div className="settings-row-title">FinMan</div><div className="settings-row-sub">v2.2.1.3 — Built for you by Akbar 💚</div></div>
        </div>
      </div>

      <div className="h-8"/>
    </div>
  );
}