import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import DataManager   from './DataManager.jsx';
import AccountMgr    from './AccountMgr.jsx';
import CategoryMgr   from './CategoryMgr.jsx';
import BudgetMgr     from './BudgetMgr.jsx';
import RecurringMgr  from './RecurringMgr.jsx';
import ProfileMgr    from './ProfileMgr.jsx';
import './Settings.css';

const PAGES = { data: DataManager, accounts: AccountMgr, categories: CategoryMgr,
                budgets: BudgetMgr, recurring: RecurringMgr, profile: ProfileMgr };

export default function Settings() {
  const { state } = useApp();
  const [page, setPage] = useState(null);

  if (page && PAGES[page]) {
    const Page = PAGES[page];
    return <Page onBack={() => setPage(null)} />;
  }

  const { transactions, accounts, categories, budgets, recurring } = state;
  const expCats = categories.filter(c=>c.type==='Expense').length;
  const incCats = categories.filter(c=>c.type==='Income').length;

  return (
    <div className="settings-screen">
      <div className="page-header"><div className="page-title">Settings</div></div>

      {/* Profile card */}
      <div className="settings-profile-card" onClick={() => setPage('profile')}>
        <div className="settings-avatar">F</div>
        <div className="settings-profile-info">
          <div className="settings-profile-name">FinMan</div>
          <div className="settings-profile-sub">{transactions.length.toLocaleString()} transactions · {accounts.length} accounts</div>
        </div>
        <ChevronRight />
      </div>

      <div className="settings-group">
        <div className="settings-group-label">Data Management</div>
        <div className="settings-list">
          <Row icon="📥" title="Import / Export" sub="Excel, CSV, JSON — sync between devices" onClick={() => setPage('data')} />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">Manage</div>
        <div className="settings-list">
          <Row icon="💳" title="Accounts"   sub={`${accounts.length} accounts`}                onClick={() => setPage('accounts')} />
          <Row icon="🏷️" title="Categories" sub={`${expCats} expense · ${incCats} income`}     onClick={() => setPage('categories')} />
          <Row icon="🎯" title="Budgets"    sub={`${budgets.length} active budget${budgets.length!==1?'s':''}`} onClick={() => setPage('budgets')} />
          <Row icon="🔄" title="Recurring"  sub={`${recurring.length} recurring transaction${recurring.length!==1?'s':''}`} onClick={() => setPage('recurring')} last />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">About</div>
        <div className="settings-list">
          <Row icon="ℹ️" title="FinMan v2.0" sub="Personal Finance Manager · developer-akbar" last noChevron />
        </div>
      </div>

      <div style={{height:20}}/>
    </div>
  );
}

function Row({ icon, title, sub, onClick, last, noChevron }) {
  return (
    <div className={`settings-row card-pressable ${last?'last':''}`} onClick={onClick}>
      <div className="settings-row-icon">{icon}</div>
      <div className="settings-row-text">
        <div className="settings-row-title">{title}</div>
        {sub && <div className="settings-row-sub">{sub}</div>}
      </div>
      {!noChevron && onClick && <ChevronRight />}
    </div>
  );
}

function ChevronRight() {
  return <svg className="chevron" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>;
}
