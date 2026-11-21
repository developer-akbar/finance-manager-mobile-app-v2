/**
 * src/server/ai/syntheticFinancialFixtures.js
 *
 * Deterministic synthetic financial dataset for FinMan OpenAI POC (Phase OAI-1).
 * Strictly isolated: Zero connection to IndexedDB, SQLite, or real user records.
 *
 * Guaranteed Privacy:
 * Used as the exclusive underlying data source for the OpenAI POC.
 * All account names and entities are unmistakably fictional (Demo Bank A, Demo Bank B, Demo Credit Card, etc.)
 * to avoid any confusion with the user's actual accounts.
 */

export const SYNTHETIC_REFERENCE_DATE = new Date(2026, 10, 15); // 15 November 2026

export const SYNTHETIC_ACCOUNTS = [
  {
    id: 'syn-acct-1',
    name: 'Demo Bank A (Savings)',
    group: 'Bank Accounts',
    acctType: 'Savings',
    isAsset: true,
    settlementDate: 0,
    paymentDueDays: 0
  },
  {
    id: 'syn-acct-2',
    name: 'Demo Bank B (Salary)',
    group: 'Bank Accounts',
    acctType: 'Salary',
    isAsset: true,
    settlementDate: 0,
    paymentDueDays: 0
  },
  {
    id: 'syn-acct-3',
    name: 'Demo Credit Card Platinum',
    group: 'Credit Cards',
    acctType: 'Credit Card',
    isAsset: false,
    settlementDate: 18,
    paymentDueDays: 20
  },
  {
    id: 'syn-acct-4',
    name: 'Demo Share Market Demat',
    group: 'Investments',
    acctType: 'Demat',
    isAsset: true,
    settlementDate: 0,
    paymentDueDays: 0
  },
  {
    id: 'syn-acct-5',
    name: 'Demo Mutual Funds Portfolio',
    group: 'Investments',
    acctType: 'Mutual Fund',
    isAsset: true,
    settlementDate: 0,
    paymentDueDays: 0
  },
  {
    id: 'syn-acct-6',
    name: 'Demo Cash Wallet',
    group: 'Cash',
    acctType: 'Cash',
    isAsset: true,
    settlementDate: 0,
    paymentDueDays: 0
  }
];

export const SYNTHETIC_CATEGORIES = {
  Salary: { type: 'Income', subcategories: ['Monthly Salary', 'Performance Bonus'] },
  Rent: { type: 'Expense', subcategories: ['Apartment Rent'] },
  Groceries: { type: 'Expense', subcategories: ['Supermarket', 'Organic Farm', 'Vegetables'] },
  Dining: { type: 'Expense', subcategories: ['Restaurants', 'Coffee Shop'] },
  Utilities: { type: 'Expense', subcategories: ['Electricity', 'Broadband', 'Mobile Bill'] },
  Investments: { type: 'Expense', subcategories: ['Equity SIP', 'Mutual Fund SIP'] },
  Shopping: { type: 'Expense', subcategories: ['Electronics', 'Clothing'] }
};

