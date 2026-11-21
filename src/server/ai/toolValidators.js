/**
 * src/server/ai/toolValidators.js
 *
 * Strict Server-Side Tool Argument Validators and Result Formatters.
 */

import { ALLOWED_TOOL_NAMES } from './toolSchemas.js';

export class ToolValidationError extends Error {
  constructor(message, code = 'INVALID_TOOL_ARGUMENT') {
    super(`[${code}] ${message}`);
    this.name = 'ToolValidationError';
    this.code = code;
  }
}

export function validatePeriod(period) {
  if (!period || typeof period !== 'string') return 'this_month';
  const clean = period.trim().toLowerCase();
  if (clean === 'this_month' || clean === 'last_month') return clean;
  if (/^\d{4}-\d{2}$/.test(clean)) return clean;
  return 'this_month';
}

export function sanitizeSearchString(str) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().replace(/[<>'"\\]/g, '').slice(0, 100);
}

export function validateToolInvocation(toolName, rawArgs = {}) {
  if (!toolName || typeof toolName !== 'string') {
    throw new ToolValidationError('Tool name must be a non-empty string.', 'MISSING_TOOL_NAME');
  }

  if (!ALLOWED_TOOL_NAMES.has(toolName)) {
    throw new ToolValidationError(
      `Tool "${toolName}" is not registered or permitted in the synthetic financial registry.`,
      'UNAUTHORIZED_TOOL'
    );
  }

  const args = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {};

  switch (toolName) {
    case 'getFinancialSummary':
    case 'getMonthlyCashFlow':
      return {
        period: validatePeriod(args.period)
      };

    case 'getAccountBalances':
    case 'getInvestmentHoldings':
    case 'getPortfolioSummary':
    case 'getLiabilities':
      return {}; // No arguments allowed

    case 'getCategorySpending': {
      if (!args.category || typeof args.category !== 'string' || !args.category.trim()) {
        throw new ToolValidationError('getCategorySpending requires a non-empty "category" parameter.', 'MISSING_CATEGORY');
      }
      return {
        category: sanitizeSearchString(args.category),
        period: validatePeriod(args.period)
      };
    }

    case 'getTopExpenseCategories': {
      let limit = parseInt(args.limit, 10);
      if (isNaN(limit) || limit < 1) limit = 5;
      if (limit > 10) limit = 10;
      return {
        period: validatePeriod(args.period),
        limit
      };
    }

    case 'searchTransactions': {
      const category = sanitizeSearchString(args.category);
      const account = sanitizeSearchString(args.account);
      const searchTerm = sanitizeSearchString(args.searchTerm);
      const type = (args.type && ['Income', 'Expense', 'Transfer-Out'].includes(args.type)) ? args.type : null;

      let minAmount = undefined;
      let maxAmount = undefined;
      if (args.minAmount !== undefined && !isNaN(Number(args.minAmount))) {
        minAmount = Math.max(0, Number(args.minAmount));
      }
      if (args.maxAmount !== undefined && !isNaN(Number(args.maxAmount))) {
        maxAmount = Math.max(0, Number(args.maxAmount));
      }

      let limit = parseInt(args.limit, 10);
      if (isNaN(limit) || limit < 1) limit = 5;
      if (limit > 15) limit = 15;

      let offset = parseInt(args.offset, 10);
      if (isNaN(offset) || offset < 0) offset = 0;

      const hasFilter = Boolean(category || account || searchTerm || type || minAmount !== undefined || maxAmount !== undefined || args.startDate || args.endDate);
      if (!hasFilter) {
        throw new ToolValidationError('searchTransactions requires at least one search filter (e.g. category, account, type, or searchTerm). Unbounded searches are blocked.', 'UNFILTERED_SEARCH_BLOCKED');
      }

      return {
        category: category || null,
        account: account || null,
        type: type || null,
        searchTerm: searchTerm || null,
        startDate: args.startDate || null,
        endDate: args.endDate || null,
        minAmount,
        maxAmount,
        limit,
        offset
      };
    }

    default:
      throw new ToolValidationError(`Unsupported tool validation for "${toolName}".`, 'UNHANDLED_TOOL');
  }
}

/**
 * Ensures safe bounded items in arrays returned by tools.
 */
export function formatSafeToolResult(rawResult, maxItems = 15) {
  if (!rawResult || typeof rawResult !== 'object') {
    return { data: rawResult };
  }

  const result = { ...rawResult };
  for (const [key, val] of Object.entries(result)) {
    if (Array.isArray(val) && val.length > maxItems) {
      result[key] = val.slice(0, maxItems);
      result[`_pagination_${key}`] = {
        isTruncated: true,
        totalItems: val.length,
        returnedItems: maxItems,
        note: `Displaying top ${maxItems} of ${val.length} items.`
      };
    }
  }

  return result;
}

