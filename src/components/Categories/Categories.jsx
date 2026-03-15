import React, { useState, useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseDate, formatINR, formatINRCompact, txnType, txnAmount, calcTotals, currentFY, fyLabel, fyStart, fyEnd } from '../../utils/format.js';
import TransactionItem from '../Transactions/TransactionItem.jsx';
import AddTransaction from '../Transactions/AddTransaction.jsx';
import useSwipe from '../../hooks/useSwipe.js';
import './Categories.css';

const PIE_COLORS = ['#ff4d6a','#ffd166','#a78bfa','#4d9fff','#00e5a0','#fb8500','#06d6a0','#ff9f1c','#e040fb','#00b4d8','#f72585','#7209b7','#3a86ff','#8338ec','#ffbe0b'];
const PERIODS    = ['Month','Year','FY','All','Custom'];
const MS_S       = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MS_F       = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const BackBtn = ({ onClick }) => (
  <button className="back-btn" onClick={onClick}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
  </button>
);

const PieTip = ({ active, payload }) => {
  if (!active || !payload?.[0]) return null;
  const d = payload[0];
  return (
    <div style={{background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:10,padding:'6px 10px',fontSize:'0.73rem'}}>
      <div style={{fontWeight:700,marginBottom:2}}>{d.name}</div>
      <div>{formatINR(d.value)} · {d.payload.pct}%</div>
    </div>
  );
};

// ── Shared period controls ────────────────────────────────────────────────────
function PeriodControls({ period, setPeriod, viewYear, viewMonth, viewFY, onPrev, onNext, customFrom, setFrom, customTo, setTo, periodLabel }) {
  return (
    <>
      <div style={{padding:'6px var(--page-px) 4px',flexShrink:0}}>
        <div className="period-tabs">
          {PERIODS.map(p=><button key={p} className={`period-tab ${period===p?'active':''}`} onClick={()=>setPeriod(p)}>{p}</button>)}
        </div>
      </div>
      {!['All','Custom'].includes(period)&&(
        <div className="period-picker-row" style={{flexShrink:0}}>
          <button className="pp-arrow" onClick={onPrev}>‹</button>
          <div className="pp-label">{periodLabel}</div>
          <button className="pp-arrow" onClick={onNext}>›</button>
        </div>
      )}
      {period==='Custom'&&(
        <div style={{display:'flex',gap:8,padding:'6px var(--page-px)',flexShrink:0}}>
          <input type="date" className="form-input" style={{flex:1}} value={customFrom} onChange={e=>setFrom(e.target.value)}/>
          <span style={{alignSelf:'center',color:'var(--text-muted)'}}>–</span>
          <input type="date" className="form-input" style={{flex:1}} value={customTo} onChange={e=>setTo(e.target.value)}/>
        </div>
      )}
    </>
  );
}

