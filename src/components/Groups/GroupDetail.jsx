import React, { useState, useMemo } from 'react';
import { formatINR, formatDate } from '../../utils/format.js';
import { computeGroupBalances, buildWhatsAppReminder } from '../../utils/debtSimplifier.js';
import AddGroupExpense from './AddGroupExpense.jsx';
import GroupSettlementSlip from './GroupSettlementSlip.jsx';

export default function GroupDetail({ group, onUpdateGroup, onDeleteGroup, onBack, onRecordFinManTxn, backInterceptRef }) {
  const [activeTab, setActiveTab] = useState('expenses'); // 'expenses' | 'balances' | 'members'
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showSlip, setShowSlip] = useState(false);
  const [settleModal, setSettleModal] = useState(null); // { fromId, toId, amount }
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberUpi, setNewMemberUpi] = useState('');
  const [showAddMember, setShowAddMember] = useState(false);

  const expenses = group.expenses || [];
  const settlements = group.settlements || [];
  const members = group.members || [];

  const balances = useMemo(() => {
    return computeGroupBalances(members, expenses, settlements);
  }, [members, expenses, settlements]);

  const youMember = members.find(m => m.isYou) || members[0];
  const youStat = balances.memberStats.find(m => m.id === youMember?.id);

  // Register Android back button
  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (showDeleteConfirm) {
      backInterceptRef.current = () => setShowDeleteConfirm(false);
    } else if (showSlip) {
      backInterceptRef.current = () => setShowSlip(false);
    } else if (showAddExpense) {
      backInterceptRef.current = () => setShowAddExpense(false);
    } else if (settleModal) {
      backInterceptRef.current = () => setSettleModal(null);
    } else {
      backInterceptRef.current = onBack;
    }
    return () => { if (backInterceptRef) backInterceptRef.current = null; };
  }, [showDeleteConfirm, showSlip, showAddExpense, settleModal, onBack, backInterceptRef]);

  const handleAddExpense = (expense) => {
    const updated = {
      ...group,
      expenses: [expense, ...(group.expenses || [])],
    };
    onUpdateGroup(updated);
    setShowAddExpense(false);
  };

  const handleDeleteExpense = (expId) => {
    const updated = {
      ...group,
      expenses: (group.expenses || []).filter(e => e.id !== expId),
    };
    onUpdateGroup(updated);
  };

  const handleRecordSettlement = () => {
    if (!settleModal) return;
    const newSettlement = {
      id: `set-${Date.now()}`,
      fromMemberId: settleModal.fromId,
      toMemberId: settleModal.toId,
      amount: parseFloat(settleModal.amount) || 0,
      date: new Date().toISOString().split('T')[0],
      note: 'Settled via FinMan',
    };
    const updated = {
      ...group,
      settlements: [...(group.settlements || []), newSettlement],
    };
    onUpdateGroup(updated);
    setSettleModal(null);
  };

  const handleAddMember = () => {
    if (!newMemberName.trim()) return;
    const newMember = {
      id: `m-${Date.now()}`,
      name: newMemberName.trim(),
      upiId: newMemberUpi.trim(),
      isYou: false,
    };
    const updated = {
      ...group,
      members: [...members, newMember],
    };
    onUpdateGroup(updated);
    setNewMemberName('');
    setNewMemberUpi('');
    setShowAddMember(false);
  };

  return (
    <div className="sub-screen">
      {/* Top Navigation */}
      <div className="page-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div style={{ flex: 1, minWidth: 0, paddingLeft: 8 }}>
          <div className="page-hdr-title" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '1.05rem' }}>
            <span>{group.emoji || '🏖️'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.name}</span>
          </div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{members.length} members · {expenses.length} expenses</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setShowSlip(true)}
            style={{
              padding: '6px 10px',
              borderRadius: 12,
              background: 'var(--bg-card2)',
              color: 'var(--accent)',
              border: '1px solid var(--border)',
              fontSize: '0.72rem',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4
            }}
          >
            <span>📄</span> Slip
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            style={{
              padding: '6px 10px',
              borderRadius: 12,
              background: 'rgba(255, 77, 106, 0.12)',
              color: 'var(--expense)',
              border: '1px solid rgba(255, 77, 106, 0.25)',
              fontSize: '0.72rem',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4
            }}
            title="Delete Group"
          >
            <span>🗑️</span>
          </button>
        </div>
      </div>

      <div className="sub-body" style={{ paddingBottom: 'calc(var(--safe-bottom) + 80px)' }}>
        {/* Top Summary Banner */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
          margin: '0 var(--page-px) 14px'
        }}>
          <div style={{ background: 'var(--bg-card)', padding: 12, borderRadius: 14, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Total Group Spend
            </div>
            <div style={{ fontSize: '1.15rem', fontWeight: 900, color: 'var(--text-primary)', marginTop: 4 }}>
              {formatINR(balances.totalSpent)}
            </div>
          </div>
          <div style={{ background: 'var(--bg-card)', padding: 12, borderRadius: 14, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Your Balance
            </div>
            <div style={{
              fontSize: '1.15rem', fontWeight: 900, marginTop: 4,
              color: youStat?.net > 0 ? 'var(--income)' : youStat?.net < 0 ? 'var(--expense)' : 'var(--text-muted)'
            }}>
              {youStat?.net > 0 ? `+${formatINR(youStat.net)}` : youStat?.net < 0 ? `−${formatINR(Math.abs(youStat.net))}` : 'Settled'}
            </div>
          </div>
        </div>

        {/* View Tabs */}
        <div style={{ display: 'flex', gap: 6, margin: '0 var(--page-px) 14px', background: 'var(--bg-card2)', padding: 4, borderRadius: 12 }}>
          {[
            { id: 'expenses', label: `Expenses (${expenses.length})` },
            { id: 'balances', label: 'Balances & Settle' },
            { id: 'members', label: `Members (${members.length})` }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1, padding: '7px 0', borderRadius: 8, fontSize: '0.74rem', fontWeight: 700, border: 'none',
                background: activeTab === tab.id ? 'var(--accent)' : 'transparent',
                color: activeTab === tab.id ? '#000' : 'var(--text-muted)', cursor: 'pointer'
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* TAB 1: Expenses */}
        {activeTab === 'expenses' && (
          <div style={{ margin: '0 var(--page-px)' }}>
            {expenses.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: '2.2rem', marginBottom: 8 }}>🏖️</div>
                <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>No expenses recorded yet</div>
                <div style={{ fontSize: '0.75rem', marginTop: 4 }}>Tap the button below to add your first shared bill or payment.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {expenses.map(exp => {
                  const payers = exp.paidBy?.map(p => {
                    const m = members.find(mem => mem.id === p.memberId);
                    return m ? `${m.name} (₹${p.amount})` : 'Someone';
                  }).join(', ');

                  return (
                    <div key={exp.id} style={{
                      background: 'var(--bg-card)', padding: 12, borderRadius: 12, border: '1px solid var(--border)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                          {exp.title}
                        </div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>
                          {formatDate(exp.date, 'short')} · Paid by {payers}
                        </div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--accent)', marginTop: 2 }}>
                          Split {exp.splitMode} among {exp.splits?.length || 0} members
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ fontSize: '0.95rem', fontWeight: 900, color: 'var(--text-primary)' }}>
                          {formatINR(exp.amount)}
                        </div>
                        <button
                          onClick={() => handleDeleteExpense(exp.id)}
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.85rem', cursor: 'pointer', padding: 4 }}
                          title="Delete Expense"
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: Balances & Simplified Settlements */}
        {activeTab === 'balances' && (
          <div style={{ margin: '0 var(--page-px)' }}>
            {/* Simplified Settlements */}
            <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8 }}>
              ⚡ Simplified Debt Settlements
            </div>
            {balances.simplifiedDebts.length === 0 ? (
              <div style={{
                background: 'var(--bg-card)', padding: 20, borderRadius: 12, border: '1px solid var(--border)',
                textAlign: 'center', color: 'var(--income)', fontWeight: 700, fontSize: '0.85rem'
              }}>
                🎉 All balances are settled up!
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                {balances.simplifiedDebts.map((debt, i) => (
                  <div key={i} style={{
                    background: 'var(--bg-card)', padding: 12, borderRadius: 12, border: '1px solid var(--border)',
                    display: 'flex', flexDirection: 'column', gap: 8
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <span style={{ fontWeight: 800, color: 'var(--expense)' }}>{debt.fromName}</span>
                        <span style={{ color: 'var(--text-muted)', margin: '0 6px' }}>owes</span>
                        <span style={{ fontWeight: 800, color: 'var(--income)' }}>{debt.toName}</span>
                      </div>
                      <div style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--text-primary)' }}>
                        {formatINR(debt.amount)}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => setSettleModal(debt)}
                        style={{
                          flex: 1, padding: '6px 10px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700,
                          background: 'rgba(0, 229, 160, 0.15)', color: 'var(--accent)', border: '1px solid var(--accent)',
                          cursor: 'pointer'
                        }}
                      >
                        ✓ Record Settled
                      </button>
                      <button
                        onClick={() => {
                          const text = buildWhatsAppReminder({
                            debtorName: debt.fromName,
                            creditorName: debt.toName,
                            amount: debt.amount,
                            groupName: group.name,
                            upiId: debt.toUpi
                          });
                          window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
                        }}
                        style={{
                          padding: '6px 10px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700,
                          background: 'rgba(37, 211, 102, 0.15)', color: '#25D366', border: '1px solid rgba(37, 211, 102, 0.3)',
                          cursor: 'pointer'
                        }}
                      >
                        💬 WhatsApp
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Individual Balances */}
            <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8 }}>
              👤 Individual Balance Sheet
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {balances.memberStats.map(m => (
                <div key={m.id} style={{
                  background: 'var(--bg-card2)', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border-light)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                  <div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700 }}>{m.name} {m.isYou ? '(You)' : ''}</div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                      Paid: {formatINR(m.paid)} · Share: {formatINR(m.share)}
                    </div>
                  </div>
                  <div style={{
                    fontSize: '0.85rem', fontWeight: 800,
                    color: m.net > 0 ? 'var(--income)' : m.net < 0 ? 'var(--expense)' : 'var(--text-muted)'
                  }}>
                    {m.net > 0 ? `+${formatINR(m.net)}` : m.net < 0 ? `−${formatINR(Math.abs(m.net))}` : '0.00'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 3: Members */}
        {activeTab === 'members' && (
          <div style={{ margin: '0 var(--page-px)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Trip Members ({members.length})
              </div>
              <button
                onClick={() => setShowAddMember(true)}
                style={{
                  padding: '4px 10px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700,
                  background: 'rgba(0, 229, 160, 0.15)', color: 'var(--accent)', border: '1px solid var(--accent)', cursor: 'pointer'
                }}
              >
                + Add Member
              </button>
            </div>

            {showAddMember && (
              <div style={{ background: 'var(--bg-card)', padding: 12, borderRadius: 12, border: '1px solid var(--border)', marginBottom: 12 }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 800, marginBottom: 8 }}>Add New Member</div>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Member Name (e.g. Imran)"
                  value={newMemberName}
                  onChange={e => setNewMemberName(e.target.value)}
                  style={{ marginBottom: 8, fontSize: '0.85rem' }}
                />
                <input
                  type="text"
                  className="form-input"
                  placeholder="UPI ID (optional, e.g. imran@okaxis)"
                  value={newMemberUpi}
                  onChange={e => setNewMemberUpi(e.target.value)}
                  style={{ marginBottom: 10, fontSize: '0.85rem' }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowAddMember(false)}>Cancel</button>
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleAddMember}>Add</button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {members.map(m => (
                <div key={m.id} style={{
                  background: 'var(--bg-card)', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>
                      {m.name} {m.isYou ? '🌟 (You)' : ''}
                    </div>
                    {m.upiId && <div style={{ fontSize: '0.68rem', color: 'var(--accent)' }}>UPI: {m.upiId}</div>}
                  </div>
                </div>
              ))}
            </div>

            {/* Danger Zone */}
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--expense)', textTransform: 'uppercase', marginBottom: 8 }}>
                Danger Zone
              </div>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                style={{
                  width: '100%', padding: '12px 14px', borderRadius: 12,
                  background: 'rgba(255, 77, 106, 0.12)', border: '1px solid rgba(255, 77, 106, 0.3)',
                  color: 'var(--expense)', fontWeight: 800, fontSize: '0.85rem', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                }}
              >
                <span>🗑️</span> Delete This Group
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Floating Add Expense Button */}
      <div style={{
        position: 'fixed', bottom: 'calc(var(--safe-bottom) + 16px)', left: 0, right: 0,
        display: 'flex', justifyContent: 'center', zIndex: 50, pointerEvents: 'none'
      }}>
        <button
          onClick={() => setShowAddExpense(true)}
          style={{
            pointerEvents: 'auto',
            padding: '12px 24px', borderRadius: 30, background: 'var(--accent)',
            color: '#000', fontWeight: 900, fontSize: '0.9rem', border: 'none',
            boxShadow: '0 6px 20px rgba(0, 229, 160, 0.4)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6
          }}
        >
          <span>➕</span> Add Shared Expense
        </button>
      </div>

      {/* Delete Group Confirmation Modal */}
      {showDeleteConfirm && (
        <>
          <div className="overlay" onClick={() => setShowDeleteConfirm(false)} />
          <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
            <div className="sheet-handle" />
            <div style={{ fontSize: '2rem', textAlign: 'center', marginBottom: 8 }}>🗑️</div>
            <div style={{ fontSize: '1.05rem', fontWeight: 800, textAlign: 'center', marginBottom: 6 }}>
              Delete "{group.name}"?
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5, marginBottom: 20 }}>
              This will permanently delete this group along with all its {expenses.length} shared expenses and settlement records. This action cannot be undone.
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost btn-full" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn btn-danger btn-full"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  onDeleteGroup();
                }}
              >
                Yes, Delete Group
              </button>
            </div>
          </div>
        </>
      )}

      {/* Settle Up Bottom Sheet Modal */}
      {settleModal && (
        <>
          <div className="overlay" onClick={() => setSettleModal(null)} />
          <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
            <div className="sheet-handle" />
            <div style={{ fontSize: '1.2rem', textAlign: 'center', marginBottom: 4 }}>💸 Record Payment Settlement</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', marginBottom: 14 }}>
              Confirm that {settleModal.fromName} paid {settleModal.toName}
            </div>

            <div style={{ background: 'var(--bg-card2)', padding: 14, borderRadius: 12, textAlign: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 900, color: 'var(--text-primary)' }}>
                {formatINR(settleModal.amount)}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost btn-full" onClick={() => setSettleModal(null)}>Cancel</button>
              <button className="btn btn-primary btn-full" onClick={handleRecordSettlement}>
                ✓ Confirm Settlement
              </button>
            </div>
          </div>
        </>
      )}

      {/* Fullscreen Add Expense Modal */}
      {showAddExpense && (
        <AddGroupExpense
          group={group}
          onSave={handleAddExpense}
          onClose={() => setShowAddExpense(false)}
        />
      )}

      {/* Fullscreen Printable Settlement Slip */}
      {showSlip && (
        <GroupSettlementSlip
          group={group}
          balances={balances}
          onClose={() => setShowSlip(false)}
        />
      )}
    </div>
  );
}
