import React, { createContext, useContext, useReducer, useEffect, useRef, useCallback } from 'react';
import {
  getAllRecurringRules, saveRecurringRule, updateRecurringRule, deleteRecurringRule,
  getActiveRecurringRules, buildInstalmentSchedule, computeNextRepeatDate,
  buildInstalmentNote, parseInstalmentInfo,
} from '../database/recurring.js';
import {
  getTransactions, addTransaction as dbAdd, updateTransaction as dbUpdate,
  deleteTransaction as dbDelete, deleteAllTransactions, bulkImport,
  getTransactionCount, analyseImport,
  getAllSettings, setSetting,
  getAccounts, replaceAccounts,
  getAccountGroups, replaceAccountGroups,
  getAccountMapping, replaceAccountMapping,
  getCategories, replaceCategories,
  getBudgets, setBudget, deleteBudget, replaceBudgets,
  getDB,
} from '../database/index.js';
import { DEFAULT_ACCOUNT_GROUPS, DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } from '../database/defaults.js';
import { v4 as uuid } from 'uuid';
import { parseDate } from '../utils/format.js';

const Ctx = createContext(null);
export const useApp = () => { const c = useContext(Ctx); if (!c) throw new Error('useApp outside AppProvider'); return c; };

// ── Helpers ───────────────────────────────────────────────────────────────────
const sortTransactions = (txns) => {
  return [...txns].sort((a, b) => {
    const da = parseDate(a.Date).getTime();
    const db = parseDate(b.Date).getTime();
    if (da !== db) return db - da;

    const ta = a.Time || '00:00';
    const tb = b.Time || '00:00';
    if (ta !== tb) return tb.localeCompare(ta);

    const ca = a.created_at || '';
    const cb = b.created_at || '';
    return cb.localeCompare(ca);
  });
};

// Categories in state: { CatName: { type:'Expense'|'Income', subcategories:['sub1',...] } }
const catsArrToObj = (arr) => {
  const o = {};
  for (const c of (arr || [])) {
    o[c.name] = { type: c.type || 'Expense', subcategories: (c.subcategories || []).map(s => s.name || s) };
  }
  return o;
};
const catsObjToArr = (obj) => {
  if (Array.isArray(obj)) return obj;
  return Object.entries(obj || {}).map(([name, d], i) => ({
    name,
    type: d.type || 'Expense',
    sortOrder: d.sortOrder !== undefined ? d.sortOrder : i,
    subcategories: Array.from(d.subcategories || d.subs || []).map((s, si) =>
      typeof s === 'string' ? { name: s, sortOrder: si } : { name: s.name || '', sortOrder: s.sortOrder !== undefined ? s.sortOrder : si }
    ),
  }));
};

const normalizeAccounts = (raw) =>
  (raw || []).map(a => typeof a === 'string'
    ? { id: uuid(), name: a, group: '', icon: '💳', acctType: '', settlementDate: 0, paymentDueDays: 0, isAsset: true, cardLast4: '', subAccounts: [] }
    : { id: a.id || uuid(),
        name: a.name || '', group: a.group || a.group_name || '', icon: '💳',
        acctType: a.acctType || a.acct_type || '',
        settlementDate: (a.settlementDate !== undefined ? Number(a.settlementDate) : (a.settlement_date !== undefined ? Number(a.settlement_date) : 0)) || 0,
        paymentDueDays: (a.paymentDueDays !== undefined ? Number(a.paymentDueDays) : (a.payment_due_days !== undefined ? Number(a.payment_due_days) : 0)) || 0,
        isAsset: a.isAsset !== undefined ? a.isAsset : (a.is_asset !== undefined ? Number(a.is_asset) === 1 : true),
        cardLast4: a.cardLast4 || a.card_last4 || '',
        subAccounts: a.subAccounts || [] });

// ── Reducer ───────────────────────────────────────────────────────────────────
const INIT = {
  transactions: [], accounts: [], categories: {},
  accountGroups: [], budgets: [], settings: {},
  theme: 'dark', fontSize: 1.0, fontFamily: 'Sora', fontDataWeight: 'regular',
  recurringRules: [],
  loading: true, error: null, importProgress: null,
  currentView: 'dashboard',
  brokerages: [],
};

