import React, { useState, useMemo } from 'react';
import { formatINR } from '../../utils/format.js';
import { calculateSplits } from '../../utils/debtSimplifier.js';

export default function AddGroupExpense({ group, onSave, onClose }) {
  const members = group.members || [];
  const youMember = members.find(m => m.isYou) || members[0];

  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [category, setCategory] = useState('Food & Dining');

  // Payer state: single vs multi
  const [payerMode, setPayerMode] = useState('single'); // 'single' | 'multi'
  const [singlePayerId, setSinglePayerId] = useState(youMember?.id || '');
  const [multiPayerAmounts, setMultiPayerAmounts] = useState({});

  // Split state
  const [splitMode, setSplitMode] = useState('equal'); // 'equal' | 'exact' | 'percent' | 'shares'
  const [selectedMemberIds, setSelectedMemberIds] = useState(() => new Set(members.map(m => m.id)));
  const [customValues, setCustomValues] = useState({});
  const [error, setError] = useState('');

  const numAmount = parseFloat(amount) || 0;

  // Selected member objects
  const activeMembers = useMemo(() => {
    return members.filter(m => selectedMemberIds.has(m.id));
  }, [members, selectedMemberIds]);

  // Computed splits
  const computedSplits = useMemo(() => {
    return calculateSplits(numAmount, activeMembers, splitMode, customValues);
  }, [numAmount, activeMembers, splitMode, customValues]);

  const totalSplitSum = useMemo(() => {
    return computedSplits.reduce((sum, s) => sum + (parseFloat(s.share) || 0), 0);
  }, [computedSplits]);

  const totalPaidSum = useMemo(() => {
    if (payerMode === 'single') return numAmount;
    return Object.values(multiPayerAmounts).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
  }, [payerMode, numAmount, multiPayerAmounts]);

  const handleToggleMember = (id) => {
    setSelectedMemberIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id); // Keep at least 1
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSave = () => {
    if (!title.trim()) {
      setError('Please enter a description / title for this expense');
      return;
    }
    if (numAmount <= 0) {
      setError('Please enter a valid amount greater than 0');
      return;
    }
    if (Math.abs(totalPaidSum - numAmount) > 0.05) {
      setError(`Paid amount (₹${totalPaidSum}) must match total expense (₹${numAmount})`);
      return;
    }
    if (Math.abs(totalSplitSum - numAmount) > 0.05) {
      setError(`Split shares total (₹${totalSplitSum}) must match total expense (₹${numAmount})`);
      return;
    }

    // Build paidBy array
    let paidBy = [];
    if (payerMode === 'single') {
      paidBy = [{ memberId: singlePayerId, amount: numAmount }];
    } else {
      paidBy = Object.entries(multiPayerAmounts)
        .filter(([, v]) => parseFloat(v) > 0)
        .map(([memberId, v]) => ({ memberId, amount: parseFloat(v) }));
    }

    const expense = {
      id: `exp-${Date.now()}`,
      title: title.trim(),
      amount: numAmount,
      date,
      category,
      paidBy,
      splitMode,
      splits: computedSplits,
      createdAt: new Date().toISOString(),
    };

    onSave(expense);
  };

  return (
    <div className="fullscreen-modal" style={{ zIndex: 1000, overflowY: 'auto', background: 'var(--bg-base)' }}>
      {/* Header */}
      <div className="page-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="back-btn" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="page-hdr-title">Add Shared Expense</div>
        <div style={{ width: 32 }} />
      </div>

      <div style={{ maxWidth: 540, margin: '0 auto', padding: '16px var(--page-px) 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && (
          <div style={{ background: 'rgba(255, 77, 106, 0.15)', color: 'var(--expense)', padding: '8px 14px', borderRadius: 10, fontSize: '0.78rem', fontWeight: 700 }}>
            {error}
          </div>
        )}

        {/* Title & Amount */}
        <div style={{ background: 'var(--bg-card)', padding: 16, borderRadius: 14, border: '1px solid var(--border)' }}>
          <label style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
            Expense Description
          </label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g. Dinner, Fuel, Airbnb, Groceries"
            value={title}
            onChange={e => { setTitle(e.target.value); setError(''); }}
            style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: 12 }}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                Total Amount (₹)
              </label>
              <input
                type="number"
                step="any"
                className="form-input"
                placeholder="0.00"
                value={amount}
                onChange={e => { setAmount(e.target.value); setError(''); }}
                style={{ fontSize: '1.1rem', fontWeight: 900, color: 'var(--income)' }}
              />
            </div>
            <div>
              <label style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                Date
              </label>
              <input
                type="date"
                className="form-input"
                value={date}
                onChange={e => setDate(e.target.value)}
                style={{ fontSize: '0.85rem' }}
              />
            </div>
          </div>
        </div>

        {/* Paid By Section */}
        <div style={{ background: 'var(--bg-card)', padding: 16, borderRadius: 14, border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--text-muted)', margin: 0 }}>
              💳 Who Paid?
            </label>
            <div style={{ display: 'flex', gap: 4, background: 'var(--bg-card2)', padding: 2, borderRadius: 8 }}>
              <button
                type="button"
                onClick={() => setPayerMode('single')}
                style={{
                  padding: '3px 8px', borderRadius: 6, fontSize: '0.68rem', fontWeight: 700, border: 'none',
                  background: payerMode === 'single' ? 'var(--accent)' : 'transparent',
                  color: payerMode === 'single' ? '#000' : 'var(--text-muted)', cursor: 'pointer'
                }}
              >
                Single Payer
              </button>
              <button
                type="button"
                onClick={() => setPayerMode('multi')}
                style={{
                  padding: '3px 8px', borderRadius: 6, fontSize: '0.68rem', fontWeight: 700, border: 'none',
                  background: payerMode === 'multi' ? 'var(--accent)' : 'transparent',
                  color: payerMode === 'multi' ? '#000' : 'var(--text-muted)', cursor: 'pointer'
                }}
              >
                Multiple
              </button>
            </div>
          </div>

          {payerMode === 'single' ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {members.map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSinglePayerId(m.id)}
                  style={{
                    padding: '6px 12px', borderRadius: 10, fontSize: '0.75rem', fontWeight: 700,
                    border: `1px solid ${singlePayerId === m.id ? 'var(--accent)' : 'var(--border)'}`,
                    background: singlePayerId === m.id ? 'rgba(0,229,160,0.15)' : 'var(--bg-card2)',
                    color: singlePayerId === m.id ? 'var(--accent)' : 'var(--text-primary)',
                    cursor: 'pointer'
                  }}
                >
                  {m.name} {m.isYou ? '(You)' : ''}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {members.map(m => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{m.name}</span>
                  <input
                    type="number"
                    step="any"
                    className="form-input"
                    placeholder="₹ 0"
                    style={{ width: 110, fontSize: '0.85rem', textAlign: 'right', padding: '4px 8px' }}
                    value={multiPayerAmounts[m.id] || ''}
                    onChange={e => setMultiPayerAmounts(prev => ({ ...prev, [m.id]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Split Mode & Split With */}
        <div style={{ background: 'var(--bg-card)', padding: 16, borderRadius: 14, border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--text-muted)', margin: 0 }}>
              👥 Split With
            </label>
            <div style={{ display: 'flex', gap: 4, background: 'var(--bg-card2)', padding: 2, borderRadius: 8 }}>
              {['equal', 'exact', 'percent', 'shares'].map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSplitMode(mode)}
                  style={{
                    padding: '3px 6px', borderRadius: 6, fontSize: '0.65rem', fontWeight: 700, border: 'none',
                    background: splitMode === mode ? 'var(--accent)' : 'transparent',
                    color: splitMode === mode ? '#000' : 'var(--text-muted)', textTransform: 'capitalize', cursor: 'pointer'
                  }}
                >
                  {mode === 'equal' ? 'Equally' : mode === 'exact' ? 'Exact ₹' : mode === 'percent' ? '%' : 'Shares'}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {members.map(m => {
              const isSelected = selectedMemberIds.has(m.id);
              const computedShare = computedSplits.find(s => s.memberId === m.id)?.share || 0;

              return (
                <div
                  key={m.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 10px', borderRadius: 10, background: isSelected ? 'var(--bg-card2)' : 'var(--bg-base)',
                    border: `1px solid ${isSelected ? 'var(--border)' : 'transparent'}`, opacity: isSelected ? 1 : 0.5
                  }}
                >
                  <div
                    onClick={() => handleToggleMember(m.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1 }}
                  >
                    <input type="checkbox" checked={isSelected} onChange={() => {}} style={{ pointerEvents: 'none' }} />
                    <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>{m.name}</span>
                  </div>

                  {isSelected && (
                    <div>
                      {splitMode === 'equal' ? (
                        <span style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--accent)' }}>
                          {formatINR(computedShare)}
                        </span>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            style={{ width: 80, fontSize: '0.8rem', textAlign: 'right', padding: '4px 6px' }}
                            placeholder={splitMode === 'exact' ? '₹' : splitMode === 'percent' ? '%' : 'Shares'}
                            value={customValues[m.id] || ''}
                            onChange={e => setCustomValues(prev => ({ ...prev, [m.id]: e.target.value }))}
                          />
                          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', minWidth: 45, textAlign: 'right' }}>
                            ({formatINR(computedShare)})
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Save Button */}
        <button
          className="btn btn-primary btn-full"
          onClick={handleSave}
          style={{ marginTop: 6, padding: '12px 0', fontSize: '0.95rem', fontWeight: 800 }}
        >
          Save Expense ({formatINR(numAmount)})
        </button>
      </div>
    </div>
  );
}
