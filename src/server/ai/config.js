/**
 * src/server/ai/config.js
 *
 * Server-side configuration for OpenAI Ask FinMan POC (Phase OAI-1).
 *
 * Strict Security Rules:
 * 1. OPENAI_API_KEY is read exclusively on the server (process.env.OPENAI_API_KEY).
 * 2. Never exposed to Vite client bundles (never prefixed with VITE_).
 * 3. Never returned in API responses or client payloads.
 */

import fs from 'fs';
import path from 'path';

// Official OpenAI Pricing for gpt-4o-mini (as of November 2026):
// Input:  $0.15 / 1,000,000 tokens ($0.00000015 per token)
// Output: $0.60 / 1,000,000 tokens ($0.00000060 per token)
export const MODEL_PRICING = {
  'gpt-4o-mini': {
    inputPerMillion: 0.15,
    outputPerMillion: 0.60,
    inputPerToken: 0.00000015,
    outputPerToken: 0.00000060
  },
  'gpt-4o': {
    inputPerMillion: 2.50,
    outputPerMillion: 10.00,
    inputPerToken: 0.0000025,
    outputPerToken: 0.000010
  }
};

export const DEFAULT_MODEL = 'gpt-4o-mini';

export function getAiConfig() {
  let apiKey = '';
  let source = 'none';

  // 1. In local development, prioritize .env.local if present
  try {
    const envLocalPath = path.resolve(process.cwd(), '.env.local');
    if (fs.existsSync(envLocalPath)) {
      const content = fs.readFileSync(envLocalPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('OPENAI_API_KEY=')) {
          let parsed = trimmed.slice('OPENAI_API_KEY='.length).trim();
          if ((parsed.startsWith('"') && parsed.endsWith('"')) || (parsed.startsWith("'") && parsed.endsWith("'"))) {
            parsed = parsed.slice(1, -1).trim();
          }
          if (parsed && !parsed.includes('your-key-here')) {
            apiKey = parsed;
            source = '.env.local';
            break;
          }
        }
      }
    }
  } catch {
    // Fallback silently if filesystem not available
  }

  // 2. Fallback to process.env.OPENAI_API_KEY (Vercel serverless / Docker / CI)
  if (!apiKey && process.env.OPENAI_API_KEY) {
    let envKey = process.env.OPENAI_API_KEY.trim();
    if ((envKey.startsWith('"') && envKey.endsWith('"')) || (envKey.startsWith("'") && envKey.endsWith("'"))) {
      envKey = envKey.slice(1, -1).trim();
    }
    if (envKey) {
      apiKey = envKey;
      source = 'process.env.OPENAI_API_KEY';
    }
  }

  const rawHasWhitespace = Boolean(apiKey && (apiKey !== apiKey.trim()));
  if (apiKey) {
    apiKey = apiKey.trim();
  }

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  // Development-only safe diagnostics logging (never logs secret or partial key)
  if (process.env.NODE_ENV !== 'production' && typeof console !== 'undefined') {
    console.log('[AI Server Diagnostics]', {
      keyExists: Boolean(apiKey && apiKey.length > 0),
      keyLength: apiKey ? apiKey.length : 0,
      startsWithSk: Boolean(apiKey && apiKey.startsWith('sk-')),
      hasWhitespace: rawHasWhitespace,
      source: apiKey ? source : 'none',
      hasOrgId: Boolean(process.env.OPENAI_ORG_ID || process.env.OPENAI_ORGANIZATION),
      hasProjectId: Boolean(process.env.OPENAI_PROJECT_ID),
      selectedModel: model
    });
  }

  return {
    apiKey,
    source,
    hasWhitespace: rawHasWhitespace,
    model,
    hasApiKey: Boolean(apiKey && apiKey.trim().length > 0),
    maxToolCalls: 3,
    maxInputChars: 1000,
    maxHistoryMessages: 10,
    maxOutputTokens: 600,
    temperature: 0.2,
    timeoutMs: 30000 // 30 seconds server timeout
  };
}

/**
 * Calculates estimated cost in USD based on official token counts.
 *
 * @param {string} model Model identifier
 * @param {{ promptTokens?: number, completionTokens?: number }} usage
 * @returns {number} Estimated cost in USD rounded to 6 decimal places
 */
export function calculateEstimatedCost(model = DEFAULT_MODEL, usage = {}) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[DEFAULT_MODEL];
  const promptTokens = Number(usage.promptTokens || usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completionTokens || usage.completion_tokens || 0);

  const cost = (promptTokens * pricing.inputPerToken) + (completionTokens * pricing.outputPerToken);
  return Math.round(cost * 1_000_000) / 1_000_000;
}