function reducer(s, a) {
  switch (a.type) {
    case 'INIT':         return { ...s, ...a.payload, transactions: sortTransactions(a.payload.transactions), loading: false };
    case 'ADD_TXN':      return { ...s, transactions: sortTransactions([a.payload, ...s.transactions]) };
    case 'UPD_TXN':      return { ...s, transactions: sortTransactions(s.transactions.map(t => t._id === a.payload._id ? a.payload : t)) };
    case 'DEL_TXN':      return { ...s, transactions: s.transactions.filter(t => t._id !== a.payload) };
    case 'SET_BUDGETS':  return { ...s, budgets: a.payload };
    case 'SET_IMPORT':   return { ...s, importProgress: a.payload };
    case 'SET_THEME':    return { ...s, theme: a.payload };
    case 'SET_FONTSIZE': return { ...s, fontSize: a.payload };
    case 'SET_FONTFAMILY':     return { ...s, fontFamily: a.payload };
    case 'SET_FONTDATAWEIGHT':   return { ...s, fontDataWeight: a.payload };
    case 'SET_RECURRING':        return { ...s, recurringRules: a.payload };
    case 'UPD_SETTINGS': return { ...s, settings: { ...s.settings, ...a.payload } };
    case 'NAVIGATE': 
      return { 
        ...s, 
        currentView: typeof a.payload === 'object' ? a.payload.view : a.payload,
        viewParams: typeof a.payload === 'object' ? a.payload.params : null
      };
    case 'CLEAR_NAV_PARAMS':
      return { ...s, viewParams: null };
    default: return s;
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────
export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, INIT);
  const cancelRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [txns, accts, catsArr, aGroups, aMapping, budgets, settings, recurringRules] = await Promise.all([
        getTransactions(), getAccounts(), getCategories(),
        getAccountGroups(), getAccountMapping(), getBudgets(), getAllSettings(),
        getAllRecurringRules(),
      ]);

      let brokerages = [];
      try {
        const db = getDB();
        const bRes = await db.query('SELECT * FROM brokerages', []);
        brokerages = bRes.values || [];
      } catch (err) {
        console.warn('Failed to load brokerages:', err);
      }

      // Seed defaults on fresh install or when accounts/categories are empty
      if (accts.length === 0 || catsArr.length === 0) {
        if (accts.length === 0) {
          await replaceAccountGroups(DEFAULT_ACCOUNT_GROUPS);
          await replaceAccounts(DEFAULT_ACCOUNTS.map((a,i) => ({ id: uuid(), ...a, sortOrder: i })));
        }
        if (catsArr.length === 0) {
          await replaceCategories(DEFAULT_CATEGORIES.map((c,i) => ({
            id: uuid(), name: c.name, type: c.type, sortOrder: i,
            subcategories: c.subcategories.map((s,si) => ({ id: uuid(), name: s, sortOrder: si })),
          })));
        }
        await setSetting('sub_accounts_migrated_v2', 'true');
        const [seedAccts, seedCats, seedGroups] = await Promise.all([getAccounts(), getCategories(), getAccountGroups()]);
        const theme     = settings.theme     || 'dark';
        const fontSize  = parseFloat(settings.fontSize  || '1.0');
        const fontFamily = settings.fontFamily || 'Sora';
        const fontDataWeight = settings.fontDataWeight || 'regular';
        const fwMap = { light: '400', regular: '500', bold: '700' };
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.style.setProperty('--fs-scale', String(fontSize));
        document.documentElement.style.setProperty('--fw-data', fwMap[fontDataWeight] || '400');
        document.documentElement.style.setProperty('--font', fontFamily === 'Sora' ? "'Sora', sans-serif" : 
          fontFamily === 'Inter' ? "'Inter', sans-serif" :
          fontFamily === 'Roboto' ? "'Roboto', sans-serif" :
          fontFamily === 'Open Sans' ? "'Open Sans', sans-serif" :
          fontFamily === 'Lato' ? "'Lato', sans-serif" : "'Sora', sans-serif");
        dispatch({ type: 'INIT', payload: {
          transactions: txns,
          accounts: normalizeAccounts(seedAccts),
          categories: catsArrToObj(seedCats),
          categoriesArr: seedCats || [],
          accountGroups: seedGroups || [],
          accountMapping: aMapping || [],
          budgets, settings, theme, fontSize, fontFamily, fontDataWeight,
          recurringRules: recurringRules || [],
          brokerages: brokerages || [],
        }});
        return;
      }

      // One-time migration for sub-accounts v2
      // Reset migration if accounts exist but sub-accounts are empty (self-healing fallback)
      let needsSelfHealing = false;
      const sm = accts.find(a => (a.name || '').toLowerCase() === 'share market');
      const lmf = accts.find(a => (a.name || '').toLowerCase() === 'liquid mutual funds');
      const amzn = accts.find(a => (a.name || '').toLowerCase() === 'amazon');
      if (
        (sm && (!sm.subAccounts || sm.subAccounts.length === 0)) ||
        (lmf && (!lmf.subAccounts || lmf.subAccounts.length === 0)) ||
        (amzn && (!amzn.subAccounts || amzn.subAccounts.length === 0))
      ) {
        console.log('Detected empty sub-accounts on main parent accounts, forcing self-healing migration...');
        needsSelfHealing = true;
      }

      if (settings.sub_accounts_migrated_v2 !== 'true' || needsSelfHealing) {
        console.log('Running database migration for sub-accounts v2...');
        
        // 1. Migrate accounts configuration
        const nextAccts = accts.filter(a => !['zerodha', 'groww', 'fareeda groww', 'ammi groww'].includes((a.name || '').toLowerCase()));
        let lmfAcct = nextAccts.find(a => (a.name || '').toLowerCase() === 'liquid mutual funds');
        if (lmfAcct) {
          if (!lmfAcct.subAccounts || lmfAcct.subAccounts.length === 0) {
            lmfAcct.subAccounts = [ { id: uuid(), name: 'Groww' } ];
          }
        } else {
          nextAccts.push({ id: uuid(), name: 'Liquid Mutual Funds', group: 'Investments', subAccounts: [ { id: uuid(), name: 'Groww' } ] });
        }
        
        let smAcct = nextAccts.find(a => (a.name || '').toLowerCase() === 'share market');
        if (smAcct) {
          if (!smAcct.subAccounts || smAcct.subAccounts.length === 0) {
            smAcct.subAccounts = [ { id: uuid(), name: 'Zerodha' }, { id: uuid(), name: 'Groww' } ];
          }
        } else {
          nextAccts.push({ id: uuid(), name: 'Share Market', group: 'Investments', subAccounts: [ { id: uuid(), name: 'Zerodha' }, { id: uuid(), name: 'Groww' } ] });
        }
        
        let amazonAcct = nextAccts.find(a => (a.name || '').toLowerCase() === 'amazon');
        if (amazonAcct) {
          if (!amazonAcct.subAccounts) amazonAcct.subAccounts = [];
          if (!amazonAcct.subAccounts.some(s => s.name.toLowerCase() === 'my amazon')) {
            amazonAcct.subAccounts.push({ id: uuid(), name: 'My Amazon' });
          }
        } else {
          nextAccts.push({
            id: uuid(),
            name: 'Amazon',
            group: 'Digital Wallets',
            subAccounts: [
              { id: uuid(), name: 'My Amazon' }
            ]
          });
        }
        await replaceAccounts(nextAccts);

        // 2. Map and identify transactions to migrate
        const changedTxns = [];
        for (const t of txns) {
          let changed = false;
          let acct = t.Account || '';
          let fromAcct = t.FromAccount || '';
          let toAcct = t.ToAccount || '';
          let sub = t.SubAccount || '';
          let fromSub = t.FromSubAccount || '';
          let toSub = t.ToSubAccount || '';

          // Force correct Amazon sub-accounts for reconciliation transfers
          if (t.Note === 'Reconciliation adjustment' && (acct === 'Amazon' || fromAcct === 'Amazon' || toAcct === 'Amazon')) {
            const match = (t.Description || '').match(/Reconcile\s+([\w\s]+?)\s+balance/i);
            if (match) {
              const targetSub = match[1].trim();
              let resolvedFrom = '';
              let resolvedTo = '';
              const toSubAccounts = new Set([
                'amzad amazon', 'arshad amazon', 'aslam amazon', 
                'mami amazon', 'mamu amazon', 'haseena amazon', 'khaleel amazon'
              ]);
              if (toSubAccounts.has(targetSub.toLowerCase())) {
                resolvedFrom = 'My Amazon';
                resolvedTo = targetSub;
              } else {
                resolvedFrom = targetSub;
                resolvedTo = 'My Amazon';
              }
              if (sub !== '' || fromSub !== resolvedFrom || toSub !== resolvedTo) {
                sub = '';
                fromSub = resolvedFrom;
                toSub = resolvedTo;
                changed = true;
              }
            }
          }

          const isShareMarketTransfer = t.Note === 'FnO Investment' || 
                                      t.Note === 'Share Market Investment' ||
                                      String(t.Description || '').toLowerCase().includes('equity investment') || 
                                      String(t.Description || '').toLowerCase().includes('fno investment');


          if (t.Note !== 'Reconciliation adjustment') {
            // Account
            if (acct === 'Zerodha') {
              acct = 'Share Market'; sub = 'Zerodha'; changed = true;
            } else if (acct === 'Ammi Groww') {
              acct = 'Liquid Mutual Funds'; sub = 'Ammi Groww'; changed = true;
            } else if (acct === 'Fareeda Groww') {
              if (isShareMarketTransfer) {
                acct = 'Share Market'; sub = 'Fareeda Groww';
              } else {
                acct = 'Liquid Mutual Funds'; sub = 'Fareeda Groww';
              }
              changed = true;
            } else if (acct === 'Amazon') {
              if (!sub) {
                const txt = ((t.Note || '') + ' ' + (t.Description || '')).toLowerCase();
                if (/\bfather\b/i.test(txt)) {
                  sub = 'Father Amazon';
                } else if (/\bfareeda\b/i.test(txt)) {
                  sub = 'Fareeda Amazon';
                } else if (/\bammi\b/i.test(txt)) {
                  sub = 'Ammi Amazon';
                } else if (/\bap\b/i.test(txt)) {
                  sub = 'AP Amazon';
                } else if (/\bamzad\b/i.test(txt)) {
                  sub = 'Amzad Amazon';
                } else if (/\bjanu\b/i.test(txt)) {
                  sub = 'Janu Amazon';
                } else if (/\bgulzar\b/i.test(txt)) {
                  sub = 'Gulzar Amazon';
                } else if (/\bfahim\b/i.test(txt)) {
                  sub = 'Fahim Amazon';
                } else {
                  sub = 'My Amazon';
                }
                changed = true;
              }
            }

            // FromAccount
            if (fromAcct === 'Zerodha') {
              fromAcct = 'Share Market'; fromSub = 'Zerodha'; changed = true;
            } else if (fromAcct === 'Ammi Groww') {
              fromAcct = 'Liquid Mutual Funds'; fromSub = 'Ammi Groww'; changed = true;
            } else if (fromAcct === 'Fareeda Groww') {
              if (isShareMarketTransfer) {
                fromAcct = 'Share Market'; fromSub = 'Fareeda Groww';
              } else {
                fromAcct = 'Liquid Mutual Funds'; fromSub = 'Fareeda Groww';
              }
              changed = true;
            } else if (fromAcct === 'Amazon') {
              if (!fromSub) {
                const txt = ((t.Note || '') + ' ' + (t.Description || '')).toLowerCase();
                if (/\bfather\b/i.test(txt)) {
                  fromSub = 'Father Amazon';
                } else if (/\bfareeda\b/i.test(txt)) {
                  fromSub = 'Fareeda Amazon';
                } else if (/\bammi\b/i.test(txt)) {
                  fromSub = 'Ammi Amazon';
                } else if (/\bap\b/i.test(txt)) {
                  fromSub = 'AP Amazon';
                } else if (/\bamzad\b/i.test(txt)) {
                  fromSub = 'Amzad Amazon';
                } else if (/\bjanu\b/i.test(txt)) {
                  fromSub = 'Janu Amazon';
                } else if (/\bgulzar\b/i.test(txt)) {
                  fromSub = 'Gulzar Amazon';
                } else if (/\bfahim\b/i.test(txt)) {
                  fromSub = 'Fahim Amazon';
                } else {
                  fromSub = 'My Amazon';
                }
                changed = true;
              }
            }

            // ToAccount
            if (toAcct === 'Zerodha') {
              toAcct = 'Share Market'; toSub = 'Zerodha'; changed = true;
            } else if (toAcct === 'Ammi Groww') {
              toAcct = 'Liquid Mutual Funds'; toSub = 'Ammi Groww'; changed = true;
            } else if (toAcct === 'Fareeda Groww') {
              if (isShareMarketTransfer) {
                toAcct = 'Share Market'; toSub = 'Fareeda Groww';
              } else {
                toAcct = 'Liquid Mutual Funds'; toSub = 'Fareeda Groww';
              }
              changed = true;
            } else if (toAcct === 'Amazon') {
              if (!toSub) {
                const txt = ((t.Note || '') + ' ' + (t.Description || '')).toLowerCase();
                if (/\bfather\b/i.test(txt)) {
                  toSub = 'Father Amazon';
                } else if (/\bfareeda\b/i.test(txt)) {
                  toSub = 'Fareeda Amazon';
                } else if (/\bammi\b/i.test(txt)) {
                  toSub = 'Ammi Amazon';
                } else if (/\bap\b/i.test(txt)) {
                  toSub = 'AP Amazon';
                } else if (/\bamzad\b/i.test(txt)) {
                  toSub = 'Amzad Amazon';
                } else if (/\bjanu\b/i.test(txt)) {
                  toSub = 'Janu Amazon';
                } else if (/\bgulzar\b/i.test(txt)) {
                  toSub = 'Gulzar Amazon';
                } else if (/\bfahim\b/i.test(txt)) {
                  toSub = 'Fahim Amazon';
                } else {
                  toSub = 'My Amazon';
                }
                changed = true;
              }
            }
          }


          if (changed) {
            const dbTxn = {
              id: t.id || t._id,
              date: t.Date || '',
              time: t.Time || '',
              account: acct,
              from_account: fromAcct,
              to_account: toAcct,
              category: t.Category || '',
              subcategory: t.Subcategory || '',
              note: t.Note || '',
              description: t.Description || '',
              inr: parseFloat(t.INR || t.Amount || 0),
              amount: String(t.Amount || t.INR || '0'),
              currency: t.Currency || 'INR',
              type: t['Income/Expense'] || 'Expense',
              created_at: t.created_at || new Date().toISOString(),
              updated_at: new Date().toISOString(),
              recurring_rule_id: t.recurring_rule_id || '',
              tags: t.Tags || t.tags || '',
              split_group_id: t.split_group_id || '',
              receipt_image: t.receipt_image || '',
              warranty_expiry: t.warranty_expiry || '',
              serial_no: t.serial_no || '',
              sub_account: sub,
              from_sub_account: fromSub,
              to_sub_account: toSub
            };
            changedTxns.push(dbTxn);
          }
        }

        // 3. Perform optimized batch update
        if (changedTxns.length > 0) {
          const { Capacitor } = await import('@capacitor/core');
          if (Capacitor.getPlatform() === 'web') {
            console.log(`IndexedDB batch migrating ${changedTxns.length} transactions...`);
            const openIDB = () => new Promise((res, rej) => {
              const req = indexedDB.open('finman_v2');
              req.onsuccess = e => res(e.target.result);
              req.onerror = e => rej(e.target.error);
            });
            const idb = await openIDB();
            const tx = idb.transaction('transactions', 'readwrite');
            const store = tx.objectStore('transactions');
            changedTxns.forEach(row => store.put(row));
            await new Promise((res, rej) => {
              tx.oncomplete = () => res();
              tx.onerror = () => rej(tx.error);
            });
          } else {
            console.log(`SQLite transaction migrating ${changedTxns.length} transactions...`);
            const sdb = getDB();
            await sdb.execute('BEGIN TRANSACTION;');
            for (const row of changedTxns) {
              await sdb.run(
                `UPDATE transactions SET account=?,from_account=?,to_account=?,sub_account=?,from_sub_account=?,to_sub_account=?,updated_at=? WHERE id=?`,
                [row.account, row.from_account, row.to_account, row.sub_account, row.from_sub_account, row.to_sub_account, row.updated_at, row.id]
              );
            }
            await sdb.execute('COMMIT;');
          }
        }

        await setSetting('sub_accounts_migrated_v2', 'true');
        // Trigger load again to refresh context state
        await load();
        return;
      }
      const theme     = settings.theme     || 'dark';
      const fontSize  = parseFloat(settings.fontSize  || '1.0');
      const fontFamily = settings.fontFamily || 'Sora';
      const fontDataWeight = settings.fontDataWeight || 'regular';
      const fwMap = { light: '400', regular: '500', bold: '700' };
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.style.setProperty('--fs-scale', String(fontSize));
      document.documentElement.style.setProperty('--fw-data', fwMap[fontDataWeight] || '400');
      document.documentElement.style.setProperty('--font', fontFamily === 'Sora' ? "'Sora', sans-serif" : 
        fontFamily === 'Inter' ? "'Inter', sans-serif" :
        fontFamily === 'Roboto' ? "'Roboto', sans-serif" :
        fontFamily === 'Open Sans' ? "'Open Sans', sans-serif" :
        fontFamily === 'Lato' ? "'Lato', sans-serif" : "'Sora', sans-serif");
      dispatch({
        type: 'INIT', payload: {
          transactions:  txns,
          accounts:      normalizeAccounts(accts),
          categories:    catsArrToObj(catsArr),
          categoriesArr: catsArr || [],
          accountGroups: aGroups || [],
          accountMapping: aMapping || [],
          budgets, settings, theme, fontSize, fontFamily, fontDataWeight,
          recurringRules: recurringRules || [],
          brokerages: brokerages || [],
        },
      });
    } catch (e) {
      console.error('AppContext load error:', e);
      dispatch({ type:'INIT', payload:{ transactions:[], accounts:[], categories:{}, accountGroups:[], budgets:[], settings:{}, theme:'dark', fontSize:1.0, fontFamily:'Sora', fontDataWeight:'regular', recurringRules:[], brokerages:[] } });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const navigate = (view, params = null) => dispatch({ type: 'NAVIGATE', payload: { view, params } });
  const clearNavParams = () => dispatch({ type: 'CLEAR_NAV_PARAMS' });

  const addTransaction    = async (data) => { const r = await dbAdd(data);    if (r) dispatch({ type:'ADD_TXN', payload:r }); return r; };
  const updateTransaction = async (id,d) => { const r = await dbUpdate(id,d); if (r) dispatch({ type:'UPD_TXN', payload:r }); return r; };
  const deleteTransaction = async (id)   => { await dbDelete(id); dispatch({ type:'DEL_TXN', payload:id }); };

  // ── Instalment bulk operations ─────────────────────────────────────────
  // Edit Note, Description, Tags, Category, Subcategory, Account, etc. across all instalments in series.
  // Individual Dates and Amounts are preserved per instalment!
  const updateInstalmentSiblings = async (ruleId, updatedTxn, originalTxn = null) => {
    // Fetch fresh transactions from DB
    const freshTxns = await getTransactions();
    const targetTxn = originalTxn || updatedTxn;
    if (!targetTxn) return;

    const currentId = updatedTxn?._id || updatedTxn?.ID || originalTxn?._id || originalTxn?.ID;
    const origInfo = parseInstalmentInfo(originalTxn?.Note) || parseInstalmentInfo(updatedTxn?.Note);
    const targetRuleId = ruleId || originalTxn?.recurring_rule_id || updatedTxn?.recurring_rule_id;
    const totalParts = origInfo ? origInfo.total : 1;
    const currentPart = origInfo ? origInfo.part : 1;
    const targetAmt = parseFloat(targetTxn.INR) || parseFloat(targetTxn.Amount) || 0;
    const targetDesc = (targetTxn.Description || '').trim().toLowerCase();
    const targetAcct = (targetTxn.Account || targetTxn.FromAccount || '').trim().toLowerCase();
    const targetCat = (targetTxn.Category || '').trim().toLowerCase();
    const targetBase = origInfo ? origInfo.base.toLowerCase() : '';

    let candidates = [];
    if (targetRuleId) {
      candidates = freshTxns.filter(t => t.recurring_rule_id === targetRuleId);
    }

    // If candidates from ruleId don't cover the full series, match by note pattern + description / account / amount
    if (candidates.length < totalParts && origInfo) {
      const noteCandidates = freshTxns.filter(t => {
        const info = parseInstalmentInfo(t.Note);
        if (!info || info.total !== totalParts) return false;

        // Check match by Description (if description is present and has text)
        if (targetDesc && targetDesc.length > 3) {
          const tDesc = (t.Description || '').trim().toLowerCase();
          if (tDesc === targetDesc) return true;
        }

        // Check match by base note + Category + Account + Amount similarity
        if (targetBase && info.base.toLowerCase() === targetBase) {
          if (targetCat && t.Category && t.Category.trim().toLowerCase() !== targetCat) return false;
          if (targetAcct && t.Account && (t.Account || t.FromAccount || '').trim().toLowerCase() !== targetAcct) return false;
          const tAmt = parseFloat(t.INR) || parseFloat(t.Amount) || 0;
          if (targetAmt > 0 && Math.abs(tAmt - targetAmt) > Math.max(15, targetAmt * 0.35)) return false;
          return true;
        }

        return false;
      });

      const candMap = new Map();
      candidates.forEach(c => candMap.set(c._id || c.ID || c.id, c));
      noteCandidates.forEach(c => candMap.set(c._id || c.ID || c.id, c));
      candidates = Array.from(candMap.values());
    }

    if (!candidates.length) candidates = [targetTxn];

    // Pick at most ONE best sibling per part number (1..totalParts)
    const targetDateObj = parseDate(targetTxn.Date);
    const bestSiblingsByPart = new Map();

    for (const c of candidates) {
      const cInfo = parseInstalmentInfo(c.Note);
      const p = cInfo ? cInfo.part : 1;
      if (p < 1 || p > totalParts) continue;

      const isSelf = (c._id && c._id === targetTxn._id) || (c.ID && c.ID === targetTxn.ID) || (currentId && (c._id === currentId || c.ID === currentId));
      if (isSelf) {
        bestSiblingsByPart.set(p, c);
        continue;
      }

      if (!bestSiblingsByPart.has(p)) {
        bestSiblingsByPart.set(p, c);
      } else {
        const expectedMonthDiff = p - currentPart;
        const expectedDate = new Date(targetDateObj.getFullYear(), targetDateObj.getMonth() + expectedMonthDiff, targetDateObj.getDate());
        const cDate = parseDate(c.Date);
        const existingDate = parseDate(bestSiblingsByPart.get(p).Date);
        const curDiff = Math.abs(existingDate.getTime() - expectedDate.getTime());
        const newDiff = Math.abs(cDate.getTime() - expectedDate.getTime());
        if (newDiff < curDiff) {
          bestSiblingsByPart.set(p, c);
        }
      }
    }

    bestSiblingsByPart.set(currentPart, targetTxn);
    const allTxns = Array.from(bestSiblingsByPart.values());
    if (!allTxns.length) return;

    // Determine the new base note (without instalment suffix)
    const newInfo = parseInstalmentInfo(updatedTxn?.Note);
    const newBaseNote = newInfo ? newInfo.base : (updatedTxn?.Note || '').replace(/[\(\[]\s*\d+\s*(?:\/|of)\s*\d+\s*[\)\]]\s*$/i, '').trim();

    // Fast parallel batch updates across all isolated siblings
    await Promise.all(allTxns.map(async sibling => {
      const sibId = sibling._id || sibling.ID || sibling.id;
      const isTheEditedItem = (currentId && sibId === currentId);

      const sibInfo = parseInstalmentInfo(sibling.Note);
      const partNum = sibInfo ? sibInfo.part : (origInfo ? origInfo.part : 1);
      const totalNum = sibInfo ? sibInfo.total : (origInfo ? origInfo.total : allTxns.length);
      const newNote = `${newBaseNote} (${partNum}/${totalNum})`;

      const updated = {
        ...sibling,
        Account:          updatedTxn.Account !== undefined ? updatedTxn.Account : sibling.Account,
        FromAccount:      updatedTxn.FromAccount !== undefined ? updatedTxn.FromAccount : (sibling.FromAccount || ''),
        ToAccount:        updatedTxn.ToAccount !== undefined ? updatedTxn.ToAccount : (sibling.ToAccount || ''),
        Category:         updatedTxn.Category !== undefined ? updatedTxn.Category : sibling.Category,
        Subcategory:      updatedTxn.Subcategory !== undefined ? updatedTxn.Subcategory : (sibling.Subcategory || 'Default'),
        Note:             newNote,
        Description:      updatedTxn.Description !== undefined ? updatedTxn.Description : (sibling.Description || ''),
        // Keep each sibling's own INR and Amount (only the edited item receives its new amount)
        INR:              isTheEditedItem && updatedTxn.INR !== undefined ? Number(updatedTxn.INR) : sibling.INR,
        Amount:           isTheEditedItem && updatedTxn.Amount !== undefined ? String(updatedTxn.Amount) : sibling.Amount,
        Currency:         updatedTxn.Currency || sibling.Currency || 'INR',
        'Income/Expense': updatedTxn['Income/Expense'] || sibling['Income/Expense'] || sibling.type || 'Expense',
        Tags:             updatedTxn.Tags !== undefined ? updatedTxn.Tags : (sibling.Tags || ''),
        receipt_image:    updatedTxn.receipt_image !== undefined ? updatedTxn.receipt_image : (sibling.receipt_image || ''),
        warranty_expiry:  updatedTxn.warranty_expiry !== undefined ? updatedTxn.warranty_expiry : (sibling.warranty_expiry || ''),
        serial_no:        updatedTxn.serial_no !== undefined ? updatedTxn.serial_no : (sibling.serial_no || ''),
        recurring_rule_id: targetRuleId || sibling.recurring_rule_id || '',
        // Date is preserved per instalment (only updated if edited item specifically changed date)
        Date:             isTheEditedItem && updatedTxn.Date ? updatedTxn.Date : sibling.Date,
        Time:             isTheEditedItem && updatedTxn.Time ? updatedTxn.Time : (sibling.Time || ''),
      };
      await dbUpdate(sibId, updated);
      return updated;
    }));

    if (targetRuleId) {
      const totalAmount = allTxns.reduce((sum, s) => {
        const sibId = s._id || s.ID || s.id;
        const isEdited = (currentId && sibId === currentId);
        const amt = isEdited ? (Number(updatedTxn.INR) || Number(updatedTxn.Amount) || 0) : (Number(s.INR) || 0);
        return sum + amt;
      }, 0);
      try {
        await updateRecurringRule(targetRuleId, {
          base_note:    newBaseNote,
          category:     updatedTxn.Category,
          subcategory:  updatedTxn.Subcategory || '',
          account:      updatedTxn.Account,
          total_amount: totalAmount,
        });
      } catch (err) {
        console.warn('updateRecurringRule error:', err);
      }
    }

    await load();
  };

  // Update amount on one instalment and adjust rule total_amount
  const updateInstalmentAmount = async (ruleId, oldAmount, newAmount) => {
    if (!ruleId) return;
    const rules = state.recurringRules || [];
    const rule = rules.find(r => r.id === ruleId);
    if (!rule) return;
    const diff = newAmount - oldAmount;
    await updateRecurringRule(ruleId, { total_amount: (rule.total_amount || 0) + diff });
  };

  // Delete all instalment transactions and cancel the rule
  const deleteAllInstalments = async (ruleId) => {
    if (!ruleId) return;
    const toDelete = state.transactions.filter(t => t.recurring_rule_id === ruleId);
    for (const t of toDelete) {
      await dbDelete(t._id);
      dispatch({ type:'DEL_TXN', payload:t._id });
    }
    await updateRecurringRule(ruleId, { status: 'cancelled' });
    const rules = await getAllRecurringRules();
    dispatch({ type:'SET_RECURRING', payload: rules });
  };

  const renameAccount = async (oldName, newName) => {
    for (const t of state.transactions.filter(t => t.Account===oldName||t.FromAccount===oldName||t.ToAccount===oldName))
      await dbUpdate(t._id, { ...t, Account:t.Account===oldName?newName:t.Account, FromAccount:t.FromAccount===oldName?newName:t.FromAccount, ToAccount:t.ToAccount===oldName?newName:t.ToAccount });
    await load();
  };

  const renameCategory = async (oldCat, newCat, oldSub=null, newSub=null) => {
    for (const t of state.transactions.filter(t => t.Category===oldCat && (oldSub===null||t.Subcategory===oldSub)))
      await dbUpdate(t._id, { ...t, Category:newCat, Subcategory:oldSub!==null?(t.Subcategory===oldSub?newSub:t.Subcategory):t.Subcategory });
    await load();
  };

  const deleteAccountTransactions = async (oldName, fallbackName = 'Ungrouped') => {
    for (const t of state.transactions.filter(t => t.Account===oldName||t.FromAccount===oldName||t.ToAccount===oldName)) {
      await dbUpdate(t._id, {
        ...t,
        Account: t.Account===oldName ? fallbackName : t.Account,
        FromAccount: t.FromAccount===oldName ? fallbackName : t.FromAccount,
        ToAccount: t.ToAccount===oldName ? fallbackName : t.ToAccount
      });
    }
  };

  const deleteCategoryTransactions = async (oldCat, fallbackCat = 'Unassigned') => {
    for (const t of state.transactions.filter(t => t.Category===oldCat)) {
      await dbUpdate(t._id, { ...t, Category: fallbackCat });
    }
  };

  const deleteSubcategoryTransactions = async (catName, oldSub) => {
    for (const t of state.transactions.filter(t => t.Category===catName && t.Subcategory===oldSub)) {
      await dbUpdate(t._id, { ...t, Subcategory: '' });
    }
  };

  const renameSubAccount = async (acctName, oldSubName, newSubName) => {
    for (const t of state.transactions.filter(t => t.Account === acctName && (t.SubAccount === oldSubName || t.FromSubAccount === oldSubName || t.ToSubAccount === oldSubName))) {
      await dbUpdate(t._id, {
        ...t,
        SubAccount: t.SubAccount === oldSubName ? newSubName : t.SubAccount,
        FromSubAccount: t.FromSubAccount === oldSubName ? newSubName : t.FromSubAccount,
        ToSubAccount: t.ToSubAccount === oldSubName ? newSubName : t.ToSubAccount
      });
    }
    await load();
  };

  const deleteSubAccountTransactions = async (acctName, oldSub) => {
    for (const t of state.transactions.filter(t => t.Account === acctName && (t.SubAccount === oldSub || t.FromSubAccount === oldSub || t.ToSubAccount === oldSub))) {
      await dbUpdate(t._id, {
        ...t,
        SubAccount: t.SubAccount === oldSub ? '' : t.SubAccount,
        FromSubAccount: t.FromSubAccount === oldSub ? '' : t.FromSubAccount,
        ToSubAccount: t.ToSubAccount === oldSub ? '' : t.ToSubAccount
      });
    }
    await load();
  };

  const importData = async (rows, mode = 'override', backupData = null) => {
    const isOverride = (mode === 'override');
    const dbCount = isOverride ? 0 : await getTransactionCount();
    const isFirstImport = dbCount === 0;
    cancelRef.current = false;
    const total = rows.length;
    dispatch({ type:'SET_IMPORT', payload:{ processed:0, total, startTime:Date.now() } });

    if (isOverride) {
      await deleteAllTransactions();
      await setSetting('sub_accounts_migrated_v2', 'false');
    }

    // 1. Full FinMan Backup (.finman or JSON backup)
    if (backupData) {
      if (isOverride) {
        // OVERRIDE: Replace all accounts, groups, mapping, categories, budgets, recurring rules exclusively from backup
        await replaceAccounts(normalizeAccounts(backupData.accounts || []));
        const rawGroups = backupData.accountGroups || backupData.account_groups || backupData.groups || [];
        await replaceAccountGroups(rawGroups.map((g, i) => typeof g === 'string' ? { id: uuid(), name: g, sort_order: i } : g));
        await replaceAccountMapping(backupData.accountMapping || []);
        await replaceCategories(catsObjToArr(backupData.categories || {}));
        await replaceBudgets(backupData.budgets || backupData.budget || []);

        const db = getDB();
        await db.run('DELETE FROM recurring_rules');
        const rules = backupData.recurringRules || backupData.recurring_rules || backupData.recurrings || [];
        for (const rule of rules) { await saveRecurringRule(rule); }

        // Restoring stock inventory table
        await db.run('DELETE FROM inventory');
        const inventory = backupData.inventory || [];
        for (const item of inventory) {
          await db.run(
            'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date, notes, updated_at, sub_qty, sub_unit, original_qty, pack_qty, discount_type, discount_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              item.id,
              item.name,
              parseFloat(item.qty) || 0,
              item.unit || '',
              parseFloat(item.price) || 0,
              parseFloat(item.discounted_price) || 0,
              item.status || 'available',
              item.purchased_date || '',
              item.notes || '',
              item.updated_at || new Date().toISOString(),
              parseFloat(item.sub_qty) || 1,
              item.sub_unit || '',
              parseFloat(item.original_qty) || parseFloat(item.qty) || 0,
              parseFloat(item.pack_qty) || 1,
              item.discount_type || 'percentage',
              parseFloat(item.discount_value) || 0
            ]
          );
        }

        const tagVal = backupData.customTags || backupData.savedTags || '';
        if (tagVal) await setSetting('customTags', String(tagVal));
      } else {
        // MERGE: Merge backup settings with existing ones
        await updateSettings({
          accounts: Array.isArray(backupData.accounts) ? backupData.accounts : undefined,
          accountGroups: Array.isArray(backupData.accountGroups) ? backupData.accountGroups : undefined,
          accountMapping: Array.isArray(backupData.accountMapping) ? backupData.accountMapping : undefined,
          categories: backupData.categories && typeof backupData.categories === 'object' ? backupData.categories : undefined,
          recurringRules: Array.isArray(backupData.recurringRules) ? backupData.recurringRules : undefined,
          budgets: Array.isArray(backupData.budgets) ? backupData.budgets : undefined,
          customTags: backupData.customTags || backupData.savedTags || undefined,
        });

        // Restore inventory table in Merge mode as well (clear and load backup active stock items)
        if (Array.isArray(backupData.inventory) && backupData.inventory.length > 0) {
          const db = getDB();
          await db.run('DELETE FROM inventory');
          for (const item of backupData.inventory) {
            await db.run(
              'INSERT INTO inventory (id, name, qty, unit, price, discounted_price, status, purchased_date, notes, updated_at, sub_qty, sub_unit, original_qty, pack_qty, discount_type, discount_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [
                item.id,
                item.name,
                parseFloat(item.qty) || 0,
                item.unit || '',
                parseFloat(item.price) || 0,
                parseFloat(item.discounted_price) || 0,
                item.status || 'available',
                item.purchased_date || '',
                item.notes || '',
                item.updated_at || new Date().toISOString(),
                parseFloat(item.sub_qty) || 1,
                item.sub_unit || '',
                parseFloat(item.original_qty) || parseFloat(item.qty) || 0,
                parseFloat(item.pack_qty) || 1,
                item.discount_type || 'percentage',
                parseFloat(item.discount_value) || 0
              ]
            );
          }
        }
      }

      // Import transactions in batches
      let imported = 0, skipped = 0;
      const BATCH = 500;
      for (let i = 0; i < total; i += BATCH) {
        if (cancelRef.current) {
          dispatch({ type:'SET_IMPORT', payload:null });
          await load();
          return { imported, skipped, cancelled:true };
        }
        const res = await bulkImport(rows.slice(i, i + BATCH), { firstImport: isFirstImport });
        imported += res.imported; skipped += res.skipped;
        dispatch({ type:'SET_IMPORT', payload:{ processed:Math.min(i+BATCH,total), total, startTime:Date.now() } });
        await new Promise(r => setTimeout(r, 0));
      }

      dispatch({ type:'SET_IMPORT', payload:null });
      await load();
      return { imported, skipped, cancelled:false };
    }

    // 2. Transactions-only file (CSV / XLS)
    // Extract accounts, groups, mapping, categories, and tags from CSV rows
    const acctMap = new Map();
    const catMap = {};
    const groupSet = new Set();
    const groupOrderMap = new Map();
    const tagSet = new Set();
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
    const looksLikeUUID = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const RESERVED_ACCT = new Set(['INR','USD','GBP','EUR','Transfer','Transfer-Out','Transfer-In']);
    const RESERVED_CAT  = new Set(['Transfer','Transfer-Out','Transfer-In','Income','Expense']);

    for (const r of rows) {
      const typeRaw = String(r['Income/Expense'] || r.type || '').trim();
      const isXfer  = typeRaw.toLowerCase().startsWith('transfer');
      const rawCat  = String(r.Category    || r.category    || '').trim();
      const rawTo   = String(r.ToAccount   || r.to_account  || '').trim();
      const rawSub  = String(r.Subcategory || r.subcategory || '').trim();
      const sub     = rawSub.toLowerCase() === 'default' ? '' : rawSub;
      const rawSubAcct = String(r.SubAccount || r.sub_account || '').trim();
      const rawFromSub = String(r.FromSubAccount || r.from_sub_account || '').trim();
      const rawToSub   = String(r.ToSubAccount || r.to_sub_account || '').trim();

      // Extract account info
      const rawAcct  = String(r.Account || r.account || '').trim();
      const realAcct = looksNumeric(rawAcct)
        ? String(r.FromAccount || r.from_account || '').trim() || rawAcct
        : rawAcct;

      const acctGroup = String(r.AccountGroup || r.account_group || r.Group || '').trim();
      const acctType = String(r.AccountType || r.account_type || '').trim();
      const cardLast4 = String(r.CardLast4 || r.card_last4 || r.AccountCardLast4 || '').trim();
      const settleRaw = r.SettlementDate ?? r.settlement_date ?? r.AccountSettlementDate ?? r.account_settlement_date;
      const settlementDate = (settleRaw !== undefined && settleRaw !== '') ? parseInt(settleRaw) : 0;
      const payDaysRaw = r.PaymentDueDays ?? r.payment_due_days ?? r.AccountPaymentDueDays ?? r.account_payment_due_days;
      const paymentDueDays = (payDaysRaw !== undefined && payDaysRaw !== '') ? parseInt(payDaysRaw) : 0;
      const isAsset = (acctType === 'credit_card' || ['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later', 'installments'].some(k => (acctGroup || acctType || realAcct).toLowerCase().includes(k))) ? false : true;
      const acctOrdRaw = r.AccountOrder ?? r.account_order ?? r.FromAccountOrder ?? r.from_account_order;
      const acctOrd = (acctOrdRaw !== undefined && acctOrdRaw !== '') ? parseInt(acctOrdRaw) : undefined;
      const grpOrdRaw = r.AccountGroupOrder ?? r.account_group_order;
      const grpOrd = (grpOrdRaw !== undefined && grpOrdRaw !== '') ? parseInt(grpOrdRaw) : undefined;

      if (realAcct && !RESERVED_ACCT.has(realAcct) && !looksNumeric(realAcct) && !looksLikeUUID(realAcct)) {
        if (!acctMap.has(realAcct)) {
          acctMap.set(realAcct, { name: realAcct, group: acctGroup, icon: '💳', acctType, cardLast4, settlementDate, paymentDueDays, isAsset, sortOrder: acctOrd, subAccounts: new Set() });
        } else {
          const existing = acctMap.get(realAcct);
          if (!existing.subAccounts) existing.subAccounts = new Set();
          if (acctGroup && !existing.group) existing.group = acctGroup;
          if (acctType && !existing.acctType) existing.acctType = acctType;
          if (cardLast4 && !existing.cardLast4) existing.cardLast4 = cardLast4;
          if (settlementDate && !existing.settlementDate) existing.settlementDate = settlementDate;
          if (paymentDueDays && !existing.paymentDueDays) existing.paymentDueDays = paymentDueDays;
          if (acctOrd !== undefined && existing.sortOrder === undefined) existing.sortOrder = acctOrd;
        }
        const sVal = rawSubAcct || rawFromSub;
        if (sVal) acctMap.get(realAcct).subAccounts.add(sVal);
        if (acctGroup) {
          groupSet.add(acctGroup);
          if (grpOrd !== undefined && !groupOrderMap.has(acctGroup)) {
            groupOrderMap.set(acctGroup, grpOrd);
          }
        }
      }

      if (isXfer) {
        const destAcct = (rawTo && !RESERVED_ACCT.has(rawTo) && !looksNumeric(rawTo)) ? rawTo : rawCat;
        const toGroup = String(r.ToAccountGroup || r.to_account_group || '').trim();
        const toOrdRaw = r.ToAccountOrder ?? r.to_account_order;
        const toOrd = (toOrdRaw !== undefined && toOrdRaw !== '') ? parseInt(toOrdRaw) : undefined;
        if (destAcct && !RESERVED_ACCT.has(destAcct) && !looksNumeric(destAcct) && !looksLikeUUID(destAcct)) {
          if (!acctMap.has(destAcct)) {
            acctMap.set(destAcct, { name: destAcct, group: toGroup, icon: '💳', acctType: '', cardLast4: '', settlementDate: 0, paymentDueDays: 0, isAsset: true, sortOrder: toOrd, subAccounts: new Set() });
          } else {
            const existing = acctMap.get(destAcct);
            if (!existing.subAccounts) existing.subAccounts = new Set();
            if (toGroup && !existing.group) existing.group = toGroup;
            if (toOrd !== undefined && existing.sortOrder === undefined) existing.sortOrder = toOrd;
          }
          if (rawToSub) acctMap.get(destAcct).subAccounts.add(rawToSub);
          if (toGroup) groupSet.add(toGroup);
        }
      } else {
        if (rawCat && !RESERVED_CAT.has(rawCat) && !looksLikeUUID(rawCat)) {
          const catType = typeRaw === 'Income' ? 'Income' : 'Expense';
          if (!catMap[rawCat]) catMap[rawCat] = { type: catType, subs: new Set() };
          if (sub && !looksLikeUUID(sub)) catMap[rawCat].subs.add(sub);
        }
      }

      // Collect tags from Tags column or Note
      const rawTags = String(r.Tags || r.tags || '').trim();
      if (rawTags) {
        rawTags.split(/[\s,]+/).forEach(tg => {
          const clean = tg.trim();
          if (clean) tagSet.add(clean.startsWith('#') ? clean : `#${clean}`);
        });
      }
      const rawNote = String(r.Note || r.note || '').trim();
      if (rawNote) {
        const noteTags = rawNote.match(/#[A-Za-z0-9_]+/g);
        if (noteTags) noteTags.forEach(tg => tagSet.add(tg.trim()));
      }
    }

    const newAcctsList = Array.from(acctMap.values()).map(a => {
      const subs = new Set(a.subAccounts || []);
      if ((a.name || '').toLowerCase() === 'liquid mutual funds') {
        subs.add('Groww');
      } else if ((a.name || '').toLowerCase() === 'share market') {
        subs.add('Zerodha');
      } else if ((a.name || '').toLowerCase() === 'amazon') {
        subs.add('My Amazon');
      }
      return {
        ...a,
        subAccounts: Array.from(subs)
      };
    });
    newAcctsList.sort((a, b) => {
      const ordA = (a.sortOrder !== undefined && !isNaN(a.sortOrder)) ? a.sortOrder : 999999;
      const ordB = (b.sortOrder !== undefined && !isNaN(b.sortOrder)) ? b.sortOrder : 999999;
      return ordA - ordB;
    });

    const newCatsArr = catsObjToArr(catMap);
    const newGroupsList = Array.from(groupSet).filter(Boolean).map((name, i) => {
      const ord = groupOrderMap.get(name) !== undefined ? groupOrderMap.get(name) : i;
      return { id: uuid(), name, sort_order: ord };
    });
    newGroupsList.sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999));

    if (isOverride) {
      // OVERRIDE: Delete all existing/default accounts and categories, replacing exclusively with the file's items
      await replaceAccounts(newAcctsList);
      await replaceCategories(newCatsArr);
      await replaceAccountGroups(newGroupsList);
      if (tagSet.size > 0) {
        const tagStr = Array.from(tagSet).join(', ');
        await setSetting('customTags', tagStr);
      }
    } else {
      // MERGE: Merge with existing accounts, categories, and groups
      const existAccts = normalizeAccounts(await getAccounts());
      const existAcctMap = new Map();
      existAccts.forEach(a => existAcctMap.set((a.name || '').toLowerCase(), a));

      newAcctsList.forEach(newAcct => {
        const key = (newAcct.name || '').toLowerCase();
        if (existAcctMap.has(key)) {
          const existAcct = existAcctMap.get(key);
          const existingSubs = existAcct.subAccounts || [];
          const existingSubNames = new Set(existingSubs.map(s => (typeof s === 'object' ? s.name : s).toLowerCase()));
          
          const newSubs = newAcct.subAccounts || [];
          newSubs.forEach(s => {
            const sName = typeof s === 'object' ? s.name : s;
            if (!existingSubNames.has(sName.toLowerCase())) {
              existingSubs.push(typeof s === 'object' ? s : { id: uuid(), name: sName });
            }
          });
          existAcct.subAccounts = existingSubs;
        } else {
          existAcctMap.set(key, newAcct);
        }
      });
      await replaceAccounts(Array.from(existAcctMap.values()));

      const existGroups = await getAccountGroups();
      const existGroupNames = new Set(existGroups.map(g => g.name));
      const brandNewGroups = newGroupsList.filter(g => !existGroupNames.has(g.name));
      await replaceAccountGroups([...existGroups, ...brandNewGroups]);

      const existCatsArr = await getCategories();
      const existCatsObj = catsArrToObj(existCatsArr);
      for (const [cat, d] of Object.entries(catMap)) {
        if (!existCatsObj[cat]) {
          existCatsObj[cat] = { type: d.type, subcategories: [...d.subs] };
        } else {
          const sc = new Set(existCatsObj[cat].subcategories);
          d.subs.forEach(s => sc.add(s));
          existCatsObj[cat].subcategories = [...sc];
        }
      }
      await replaceCategories(catsObjToArr(existCatsObj));
    }

    // Bulk insert transactions in batches
    let imported = 0, skipped = 0;
    const BATCH = 500;
    for (let i = 0; i < total; i += BATCH) {
      if (cancelRef.current) {
        dispatch({ type:'SET_IMPORT', payload:null });
        await load();
        return { imported, skipped, cancelled:true };
      }
      const res = await bulkImport(rows.slice(i, i + BATCH), { firstImport: isFirstImport });
      imported += res.imported; skipped += res.skipped;
      dispatch({ type:'SET_IMPORT', payload:{ processed:Math.min(i+BATCH,total), total, startTime:Date.now() } });
      await new Promise(r => setTimeout(r, 0));
    }

    dispatch({ type:'SET_IMPORT', payload:null });

    // Automatically trigger Stock Inventory Sync from newly imported transaction records
    // only if we did not restore a full JSON/Encrypted backup (which already contains the active stock inventory)
    if (!backupData) {
      try {
        const { syncStockFromPastTransactions } = await import('../database/inventory.js');
        await syncStockFromPastTransactions();
      } catch (e) {
        console.warn('Failed to auto-sync inventory after import:', e);
      }
    }

    await load();
    return { imported, skipped, cancelled:false };
  };

  const cancelImport = () => { cancelRef.current = true; };
  // Remove accounts whose names look like numeric amounts (cleanup from bad imports)
  // Also removes any account not referenced in any transaction
  const cleanupAccounts = async () => {
    const txns = state.transactions;
    const usedNames = new Set();
    for (const t of txns) {
      if (t.Account)     usedNames.add(t.Account);
      if (t.FromAccount) usedNames.add(t.FromAccount);
      if (t.ToAccount)   usedNames.add(t.ToAccount);
    }
    const cleaned = normalizeAccounts(await getAccounts()).filter(a => usedNames.has(a.name));
    await replaceAccounts(cleaned);
    await load();
  };

  const clearAllData = async () => {
    const db = getDB();
    await db.run('DELETE FROM transactions');
    await db.run('DELETE FROM investment_transactions');
    await db.run('DELETE FROM accounts');
    await db.run('DELETE FROM sub_accounts');
    await db.run('DELETE FROM account_groups');
    await db.run('DELETE FROM account_mapping');
    await db.run('DELETE FROM categories');
    await db.run('DELETE FROM subcategories');
    await db.run('DELETE FROM budgets');
    await db.run('DELETE FROM recurring_rules');
    await db.run('DELETE FROM inventory');
    // Re-seed default metadata for fresh reuse
    await replaceAccountGroups(DEFAULT_ACCOUNT_GROUPS);
    await replaceAccounts(DEFAULT_ACCOUNTS.map((a,i) => ({ id: uuid(), ...a, sortOrder: i })));
    await replaceCategories(DEFAULT_CATEGORIES.map((c,i) => ({
      id: uuid(), name: c.name, type: c.type, sortOrder: i,
      subcategories: c.subcategories.map((s,si) => ({ id: uuid(), name: s, sortOrder: si })),
    })));
    await setSetting('sub_accounts_migrated_v2', 'true');
    await load();
  };

  const updateSettings = async (data) => {
    if (data.accounts       !== undefined) await replaceAccounts(data.accounts);
    if (data.categories     !== undefined) await replaceCategories(catsObjToArr(data.categories));
    if (data.accountGroups  !== undefined) await replaceAccountGroups(data.accountGroups);
    if (data.accountMapping  !== undefined) await replaceAccountMapping(data.accountMapping);
    if (data.budgets         !== undefined) await replaceBudgets(data.budgets);
    if (data.recurringRules  !== undefined) {
      // Restore each rule
      for (const rule of data.recurringRules) { await saveRecurringRule(rule); }
      const rules = await getAllRecurringRules();
      dispatch({ type:'SET_RECURRING', payload: rules });
    }
    // Persist simple key-value settings (profileName, pin, pinIdleSeconds, customTags, etc.)
    const settingsKeys = ['profileName', 'pin', 'pinIdleSeconds', 'name', 'backupSchedule', 'lastBackupCheck', 'backupHistory', 'fontDataWeight', 'biometricsEnabled', 'customTags'];
    const changed = {};
    for (const key of settingsKeys) {
      if (data[key] !== undefined) {
        await setSetting(key, String(data[key]));
        changed[key] = data[key];
      }
    }
    if (Object.keys(changed).length > 0) {
      // Optimistic update so UI reflects immediately without full reload
      dispatch({ type: 'UPD_SETTINGS', payload: changed });
    }
    await load();
  };

  // ── Recurring rules ─────────────────────────────────────────────────────
  const createRecurringRule = async (rule) => {
    const saved = await saveRecurringRule(rule);
    const rules = await getAllRecurringRules();
    dispatch({ type:'SET_RECURRING', payload: rules });
    return saved;
  };

  const modifyRecurringRule = async (id, updates) => {
    await updateRecurringRule(id, updates);
    const rules = await getAllRecurringRules();
    dispatch({ type:'SET_RECURRING', payload: rules });
  };

  const removeRecurringRule = async (id) => {
    await deleteRecurringRule(id);
    const rules = await getAllRecurringRules();
    dispatch({ type:'SET_RECURRING', payload: rules });
  };

  // Process due repeat transactions on app open
  const processDueRepeat = async () => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
    const active = await getActiveRecurringRules();
    // next_date stored as YYYY-MM-DD — compare directly as strings
    const due = active.filter(r => r.rule_type === 'repeat' && r.next_date && r.next_date <= todayStr);
    if (!due.length) return;
    for (const rule of due) {
      // Convert YYYY-MM-DD → DD/MM/YYYY for transaction Date storage
      const [dy, dm, dd] = rule.next_date.split('-');
      const txnDate = `${dd}/${dm}/${dy}`;
      const data = {
        Date: txnDate, Time: '00:00',
        Account: rule.account || rule.from_account || '',
        FromAccount: rule.from_account || '', ToAccount: rule.to_account || '',
        Category: rule.txn_type === 'Transfer-Out' ? 'Transfer' : (rule.category || ''),
        Subcategory: rule.subcategory || 'Default',
        Note: rule.base_note || '', Description: rule.description || '',
        INR: rule.amount_per_part || 0, Amount: String(rule.amount_per_part || 0),
        Currency: rule.currency || 'INR', 'Income/Expense': rule.txn_type || 'Expense',
        recurring_rule_id: rule.id,
      };
      await dbAdd(data);
      // next_date stays as YYYY-MM-DD for consistent comparison
      const nextDate = computeNextRepeatDate(rule.next_date, rule.frequency, rule.schedule_mode);
      await updateRecurringRule(rule.id, {
        next_date: nextDate,
        completed_parts: (rule.completed_parts || 0) + 1,
      });
    }
    if (due.length) await load();
  };

  const setTheme = async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    dispatch({ type:'SET_THEME', payload: theme });
    try { await setSetting('theme', theme); } catch (e) { console.error('setTheme:', e); }
  };

  const setFontSize = async (scale) => {
    document.documentElement.style.setProperty('--fs-scale', String(scale));
    dispatch({ type:'SET_FONTSIZE', payload: scale });
    try { await setSetting('fontSize', String(scale)); } catch (e) { console.error('setFontSize:', e); }
  };

  const setFontDataWeight = async (weight) => {
    const fwMap = { light: '400', regular: '500', bold: '700' };
    document.documentElement.style.setProperty('--fw-data', fwMap[weight] || '400');
    dispatch({ type: 'SET_FONTDATAWEIGHT', payload: weight });
    try { await setSetting('fontDataWeight', weight); } catch (e) { console.error('setFontDataWeight:', e); }
  };

  const setFontFamily = async (family) => {
    const fontMap = {
      'Sora': "'Sora', sans-serif",
      'Inter': "'Inter', sans-serif",
      'Roboto': "'Roboto', sans-serif",
      'Open Sans': "'Open Sans', sans-serif",
      'Lato': "'Lato', sans-serif",
    };
    const cssFamily = fontMap[family] || "'Sora', sans-serif";
    document.documentElement.style.setProperty('--font', cssFamily);
    dispatch({ type:'SET_FONTFAMILY', payload: family });
    try { await setSetting('fontFamily', family); } catch (e) { console.error('setFontFamily:', e); }
  };

  const saveBudget   = async (cat, amount, period) => { await setBudget(cat, amount, period); dispatch({ type:'SET_BUDGETS', payload: await getBudgets() }); };
  const removeBudget = async (cat) => { await deleteBudget(cat); dispatch({ type:'SET_BUDGETS', payload: await getBudgets() }); };

  return (
    <Ctx.Provider value={{
      state, dispatch, load, navigate, clearNavParams,
      addTransaction, updateTransaction, deleteTransaction,
      updateInstalmentSiblings, updateInstalmentAmount, deleteAllInstalments,
      renameAccount, renameCategory, cleanupAccounts,
      deleteAccountTransactions, deleteCategoryTransactions, deleteSubcategoryTransactions,
      renameSubAccount, deleteSubAccountTransactions,
      importData, cancelImport, clearAllData, analyseImport,
      updateSettings, setTheme, setFontSize, setFontFamily, setFontDataWeight,
      createRecurringRule, modifyRecurringRule, removeRecurringRule, processDueRepeat,
      saveBudget, removeBudget,
    }}>
      {children}
    </Ctx.Provider>
  );
}