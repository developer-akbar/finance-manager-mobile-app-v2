import React, { useState, useEffect, useMemo } from 'react';
import { formatINR } from '../../utils/format.js';
import { computeGroupBalances } from '../../utils/debtSimplifier.js';
import GroupDetail from './GroupDetail.jsx';

const STORAGE_KEY = 'finman_shared_groups';

const DEFAULT_SAMPLE_GROUPS = [
  {
    id: 'grp-sample-1',
    name: 'Goa Trip 2026',
    emoji: '🏖️',
    currency: 'INR',
    createdAt: new Date().toISOString(),
    members: [
      { id: 'm-1', name: 'You (Akbar)', upiId: 'akbar@upi', isYou: true },
      { id: 'm-2', name: 'Rahul', upiId: 'rahul@okaxis', isYou: false },
      { id: 'm-3', name: 'Sneha', upiId: 'sneha@icici', isYou: false },
      { id: 'm-4', name: 'Imran', upiId: 'imran@paytm', isYou: false }
    ],
    expenses: [
      {
        id: 'exp-1',
        title: 'Villa Stay Advance',
        amount: 12000,
        date: new Date().toISOString().split('T')[0],
        category: 'Stay',
        paidBy: [{ memberId: 'm-1', amount: 12000 }],
        splitMode: 'equal',
        splits: [
          { memberId: 'm-1', share: 3000 },
          { memberId: 'm-2', share: 3000 },
          { memberId: 'm-3', share: 3000 },
          { memberId: 'm-4', share: 3000 }
        ]
      },
      {
        id: 'exp-2',
        title: 'Beach Shack Dinner',
        amount: 4800,
        date: new Date().toISOString().split('T')[0],
        category: 'Food',
        paidBy: [{ memberId: 'm-2', amount: 4800 }],
        splitMode: 'equal',
        splits: [
          { memberId: 'm-1', share: 1200 },
          { memberId: 'm-2', share: 1200 },
          { memberId: 'm-3', share: 1200 },
          { memberId: 'm-4', share: 1200 }
        ]
      }
    ],
    settlements: []
  }
];

