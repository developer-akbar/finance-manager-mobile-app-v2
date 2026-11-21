/**
 * src/server/ai/chatController.js
 *
 * Universal request handler for OpenAI Ask FinMan chat requests.
 * Shared between Vite dev server middleware and Vercel serverless functions.
 */

import { OpenAIProviderAdapter } from './adapters/OpenAIProviderAdapter.js';
import { orchestrateAiChat } from './orchestrator.js';
import { checkRateLimit } from './rateLimiter.js';
import { getAiConfig } from './config.js';

export async function handleChatRequest(req, res) {
  // Extract client IP
  const clientIp = req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

  // 1. Rate Limiting Check
  const rateLimit = checkRateLimit(String(clientIp));
  if (!rateLimit.allowed) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: `Rate limit exceeded. Please wait ${rateLimit.retryAfterSec} seconds before sending another message.`,
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterSec: rateLimit.retryAfterSec
    }));
    return;
  }

  // 2. HTTP Method Check
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST.', code: 'METHOD_NOT_ALLOWED' }));
    return;
  }

  // 3. Configuration Check
  const config = getAiConfig();
  if (!config.hasApiKey) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'OpenAI API key is not configured on the server. Please set OPENAI_API_KEY in .env.local to enable the AI assistant.',
      code: 'API_KEY_MISSING'
    }));
    return;
  }

  // 4. Parse request body
  let body = {};
  try {
    if (typeof req.body === 'object' && req.body !== null) {
      body = req.body;
    } else if (typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else {
      // Buffer from raw stream if needed
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (e) {
            reject(new Error('Invalid JSON payload in request body.'));
          }
        });
        req.on('error', reject);
      });
    }
  } catch (parseErr) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: parseErr.message, code: 'INVALID_JSON_BODY' }));
    return;
  }

  const { message, history, useDeterministicBypass } = body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Field "message" is required and must be a non-empty string.', code: 'MISSING_MESSAGE' }));
    return;
  }

  // 5. Execute Orchestration
  try {
    const adapter = new OpenAIProviderAdapter({
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs
    });

    const result = await orchestrateAiChat(message, {
      history,
      adapter,
      useDeterministicBypass
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: true,
      data: result
    }));
  } catch (err) {
    const status = err.status || 500;
    const isClientError = status >= 400 && status < 500;
    const safeErrorMessage = isClientError ? err.message : 'An error occurred during AI processing.';

    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: safeErrorMessage,
      code: err.code || 'AI_ORCHESTRATION_ERROR'
    }));
  }
}

