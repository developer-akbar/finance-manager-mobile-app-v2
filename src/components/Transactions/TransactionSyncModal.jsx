import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import {
  parseFinmanPayload,
  createSyncPlan,
  executeSyncPlan,
  CLASSIFICATION_TYPES,
  RESOLUTION_ACTIONS,
  SYNC_ERROR_CODES
} from '../../utils/finmanPayload.js';
import { formatINR, formatDate, formatTime } from '../../utils/format.js';
import { toast } from '../Common/Toast.jsx';
import { replaceAccounts } from '../../database/accounts.js';
import { replaceCategories } from '../../database/categories.js';
import { bulkImport } from '../../database/transactions.js';
import { v4 as uuid } from 'uuid';
import './TransactionSyncModal.css';

export default function TransactionSyncModal({ isOpen, onClose, initialPayloadText = '' }) {
  const { state, load, updateTransaction, addTransaction } = useApp();
  const { transactions = [], accounts = [], categories = {} } = state;

  const [step, setStep] = useState('input'); // 'input' | 'review' | 'complete'
  const [rawText, setRawText] = useState(initialPayloadText);
  const [parseError, setParseError] = useState(null);
  const [plan, setPlan] = useState(null);
  const [resolutions, setResolutions] = useState({});
  const [autoCreateRefs, setAutoCreateRefs] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all'); // 'all' | 'conflicts' | 'new' | 'existing'

  // Attempt auto-parsing if initial payload text is provided
  useEffect(() => {
    if (isOpen && initialPayloadText && initialPayloadText.trim()) {
      handleParseText(initialPayloadText);
    } else if (isOpen) {
      setStep('input');
      setRawText('');
      setParseError(null);
      setPlan(null);
      setExecutionResult(null);
    }
  }, [isOpen, initialPayloadText]);

  // Handle Clipboard Read with Fallback
  const handlePasteFromClipboard = async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        toast.info('Clipboard access unavailable. Please paste into the box below.');
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        toast.info('Clipboard is empty.');
        return;
      }
      setRawText(text);
      handleParseText(text);
    } catch (err) {
      console.warn('Clipboard read failed:', err);
      toast.info('Could not read clipboard automatically. Please paste into the box below.');
    }
  };

  // Safe parse & plan creation
  const handleParseText = (text) => {
    setParseError(null);
    if (!text || !text.trim()) {
      setParseError({ code: 'EMPTY_INPUT', message: 'Please paste payload JSON text.' });
      return;
    }

    const parsed = parseFinmanPayload(text);
    if (!parsed.success) {
      let friendlyMsg = parsed.error.message;
      if (parsed.error.code === SYNC_ERROR_CODES.INVALID_FORMAT) {
        friendlyMsg = 'Not a valid FinMan payload. Please verify you copied from a FinMan instance.';
      } else if (parsed.error.code === SYNC_ERROR_CODES.UNSUPPORTED_VERSION) {
        friendlyMsg = 'This payload was exported from an incompatible or future version of FinMan.';
      } else if (parsed.error.code === SYNC_ERROR_CODES.CHECKSUM_MISMATCH) {
        friendlyMsg = 'Integrity check failed: payload data appears tampered or corrupted in transit.';
      } else if (parsed.error.code === SYNC_ERROR_CODES.COUNT_MISMATCH) {
        friendlyMsg = 'Payload transaction count does not match declared header count.';
      }
      setParseError({ code: parsed.error.code, message: friendlyMsg, details: parsed.error.details });
      return;
    }

    const syncPlan = createSyncPlan({
      incomingTransactions: parsed.transactions,
      existingTransactions: transactions,
      existingAccounts: accounts,
      existingCategories: categories
    });

    // Default all conflicts to KEEP_EXISTING unless user explicitly overrides
    const initialResolutions = {};
    for (const conf of syncPlan.conflicts) {
      const id = String(conf.incomingTxn.id || conf.incomingTxn.ID || conf.incomingTxn._id);
      initialResolutions[id] = RESOLUTION_ACTIONS.KEEP_EXISTING;
    }

    setPlan(syncPlan);
    setResolutions(initialResolutions);
    setStep('review');
    setActiveFilter(syncPlan.conflicts.length > 0 ? 'conflicts' : 'all');
  };

  // Toggle conflict resolution
  const handleResolutionChange = (id, choice) => {
    setResolutions(prev => ({
      ...prev,
      [id]: choice
    }));
  };

  // Bulk conflict resolution actions
  const handleBulkConflictResolution = (choice) => {
    if (!plan || !plan.conflicts) return;
    const next = { ...resolutions };
    for (const conf of plan.conflicts) {
      const id = String(conf.incomingTxn.id || conf.incomingTxn.ID || conf.incomingTxn._id);
      next[id] = choice;
    }
    setResolutions(next);
  };

  // Confirm and execute sync plan
  const handleConfirmImport = async () => {
    if (!plan || isExecuting) return;
    setIsExecuting(true);

    try {
      // 1. Auto-register missing accounts / categories if enabled
      if (autoCreateRefs && plan.missingReferences) {
        const { accounts: missingAccts, categories: missingCats, subAccounts: missingSubs } = plan.missingReferences;

        // Register Missing Accounts
        if (missingAccts && missingAccts.length > 0) {
          const currentAccts = [...accounts];
          const existingNames = new Set(currentAccts.map(a => (a.name || '').toLowerCase()));
          let modified = false;

          for (const acctName of missingAccts) {
            if (!existingNames.has(acctName.toLowerCase())) {
              currentAccts.push({
                id: uuid(),
                name: acctName,
                group: 'Bank Accounts',
                subAccounts: []
              });
              existingNames.add(acctName.toLowerCase());
              modified = true;
            }
          }

          // Register Missing SubAccounts
          if (missingSubs && missingSubs.length > 0) {
            for (const subItem of missingSubs) {
              const targetAcct = currentAccts.find(a => (a.name || '').toLowerCase() === (subItem.account || '').toLowerCase());
              if (targetAcct) {
                targetAcct.subAccounts = targetAcct.subAccounts || [];
                const hasSub = targetAcct.subAccounts.some(s => (typeof s === 'string' ? s : s.name).toLowerCase() === subItem.subAccount.toLowerCase());
                if (!hasSub) {
                  targetAcct.subAccounts.push({ id: uuid(), name: subItem.subAccount });
                  modified = true;
                }
              }
            }
          }

          if (modified) {
            await replaceAccounts(currentAccts);
          }
        }

        // Register Missing Categories
        if (missingCats && missingCats.length > 0) {
          const currentCats = Object.entries(categories || {}).map(([name, cat]) => ({
            id: cat.id || uuid(),
            name,
            type: cat.type || 'Expense',
            subcategories: (cat.subcategories || []).map(s => (typeof s === 'string' ? { id: uuid(), name: s } : s))
          }));
          const existingCatNames = new Set(currentCats.map(c => (c.name || '').toLowerCase()));
          let modifiedCats = false;

          for (const catName of missingCats) {
            if (!existingCatNames.has(catName.toLowerCase())) {
              currentCats.push({
                id: uuid(),
                name: catName,
                type: 'Expense',
                subcategories: []
              });
              existingCatNames.add(catName.toLowerCase());
              modifiedCats = true;
            }
          }

          if (modifiedCats) {
            await replaceCategories(currentCats);
          }
        }
      }

      // 2. Execute DB writes via existing transaction infrastructure
      const dbContext = {
        bulkImportFn: bulkImport,
        addTransactionFn: addTransaction,
        updateTransactionFn: updateTransaction
      };

      const result = await executeSyncPlan(plan, resolutions, dbContext);
      setExecutionResult(result);
      setStep('complete');

      // Refresh application context state
      await load();
      toast.success(`Synced ${result.insertedCount} added, ${result.updatedCount} replaced!`);
    } catch (err) {
      console.error('Sync execution failed:', err);
      toast.error(`Import execution failed: ${err.message}`);
    } finally {
      setIsExecuting(false);
    }
  };

  // Grouped items calculation for review
  const conflictItems = plan?.conflicts || [];
  const newItems = plan?.new || [];
  const existingItems = plan?.exactExisting || [];

  // Group linked companions (e.g. BUY + companion CHARGE or split legs)
  const groupedNewItems = useMemo(() => {
    if (!newItems.length) return [];
    
    const parents = [];
    const childMap = new Map(); // parentId -> [child items]
    const splitMap = new Map(); // split_group_id -> [items]

    for (const item of newItems) {
      const t = item.incomingTxn;
      const splitGrp = String(t.split_group_id || '');

      if (splitGrp.startsWith('inv_charge_')) {
        const parentId = splitGrp.replace('inv_charge_', '');
        if (!childMap.has(parentId)) childMap.set(parentId, []);
        childMap.get(parentId).push(item);
      } else if (splitGrp) {
        if (!splitMap.has(splitGrp)) splitMap.set(splitGrp, []);
        splitMap.get(splitGrp).push(item);
      } else {
        parents.push({ item, children: [] });
      }
    }

    // Attach children to parents
    for (const p of parents) {
      const pId = String(p.item.incomingTxn.id || p.item.incomingTxn.ID || p.item.incomingTxn._id);
      if (childMap.has(pId)) {
        p.children = childMap.get(pId);
        childMap.delete(pId);
      }
    }

    // Orphan charges or remaining split groups
    const remainingOrphans = [];
    for (const [parentId, children] of childMap.entries()) {
      children.forEach(c => remainingOrphans.push({ item: c, children: [], isOrphanCharge: true }));
    }

    const splitGroups = [];
    for (const [groupId, items] of splitMap.entries()) {
      splitGroups.push({ isSplitGroup: true, groupId, items });
    }

    return [...parents, ...remainingOrphans, ...splitGroups];
  }, [newItems]);

  const toInsertCount = (plan?.new || []).length;
  const toReplaceCount = Object.values(resolutions).filter(r => r === RESOLUTION_ACTIONS.REPLACE_WITH_INCOMING).length;
  const toSkipCount = (plan?.exactExisting || []).length + Object.values(resolutions).filter(r => r === RESOLUTION_ACTIONS.KEEP_EXISTING).length;

  if (!isOpen) return null;

  return (
    <div className="sync-modal-overlay" onClick={onClose}>
      <div className="sync-modal-dialog" onClick={e => e.stopPropagation()}>
        
        {/* Modal Header */}
        <div className="sync-modal-header">
          <div className="sync-modal-title-wrap">
            <span className="sync-modal-icon">🔄</span>
            <div>
              <div className="sync-modal-title">
                {step === 'input' && 'Paste Transactions'}
                {step === 'review' && 'Review & Resolve Sync'}
                {step === 'complete' && 'Sync Complete'}
              </div>
              <div className="sync-modal-subtitle">
                {step === 'input' && 'Import portable transaction payloads across FinMan environments'}
                {step === 'review' && `${plan?.summary?.total || 0} transaction${plan?.summary?.total > 1 ? 's' : ''} parsed · Inspect before writing`}
                {step === 'complete' && 'Database updated cleanly with zero duplicates'}
              </div>
            </div>
          </div>
          <button className="sync-close-btn" onClick={onClose} title="Close Modal">✕</button>
        </div>

        {/* Modal Body */}
        <div className="sync-modal-body">
          
          {/* STEP 1: Paste Input */}
          {step === 'input' && (
            <div className="sync-step-input">
              <div className="sync-clipboard-banner">
                <button className="btn btn-secondary sync-clip-btn" onClick={handlePasteFromClipboard}>
                  📋 Paste from Clipboard
                </button>
                <span className="sync-clip-hint">Or paste exported FinMan JSON directly below:</span>
              </div>

              <textarea
                className="sync-textarea"
                value={rawText}
                onChange={e => { setRawText(e.target.value); setParseError(null); }}
                placeholder='{\n  "format": "finman-transactions",\n  "version": 1,\n  "count": 3,\n  "transactions": [ ... ]\n}'
                rows={10}
                autoFocus
              />

              {parseError && (
                <div className="sync-error-banner">
                  <span className="sync-error-icon">⚠️</span>
                  <div className="sync-error-content">
                    <div className="sync-error-title">Unable to Process Payload ({parseError.code})</div>
                    <div className="sync-error-msg">{parseError.message}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 2: Review & Planning */}
          {step === 'review' && plan && (
            <div className="sync-step-review">
              
              {/* KPI Badges */}
              <div className="sync-kpi-bar">
                <button
                  className={`sync-kpi-chip chip-new ${activeFilter === 'new' ? 'active' : ''}`}
                  onClick={() => setActiveFilter('new')}
                >
                  <span className="kpi-num">{plan.summary.newCount}</span>
                  <span className="kpi-label">New</span>
                </button>

                <button
                  className={`sync-kpi-chip chip-conflict ${activeFilter === 'conflicts' ? 'active' : ''}`}
                  onClick={() => setActiveFilter('conflicts')}
                >
                  <span className="kpi-num">{plan.summary.conflictCount}</span>
                  <span className="kpi-label">Conflicts</span>
                </button>

                <button
                  className={`sync-kpi-chip chip-existing ${activeFilter === 'existing' ? 'active' : ''}`}
                  onClick={() => setActiveFilter('existing')}
                >
                  <span className="kpi-num">{plan.summary.exactExistingCount}</span>
                  <span className="kpi-label">Already Existing</span>
                </button>

                <button
                  className={`sync-kpi-chip chip-all ${activeFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setActiveFilter('all')}
                >
                  <span className="kpi-num">{plan.summary.total}</span>
                  <span className="kpi-label">Total</span>
                </button>
              </div>

              {/* Missing References Card */}
              {(plan.missingReferences.accounts.length > 0 || plan.missingReferences.categories.length > 0 || plan.missingReferences.subAccounts.length > 0) && (
                <div className="sync-missing-refs-card">
                  <div className="missing-refs-hdr">
                    <span>⚠️ Detected New References</span>
                    <label className="sync-checkbox-label">
                      <input
                        type="checkbox"
                        checked={autoCreateRefs}
                        onChange={e => setAutoCreateRefs(e.target.checked)}
                      />
                      Auto-create missing metadata on import
                    </label>
                  </div>
                  <div className="missing-refs-list">
                    {plan.missingReferences.accounts.length > 0 && (
                      <div className="missing-ref-tag">
                        <strong>Accounts:</strong> {plan.missingReferences.accounts.join(', ')}
                      </div>
                    )}
                    {plan.missingReferences.categories.length > 0 && (
                      <div className="missing-ref-tag">
                        <strong>Categories:</strong> {plan.missingReferences.categories.join(', ')}
                      </div>
                    )}
                    {plan.missingReferences.subAccounts.length > 0 && (
                      <div className="missing-ref-tag">
                        <strong>SubAccounts:</strong> {plan.missingReferences.subAccounts.map(s => `${s.account} › ${s.subAccount}`).join(', ')}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Content Sections */}
              <div className="sync-review-scroll">
                
                {/* 1. Conflicts Section */}
                {(activeFilter === 'all' || activeFilter === 'conflicts') && conflictItems.length > 0 && (
                  <div className="sync-section">
                    <div className="sync-section-hdr">
                      <div className="section-title text-conflict">
                        <span>⚡ Conflicts ({conflictItems.length})</span>
                      </div>
                      <div className="conflict-bulk-actions">
                        <button
                          className="btn-tiny"
                          onClick={() => handleBulkConflictResolution(RESOLUTION_ACTIONS.KEEP_EXISTING)}
                        >
                          Keep All Existing
                        </button>
                        <button
                          className="btn-tiny btn-tiny-accent"
                          onClick={() => handleBulkConflictResolution(RESOLUTION_ACTIONS.REPLACE_WITH_INCOMING)}
                        >
                          Replace All Incoming
                        </button>
                      </div>
                    </div>

                    <div className="sync-items-list">
                      {conflictItems.map(conf => {
                        const id = String(conf.incomingTxn.id || conf.incomingTxn.ID || conf.incomingTxn._id);
                        const curRes = resolutions[id] || RESOLUTION_ACTIONS.KEEP_EXISTING;

                        return (
                          <div key={id} className="sync-card sync-conflict-card">
                            <div className="conflict-card-top">
                              <span className="badge badge-conflict">Conflict</span>
                              <span className="conflict-id">ID: {id}</span>
                              <span className="conflict-date">{formatDate(conf.incomingTxn.Date)}</span>
                            </div>

                            {/* Side-by-side comparison */}
                            <div className="conflict-comparison-grid">
                              <div className={`conflict-side ${curRes === RESOLUTION_ACTIONS.KEEP_EXISTING ? 'side-selected' : ''}`}>
                                <div className="side-hdr">
                                  <span>Current Destination Record</span>
                                  {curRes === RESOLUTION_ACTIONS.KEEP_EXISTING && <span className="side-tag">Retained</span>}
                                </div>
                                <div className="side-content">
                                  <div className="side-row">
                                    <span className="side-lbl">Amount:</span>
                                    <span className="side-val">₹{conf.existingTxn.INR || conf.existingTxn.Amount}</span>
                                  </div>
                                  <div className="side-row">
                                    <span className="side-lbl">Account:</span>
                                    <span className="side-val">{conf.existingTxn.Account || '—'}</span>
                                  </div>
                                  <div className="side-row">
                                    <span className="side-lbl">Category:</span>
                                    <span className="side-val">{conf.existingTxn.Category || '—'}</span>
                                  </div>
                                  <div className="side-row">
                                    <span className="side-lbl">Note:</span>
                                    <span className="side-val">{conf.existingTxn.Note || '—'}</span>
                                  </div>
                                </div>
                              </div>

                              <div className={`conflict-side ${curRes === RESOLUTION_ACTIONS.REPLACE_WITH_INCOMING ? 'side-selected' : ''}`}>
                                <div className="side-hdr">
                                  <span>Incoming Payload Record</span>
                                  {curRes === RESOLUTION_ACTIONS.REPLACE_WITH_INCOMING && <span className="side-tag tag-replace">Will Overwrite</span>}
                                </div>
                                <div className="side-content">
                                  <div className="side-row">
                                    <span className="side-lbl">Amount:</span>
                                    <span className="side-val text-accent">₹{conf.incomingTxn.INR || conf.incomingTxn.Amount}</span>
                                  </div>
                                  <div className="side-row">
                                    <span className="side-lbl">Account:</span>
                                    <span className="side-val">{conf.incomingTxn.Account || '—'}</span>
                                  </div>
                                  <div className="side-row">
                                    <span className="side-lbl">Category:</span>
                                    <span className="side-val">{conf.incomingTxn.Category || '—'}</span>
                                  </div>
                                  <div className="side-row">
                                    <span className="side-lbl">Note:</span>
                                    <span className="side-val">{conf.incomingTxn.Note || '—'}</span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Itemized Field Diffs */}
                            <div className="conflict-diff-tags">
                              <span className="diff-title">Changed Fields:</span>
                              {conf.diffFields.map((df, di) => (
                                <span key={di} className="diff-pill">
                                  {df.field}: <em>{String(df.existing)}</em> → <strong>{String(df.incoming)}</strong>
                                </span>
                              ))}
                            </div>

                            {/* Resolution Switcher */}
                            <div className="conflict-resolution-bar">
                              <button
                                className={`btn-choice ${curRes === RESOLUTION_ACTIONS.KEEP_EXISTING ? 'active' : ''}`}
                                onClick={() => handleResolutionChange(id, RESOLUTION_ACTIONS.KEEP_EXISTING)}
                              >
                                Keep Existing
                              </button>
                              <button
                                className={`btn-choice choice-replace ${curRes === RESOLUTION_ACTIONS.REPLACE_WITH_INCOMING ? 'active' : ''}`}
                                onClick={() => handleResolutionChange(id, RESOLUTION_ACTIONS.REPLACE_WITH_INCOMING)}
                              >
                                Replace with Incoming
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 2. New Transactions Section */}
                {(activeFilter === 'all' || activeFilter === 'new') && groupedNewItems.length > 0 && (
                  <div className="sync-section">
                    <div className="sync-section-hdr">
                      <div className="section-title text-new">
                        <span>✨ New Transactions ({newItems.length})</span>
                      </div>
                    </div>

                    <div className="sync-items-list">
                      {groupedNewItems.map((group, gi) => {
                        if (group.isSplitGroup) {
                          return (
                            <div key={`split-${gi}`} className="sync-split-group-card">
                              <div className="split-group-hdr">
                                <span>🛍️ Linked Split Group ({group.items.length} items)</span>
                              </div>
                              <div className="split-group-items">
                                {group.items.map((it, ii) => (
                                  <TransactionRowCard key={ii} txn={it.incomingTxn} isNew />
                                ))}
                              </div>
                            </div>
                          );
                        }

                        const { item, children, isOrphanCharge } = group;
                        const t = item.incomingTxn;

                        return (
                          <div key={t.id || t.ID || gi} className="sync-card sync-new-card">
                            <TransactionRowCard txn={t} isNew isOrphanCharge={isOrphanCharge} />
                            
                            {/* Nested Linked Charges */}
                            {children && children.length > 0 && (
                              <div className="sync-linked-children">
                                {children.map((ch, ci) => (
                                  <div key={ci} className="sync-linked-child-row">
                                    <span className="linked-tree-icon">└── ⚡ Linked Charge:</span>
                                    <TransactionRowCard txn={ch.incomingTxn} isLinkedCharge isNew />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 3. Already Existing Section */}
                {(activeFilter === 'all' || activeFilter === 'existing') && existingItems.length > 0 && (
                  <div className="sync-section">
                    <div className="sync-section-hdr">
                      <div className="section-title text-muted">
                        <span>Already In Database ({existingItems.length} — Skipped)</span>
                      </div>
                    </div>

                    <div className="sync-items-list sync-existing-list">
                      {existingItems.map((ex, ei) => (
                        <div key={ei} className="sync-card sync-existing-card">
                          <TransactionRowCard txn={ex.incomingTxn} isExisting />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 3: Complete Screen */}
          {step === 'complete' && executionResult && (
            <div className="sync-step-complete">
              <div className="complete-icon">🎉</div>
              <div className="complete-title">Transaction Sync Complete</div>
              <div className="complete-desc">
                Your destination database has been updated cleanly.
              </div>

              <div className="complete-summary-grid">
                <div className="summary-stat-box stat-added">
                  <div className="stat-val">+{executionResult.insertedCount}</div>
                  <div className="stat-lbl">Added</div>
                </div>
                <div className="summary-stat-box stat-replaced">
                  <div className="stat-val">{executionResult.updatedCount}</div>
                  <div className="stat-lbl">Replaced</div>
                </div>
                <div className="summary-stat-box stat-skipped">
                  <div className="stat-val">{executionResult.skippedCount}</div>
                  <div className="stat-lbl">Skipped</div>
                </div>
              </div>

              <div className="complete-safety-banner">
                <span>🛡️ All original IDs, investment relationships, charges, and cost basis invariants preserved.</span>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="sync-modal-footer">
          {step === 'input' && (
            <>
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!rawText.trim()}
                onClick={() => handleParseText(rawText)}
              >
                Review Transactions →
              </button>
            </>
          )}

          {step === 'review' && (
            <>
              <div className="sync-footer-summary">
                Ready to import: <strong>{toInsertCount} New</strong> + <strong>{toReplaceCount} Replacements</strong> ({toSkipCount} Skipped)
              </div>
              <div className="sync-footer-actions">
                <button className="btn btn-ghost" onClick={() => setStep('input')} disabled={isExecuting}>
                  ← Back
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleConfirmImport}
                  disabled={isExecuting || (toInsertCount === 0 && toReplaceCount === 0)}
                >
                  {isExecuting ? 'Importing...' : `Import ${toInsertCount + toReplaceCount} Transactions`}
                </button>
              </div>
            </>
          )}

          {step === 'complete' && (
            <button className="btn btn-primary btn-full" onClick={onClose}>
              Done
            </button>
          )}
        </div>

      </div>
    </div>
  );
}

// Sub-component: Clean transaction display card
function TransactionRowCard({ txn, isNew, isExisting, isLinkedCharge, isOrphanCharge }) {
  const isInv = !!(txn.InvestmentTransactionType || txn.Brokerage);
  const invType = txn.InvestmentTransactionType;
  const isXfer = String(txn['Income/Expense'] || txn.type || '').toLowerCase().startsWith('transfer');
  const inr = parseFloat(txn.INR || txn.Amount || txn.inr || txn.amount || 0);

  return (
    <div className={`txn-sync-row ${isLinkedCharge ? 'txn-sync-linked' : ''} ${isExisting ? 'txn-sync-existing' : ''}`}>
      <div className="sync-row-left">
        <div className="sync-row-primary">
          <span className="sync-row-date">{formatDate(txn.Date)}</span>
          {txn.Time && <span className="sync-row-time">{formatTime(txn.Time)}</span>}
          <span className="sync-row-acct">{txn.Account || txn.FromAccount || '—'}</span>
          {isXfer && txn.ToAccount && <span className="sync-row-to">→ {txn.ToAccount}</span>}
          <span className="sync-row-cat">{txn.Category || '—'}</span>
          {txn.SubAccount && <span className="sync-row-subacct">[{txn.SubAccount}]</span>}
        </div>

        <div className="sync-row-note">
          {txn.Note || txn.Description || (isInv ? `${txn.InvestmentTransactionType} ${txn.SecuritySymbol || ''}` : '—')}
          {isInv && (
            <span className="sync-inv-tags">
              {invType && <span className={`tag-inv-type tag-inv-${invType.toLowerCase()}`}>{invType}</span>}
              {txn.SecuritySymbol && <span className="tag-inv-symbol">{txn.SecuritySymbol}</span>}
              {txn.Quantity && <span className="tag-inv-qty">{txn.Quantity} units</span>}
              {txn.UnitPrice && <span className="tag-inv-price">@ ₹{txn.UnitPrice}</span>}
            </span>
          )}
        </div>
      </div>

      <div className="sync-row-right">
        <span className={`sync-row-amount ${isInv && invType === 'BUY' ? 'amt-buy' : (isXfer ? 'amt-xfer' : (inr >= 0 ? 'amt-inc' : 'amt-exp'))}`}>
          {inr < 0 ? '−' : (isXfer ? '' : (inr > 0 ? '+' : ''))}{formatINR(Math.abs(inr))}
        </span>
        {isExisting && <span className="status-pill status-skipped">Skip</span>}
        {isNew && <span className="status-pill status-new">New</span>}
      </div>
    </div>
  );
}
