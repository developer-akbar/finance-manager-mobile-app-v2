/**
 * src/server/ai/diagnosticAuth.js
 *
 * Minimal independent authentication verification tool.
 * Tests OpenAI authentication directly without tool orchestration or token overhead.
 */

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

export async function verifyOpenAiAuth(providedKey = null) {
  let key = providedKey;
  let source = providedKey ? 'explicit_argument' : null;

  if (!key) {
    // 1. In local dev, read directly from .env.local first
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
              key = parsed;
              source = '.env.local';
              break;
            }
          }
        }
      }
    } catch {
      // Fallback
    }

    // 2. Fallback to process.env.OPENAI_API_KEY
    if (!key && process.env.OPENAI_API_KEY) {
      key = process.env.OPENAI_API_KEY.trim();
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
        key = key.slice(1, -1).trim();
      }
      source = 'process.env.OPENAI_API_KEY';
    }
  }

  // Safe Diagnostics (Never expose the key or secrets)
  const diagnostics = {
    keyExists: Boolean(key && key.length > 0),
    keyLength: key ? key.length : 0,
    startsWithSk: Boolean(key && key.startsWith('sk-')),
    startsWithSkProj: Boolean(key && key.startsWith('sk-proj-')),
    hasWhitespace: Boolean(key && /\s/.test(key)),
    source: source || 'none',
    hasOrgId: Boolean(process.env.OPENAI_ORG_ID || process.env.OPENAI_ORGANIZATION),
    hasProjectId: Boolean(process.env.OPENAI_PROJECT_ID),
    selectedModel: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  };

  if (!diagnostics.keyExists) {
    return {
      success: false,
      status: 400,
      code: 'MISSING_API_KEY',
      message: 'No API key was found in process.env or .env.local.',
      diagnostics
    };
  }

  // Make minimal request using models.list() (zero token cost)
  const client = new OpenAI({
    apiKey: key,
    maxRetries: 0,
    timeout: 25000
  });

  try {
    const listRes = await client.models.list();
    return {
      success: true,
      status: 200,
      code: null,
      message: 'Authentication successful. OpenAI accepted API key.',
      modelCount: listRes.data?.length || 0,
      diagnostics
    };
  } catch (err) {
    return {
      success: false,
      status: err.status || err.statusCode || 500,
      code: err.code || err.error?.code || 'AUTHENTICATION_FAILED',
      type: err.type || err.error?.type || null,
      message: err.message || 'OpenAI authentication failed.',
      requestId: err.request_id || err.headers?.['x-request-id'] || null,
      diagnostics
    };
  }
}

// Direct execution CLI mode
if (process.argv[1] && process.argv[1].endsWith('diagnosticAuth.js')) {
  verifyOpenAiAuth().then(res => {
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.success ? 0 : 1);
  }).catch(err => {
    console.error('Diagnostic error:', err);
    process.exit(1);
  });
}
