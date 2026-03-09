import React, { useMemo, useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, formatCompact, parseDate, monthName } from '../../utils/format.js';
import TxnList from '../Common/TxnList.jsx';
import '../Common/TxnList.css';
import './Dashboard.css';

export default function Dashboard({ onAdd }) {
  const { state, deleteTransaction, dispatch } = useApp();
  const { transactions, accounts, budgets } = state;
  const [period, setPeriod] = useState('month'); // month | year | all

  const now = new Date();

  const { income, expense, balance, filtered } = useMemo(() => {
    let list = [...transactions];
    if (period === 'month') {
      list = list.filter(t => {
        const d = parseDate(t.Date);
        return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
      });
    } else if (period === 'year') {
      list = list.filter(t => parseDate(t.Date).getFullYear()===now.getFullYear());
    }
    const inc = list.filter(t=>t['Income/Expense']==='Income').reduce((s,t)=>s+parseFloat(t.INR||0),0);
    const exp = list.filter(t=>t['Income/Expense']==='Expense').reduce((s,t)=>s+parseFloat(t.INR||0),0);
    return { income:inc, expense:exp, balance:inc-exp, filtered:list };
  }, [transactions, period]);

  // Net worth = sum of all-time (income - expense)
  const netWorth = useMemo(() => {
    const inc = transactions.filter(t=>t['Income/Expense']==='Income').reduce((s,t)=>s+parseFloat(t.INR||0),0);
    const exp = transactions.filter(t=>t['Income/Expense']==='Expense').reduce((s,t)=>s+parseFloat(t.INR||0),0);
    return inc - exp;
  }, [transactions]);

  // 6-month bar chart data
  const barData = useMemo(() => {
    const months = Array.from({length:6}, (_,i) => {
      const d = new Date(now.getFullYear(), now.getMonth()-5+i, 1);
      return { month: d.getMonth(), year: d.getFullYear(), label: monthName(d.getMonth()) };
    });
    return months.map(({ month, year, label }) => {
      const txns = transactions.filter(t => {
        const d = parseDate(t.Date);
        return d.getMonth()===month && d.getFullYear()===year;
      });
      const inc = txns.filter(t=>t['Income/Expense']==='Income').reduce((s,t)=>s+parseFloat(t.INR||0),0);
      const exp = txns.filter(t=>t['Income/Expense']==='Expense').reduce((s,t)=>s+parseFloat(t.INR||0),0);
      return { label, inc, exp };
    });
  }, [transactions]);
  const barMax = Math.max(...barData.flatMap(d=>[d.inc,d.exp]), 1);

  // Budget progress
  const budgetProgress = useMemo(() => {
    return budgets.map(b => {
      const spent = transactions.filter(t => {
        const d = parseDate(t.Date);
        const isThisMonth = d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
        return t.Category === b.category && t['Income/Expense']==='Expense' && isThisMonth;
      }).reduce((s,t)=>s+parseFloat(t.INR||0),0);
      return { ...b, spent, pct: Math.min(100, (spent/b.amount)*100) };
    });
  }, [budgets, transactions]);

  const recent = filtered.slice(0, 10);

  return (
    <div className="dashboard">
      {/* Header */}
      <div className="dash-header">
        <div>
          <div className="dash-greeting-sub">Good {hour()},</div>
          <div className="dash-greeting">FinMan <span className="dash-wave">👋</span></div>
        </div>
        <button className="dash-avatar" onClick={() => dispatch({ type:'SET_VIEW', v:'settings' })}>
          F
        </button>
      </div>

      {/* Net Worth Hero Card */}
      <div className="nw-card">
        <div className="nw-glow" />
        <div className="nw-label">Net Worth</div>
        <div className="nw-amount">{formatINR(netWorth)}</div>
        <div className="nw-period-tabs">
          {['month','year','all'].map(p => (
            <button key={p} className={`nw-period-btn ${period===p?'active':''}`} onClick={() => setPeriod(p)}>
              {p==='month'?'Month':p==='year'?'Year':'All'}
            </button>
          ))}
        </div>
        <div className="nw-stats">
          <div className="nw-stat">
            <div className="nw-stat-label">Income</div>
            <div className="nw-stat-val income">{formatCompact(income)}</div>
          </div>
          <div className="nw-divider" />
          <div className="nw-stat">
            <div className="nw-stat-label">Expense</div>
            <div className="nw-stat-val expense">{formatCompact(expense)}</div>
          </div>
          <div className="nw-divider" />
          <div className="nw-stat">
            <div className="nw-stat-label">Savings</div>
            <div className={`nw-stat-val ${balance>=0?'income':'expense'}`}>{formatCompact(Math.abs(balance))}</div>
          </div>
        </div>
      </div>

      {/* Spending Chart */}
      <div className="section-label" style={{marginTop:24}}>6-Month Overview</div>
      <div className="card dash-chart-card">
        <div className="dash-bar-chart">
          {barData.map((d, i) => (
            <div key={i} className="dash-bar-col">
              <div className="dash-bar-pair">
                <div className="dash-bar inc" style={{ height:`${(d.inc/barMax)*100}%` }} title={formatINR(d.inc)} />
                <div className="dash-bar exp" style={{ height:`${(d.exp/barMax)*100}%` }} title={formatINR(d.exp)} />
              </div>
              <div className="dash-bar-label">{d.label}</div>
            </div>
          ))}
        </div>
        <div className="dash-chart-legend">
          <span><span className="legend-dot inc" />Income</span>
          <span><span className="legend-dot exp" />Expense</span>
        </div>
      </div>

      {/* Account Balances */}
      {accounts.length > 0 && (
        <>
          <div className="section-label" style={{marginTop:24}}>Accounts</div>
          <div className="dash-accounts-scroll">
            {accounts.map(a => {
              const inc = transactions.filter(t=>t.Account===a.name&&t['Income/Expense']==='Income').reduce((s,t)=>s+parseFloat(t.INR||0),0);
              const exp = transactions.filter(t=>t.Account===a.name&&t['Income/Expense']==='Expense').reduce((s,t)=>s+parseFloat(t.INR||0),0);
              const tr_in  = transactions.filter(t=>t.ToAccount===a.name).reduce((s,t)=>s+parseFloat(t.INR||0),0);
              const tr_out = transactions.filter(t=>t.FromAccount===a.name).reduce((s,t)=>s+parseFloat(t.INR||0),0);
              const bal = inc - exp + tr_in - tr_out;
              return (
                <div key={a.id} className="dash-acct-card" style={{ '--acct-color': a.color||'#4d9fff' }}>
                  <div className="dash-acct-icon">{a.icon||'💳'}</div>
                  <div className="dash-acct-name">{a.name}</div>
                  <div className="dash-acct-bal">{formatINR(bal)}</div>
                  <div className="dash-acct-sub">{a.group_name||''}</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Budget Overview */}
      {budgetProgress.length > 0 && (
        <>
          <div className="section-label" style={{marginTop:24}}>Budgets — {monthName(now.getMonth())}</div>
          <div className="card" style={{margin:'0 16px',overflow:'hidden'}}>
            {budgetProgress.map(b => (
              <div key={b.id} className="dash-budget-row">
                <div className="dash-budget-top">
                  <span className="dash-budget-name">{b.category}</span>
                  <span className="dash-budget-vals">
                    <span style={{color: b.pct>=100 ? 'var(--red)' : 'var(--text2)'}}>{formatINR(b.spent)}</span>
                    <span style={{color:'var(--text3)'}}> / {formatINR(b.amount)}</span>
                  </span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{
                    width:`${b.pct}%`,
                    background: b.pct>=100 ? 'var(--red)' : b.pct>=80 ? 'var(--gold)' : 'var(--green)'
                  }} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Recent Transactions */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'24px 20px 10px'}}>
        <div className="section-label" style={{padding:0,margin:0}}>Recent</div>
        <button className="dash-see-all" onClick={() => dispatch({ type:'SET_VIEW', v:'search' })}>
          See all →
        </button>
      </div>
      <TxnList transactions={recent} onDelete={deleteTransaction} />
      <div style={{height:20}} />
    </div>
  );
}

function hour() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}