// ── Category Detail screen ────────────────────────────────────────────────────
function CategoryDetail({ catName, initPeriod, initYear, initMonth, initFY, allTxns, onBack }) {
  const now = new Date();
  const [period,    setPeriod]   = useState(initPeriod  || 'Month');
  const [viewYear,  setViewYear] = useState(initYear    || now.getFullYear());
  const [viewMonth, setViewMonth]= useState(initMonth   ?? now.getMonth());
  const [viewFY,    setViewFY]   = useState(initFY      || currentFY());
  const [customFrom,setFrom]     = useState('');
  const [customTo,  setTo]       = useState('');
  const [selSub,    setSelSub]   = useState(null);
  const [addDate,   setAddDate]  = useState(null);
  const [addCat,    setAddCat]   = useState(null);
  const [selected,  setSelected] = useState(new Set());
  const [multiMode, setMultiMode] = useState(false);

  const catTxns = useMemo(() => allTxns.filter(t => t.Category === catName), [allTxns, catName]);

  const applyPeriod = (txns) => {
    if (period==='Month')  return txns.filter(t=>{const d=parseDate(t.Date);return d.getFullYear()===viewYear&&d.getMonth()===viewMonth;});
    if (period==='Year')   return txns.filter(t=>parseDate(t.Date).getFullYear()===viewYear);
    if (period==='FY')     return txns.filter(t=>{const d=parseDate(t.Date);return d>=fyStart(viewFY)&&d<=fyEnd(viewFY);});
    if (period==='Custom'&&customFrom&&customTo){const f=new Date(customFrom),to=new Date(customTo+'T23:59:59');return txns.filter(t=>{const d=parseDate(t.Date);return d>=f&&d<=to;});}
    return txns;
  };
  const periodTxns = useMemo(() => applyPeriod(catTxns), [catTxns,period,viewYear,viewMonth,viewFY,customFrom,customTo]);
  const filtTxns   = useMemo(() => selSub ? periodTxns.filter(t=>t.Subcategory===selSub) : periodTxns, [periodTxns,selSub]);

  const subData = useMemo(() => {
    const map = {};
    for (const t of periodTxns) { const s=t.Subcategory; if(!s||s==='Default') continue; map[s]=(map[s]||0)+txnAmount(t); }
    return Object.entries(map).sort((a,b)=>b[1]-a[1]);
  }, [periodTxns]);

  const totals   = useMemo(() => calcTotals(filtTxns), [filtTxns]);
  const totalAmt = periodTxns.reduce((s,t)=>s+txnAmount(t),0);

  const prev = () => {
    if(period==='Month'){if(viewMonth===0){setViewMonth(11);setViewYear(y=>y-1);}else setViewMonth(m=>m-1);}
    if(period==='Year') setViewYear(y=>y-1);
    if(period==='FY')   setViewFY(y=>y-1);
  };
  const next = () => {
    if(period==='Month'){if(viewMonth===11){setViewMonth(0);setViewYear(y=>y+1);}else setViewMonth(m=>m+1);}
    if(period==='Year') setViewYear(y=>y+1);
    if(period==='FY')   setViewFY(y=>y+1);
  };
  const swipe = useSwipe(next, prev);
  const periodLabel = period==='Month'?`${MS_F[viewMonth]} ${viewYear}`:period==='Year'?String(viewYear):period==='FY'?fyLabel(viewFY):period==='Custom'&&customFrom&&customTo?`${customFrom} – ${customTo}`:'All Time';

  const toggleSel = t => setSelected(p => { const s = new Set(p); s.has(t._id) ? s.delete(t._id) : s.add(t._id); return s; });

  const selTotals = useMemo(() => {
    let inc = 0, exp = 0, xfr = 0;
    for (const t of filtTxns.filter(r => selected.has(r._id))) {
      const tp = txnType(t), amt = txnAmount(t);
      if (tp === 'income') inc += amt;
      else if (tp === 'expense') exp += amt;
      else xfr += amt;
    }
    return { inc, exp, xfr };
  }, [filtTxns, selected]);

  const trendData = useMemo(() => {
    const now = new Date();
    return Array.from({length:6}, (_,i) => {
      const d = new Date(now.getFullYear(), now.getMonth()-5+i, 1);
      const src = selSub ? catTxns.filter(t=>t.Subcategory===selSub) : catTxns;
      const amt = src.filter(t=>{const td=parseDate(t.Date);return td.getFullYear()===d.getFullYear()&&td.getMonth()===d.getMonth();})
                      .reduce((s,t)=>s+txnAmount(t),0);
      return { name: MS_S[d.getMonth()], amt };
    });
  }, [catTxns, selSub]);

  const groupedTxns = useMemo(() => {
    const map = {};
    for (const t of [...filtTxns].sort((a,b)=>parseDate(b.Date)-parseDate(a.Date))) { if(!map[t.Date])map[t.Date]=[]; map[t.Date].push(t); }
    return Object.entries(map);
  }, [filtTxns]);

  return (
    <div className="cat-detail-screen">
      {/* Header with back button */}
      <div className="page-hdr">
        <BackBtn onClick={onBack}/>
        <div style={{flex:1,minWidth:0}}>
          <div className="page-hdr-title" style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{catName}</div>
          <div className="page-hdr-sub">{catTxns.length} total transactions</div>
        </div>
        <div className="entity-badge" style={{background:'var(--expense-bg)',color:'var(--expense)'}}>{formatINRCompact(totalAmt)}</div>
      </div>

      <div className="cat-detail-body" {...(multiMode ? {} : swipe)}>
        <PeriodControls period={period} setPeriod={setPeriod}
          viewYear={viewYear} viewMonth={viewMonth} viewFY={viewFY}
          onPrev={prev} onNext={next}
          customFrom={customFrom} setFrom={setFrom} customTo={customTo} setTo={setTo}
          periodLabel={periodLabel}/>

        <div className="bal-strip" style={{flexShrink:0}}>
          <div className="bal-strip-item"><div className="bal-strip-l">Income</div><div className="bal-strip-v" style={{color:'var(--income)'}}>{formatINR(totals.income)}</div></div>
          <div className="bal-strip-div"/>
          <div className="bal-strip-item"><div className="bal-strip-l">Expense</div><div className="bal-strip-v" style={{color:'var(--expense)'}}>{formatINR(totals.expense)}</div></div>
          <div className="bal-strip-div"/>
          <div className="bal-strip-item"><div className="bal-strip-l">Txns</div><div className="bal-strip-v">{filtTxns.length}</div></div>
        </div>

        {/* 6-month trend chart */}
        <div style={{padding:'8px var(--page-px) 4px',flexShrink:0}}>
          <div style={{fontSize:'0.62rem',fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.7px',marginBottom:6}}>
            6-Month Trend{selSub ? ` — ${selSub}` : ''}
          </div>
          <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--r-lg)',padding:'10px 6px 4px'}}>
            <ResponsiveContainer width="100%" height={110}>
              <LineChart data={trendData} margin={{top:4,right:4,bottom:0,left:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false}/>
                <XAxis dataKey="name" tick={{fontSize:9,fill:'var(--text-muted)'}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fontSize:9,fill:'var(--text-muted)'}} axisLine={false} tickLine={false} tickFormatter={v=>formatINRCompact(v)} width={38}/>
                <Tooltip formatter={v=>[formatINR(v),'Amount']} contentStyle={{background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,fontSize:11}}/>
                <Line type="monotone" dataKey="amt" stroke="var(--expense)" strokeWidth={2.5}
                  dot={{fill:'var(--expense)',r:4,strokeWidth:0}}
                  activeDot={{r:6,fill:'var(--expense)',stroke:'rgba(255,77,106,0.3)',strokeWidth:4}}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Subcategories as list with totals */}
        {subData.length>0&&(
          <div style={{flexShrink:0}}>
            <div className="cat-sub-list-header">
              <span>Subcategories</span>
              {selSub&&<button className="btn btn-ghost btn-sm" style={{padding:'2px 8px',fontSize:'0.68rem'}} onClick={()=>setSelSub(null)}>Show all</button>}
            </div>
            <div className={`cat-sub-list-row ${!selSub?'sub-active':''}`} onClick={()=>setSelSub(null)}>
              <div className="cat-sub-list-name">All</div>
              <div className="cat-sub-list-amt">{formatINR(totalAmt)}</div>
            </div>
            {subData.map(([sub,amt])=>(
              <div key={sub} className={`cat-sub-list-row ${selSub===sub?'sub-active':''}`} onClick={()=>setSelSub(selSub===sub?null:sub)}>
                <div className="cat-sub-list-name">{sub}</div>
                <div className="cat-sub-list-amt">{formatINR(amt)}</div>
              </div>
            ))}
          </div>
        )}

        {/* Date-grouped transactions */}
        {filtTxns.length===0
          ? <div className="empty-state"><div className="empty-icon">📭</div><div className="empty-title">No transactions</div><div className="empty-desc">{periodLabel}</div></div>
          : <>
              {multiMode && selected.size > 0 && (
                <div className="search-sel-bar">
                  <div style={{display:'flex',alignItems:'center',gap:6,flex:1,flexWrap:'wrap'}}>
                    <span style={{fontWeight:800,fontSize:'0.82rem'}}>{selected.size} selected</span>
                    {selTotals.inc > 0 && <span className="sel-total-inc">+{formatINR(selTotals.inc)}</span>}
                    {selTotals.exp > 0 && <span className="sel-total-exp">−{formatINR(selTotals.exp)}</span>}
                    {selTotals.xfr > 0 && <span className="sel-total-xfr">⇄{formatINR(selTotals.xfr)}</span>}
                    {(selTotals.inc > 0 || selTotals.exp > 0) && (
                      <span className="sel-total-net" style={{color: selTotals.inc - selTotals.exp >= 0 ? 'var(--income)' : 'var(--expense)'}}>
                        = {selTotals.inc - selTotals.exp >= 0 ? '+' : '−'}{formatINR(Math.abs(selTotals.inc - selTotals.exp))}
                      </span>
                    )}
                  </div>
                  <button style={{background:'none',border:'none',color:'var(--accent)',fontWeight:700,cursor:'pointer',flexShrink:0,fontSize:'0.82rem'}} onClick={() => { setMultiMode(false); setSelected(new Set()); }}>Done</button>
                </div>
              )}
              {groupedTxns.map(([dk,txns])=>{
                const gt=calcTotals(txns), d=parseDate(txns[0].Date);
                return (
                  <div key={dk} className="date-group-container">
                    <div className="dg-header" onClick={multiMode ? null : ()=>{ setAddDate(txns[0].Date); setAddCat(catName); }}>
                      <div className="dg-left">
                        <div className="dg-day">{d.getDate()}</div>
                        <div className="dg-meta">
                          <div className="dg-wday">{d.toLocaleDateString('en-IN',{weekday:'short'}).toUpperCase()}</div>
                          <div className="dg-month">{MS_S[d.getMonth()]} {d.getFullYear()}</div>
                        </div>
                      </div>
                      <div className="dg-totals">
                        {gt.income>0&&<span className="dg-inc">+{formatINR(gt.income)}</span>}
                        {gt.expense>0&&<span className="dg-exp">−{formatINR(gt.expense)}</span>}
                      </div>
                    </div>
                    <div className="dg-items">{txns.map(t=><TransactionItem key={t._id} transaction={t}
                      selected={selected.has(t._id)}
                      onLongPress={tt => { setMultiMode(true); setSelected(new Set([tt._id])); }}
                      onTap={multiMode ? toggleSel : null}
                    />)}</div>
                  </div>
                );
              })}
            </>
        }
        <div style={{height:24}}/>
      </div>

      {addDate&&<AddTransaction prefillDate={addDate} prefillCategory={addCat} onClose={()=>{ setAddDate(null); setAddCat(null); }}/>}
    </div>
  );
}

