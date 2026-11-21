/**
 * src/services/aiChatService.js
 *
 * Client-side communication service for Ask FinMan OpenAI POC.
 * Dispatches natural-language questions to the server-side /api/ai/chat endpoint.
 */

export class AiChatError extends Error {
  constructor(message, code = 'AI_CHAT_ERROR', retryAfterSec = 0) {
    super(message);
    this.name = 'AiChatError';
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Sends a financial question to the FinMan OpenAI assistant backend.
 *
 * @param {string} message The user's query
 * @param {Object} [options]
 * @param {Array} [options.history] Previous messages in conversation
 * @param {boolean} [options.useDeterministicBypass] If true, enables direct deterministic balance responses
 * @param {AbortSignal} [options.signal] AbortController signal
 * @returns {Promise<{ answer: string, toolCalls: Array, metrics: Object }>}
 */
export async function sendAiChatMessage(message, options = {}) {
  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new AiChatError('Message cannot be empty.', 'EMPTY_MESSAGE');
  }

  const endpoint = '/api/ai/chat';
  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: message.trim(),
        history: options.history || [],
        useDeterministicBypass: options.useDeterministicBypass !== false
      }),
      signal: options.signal
    });
  } catch (netErr) {
    if (netErr.name === 'AbortError') {
      throw netErr;
    }
    throw new AiChatError(`Network connection error: ${netErr.message}`, 'NETWORK_ERROR');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new AiChatError('Invalid JSON response received from server.', 'SERVER_ERROR');
  }

  if (!response.ok || !data.success) {
    const errorMsg = data.error || `Request failed with status ${response.status}`;
    const code = data.code || 'API_ERROR';
    const retryAfter = data.retryAfterSec || 0;
    throw new AiChatError(errorMsg, code, retryAfter);
  }

  return data.data;
}

