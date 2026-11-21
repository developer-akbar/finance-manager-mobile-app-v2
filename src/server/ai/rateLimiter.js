/**
 * src/server/ai/rateLimiter.js
 *
 * Lightweight in-memory rate limiter for server-side AI endpoints.
 * Protects OpenAI API credits from runaway loops or abuse.
 */

const clientRequests = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 20; // 20 requests per minute per IP

export function checkRateLimit(clientIp = 'default') {
  const now = Date.now();
  const timestamps = clientRequests.get(clientIp) || [];

  // Filter timestamps within current window
  const activeTimestamps = timestamps.filter(t => now - t < WINDOW_MS);

  if (activeTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    clientRequests.set(clientIp, activeTimestamps);
    const oldest = activeTimestamps[0];
    const retryAfterSec = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, retryAfterSec)
    };
  }

  activeTimestamps.push(now);
  clientRequests.set(clientIp, activeTimestamps);

  return {
    allowed: true,
    remaining: MAX_REQUESTS_PER_WINDOW - activeTimestamps.length,
    retryAfterSec: 0
  };
}

// Helper for testing to reset rate limiter
export function resetRateLimiter() {
  clientRequests.clear();
}

