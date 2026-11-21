/**
 * src/server/ai/adapters/OpenAIProviderAdapter.js
 *
 * Official OpenAI SDK Provider Adapter for FinMan (Phase OAI-1).
 */

import OpenAI from 'openai';
import { AIProviderAdapter } from './AIProviderAdapter.js';
import { DEFAULT_MODEL } from '../config.js';

export class OpenAIProviderAdapter extends AIProviderAdapter {
  constructor(options = {}) {
    super();
    let key = options.apiKey || process.env.OPENAI_API_KEY || '';
    if (key) {
      key = key.trim();
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
        key = key.slice(1, -1).trim();
      }
    }
    this.apiKey = key;
    this.model = options.model || process.env.OPENAI_MODEL || DEFAULT_MODEL;

    // Support injected client for unit testing
    if (options.client) {
      this.client = options.client;
    } else if (this.apiKey) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        timeout: options.timeoutMs || 25000,
        maxRetries: 0
      });
    } else {
      this.client = null;
    }
  }

  /**
   * Generates response via OpenAI chat completions API with tool calling.
   */
  async generateResponse({ messages = [], tools = [], temperature = 0.2, maxTokens = 600 }) {
    if (!this.client) {
      throw new Error('[OPENAI_CONFIG_ERROR] OpenAI API key is missing or not configured on server.');
    }

    try {
      const requestPayload = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens
      };

      if (Array.isArray(tools) && tools.length > 0) {
        requestPayload.tools = tools;
        requestPayload.tool_choice = 'auto';
      }

      const completion = await this.client.chat.completions.create(requestPayload);
      const choice = completion.choices?.[0];
      const message = choice?.message || {};

      const toolCalls = (message.tool_calls || []).map(tc => {
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(tc.function?.arguments || '{}');
        } catch (parseErr) {
          parsedArgs = { _raw: tc.function?.arguments, parseError: parseErr.message };
        }
        return {
          id: tc.id,
          name: tc.function?.name,
          arguments: parsedArgs
        };
      });

      return {
        content: message.content || null,
        toolCalls,
        rawMessage: message,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0
        },
        model: completion.model || this.model
      };
    } catch (err) {
      // Sanitize OpenAI error to avoid exposing API keys or internals
      const status = err.status || err.statusCode || 500;
      let safeMessage = err.message || 'OpenAI API request failed';

      if (status === 401) {
        safeMessage = 'OpenAI authentication failed: Invalid API key.';
      } else if (status === 429) {
        safeMessage = 'OpenAI rate limit exceeded or insufficient API credit quota.';
      } else if (status === 400) {
        safeMessage = `OpenAI bad request: ${err.message}`;
      }

      const error = new Error(`[OPENAI_API_ERROR] ${safeMessage}`);
      error.status = status;
      error.code = err.code || 'OPENAI_REQUEST_FAILED';
      throw error;
    }
  }
}

