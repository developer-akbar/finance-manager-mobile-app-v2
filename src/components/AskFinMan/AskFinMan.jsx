/**
 * src/components/AskFinMan/AskFinMan.jsx
 *
 * FinMan AI Assistant (Phase OAI-1: OpenAI POC).
 * Natural-language personal finance assistant operating in Synthetic Demo Mode.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { sendAiChatMessage } from '../../services/aiChatService.js';
import SafeMarkdown from './SafeMarkdown.jsx';
import ToolExecutionAccordion from './ToolExecutionAccordion.jsx';
import DiagnosticPanel from './DiagnosticPanel.jsx';
import './AskFinMan.css';

const SUGGESTED_QUESTIONS = [
  'Show me my account balances.',
  'How much did I spend last month?',
  'Which are my top three expense categories?',
  'Show my monthly income and expenses.',
  'What investments do I currently hold?',
  'Compare my income and expenses over the last three months.',
  'Find transactions related to groceries.'
];

export default function AskFinMan({ onBack }) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [errorMsg, setErrorMsg] = useState(null);
  const [latestMetrics, setLatestMetrics] = useState(null);
  const [sessionCost, setSessionCost] = useState(0);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const abortControllerRef = useRef(null);
  const timerRef = useRef(null);

  // Auto-scroll to bottom of chat
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, scrollToBottom]);

  // Handle Send
  const handleSendMessage = useCallback(async (queryText) => {
    const query = typeof queryText === 'string' ? queryText.trim() : inputText.trim();
    if (!query || isLoading) return;

    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setErrorMsg(null);

    const userMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: query,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    setElapsedSec(0);

    // Start elapsed timer
    const startTimestamp = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startTimestamp) / 1000));
    }, 500);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      // Build conversation history (excluding initial system)
      const history = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));

      const result = await sendAiChatMessage(query, {
        history,
        useDeterministicBypass: true,
        signal: abortController.signal
      });

      const assistantMessage = {
        id: `asst_${Date.now()}`,
        role: 'assistant',
        content: result.answer,
        toolCalls: result.toolCalls || [],
        metrics: result.metrics || null,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      setMessages(prev => [...prev, assistantMessage]);
      if (result.metrics) {
        setLatestMetrics(result.metrics);
        setSessionCost(prev => prev + Number(result.metrics.estimatedCostUsd || 0));
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setMessages(prev => [
          ...prev,
          {
            id: `asst_${Date.now()}`,
            role: 'assistant',
            content: '*(Request cancelled by user)*',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }
        ]);
      } else {
        setErrorMsg(err.message || 'Failed to communicate with AI Assistant.');
      }
    } finally {
      clearInterval(timerRef.current);
      timerRef.current = null;
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  }, [inputText, isLoading, messages]);

  const handleCancel = () => {
    abortControllerRef.current?.abort();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleTextareaChange = (e) => {
    setInputText(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  return (
    <div className="ask-finman-screen">
      {/* Header */}
      <div className="ask-finman-header">
        <div className="ask-finman-title-group">
          {onBack && (
            <button type="button" className="ask-finman-back-btn" onClick={onBack}>
              ←
            </button>
          )}
          <div>
            <h2 className="ask-finman-title">✨ Ask FinMan</h2>
            <div className="ask-finman-subtitle">OpenAI Assistant POC (Phase OAI-1)</div>
          </div>
        </div>
        <div className="ask-finman-demo-tag">
          <span className="demo-dot" />
          Synthetic Demo Mode
        </div>
      </div>

      {/* Safety Notice Banner */}
      <div className="ask-finman-safety-banner">
        🔒 <strong>Isolated Demo Environment:</strong> Operating exclusively on synthetic test records. Zero access to personal financial repositories or device storage.
      </div>

      {/* Diagnostic Metrics Strip */}
      {latestMetrics && (
        <DiagnosticPanel metrics={latestMetrics} sessionCost={sessionCost} />
      )}

      {/* Messages Scroll Area */}
      <div className="ask-finman-messages-container">
        {messages.length === 0 ? (
          <div className="ask-finman-welcome">
            <div className="welcome-icon">💡</div>
            <h3>How can I help with your finances today?</h3>
            <p>
              Ask any natural-language question about balances, monthly cash flow, categories, or investments.
            </p>

            <div className="suggested-queries-label">Suggested Demo Queries:</div>
            <div className="suggested-queries-grid">
              {SUGGESTED_QUESTIONS.map((q, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="suggested-query-chip"
                  onClick={() => handleSendMessage(q)}
                  disabled={isLoading}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className={`message-bubble-wrapper ${msg.role}`}>
              <div className="message-bubble">
                <div className="message-content">
                  <SafeMarkdown content={msg.content} />
                </div>

                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <ToolExecutionAccordion toolCalls={msg.toolCalls} />
                )}

                <div className="message-footer">
                  <span className="message-time">{msg.timestamp}</span>
                </div>
              </div>
            </div>
          ))
        )}

        {/* Loading Spinner */}
        {isLoading && (
          <div className="message-bubble-wrapper assistant loading">
            <div className="message-bubble loading-bubble">
              <div className="loading-spinner-row">
                <span className="loading-spinner" />
                <span className="loading-text">
                  Consulting FinMan AI... ({elapsedSec}s)
                </span>
                <button type="button" className="cancel-inference-btn" onClick={handleCancel}>
                  Stop
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error Banner */}
        {errorMsg && (
          <div className="ask-finman-error-card">
            <span className="error-icon">⚠️</span>
            <div className="error-text">{errorMsg}</div>
            <button
              type="button"
              className="error-dismiss-btn"
              onClick={() => setErrorMsg(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Chat Input Bar */}
      <div className="ask-finman-input-bar">
        <textarea
          ref={textareaRef}
          className="ask-finman-textarea"
          placeholder="Ask a financial question... (e.g. 'Show me my account balances')"
          value={inputText}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          rows={1}
        />
        <button
          type="button"
          className="ask-finman-send-btn"
          onClick={() => handleSendMessage()}
          disabled={isLoading || !inputText.trim()}
          aria-label="Send message"
        >
          {isLoading ? '⏳' : '➔'}
        </button>
      </div>
    </div>
  );
}

