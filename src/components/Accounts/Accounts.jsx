import React, { useState, useMemo, useEffect } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseDate, formatINR, formatINRCompact, calcTotals, txnType, txnAmount, currentFY, fyLabel, fyStart, fyEnd } from '../../utils/format.js';
import TransactionItem from '../Transactions/TransactionItem.jsx';
import AddTransaction from '../Transactions/AddTransaction.jsx';
import useSwipe from '../../hooks/useSwipe.js';
import './Accounts.css';

const MS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MS_F = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const PERIODS = ['Month','Year','FY','All','Custom'];

/**
 * Compute running balance for a named account from a list of transactions.
 * Rules (matching legacy logic exactly):
 *   Income     → account += INR
 *   Expense    → account -= INR
 *   Transfer-Out → fromAccount -= INR; toAccount (= ToAccount || Category) += INR
 *   Transfer-In  → toAccount += INR (credit side)
 */
function computeBalance(txns, acctName) {
  let bal = 0;
  for (const t of txns) {
    const amt  = txnAmount(t);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = t.Account || t.FromAccount || '';
    const dest = t.ToAccount || '';

    if (type === 'Income')       { if (acct === acctName) bal += amt; }
    else if (type === 'Expense') { if (acct === acctName) bal -= amt; }
    else if (type === 'Transfer-Out') {
      if (acct === acctName) bal -= amt;
      if (dest === acctName) bal += amt;
    }
    // Transfer-In: skip
  }
  return bal;
}

// Build a full balance map over ALL transactions.
// Skips numeric-looking keys that arise from legacy Transfer-Out rows where
// the Account column held the INR amount rather than a real account name.
function buildBalanceMap(transactions) {
  const map = {};
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
  const ensure = n => { if (n && !looksNumeric(n) && !map[n]) map[n] = 0; };
  const addTo  = (n, v) => { if (n && !looksNumeric(n)) { ensure(n); map[n] = (map[n]||0) + v; } };

  for (const t of transactions) {
    const amt  = txnAmount(t);
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || t.FromAccount || '').trim();
    const dest = String(t.ToAccount || '').trim();

    if      (type === 'Income')       addTo(acct, +amt);
    else if (type === 'Expense')      addTo(acct, -amt);
    else if (type === 'Transfer-Out') { addTo(acct, -amt); addTo(dest, +amt); }
    // Transfer-In: skip — Transfer-Out handles both sides
  }
  return map;
}

