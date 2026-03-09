import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { v4 as uuid } from 'uuid';
import './Settings.css';

const ICONS_EXP = ['🍔','🚗','🛍️','⚡','🏥','🎬','✈️','📱','🏠','📚','💪','🐾'];
const ICONS_INC = ['💼','💰','📈','🎁','🏆','💎'];
const COLORS    = ['#ff4d6a','#ffd166','#a78bfa','#4d9fff','#00e5a0','#fb923c','#2dd4bf','#f472b6'];

export default function CategoryMgr({ onBack }) {
  const { state, saveCategories, toast } = useApp();
  const cats = Array.isArray(state.categories) ? state.categories : [];

  const [newCatName,  setNewCatName]  = useState('');
  const [newCatType,  setNewCatType]  = useState('Expense');
  const [newCatIcon,  setNewCatIcon]  = useState('📦');
  const [newCatColor, setNewCatColor] = useState('#ff4d6a');
  const [newSubName,  setNewSubName]  = useState('');
  const [forCat,      setForCat]      = useState('');
  const [expanded,    setExpanded]    = useState(null);
  const [saving,      setSaving]      = useState(false);

  const doAddCat = async () => {
    if (!newCatName.trim()) return;
    if (cats.some(c=>c.name===newCatName.trim())) { toast('Category exists','error'); return; }
    setSaving(true);
    try {
      await saveCategories([...cats, { id:uuid(), name:newCatName.trim(), type:newCatType, icon:newCatIcon, color:newCatColor, sort_order:cats.length, subcategories:[] }]);
      setNewCatName(''); toast('Category added ✓');
    } finally { setSaving(false); }
  };

  const doDeleteCat = async (id) => {
    if (!window.confirm('Delete category?')) return;
    await saveCategories(cats.filter(c=>c.id!==id));
    toast('Deleted');
  };

  const doAddSub = async () => {
    if (!newSubName.trim() || !forCat) return;
    const updated = cats.map(c => c.id===forCat
      ? { ...c, subcategories: [...(c.subcategories||[]), { id:uuid(), name:newSubName.trim(), icon:'', sort_order:(c.subcategories||[]).length }] }
      : c);
    await saveCategories(updated);
    setNewSubName(''); toast('Subcategory added ✓');
  };

  const doDeleteSub = async (catId, subId) => {
    const updated = cats.map(c => c.id===catId
      ? { ...c, subcategories: (c.subcategories||[]).filter(s=>s.id!==subId) }
      : c);
    await saveCategories(updated);
    toast('Deleted');
  };

  const expCats = cats.filter(c=>c.type==='Expense');
  const incCats = cats.filter(c=>c.type==='Income');

  return (
    <div className="subpage settings-screen">
      <div className="subpage-header">
        <button className="back-btn" onClick={onBack}><BackIcon/></button>
        <div className="subpage-title">Categories</div>
      </div>

      {/* Add Category */}
      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>Add Category</div>
        <div className="card" style={{padding:16,display:'flex',flexDirection:'column',gap:10}}>
          <input className="form-control" placeholder="Category name" value={newCatName} onChange={e=>setNewCatName(e.target.value)} />
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <select className="form-control" value={newCatType} onChange={e=>setNewCatType(e.target.value)}>
              <option value="Expense">Expense</option>
              <option value="Income">Income</option>
            </select>
            <select className="form-control" value={newCatColor} onChange={e=>setNewCatColor(e.target.value)}>
              {COLORS.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="icon-picker">
            {(newCatType==='Income'?ICONS_INC:ICONS_EXP).map(i=>(
              <button key={i} className={`icon-btn ${newCatIcon===i?'active':''}`} onClick={()=>setNewCatIcon(i)}>{i}</button>
            ))}
          </div>
          <button className="btn btn-primary btn-full" onClick={doAddCat} disabled={!newCatName.trim()||saving}>+ Add Category</button>
        </div>
      </div>

      {/* Add Subcategory */}
      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>Add Subcategory</div>
        <div className="card" style={{padding:16,display:'flex',flexDirection:'column',gap:10}}>
          <select className="form-control" value={forCat} onChange={e=>setForCat(e.target.value)}>
            <option value="">Select category…</option>
            {cats.map(c=><option key={c.id} value={c.id}>{c.icon} {c.name} ({c.type})</option>)}
          </select>
          <div style={{display:'flex',gap:10}}>
            <input className="form-control" placeholder="Subcategory name" value={newSubName} onChange={e=>setNewSubName(e.target.value)} style={{flex:1}}/>
            <button className="btn btn-secondary" onClick={doAddSub} disabled={!newSubName.trim()||!forCat}>Add</button>
          </div>
        </div>
      </div>

      {/* Category lists */}
      {[['Expense',expCats],['Income',incCats]].map(([type,list])=>(
        <div key={type} className="mgr-section">
          <div className="settings-group-label" style={{padding:0,marginBottom:12}}>{type} Categories ({list.length})</div>
          {list.length === 0 ? <div className="empty-state" style={{padding:20}}><div className="empty-sub">No {type.toLowerCase()} categories</div></div> : (
            <div className="settings-list">
              {list.map(c=>(
                <div key={c.id}>
                  <div className="settings-row card-pressable" onClick={()=>setExpanded(expanded===c.id?null:c.id)}>
                    <div className="settings-row-icon" style={{background:`${c.color}20`,fontSize:18}}>{c.icon}</div>
                    <div className="settings-row-text">
                      <div className="settings-row-title">{c.name}</div>
                      <div className="settings-row-sub">{(c.subcategories||[]).length} subcategories</div>
                    </div>
                    <button className="btn btn-danger btn-sm" onClick={e=>{e.stopPropagation();doDeleteCat(c.id);}}>✕</button>
                  </div>
                  {expanded===c.id && (c.subcategories||[]).map(s=>(
                    <div key={s.id} style={{display:'flex',alignItems:'center',padding:'10px 16px 10px 52px',borderBottom:'1px solid var(--border)',background:'var(--bg3)'}}>
                      <span style={{flex:1,fontSize:13,color:'var(--text3)'}}>↳ {s.name}</span>
                      <button className="btn btn-danger btn-sm" onClick={()=>doDeleteSub(c.id,s.id)}>✕</button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const BackIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>;
