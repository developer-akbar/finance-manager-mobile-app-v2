import React, { createContext, useContext, useReducer, useEffect, useRef } from 'react';
import {
  getTransactions, addTransaction as dbAdd, updateTransaction as dbUpdate,
  deleteTransaction as dbDelete, deleteAllTransactions, bulkImport,
  getAccounts, replaceAccounts, getAccountGroups, replaceAccountGroups,
  getCategories, replaceCategories,
  getBudgets, saveBudget, deleteBudget,
  getRecurring, saveRecurring, deleteRecurring,
  getAllSettings, setSetting,
} from '../database/index.js';

const Ctx = createContext(null);
export const useApp = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp must be inside AppProvider');
  return c;
};

const init = {
  transactions: [],
  accounts: [],        // [{id,name,group_name,icon,color}]
  accountGroups: [],   // [{id,name}]
  categories: [],      // [{id,name,type,icon,color,subcategories:[]}]
  budgets: [],
  recurring: [],
  settings: {},
  currentView: 'dashboard',
  loading: true,
  importProgress: null, // {phase,processed,total,startTime}
  toasts: [],
};

function reducer(s, a) {
  switch (a.type) {
    case 'SET_LOADING':        return { ...s, loading: a.v };
    case 'SET_VIEW':           return { ...s, currentView: a.v };
    case 'SET_TRANSACTIONS':   return { ...s, transactions: a.v };
    case 'ADD_TXN':            return { ...s, transactions: [a.v, ...s.transactions] };
    case 'UPDATE_TXN':         return { ...s, transactions: s.transactions.map(t => t._id===a.v._id ? a.v : t) };
    case 'DELETE_TXN':         return { ...s, transactions: s.transactions.filter(t => t._id!==a.v) };
    case 'SET_ACCOUNTS':       return { ...s, accounts: a.v };
    case 'SET_GROUPS':         return { ...s, accountGroups: a.v };
    case 'SET_CATEGORIES':     return { ...s, categories: a.v };
    case 'SET_BUDGETS':        return { ...s, budgets: a.v };
    case 'SET_RECURRING':      return { ...s, recurring: a.v };
    case 'SET_SETTINGS':       return { ...s, settings: a.v };
    case 'SET_IMPORT':         return { ...s, importProgress: a.v };
    case 'HYDRATE':            return { ...s, ...a.v, loading: false };
    case 'TOAST_ADD':          return { ...s, toasts: [...s.toasts, a.v] };
    case 'TOAST_REMOVE':       return { ...s, toasts: s.toasts.filter(t => t.id !== a.v) };
    default: return s;
  }
}

