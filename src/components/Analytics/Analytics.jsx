import React, { useState, useMemo } from 'react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useApp } from '../../contexts/AppContext.jsx';
import {
  parseDate, formatINR, formatINRCompact, calcTotals, txnType, txnAmount,
  getCategoryEmoji, getFY, fyLabel, fyStart, fyEnd, currentFY,
} from '../../utils/format.js';
import './Analytics.css';

const COLORS = ['#ff4d6a','#ffd166','#a78bfa','#4d9fff','#00e5a0','#fb8500','#06d6a0'];

const PERIODS = ['Month','Year','FY','All'];

const CustomTooltip = ({active,payload}) => {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:10,padding:'8px 12px',fontSize:12}}>
      <div style={{fontWeight:700,color:'var(--text-primary)',marginBottom:4}}>{payload[0]?.payload?.label||payload[0]?.name}</div>
      {payload.map((p,i)=><div key={i} style={{color:p.color,marginTop:2}}>{p.name}: {formatINR(p.value)}</div>)}
    </div>
  );
};

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function Analytics() {
  const { state } = useApp();
  const { transactions } = state;

  const now     = new Date();
  const [period,    setPeriod]    = useState('Month');
  const [viewType,  setViewType]  = useState('expense');
  // Month picker
  const [selYear,   setSelYear]   = useState(now.getFullYear());
  const [selMonth,  setSelMonth]  = useState(now.getMonth());
  // Year picker
  const [selAYear,  setSelAYear]  = useState(now.getFullYear());
  // FY picker
  const [selFY,     setSelFY]     = useState(currentFY());

  // Available years
  const availYears = useMemo(() => {
    const ys = new Set(transactions.map(t=>parseDate(t.Date).getFullYear()).filter(y=>y>2000));
    ys.add(now.getFullYear()); return [...ys].sort((a,b)=>b-a);
  }, [transactions]);

  const availFYs = useMemo(() => {
    const fys = new Set(transactions.map(t=>getFY(t.Date)));
    fys.add(currentFY()); return [...fys].sort((a,b)=>b-a);
  }, [transactions]);

  // Filtered transactions for selected period
  const periodTxns = useMemo(() => {
    if (period==='All') return transactions;
    if (period==='Month') return transactions.filter(t => {
      const d=parseDate(t.Date); return d.getFullYear()===selYear && d.getMonth()===selMonth;
    });
    if (period==='Year') return transactions.filter(t => parseDate(t.Date).getFullYear()===selAYear);
    if (period==='FY')   return transactions.filter(t => {
      const d=parseDate(t.Date); return d>=fyStart(selFY) && d<=fyEnd(selFY);
    });
    return transactions;
  }, [transactions, period, selYear, selMonth, selAYear, selFY]);

  const totals = useMemo(() => calcTotals(periodTxns), [periodTxns]);

  // Period label (shown in summary)
  const periodLabel = useMemo(() => {
    if (period==='Month') return new Date(selYear,selMonth,1).toLocaleDateString('en-IN',{month:'long',year:'numeric'});
    if (period==='Year')  return `Calendar Year ${selAYear}`;
    if (period==='FY')    return fyLabel(selFY);
    return 'All Time';
  }, [period, selYear, selMonth, selAYear, selFY]);

  // Number of months in period (for averages)
  const numMonths = useMemo(() => {
    if (period==='Month') return 1;
    if (period==='Year') {
      // count distinct months in that year that have data, min 1
      const ms = new Set(periodTxns.map(t=>parseDate(t.Date).getMonth())); return Math.max(1, ms.size);
    }
    if (period==='FY') {
      const ms = new Set(periodTxns.map(t => {
        const d=parseDate(t.Date); return `${d.getFullYear()}-${d.getMonth()}`;
      })); return Math.max(1, ms.size);
    }
    if (period==='All') {
      const ms = new Set(periodTxns.map(t => {
        const d=parseDate(t.Date); return `${d.getFullYear()}-${d.getMonth()}`;
      })); return Math.max(1, ms.size);
    }
    return 1;
  }, [period, periodTxns]);

  const showAverage = period==='Year' || period==='FY' || period==='All';

  // Category data
  const categoryData = useMemo(() => {
    const map = {};
    for (const t of periodTxns) {
      if (txnType(t)!==viewType) continue;
      const cat=t.Category||'Other';
      map[cat]=(map[cat]||0)+txnAmount(t);
    }
    return Object.entries(map).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value).slice(0,7);
  }, [periodTxns, viewType]);
  const catTotal = categoryData.reduce((s,d)=>s+d.value,0)||1;

  // 6-month or 12-month bar data
  const barData = useMemo(() => {
    if (period==='Year') {
      return MONTHS_SHORT.map((label,mi)=>({
        label,
        income:  calcTotals(transactions.filter(t=>{const d=parseDate(t.Date);return d.getFullYear()===selAYear&&d.getMonth()===mi;})).income,
        expense: calcTotals(transactions.filter(t=>{const d=parseDate(t.Date);return d.getFullYear()===selAYear&&d.getMonth()===mi;})).expense,
      }));
    }
    if (period==='FY') {
      return Array.from({length:12},(_,i)=>{
        const mi=(3+i)%12, yr=i<9?selFY:selFY+1;
        const txns=transactions.filter(t=>{const d=parseDate(t.Date);return d.getFullYear()===yr&&d.getMonth()===mi;});
        return {label:MONTHS_SHORT[mi],...calcTotals(txns)};
      });
    }
    // Default: last 6 months ending at viewed month
    return Array.from({length:6},(_,i)=>{
      const d=new Date(selYear,selMonth-5+i,1);
      const txns=transactions.filter(t=>{const td=parseDate(t.Date);return td.getFullYear()===d.getFullYear()&&td.getMonth()===d.getMonth();});
      return {label:MONTHS_SHORT[d.getMonth()],...calcTotals(txns)};
    });
  }, [transactions, period, selYear, selMonth, selAYear, selFY]);

  // Account breakdown
  const accountData = useMemo(() => {
    const map={};
    for(const t of periodTxns){
      const acct=t.Account||'Unknown';
      if(!map[acct]) map[acct]={income:0,expense:0};
      if(txnType(t)==='income')  map[acct].income  +=txnAmount(t);
      if(txnType(t)==='expense') map[acct].expense +=txnAmount(t);
    }
    return Object.entries(map).map(([name,d])=>({name,...d})).sort((a,b)=>(b.income+b.expense)-(a.income+a.expense)).slice(0,6);
  }, [periodTxns]);

  return (
    <div className="analytics-screen">
      <div className="page-hdr">
        <div className="page-hdr-title">Analytics</div>
      </div>

      {/* Period selector */}
      <div className="analytics-periods">
        <div className="period-tabs">
          {PERIODS.map(p=>(
            <button key={p} className={`period-tab ${period===p?'active':''}`} onClick={()=>setPeriod(p)}>{p}</button>
          ))}
        </div>
      </div>

      {/* Period picker row */}
      {period==='Month' && (
        <div className="period-picker-row">
          <button className="pp-arrow" onClick={()=>{ if(selMonth===0){setSelMonth(11);setSelYear(y=>y-1);}else setSelMonth(m=>m-1); }}>‹</button>
          <div className="pp-label">{new Date(selYear,selMonth,1).toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</div>
          <button className="pp-arrow" onClick={()=>{ if(selYear>now.getFullYear()||(selYear===now.getFullYear()&&selMonth>=now.getMonth())) return; if(selMonth===11){setSelMonth(0);setSelYear(y=>y+1);}else setSelMonth(m=>m+1); }} style={{opacity:(selYear===now.getFullYear()&&selMonth>=now.getMonth())?0.3:1}}>›</button>
        </div>
      )}
      {period==='Year' && (
        <div className="period-picker-row">
          <button className="pp-arrow" onClick={()=>setSelAYear(y=>y-1)}>‹</button>
          <div className="pp-label">{selAYear}</div>
          <button className="pp-arrow" onClick={()=>setSelAYear(y=>Math.min(y+1,now.getFullYear()))} style={{opacity:selAYear>=now.getFullYear()?0.3:1}}>›</button>
        </div>
      )}
      {period==='FY' && (
        <div className="period-picker-row">
          <button className="pp-arrow" onClick={()=>setSelFY(y=>y-1)}>‹</button>
          <div className="pp-label">{fyLabel(selFY)}</div>
          <button className="pp-arrow" onClick={()=>setSelFY(y=>Math.min(y+1,currentFY()))} style={{opacity:selFY>=currentFY()?0.3:1}}>›</button>
        </div>
      )}

      {/* Summary cards */}
      <div className="an-summary">
        <div className="an-sum-card income">
          <div className="an-sum-label">Income</div>
          <div className="an-sum-val">{formatINRCompact(totals.income)}</div>
          {showAverage && numMonths>1 && <div className="an-sum-avg">~{formatINRCompact(totals.income/numMonths)}/mo</div>}
        </div>
        <div className="an-sum-card expense">
          <div className="an-sum-label">Expenses</div>
          <div className="an-sum-val">{formatINRCompact(totals.expense)}</div>
          {showAverage && numMonths>1 && <div className="an-sum-avg">~{formatINRCompact(totals.expense/numMonths)}/mo</div>}
        </div>
        <div className="an-sum-card savings">
          <div className="an-sum-label">Saved</div>
          <div className="an-sum-val">{formatINRCompact(Math.max(0,totals.balance))}</div>
          {showAverage && numMonths>1 && <div className="an-sum-avg">~{formatINRCompact(Math.max(0,totals.balance)/numMonths)}/mo</div>}
        </div>
      </div>

      {/* Bar chart */}
      <div className="an-card">
        <div className="an-card-title">{period==='Year'?`${selAYear} Monthly`:period==='FY'?`${fyLabel(selFY)} Monthly`:`6 Months to ${new Date(selYear,selMonth,1).toLocaleDateString('en-IN',{month:'short',year:'numeric'})}`}</div>
        <ResponsiveContainer width="100%" height={150}>
          <BarChart data={barData} barGap={3} barSize={10}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false}/>
            <XAxis dataKey="label" tick={{fill:'#4a5a7a',fontSize:10,fontFamily:'Sora'}} axisLine={false} tickLine={false}/>
            <YAxis hide/>
            <Tooltip content={<CustomTooltip/>} cursor={{fill:'rgba(255,255,255,0.03)'}}/>
            <Bar dataKey="income"  fill="#00e5a0" radius={[3,3,0,0]} name="Income"/>
            <Bar dataKey="expense" fill="#ff4d6a" radius={[3,3,0,0]} name="Expense"/>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Category breakdown */}
      <div className="an-card">
        <div className="an-card-hdr">
          <div className="an-card-title" style={{marginBottom:0}}>By Category</div>
          <div className="view-toggle">
            <button className={viewType==='expense'?'active':''} onClick={()=>setViewType('expense')}>Expense</button>
            <button className={viewType==='income'?'active':''} onClick={()=>setViewType('income')}>Income</button>
          </div>
        </div>
        {categoryData.length===0 ? (
          <div style={{padding:'20px',textAlign:'center',color:'var(--text-muted)',fontSize:13}}>No data for this period</div>
        ) : (
          <>
            <div className="cat-donut-row">
              <PieChart width={110} height={110}>
                <Pie data={categoryData} cx={50} cy={50} innerRadius={32} outerRadius={50} dataKey="value" paddingAngle={2} stroke="none">
                  {categoryData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Pie>
              </PieChart>
              <div className="cat-legend">
                {categoryData.map((d,i)=>(
                  <div key={d.name} className="cat-legend-row">
                    <div className="cat-legend-dot" style={{background:COLORS[i%COLORS.length]}}/>
                    <span className="cat-legend-name">{getCategoryEmoji(d.name)} {d.name}</span>
                    <span className="cat-legend-pct">{Math.round((d.value/catTotal)*100)}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="cat-bar-list">
              {categoryData.map((d,i)=>(
                <div key={d.name} className="cat-bar-row">
                  <div className="cat-bar-icon" style={{background:COLORS[i%COLORS.length]+'22'}}>{getCategoryEmoji(d.name)}</div>
                  <div className="cat-bar-info">
                    <div className="cat-bar-name-row">
                      <span className="cat-bar-name">{d.name}</span>
                      <span className="cat-bar-amt" style={{color:COLORS[i%COLORS.length]}}>{formatINR(d.value)}</span>
                    </div>
                    {showAverage && numMonths>1 && (
                      <div className="cat-bar-avg">avg {formatINR(d.value/numMonths)}/mo</div>
                    )}
                    <div className="progress-track" style={{marginTop:4}}>
                      <div className="progress-fill" style={{width:`${(d.value/catTotal)*100}%`,background:COLORS[i%COLORS.length]}}/>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Account breakdown */}
      {accountData.length>0 && (
        <div className="an-card">
          <div className="an-card-title">By Account</div>
          {accountData.map(a=>(
            <div key={a.name} className="an-acct-row">
              <div className="an-acct-name">💳 {a.name}</div>
              <div className="an-acct-vals">
                <span className="amt-income">+{formatINR(a.income)}</span>
                <span className="amt-expense">−{formatINR(a.expense)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="h-8"/>
    </div>
  );
}