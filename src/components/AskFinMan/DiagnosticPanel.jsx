/**
 * src/components/AskFinMan/DiagnosticPanel.jsx
 *
 * Development-only metrics panel displaying latency, token usage, and API costs.
 */

import React, { useState } from 'react';

export default function DiagnosticPanel({ metrics = null, sessionCost = 0 }) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!metrics) return null;

  return (
    <div className="diagnostic-panel-container">
      <div className="diagnostic-panel-header" onClick={() => setIsExpanded(prev => !prev)}>
        <div className="diagnostic-summary-chips">
          <span className="diag-chip">🤖 {metrics.model}</span>
          <span className="diag-chip">⏱️ {(metrics.durationMs / 1000).toFixed(2)}s</span>
          <span className="diag-chip">📊 {metrics.totalTokens || 0} tokens</span>
          <span className="diag-chip cost-chip">💵 ${Number(metrics.estimatedCostUsd || 0).toFixed(6)}</span>
        </div>
        <button type="button" className="diag-toggle-btn">
          {isExpanded ? 'Hide Diagnostics' : 'Metrics'}
        </button>
      </div>

      {isExpanded && (
        <div className="diagnostic-panel-details">
          <div className="diag-grid">
            <div className="diag-stat">
              <span className="diag-label">Total Duration</span>
              <span className="diag-val">{metrics.durationMs} ms</span>
            </div>
            <div className="diag-stat">
              <span className="diag-label">Tool Execution</span>
              <span className="diag-val">{metrics.toolDurationMs || 0} ms</span>
            </div>
            <div className="diag-stat">
              <span className="diag-label">Prompt Tokens</span>
              <span className="diag-val">{metrics.promptTokens || 0}</span>
            </div>
            <div className="diag-stat">
              <span className="diag-label">Completion Tokens</span>
              <span className="diag-val">{metrics.completionTokens || 0}</span>
            </div>
            <div className="diag-stat">
              <span className="diag-label">Query Cost</span>
              <span className="diag-val">${Number(metrics.estimatedCostUsd || 0).toFixed(6)}</span>
            </div>
            <div className="diag-stat">
              <span className="diag-label">Session Est. Cost</span>
              <span className="diag-val">${Number(sessionCost || 0).toFixed(6)}</span>
            </div>
          </div>
          <div className="diag-footer-note">
            * Cost calculated using official OpenAI gpt-4o-mini pricing ($0.15/1M input, $0.60/1M output).
          </div>
        </div>
      )}
    </div>
  );
}