const BATCH = 300;

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, init);
  const cancelRef = useRef(false);

  useEffect(() => { hydrate(); }, []);

  async function hydrate() {
    try {
      const [txns, accts, grps, cats, budgets, recurring, settings] = await Promise.all([
        getTransactions(), getAccounts(), getAccountGroups(),
        getCategories(), getBudgets(), getRecurring(), getAllSettings(),
      ]);
      dispatch({ type:'HYDRATE', v:{ transactions:txns, accounts:accts, accountGroups:grps,
        categories:cats, budgets, recurring, settings } });
    } catch (e) {
      console.error('Hydrate error:', e);
      dispatch({ type:'SET_LOADING', v:false });
    }
  }

  // ── Transactions ──────────────────────────────────────────────────────────
  async function addTransaction(t) {
    const saved = await dbAdd(t);
    if (saved) dispatch({ type:'ADD_TXN', v:saved });
    return saved;
  }
  async function updateTransaction(id, t) {
    const saved = await dbUpdate(id, t);
    if (saved) dispatch({ type:'UPDATE_TXN', v:saved });
    return saved;
  }
  async function deleteTransaction(id) {
    await dbDelete(id);
    dispatch({ type:'DELETE_TXN', v:id });
  }

  // ── Import (batched, cancellable, global progress) ────────────────────────
  async function importTransactions(rows, mode='override') {
    cancelRef.current = false;
    const total = rows.length;
    const startTime = Date.now();
    dispatch({ type:'SET_IMPORT', v:{ phase:'importing', processed:0, total, startTime } });

    if (mode==='override') await deleteAllTransactions();

    let imported=0, skipped=0;
    for (let i=0; i<total; i+=BATCH) {
      if (cancelRef.current) {
        dispatch({ type:'SET_IMPORT', v:null });
        await hydrate();
        return { imported, skipped, cancelled:true };
      }
      const batch = rows.slice(i, i+BATCH);
      const r = await bulkImport(batch, mode==='merge');
      imported += r.imported; skipped += r.skipped;
      dispatch({ type:'SET_IMPORT', v:{ phase:'importing', processed:Math.min(i+BATCH,total), total, startTime } });
      await new Promise(r => setTimeout(r,0));
    }
    dispatch({ type:'SET_IMPORT', v:null });
    await hydrate();
    return { imported, skipped };
  }
  function cancelImport() { cancelRef.current = true; }

  async function clearAllData() {
    await deleteAllTransactions();
    dispatch({ type:'SET_TRANSACTIONS', v:[] });
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  async function saveAccounts(list) {
    await replaceAccounts(list);
    const fresh = await getAccounts();
    dispatch({ type:'SET_ACCOUNTS', v:fresh });
  }
  async function saveAccountGroups(list) {
    await replaceAccountGroups(list);
    const fresh = await getAccountGroups();
    dispatch({ type:'SET_GROUPS', v:fresh });
  }

  // ── Categories ────────────────────────────────────────────────────────────
  async function saveCategories(list) {
    await replaceCategories(list);
    const fresh = await getCategories();
    dispatch({ type:'SET_CATEGORIES', v:fresh });
  }

  // ── Budgets ───────────────────────────────────────────────────────────────
  async function upsertBudget(b) {
    const saved = await saveBudget(b);
    const fresh = await getBudgets();
    dispatch({ type:'SET_BUDGETS', v:fresh });
    return saved;
  }
  async function removeBudget(id) {
    await deleteBudget(id);
    dispatch({ type:'SET_BUDGETS', v:state.budgets.filter(b=>b.id!==id) });
  }

  // ── Recurring ─────────────────────────────────────────────────────────────
  async function upsertRecurring(r) {
    const saved = await saveRecurring(r);
    const fresh = await getRecurring();
    dispatch({ type:'SET_RECURRING', v:fresh });
    return saved;
  }
  async function removeRecurring(id) {
    await deleteRecurring(id);
    dispatch({ type:'SET_RECURRING', v:state.recurring.filter(r=>r.id!==id) });
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  async function updateSetting(key, value) {
    await setSetting(key, value);
    dispatch({ type:'SET_SETTINGS', v:{ ...state.settings, [key]:String(value) } });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  function toast(message, type='success', duration=3000) {
    const id = Date.now().toString();
    dispatch({ type:'TOAST_ADD', v:{ id, message, kind:type } });
    setTimeout(() => dispatch({ type:'TOAST_REMOVE', v:id }), duration);
  }

  // ── Derived helpers ───────────────────────────────────────────────────────
  const accountNames = state.accounts.map(a => a.name);
  const categoryMap  = Object.fromEntries(state.categories.map(c => [c.name, c]));

  return (
    <Ctx.Provider value={{
      state, dispatch,
      accountNames, categoryMap,
      addTransaction, updateTransaction, deleteTransaction,
      importTransactions, cancelImport, clearAllData,
      saveAccounts, saveAccountGroups,
      saveCategories,
      upsertBudget, removeBudget,
      upsertRecurring, removeRecurring,
      updateSetting,
      hydrate,
      toast,
    }}>
      {children}
    </Ctx.Provider>
  );
}
