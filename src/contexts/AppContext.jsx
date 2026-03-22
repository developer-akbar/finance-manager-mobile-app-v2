import React, { createContext, useContext, useReducer, useEffect, useRef, useCallback } from 'react';
import {
  getTransactions, addTransaction as dbAdd, updateTransaction as dbUpdate,
  deleteTransaction as dbDelete, deleteAllTransactions, bulkImport,
  getTransactionCount, analyseImport,
  getAllSettings, setSetting,
  getAccounts, replaceAccounts,
  getAccountGroups, replaceAccountGroups,
  getAccountMapping, replaceAccountMapping,
  getCategories, replaceCategories,
  getBudgets, setBudget, deleteBudget,
} from '../database/index.js';
import { DEFAULT_ACCOUNT_GROUPS, DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } from '../database/defaults.js';
import { v4 as uuid } from 'uuid';

const Ctx = createContext(null);
export const useApp = () => { const c = useContext(Ctx); if (!c) throw new Error('useApp outside AppProvider'); return c; };

// ── Helpers ───────────────────────────────────────────────────────────────────
// Categories in state: { CatName: { type:'Expense'|'Income', subcategories:['sub1',...] } }
const catsArrToObj = (arr) => {
  const o = {};
  for (const c of (arr || [])) {
    o[c.name] = { type: c.type || 'Expense', subcategories: (c.subcategories || []).map(s => s.name || s) };
  }
  return o;
};
const catsObjToArr = (obj) =>
  Object.entries(obj || {}).map(([name, d], i) => ({
    name, type: d.type || 'Expense',
    sortOrder: d.sortOrder !== undefined ? d.sortOrder : i,
    subcategories: (d.subcategories || []).map((s, si) => ({ name: s, sortOrder: si })),
  }));

const normalizeAccounts = (raw) =>
  (raw || []).map(a => typeof a === 'string'
    ? { name: a, group: '', icon: '💳', acctType: '', settlementDate: 0, paymentDueDays: 0 }
    : { name: a.name || '', group: a.group || a.group_name || '', icon: '💳',
        acctType: a.acctType || '', settlementDate: a.settlementDate ? Number(a.settlementDate) : 0, paymentDueDays: a.paymentDueDays ? Number(a.paymentDueDays) : 0 });

// ── Reducer ───────────────────────────────────────────────────────────────────
const INIT = {
  transactions: [], accounts: [], categories: {},
  accountGroups: [], budgets: [], settings: {},
  theme: 'dark', fontSize: 1.0, fontFamily: 'Sora', fontDataWeight: 'regular',
  loading: true, error: null, importProgress: null,
  currentView: 'dashboard',
};

