/**
 * src/server/ai/toolSchemas.js
 *
 * Strict OpenAI function/tool declarations for FinMan Synthetic Financial Tools.
 */

export const OPENAI_TOOL_DECLARATIONS = [
  {
    type: 'function',
    function: {
      name: 'getFinancialSummary',
      description: 'Get high-level financial summary (income, expenses, net savings, savings rate) for a given period.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Reporting period: "this_month", "last_month", or specific month "YYYY-MM" (e.g. "2026-10")',
            default: 'this_month'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getAccountBalances',
      description: 'Get current balances across all accounts (Bank Accounts, Investments, Credit Cards, Cash Wallets) and calculate Net Worth, Total Assets, and Total Liabilities.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getMonthlyCashFlow',
      description: 'Get monthly cash flow metrics including daily burn rate, surplus or deficit, and pacing.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Reporting period: "this_month", "last_month", or specific month "YYYY-MM"',
            default: 'this_month'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getCategorySpending',
      description: 'Get total amount spent and transaction breakdown for a specific expense category.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Name of the expense category (e.g. "Groceries", "Dining", "Rent", "Utilities", "Shopping")'
          },
          period: {
            type: 'string',
            description: 'Reporting period: "this_month", "last_month", or "YYYY-MM"',
            default: 'this_month'
          }
        },
        required: ['category'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getTopExpenseCategories',
      description: 'Get the top spending categories ranked by total expense amount with percentage of total spending.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Reporting period: "this_month", "last_month", or "YYYY-MM"',
            default: 'this_month'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of top categories to return (between 1 and 10)',
            default: 5
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getInvestmentHoldings',
      description: 'Get detailed individual investment holdings (stocks and mutual funds) with invested cost, current market value, and returns.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getPortfolioSummary',
      description: 'Get overall investment portfolio summary (total invested, total current value, overall gain/loss, asset allocation between Equity and Mutual Funds).',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getLiabilities',
      description: 'Get outstanding credit card debts, payable amounts, and personal liabilities.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'searchTransactions',
      description: 'Search and filter transactions by category, account, type, search term, or amount range. Requires at least one search filter.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category name' },
          account: { type: 'string', description: 'Filter by account name' },
          type: { type: 'string', enum: ['Income', 'Expense', 'Transfer-Out'], description: 'Transaction type' },
          searchTerm: { type: 'string', description: 'Keyword search in note, description, or subcategory' },
          startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
          endDate: { type: 'string', description: 'End date in YYYY-MM-DD format' },
          minAmount: { type: 'number', description: 'Minimum transaction amount in INR' },
          maxAmount: { type: 'number', description: 'Maximum transaction amount in INR' },
          limit: { type: 'integer', description: 'Maximum number of transactions to return (1-15, default 5)', default: 5 },
          offset: { type: 'integer', description: 'Pagination offset', default: 0 }
        },
        additionalProperties: false
      }
    }
  }
];

export const ALLOWED_TOOL_NAMES = new Set(OPENAI_TOOL_DECLARATIONS.map(t => t.function.name));