// ── Main Categories screen ────────────────────────────────────────────────────
export default function Categories({ backInterceptRef } = {}) {
  const { state } = useApp();
  const { transactions } = state;
  const now = new Date();

  const [catType,   setCatType]  = useState('Expense');
  const [period,    setPeriod]   = useState('Month');
  const [viewYear,  setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth]= useState(now.getMonth());
  const [viewFY,    setViewFY]   = useState(currentFY());
  const [customFrom,setFrom]     = useState('');
  const [customTo,  setTo]       = useState('');
  const [drill,     setDrill]    = useState(null);

  // Register Android back intercept when category drill-down is open
  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (drill) {
      backInterceptRef.current = () => setDrill(null);
    } else {
      backInterceptRef.current = null;
    }
    return () => { if (backInterceptRef) backInterceptRef.current = null; };
  }, [drill, backInterceptRef]);

  const periodTxns = useMemo(() => {
    let txns = transactions;
    if (period==='Month')  txns=txns.filter(t=>{const d=parseDate(t.Date);return d.getFullYear()===viewYear&&d.getMonth()===viewMonth;});
    if (period==='Year')   txns=txns.filter(t=>parseDate(t.Date).getFullYear()===viewYear);
    if (period==='FY')     txns=txns.filter(t=>{const d=parseDate(t.Date);return d>=fyStart(viewFY)&&d<=fyEnd(viewFY);});
    if (period==='Custom'&&customFrom&&customTo){const f=new Date(customFrom),to=new Date(customTo+'T23:59:59');txns=txns.filter(t=>{const d=parseDate(t.Date);return d>=f&&d<=to;});}
    return txns;
  }, [transactions,period,viewYear,viewMonth,viewFY,customFrom,customTo]);

  // Only show expense or income based on tab
  const typeTxns = useMemo(() =>
    periodTxns.filter(t => catType==='Income' ? txnType(t)==='income' : txnType(t)==='expense'),
    [periodTxns,catType]);

  const totalAmt = useMemo(() => typeTxns.reduce((s,t)=>s+txnAmount(t),0), [typeTxns]);

  const catData = useMemo(() => {
    const map = {};
    for (const t of typeTxns) { const c=t.Category||'Others'; map[c]=(map[c]||0)+txnAmount(t); }
    return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([name,amt],i)=>({ name, amt, pct:totalAmt>0?Math.round((amt/totalAmt)*100):0, color:PIE_COLORS[i%PIE_COLORS.length] }));
  }, [typeTxns,totalAmt]);

  const prev = () => {
    if(period==='Month'){if(viewMonth===0){setViewMonth(11);setViewYear(y=>y-1);}else setViewMonth(m=>m-1);}
    if(period==='Year') setViewYear(y=>y-1);
    if(period==='FY')   setViewFY(y=>y-1);
  };
  const next = () => {
    if(period==='Month'){if(viewMonth===11){setViewMonth(0);setViewYear(y=>y+1);}else setViewMonth(m=>m+1);}
    if(period==='Year') setViewYear(y=>y+1);
    if(period==='FY')   setViewFY(y=>y+1);
  };
  const catSwipe = useSwipe(next, prev);
  const periodLabel = period==='Month'?`${MS_F[viewMonth]} ${viewYear}`:period==='Year'?String(viewYear):period==='FY'?fyLabel(viewFY):period==='Custom'&&customFrom&&customTo?`${customFrom} – ${customTo}`:'All Time';

  if (drill) return (
    <CategoryDetail catName={drill} allTxns={transactions}
      initPeriod={period} initYear={viewYear} initMonth={viewMonth} initFY={viewFY}
      onBack={()=>setDrill(null)}/>
  );

  return (
    <div className="cat-screen" {...catSwipe}>
      <div className="page-hdr">
        <div style={{flex:1}}>
          <div className="page-hdr-title">Categories</div>
          <div className="page-hdr-sub">{catType} · {formatINR(totalAmt)}</div>
        </div>
      </div>

      {/* Income / Expense tabs with totals */}
      {(() => {
        const incTotal = periodTxns.filter(t=>txnType(t)==='income').reduce((s,t)=>s+txnAmount(t),0);
        const expTotal = periodTxns.filter(t=>txnType(t)==='expense').reduce((s,t)=>s+txnAmount(t),0);
        return (
          <div style={{padding:'6px var(--page-px) 4px',flexShrink:0}}>
            <div className="cat-type-tabs">
              <button className={`cat-type-tab exp-tab ${catType==='Expense'?'active':''}`} onClick={()=>setCatType('Expense')}>
                <div style={{fontSize:'0.72rem',fontWeight:700}}>Expense</div>
                <div style={{fontSize:'0.74rem',fontFamily:'var(--font-mono)',fontWeight:800,color:catType==='Expense'?'var(--expense)':'var(--text-muted)',marginTop:2}}>{formatINR(expTotal)}</div>
              </button>
              <button className={`cat-type-tab inc-tab ${catType==='Income'?'active':''}`} onClick={()=>setCatType('Income')}>
                <div style={{fontSize:'0.72rem',fontWeight:700}}>Income</div>
                <div style={{fontSize:'0.74rem',fontFamily:'var(--font-mono)',fontWeight:800,color:catType==='Income'?'var(--income)':'var(--text-muted)',marginTop:2}}>{formatINR(incTotal)}</div>
              </button>
            </div>
          </div>
        );
      })()}

      <PeriodControls period={period} setPeriod={setPeriod}
        viewYear={viewYear} viewMonth={viewMonth} viewFY={viewFY}
        onPrev={prev} onNext={next}
        customFrom={customFrom} setFrom={setFrom} customTo={customTo} setTo={setTo}
        periodLabel={periodLabel}/>

      <div style={{flex:1,overflow:'auto'}}>
        {catData.length>0&&(
          <div className="cat-pie-wrap">
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={catData} dataKey="amt" nameKey="name" cx="50%" cy="50%" outerRadius={76} innerRadius={38}>
                  {catData.map((c,i)=><Cell key={i} fill={c.color}/>)}
                </Pie>
                <Tooltip content={<PieTip/>}/>
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}

        {catData.length===0
          ? <div className="empty-state"><div className="empty-icon">🏷️</div><div className="empty-title">No {catType.toLowerCase()} data</div><div className="empty-desc">{periodLabel}</div></div>
          : catData.map(c=>(
              <div key={c.name} className="cat-list-row" onClick={()=>setDrill(c.name)}>
                <div className="cat-pct-badge" style={{background:c.color+'28',color:c.color}}>{c.pct}%</div>
                <div className="cat-list-name">{c.name}</div>
                <div className="cat-list-amt" style={{color:catType==='Income'?'var(--income)':'var(--expense)'}}>{formatINR(c.amt)}</div>
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="11" height="11"><path d="M9 18l6-6-6-6"/></svg>
              </div>
            ))
        }
        <div style={{height:24}}/>
      </div>
    </div>
  );
}