function reducer(s, a) {
  switch (a.type) {
    case 'INIT':         return { ...s, ...a.payload, loading: false };
    case 'ADD_TXN':      return { ...s, transactions: [a.payload, ...s.transactions] };
    case 'UPD_TXN':      return { ...s, transactions: s.transactions.map(t => t._id === a.payload._id ? a.payload : t) };
    case 'DEL_TXN':      return { ...s, transactions: s.transactions.filter(t => t._id !== a.payload) };
    case 'SET_BUDGETS':  return { ...s, budgets: a.payload };
    case 'SET_IMPORT':   return { ...s, importProgress: a.payload };
    case 'SET_THEME':    return { ...s, theme: a.payload };
    case 'SET_FONTSIZE': return { ...s, fontSize: a.payload };
    case 'SET_FONTFAMILY':     return { ...s, fontFamily: a.payload };
    case 'SET_FONTDATAWEIGHT': return { ...s, fontDataWeight: a.payload };
    case 'UPD_SETTINGS': return { ...s, settings: { ...s.settings, ...a.payload } };
    case 'NAVIGATE': return { ...s, currentView: a.payload };
    default: return s;
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────
export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, INIT);
  const cancelRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [txns, accts, catsArr, aGroups, aMapping, budgets, settings] = await Promise.all([
        getTransactions(), getAccounts(), getCategories(),
        getAccountGroups(), getAccountMapping(), getBudgets(), getAllSettings(),
      ]);

      // Seed defaults on very first launch (empty accounts AND categories)
      if (accts.length === 0 && catsArr.length === 0) {
        await replaceAccountGroups(DEFAULT_ACCOUNT_GROUPS);
        await replaceAccounts(DEFAULT_ACCOUNTS.map((a,i) => ({ id: uuid(), ...a, sortOrder: i })));
        await replaceCategories(DEFAULT_CATEGORIES.map((c,i) => ({
          id: uuid(), name: c.name, type: c.type, sortOrder: i,
          subcategories: c.subcategories.map((s,si) => ({ id: uuid(), name: s, sortOrder: si })),
        })));
        // Reload after seeding
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
        }});
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
        },
      });
    } catch (e) {
      console.error('AppContext load error:', e);
      dispatch({ type:'INIT', payload:{ transactions:[], accounts:[], categories:{}, accountGroups:[], budgets:[], settings:{}, theme:'dark', fontSize:1.0, fontFamily:'Sora', fontDataWeight:'light' } });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const navigate = (view) => dispatch({ type: 'NAVIGATE', payload: view });

  const addTransaction    = async (data) => { const r = await dbAdd(data);    if (r) dispatch({ type:'ADD_TXN', payload:r }); return r; };
  const updateTransaction = async (id,d) => { const r = await dbUpdate(id,d); if (r) dispatch({ type:'UPD_TXN', payload:r }); return r; };
  const deleteTransaction = async (id)   => { await dbDelete(id); dispatch({ type:'DEL_TXN', payload:id }); };

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

  const importData = async (rows, mode = 'override') => {
    const dbCount = mode === 'override' ? 0 : await getTransactionCount();
    const isFirstImport = dbCount === 0;
    cancelRef.current = false;
    const total = rows.length;
    dispatch({ type:'SET_IMPORT', payload:{ processed:0, total, startTime:Date.now() } });

    if (mode === 'override') await deleteAllTransactions();

    // Import in batches so UI stays responsive
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
      await new Promise(r => setTimeout(r, 0)); // yield to UI
    }

    // Auto-extract accounts & categories from imported rows.
    // Supports both Money Manager XLS and FinMan CSV/JSON export formats.
    const acctSet = new Set(), catMap = {};
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
    // UUID pattern — category/account names that look like UUIDs are corruption
    // artefacts from previous bad imports and must never be stored.
    const looksLikeUUID = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    // Reserved words that must never become account or category names
    const RESERVED_ACCT = new Set(['INR','USD','GBP','EUR','Transfer','Transfer-Out','Transfer-In']);
    const RESERVED_CAT  = new Set(['Transfer','Transfer-Out','Transfer-In','Income','Expense']);

    for (const r of rows) {
      const typeRaw = String(r['Income/Expense'] || r.type || '').trim();
      const isXfer  = typeRaw.toLowerCase().startsWith('transfer');
      const rawCat  = String(r.Category    || r.category    || '').trim();
      const rawTo   = String(r.ToAccount   || r.to_account  || '').trim();
      const rawSub  = String(r.Subcategory || r.subcategory || '').trim();
      const sub     = rawSub.toLowerCase() === 'default' ? '' : rawSub;

      // Source account — guard against numeric/UUID/reserved values
      const rawAcct  = String(r.Account || r.account || '').trim();
      const realAcct = looksNumeric(rawAcct)
        ? String(r.FromAccount || r.from_account || '').trim() || rawAcct
        : rawAcct;

      if (realAcct && !RESERVED_ACCT.has(realAcct) && !looksNumeric(realAcct) && !looksLikeUUID(realAcct))
        acctSet.add(realAcct);

      if (isXfer) {
        // Destination account: prefer explicit ToAccount (FinMan export),
        // fall back to Category (Money Manager format).
        const destAcct = (rawTo && !RESERVED_ACCT.has(rawTo) && !looksNumeric(rawTo))
          ? rawTo
          : rawCat;
        if (destAcct && !RESERVED_ACCT.has(destAcct) && !looksNumeric(destAcct) && !looksLikeUUID(destAcct))
          acctSet.add(destAcct);
      } else {
        // For Expense/Income: Category = expense category (never add to accounts)
        // Also skip UUID-looking names and reserved words.
        if (rawCat && !RESERVED_CAT.has(rawCat) && !looksLikeUUID(rawCat)) {
          const catType = typeRaw === 'Income' ? 'Income' : 'Expense';
          if (!catMap[rawCat]) catMap[rawCat] = { type: catType, subs: new Set() };
          if (sub && !looksLikeUUID(sub)) catMap[rawCat].subs.add(sub);
        }
      }
    }

    // Build account list from imported rows
    const newAcctNames = [...acctSet].filter(n => n);
    if (mode === 'override') {
      await replaceAccounts(newAcctNames.map(name => ({ name, group:'', icon:'💳', acctType:'', settlementDate:0, paymentDueDays:0 })));
    } else {
      const existAccts = normalizeAccounts(await getAccounts());
      const existNames = new Set(existAccts.map(a => a.name));
      const brandNew   = newAcctNames.filter(n => !existNames.has(n)).map(name => ({ name, group:'', icon:'💳', acctType:'', settlementDate:0, paymentDueDays:0 }));
      await replaceAccounts([...existAccts, ...brandNew]);
    }

    // Merge with existing categories — case-insensitive dedup.
    // Build a lookup: lowercase name → canonical (Title Case preferred) name already in DB.
    const existCatsArr = await getCategories();
    const existCatsObj = catsArrToObj(existCatsArr);
    // Remove any UUID-named categories that leaked in from previous bad imports
    for (const key of Object.keys(existCatsObj)) {
      if (looksLikeUUID(key)) delete existCatsObj[key];
    }
    // Build case-insensitive map: lowercase → existing canonical key
    const existCatLC = {};
    for (const key of Object.keys(existCatsObj)) existCatLC[key.toLowerCase()] = key;

    for (const [cat, d] of Object.entries(catMap)) {
      // Find existing key case-insensitively; prefer the one already in DB
      const canonical = existCatLC[cat.toLowerCase()] || cat;
      if (!existCatsObj[canonical]) {
        existCatsObj[canonical] = { type: d.type, subcategories: [...d.subs] };
        existCatLC[canonical.toLowerCase()] = canonical;
      } else {
        const sc = new Set(existCatsObj[canonical].subcategories);
        d.subs.forEach(s => sc.add(s));
        existCatsObj[canonical].subcategories = [...sc];
        if (d.type !== existCatsObj[canonical].type && d.type === 'Income')
          existCatsObj[canonical].type = 'Income';
      }
    }
    await replaceCategories(catsObjToArr(existCatsObj));

    dispatch({ type:'SET_IMPORT', payload:null });
    await load(); // Reload all data from DB into state
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

  const clearAllData = async () => { await deleteAllTransactions(); await load(); };

  const updateSettings = async (data) => {
    if (data.accounts       !== undefined) await replaceAccounts(data.accounts);
    if (data.categories     !== undefined) await replaceCategories(catsObjToArr(data.categories));
    if (data.accountGroups  !== undefined) await replaceAccountGroups(data.accountGroups);
    if (data.accountMapping !== undefined) await replaceAccountMapping(data.accountMapping);
    // Persist simple key-value settings (profileName, pin, pinIdleSeconds, etc.)
    const settingsKeys = ['profileName', 'pin', 'pinIdleSeconds', 'name', 'backupSchedule', 'lastBackupCheck', 'backupHistory', 'fontDataWeight'];
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
      state, dispatch, load, navigate,
      addTransaction, updateTransaction, deleteTransaction,
      renameAccount, renameCategory, cleanupAccounts,
      importData, cancelImport, clearAllData, analyseImport,
      updateSettings, setTheme, setFontSize, setFontFamily, setFontDataWeight,
      saveBudget, removeBudget,
    }}>
      {children}
    </Ctx.Provider>
  );
}