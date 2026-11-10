import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, getUserFacingTags } from '../../utils/format.js';
import { toast } from '../Common/Toast.jsx';
import './Bookmarks.css';

const TYPES = [
  { id: 'Expense', label: 'Expense', cls: 'expense' },
  { id: 'Income', label: 'Income', cls: 'income' },
  { id: 'Transfer-Out', label: 'Transfer', cls: 'transfer' },
];

export default function Bookmarks({ isActive, onUseBookmark, backInterceptRef }) {
  const { state, navigate, updateBookmark, deleteBookmark, duplicateBookmark, reorderBookmarks } = useApp();
  const { bookmarks = [], accounts = [], categories = {} } = state || {};

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All'); // 'All' | 'Expense' | 'Income' | 'Transfer'
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState(null);
  const [deletingBookmark, setDeletingBookmark] = useState(null);
  const [draggedIdx, setDraggedIdx] = useState(null);

  // Hardware back button / Escape key interception
  useEffect(() => {
    if (!isActive && !deletingBookmark && !editingBookmark) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (deletingBookmark) {
          e.stopPropagation();
          setDeletingBookmark(null);
        } else if (editingBookmark) {
          e.stopPropagation();
          setEditingBookmark(null);
        } else if (isEditMode) {
          e.stopPropagation();
          setIsEditMode(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);

    if (backInterceptRef) {
      const original = backInterceptRef.current;
      backInterceptRef.current = () => {
        if (deletingBookmark) {
          setDeletingBookmark(null);
          return true;
        }
        if (editingBookmark) {
          setEditingBookmark(null);
          return true;
        }
        if (isEditMode) {
          setIsEditMode(false);
          return true;
        }
        navigate('transactions');
        return true;
      };
      return () => {
        backInterceptRef.current = original;
        window.removeEventListener('keydown', handleKeyDown, true);
      };
    }

    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isActive, backInterceptRef, deletingBookmark, editingBookmark, isEditMode, navigate]);

  // Counts by type
  const counts = useMemo(() => {
    const c = { All: bookmarks.length, Expense: 0, Income: 0, Transfer: 0 };
    for (const b of bookmarks) {
      const t = b.transaction_type || 'Expense';
      if (t === 'Income') c.Income++;
      else if (t.startsWith('Transfer')) c.Transfer++;
      else c.Expense++;
    }
    return c;
  }, [bookmarks]);

  // Filter & Search
  const filteredBookmarks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bookmarks.filter(b => {
      // Type match
      const t = b.transaction_type || 'Expense';
      if (typeFilter === 'Expense' && t !== 'Expense') return false;
      if (typeFilter === 'Income' && t !== 'Income') return false;
      if (typeFilter === 'Transfer' && !t.startsWith('Transfer')) return false;

      // Text search match
      if (!q) return true;
      const td = b.template_data || {};
      const nameMatch = (b.name || '').toLowerCase().includes(q);
      const noteMatch = (td.note || '').toLowerCase().includes(q);
      const descMatch = (td.description || '').toLowerCase().includes(q);
      const catMatch = (td.category || '').toLowerCase().includes(q);
      const subcatMatch = (td.subcategory || '').toLowerCase().includes(q);
      const acctMatch = (td.account || td.from_account || td.to_account || '').toLowerCase().includes(q);
      const subAcctMatch = (td.sub_account || td.from_sub_account || td.to_sub_account || '').toLowerCase().includes(q);
      const tagsMatch = (td.tags || '').toLowerCase().includes(q);

      return nameMatch || noteMatch || descMatch || catMatch || subcatMatch || acctMatch || subAcctMatch || tagsMatch;
    });
  }, [bookmarks, typeFilter, search]);

  // Mobile Long-Press (550ms) to toggle management mode
  const longPressTimerRef = useRef(null);
  const startPosRef = useRef({ x: 0, y: 0 });
  const isLongPressTriggeredRef = useRef(false);

  const handleCardPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, a, .bookmark-mgmt-btn, .bookmark-use-btn, .bookmark-reorder-btn')) {
      return;
    }
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    startPosRef.current = { x: e.clientX, y: e.clientY };
    isLongPressTriggeredRef.current = false;

    longPressTimerRef.current = setTimeout(() => {
      isLongPressTriggeredRef.current = true;
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(40); } catch {}
      }
      setIsEditMode(prev => !prev);
    }, 550);
  };

  const handleCardPointerMove = (e) => {
    if (!longPressTimerRef.current) return;
    const dx = Math.abs(e.clientX - startPosRef.current.x);
    const dy = Math.abs(e.clientY - startPosRef.current.y);
    if (dx > 10 || dy > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleCardPointerUpOrCancel = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (isLongPressTriggeredRef.current) {
      setTimeout(() => {
        isLongPressTriggeredRef.current = false;
      }, 300);
    }
  };

  const handleCardContextMenu = (e) => {
    if (isLongPressTriggeredRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  };

    // Drag and drop reordering (available in edit mode or anytime draggable)
  const dragIdxRef = useRef(null);

  const handleDragStart = (e, index) => {
    dragIdxRef.current = index;
    setDraggedIdx(index);
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', String(index));
    } catch {}
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragIdxRef.current === null || dragIdxRef.current === index) return;

    const fromIdx = dragIdxRef.current;
    const toIdx = index;
    dragIdxRef.current = toIdx;
    setDraggedIdx(toIdx);

    // Swap locally in array
    const reordered = [...bookmarks];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);

    // Save persistent sort orders
    const orderedIds = reordered.map(b => b.id);
    reorderBookmarks(orderedIds);
  };

  const handleDragEnd = () => {
    dragIdxRef.current = null;
    setDraggedIdx(null);
  };

  // Move item up / down for touch / mobile
  const moveBookmark = async (index, direction) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= bookmarks.length) return;

    const reordered = [...bookmarks];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIdx, 0, moved);

    const orderedIds = reordered.map(b => b.id);
    await reorderBookmarks(orderedIds);
    toast.success('Bookmark order updated');
  };

  // Duplication
  const handleDuplicate = async (b) => {
    try {
      await duplicateBookmark(b.id);
      toast.success(`Duplicated "${b.name}"`);
    } catch (err) {
      console.error('Failed to duplicate bookmark:', err);
      toast.error('Failed to duplicate bookmark');
    }
  };

  // Deletion
  const handleDeleteConfirm = async () => {
    if (!deletingBookmark) return;
    try {
      const name = deletingBookmark.name;
      await deleteBookmark(deletingBookmark.id);
      toast.success(`Removed bookmark "${name}"`);
      setDeletingBookmark(null);
    } catch (err) {
      console.error('Failed to delete bookmark:', err);
      toast.error('Failed to delete bookmark');
    }
  };

  return (
    <div className="bookmarks-screen">
      {/* FinMan Application Header */}
      <div className="page-hdr bookmarks-page-hdr">
        <div className="bookmarks-hdr-left">
          <button className="back-btn" onClick={() => navigate('transactions')} title="Back to Transactions">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="page-hdr-title bookmarks-title">Bookmarks</div>
        </div>

        {/* Single Global Edit / Done Toggle Button */}
        {bookmarks.length > 0 && (
          <button
            type="button"
            className={`bookmarks-global-edit-btn ${isEditMode ? 'active' : ''}`}
            onClick={() => setIsEditMode(prev => !prev)}
            title={isEditMode ? 'Finish managing bookmarks' : 'Manage and reorder bookmark templates'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
              {isEditMode ? (
                <polyline points="20 6 9 17 4 12" />
              ) : (
                <>
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </>
              )}
            </svg>
            <span>{isEditMode ? 'Done' : 'Edit'}</span>
          </button>
        )}
      </div>

      {/* Main Content Body */}
      <div className="bookmarks-body">
        {/* Search & Filter Toolbar — Immediately below header */}
        <div className="bookmarks-toolbar">
          <div className="bookmarks-search-wrap">
            <svg className="bookmarks-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="15" height="15">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="text"
              className="bookmarks-search-input"
              placeholder="Search bookmarks by name, note, category, account..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="bookmarks-search-clear" onClick={() => setSearch('')} title="Clear search">
                ✕
              </button>
            )}
          </div>

          <div className="bookmarks-filter-tabs">
            {['All', 'Expense', 'Income', 'Transfer'].map((type) => (
              <button
                key={type}
                className={`bookmarks-filter-tab ${typeFilter === type ? 'active' : ''}`}
                onClick={() => setTypeFilter(type)}
              >
                <span>{type}</span>
                <span className="bookmarks-filter-count">({counts[type] || 0})</span>
              </button>
            ))}
          </div>
        </div>

        {/* Bookmark Cards Grid */}
        <div className="bookmarks-card-list">
          {filteredBookmarks.length === 0 ? (
            <div className="bookmarks-empty">
              <div className="bookmarks-empty-icon">🔖</div>
              <div className="bookmarks-empty-title">
                {bookmarks.length === 0 ? 'No bookmarks saved yet' : 'No matching bookmarks'}
              </div>
              <div className="bookmarks-empty-sub">
                {bookmarks.length === 0
                  ? 'Open any transaction from your list and tap "Bookmark" to save it as a reusable template for quick entry.'
                  : 'Try adjusting your search query or switching filters.'}
              </div>
              {bookmarks.length === 0 ? (
                <button className="btn btn-primary" onClick={() => navigate('transactions')}>
                  View Transactions
                </button>
              ) : (
                <button className="btn btn-secondary" onClick={() => { setSearch(''); setTypeFilter('All'); }}>
                  Clear Filters
                </button>
              )}
            </div>
          ) : (
            filteredBookmarks.map((bookmark, idx) => {
              const td = bookmark.template_data || {};
              const isXfer = (bookmark.transaction_type || '').startsWith('Transfer');
              const typeCls = isXfer ? 'transfer' : (bookmark.transaction_type === 'Income' ? 'income' : 'expense');
              const amt = parseFloat(td.amount || 0);

              return (
                <div
                  key={bookmark.id}
                  className={`bookmark-card ${draggedIdx === idx ? 'dragging' : ''} ${isEditMode ? 'edit-mode' : ''}`}
                  onPointerDown={handleCardPointerDown}
                  onPointerMove={handleCardPointerMove}
                  onPointerUp={handleCardPointerUpOrCancel}
                  onPointerCancel={handleCardPointerUpOrCancel}
                  onContextMenu={handleCardContextMenu}
                  draggable={isEditMode}
                  onDragStart={(e) => isEditMode && handleDragStart(e, idx)}
                  onDragOver={(e) => isEditMode && handleDragOver(e, idx)}
                  onDragEnd={handleDragEnd}
                >
                  {/* Two-Column Horizontal Card Layout: Left Info Area + Right Action Area */}
                  <div className="bookmark-card-content">
                    {/* Left: Main Information Area */}
                    <div className="bookmark-card-info">
                      {/* Row 1: Type Pill + Bookmark Name */}
                      <div className="bookmark-card-row-title">
                        <span className={`bookmark-type-pill ${typeCls}`}>
                          {bookmark.transaction_type || 'Expense'}
                        </span>
                        <span className="bookmark-card-name">{bookmark.name}</span>
                      </div>

                      {/* Row 2: Account route, Category, and Note (inline horizontal) */}
                      <div className="bookmark-card-row-meta">
                        <span className="bookmark-meta-item">
                          <span className="bookmark-meta-icon">💳</span>
                          <span className="bookmark-meta-val">
                            {isXfer
                              ? `${td.from_account || td.account || '—'}${td.from_sub_account ? ` (${td.from_sub_account})` : ''} → ${td.to_account || '—'}${td.to_sub_account ? ` (${td.to_sub_account})` : ''}`
                              : `${td.account || '—'}${td.sub_account ? ` → ${td.sub_account}` : ''}`
                            }
                          </span>
                        </span>

                        {!isXfer && td.category && (
                          <>
                            <span className="bookmark-meta-dot">·</span>
                            <span className="bookmark-meta-item">
                              <span className="bookmark-meta-icon">📁</span>
                              <span className="bookmark-meta-val">
                                {td.category}{td.subcategory ? ` · ${td.subcategory}` : ''}
                              </span>
                            </span>
                          </>
                        )}

                        {td.note && (
                          <>
                            <span className="bookmark-meta-dot">·</span>
                            <span className="bookmark-meta-item bookmark-meta-note" title={td.note}>
                              "{td.note}"
                            </span>
                          </>
                        )}
                      </div>

                      {/* Row 3: Tags + Usage count (inline horizontal) */}
                      <div className="bookmark-card-row-sub">
                        {td.tags && getUserFacingTags(td.tags).length > 0 && (
                          <div className="bookmark-tags-wrap">
                            {getUserFacingTags(td.tags).map(tg => (
                              <span key={tg} className="bookmark-tag-pill">#{tg}</span>
                            ))}
                          </div>
                        )}

                        {td.tags && getUserFacingTags(td.tags).length > 0 && (
                          <span className="bookmark-meta-dot">·</span>
                        )}

                        <span className="bookmark-usage-text">
                          {bookmark.usage_count > 0
                            ? `Used ${bookmark.usage_count} time${bookmark.usage_count > 1 ? 's' : ''}`
                            : 'Not used yet'}
                        </span>
                      </div>
                    </div>

                    {/* Right: Action Area (Amount on top, Use button directly below it) */}
                    <div className="bookmark-card-action-area">
                      {amt > 0 ? (
                        <div className="bookmark-card-amount">
                          {formatINR(amt)}
                        </div>
                      ) : (
                        <div className="bookmark-card-amount-empty" title="Amount varies">
                          —
                        </div>
                      )}
                      <button
                        type="button"
                        className="bookmark-use-btn"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onUseBookmark(bookmark);
                        }}
                        title="Create fresh transaction from this template"
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                        <span>Use</span>
                      </button>
                    </div>
                  </div>

                  {/* Management Bar (Revealed across ALL cards when global Edit mode is active) */}
                  {isEditMode && (
                    <div className="bookmark-management-bar">
                      <div className="bookmark-mgmt-actions">
                        <button
                          type="button"
                          className="bookmark-mgmt-btn"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingBookmark(bookmark);
                          }}
                          title="Edit Bookmark Template"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                          <span>Edit</span>
                        </button>

                        <button
                          type="button"
                          className="bookmark-mgmt-btn"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDuplicate(bookmark);
                          }}
                          title="Duplicate Template"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                          <span>Copy</span>
                        </button>

                        <div className="bookmark-reorder-btn-group">
                          <button
                            type="button"
                            className="bookmark-mgmt-btn bookmark-reorder-btn"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              moveBookmark(idx, -1);
                            }}
                            disabled={idx === 0}
                            title="Move Up"
                          >
                            ▲ Up
                          </button>
                          <button
                            type="button"
                            className="bookmark-mgmt-btn bookmark-reorder-btn"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              moveBookmark(idx, 1);
                            }}
                            disabled={idx === bookmarks.length - 1}
                            title="Move Down"
                          >
                            ▼ Down
                          </button>
                        </div>

                        <button
                          type="button"
                          className="bookmark-mgmt-btn bookmark-delete-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeletingBookmark(bookmark);
                          }}
                          title="Delete Bookmark Template"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6l-1 14H6L5 6" />
                            <path d="M10 11v6M14 11v6" />
                            <path d="M9 6V4h6v2" />
                          </svg>
                          <span>Delete</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Edit Bookmark Modal (Identical to FinMan Edit Transaction) */}
      {editingBookmark && (
        <EditBookmarkModal
          bookmark={editingBookmark}
          accounts={accounts}
          categories={categories}
          onClose={() => setEditingBookmark(null)}
          onSave={async (id, updates) => {
            await updateBookmark(id, updates);
            toast.success('Bookmark updated');
            setEditingBookmark(null);
          }}
        />
      )}

      {/* Delete Confirmation Sheet (FinMan Standard) */}
      {deletingBookmark && (
        <>
          <div className="overlay" onClick={() => setDeletingBookmark(null)} />
          <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 20px)' }} onClick={e => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{ display: 'inline-flex', padding: 12, borderRadius: '50%', background: 'var(--expense-bg)', color: 'var(--expense)', marginBottom: 8 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="28" height="28">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4h6v2" />
                </svg>
              </div>
              <div style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                Delete Bookmark?
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                Are you sure you want to delete <strong>"{deletingBookmark.name}"</strong>?<br/>
                Existing transactions created from this bookmark will not be modified or deleted.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-ghost btn-full" onClick={() => setDeletingBookmark(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger btn-full" onClick={handleDeleteConfirm}>
                Delete
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Edit Bookmark Modal (Directly reusing FinMan Edit Transaction Structure) ───
function EditBookmarkModal({ bookmark, accounts, categories, onClose, onSave }) {
  const td = bookmark.template_data || {};
  const [name, setName] = useState(bookmark.name || '');
  const [type, setType] = useState(bookmark.transaction_type || 'Expense');
  const [amount, setAmount] = useState(td.amount !== undefined && td.amount !== null ? String(td.amount) : '');
  const [account, setAccount] = useState(td.account || '');
  const [subAccount, setSubAccount] = useState(td.sub_account || '');
  const [fromAccount, setFromAccount] = useState(td.from_account || td.account || '');
  const [toAccount, setToAccount] = useState(td.to_account || '');
  const [category, setCategory] = useState(td.category || '');
  const [subcategory, setSubcategory] = useState(td.subcategory || '');
  const [note, setNote] = useState(td.note || '');
  const [description, setDescription] = useState(td.description || '');
  const [tags, setTags] = useState(td.tags || '');

  const isXfer = type.startsWith('Transfer');

  // Available sub-accounts for selected account
  const activeAcctObj = useMemo(() => {
    return accounts.find(a => (a.name || a) === (isXfer ? fromAccount : account));
  }, [accounts, isXfer, fromAccount, account]);

  const subAccountsList = useMemo(() => {
    if (!activeAcctObj) return [];
    const subs = Array.isArray(activeAcctObj.subAccounts) ? activeAcctObj.subAccounts : [];
    return subs.map(s => typeof s === 'string' ? s : s.name).filter(Boolean);
  }, [activeAcctObj]);

  // Available subcategories for selected category
  const subcategoriesList = useMemo(() => {
    if (!category || !categories[category]) return [];
    return categories[category].subcategories || [];
  }, [category, categories]);

  const handleSave = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Bookmark name is required');
      return;
    }

    const updatedTemplate = {
      ...td,
      amount: String(amount || ''),
      account: isXfer ? fromAccount : account,
      sub_account: isXfer ? '' : subAccount,
      from_account: fromAccount,
      to_account: toAccount,
      category: isXfer ? '' : category,
      subcategory: isXfer ? '' : subcategory,
      note: note.trim(),
      description: description.trim(),
      tags: tags.trim()
    };

    onSave(bookmark.id, {
      name: name.trim(),
      transaction_type: type,
      template_data: updatedTemplate
    });
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div
        className="fullscreen-modal"
        data-type={type}
        onClick={(e) => e.stopPropagation()}
      >
        {/* FinMan standard Add/Edit Header */}
        <div className="add-hdr">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="add-title">Edit Bookmark Template</div>
          </div>
          <button type="button" className="add-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {/* FinMan standard Type Tabs */}
        <div className="type-tabs">
          {TYPES.map(tp => (
            <button
              key={tp.id}
              type="button"
              className={`type-tab ${tp.cls} ${type === tp.id ? 'active' : ''}`}
              onClick={() => setType(tp.id)}
            >
              {tp.label}
            </button>
          ))}
        </div>

        {/* FinMan standard Add/Edit Form Body */}
        <form onSubmit={handleSave} className="add-form" style={{ flex: 1, overflowY: 'auto', padding: '10px var(--page-px) 24px' }}>
          {/* Bookmark Name */}
          <div className="form-group">
            <label className="form-label">Name *</label>
            <input
              type="text"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Chicken groceries, Monthly Rent"
              required
            />
          </div>

          {/* Account(s) */}
          {!isXfer ? (
            <div className="form-group account-subacct-group">
              <label className="form-label">Account</label>
              <div className={`account-subacct-wrap ${subAccountsList.length > 0 ? 'has-sub' : ''}`}>
                <select
                  className="form-input"
                  value={account}
                  onChange={(e) => {
                    setAccount(e.target.value);
                    setSubAccount('');
                  }}
                >
                  <option value="">(Select Account)</option>
                  {accounts.map(a => {
                    const n = a.name || a;
                    return <option key={n} value={n}>{n}</option>;
                  })}
                </select>
                {subAccountsList.length > 0 && (
                  <select
                    className="form-input"
                    value={subAccount}
                    onChange={(e) => setSubAccount(e.target.value)}
                  >
                    <option value="">(Sub-Account)</option>
                    {subAccountsList.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="form-group account-subacct-group">
                <label className="form-label">From</label>
                <div className="account-subacct-wrap">
                  <select
                    className="form-input"
                    value={fromAccount}
                    onChange={(e) => setFromAccount(e.target.value)}
                  >
                    <option value="">(Select Account)</option>
                    {accounts.map(a => {
                      const n = a.name || a;
                      return <option key={n} value={n}>{n}</option>;
                    })}
                  </select>
                </div>
              </div>
              <div className="form-group account-subacct-group">
                <label className="form-label">To</label>
                <div className="account-subacct-wrap">
                  <select
                    className="form-input"
                    value={toAccount}
                    onChange={(e) => setToAccount(e.target.value)}
                  >
                    <option value="">(Select Destination)</option>
                    {accounts.map(a => {
                      const n = a.name || a;
                      return <option key={n} value={n}>{n}</option>;
                    })}
                  </select>
                </div>
              </div>
            </>
          )}

          {/* Category + Subcategory (hidden for Transfer) */}
          {!isXfer && (
            <div className="form-group category-subcat-group">
              <label className="form-label">Category</label>
              <div className={`category-subcat-wrap ${subcategoriesList.length > 0 ? 'has-sub' : ''}`}>
                <select
                  className="form-input"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    setSubcategory('');
                  }}
                >
                  <option value="">(Select Category)</option>
                  {Object.keys(categories).map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                {subcategoriesList.length > 0 && (
                  <select
                    className="form-input"
                    value={subcategory}
                    onChange={(e) => setSubcategory(e.target.value)}
                  >
                    <option value="">(Subcategory)</option>
                    {subcategoriesList.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          )}

          {/* Amount */}
          <div className="form-group">
            <label className="form-label">Amount</label>
            <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
              <span style={{ position: 'absolute', left: 10, fontSize: '0.9rem', color: 'var(--text-muted)', pointerEvents: 'none', zIndex: 1 }}>₹</span>
              <input
                className="form-input"
                style={{ paddingLeft: 24 }}
                type="number"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0 (optional if variable)"
              />
            </div>
          </div>

          {/* Note */}
          <div className="form-group">
            <label className="form-label">Note</label>
            <input
              type="text"
              className="form-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Monthly Broadband, Weekly Groceries"
            />
          </div>

          {/* Description */}
          <div className="description-section">
            <div className="form-group">
              <textarea
                className="form-input"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
              />
            </div>
          </div>

          {/* Tags */}
          <div className="form-group">
            <label className="form-label">Tags</label>
            <input
              type="text"
              className="form-input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="Comma-separated: recurring, home, utilities"
            />
          </div>

          {/* FinMan standard form action buttons */}
          <div className="form-actions" style={{ display: 'flex', gap: '10px', marginTop: 18, marginBottom: 8 }}>
            <button type="submit" className="btn btn-primary btn-lg" style={{ flex: 2 }}>
              Update Bookmark
            </button>
            <button type="button" className="btn btn-secondary btn-lg" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
