/**
 * Default seed data — applied ONCE on first app launch (when DB is empty).
 * Users can freely edit/delete/add everything after seeding.
 */
export const DEFAULT_ACCOUNT_GROUPS = [
  'Bank Accounts',
  'Cash',
  'Credit Cards',
  'Investments',
  'Loans',
];

export const DEFAULT_ACCOUNTS = [
  { name: 'HDFC Savings',       group: 'Bank Accounts' },
  { name: 'SBI Savings',        group: 'Bank Accounts' },
  { name: 'ICICI Current',      group: 'Bank Accounts' },
  { name: 'Cash Wallet',        group: 'Cash' },
  { name: 'HDFC Credit Card',   group: 'Credit Cards' },
  { name: 'SBI Credit Card',    group: 'Credit Cards' },
  { name: 'Share Market',        group: 'Investments', subAccounts: [ { name: 'Zerodha' }, { name: 'Groww' } ] },
  { name: 'Liquid Mutual Funds', group: 'Investments', subAccounts: [ { name: 'Groww' } ] },
  { name: 'PPF',                  group: 'Investments' },
  { name: 'Home Loan',            group: 'Loans' },
  { name: 'Car Loan',             group: 'Loans' },
];

export const DEFAULT_CATEGORIES = [
  // ── Expense ──────────────────────────────────────────────────────────────
  {
    name: 'Food & Dining', type: 'Expense',
    subcategories: ['Groceries', 'Restaurants', 'Swiggy / Zomato', 'Tea & Coffee', 'Snacks'],
  },
  {
    name: 'Transport', type: 'Expense',
    subcategories: ['Fuel', 'Auto / Cab', 'Metro / Bus', 'Parking', 'Vehicle Service'],
  },
  {
    name: 'Shopping', type: 'Expense',
    subcategories: ['Clothing', 'Electronics', 'Amazon / Flipkart', 'Home & Kitchen', 'Personal Care'],
  },
  {
    name: 'Bills & Utilities', type: 'Expense',
    subcategories: ['Electricity', 'Water', 'Gas', 'Internet', 'Mobile Recharge', 'OTT / Subscriptions'],
  },
  {
    name: 'Health', type: 'Expense',
    subcategories: ['Doctor / Hospital', 'Medicines', 'Lab Tests', 'Gym / Fitness', 'Health Insurance'],
  },
  {
    name: 'Education', type: 'Expense',
    subcategories: ['School / College Fees', 'Books & Stationery', 'Online Courses', 'Coaching / Tuition'],
  },
  {
    name: 'Entertainment', type: 'Expense',
    subcategories: ['Movies / Events', 'Games', 'Hobbies', 'Travel & Trips', 'Sports'],
  },
  {
    name: 'Home', type: 'Expense',
    subcategories: ['Rent', 'Maintenance', 'Furniture', 'Home Improvement', 'Household Items'],
  },
  {
    name: 'Family', type: 'Expense',
    subcategories: ['Kids', 'Parents', 'Gifts', 'Celebrations', 'Marriage / Events'],
  },
  {
    name: 'Finance', type: 'Expense',
    subcategories: ['Loan EMI', 'Credit Card Payment', 'Insurance Premium', 'Bank Charges', 'Tax'],
  },
  {
    name: 'Investments', type: 'Expense',
    subcategories: ['SIP', 'Stocks', 'FD / RD', 'Gold', 'PPF / NPS'],
  },
  {
    name: 'Miscellaneous', type: 'Expense',
    subcategories: ['Other', 'Donations / Charity', 'Religious'],
  },

  // ── Income ───────────────────────────────────────────────────────────────
  {
    name: 'Salary', type: 'Income',
    subcategories: ['Monthly Salary', 'Bonus', 'Arrears', 'Incentives'],
  },
  {
    name: 'Business', type: 'Income',
    subcategories: ['Revenue', 'Consulting', 'Freelance'],
  },
  {
    name: 'Investment Returns', type: 'Income',
    subcategories: ['Dividends', 'Capital Gains', 'Interest Income', 'Rental Income'],
  },
  {
    name: 'Other Income', type: 'Income',
    subcategories: ['Gifts Received', 'Cashback / Rewards', 'Refunds', 'Miscellaneous'],
  },
];