export const SYNTHETIC_TRANSACTIONS = [
  // ── October 2026 (Completed Month) ───────────────────────────────────────
  {
    id: 'syn-tx-101',
    date: '2026-10-01',
    time: '09:00',
    account: 'Demo Bank B (Salary)',
    category: 'Salary',
    subcategory: 'Monthly Salary',
    inr: 150000,
    amount: 150000,
    type: 'Income',
    note: 'Demo October Salary Credit'
  },
  {
    id: 'syn-tx-102',
    date: '2026-10-02',
    time: '10:30',
    account: 'Demo Bank B (Salary)',
    category: 'Rent',
    subcategory: 'Apartment Rent',
    inr: 35000,
    amount: 35000,
    type: 'Expense',
    note: 'Demo October Apartment Rent'
  },
  {
    id: 'syn-tx-103',
    date: '2026-10-05',
    time: '14:20',
    account: 'Demo Bank A (Savings)',
    category: 'Groceries',
    subcategory: 'Supermarket',
    inr: 8500,
    amount: 8500,
    type: 'Expense',
    note: 'Demo Weekly Groceries Supermarket'
  },
  {
    id: 'syn-tx-104',
    date: '2026-10-10',
    time: '19:45',
    account: 'Demo Credit Card Platinum',
    category: 'Dining',
    subcategory: 'Restaurants',
    inr: 4200,
    amount: 4200,
    type: 'Expense',
    note: 'Demo Weekend Dinner'
  },
  {
    id: 'syn-tx-105',
    date: '2026-10-12',
    time: '11:15',
    account: 'Demo Bank A (Savings)',
    category: 'Utilities',
    subcategory: 'Electricity',
    inr: 3200,
    amount: 3200,
    type: 'Expense',
    note: 'Demo Power Utility Bill'
  },
  {
    id: 'syn-tx-106',
    date: '2026-10-15',
    time: '16:00',
    account: 'Demo Credit Card Platinum',
    category: 'Shopping',
    subcategory: 'Electronics',
    inr: 12500,
    amount: 12500,
    type: 'Expense',
    note: 'Demo Noise Cancelling Headphones'
  },
  {
    id: 'syn-tx-107',
    date: '2026-10-20',
    time: '10:00',
    account: 'Demo Bank B (Salary)',
    category: 'Groceries',
    subcategory: 'Organic Farm',
    inr: 4500,
    amount: 4500,
    type: 'Expense',
    note: 'Demo Fresh Fruits & Veggies'
  },
  // Transfer to Demo Bank A:
  {
    id: 'syn-tx-108',
    date: '2026-10-22',
    time: '12:00',
    fromAccount: 'Demo Bank B (Salary)',
    toAccount: 'Demo Bank A (Savings)',
    account: 'Demo Bank B (Salary)',
    category: 'Transfer',
    type: 'Transfer-Out',
    inr: 40000,
    amount: 40000,
    note: 'Demo Savings Transfer'
  },

  // ── November 2026 (Current Month up to 15 Nov) ───────────────────────────
  {
    id: 'syn-tx-201',
    date: '2026-11-01',
    time: '09:00',
    account: 'Demo Bank B (Salary)',
    category: 'Salary',
    subcategory: 'Monthly Salary',
    inr: 150000,
    amount: 150000,
    type: 'Income',
    note: 'Demo November Salary Credit'
  },
  {
    id: 'syn-tx-202',
    date: '2026-11-02',
    time: '10:30',
    account: 'Demo Bank B (Salary)',
    category: 'Rent',
    subcategory: 'Apartment Rent',
    inr: 35000,
    amount: 35000,
    type: 'Expense',
    note: 'Demo November Apartment Rent'
  },
  {
    id: 'syn-tx-203',
    date: '2026-11-04',
    time: '13:10',
    account: 'Demo Bank A (Savings)',
    category: 'Groceries',
    subcategory: 'Supermarket',
    inr: 6800,
    amount: 6800,
    type: 'Expense',
    note: 'Demo Groceries Supermarket'
  },
  {
    id: 'syn-tx-204',
    date: '2026-11-08',
    time: '20:15',
    account: 'Demo Credit Card Platinum',
    category: 'Dining',
    subcategory: 'Coffee Shop',
    inr: 1850,
    amount: 1850,
    type: 'Expense',
    note: 'Demo Team Coffee & Snacks'
  },
  {
    id: 'syn-tx-205',
    date: '2026-11-10',
    time: '11:00',
    account: 'Demo Bank A (Savings)',
    category: 'Utilities',
    subcategory: 'Broadband',
    inr: 1499,
    amount: 1499,
    type: 'Expense',
    note: 'Demo Fiber Internet Subscription'
  },
  {
    id: 'syn-tx-206',
    date: '2026-11-12',
    time: '15:30',
    account: 'Demo Credit Card Platinum',
    category: 'Shopping',
    subcategory: 'Clothing',
    inr: 5400,
    amount: 5400,
    type: 'Expense',
    note: 'Demo Winter Jacket'
  }
];

export const SYNTHETIC_HOLDINGS = [
  {
    symbol: 'DEMO-INFY',
    name: 'Demo Infosys Technologies',
    assetType: 'EQUITY',
    platform: 'Demo Share Market Demat',
    units: 100,
    averageCost: 1450.00,
    investedCost: 145000.00,
    currentPrice: 1620.00,
    currentValue: 162000.00,
    unrealizedPnl: 17000.00,
    returnPercent: 11.72
  },
  {
    symbol: 'DEMO-TCS',
    name: 'Demo Tata Consultancy Services',
    assetType: 'EQUITY',
    platform: 'Demo Share Market Demat',
    units: 50,
    averageCost: 3400.00,
    investedCost: 170000.00,
    currentPrice: 3850.00,
    currentValue: 192500.00,
    unrealizedPnl: 22500.00,
    returnPercent: 13.24
  },
  {
    symbol: 'DEMO-NIFTY50-INDEX',
    name: 'Demo Nifty 50 Index Fund Direct Growth',
    assetType: 'MUTUAL_FUND',
    platform: 'Demo Mutual Funds Portfolio',
    units: 2500,
    averageCost: 120.00,
    investedCost: 300000.00,
    currentPrice: 142.50,
    currentValue: 356250.00,
    unrealizedPnl: 56250.00,
    returnPercent: 18.75
  },
  {
    symbol: 'DEMO-EMERGING-BLUECHIP',
    name: 'Demo Large & Midcap Bluechip Fund',
    assetType: 'MUTUAL_FUND',
    platform: 'Demo Mutual Funds Portfolio',
    units: 1800,
    averageCost: 95.00,
    investedCost: 171000.00,
    currentPrice: 118.00,
    currentValue: 212400.00,
    unrealizedPnl: 41400.00,
    returnPercent: 24.21
  }
];