// ── Account Detail ────────────────────────────────────────────────────────────
function AccountDetail({ acctName, allTxns, onBack }) {
  const now = new Date();
  const [period,    setPeriod]  = useState('Month');
  const [viewYear,  setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth]= useState(now.getMonth());
  const [viewFY,    setViewFY]  = useState(currentFY());
  const [customFrom,setFrom]    = useState('');
  const [customTo,  setTo]      = useState('');
  const [addDate,   setAddDate] = useState(null);
  const [showAdd,   setShowAdd] = useState(false);

  const acctTxns = useMemo(() =>
    allTxns.filter(t => {
      const acct = t.Account || t.FromAccount || '';
      const dest = t.ToAccount || '';
      return acct === acctName || dest === acctName;
    }), [allTxns, acctName]);

  const periodTxns = useMemo(() => {
    if (period==='Month')  return acctTxns.filter(t=>{const d=parseDate(t.Date);return d.getFullYear()===viewYear&&d.getMonth()===viewMonth;});
    if (period==='Year')   return acctTxns.filter(t=>parseDate(t.Date).getFullYear()===viewYear);
    if (period==='FY')     return acctTxns.filter(t=>{const d=parseDate(t.Date);return d>=fyStart(viewFY)&&d<=fyEnd(viewFY);});
    if (period==='Custom'&&customFrom&&customTo){const f=new Date(customFrom),to=new Date(customTo+'T23:59:59');return acctTxns.filter(t=>{const d=parseDate(t.Date);return d>=f&&d<=to;});}
    return acctTxns;
  }, [acctTxns,period,viewYear,viewMonth,viewFY,customFrom,customTo]);

  // Opening balance = balance from all transactions BEFORE the period
  const openingBal = useMemo(() => {
    if (period === 'All') return 0;
    const beforePeriod = acctTxns.filter(t => {
      const d = parseDate(t.Date);
      if (period==='Month')  return !(d.getFullYear()===viewYear && d.getMonth()===viewMonth) && d < new Date(viewYear, viewMonth, 1);
      if (period==='Year')   return d.getFullYear() < viewYear;
      if (period==='FY')     return d < fyStart(viewFY);
      if (period==='Custom'&&customFrom) return d < new Date(customFrom);
      return false;
    });
    return computeBalance(beforePeriod, acctName);
  }, [acctTxns, period, viewYear, viewMonth, viewFY, customFrom, acctName]);

  const periodBalance = useMemo(() => computeBalance(periodTxns, acctName), [periodTxns, acctName]);
  const closingBal    = openingBal + periodBalance;

  // Income/expense/transfer breakdown for the period
  const totals = useMemo(() => {
    let income=0, expense=0, xferIn=0, xferOut=0;
    for (const t of periodTxns) {
      const amt  = txnAmount(t);
      const type = String(t['Income/Expense'] || '').trim();
      const acct = t.Account || t.FromAccount || '';
      const dest = t.ToAccount || '';
      if (type==='Income')       income  += amt;
      else if (type==='Expense') expense += amt;
      else if (type==='Transfer-Out') {
        if(acct===acctName) xferOut+=amt;
        if(dest===acctName) xferIn+=amt;
      }
      // Transfer-In: skip (Transfer-Out already handles both sides)
    }
    return { income, expense, xferIn, xferOut };
  }, [periodTxns, acctName]);

  const barData = useMemo(() => {
    const months = [];
    for (let i=5; i>=0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
      // Running balance up to end of this month (cumulative = bank balance)
      const upToMonth = acctTxns.filter(t => {
        const td = parseDate(t.Date);
        return td <= new Date(d.getFullYear(), d.getMonth()+1, 0, 23, 59, 59);
      });
      months.push({ name: MS_S[d.getMonth()], value: computeBalance(upToMonth, acctName) });
    }
    return months;
  }, [acctTxns, acctName]);

  const prev = () => { if(period==='Month'){if(viewMonth===0){setViewMonth(11);setViewYear(y=>y-1);}else setViewMonth(m=>m-1);}if(period==='Year')setViewYear(y=>y-1);if(period==='FY')setViewFY(y=>y-1); };
  const next = () => { if(period==='Month'){if(viewMonth===11){setViewMonth(0);setViewYear(y=>y+1);}else setViewMonth(m=>m+1);}if(period==='Year')setViewYear(y=>y+1);if(period==='FY')setViewFY(y=>y+1); };
  const swipe = useSwipe(next, prev);
  const periodLabel = period==='Month'?`${MS_F[viewMonth]} ${viewYear}`:period==='Year'?String(viewYear):period==='FY'?fyLabel(viewFY):period==='Custom'&&customFrom&&customTo?`${customFrom} – ${customTo}`:'All Time';

  const groups = useMemo(() => {
    const map={};
    for(const t of [...periodTxns].sort((a,b)=>parseDate(b.Date)-parseDate(a.Date))){
      if(!map[t.Date])map[t.Date]=[];map[t.Date].push(t);
    }
    return Object.entries(map);
  }, [periodTxns]);

  return (
    <div className="acct-detail-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div style={{flex:1}}>
          <div className="page-hdr-title">{acctName}</div>
          <div className="page-hdr-sub">Account · {acctTxns.length} total txns</div>
        </div>
        <div className="entity-badge" style={{background:closingBal>=0?'var(--income-bg)':'var(--expense-bg)',color:closingBal>=0?'var(--income)':'var(--expense)'}}>
          {closingBal>=0?'+':''}{formatINRCompact(Math.abs(closingBal))}
        </div>
        <button className="add-fab-sm" onClick={()=>setShowAdd(true)} title="Add transaction">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>

      <div className="acct-detail-body" {...swipe}>
        <div style={{padding:'8px var(--page-px) 4px'}}>
          <div className="period-tabs">
            {PERIODS.map(p=><button key={p} className={`period-tab ${period===p?'active':''}`} onClick={()=>setPeriod(p)}>{p}</button>)}
          </div>
        </div>
        {!['All','Custom'].includes(period)&&(
          <div className="period-picker-row">
            <button className="pp-arrow" onClick={prev}>‹</button>
            <div className="pp-label">{periodLabel}</div>
            <button className="pp-arrow" onClick={next}>›</button>
          </div>
        )}
        {period==='Custom'&&(
          <div style={{display:'flex',gap:8,padding:'6px var(--page-px)'}}>
            <input type="date" className="form-input" style={{flex:1}} value={customFrom} onChange={e=>setFrom(e.target.value)}/>
            <span style={{alignSelf:'center',color:'var(--text-muted)'}}>–</span>
            <input type="date" className="form-input" style={{flex:1}} value={customTo} onChange={e=>setTo(e.target.value)}/>
          </div>
        )}

        {/* Opening / Closing balance for period */}
        {period !== 'All' && (
          <div className="acct-ob-strip">
            <div className="acct-ob-item">
              <div className="acct-ob-l">Opening</div>
              <div className={`acct-ob-v ${openingBal>=0?'pos':'neg'}`}>{openingBal>=0?'+':''}{formatINR(Math.abs(openingBal))}</div>
            </div>
            <div className="acct-ob-div"/>
            <div className="acct-ob-item">
              <div className="acct-ob-l">Net change</div>
              <div className={`acct-ob-v ${periodBalance>=0?'pos':'neg'}`}>{periodBalance>=0?'+':''}{formatINR(Math.abs(periodBalance))}</div>
            </div>
            <div className="acct-ob-div"/>
            <div className="acct-ob-item">
              <div className="acct-ob-l">Closing</div>
              <div className={`acct-ob-v ${closingBal>=0?'pos':'neg'}`}>{closingBal>=0?'+':''}{formatINR(Math.abs(closingBal))}</div>
            </div>
          </div>
        )}

        {/* Activity strip — banking style */}
        <div className="acct-banking-row">
          <div className="acct-banking-item">
            <div className="acct-banking-l">Deposits</div>
            <div className="acct-banking-v income">{formatINR(totals.income + totals.xferIn)}</div>
          </div>
          <div className="acct-banking-div"/>
          <div className="acct-banking-item">
            <div className="acct-banking-l">Withdrawals</div>
            <div className="acct-banking-v expense">{formatINR(totals.expense + totals.xferOut)}</div>
          </div>
          <div className="acct-banking-div"/>
          <div className="acct-banking-item">
            <div className="acct-banking-l">Txns</div>
            <div className="acct-banking-v">{periodTxns.length}</div>
          </div>
          <div className="acct-banking-div"/>
          <div className="acct-banking-item">
            <div className="acct-banking-l">Balance</div>
            <div className={`acct-banking-v ${closingBal>=0?'income':'expense'}`} style={{fontWeight:900}}>
              {closingBal>=0?'+':''}{formatINR(closingBal)}
            </div>
          </div>
        </div>

        <div className="chart-wrap">
          <div style={{fontSize:'0.62rem',fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.7px',marginBottom:6}}>6-Month Balance Trend</div>
          <ResponsiveContainer width="100%" height={130}>
            <AreaChart data={barData} margin={{top:6,right:4,bottom:0,left:0}}>
              <defs>
                <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#00e5a0" stopOpacity={0.25}/>
                  <stop offset="95%" stopColor="#00e5a0" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false}/>
              <XAxis dataKey="name" tick={{fontSize:9,fill:'var(--text-muted)'}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fontSize:9,fill:'var(--text-muted)'}} axisLine={false} tickLine={false} tickFormatter={v=>formatINRCompact(Math.abs(v))} width={42}/>
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4"/>
              <Tooltip
                formatter={v=>[formatINR(v),'Balance']}
                labelStyle={{fontSize:11,color:'var(--text-muted)'}}
                contentStyle={{background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:10,fontSize:11,padding:'6px 10px'}}
              />
              <Area
                type="monotone" dataKey="value"
                stroke="#00e5a0" strokeWidth={2.5}
                fill="url(#balGrad)"
                dot={{fill:'#00e5a0',r:4,strokeWidth:0}}
                activeDot={{r:6,fill:'#00e5a0',stroke:'rgba(0,229,160,0.3)',strokeWidth:4}}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {groups.length===0
          ? <div className="empty-state"><div className="empty-icon">📭</div><div className="empty-title">No transactions</div><div className="empty-desc">{periodLabel}</div></div>
          : groups.map(([dk,txns])=>{
              const gt=calcTotals(txns), d=parseDate(txns[0].Date);
              return(
                <div key={dk}>
                  <div className="dg-header" onClick={()=>setAddDate(txns[0].Date)}>
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
                  <div className="dg-items">{txns.map(t=><TransactionItem key={t._id} transaction={t}/>)}</div>
                </div>
              );
            })
        }
        <div style={{height:80}}/>
      </div>
      {addDate&&<AddTransaction prefillDate={addDate} prefillAccount={acctName} onClose={()=>setAddDate(null)}/>}
      {showAdd&&<AddTransaction prefillAccount={acctName} onClose={()=>setShowAdd(false)}/>}
    </div>
  );
}

