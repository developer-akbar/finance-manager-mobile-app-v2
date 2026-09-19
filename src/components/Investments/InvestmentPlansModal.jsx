import React, { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR } from '../../utils/format.js';
import { resolveInvestmentAccounts } from '../../utils/brokerageAccounting.js';
import './InvestmentPlansModal.css';

export default function InvestmentPlansModal({
  isOpen,
  onClose,
  onLogPlan,
  initialCreateFromTxn = null,
}) {
  const { state, addInvestmentPlan, updateInvestmentPlan, deleteInvestmentPlan } = useApp();
  const { investmentPlans = [], accounts = [] } = state || {};

  const [editingPlan, setEditingPlan] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [planToDelete, setPlanToDelete] = useState(null);

  // Keyboard navigation & Escape / Back handling
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (planToDelete) {
          setPlanToDelete(null);
        } else if (isCreating) {
          setIsCreating(false);
          setEditingPlan(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [planToDelete, isCreating, onClose]);

  // Form state for create / edit
  const [form, setForm] = useState({
    name: '',
    frequency: 'monthly',
    planned_amount: '',
    investment_type: 'BUY',
    owner: 'Myself',
    investment_account: '',
    funding_account: '',
    sub_account: '',
    security_symbol: '',
    security_isin: '',
    security_name: '',
    folio: '',
    holding_mode: '',
    note: '',
    description: '',
    tags: '',
    next_due_date: '',
    active: true,
  });

  // If opened with initialCreateFromTxn, auto-populate and show creator form
  useEffect(() => {
    if (initialCreateFromTxn) {
      const t = initialCreateFromTxn;
      const res = resolveInvestmentAccounts(t, accounts);
      const invTxnType = String(t.InvestmentTransactionType || t.investment_transaction_type || 'BUY').toUpperCase();

      const rawTags = t.Tags || t.tags || '';
      const extractTag = (tagsStr, key) => {
        if (!tagsStr) return '';
        const m = String(tagsStr).match(new RegExp(`(?:^|[|,]\\s*)${key}:\\s*([^|,]+)`, 'i'));
        return m ? m[1].trim() : '';
      };
      const rawOwnership = (
        t.OwnershipTag ||
        t.ownership_tag ||
        extractTag(rawTags, 'Ownership') ||
        extractTag(t.Description || '', 'Ownership') ||
        ''
      ).toUpperCase().trim();

      let initialOwner = 'Myself';
      if (rawOwnership === 'EXTERNAL' || rawOwnership === 'FATHER_EXTERNAL' || rawOwnership === 'EXTERNAL_FATHER') {
        initialOwner = 'External';
      }

      const secName = t.SecurityDisplayName || t.security_display_name || t.Note || t.note || 'Investment Plan';
      const plannedAmt = String(t.TradeValue || t.trade_value || t.INR || t.Amount || t.amount || '');

      setForm({
        name: secName,
        frequency: 'monthly',
        planned_amount: plannedAmt,
        investment_type: invTxnType === 'SELL' ? 'SELL' : 'BUY',
        owner: initialOwner,
        investment_account: res.investmentAccount || t.InvestmentAccount || t.Category || t.ToAccount || '',
        funding_account: res.bankAccount || '',
        sub_account: res.subAccount || t.SubAccount || t.sub_account || '',
        security_symbol: t.SecuritySymbol || t.security_symbol || '',
        security_isin: t.SecurityISIN || t.security_isin || '',
        security_name: secName,
        folio: extractTag(rawTags, 'Folio') || t.FolioNumber || t.folio_number || '',
        holding_mode: t.HoldingMode || t.holding_mode || extractTag(rawTags, 'Mode') || '',
        note: t.Note || t.note || '',
        description: t.Description || t.description || '',
        tags: t.Tags || t.tags || '',
        next_due_date: new Date().toISOString().slice(0, 10),
        active: true,
      });
      setIsCreating(true);
      setEditingPlan(null);
    }
  }, [initialCreateFromTxn, accounts]);

  if (!isOpen) return null;

  const handleStartCreate = () => {
    setForm({
      name: '',
      frequency: 'monthly',
      planned_amount: '',
      investment_type: 'BUY',
      owner: 'Myself',
      investment_account: 'Liquid Mutual Funds',
      funding_account: '',
      sub_account: '',
      security_symbol: '',
      security_isin: '',
      security_name: '',
      folio: '',
      holding_mode: '',
      note: '',
      description: '',
      tags: '',
      next_due_date: new Date().toISOString().slice(0, 10),
      active: true,
    });
    setEditingPlan(null);
    setIsCreating(true);
  };

  const handleStartEdit = (p) => {
    setForm({
      name: p.name || '',
      frequency: p.frequency || 'monthly',
      planned_amount: p.planned_amount ? String(p.planned_amount) : '',
      investment_type: p.investment_type || 'BUY',
      owner: p.owner || 'Myself',
      investment_account: p.investment_account || '',
      funding_account: p.funding_account || '',
      sub_account: p.sub_account || p.brokerage || '',
      security_symbol: p.security_symbol || '',
      security_isin: p.security_isin || '',
      security_name: p.security_name || '',
      folio: p.folio || '',
      holding_mode: p.holding_mode || '',
      note: p.note || '',
      description: p.description || '',
      tags: p.tags || '',
      next_due_date: p.next_due_date || '',
      active: p.active !== false,
    });
    setEditingPlan(p);
    setIsCreating(true);
  };

  const handleSaveForm = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;

    if (editingPlan) {
      await updateInvestmentPlan(editingPlan.id, form);
    } else {
      await addInvestmentPlan(form);
    }
    setIsCreating(false);
    setEditingPlan(null);
  };

  const handleToggleActive = async (p, e) => {
    e.stopPropagation();
    await updateInvestmentPlan(p.id, { active: !p.active });
  };

  const handleDelete = (p, e) => {
    e.stopPropagation();
    setPlanToDelete(p);
  };

  const handleLogClick = (p, e) => {
    e.stopPropagation();
    if (onLogPlan) {
      onLogPlan(p);
      onClose();
    }
  };

  // Investment accounts list
  const invAccounts = accounts.filter(
    (a) => a.group?.toLowerCase() === 'investments' || ['liquid mutual funds', 'mutual funds tax saver', 'share market'].includes((a.name || '').toLowerCase())
  );
  // Bank accounts list
  const bankAccounts = accounts.filter(
    (a) => a.group?.toLowerCase() !== 'investments'
  );

  return (
    <div className="plans-modal-overlay" onClick={onClose}>
      <div className="plans-modal-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="plans-modal-header">
          <div className="plans-modal-title">
            <span>📊</span> Investment Plans (SIP)
          </div>
          <button className="plans-modal-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="plans-modal-body">
          {isCreating ? (
            /* Create / Edit Form */
            <form onSubmit={handleSaveForm} className="plan-editor-form">
              <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 4, color: 'var(--text-primary)' }}>
                {editingPlan ? 'Edit Investment Plan' : 'New Investment Plan'}
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Plan Name / Security *</label>
                <div className="plan-form-control">
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. Mirae Asset Large & Midcap Fund"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value, security_name: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Planned Amount (₹)</label>
                <div className="plan-form-control">
                  <input
                    type="number"
                    step="any"
                    className="form-input"
                    placeholder="e.g. 2000"
                    value={form.planned_amount}
                    onChange={(e) => setForm({ ...form, planned_amount: e.target.value })}
                  />
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Frequency</label>
                <div className="plan-form-control">
                  <select
                    className="form-input"
                    value={form.frequency}
                    onChange={(e) => setForm({ ...form, frequency: e.target.value })}
                  >
                    <option value="monthly">Monthly</option>
                    <option value="weekly">Weekly</option>
                    <option value="fortnightly">Fortnightly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="half-yearly">Half-Yearly</option>
                    <option value="annually">Annually</option>
                  </select>
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Funding Account</label>
                <div className="plan-form-control">
                  <select
                    className="form-input"
                    value={form.funding_account}
                    onChange={(e) => setForm({ ...form, funding_account: e.target.value })}
                  >
                    <option value="">Select funding bank...</option>
                    {bankAccounts.map((a) => (
                      <option key={a.id || a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Investment Account</label>
                <div className="plan-form-control">
                  <select
                    className="form-input"
                    value={form.investment_account}
                    onChange={(e) => setForm({ ...form, investment_account: e.target.value })}
                  >
                    <option value="">Select investment account...</option>
                    {invAccounts.map((a) => (
                      <option key={a.id || a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Platform / SubAccount</label>
                <div className="plan-form-control">
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. Fareeda Groww, Zerodha"
                    value={form.sub_account}
                    onChange={(e) => setForm({ ...form, sub_account: e.target.value, brokerage: e.target.value })}
                  />
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Owner</label>
                <div className="plan-form-control">
                  <select
                    className="form-input"
                    value={form.owner}
                    onChange={(e) => setForm({ ...form, owner: e.target.value })}
                  >
                    <option value="Myself">Myself (Personal)</option>
                    <option value="External">External (Family)</option>
                  </select>
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Security Symbol / Ticker</label>
                <div className="plan-form-control">
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. INF769K01EZ3 or TATASTEEL"
                    value={form.security_symbol}
                    onChange={(e) => setForm({ ...form, security_symbol: e.target.value })}
                  />
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">ISIN</label>
                <div className="plan-form-control">
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. INF769K01EZ3"
                    value={form.security_isin}
                    onChange={(e) => setForm({ ...form, security_isin: e.target.value })}
                  />
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Next Due Date</label>
                <div className="plan-form-control">
                  <input
                    type="date"
                    className="form-input"
                    value={form.next_due_date}
                    onChange={(e) => setForm({ ...form, next_due_date: e.target.value })}
                  />
                </div>
              </div>

              <div className="plan-form-field">
                <label className="plan-form-label">Folio Number</label>
                <div className="plan-form-control">
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. 123456789"
                    value={form.folio}
                    onChange={(e) => setForm({ ...form, folio: e.target.value })}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>
                  {editingPlan ? 'Save Changes' : 'Create Plan'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setIsCreating(false);
                    setEditingPlan(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : investmentPlans.length === 0 ? (
            /* Empty State */
            <div className="plans-empty-state">
              <div className="plans-empty-icon">📈</div>
              <div className="plans-empty-text">No recurring investment plans yet.</div>
              <button className="btn btn-primary" onClick={handleStartCreate}>
                + Create First Investment Plan
              </button>
            </div>
          ) : (
            /* Plans List */
            investmentPlans.map((p) => (
              <div key={p.id} className={`plan-card ${!p.active ? 'inactive' : ''}`}>
                <div className="plan-card-header">
                  <div className="plan-card-title-wrap">
                    <div className="plan-card-name" title={p.name}>
                      {p.name}
                    </div>
                    <div className="plan-card-meta">
                      <span className="plan-badge plan-badge-buy">
                        {p.investment_type || 'BUY'}
                      </span>
                      <span className="plan-badge plan-badge-freq">
                        {p.frequency || 'monthly'}
                      </span>
                      {p.owner === 'External' && (
                        <span className="plan-badge" style={{ background: 'rgba(255, 171, 0, 0.15)', color: '#ffab00' }}>
                          Family
                        </span>
                      )}
                      {!p.active && (
                        <span className="plan-badge" style={{ background: 'rgba(255, 255, 255, 0.1)', color: 'var(--text-muted)' }}>
                          Paused
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="plan-card-amount">
                    {p.planned_amount ? formatINR(p.planned_amount) : '—'}
                  </div>
                </div>

                {/* Routing info */}
                <div className="plan-card-route">
                  <span>{p.funding_account || 'Bank'}</span>
                  <span className="plan-route-arrow">→</span>
                  <span>{p.investment_account || 'Investments'}</span>
                  {p.sub_account && (
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                      ({p.sub_account})
                    </span>
                  )}
                </div>

                {/* Footer / Actions */}
                <div className="plan-card-footer">
                  <div className="plan-due-info">
                    📅 Next Due:{' '}
                    <span className="plan-due-highlight">
                      {p.next_due_date || 'Ongoing'}
                    </span>
                  </div>
                  <div className="plan-card-actions">
                    <button
                      className="btn-plan-icon"
                      onClick={(e) => handleStartEdit(p, e)}
                      title="Edit Plan"
                    >
                      ✏️
                    </button>
                    <button
                      className="btn-plan-icon"
                      onClick={(e) => handleToggleActive(p, e)}
                      title={p.active ? 'Pause Plan' : 'Resume Plan'}
                    >
                      {p.active ? '⏸️' : '▶️'}
                    </button>
                    <button
                      className="btn-plan-icon"
                      onClick={(e) => handleDelete(p, e)}
                      title="Delete Plan"
                    >
                      🗑️
                    </button>
                    <button
                      className="btn-log-plan"
                      onClick={(e) => handleLogClick(p, e)}
                      title="Log this month's execution"
                    >
                      ⚡ Log
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        {!isCreating && investmentPlans.length > 0 && (
          <div className="plans-modal-footer">
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {investmentPlans.filter((p) => p.active).length} Active Plan(s)
            </div>
            <button className="btn btn-primary btn-sm" onClick={handleStartCreate}>
              + Add Plan
            </button>
          </div>
        )}
      </div>

      {/* Native Delete Confirmation Dialog */}
      {planToDelete && (
        <div className="plan-delete-overlay" onClick={() => setPlanToDelete(null)}>
          <div className="plan-delete-dialog" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: '2rem', marginBottom: 10, textAlign: 'center' }}>🗑️</div>
            <div className="plan-delete-title">
              Delete Investment Plan?
            </div>
            <div className="plan-delete-desc">
              Are you sure you want to delete <strong>"{planToDelete.name}"</strong>? This will remove the recurring schedule template without affecting your transaction history.
            </div>
            <div className="plan-delete-actions">
              <button
                type="button"
                className="btn btn-ghost btn-full"
                onClick={() => setPlanToDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger btn-full"
                onClick={async () => {
                  const idToDelete = planToDelete.id;
                  setPlanToDelete(null);
                  await deleteInvestmentPlan(idToDelete);
                }}
              >
                Delete Plan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
