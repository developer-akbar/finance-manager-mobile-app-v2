const getSubAccountNames = (acctObj) => {
  if (!acctObj) return [];
  const subs = Array.isArray(acctObj.subAccounts) ? acctObj.subAccounts : (acctObj.subAccounts ? Array.from(acctObj.subAccounts) : []);
  const extracted = subs.map(s => (typeof s === 'string' ? s : (s?.name || s?.id || '')).trim()).filter(Boolean);

  let rawList = extracted;
  if (rawList.length === 0) {
    const acctName = String(acctObj.name || acctObj || '').trim().toLowerCase();
    if (acctName === 'mutual funds tax saver') rawList = ['Ak ETMoney'];
    else if (acctName === 'liquid mutual funds') rawList = ['Fareeda Groww', 'Ammi Groww', 'Ak ETMoney'];
    else if (acctName === 'share market') rawList = ['Zerodha', 'Fareeda Groww'];
  }

  const seen = new Set();
  const unique = [];
  for (const name of rawList) {
    const key = name.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(name.trim());
    }
  }
  return unique;
};

const getSortedSubs = (acctObj, subAcctBalances = {}) => {
  if (!acctObj) return [];
  const names = getSubAccountNames(acctObj);
  if (!names.length) return [];
  const name = acctObj.name || acctObj;
  const sorted = [...names].sort((a, b) => {
    const balA = subAcctBalances[name]?.[a] ?? 0;
    const balB = subAcctBalances[name]?.[b] ?? 0;
    return balB - balA;
  });

  const seen = new Set();
  const result = [];
  for (const s of sorted) {
    const key = s.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(s);
    }
  }
  return result;
};

console.log('=== TEST SUBACCOUNT DEDUPLICATION ===');

// Test Case 1: Duplicate Ak ETMoney in subAccounts array
const acct1 = { name: 'Mutual Funds Tax Saver', subAccounts: ['Ak ETMoney', 'Ak ETMoney', { name: 'Ak ETMoney' }] };
const res1 = getSortedSubs(acct1);
console.log('Test 1 (Tax Saver duplicates):', res1, '->', res1.length === 1 && res1[0] === 'Ak ETMoney' ? 'PASS ✅' : 'FAIL ❌');

// Test Case 2: Empty subAccounts with canonical fallback
const acct2 = { name: 'Mutual Funds Tax Saver', subAccounts: [] };
const res2 = getSortedSubs(acct2);
console.log('Test 2 (Tax Saver fallback):', res2, '->', res2.length === 1 && res2[0] === 'Ak ETMoney' ? 'PASS ✅' : 'FAIL ❌');

// Test Case 3: Liquid Mutual Funds with duplicates
const acct3 = { name: 'Liquid Mutual Funds', subAccounts: ['Fareeda Groww', 'Fareeda Groww', 'Ammi Groww', 'Ak ETMoney', 'ak etmoney'] };
const res3 = getSortedSubs(acct3);
console.log('Test 3 (Liquid MF duplicates):', res3, '->', res3.length === 3 ? 'PASS ✅' : 'FAIL ❌');

// Test Case 4: Cash (no subaccounts)
const acct4 = { name: 'Cash', subAccounts: [] };
const res4 = getSortedSubs(acct4);
console.log('Test 4 (Cash no subs):', res4, '->', res4.length === 0 ? 'PASS ✅' : 'FAIL ❌');