// ── Main Accounts screen ──────────────────────────────────────────────────────
export default function Accounts({ backInterceptRef } = {}) {
  const { state } = useApp();
  const { accounts, accountGroups, transactions } = state;
  const [drill, setDrill] = useState(null);

  // Register Android back intercept when drill-down is open
  useEffect(() => {
    if (!backInterceptRef) return;
    if (drill) {
      backInterceptRef.current = () => setDrill(null);
    } else {
      backInterceptRef.current = null;
    }
    return () => { if (backInterceptRef) backInterceptRef.current = null; };
  }, [drill, backInterceptRef]);


  const acctBalances = useMemo(() => buildBalanceMap(transactions), [transactions]);

  const netWorth = useMemo(() => Object.values(acctBalances).reduce((s,v)=>s+v,0), [acctBalances]);
  const assets      = useMemo(() => Object.values(acctBalances).filter(v=>v>0).reduce((s,v)=>s+v,0), [acctBalances]);
  const liabilities = useMemo(() => Object.values(acctBalances).filter(v=>v<0).reduce((s,v)=>s+Math.abs(v),0), [acctBalances]);

  const uniqueAccountGroups = useMemo(() => [...new Set(accountGroups)], [accountGroups]);
  const uniqueAccounts = useMemo(() => {
    const seen = new Set();
    return accounts.filter(acc => {
        const duplicate = seen.has(acc.name);
        seen.add(acc.name);
        return !duplicate;
    });
  }, [accounts]);

  const grouped = useMemo(() => {
    const groups    = {};
    const ungrouped = [];
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
    const normalizedAccts = (uniqueAccounts||[])
      .map(a=>typeof a==='string'?{name:a,group:'',icon:'💳'}:a)
      .filter(a => a.name && !looksNumeric(a.name)); // skip numeric-named accounts
    for (const a of normalizedAccts) {
      const grp = a.group || '';
      if (grp && (uniqueAccountGroups||[]).includes(grp)) {
        if (!groups[grp]) groups[grp] = [];
        groups[grp].push(a);
      } else ungrouped.push(a);
    }
    return { groups, ungrouped };
  }, [uniqueAccounts, uniqueAccountGroups]);

  if (drill) return <AccountDetail acctName={drill} allTxns={transactions} onBack={() => setDrill(null)}/>;

  const renderAcctRow = (a) => {
    const name = a.name || a;
    const bal  = acctBalances[name] ?? 0;
    return (
      <div key={name} className="acct-row" onClick={() => setDrill(name)}>
        <div className="acct-row-name">{name}</div>
        <div className={`acct-row-bal ${bal>=0?'pos':'neg'}`}>{bal<0?'−':''}{formatINR(Math.abs(bal))}</div>
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="11" height="11"><path d="M9 18l6-6-6-6"/></svg>
      </div>
    );
  };

  return (
    <div className="accounts-screen">
      <div className="page-hdr">
        <div style={{flex:1}}>
          <div className="page-hdr-title">Accounts</div>
          <div className="page-hdr-sub">Net worth: <span style={{color:netWorth>=0?'var(--income)':'var(--expense)',fontWeight:800}}>{formatINR(netWorth)}</span></div>
        </div>
      </div>

      {/* Assets / Liabilities strip */}
      <div className="bal-strip" style={{flexShrink:0}}>
        <div className="bal-strip-item"><div className="bal-strip-l">Assets</div><div className="bal-strip-v" style={{color:'var(--income)'}}>{formatINR(assets)}</div></div>
        <div className="bal-strip-div"/>
        <div className="bal-strip-item"><div className="bal-strip-l">Liabilities</div><div className="bal-strip-v" style={{color:'var(--expense)'}}>{formatINR(liabilities)}</div></div>
        <div className="bal-strip-div"/>
        <div className="bal-strip-item"><div className="bal-strip-l">Net Worth</div><div className="bal-strip-v" style={{color:netWorth>=0?'var(--income)':'var(--expense)',fontWeight:900}}>{netWorth>=0?'+':''}{formatINR(netWorth)}</div></div>
      </div>

      <div className="accounts-list">
        {(uniqueAccountGroups||[]).map(grp => {
          const accts    = grouped.groups[grp] || [];
          if (!accts.length) return null;
          const grpTotal = accts.reduce((s,a)=>s+(acctBalances[a.name||a]??0),0);
          return (
            <div key={grp}>
              <div className="acct-group-header">
                <div className="acct-group-label">📁 {grp}</div>
                <span className={`acct-group-bal ${grpTotal>=0?'pos':'neg'}`}>{grpTotal<0?'−':''}{formatINR(Math.abs(grpTotal))}</span>
                <span className="acct-group-arrow-spacer"/>
              </div>
              {accts.map(renderAcctRow)}
            </div>
          );
        })}
        {grouped.ungrouped.length > 0 && (
          <div>
            {(uniqueAccountGroups||[]).length > 0 && (
              <div className="acct-group-header" style={{opacity:0.55}}><span>📋 Ungrouped</span></div>
            )}
            {grouped.ungrouped.map(renderAcctRow)}
          </div>
        )}
        {uniqueAccounts.length === 0 && (
          <div className="empty-state"><div className="empty-icon">💳</div><div className="empty-title">No accounts yet</div><div className="empty-desc">Add accounts in Settings</div></div>
        )}
        <div style={{height:80}}/>
      </div>
    </div>
  );
}