export default function GroupSplitManager({ onBack, backInterceptRef, onRecordFinManTxn }) {
  const [groups, setGroups] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : DEFAULT_SAMPLE_GROUPS;
    } catch {
      return DEFAULT_SAMPLE_GROUPS;
    }
  });

  const [activeGroupId, setActiveGroupId] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [groupToDelete, setGroupToDelete] = useState(null);

  // New Group Form State
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupEmoji, setNewGroupEmoji] = useState('🏖️');
  const [memberInputs, setMemberInputs] = useState(['Rahul', 'Sneha']);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
    } catch { /* storage full / blocked */ }
  }, [groups]);

  // Back button interception
  useEffect(() => {
    if (!backInterceptRef) return;
    if (activeGroupId) {
      // GroupDetail will handle sub-views
    } else if (groupToDelete) {
      backInterceptRef.current = () => setGroupToDelete(null);
    } else if (showCreateModal) {
      backInterceptRef.current = () => setShowCreateModal(false);
    } else {
      backInterceptRef.current = onBack;
    }
    return () => { if (backInterceptRef) backInterceptRef.current = null; };
  }, [activeGroupId, groupToDelete, showCreateModal, onBack, backInterceptRef]);

  const activeGroup = useMemo(() => {
    return groups.find(g => g.id === activeGroupId) || null;
  }, [groups, activeGroupId]);

  const handleUpdateGroup = (updatedGroup) => {
    setGroups(prev => prev.map(g => g.id === updatedGroup.id ? updatedGroup : g));
  };

  const handleDeleteGroup = (groupId) => {
    setGroups(prev => prev.filter(g => g.id !== groupId));
    if (activeGroupId === groupId) setActiveGroupId(null);
    setGroupToDelete(null);
  };

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return;

    const newMembers = [
      { id: 'm-you', name: 'You (Akbar)', isYou: true },
      ...memberInputs.filter(m => m.trim()).map((name, i) => ({
        id: `m-${Date.now()}-${i}`,
        name: name.trim(),
        isYou: false
      }))
    ];

    const newGroup = {
      id: `grp-${Date.now()}`,
      name: newGroupName.trim(),
      emoji: newGroupEmoji,
      currency: 'INR',
      createdAt: new Date().toISOString(),
      members: newMembers,
      expenses: [],
      settlements: []
    };

    setGroups(prev => [newGroup, ...prev]);
    setActiveGroupId(newGroup.id);
    setShowCreateModal(false);
    setNewGroupName('');
    setMemberInputs(['Rahul', 'Sneha']);
  };

  if (activeGroup) {
    return (
      <GroupDetail
        group={activeGroup}
        onUpdateGroup={handleUpdateGroup}
        onDeleteGroup={() => handleDeleteGroup(activeGroup.id)}
        onBack={() => setActiveGroupId(null)}
        onRecordFinManTxn={onRecordFinManTxn}
        backInterceptRef={backInterceptRef}
      />
    );
  }

  return (
    <div className="sub-screen">
      {/* Header */}
      <div className="page-hdr" style={{ display: 'flex', alignItems: 'center' }}>
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="page-hdr-title" style={{ flex: '1' }}>👥 Group Splits &amp; Trips</div>
        <button
          onClick={() => setShowCreateModal(true)}
          style={{
            padding: '6px 12px',
            borderRadius: 12,
            background: 'var(--accent)',
            color: 'var(--blue)',
            fontWeight: 800,
            fontSize: '0.75rem',
            border: 'none',
            cursor: 'pointer'
          }}
        >
          + New Group
        </button>
      </div>

      <div className="sub-body" style={{ paddingBottom: 'calc(var(--safe-bottom) + 40px)' }}>
        {groups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 10 }}>🏖️</div>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>No shared groups yet</div>
            <div style={{ fontSize: '0.75rem', marginTop: 4, marginBottom: 16 }}>
              Create a group for trips, flatmates, dinners, or events to track and simplify shared expenses.
            </div>
            <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
              + Create First Group
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '0 var(--page-px)' }}>
            {groups.map(grp => {
              const b = computeGroupBalances(grp.members || [], grp.expenses || [], grp.settlements || []);
              const youMember = (grp.members || []).find(m => m.isYou);
              const youNet = b.memberStats.find(m => m.id === youMember?.id)?.net || 0;

              return (
                <div
                  key={grp.id}
                  onClick={() => setActiveGroupId(grp.id)}
                  style={{
                    background: 'var(--bg-card)', borderRadius: 14, border: '1px solid var(--border)',
                    padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      fontSize: '1.8rem', width: 48, height: 48, borderRadius: 12,
                      background: 'var(--bg-card2)', display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}>
                      {grp.emoji || '👥'}
                    </div>
                    <div>
                      <div style={{ fontSize: '0.92rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                        {grp.name}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        {(grp.members || []).length} members · {(grp.expenses || []).length} expenses · Total {formatINR(b.totalSpent)}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{
                        fontSize: '0.85rem', fontWeight: 900,
                        color: youNet > 0 ? 'var(--income)' : youNet < 0 ? 'var(--expense)' : 'var(--text-muted)'
                      }}>
                        {youNet > 0 ? `+${formatINR(youNet)}` : youNet < 0 ? `−${formatINR(Math.abs(youNet))}` : 'Settled'}
                      </div>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                        {youNet > 0 ? 'You get back' : youNet < 0 ? 'You owe' : 'All clear'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setGroupToDelete(grp);
                      }}
                      style={{
                        background: 'none', border: 'none', color: 'var(--text-muted)',
                        fontSize: '1rem', padding: '6px', cursor: 'pointer', borderRadius: 8,
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                      }}
                      title="Delete Group"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create Group Modal */}
      {showCreateModal && (
        <>
          <div className="overlay" onClick={() => setShowCreateModal(false)} />
          <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 20px)' }}>
            <div className="sheet-handle" />
            <div style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: 12 }}>
              Create Shared Group / Trip
            </div>

            {/* Emoji Selector */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {['🏖️', '🏠', '🍽️', '🚗', '🎉', '✈️', '💼', '🛒'].map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setNewGroupEmoji(emoji)}
                  style={{
                    fontSize: '1.2rem', padding: '6px 8px', borderRadius: 8,
                    border: `1px solid ${newGroupEmoji === emoji ? 'var(--accent)' : 'var(--border)'}`,
                    background: newGroupEmoji === emoji ? 'rgba(0,229,160,0.15)' : 'var(--bg-card2)',
                    cursor: 'pointer'
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>

            <input
              type="text"
              className="form-input"
              placeholder="Group Name (e.g. Goa Trip 2026, Flat Rent)"
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              style={{ fontSize: '0.9rem', marginBottom: 14 }}
              autoFocus
            />

            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--text-muted)', marginBottom: 6 }}>
              Other Members (You are automatically included)
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {memberInputs.map((val, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    className="form-input"
                    placeholder={`Member ${idx + 1} Name`}
                    value={val}
                    onChange={e => {
                      const updated = [...memberInputs];
                      updated[idx] = e.target.value;
                      setMemberInputs(updated);
                    }}
                    style={{ fontSize: '0.82rem' }}
                  />
                  {memberInputs.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setMemberInputs(memberInputs.filter((_, i) => i !== idx))}
                      style={{ background: 'none', border: 'none', color: 'var(--expense)', fontSize: '0.9rem', cursor: 'pointer', padding: '0 6px' }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setMemberInputs([...memberInputs, ''])}
                style={{
                  background: 'none', border: '1px dashed var(--border)', color: 'var(--accent)',
                  padding: '6px 0', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer'
                }}
              >
                + Add Another Member
              </button>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost btn-full" onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button
                className="btn btn-primary btn-full"
                disabled={!newGroupName.trim()}
                onClick={handleCreateGroup}
              >
                Create Group
              </button>
            </div>
          </div>
        </>
      )}

      {/* Delete Group Confirmation Modal */}
      {groupToDelete && (
        <>
          <div className="overlay" onClick={() => setGroupToDelete(null)} />
          <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
            <div className="sheet-handle" />
            <div style={{ fontSize: '2rem', textAlign: 'center', marginBottom: 8 }}>🗑️</div>
            <div style={{ fontSize: '1.05rem', fontWeight: 800, textAlign: 'center', marginBottom: 6 }}>
              Delete "{groupToDelete.name}"?
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5, marginBottom: 20 }}>
              This will permanently delete this group along with all its {(groupToDelete.expenses || []).length} shared expenses and settlement records. This action cannot be undone.
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost btn-full" onClick={() => setGroupToDelete(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger btn-full"
                onClick={() => handleDeleteGroup(groupToDelete.id)}
              >
                Yes, Delete Group
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
