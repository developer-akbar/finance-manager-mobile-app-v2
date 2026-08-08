import React, { useRef } from 'react';
import { formatINR, formatDate } from '../../utils/format.js';
import { buildWhatsAppReminder } from '../../utils/debtSimplifier.js';

export default function GroupSettlementSlip({ group, balances, onClose }) {
  const slipRef = useRef(null);

  const { memberStats, simplifiedDebts, totalSpent } = balances;

  const handlePrintOrPdf = () => {
    window.print();
  };

  const handleShareWhatsApp = (debt) => {
    const text = buildWhatsAppReminder({
      debtorName: debt.fromName,
      creditorName: debt.toName,
      amount: debt.amount,
      groupName: group.name,
      upiId: debt.toUpi,
    });
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  };

  return (
    <div className="fullscreen-modal" style={{ zIndex: 1000, overflowY: 'auto', background: 'var(--bg-base)' }}>
      {/* Top Header */}
      <div className="page-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="back-btn" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="page-hdr-title">📄 Settlement Summary Slip</div>
        <button
          onClick={handlePrintOrPdf}
          style={{
            padding: '6px 12px',
            borderRadius: 12,
            background: 'var(--accent)',
            color: 'var(--text-secondary)',
            fontWeight: 800,
            fontSize: '0.75rem',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          🖨️ Print / PDF
        </button>
      </div>

      <div style={{ maxWidth: 600, margin: '0 auto', padding: '16px var(--page-px) 40px' }} ref={slipRef}>
        {/* Printable Slip Card */}
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: 18,
          border: '1px solid var(--border)',
          padding: 20,
          boxShadow: '0 8px 30px rgba(0,0,0,0.15)',
        }}>
          {/* Slip Header */}
          <div style={{ textAlign: 'center', borderBottom: '1px dashed var(--border)', paddingBottom: 16, marginBottom: 16 }}>
            <div style={{ fontSize: '2rem', marginBottom: 4 }}>{group.emoji || '🏖️'}</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 900, color: 'var(--text-primary)' }}>{group.name}</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Generated on {formatDate(new Date().toISOString(), 'short')} · FinMan Split
            </div>
            <div style={{
              display: 'inline-block',
              marginTop: 10,
              padding: '6px 16px',
              borderRadius: 20,
              background: 'rgba(0, 229, 160, 0.12)',
              border: '1px solid var(--accent)',
              color: 'var(--accent)',
              fontWeight: 800,
              fontSize: '0.9rem'
            }}>
              Total Group Spend: {formatINR(totalSpent)}
            </div>
          </div>

          {/* Member Spending Table */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
              📊 Member Contributions &amp; Balances
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {memberStats.map(m => (
                <div key={m.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', borderRadius: 10, background: 'var(--bg-card2)', border: '1px solid var(--border-light)'
                }}>
                  <div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {m.name} {m.isYou ? '🌟' : ''}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                      Paid: {formatINR(m.paid)} · Share: {formatINR(m.share)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{
                      fontSize: '0.85rem', fontWeight: 800,
                      color: m.net > 0 ? 'var(--income)' : m.net < 0 ? 'var(--expense)' : 'var(--text-muted)'
                    }}>
                      {m.net > 0 ? `+${formatINR(m.net)}` : m.net < 0 ? `−${formatINR(Math.abs(m.net))}` : 'Settled'}
                    </div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                      {m.net > 0 ? 'Gets back' : m.net < 0 ? 'Owes' : 'All clear'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Simplified Settlements */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
              ⚡ Simplified Settlements ({simplifiedDebts.length} Transfers Needed)
            </div>
            {simplifiedDebts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--income)', fontWeight: 700, fontSize: '0.85rem' }}>
                🎉 Everyone is settled up! Zero pending balances.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {simplifiedDebts.map((debt, idx) => (
                  <div key={idx} style={{
                    padding: '12px 14px', borderRadius: 12, border: '1px solid var(--border)',
                    background: 'var(--bg-card2)', display: 'flex', flexDirection: 'column', gap: 8
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontSize: '0.82rem', fontWeight: 700 }}>
                        <span style={{ color: 'var(--expense)', fontWeight: 800 }}>{debt.fromName}</span>
                        <span style={{ color: 'var(--text-muted)', margin: '0 6px' }}>pays</span>
                        <span style={{ color: 'var(--income)', fontWeight: 800 }}>{debt.toName}</span>
                      </div>
                      <div style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--text-primary)' }}>
                        {formatINR(debt.amount)}
                      </div>
                    </div>

                    {/* Action Bar: WhatsApp Reminder & UPI QR */}
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <button
                        onClick={() => handleShareWhatsApp(debt)}
                        style={{
                          flex: 1, padding: '6px 10px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700,
                          background: 'rgba(37, 211, 102, 0.15)', color: '#25D366', border: '1px solid rgba(37, 211, 102, 0.3)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, cursor: 'pointer'
                        }}
                      >
                        <span>💬</span> WhatsApp Reminder
                      </button>
                      {debt.toUpi && (
                        <a
                          href={`upi://pay?pa=${encodeURIComponent(debt.toUpi)}&pn=${encodeURIComponent(debt.toName)}&am=${debt.amount}&tn=${encodeURIComponent(`${group.name} Settlement`)}`}
                          style={{
                            padding: '6px 12px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700,
                            background: 'rgba(77, 159, 255, 0.15)', color: '#4d9fff', border: '1px solid rgba(77, 159, 255, 0.3)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, textDecoration: 'none'
                          }}
                        >
                          <span>📲</span> Pay via UPI
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Itemized Expenses List */}
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
              🧾 Itemized Expense Breakdown ({(group.expenses || []).length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(group.expenses || []).map(exp => (
                <div key={exp.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 10px', borderRadius: 8, background: 'var(--bg-base)', border: '1px solid var(--border-light)'
                }}>
                  <div>
                    <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>{exp.title}</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                      {formatDate(exp.date, 'short')} · Paid by {exp.paidBy?.map(p => group.members.find(m => m.id === p.memberId)?.name || 'Someone').join(', ')}
                    </div>
                  </div>
                  <div style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {formatINR(exp.amount)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
