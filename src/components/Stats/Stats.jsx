import React, { useMemo, useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, formatCompact, parseDate, monthName } from '../../utils/format.js';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import './Stats.css';

const COLORS = ['#ff4d6a','#ffd166','#a78bfa','#4d9fff','#00e5a0','#fb923c','#2dd4bf','#f472b6'];

export default function Stats() {
  const { state } = useApp();
  const { transactions } = state;
  const [period, setPeriod] = useState('month');
  const [tab,    setTab]    = useState('expense'); // expense | income

  const now = new Date();

  const filtered = useMemo(() => {
    if (period === 'month') return transactions.filter(t => {
      const d = parseDate(t.Date);
      return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
    });
    if (period === 'year') return transactions.filter(t => parseDate(t.Date).getFullYear()===now.getFullYear());
    return transactions;
  }, [transactions, period]);

  const totals = useMemo(() => {
    const inc = filtered.filter(t=>t['Income/Expense']==='Income').reduce((s,t)=>s+parseFloat(t.INR||0),0);
    const exp = filtered.filter(t=>t['Income/Expense']==='Expense').reduce((s,t)=>s+parseFloat(t.INR||0),0);
    return { inc, exp, net: inc-exp };
  }, [filtered]);

  // Category breakdown
  const catData = useMemo(() => {
    const type = tab === 'expense' ? 'Expense' : 'Income';
    const map = {};
    filtered.filter(t=>t['Income/Expense']===type).forEach(t => {
      const k = t.Category || 'Uncategorised';
      map[k] = (map[k]||0) + parseFloat(t.INR||0);
    });
    const total = Object.values(map).reduce((s,v)=>s+v, 0) || 1;
    return Object.entries(map)
      .sort(([,a],[,b]) => b-a)
      .map(([name, value]) => ({ name, value, pct: ((value/total)*100).toFixed(1) }));
  }, [filtered, tab]);

  // Subcategory breakdown for top category
  const [expandedCat, setExpandedCat] = useState(null);
  const subData = useMemo(() => {
    if (!expandedCat) return [];
    const type = tab === 'expense' ? 'Expense' : 'Income';
    const map = {};
    filtered.filter(t=>t['Income/Expense']===type && t.Category===expandedCat).forEach(t => {
      const k = t.Subcategory || 'Default';
      map[k] = (map[k]||0) + parseFloat(t.INR||0);
    });
    return Object.entries(map).sort(([,a],[,b])=>b-a).map(([name,value])=>({name,value}));
  }, [filtered, expandedCat, tab]);

  // Monthly trend bar chart (last 6 months)
  const trendData = useMemo(() => {
    return Array.from({length:6}, (_,i) => {
      const d = new Date(now.getFullYear(), now.getMonth()-5+i, 1);
      const m = d.getMonth(); const y = d.getFullYear();
      const txns = transactions.filter(t => {
        const td = parseDate(t.Date);
        return td.getMonth()===m && td.getFullYear()===y;
      });
      const inc = txns.filter(t=>t['Income/Expense']==='Income').reduce((s,t)=>s+parseFloat(t.INR||0),0);
      const exp = txns.filter(t=>t['Income/Expense']==='Expense').reduce((s,t)=>s+parseFloat(t.INR||0),0);
      return { name: monthName(m), inc, exp };
    });
  }, [transactions]);

  const maxBar = Math.max(...trendData.flatMap(d=>[d.inc,d.exp]),1);

  return (
    <div className="stats-screen">
      <div className="page-header">
        <div>
          <div className="page-title">Analytics</div>
          <div className="page-subtitle">{periodLabel(period)}</div>
        </div>
      </div>

      {/* Period selector */}
      <div className="period-tabs">
        {[['month','Month'],['year','Year'],['all','All Time']].map(([v,l]) => (
          <button key={v} className={`period-tab ${period===v?'active':''}`} onClick={() => setPeriod(v)}>{l}</button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="stats-summary">
        <div className="stats-sum-card income">
          <div className="stats-sum-label">Income</div>
          <div className="stats-sum-val">{formatCompact(totals.inc)}</div>
        </div>
        <div className="stats-sum-card expense">
          <div className="stats-sum-label">Expense</div>
          <div className="stats-sum-val">{formatCompact(totals.exp)}</div>
        </div>
        <div className={`stats-sum-card ${totals.net>=0?'savings':'deficit'}`}>
          <div className="stats-sum-label">{totals.net>=0?'Saved':'Deficit'}</div>
          <div className="stats-sum-val">{formatCompact(Math.abs(totals.net))}</div>
        </div>
      </div>

      {/* Trend chart */}
      <div className="section-label" style={{marginTop:24}}>Monthly Trend</div>
      <div className="card stats-chart-card">
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={trendData} barGap={2} barCategoryGap="30%">
            <XAxis dataKey="name" axisLine={false} tickLine={false}
              tick={{ fill:'var(--text3)', fontSize:10, fontFamily:'Sora' }} />
            <YAxis hide domain={[0, maxBar*1.1]} />
            <Tooltip
              contentStyle={{ background:'var(--card2)', border:'1px solid var(--border)', borderRadius:10, fontFamily:'Sora', fontSize:12 }}
              labelStyle={{ color:'var(--text2)' }}
              formatter={(v) => formatINR(v)}
            />
            <Bar dataKey="inc" fill="var(--green)" radius={[4,4,0,0]} name="Income" />
            <Bar dataKey="exp" fill="var(--red)"   radius={[4,4,0,0]} name="Expense" />
          </BarChart>
        </ResponsiveContainer>
        <div className="stats-chart-legend">
          <span><span className="legend-dot inc"/>Income</span>
          <span><span className="legend-dot exp"/>Expense</span>
        </div>
      </div>

      {/* Category breakdown */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'24px 20px 10px'}}>
        <div className="section-label" style={{padding:0,margin:0}}>By Category</div>
        <div className="stat-type-tabs">
          <button className={`stat-type-tab ${tab==='expense'?'active exp':''}`} onClick={() => { setTab('expense'); setExpandedCat(null); }}>Expense</button>
          <button className={`stat-type-tab ${tab==='income' ?'active inc':''}`} onClick={() => { setTab('income');  setExpandedCat(null); }}>Income</button>
        </div>
      </div>

      {catData.length > 0 ? (
        <>
          {/* Donut chart */}
          <div className="card stats-donut-card">
            <div className="stats-donut-wrap">
              <PieChart width={130} height={130}>
                <Pie data={catData} cx={60} cy={60} innerRadius={38} outerRadius={60}
                  dataKey="value" startAngle={90} endAngle={-270} paddingAngle={2}>
                  {catData.map((_, i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
                </Pie>
              </PieChart>
              <div className="stats-donut-legend">
                {catData.slice(0,5).map((d,i) => (
                  <div key={d.name} className="donut-legend-row" onClick={() => setExpandedCat(expandedCat===d.name?null:d.name)}>
                    <span className="donut-dot" style={{background:COLORS[i%COLORS.length]}} />
                    <span className="donut-name">{d.name}</span>
                    <span className="donut-pct">{d.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Category rows */}
          <div className="card stats-cat-list">
            {catData.map((d,i) => {
              const total = catData.reduce((s,c)=>s+c.value,0)||1;
              return (
                <div key={d.name}>
                  <div className="stats-cat-row card-pressable" onClick={() => setExpandedCat(expandedCat===d.name?null:d.name)}>
                    <div className="stats-cat-icon" style={{background:`${COLORS[i%COLORS.length]}20`}}>
                      <span style={{color:COLORS[i%COLORS.length],fontSize:10,fontWeight:800}}>{d.pct}%</span>
                    </div>
                    <div className="stats-cat-info">
                      <div className="stats-cat-name">{d.name}</div>
                      <div className="progress-track" style={{marginTop:6}}>
                        <div className="progress-fill" style={{width:`${(d.value/total)*100}%`,background:COLORS[i%COLORS.length]}} />
                      </div>
                    </div>
                    <div className="stats-cat-amt" style={{color: tab==='expense'?'var(--red)':'var(--green)'}}>
                      {formatINR(d.value)}
                    </div>
                  </div>
                  {expandedCat===d.name && subData.map(s => (
                    <div key={s.name} className="stats-sub-row">
                      <span className="stats-sub-dot" style={{background:COLORS[i%COLORS.length]}}/>
                      <span className="stats-sub-name">{s.name}</span>
                      <span className="stats-sub-amt">{formatINR(s.value)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="empty-state"><div className="empty-icon">📊</div><div className="empty-title">No data</div><div className="empty-sub">Add transactions to see analytics</div></div>
      )}

      <div style={{height:20}} />
    </div>
  );
}

function periodLabel(p) {
  const now = new Date();
  if (p==='month') return `${monthName(now.getMonth())} ${now.getFullYear()}`;
  if (p==='year')  return `Year ${now.getFullYear()}`;
  return 'All Time';
}
