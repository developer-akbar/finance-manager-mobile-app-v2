/**
 * src/server/ai/adapters/AIProviderAdapter.js
 *
 * Lightweight provider-independent AI interface.
 */

export class AIProviderAdapter {
  /**
   * Generates a completion from the underlying model.
   *
   * @param {Object} options
   * @param {Array} options.messages Conversation history
   * @param {Array} [options.tools] Approved tool schemas
   * @param {number} [options.temperature] Generation temperature
   * @param {number} [options.maxTokens] Max output tokens
   * @returns {Promise<{ content: string|null, toolCalls: Array, usage: Object, model: string }>}
   */
  async generateResponse(options) {
    throw new Error('generateResponse() must be implemented by provider adapter.');
  }
}

