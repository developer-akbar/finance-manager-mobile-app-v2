/**
 * src/components/AskFinMan/ToolExecutionAccordion.jsx
 *
 * Collapsible section displaying synthetic tool executions for transparency.
 */

import React, { useState } from 'react';

const TOOL_DISPLAY_NAMES = {
  getFinancialSummary: 'Financial Summary',
  getAccountBalances: 'Account Balances',
  getMonthlyCashFlow: 'Monthly Cash Flow',
  getCategorySpending: 'Category Spending',
  getTopExpenseCategories: 'Top Expense Categories',
  getInvestmentHoldings: 'Investment Holdings',
  getPortfolioSummary: 'Portfolio Summary',
  getLiabilities: 'Outstanding Liabilities',
  searchTransactions: 'Search Transactions'
};

export default function ToolExecutionAccordion({ toolCalls = [] }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
    return null;
  }

  return (
    <div className="tool-accordion-container">
      <button
        type="button"
        className="tool-accordion-toggle"
        onClick={() => setIsOpen(prev => !prev)}
        aria-expanded={isOpen}
      >
        <span className="tool-accordion-badge">⚡ {toolCalls.length} tool{toolCalls.length === 1 ? '' : 's'} executed</span>
        <span className="tool-accordion-summary">
          {toolCalls.map(tc => TOOL_DISPLAY_NAMES[tc.name] || tc.name).join(', ')}
        </span>
        <span className="tool-accordion-arrow">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="tool-accordion-body">
          {toolCalls.map((tc, idx) => (
            <div key={idx} className="tool-call-item">
              <div className="tool-call-header">
                <span className="tool-call-name">🔧 {TOOL_DISPLAY_NAMES[tc.name] || tc.name}</span>
                {tc.durationMs !== undefined && (
                  <span className="tool-call-duration">{tc.durationMs}ms</span>
                )}
              </div>

              {tc.args && Object.keys(tc.args).length > 0 && (
                <div className="tool-call-section">
                  <span className="tool-call-section-label">Parameters:</span>
                  <pre className="tool-call-json">{JSON.stringify(tc.args, null, 2)}</pre>
                </div>
              )}

              {tc.error ? (
                <div className="tool-call-error">⚠️ Error: {tc.error}</div>
              ) : (
                <div className="tool-call-section">
                  <span className="tool-call-section-label">Authoritative Result (Synthetic):</span>
                  <pre className="tool-call-json">{JSON.stringify(tc.result, null, 2)}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

