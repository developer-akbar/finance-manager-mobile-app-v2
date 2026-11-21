/**
 * api/ai/chat.js
 *
 * Vercel Serverless Function entrypoint for /api/ai/chat.
 */

import { handleChatRequest } from '../../src/server/ai/chatController.js';

export default async function handler(req, res) {
  return handleChatRequest(req, res);
}

