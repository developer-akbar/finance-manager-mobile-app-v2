/**
 * src/tests/openai_orchestrator.test.js
 *
 * Automated Test Suite for FinMan Phase OAI-1: OpenAI Tool-Calling Orchestrator.
 * Fully isolated: Uses mocked AI Provider Adapter to verify multi-turn tool calling
 * without making network requests or consuming OpenAI credits.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestrateAiChat } from '../server/ai/orchestrator.js';
import { checkRateLimit, resetRateLimiter } from '../server/ai/rateLimiter.js';
import { calculateEstimatedCost } from '../server/ai/config.js';

class MockAIAdapter {
  constructor(cannedResponses = []) {
    this.responses = [...cannedResponses];
    this.calls = [];
  }

  async generateResponse(options) {
    this.calls.push(options);
    if (this.responses.length === 0) {
      return {
        content: 'Default mock answer',
        toolCalls: [],
        usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
        model: 'gpt-4o-mini'
      };
    }
    const next = this.responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

test('FinMan Phase OAI-1 — OpenAI Orchestrator Suite', async (t) => {

  await t.test('1. Normal final answer without tool calls', async () => {
    const adapter = new MockAIAdapter([
      {
        content: 'Compound interest is interest calculated on the initial principal and accumulated interest.',
        toolCalls: [],
        usage: { promptTokens: 80, completionTokens: 25, totalTokens: 105 },
        model: 'gpt-4o-mini'
      }
    ]);

    const result = await orchestrateAiChat('What is compound interest?', { adapter });
    assert.ok(result.answer.includes('Compound interest'));
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.metrics.promptTokens, 80);
    assert.equal(result.metrics.completionTokens, 25);
    assert.ok(result.metrics.estimatedCostUsd > 0);
  });

  await t.test('2. Single tool call with deterministic bypass for balance inquiry', async () => {
    const adapter = new MockAIAdapter([
      {
        content: null,
        toolCalls: [
          {
            id: 'call_bal_1',
            name: 'getAccountBalances',
            arguments: {}
          }
        ],
        usage: { promptTokens: 120, completionTokens: 15, totalTokens: 135 },
        model: 'gpt-4o-mini'
      }
    ]);

    const result = await orchestrateAiChat('Show me my account balances', { adapter });

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'getAccountBalances');
    assert.ok(result.answer.includes('₹11,44,200'), 'Authoritative Net Worth rendered');
    assert.ok(result.answer.includes('₹11,68,150'), 'Authoritative Total Assets rendered');
    // Verifies that with deterministic bypass, only 1 turn occurred
    assert.equal(adapter.calls.length, 1);
  });

  await t.test('3. Multi-turn tool calling without deterministic bypass', async () => {
    const adapter = new MockAIAdapter([
      // Turn 1: Model asks for category spending
      {
        content: null,
        toolCalls: [
          {
            id: 'call_cat_1',
            name: 'getCategorySpending',
            arguments: { category: 'Groceries', period: 'this_month' }
          }
        ],
        usage: { promptTokens: 150, completionTokens: 20, totalTokens: 170 },
        model: 'gpt-4o-mini'
      },
      // Turn 2: Model synthesizes final conversational answer from tool result
      {
        content: 'You have spent ₹6,800 on Groceries so far in November 2026 across 1 supermarket transaction.',
        toolCalls: [],
        usage: { promptTokens: 210, completionTokens: 30, totalTokens: 240 },
        model: 'gpt-4o-mini'
      }
    ]);

    const result = await orchestrateAiChat('How much did I spend on groceries this month?', {
      adapter,
      useDeterministicBypass: false
    });

    assert.equal(adapter.calls.length, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'getCategorySpending');
    assert.ok(result.answer.includes('₹6,800'));
    assert.equal(result.metrics.promptTokens, 360); // 150 + 210
    assert.equal(result.metrics.completionTokens, 50); // 20 + 30
  });

  await t.test('4. Multiple tool calls in single model turn', async () => {
    const adapter = new MockAIAdapter([
      {
        content: null,
        toolCalls: [
          {
            id: 'call_sum_1',
            name: 'getFinancialSummary',
            arguments: { period: 'this_month' }
          },
          {
            id: 'call_liab_1',
            name: 'getLiabilities',
            arguments: {}
          }
        ],
        usage: { promptTokens: 180, completionTokens: 35, totalTokens: 215 },
        model: 'gpt-4o-mini'
      },
      {
        content: 'In November, your income is ₹1,50,000 and total outstanding credit card debt is ₹23,950.',
        toolCalls: [],
        usage: { promptTokens: 300, completionTokens: 40, totalTokens: 340 },
        model: 'gpt-4o-mini'
      }
    ]);

    const result = await orchestrateAiChat('Give me my summary and total debts', { adapter });

    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, 'getFinancialSummary');
    assert.equal(result.toolCalls[1].name, 'getLiabilities');
    assert.ok(result.answer.includes('₹1,50,000'));
    assert.ok(result.answer.includes('₹23,950'));
  });

  await t.test('5. Unknown tool name handled gracefully without fabrication', async () => {
    const adapter = new MockAIAdapter([
      {
        content: null,
        toolCalls: [
          {
            id: 'call_bad_1',
            name: 'getUnknownSecretData',
            arguments: {}
          }
        ],
        usage: { promptTokens: 100, completionTokens: 15, totalTokens: 115 },
        model: 'gpt-4o-mini'
      },
      {
        content: 'I attempted to query that data, but the tool is not permitted in the registry.',
        toolCalls: [],
        usage: { promptTokens: 160, completionTokens: 25, totalTokens: 185 },
        model: 'gpt-4o-mini'
      }
    ]);

    const result = await orchestrateAiChat('Query unauthorized database table', { adapter });

    assert.equal(result.toolCalls.length, 1);
    assert.ok(result.toolCalls[0].error.includes('not permitted'));
    assert.ok(result.answer.includes('not permitted'));
  });

  await t.test('6. Bounded Tool Iteration Limit (Max 3)', async () => {
    // Model repeatedly attempts tool calls indefinitely
    const adapter = new MockAIAdapter([
      { content: null, toolCalls: [{ id: '1', name: 'getLiabilities', arguments: {} }] },
      { content: null, toolCalls: [{ id: '2', name: 'getLiabilities', arguments: {} }] },
      { content: null, toolCalls: [{ id: '3', name: 'getLiabilities', arguments: {} }] },
      { content: 'Final response after loop boundary reached.', toolCalls: [] }
    ]);

    const result = await orchestrateAiChat('Loop test', {
      adapter,
      useDeterministicBypass: false
    });

    assert.ok(adapter.calls.length <= 4);
    assert.ok(result.toolCalls.length <= 3);
  });

  await t.test('7. API Error Handling: Throws sanitized error when OpenAI rejects request', async () => {
    const error = new Error('[OPENAI_API_ERROR] OpenAI authentication failed: Invalid API key.');
    error.status = 401;
    const adapter = new MockAIAdapter([error]);

    await assert.rejects(
      () => orchestrateAiChat('Hello', { adapter }),
      /OpenAI authentication failed/
    );
  });

  await t.test('8. Rate Limiter: Blocks excessive requests from same IP', () => {
    resetRateLimiter();
    const testIp = '192.168.1.100';

    for (let i = 0; i < 20; i++) {
      const res = checkRateLimit(testIp);
      assert.equal(res.allowed, true);
    }

    // 21st request exceeds rate limit
    const blocked = checkRateLimit(testIp);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec > 0);
  });

  await t.test('9. Pricing Calculator: Correctly computes official gpt-4o-mini costs', () => {
    // 10,000 prompt tokens = 10,000 * 0.00000015 = $0.0015
    // 1,000 completion tokens = 1,000 * 0.00000060 = $0.0006
    // Total = $0.0021
    const cost = calculateEstimatedCost('gpt-4o-mini', {
      promptTokens: 10000,
      completionTokens: 1000
    });
    assert.equal(cost, 0.0021);
  });

  await t.test('10. Deduplication: Identical tool calls in same request are safely deduplicated', async () => {
    const adapter = new MockAIAdapter([
      {
        content: null,
        toolCalls: [
          { id: 'call_dup_1', name: 'getAccountBalances', arguments: {} },
          { id: 'call_dup_2', name: 'getAccountBalances', arguments: {} }
        ],
        usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 }
      },
      {
        content: 'Your account balance summary was processed.',
        toolCalls: [],
        usage: { promptTokens: 80, completionTokens: 15, totalTokens: 95 }
      }
    ]);

    const result = await orchestrateAiChat('Check balances', {
      adapter,
      useDeterministicBypass: false
    });

    assert.equal(result.toolCalls.length, 2);
    // First executed successfully
    assert.equal(result.toolCalls[0].error, null);
    assert.equal(result.toolCalls[0].result.accounts.length, 6);
    // Second call was deduplicated without crashing or re-executing
    assert.match(result.toolCalls[1].error, /duplicate tool call/i);
  });

  await t.test('11. OpenAIProviderAdapter: Configures maxRetries: 0 to prevent silent retry costs', async () => {
    const { OpenAIProviderAdapter } = await import('../server/ai/adapters/OpenAIProviderAdapter.js');
    const adapter = new OpenAIProviderAdapter({ apiKey: 'sk-test-mock-key' });
    assert.ok(adapter.client);
    assert.equal(adapter.client.maxRetries, 0);
  });

});

