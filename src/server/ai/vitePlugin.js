/**
 * src/server/ai/vitePlugin.js
 *
 * Vite development server plugin providing the /api/ai/chat endpoint in local development.
 */

import { handleChatRequest } from './chatController.js';
import { verifyOpenAiAuth } from './diagnosticAuth.js';

export function finmanAiDevServerPlugin() {
  return {
    name: 'finman-ai-dev-server',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // Strip query string for route matching
        const urlPath = req.url ? req.url.split('?')[0] : '';

        if (urlPath === '/api/ai/chat') {
          try {
            await handleChatRequest(req, res);
          } catch (err) {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message, code: 'DEV_SERVER_ERROR' }));
            }
          }
          return;
        }

        if (urlPath === '/api/ai/verify' && req.method === 'GET') {
          try {
            const authResult = await verifyOpenAiAuth();
            res.statusCode = authResult.status || (authResult.success ? 200 : 500);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(authResult));
          } catch (err) {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message, code: 'AUTH_DIAGNOSTIC_ERROR' }));
            }
          }
          return;
        }

        next();
      });
    }
  };
}

