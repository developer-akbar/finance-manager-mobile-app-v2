/**
 * src/server/ai/orchestrator.js
 *
 * Server-Side Tool-Calling Orchestrator for FinMan OpenAI POC (Phase OAI-1).
 */

import { OPENAI_TOOL_DECLARATIONS, ALLOWED_TOOL_NAMES } from './toolSchemas.js';
import { executeSyntheticTool, formatDeterministicAnswer } from './syntheticToolRegistry.js';
import { calculateEstimatedCost, getAiConfig } from './config.js';

export const SYSTEM_PROMPT = `You are FinMan Assistant, an intelligent personal finance assistant operating in Synthetic Demo Mode.
You have access to 9 read-only synthetic financial tools:
- getFinancialSummary(period: "this_month"|"last_month"|"YYYY-MM")
- getAccountBalances()
- getMonthlyCashFlow(period: "this_month"|"last_month"|"YYYY-MM")
- getCategorySpending(category: string, period?: string)
- getTopExpenseCategories(period?: string, limit?: number)
- getInvestmentHoldings()
- getPortfolioSummary()
- getLiabilities()
- searchTransactions(category?, account?, type?, searchTerm?, minAmount?, maxAmount?, limit?, offset?)

CRITICAL RULES:
1. You have ZERO pre-existing knowledge of user balances, transactions, or accounts.
2. For ANY question regarding balances, spending, transactions, cash flow, investments, or debts, you MUST call the appropriate tool.
3. All financial amounts MUST be presented in Indian Rupees (INR) using the "₹" symbol and Indian numbering format (e.g. ₹1,50,000, ₹35,000, -₹4,941). Never use "$" or generic notation.
4. Keep answers concise, factual, and strictly faithful to the numbers returned by tools. Never recalculate or invent financial numbers.
5. All underlying data is synthetic demonstration data. Clearly mention this is Demo Mode if asked.`;

/**
 * Orchestrates a multi-turn tool-calling conversation with OpenAI.
 *
 * @param {string} userMessage The user's natural language question
 * @param {Object} options
 * @param {Array} [options.history] Previous messages (bounded)
 * @param {Object} options.adapter OpenAIProviderAdapter instance
 * @param {boolean} [options.useDeterministicBypass] If true, formats simple balance/summary queries directly
 * @returns {Promise<Object>} Formatted response with answer, toolCalls, and metrics
 */
export async function orchestrateAiChat(userMessage, options = {}) {
  const startTime = Date.now();
  const config = getAiConfig();
  const adapter = options.adapter;

  if (!adapter) {
    throw new Error('AI provider adapter is required for orchestration.');
  }

  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    throw new Error('User message must be a non-empty string.');
  }

  const cleanQuery = userMessage.trim().slice(0, config.maxInputChars);

  // Build bounded message history
  const rawHistory = Array.isArray(options.history) ? options.history : [];
  const boundedHistory = rawHistory
    .slice(-config.maxHistoryMessages)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({
      role: m.role,
      content: m.content.slice(0, config.maxInputChars)
    }));

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...boundedHistory,
    { role: 'user', content: cleanQuery }
  ];

  let loopCount = 0;
  const maxCalls = config.maxToolCalls;
  const recordedToolCalls = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let toolExecutionDurationMs = 0;
  let finalAnswer = null;
  let selectedModel = config.model;

  while (loopCount < maxCalls && !finalAnswer) {
    loopCount++;

    const response = await adapter.generateResponse({
      messages,
      tools: OPENAI_TOOL_DECLARATIONS,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens
    });

    if (response.model) selectedModel = response.model;
    if (response.usage) {
      totalPromptTokens += response.usage.promptTokens || 0;
      totalCompletionTokens += response.usage.completionTokens || 0;
    }

    // ── Case 1: Direct Text Completion (No tool calls) ──
    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalAnswer = response.content || 'I processed your request, but no response was generated.';
      break;
    }

    // ── Case 2: Tool Call(s) returned by model ──
    // Append assistant's message with tool_calls to conversation history
    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.rawMessage?.tool_calls || response.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments)
        }
      }))
    });

    // Execute each tool call
    for (const toolCall of response.toolCalls) {
      const toolName = toolCall.name;
      const toolStart = Date.now();

      let toolResult;
      let toolError = null;

      // Guard: enforce total tool call execution limit
      if (recordedToolCalls.length >= maxCalls) {
        toolError = `Execution skipped: maximum tool call limit (${maxCalls}) reached.`;
        toolResult = { error: toolError, isDemoData: true };
      } else {
        // Guard: deduplicate identical tool call with same arguments
        const argsStr = JSON.stringify(toolCall.arguments || {});
        const isDuplicate = recordedToolCalls.some(tc => tc.name === toolName && JSON.stringify(tc.args || {}) === argsStr);
        if (isDuplicate) {
          toolError = `Execution skipped: duplicate tool call "${toolName}" with identical arguments.`;
          toolResult = { error: toolError, isDemoData: true };
        } else {
          try {
            if (!ALLOWED_TOOL_NAMES.has(toolName)) {
              throw new Error(`Tool "${toolName}" is not permitted or does not exist in the synthetic registry.`);
            }
            toolResult = executeSyntheticTool(toolName, toolCall.arguments);
          } catch (err) {
            toolError = err.message;
            toolResult = { error: err.message, isDemoData: true };
          }
        }
      }

      const toolDuration = Date.now() - toolStart;
      toolExecutionDurationMs += toolDuration;

      recordedToolCalls.push({
        id: toolCall.id,
        name: toolName,
        args: toolCall.arguments,
        result: toolResult,
        error: toolError,
        durationMs: toolDuration
      });

      // Append tool result message in OpenAI format
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult)
      });
    }

    if (recordedToolCalls.length >= maxCalls) {
      break;
    }

    // Evaluate Deterministic Formatting optimization:
    // If exactly 1 tool was invoked and it's a direct financial status inquiry,
    // we can return the 100% authoritative formatted figure without a second model call.
    if (options.useDeterministicBypass !== false && response.toolCalls.length === 1 && !recordedToolCalls[0].error) {
      const primaryTool = recordedToolCalls[0];
      const deterministicText = formatDeterministicAnswer(primaryTool.name, primaryTool.result);
      if (deterministicText) {
        finalAnswer = deterministicText;
        break;
      }
    }
  }

  // If the loop finished with tool calls but no final answer yet, do one final synthesis
  if (!finalAnswer) {
    const finalResponse = await adapter.generateResponse({
      messages,
      tools: [], // No more tool calls on final pass
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens
    });

    if (finalResponse.usage) {
      totalPromptTokens += finalResponse.usage.promptTokens || 0;
      totalCompletionTokens += finalResponse.usage.completionTokens || 0;
    }
    finalAnswer = finalResponse.content || 'Completed processing your request.';
  }

  const totalDurationMs = Date.now() - startTime;
  const totalTokens = totalPromptTokens + totalCompletionTokens;
  const estimatedCostUsd = calculateEstimatedCost(selectedModel, {
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens
  });

  return {
    answer: finalAnswer,
    toolCalls: recordedToolCalls,
    metrics: {
      durationMs: totalDurationMs,
      toolDurationMs: toolExecutionDurationMs,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens,
      estimatedCostUsd,
      model: selectedModel,
      isDemoData: true,
      timestamp: new Date().toISOString()
    }
  };
}

